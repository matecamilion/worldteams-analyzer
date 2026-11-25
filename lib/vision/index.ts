import "server-only";
import { DeepSeekProvider } from "./deepseek";
import type { VisionProvider } from "./provider";

/** Elige el proveedor de visión según VISION_PROVIDER. Las claves sólo existen en el servidor. */
export function getVisionProvider(name = process.env.VISION_PROVIDER ?? "deepseek"): VisionProvider | null {
  switch (name) {
    case "deepseek": {
      const key = process.env.DEEPSEEK_API_KEY;
      return key ? new DeepSeekProvider(key, process.env.DEEPSEEK_MODEL ?? "deepseek-flash") : null;
    }
    default:
      return null;
  }
}
