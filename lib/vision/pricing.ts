import type { VisionUsage } from "./provider";

/**
 * Precios por millón de tokens (USD). DeepSeek publicado en api-docs.deepseek.com/quick_start/pricing
 * (consultado 25/11/2026): pico 01–04 y 06–10 UTC lun–vie; fuera de pico cuesta la mitad.
 * Las imágenes se cuentan como tokens de entrada según el `usage` que devuelve la API.
 */
export const PRICES: Record<string, { input: number; output: number; offPeakFactor?: number }> = {
  "deepseek:deepseek-flash": { input: 0.3, output: 1.2, offPeakFactor: 0.5 },
};

export function estimateCostUsd(providerKey: string, usage: VisionUsage) {
  const p = PRICES[providerKey];
  if (!p) return null;
  const peak = (usage.inputTokens * p.input + usage.outputTokens * p.output) / 1e6;
  return { peak, offPeak: peak * (p.offPeakFactor ?? 1) };
}
