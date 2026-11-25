import { OVERLAP_PROMPT } from "./prompt";
import { CALL_TIMEOUT_MS, parseBoxes, postJsonWithTimeout, type VisionImage, type VisionProvider } from "./provider";

/** DeepSeek vía su API compatible con OpenAI (chat completions con image_url). */
export class DeepSeekProvider implements VisionProvider {
  readonly name = "deepseek";

  constructor(
    private readonly apiKey: string,
    readonly model = "deepseek-flash",
    private readonly baseUrl = "https://api.deepseek.com",
    private readonly timeoutMs = CALL_TIMEOUT_MS,
  ) {}

  async detectOverlaps(image: VisionImage, prompt: string = OVERLAP_PROMPT) {
    const body = {
      model: this.model,
      temperature: 0,
      response_format: { type: "json_object" },
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
