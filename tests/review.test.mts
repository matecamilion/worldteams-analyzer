import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";
import { loadPdf } from "../lib/detector/pdf";
import { buildMarkedPdf } from "../lib/detector/marked-pdf";
import { numberFindings, reviewLabel, summarize } from "../lib/detector/report";
import {
  applyReview,
  decide,
  IOU_MIN,
  iou,
  MAX_DECISIONS_PER_PAGE,
  migrateReview,
  signatureOf,
  stateOf,
  type Review,
} from "../lib/detector/review";
import { loadReview, MAX_REVIEWED_PDFS, saveReview } from "../lib/client/review-store";
import type { Finding, PageResult } from "../lib/detector/types";

const W = 1000;
const H = 800;
/** Hallazgo con la caja en pt; boxNorm se calcula sobre una hoja de 1000 × 800. */
function finding(id: string, box: { x: number; y: number; w: number; h: number }, over: Partial<Finding> = {}): Finding {
  return {
    id,
    page: 1,
    severity: "choque",
    box,
    boxNorm: { x: box.x / W, y: box.y / H, w: box.w / W, h: box.h / H },
    texts: ["COCINA", "LAVADERO"],
    zone: "z",
    confidence: 0.9,
    source: "vector",
    originLabel: "Texto del PDF",
    ...over,
  };
}
const page = (findings: Finding[], over: Partial<PageResult> = {}): PageResult => ({
  page: 1, kind: "vector", width: W, height: H, textCount: 10, findings, status: "ok", ms: 1, ...over,
});
const ia = (id: string, box: { x: number; y: number; w: number; h: number }, over: Partial<Finding> = {}) =>
  finding(id, box, { source: "vision", originLabel: "Detectado por IA", texts: ["TEXTO A", "TEXTO B"], ...over });
const ids = (pages: PageResult[]) => pages.flatMap((p) => p.findings.map((f) => f.id));
/** id → estado, tal como lo ve la pantalla (las falsas alarmas no están). */
const states = (pages: PageResult[]) => Object.fromEntries(pages.flatMap((p) => p.findings.map((f) => [f.id, stateOf(f)])));
/** El hallazgo tal como lo muestra la pantalla (con reviewState/reviewFirma), para decidir sobre él. */
const shown = (pages: PageResult[], review: Review, id: string) => {
  const r = applyReview(pages, review);
  return r.pages.flatMap((p) => p.findings).find((f) => f.id === id) ?? r.falseAlarms.find((f) => f.id === id)!;
};

test("transiciones: por revisar → confirmado → falsa alarma → por revisar, sin mutar los estados anteriores", () => {
  const a = finding("a", { x: 100, y: 100, w: 80, h: 12 });
  const pages = [page([a])];
  const r0: Review = {};
  assert.deepEqual(states(applyReview(pages, r0).pages), { a: "por_revisar" }, "por defecto, por revisar");
  assert.equal(reviewLabel(applyReview(pages, r0).pages[0].findings[0]), "Posible choque");

  const r1 = decide(r0, shown(pages, r0, "a"), "confirmado");
  assert.deepEqual(states(applyReview(pages, r1).pages), { a: "confirmado" });
  assert.equal(reviewLabel(applyReview(pages, r1).pages[0].findings[0]), "Choque confirmado");
  assert.equal(decide(r1, shown(pages, r1, "a"), "confirmado"), r1, "repetir el mismo estado no cambia nada");

  const r2 = decide(r1, shown(pages, r1, "a"), "falsa_alarma");
  const v2 = applyReview(pages, r2);
  assert.deepEqual(ids(v2.pages), [], "una falsa alarma se saca");
  assert.deepEqual(v2.falseAlarms.map((f) => f.id), ["a"]);
  assert.equal(r2[1].decisiones.length, 1, "cambiar de estado reemplaza la decisión, no la duplica");

  const r3 = decide(r2, v2.falseAlarms[0], "por_revisar");
  assert.deepEqual(states(applyReview(pages, r3).pages), { a: "por_revisar" });
  assert.equal(r3[1].decisiones.length, 0);
  // Falsa alarma → confirmado directo (desde la lista de falsas alarmas).
  assert.deepEqual(states(applyReview(pages, decide(r2, v2.falseAlarms[0], "confirmado")).pages), { a: "confirmado" });

  // Deshacer vuelve a un objeto anterior, que quedó intacto.
  assert.deepEqual(r0, {});
  assert.equal(r1[1].decisiones[0].estado, "confirmado");
  // Lo agregado a mano no se revisa: nace confirmado.
  assert.equal(decide(r0, { ...a, source: "manual" }, "falsa_alarma"), r0);
});

