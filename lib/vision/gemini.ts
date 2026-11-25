import { OVERLAP_PROMPT } from "./prompt";
import { parseBoxes, VisionError, type VisionImage, type VisionProvider } from "./provider";

/**
 * Gemini (Google AI Studio) por la API Interactions.
 * Gemini está entrenado para devolver cajas como box_2d = [ymin, xmin, ymax, xmax] en 0–1000;
 * se le piden en ese formato nativo y se convierten acá al [x0, y0, x1, y1] 0–1 del resto del código.
 * No se envía temperature: según la documentación, Gemini 3.6+ y 4 la ignoran.
 */
export class GeminiProvider implements VisionProvider {
  readonly name = "gemini";

  constructor(
    private readonly apiKey: string,
    readonly model = "gemini-3.5-flash-lite",
    private readonly baseUrl = "https://generativelanguage.googleapis.com/v1beta",
    private readonly timeoutMs = 50_000,
  ) {}

  async detectOverlaps(image: VisionImage, prompt: string = OVERLAP_PROMPT) {
    const body = {
      model: this.model,
      input: [
        // La documentación recomienda el texto antes de la imagen.
        { type: "text", text: `${prompt}\n\n${GEMINI_FORMAT}` },
        { type: "image", data: image.data.toString("base64"), mime_type: image.mime },
      ],
      response_format: { type: "text", mime_type: "application/json", schema: SCHEMA },
    };
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/interactions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new VisionError(`Gemini no respondió: ${(e as Error).message}`, true);
    }
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      throw new VisionError(`Gemini respondió ${res.status}: ${detail}`, res.status === 429 || res.status >= 500);
    }
    const json = (await res.json()) as Record<string, unknown>;
    const raw = extractText(json);
    return { boxes: parseBoxes(toOurFormat(raw)), usage: extractUsage(json), raw };
  }
}

const GEMINI_FORMAT = `Formato de salida para este modelo: en lugar de "box", usá "box_2d" = [ymin, xmin, ymax, xmax] normalizado de 0 a 1000.`;

const SCHEMA = {
  type: "object",
  properties: {
    overlaps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          box_2d: { type: "array", items: { type: "number" } },
          texts: { type: "array", items: { type: "string" } },
          confidence: { type: "number" },
        },
        required: ["box_2d", "texts", "confidence"],
      },
    },
  },
  required: ["overlaps"],
};

/** Texto de la respuesta: último bloque de texto de los pasos del modelo (forma documentada), con alternativas. */
export function extractText(json: Record<string, unknown>): string {
  if (typeof json.output_text === "string") return json.output_text;
  const texts: string[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o.text === "string" && o.type !== "thought") texts.push(o.text);
      for (const k of ["steps", "outputs", "content", "candidates", "parts"]) if (k in o) walk(o[k]);
    }
  };
  walk(json);
  // Preferimos el último texto que traiga JSON (el model_output final).
  const withJson = texts.filter((t) => t.includes("{"));
  if (!withJson.length) throw new VisionError("La respuesta de Gemini no trae texto", true);
  return withJson[withJson.length - 1];
}

function extractUsage(json: Record<string, unknown>) {
  const u = (json.usage ?? json.usageMetadata ?? {}) as Record<string, number | undefined>;
  return {
    inputTokens: u.total_input_tokens ?? u.input_tokens ?? u.promptTokenCount ?? 0,
    outputTokens: u.total_output_tokens ?? u.output_tokens ?? u.candidatesTokenCount ?? 0,
  };
}

/** box_2d [ymin, xmin, ymax, xmax] 0–1000 → box [x0, y0, x1, y1] 0–1. */
export function toOurFormat(raw: string): string {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return raw;
  try {
    const parsed = JSON.parse(m[0]) as { overlaps?: { box_2d?: number[]; box?: number[] }[] };
    for (const o of parsed.overlaps ?? []) {
      if (Array.isArray(o.box_2d) && o.box_2d.length === 4) {
        const [y0, x0, y1, x1] = o.box_2d;
        o.box = [x0 / 1000, y0 / 1000, x1 / 1000, y1 / 1000];
        delete o.box_2d;
      }
    }
    return JSON.stringify(parsed);
  } catch {
    return raw;
  }
}
