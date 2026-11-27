// Registro de "Mi actividad" desde el navegador: una llamada a POST /api/historial al terminar un
// análisis. Sólo metadatos (nombre y conteos). A prueba de fallos: nunca lanza y nunca bloquea.
import type { PageResult } from "@/lib/detector/types";
import { summarize } from "@/lib/detector/report";
import { cleanFileName, MAX_FILE_NAME } from "@/lib/historial-limits";

/** Resultado de una página y de dónde salió: del servidor o del caché del navegador. */
export type PageOutcome = { result: PageResult; fromCache: boolean };

export type HistoryPayload = {
  nombre_archivo: string;
  paginas: number;
  paginas_escaneadas: number;
  choques: number;
  duplicados: number;
  cercanias: number;
  paginas_no_verificadas: number;
};

/**
 * Fila a guardar, o null si no corresponde: si alguna página salió del caché, el archivo ya se
 * había analizado en este navegador y no es un análisis nuevo.
 */
export function historyEntryFor(fileName: string, outcomes: PageOutcome[]): HistoryPayload | null {
  if (!outcomes.length || outcomes.some((o) => o.fromCache)) return null;
  const results = outcomes.map((o) => o.result);
  const s = summarize(results);
  const name = cleanFileName(fileName).slice(0, MAX_FILE_NAME) || "sin nombre.pdf";
  return {
    nombre_archivo: name,
    paginas: results.length,
    paginas_escaneadas: results.filter((r) => r.kind === "image").length,
    choques: s.choques,
    duplicados: s.duplicados,
    cercanias: s.cercanias,
    paginas_no_verificadas: s.noVerificadas,
  };
}

/**
 * Manda la fila. Devuelve si se guardó; ante cualquier falla (red, servidor, base, tiempo)
 * devuelve false sin lanzar: el historial es accesorio y el análisis no depende de él.
 */
export async function recordHistory(
  entry: HistoryPayload,
  fetchImpl: typeof fetch = (...args) => fetch(...args),
  timeoutMs = 10_000,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl("/api/historial", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry),
      // Si la persona cierra la pestaña justo al terminar, el registro igual sale.
      keepalive: true,
      signal: controller.signal,
    });
    if (!res.ok) console.warn(`No se pudo guardar el historial (HTTP ${res.status}).`);
    return res.ok;
  } catch (e) {
    console.warn("No se pudo guardar el historial:", (e as Error)?.message ?? e);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Al terminar de analizar TODAS las páginas de un archivo: registra el análisis si corresponde.
 * No se espera (el resultado ya está en pantalla) y nunca lanza, falle lo que falle.
 */
export async function recordFinishedRun(
  fileName: string,
  outcomes: PageOutcome[],
  totalPages: number,
  send: (entry: HistoryPayload) => Promise<boolean> = recordHistory,
): Promise<boolean> {
  try {
    if (outcomes.length !== totalPages) return false; // corrida cortada: no es un análisis completo
    const entry = historyEntryFor(fileName, outcomes);
    return entry ? await send(entry) : false;
  } catch (e) {
    console.warn("No se pudo registrar el historial:", (e as Error)?.message ?? e);
    return false;
  }
}
