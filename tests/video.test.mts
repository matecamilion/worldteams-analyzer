import { test } from "node:test";
import assert from "node:assert/strict";
import { COMPLETE_AT_S, evaluateBeat, isComplete, MIN_BEAT_INTERVAL_S, VIDEO_DURATION_S, type BeatInput } from "../lib/video";

const T0 = 1_000_000;
const credit = (input: BeatInput) => evaluateBeat(input).credited;

/**
 * Simula el servidor frente a un cliente que manda latidos cada `gapMs` informando `reportedAt(t)`.
 * Igual que record_heartbeat: sólo un latido aceptado guarda la hora y fija el primer latido.
 * Devuelve los segundos reales que tardó en completarse (o Infinity) y el crédito final.
 */
function simulate(gapMs: number, reportedAt: (t: number) => number, limitS = 400) {
  let credited = 0;
  let first: number | null = null;
  let last: number | null = null;
  for (let t = 0; t <= limitS * 1000; t += gapMs) {
    const now = T0 + t;
    const r = evaluateBeat({ credited, firstBeatAt: first, lastBeatAt: last, now, reported: reportedAt(t / 1000) });
    if (r.accepted) {
      credited = r.credited;
      first ??= now;
      last = now;
    }
    if (isComplete(credited)) return { completedAt: t / 1000, credited };
  }
  return { completedAt: Infinity, credited };
}

test("ataque: latidos inventados cada 100 ms no completan el video antes de ~145 s", () => {
  const { completedAt } = simulate(100, () => 10_000);
  // Hacen falta 149,8 s (98 %). Con 2 % de tolerancia y 2 s de arranque, el mínimo posible es ~145 s.
  assert.ok(completedAt >= 145, `se completó a los ${completedAt} s`);
  assert.ok(completedAt < 160, `no debería tardar más que el video: ${completedAt} s`);
});

test("ataque: latidos inventados cada 250 ms no completan el video antes de ~145 s", () => {
  const { completedAt } = simulate(250, () => 10_000);
  assert.ok(completedAt >= 145, `se completó a los ${completedAt} s`);
});

test("un latido a menos de 4 s del último aceptado se ignora y avisa cuándo reenviarlo", () => {
  const r = evaluateBeat({ credited: 30, firstBeatAt: T0 - 30_000, lastBeatAt: T0, now: T0 + 1_500, reported: 31.5 });
  assert.equal(r.accepted, false);
  assert.equal(r.credited, 30);
  assert.equal(!r.accepted && r.retryInMs, MIN_BEAT_INTERVAL_S * 1000 - 1_500);
});

test("ataque: latidos cada 5 s inventando la posición tampoco baja de ~145 s", () => {
  const { completedAt } = simulate(5_000, () => 10_000);
  assert.ok(completedAt >= 145, `se completó a los ${completedAt} s`);
});

test("tope total: nunca más que el tiempo real desde el primer latido × 1,02 + 2 s", () => {
  // Fila con hora del último latido manipulada hacia atrás: el tope total igual corta.
  const c = credit({ credited: 10, firstBeatAt: T0, lastBeatAt: T0 - 60_000, now: T0 + 20_000, reported: 150 });
  assert.ok(c <= 20 * 1.02 + 2 + 1e-9, String(c));
});

test("el primer latido sólo acredita el arranque, aunque informe el final", () => {
  assert.equal(credit({ credited: 0, firstBeatAt: null, lastBeatAt: null, now: T0, reported: 150 }), 2);
  assert.equal(credit({ credited: 0, firstBeatAt: null, lastBeatAt: null, now: T0, reported: 0.4 }), 0.4);
});

test("no acredita más que el tiempo real transcurrido (saltar adelante no sirve)", () => {
  const c = credit({ credited: 10, firstBeatAt: T0 - 10_000, lastBeatAt: T0, now: T0 + 5_000, reported: 120 });
  assert.ok(c > 15 && c <= 15.1 + 1e-9, String(c));
});

test("el crédito nunca baja", () => {
  assert.equal(credit({ credited: 40, firstBeatAt: T0 - 40_000, lastBeatAt: T0, now: T0 + 5_000, reported: 3 }), 40);
  assert.equal(credit({ credited: 40, firstBeatAt: T0 - 40_000, lastBeatAt: T0, now: T0 + 5_000, reported: NaN }), 40);
});

test("una pausa larga no se ahorra: como mucho 15 s por latido", () => {
  const c = credit({ credited: 20, firstBeatAt: T0 - 20_000, lastBeatAt: T0, now: T0 + 600_000, reported: 152 });
  assert.ok(c <= 20 + 15 * 1.02 + 1e-9, String(c));
});

test("reproducir a 2× no gana tiempo", () => {
  const { credited } = simulate(5_000, (t) => 2 * t, 95);
  assert.ok(credited <= 95 * 1.02 + 2 + 1e-9, String(credited));
});

test("viendo a 1× con latidos cada 5 s se completa a tiempo y nunca pasa la duración", () => {
  const { completedAt, credited } = simulate(5_000, (t) => Math.min(t, VIDEO_DURATION_S));
  assert.ok(completedAt <= 155, `debería completarse al terminar el video: ${completedAt} s`);
  assert.ok(credited <= VIDEO_DURATION_S);
  assert.ok(COMPLETE_AT_S > 149 && COMPLETE_AT_S < 150);
});

test("una pausa y reanudación rápida no pierde tiempo: el latido ignorado se reenvía", () => {
  // Latidos a 0, 5, 6 (pausa, ignorado), 10, 10,1 (play, ignorado) … el reenvío a los 4 s cubre lo visto.
  const beats = [0, 5, 6, 10, 10.1, 14.1, 19.1];
  let credited = 0;
  let first: number | null = null;
  let last: number | null = null;
  const watched = (t: number) => (t <= 6 ? t : Math.max(6, t - 4)); // pausado de 6 a 10
  for (const t of beats) {
    const r = evaluateBeat({ credited, firstBeatAt: first, lastBeatAt: last, now: T0 + t * 1000, reported: watched(t) });
    if (r.accepted) {
      credited = r.credited;
      first ??= T0 + t * 1000;
      last = T0 + t * 1000;
    }
  }
  assert.ok(Math.abs(credited - watched(19.1)) < 1e-6, String(credited));
});
