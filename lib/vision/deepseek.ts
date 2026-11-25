import { OVERLAP_PROMPT } from "./prompt";
import { parseBoxes, VisionError, type VisionImage, type VisionProvider } from "./provider";

/** DeepSeek vía su API compatible con OpenAI (chat completions con image_url). */
export class DeepSeekProvider implements VisionProvider {
  readonly name = "deepseek";

  constructor(
    private readonly apiKey: string,
    readonly model = "deepseek-flash",
    private readonly baseUrl = "https://api.deepseek.com",
    private readonly timeoutMs = 50_000,
  ) {}

  async detectOverlaps(image: VisionImage) {
    const body = {
      model: this.model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: OVERLAP_PROMPT },
            { type: "image_url", image_url: { url: `data:${image.mime};base64,${image.data.toString("base64")}` } },
          ],
        },
      ],
    };
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new VisionError(`DeepSeek no respondió: ${(e as Error).message}`, true);
    }
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      throw new VisionError(`DeepSeek respondió ${res.status}: ${detail}`, res.status === 429 || res.status >= 500);
    }
    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const raw = json.choices?.[0]?.message?.content ?? "";
    return {
      boxes: parseBoxes(raw),
      usage: { inputTokens: json.usage?.prompt_tokens ?? 0, outputTokens: json.usage?.completion_tokens ?? 0 },
      raw,
    };
  }
}
