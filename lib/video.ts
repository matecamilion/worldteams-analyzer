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

/**
 * Reglas de acreditación. Las mismas están en la función SQL record_heartbeat
 * (supabase/migrations/20261126_video_tope_latidos.sql): si se cambian acá, cambiarlas allá.
 */
/** Un latido que llega antes de esto desde el último aceptado se ignora (no acredita ni mueve la hora). */
export const MIN_BEAT_INTERVAL_S = 4;
/** Máximo que puede avanzar el crédito en un solo latido, aunque haya pasado más tiempo (no se "ahorra" tiempo en pausa). */
export const MAX_STEP_S = 15;
/** Tolerancia proporcional por demoras de red: 2 % del tiempo transcurrido (sin suma fija por latido). */
export const RATE_TOLERANCE = 1.02;
/** Tope total: lo acreditado nunca supera (tiempo real desde el primer latido) × 1,02 + esto. */
export const TOTAL_SLACK_S = 2;

export type BeatInput = {
  /** Segundos ya acreditados. */
  credited: number;
  /** Primer latido aceptado (ms), o null si todavía no hubo. */
  firstBeatAt: number | null;
  /** Último latido aceptado (ms), o null si es el primero. */
  lastBeatAt: number | null;
  /** Ahora (ms, reloj del servidor). */
  now: number;
  /** Posición que informa el navegador (s). */
  reported: number;
};

export type BeatResult =
  | { accepted: true; credited: number }
  /** Llegó demasiado pronto: no cambia nada; el navegador puede reenviarlo en `retryInMs`. */
  | { accepted: false; credited: number; retryInMs: number };

/**
 * Evalúa un latido. El crédito nunca baja; avanza como mucho el tiempo real transcurrido desde
 * el último latido aceptado × 1,02 (máximo 15 s por latido); en total nunca supera el tiempo real
 * desde el primer latido × 1,02 + 2 s; y nunca pasa la duración. Los latidos a menos de 4 s del
 * último aceptado se ignoran: mandar latidos más seguidos no acelera nada.
 */
export function evaluateBeat({ credited, firstBeatAt, lastBeatAt, now, reported }: BeatInput): BeatResult {
  const base = Math.max(0, Number.isFinite(credited) ? credited : 0);
  if (lastBeatAt !== null && now - lastBeatAt < MIN_BEAT_INTERVAL_S * 1000) {
    return { accepted: false, credited: base, retryInMs: Math.ceil(MIN_BEAT_INTERVAL_S * 1000 - (now - lastBeatAt)) };
  }
  if (!Number.isFinite(reported)) return { accepted: true, credited: base };
  const first = firstBeatAt ?? now;
  const step = lastBeatAt === null ? TOTAL_SLACK_S : Math.min((now - lastBeatAt) / 1000, MAX_STEP_S) * RATE_TOLERANCE;
  const totalCap = (Math.max(0, now - first) / 1000) * RATE_TOLERANCE + TOTAL_SLACK_S;
  const next = Math.min(Math.max(0, reported), base + step, totalCap, VIDEO_DURATION_S);
  return { accepted: true, credited: Math.max(base, Math.round(next * 1000) / 1000) };
}

export const isComplete = (credited: number) => credited >= COMPLETE_AT_S;
export const percent = (credited: number) => Math.min(100, Math.floor((credited / VIDEO_DURATION_S) * 100));
