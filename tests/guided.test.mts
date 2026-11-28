import { test } from "node:test";
import assert from "node:assert/strict";
import { numberFindings } from "../lib/detector/report";
import { applyReview, decide, nextToReview, type Review } from "../lib/detector/review";
import type { Finding, PageResult } from "../lib/detector/types";

const f = (id: string, page: number, y: number, over: Partial<Finding> = {}): Finding => ({
  id, page, severity: "choque", box: { x: 100, y, w: 50, h: 10 }, boxNorm: { x: 0.1, y: y / 800, w: 0.05, h: 10 / 800 },
  texts: [id.toUpperCase(), "X"], zone: "z", confidence: 0.9, source: "vector", originLabel: "Texto del PDF", ...over,
});
const pg = (page: number, findings: Finding[]): PageResult => ({
  page, kind: "vector", width: 1000, height: 800, textCount: 1, findings, status: "ok", ms: 1,
});

/**
 * Simula el modo guiado tal como lo maneja DetectorApp: arranca en el primero por revisar y cada
 * decisión avanza al próximo por revisar (dando la vuelta) hasta que no queda ninguno.
 */
function walk(results: PageResult[], review: Review, answers: Record<string, "confirmado" | "falsa_alarma">) {
  const visited: string[] = [];
  let list = numberFindings(applyReview(results, review).pages);
  let current = nextToReview(list, null);
  while (current) {
    visited.push(current.id);
    const decided = current;
    review = decide(review, decided, answers[decided.id]);
    const next = nextToReview(list, decided.id, decided.id); // con la lista de antes de decidir, como en la app
    list = numberFindings(applyReview(results, review).pages);
    current = next && list.find((x) => x.id === next.id)!;
    assert.ok(visited.length <= 20, "no da vueltas para siempre");
  }
  return { visited, review, counts: applyReview(results, review).counts };
}

test("modo guiado: arranca en el primero por revisar, saltea los ya revisados y termina con todo revisado", () => {
  const results = [pg(1, [f("a", 1, 100), f("b", 1, 200), f("c", 1, 300)]), pg(2, [f("d", 2, 100)])];
  // "b" ya estaba confirmado de antes: el recorrido no se detiene ahí.
  const review = decide({}, results[0].findings[1], "confirmado");
  const { visited, counts } = walk(results, review, { a: "falsa_alarma", c: "confirmado", d: "falsa_alarma" });
  assert.deepEqual(visited, ["a", "c", "d"], "en orden de numeración, entre páginas");
  assert.deepEqual(counts, { total: 4, revisados: 4, confirmados: 2, falsasAlarmas: 2, porRevisar: 0 }, "Todo revisado");
});

test("modo guiado: si se entra a mitad, sigue desde ahí y da la vuelta hasta el principio", () => {
  const list = numberFindings(applyReview([pg(1, [f("a", 1, 100), f("b", 1, 200), f("c", 1, 300)])], {}).pages);
  assert.equal(nextToReview(list, "b")?.id, "c");
  assert.equal(nextToReview(list, "c")?.id, "a", "da la vuelta");
  assert.equal(nextToReview(list, "c", "a")?.id, "b", "saltea el que se acaba de decidir");
  assert.equal(nextToReview(list, "x")?.id, "a", "un id que ya no está (falsa alarma) arranca del principio");
  assert.equal(nextToReview([], null), null);
});

test("modo guiado: lo agregado a mano y lo confirmado no se preguntan; volver a por revisar lo vuelve a incluir", () => {
  const results = [pg(1, [f("a", 1, 100), f("b", 1, 200)])];
  let review = decide({}, results[0].findings[0], "confirmado");
  review = decide(review, results[0].findings[1], "confirmado");
  const list = numberFindings(applyReview(results, review).pages);
  assert.equal(nextToReview(list, null), null, "nada por revisar");
  const a = list.find((x) => x.id === "a")!;
  review = decide(review, a, "por_revisar");
  assert.equal(nextToReview(numberFindings(applyReview(results, review).pages), null)?.id, "a");
});
