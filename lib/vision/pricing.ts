import type { VisionUsage } from "./provider";

/**
 * Precios por millón de tokens (USD, tarifa pico). DeepSeek publicado en
 * api-docs.deepseek.com/quick_start/pricing (consultado 26/11/2026): entrada en caché 0,006,
 * entrada sin caché 0,30, salida 1,20 (el razonamiento interno se cobra como salida).
 * Pico 01–04 y 06–10 UTC lun–vie; fuera de pico cuesta la mitad.
 */
export const PRICES: Record<string, { input: number; cachedInput?: number; output: number; offPeakFactor?: number }> = {
  "deepseek:deepseek-flash": { input: 0.3, cachedInput: 0.006, output: 1.2, offPeakFactor: 0.5 },
  // Cuota gratuita de Google AI Studio: sin costo, pero Google puede usar los datos enviados.
  "gemini:gemini-3.5-flash-lite": { input: 0, output: 0, offPeakFactor: 1 },
};

export function estimateCostUsd(providerKey: string, usage: VisionUsage) {
  const p = PRICES[providerKey];
  if (!p) return null;
  const cached = Math.min(usage.cachedInputTokens ?? 0, usage.inputTokens);
  const peak = ((usage.inputTokens - cached) * p.input + cached * (p.cachedInput ?? p.input) + usage.outputTokens * p.output) / 1e6;
  return { peak, offPeak: peak * (p.offPeakFactor ?? 1) };
}