test("vectorial: se reconoce por firma aunque el análisis nuevo cambie los ids y el orden (confirmados y falsas alarmas)", () => {
  const a = finding("p1-choque-1", { x: 100, y: 100, w: 80, h: 12 });
  const b = finding("p1-choque-2", { x: 400, y: 300, w: 80, h: 12 }, { texts: ["BAÑO", "PASO"] });
  const c = finding("p1-choque-3", { x: 600, y: 600, w: 80, h: 12 }, { texts: ["ESTAR", "COMEDOR"] });
  let review = decide({}, a, "falsa_alarma");
  review = decide(review, b, "confirmado");
  // Reanálisis: mismos hallazgos, ids cambiados, y textos en otro orden (la firma los ordena).
  const again = [page([
    finding("p1-choque-1", c.box, { texts: ["ESTAR", "COMEDOR"] }),
    finding("p1-choque-2", b.box, { texts: ["PASO", "BAÑO"] }),
    finding("p1-choque-3", a.box, { texts: ["LAVADERO", "COCINA"] }),
  ])];
  const r = applyReview(again, review);
  assert.deepEqual(states(r.pages), { "p1-choque-1": "por_revisar", "p1-choque-2": "confirmado" });
  assert.deepEqual(r.falseAlarms.map((f) => f.texts), [["LAVADERO", "COCINA"]]);
  assert.deepEqual(r.counts, { total: 3, revisados: 2, confirmados: 1, falsasAlarmas: 1, porRevisar: 1 });
});

test("vectorial: mismos textos en otro lugar u otro tipo es otro hallazgo y no hereda el estado", () => {
  const a = finding("x", { x: 100, y: 100, w: 80, h: 12 });
  const review = decide({}, a, "falsa_alarma");
  const elsewhere = finding("y", { x: 600, y: 500, w: 80, h: 12 });
  const otherType = finding("z", a.box, { severity: "cercania" });
  assert.deepEqual(states(applyReview([page([elsewhere, otherType])], review).pages), { y: "por_revisar", z: "por_revisar" });
});

test(`IA: confirmados y falsas alarmas se reconocen por geometría con IoU ≥ ${IOU_MIN}, no por texto`, () => {
  const original = ia("p1-ia-1", { x: 200, y: 200, w: 100, h: 20 });
  const other = ia("p1-ia-2", { x: 600, y: 500, w: 100, h: 20 });
  let review = decide({}, original, "falsa_alarma");
  review = decide(review, other, "confirmado");
  // La IA lee otros textos y corre las cajas un poco: IoU ≈ 0,82.
  const moved = ia("p1-ia-3", { x: 205, y: 201, w: 100, h: 20 }, { texts: ["TEXT0 A", "TEXTO 8"] });
  const movedOther = ia("p1-ia-1", { x: 604, y: 499, w: 100, h: 20 });
  assert.ok(iou(original.boxNorm, moved.boxNorm) >= IOU_MIN);
  const r = applyReview([page([moved, movedOther], { kind: "image" })], review);
  assert.deepEqual(states(r.pages), { "p1-ia-1": "confirmado" });
  assert.deepEqual(r.falseAlarms.map((f) => f.id), ["p1-ia-3"]);
  // Corrida más: IoU ≈ 0,43 (debajo del umbral) → vuelve a estar por revisar.
  const far = ia("p1-ia-1", { x: 240, y: 205, w: 100, h: 20 });
  assert.ok(iou(original.boxNorm, far.boxNorm) < IOU_MIN);
  assert.deepEqual(states(applyReview([page([far], { kind: "image" })], review).pages), { "p1-ia-1": "por_revisar" });
  // Un vectorial en el mismo lugar no hereda la decisión de la IA (ni al revés).
  assert.deepEqual(states(applyReview([page([finding("v", original.box)])], review).pages), { v: "por_revisar" });

  // Cambiar de idea sobre el reconocido reemplaza la decisión vieja (no quedan dos).
  const confirmed = r.pages[0].findings[0];
  const changed = decide(review, confirmed, "por_revisar");
  assert.equal(changed[1].decisiones.length, 1);
  assert.deepEqual(states(applyReview([page([movedOther], { kind: "image" })], changed).pages), { "p1-ia-1": "por_revisar" });
});

