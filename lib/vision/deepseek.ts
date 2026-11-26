import { OVERLAP_PROMPT } from "./prompt";
import { CALL_TIMEOUT_MS, parseBoxes, postJsonWithTimeout, VisionError, type VisionImage, type VisionProvider } from "./provider";

export type DeepSeekOptions = {
  /** Razonamiento interno: "none" lo apaga; por defecto la API usa "high". */
  reasoningEffort?: "none" | "low" | "high";
  /** Tope de tokens de salida (razonamiento + respuesta). */
  maxTokens?: number;
};

/** DeepSeek vía su API compatible con OpenAI (chat completions con image_url). */
export class DeepSeekProvider implements VisionProvider {
  readonly name = "deepseek";

  constructor(
    private readonly apiKey: string,
    readonly model = "deepseek-flash",
    private readonly baseUrl = "https://api.deepseek.com",
    private readonly timeoutMs = CALL_TIMEOUT_MS,
    private readonly options: DeepSeekOptions = {},
  ) {}

  async detectOverlaps(image: VisionImage, prompt: string = OVERLAP_PROMPT) {
    const body = {
      model: this.model,
      temperature: 0,
      response_format: { type: "json_object" },
      ...(this.options.reasoningEffort === "none"
        ? { thinking: { type: "disabled" } }
        : this.options.reasoningEffort
          ? { reasoning_effort: this.options.reasoningEffort }
          : {}),
      ...(this.options.maxTokens ? { max_tokens: this.options.maxTokens } : {}),
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: `data:${image.mime};base64,${image.data.toString("base64")}` } },
          ],
        },
      ],
    };
    const json = (await postJsonWithTimeout(
      `${this.baseUrl}/chat/completions`,
      { Authorization: `Bearer ${this.apiKey}` },
      body,
      "DeepSeek",
      this.timeoutMs,
    )) as {
      choices?: { message?: { content?: string }; finish_reason?: string }[];
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_cache_hit_tokens?: number;
        completion_tokens_details?: { reasoning_tokens?: number };
      };
    };
    const raw = json.choices?.[0]?.message?.content ?? "";
    // Cortada por el tope de tokens: no es una respuesta confiable; se reintenta.
    if (json.choices?.[0]?.finish_reason === "length") throw new VisionError("Respuesta cortada por el tope de tokens", true);
    return {
      boxes: parseBoxes(raw),
      usage: {
        inputTokens: json.usage?.prompt_tokens ?? 0,
        outputTokens: json.usage?.completion_tokens ?? 0,
        cachedInputTokens: json.usage?.prompt_cache_hit_tokens ?? 0,
        reasoningTokens: json.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
      },
      raw,
    };
  }
}
