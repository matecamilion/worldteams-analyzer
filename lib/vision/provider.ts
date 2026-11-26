/** Una caja devuelta por un modelo de visión, normalizada 0–1 respecto del mosaico enviado. */
export type VisionBox = {
  x: number;
  y: number;
  w: number;
  h: number;
  texts: string[];
  confidence: number;
};

export type VisionUsage = {
  inputTokens: number;
  outputTokens: number;
  /** Parte de la entrada servida desde el caché del proveedor (más barata). */
  cachedInputTokens?: number;
  /** Parte de la salida que es razonamiento interno del modelo. */
  reasoningTokens?: number;
};

export type VisionImage = {
  /** JPEG del mosaico. */
  data: Buffer;
  mime: "image/jpeg" | "image/png";
  width: number;
  height: number;
};

/**
 * Proveedor de visión intercambiable. Cada implementación sólo sabe hablar con su API;
 * el armado de mosaicos, la conversión de coordenadas y la unión viven fuera.
 */
export interface VisionProvider {
  readonly name: string;
  readonly model: string;
  /** `prompt` permite reutilizar la llamada para el refinamiento sobre un recorte. */
  detectOverlaps(image: VisionImage, prompt?: string): Promise<{ boxes: VisionBox[]; usage: VisionUsage; raw: string }>;
}

export class VisionError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

/** Lo que se muestra cuando la IA vio un texto pero no pudo leerlo. */
export const UNREADABLE_TEXT = "texto no legible";

// Claves y valores del formato de respuesta: nunca son texto del plano.
const RESPONSE_KEYS = /^(confidence|confianza|box|texts?|textos?|overlaps?|null|undefined|none|n\/?a)$/i;
// Comentarios del modelo en vez de texto leído: "ilegible", "segundo texto superpuesto", "letras dobles"…
const UNREADABLE_HINT =
  /ilegible|no (se )?(lee|legible|leíble|distingue)|illegible|unreadable|unknown|desconocid|superpuest|encimad|letras dobles|texto (tenue|gris|de fondo|detr[aá]s|tapado)|segundo texto|^\W*$/i;

/**
 * Deja sólo lo que parece texto del plano. Saca las claves del JSON que el modelo a veces mete en
 * la lista ("confidence"), sus comentarios entre paréntesis y los puntos suspensivos; si lo que
 * queda es una descripción en vez de un texto leído, lo reemplaza por "texto no legible".
 */
export function cleanTexts(raw: unknown[]): string[] {
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const original = item.trim();
    if (!original || RESPONSE_KEYS.test(original.replace(/["':]/g, "").trim())) continue;
    const text = original
      .replace(/\([^)]*\)?/g, " ")
      .replace(/\[[^\]]*\]?/g, " ")
      .replace(/…|\.{2,}|\?{2,}/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    // Rótulo leído: corto y sin comentario. Más de 40 caracteres es una frase del modelo, no un rótulo.
    const unreadable = !text || UNREADABLE_HINT.test(original) || text.length > 40;
    out.push(unreadable ? UNREADABLE_TEXT : text);
  }
  // Un "texto no legible" por texto, sin repetir el mismo rótulo leído dos veces seguidas.
  return out.filter((t, i) => t === UNREADABLE_TEXT || out.indexOf(t) === i).slice(0, 4);
}

/** Interpreta la respuesta del modelo con tolerancia: JSON suelto, bloque ```json o texto alrededor. */
export function parseBoxes(raw: string): VisionBox[] {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new VisionError("La respuesta del modelo no trae JSON", true);
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    throw new VisionError("JSON inválido en la respuesta del modelo", true);
  }
  const list = (parsed as { overlaps?: unknown }).overlaps;
  if (!Array.isArray(list)) return [];
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const out: VisionBox[] = [];
  for (const item of list) {
    const box = (item as { box?: unknown }).box;
    if (!Array.isArray(box) || box.length !== 4 || !box.every((n) => typeof n === "number" && isFinite(n))) continue;
    let [x0, y0, x1, y1] = box as number[];
    // Algunos modelos devuelven 0–1000 aunque se les pida 0–1.
    if (Math.max(x0, y0, x1, y1) > 1.5) [x0, y0, x1, y1] = [x0, y0, x1, y1].map((n) => n / 1000);
    const [ax, bx] = [clamp(Math.min(x0, x1)), clamp(Math.max(x0, x1))];
    const [ay, by] = [clamp(Math.min(y0, y1)), clamp(Math.max(y0, y1))];
    if (bx - ax <= 0 || by - ay <= 0) continue;
    const texts = (item as { texts?: unknown }).texts;
    let conf = Number((item as { confidence?: unknown }).confidence);
    // Lista mal cerrada: ["COCINA","…","confidence",0.7] trae la confianza adentro de los textos.
    if (!isFinite(conf) && Array.isArray(texts)) {
      const k = texts.findIndex((t) => typeof t === "string" && /^confidence$/i.test(t.trim()));
      if (k >= 0 && typeof texts[k + 1] === "number") conf = texts[k + 1] as number;
    }
    out.push({
      x: ax,
      y: ay,
      w: bx - ax,
      h: by - ay,
      texts: Array.isArray(texts) ? cleanTexts(texts) : [],
      confidence: isFinite(conf) ? clamp(conf) : 0.5,
    });
  }
  return out;
}

/** Tiempo máximo por llamada al modelo de visión. */
export const CALL_TIMEOUT_MS = 20_000;

/**
 * POST JSON con corte por AbortController: el plazo cubre la conexión y la lectura completa
 * de la respuesta. Un corte es reintentable (otra llamada suele responder a tiempo).
 */
export async function postJsonWithTimeout(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  label: string,
  timeoutMs = CALL_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      throw new VisionError(`${label} respondió ${res.status}: ${detail}`, res.status === 429 || res.status >= 500);
    }
    return (await res.json()) as Record<string, unknown>;
  } catch (e) {
    if (e instanceof VisionError) throw e;
    const msg = controller.signal.aborted ? `sin respuesta en ${timeoutMs / 1000} s` : (e as Error).message;
    throw new VisionError(`${label} no respondió: ${msg}`, true);
  } finally {
    clearTimeout(timer);
  }
}