test("IA: un vecino real que se superpone NO hereda el estado: cada decisión alcanza a un solo hallazgo, el de mayor IoU", () => {
  const decided = ia("p1-ia-1", { x: 200, y: 200, w: 100, h: 20 });
  for (const estado of ["falsa_alarma", "confirmado"] as const) {
    const review = decide({}, decided, estado);
    const same = ia("a", { x: 202, y: 200, w: 100, h: 20 }); // IoU ≈ 0,96
    const neighbor = ia("b", { x: 215, y: 202, w: 100, h: 20 }); // IoU ≈ 0,66: pasa el umbral, pero es otro
    assert.ok(iou(decided.boxNorm, neighbor.boxNorm) >= IOU_MIN);
    const r = applyReview([page([neighbor, same], { kind: "image" })], review);
    assert.equal(states(r.pages).b, "por_revisar", estado);
    assert.equal(estado === "falsa_alarma" ? r.falseAlarms[0].id : states(r.pages).a, estado === "falsa_alarma" ? "a" : "confirmado");
  }
});

test("migración: el formato anterior («Está bien» → descartados) pasa a falsas alarmas sin perder nada", () => {
  const a = finding("a", { x: 100, y: 100, w: 80, h: 12 });
  const b = ia("b", { x: 500, y: 400, w: 90, h: 14 });
  const old = {
    1: {
      descartados: [a, b].map((f) => ({ firma: signatureOf(f), tipo: f.severity, boxNorm: f.boxNorm, textos: f.texts, fecha: "2026-11-01T10:00:00.000Z" })),
      manuales: [{ id: "m1", box: { x: 10, y: 10, w: 20, h: 20 }, boxNorm: { x: 0.01, y: 0.0125, w: 0.02, h: 0.025 }, nota: "ojo", fecha: "2026-11-01T10:00:00.000Z" }],
    },
    2: { descartados: [] },
    basura: { descartados: [{ firma: 1 }] },
  };
  const migrated = migrateReview(old);
  assert.deepEqual(Object.keys(migrated), ["1"]);
  assert.deepEqual(migrated[1].decisiones.map((d) => [d.firma, d.estado, d.fecha]), [
    [signatureOf(a), "falsa_alarma", "2026-11-01T10:00:00.000Z"],
    [signatureOf(b), "falsa_alarma", "2026-11-01T10:00:00.000Z"],
  ]);
  assert.equal(migrated[1].manuales?.[0].nota, "ojo");
  const r = applyReview([page([a, b])], migrated);
  assert.deepEqual(r.falseAlarms.map((f) => f.id).sort(), ["a", "b"]);
  assert.deepEqual(r.counts, { total: 3, revisados: 3, confirmados: 1, falsasAlarmas: 2, porRevisar: 0 }, "la marca a mano cuenta como confirmada");
  // El formato nuevo pasa igual; basura no rompe.
  assert.deepEqual(migrateReview(migrated), migrated);
  for (const bad of [null, 3, "x", [], { 1: "x" }]) assert.deepEqual(migrateReview(bad), {});

  // Desde localStorage: lo guardado con el formato viejo se lee ya migrado.
  const store = new Map([["revisor:revision:h", JSON.stringify(old)]]);
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: () => {}, removeItem: () => {} } as unknown as Storage;
  assert.deepEqual(loadReview("h", storage), migrated);
});

test("Reintentar: reanalizar una página (resultado nuevo, ids nuevos) no pierde nada de la revisión", () => {
  const p1 = [finding("p1-choque-1", { x: 100, y: 100, w: 80, h: 12 }), finding("p1-choque-2", { x: 100, y: 300, w: 80, h: 12 }, { texts: ["X", "Y"] })];
  const p2 = [ia("p2-ia-1", { x: 200, y: 200, w: 100, h: 20 }, { page: 2 }), ia("p2-ia-2", { x: 600, y: 500, w: 100, h: 20 }, { page: 2 })];
  const before = [page(p1), page(p2, { page: 2, kind: "image" })];
  let review = decide({}, p1[0], "confirmado");
  review = decide(review, p2[0], "falsa_alarma");
  review = decide(review, p2[1], "confirmado");
  const countsBefore = applyReview(before, review).counts;
  // Reintentar la página 2: la IA devuelve las cajas un poco corridas y en otro orden; la 1 queda igual.
  const retried = [before[0], page([ia("p2-ia-1", { x: 603, y: 502, w: 100, h: 20 }, { page: 2 }), ia("p2-ia-2", { x: 198, y: 201, w: 100, h: 20 }, { page: 2 })], { page: 2, kind: "image" })];
  const after = applyReview(retried, review);
  assert.deepEqual(after.counts, countsBefore);
  assert.deepEqual(states(after.pages), { "p1-choque-1": "confirmado", "p1-choque-2": "por_revisar", "p2-ia-1": "confirmado" });
  assert.deepEqual(after.falseAlarms.map((f) => f.id), ["p2-ia-2"]);
  // Mientras la página se reanaliza (sin resultado) sus decisiones no se pierden: siguen guardadas.
  const during = applyReview([before[0]], review);
  assert.equal(during.counts.total, 2);
  assert.equal(review[2].decisiones.length, 2);
});

