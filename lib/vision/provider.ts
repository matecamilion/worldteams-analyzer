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
