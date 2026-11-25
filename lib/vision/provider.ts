/** Una caja devuelta por un modelo de visión, normalizada 0–1 respecto del mosaico enviado. */
export type VisionBox = {
  x: number;
  y: number;
  w: number;
  h: number;
  texts: string[];
  confidence: number;
};

export type VisionUsage = { inputTokens: number; outputTokens: number };

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
    const conf = Number((item as { confidence?: unknown }).confidence);
    out.push({
      x: ax,
      y: ay,
      w: bx - ax,
      h: by - ay,
      texts: Array.isArray(texts) ? texts.filter((t): t is string => typeof t === "string").slice(0, 4) : [],
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
