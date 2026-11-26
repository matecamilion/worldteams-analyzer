import "server-only";
import { DeepSeekProvider } from "./deepseek";
import { GeminiProvider } from "./gemini";
import type { VisionProvider } from "./provider";

/** Elige el proveedor de visión según VISION_PROVIDER. Las claves sólo existen en el servidor. */
export function getVisionProvider(name = process.env.VISION_PROVIDER ?? "deepseek"): VisionProvider | null {
  switch (name) {
    case "deepseek": {
      const key = process.env.DEEPSEEK_API_KEY;
      // max_tokens 8192: tope de seguridad (el razonamiento medido por llamada queda muy por debajo).
      // VISION_REASONING=none apaga el razonamiento: más barato y rápido, medido aparte (ver README).
      const reasoning = process.env.VISION_REASONING as "none" | "low" | "high" | undefined;
      return key
        ? new DeepSeekProvider(key, process.env.DEEPSEEK_MODEL ?? "deepseek-flash", undefined, undefined, {
            maxTokens: 8192,
            ...(reasoning ? { reasoningEffort: reasoning } : {}),
          })
        : null;
    }
    case "gemini": {
      const key = process.env.GEMINI_API_KEY;
      return key ? new GeminiProvider(key, process.env.GEMINI_MODEL ?? "gemini-3.5-flash-lite") : null;
    }
    default:
      return null;
  }
}
