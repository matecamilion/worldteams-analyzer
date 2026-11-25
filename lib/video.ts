// Reglas del video obligatorio. Puras (sin Supabase) para poder probarlas.

/** Duración del video de inducción, fija del lado del servidor: no se confía en la del navegador. */
export const VIDEO_DURATION_S = 152.853;
/** Se considera visto al 98 %. */
export const COMPLETE_RATIO = 0.98;
export const COMPLETE_AT_S = VIDEO_DURATION_S * COMPLETE_RATIO;
/** Cada cuánto manda el reproductor su posición. */
export const HEARTBEAT_MS = 5_000;
/** Archivo en el bucket público "video". */
export const VIDEO_OBJECT = "worldteams-intro.mp4";

/** Máximo que puede avanzar el crédito en un solo latido, aunque haya pasado más tiempo (no se "ahorra" tiempo en pausa). */
export const MAX_STEP_S = 15;
/** Tolerancia por demoras de red y redondeo: 2 % del tiempo transcurrido + 0,3 s. */
const RATE_TOLERANCE = 1.02;
const JITTER_S = 0.3;
/** Primer latido (no hay uno anterior para medir el tiempo): sólo se acepta el arranque. */
const FIRST_BEAT_MAX_S = 2;

export type CreditInput = {
  /** Segundos ya acreditados. */
  credited: number;
  /** Momento del último latido aceptado (ms), o null si es el primero. */
  lastBeatAt: number | null;
  /** Ahora (ms, reloj del servidor). */
  now: number;
  /** Posición que informa el navegador (s). */
  reported: number;
};

/**
 * Nuevo crédito: nunca baja, nunca supera el tiempo real transcurrido desde el último latido
 * (a velocidad 1×, con tolerancia), nunca más de MAX_STEP_S por latido, nunca más que la duración.
 */
export function nextCredit({ credited, lastBeatAt, now, reported }: CreditInput): number {
  const base = Math.max(0, Number.isFinite(credited) ? credited : 0);
  if (!Number.isFinite(reported)) return base;
  const elapsed = lastBeatAt === null ? 0 : Math.max(0, (now - lastBeatAt) / 1000);
  const allowed = lastBeatAt === null ? FIRST_BEAT_MAX_S : Math.min(elapsed, MAX_STEP_S) * RATE_TOLERANCE + JITTER_S;
  const next = Math.min(reported, base + allowed, VIDEO_DURATION_S);
  return Math.max(base, Math.round(next * 1000) / 1000);
}

export const isComplete = (credited: number) => credited >= COMPLETE_AT_S;
export const percent = (credited: number) => Math.min(100, Math.floor((credited / VIDEO_DURATION_S) * 100));
