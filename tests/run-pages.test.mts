import { test } from "node:test";
import assert from "node:assert/strict";
import { PAGINAS_EN_PARALELO, runPages, type PageAttempt } from "../lib/client/run-pages";
import { recordFinishedRun, type PageOutcome } from "../lib/client/historial";
import type { PageResult } from "../lib/detector/types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const page = (n: number, over: Partial<PageResult> = {}): PageResult => ({
  page: n, kind: "image", width: 1, height: 1, textCount: 0, findings: [], status: "ok", ms: 1, ...over,
});

/** Analizador de prueba: registra cuántas páginas hay en vuelo y en qué orden empiezan. */
function fakeAnalyzer(delays: Record<number, number> = {}, over: (n: number) => Partial<PageAttempt<PageOutcome>> = () => ({})) {
  const started: number[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const inFlightWhenStarted: Record<number, number> = {};
  const analyzePage = async (n: number): Promise<PageAttempt<PageOutcome>> => {
    started.push(n);
    inFlight++;
    inFlightWhenStarted[n] = inFlight;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await sleep(delays[n] ?? 5);
    inFlight--;
    return { outcome: { result: page(n), fromCache: false }, ...over(n) };
  };
  return { analyzePage, started, inFlightWhenStarted, get maxInFlight() { return maxInFlight; } };
}

const noError = (n: number): PageOutcome => assert.fail(`no debería fallar la página ${n}`);

test("la página 1 va sola; después, de a 3, y cada resultado queda en su lugar aunque terminen desordenadas", async () => {
  assert.equal(PAGINAS_EN_PARALELO, 3);
  // Las primeras en salir tardan más: terminan después que las siguientes.
  const a = fakeAnalyzer({ 1: 20, 2: 40, 3: 5, 4: 25, 5: 1, 6: 10, 7: 2 });
  const r = await runPages({ total: 7, isCurrent: () => true, analyzePage: a.analyzePage, onPageError: noError });
  assert.equal(r.status, "completa");
  if (r.status !== "completa") return;
  assert.equal(r.mode, "paralelo");
  assert.deepEqual(r.outcomes.map((o) => o.result.page), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(a.started[0], 1);
  assert.equal(a.inFlightWhenStarted[1], 1, "la 1 corre sola");
  assert.equal(a.maxInFlight, 3);
});

test("si cambia la corrida con varias páginas en vuelo, no empieza ninguna más y se descarta el resultado", async () => {
  let current = true;
  const a = fakeAnalyzer({ 2: 30, 3: 30, 4: 30 });
  const analyzePage = async (n: number) => {
    if (n === 3) setTimeout(() => (current = false), 10); // se sube otro archivo a mitad de camino
    const at = await a.analyzePage(n);
    return current ? at : null; // como DetectorApp.analyze: null si la corrida ya no es la actual
  };
  const r = await runPages({ total: 9, isCurrent: () => current, analyzePage, onPageError: noError });
  assert.equal(r.status, "cortada");
  assert.deepEqual(a.started, [1, 2, 3, 4], "sólo las que ya estaban en vuelo");
});

test("un error en una página no frena las demás", async () => {
  const a = fakeAnalyzer();
  const failed: number[] = [];
  const r = await runPages<PageOutcome>({
    total: 6,
    isCurrent: () => true,
    analyzePage: async (n) => {
      if (n === 3) throw new Error("pdf.js no pudo leer la página");
      return a.analyzePage(n);
    },
    onPageError: (n) => (failed.push(n), { result: page(n, { status: "no_verificada", error: "x" }), fromCache: false }),
  });
  assert.equal(r.status, "completa");
  if (r.status !== "completa") return;
  assert.deepEqual(failed, [3]);
  assert.deepEqual(r.outcomes.map((o) => `${o.result.page}:${o.result.status}`), ["1:ok", "2:ok", "3:no_verificada", "4:ok", "5:ok", "6:ok"]);
});

test("falla temprano: sin acceso en la página 1 no se pide ninguna más; si falla el servicio, el resto va de a una", async () => {
  const blocked = fakeAnalyzer({}, (n) => (n === 1 ? { failure: "sin_acceso" } : {}));
  const r1 = await runPages({ total: 5, isCurrent: () => true, analyzePage: blocked.analyzePage, onPageError: noError });
  assert.equal(r1.status, "sin_acceso");
  if (r1.status === "sin_acceso") assert.deepEqual(r1.pending, [2, 3, 4, 5]);
  assert.deepEqual(blocked.started, [1]);

  const down = fakeAnalyzer({}, (n) => (n === 1 ? { failure: "error" } : {}));
  const r2 = await runPages({ total: 5, isCurrent: () => true, analyzePage: down.analyzePage, onPageError: noError });
  assert.equal(r2.status, "completa");
  if (r2.status === "completa") assert.equal(r2.mode, "serie");
  assert.equal(down.maxInFlight, 1);

  // Sin acceso a mitad de camino (la sesión vence): las que ya salieron terminan, no sale ninguna más.
  const expires = fakeAnalyzer({}, (n) => (n === 3 ? { failure: "sin_acceso" } : {}));
  const r3 = await runPages({ total: 10, isCurrent: () => true, analyzePage: expires.analyzePage, onPageError: noError });
  assert.equal(r3.status, "sin_acceso");
  assert.ok(expires.started.length < 10);
});

test("el historial se registra una sola vez, al terminar todas, aunque terminen casi juntas", async () => {
  const sent: unknown[] = [];
  const send = async (e: unknown) => (sent.push(e), true);
  const a = fakeAnalyzer({ 2: 3, 3: 3, 4: 3 });
  const r = await runPages({ total: 4, isCurrent: () => true, analyzePage: a.analyzePage, onPageError: noError });
  assert.equal(r.status, "completa");
  if (r.status === "completa") await recordFinishedRun("a.pdf", r.outcomes, 4, send);
  assert.equal(sent.length, 1);
  assert.equal((sent[0] as { paginas: number }).paginas, 4);

  // Corrida cortada o sin acceso: runPages no devuelve resultados completos y no hay nada que registrar.
  const blocked = fakeAnalyzer({}, (n) => (n === 2 ? { failure: "sin_acceso" } : {}));
  const r2 = await runPages({ total: 4, isCurrent: () => true, analyzePage: blocked.analyzePage, onPageError: noError });
  assert.notEqual(r2.status, "completa");
});
