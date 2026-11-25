import { test } from "node:test";
import assert from "node:assert/strict";
import { COMPLETE_AT_S, isComplete, nextCredit, VIDEO_DURATION_S } from "../lib/video";

const T0 = 1_000_000;

test("el primer latido sólo acredita el arranque, aunque informe el final", () => {
  assert.equal(nextCredit({ credited: 0, lastBeatAt: null, now: T0, reported: 150 }), 2);
  assert.equal(nextCredit({ credited: 0, lastBeatAt: null, now: T0, reported: 0.4 }), 0.4);
});

test("no acredita más que el tiempo real transcurrido (saltar adelante no sirve)", () => {
  // 5 s después dice estar en el segundo 120: se acreditan ~5 s.
  const c = nextCredit({ credited: 10, lastBeatAt: T0, now: T0 + 5_000, reported: 120 });
  assert.ok(c > 15 && c < 15.5, String(c));
});

test("el crédito nunca baja", () => {
  assert.equal(nextCredit({ credited: 40, lastBeatAt: T0, now: T0 + 5_000, reported: 3 }), 40);
  assert.equal(nextCredit({ credited: 40, lastBeatAt: T0, now: T0 + 5_000, reported: NaN }), 40);
});

test("una pausa larga no se ahorra: como mucho 15 s por latido", () => {
  const c = nextCredit({ credited: 20, lastBeatAt: T0, now: T0 + 600_000, reported: 152 });
  assert.ok(c <= 20 + 15 * 1.02 + 0.3 + 1e-9, String(c));
});

test("latidos más rápidos que el tiempo real (velocidad 2×) no ganan tiempo", () => {
  let credited = 0;
  let last: number | null = null;
  let now = T0;
  let pos = 0;
  // Reproduce a 2×: cada 5 s reales informa 10 s más.
  for (let i = 0; i < 20; i++) {
    credited = nextCredit({ credited, lastBeatAt: last, now, reported: pos });
    last = now;
    now += 5_000;
    pos += 10;
  }
  // 95 s reales desde el primer latido → no más de ~1,02×95 + jitter.
  assert.ok(credited < 2 + 19 * (5 * 1.02 + 0.3) + 1e-9, String(credited));
  assert.ok(credited < 105, String(credited));
});

test("viendo a 1× con latidos cada 5 s se completa, y nunca pasa la duración", () => {
  let credited = 0;
  let last: number | null = null;
  for (let t = 0; t <= 160; t += 5) {
    credited = nextCredit({ credited, lastBeatAt: last, now: T0 + t * 1000, reported: Math.min(t, VIDEO_DURATION_S) });
    last = T0 + t * 1000;
  }
  assert.ok(isComplete(credited), String(credited));
  assert.ok(credited <= VIDEO_DURATION_S);
  assert.ok(COMPLETE_AT_S > 149 && COMPLETE_AT_S < 150);
});