test("tope de entradas: por página se queda con las más nuevas, y por navegador con los PDFs modificados más recientes", () => {
  let review: Review = {};
  for (let i = 0; i < MAX_DECISIONS_PER_PAGE + 5; i++) review = decide(review, finding(`f${i}`, { x: i * 3, y: 10, w: 5, h: 5 }), i % 2 ? "confirmado" : "falsa_alarma");
  assert.equal(review[1].decisiones.length, MAX_DECISIONS_PER_PAGE);
  assert.equal(review[1].decisiones[0].firma, signatureOf(finding("f5", { x: 15, y: 10, w: 5, h: 5 })));

  const store = new Map<string, string>();
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  } as Storage;
  const one = decide({}, finding("a", { x: 1, y: 1, w: 5, h: 5 }), "confirmado");
  for (let i = 0; i < MAX_REVIEWED_PDFS + 3; i++) saveReview(`hash${i}`, one, storage);
  assert.deepEqual(loadReview("hash0", storage), {}, "el más viejo se borró");
  assert.deepEqual(loadReview(`hash${MAX_REVIEWED_PDFS + 2}`, storage), one);
  assert.equal([...store.keys()].filter((k) => k.startsWith("revisor:revision:hash")).length, MAX_REVIEWED_PDFS);
  // Vacía: se borra. Dañada o sin localStorage: {} sin lanzar.
  saveReview("hash100", {}, storage);
  assert.equal(store.has("revisor:revision:hash100"), false);
  store.set("revisor:revision:roto", "{no es json");
  assert.deepEqual(loadReview("roto", storage), {});
  assert.deepEqual(loadReview("x", undefined), {});
  const full = { ...storage, setItem: () => { throw new Error("QuotaExceededError"); } } as Storage;
  assert.doesNotThrow(() => saveReview("y", one, full));
});

test("contadores y numeración: la pantalla y el PDF exportado coinciden después de revisar", async () => {
  const src = await PDFDocument.create();
  src.addPage([W, H]);
  const bytes = await src.save();
  const findings = [
    finding("p1-choque-1", { x: 100, y: 100, w: 80, h: 12 }),
    finding("p1-choque-2", { x: 100, y: 300, w: 80, h: 12 }, { texts: ["BAÑO", "PASO"] }),
    finding("p1-cercania-1", { x: 100, y: 500, w: 80, h: 12 }, { severity: "cercania", texts: ["ESTAR", "1.20"] }),
  ];
  const results = [page(findings)];
  let review = decide({}, findings[0], "falsa_alarma");
  review = decide(review, findings[1], "confirmado");
  const reviewed = applyReview(results, review);

  // Pantalla: lo mismo que calcula DetectorApp.
  const screen = numberFindings(reviewed.pages);
  assert.deepEqual(screen.map((f) => [f.n, f.texts.join(" × "), f.reviewState]), [[1, "BAÑO × PASO", "confirmado"], [2, "ESTAR × 1.20", "por_revisar"]], "se renumera desde 1");
  assert.deepEqual(summarize(reviewed.pages), { choques: 1, cercanias: 1, duplicados: 0, noVerificadas: 0 });
  assert.deepEqual(reviewed.counts, { total: 3, revisados: 2, confirmados: 1, falsasAlarmas: 1, porRevisar: 1 });

  const pdf = await buildMarkedPdf({
    bytes,
    fileName: "x.pdf",
    pages: reviewed.pages,
    geometry: { 1: { view: [0, 0, W, H], rotate: 0 } },
    showNear: true,
    falseAlarmCount: reviewed.counts.falsasAlarmas,
  });
  const doc = await loadPdf(pdf);
  const text = (await (await doc.getPage(doc.numPages)).getTextContent()).items.map((i) => ("str" in i ? i.str : "")).join("\n");
  assert.match(text, /1 choque · 0 duplicados · 1 cercanía/);
  assert.match(text, /1 falsa alarma según la revisión del usuario/);
  assert.doesNotMatch(text, /Está bien|descartad/);
  assert.match(text, /BAÑO \/ PASO/);
  assert.doesNotMatch(text, /COCINA/, "la falsa alarma no se lista");
  // En la lista del PDF, el n.º 1 es el mismo hallazgo que en la pantalla.
  const lines = text.split("\n");
  // Cada fila de la tabla: n.º, página, tipo, zona y textos (separados por blancos).
  for (const f of screen) {
    const at = lines.indexOf(f.texts.join(" / "));
    assert.equal(lines[at - 8], String(f.n), `n.º de ${f.texts.join(" / ")}`);
  }
});
