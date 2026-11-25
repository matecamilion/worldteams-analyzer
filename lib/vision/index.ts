import "server-only";
import { DeepSeekProvider } from "./deepseek";
import { GeminiProvider } from "./gemini";
import type { VisionProvider } from "./provider";

/** Elige el proveedor de visión según VISION_PROVIDER. Las claves sólo existen en el servidor. */
export function getVisionProvider(name = process.env.VISION_PROVIDER ?? "deepseek"): VisionProvider | null {
  switch (name) {
    case "deepseek": {
      const key = process.env.DEEPSEEK_API_KEY;
      return key ? new DeepSeekProvider(key, process.env.DEEPSEEK_MODEL ?? "deepseek-flash") : null;
    }
    case "gemini": {
      const key = process.env.GEMINI_API_KEY;
      return key ? new GeminiProvider(key, process.env.GEMINI_MODEL ?? "gemini-3.5-flash-lite") : null;
    }
    default:
      return null;
  }
}
