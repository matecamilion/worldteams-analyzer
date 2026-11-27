import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";
import { loadPdf } from "../lib/detector/pdf";
import { buildMarkedPdf } from "../lib/detector/marked-pdf";
import { numberFindings, summarize } from "../lib/detector/report";
import {
  applyReview,
  dismiss,
  IOU_MIN,
  iou,
  MAX_DISMISSED_PER_PAGE,
  restore,
  signatureOf,
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

test("vectorial: se reconoce por firma aunque el análisis nuevo cambie los ids y el orden", () => {
  const a = finding("p1-choque-1", { x: 100, y: 100, w: 80, h: 12 });
  const b = finding("p1-choque-2", { x: 400, y: 300, w: 80, h: 12 }, { texts: ["BAÑO", "PASO"] });
  const review = dismiss({}, a);
  // Reanálisis: mismos hallazgos, ids cambiados, y textos en otro orden (la firma los ordena).
  const again = [page([
    finding("p1-choque-1", b.box, { texts: ["BAÑO", "PASO"] }),
    finding("p1-choque-2", a.box, { texts: ["LAVADERO", "COCINA"] }),
  ])];
  const r = applyReview(again, review);
  assert.deepEqual(ids(r.pages), ["p1-choque-1"]);
  assert.equal(r.dismissed.length, 1);
  assert.deepEqual(r.dismissed[0].texts, ["LAVADERO", "COCINA"]);
});

test("vectorial: mismos textos en otro lugar es otro hallazgo y no se oculta", () => {
  const a = finding("x", { x: 100, y: 100, w: 80, h: 12 });
  const review = dismiss({}, a);
  const elsewhere = finding("y", { x: 600, y: 500, w: 80, h: 12 });
  const otherType = finding("z", a.box, { severity: "cercania" });
  assert.deepEqual(ids(applyReview([page([elsewhere, otherType])], review).pages), ["y", "z"]);
});

test(`IA: se reconoce por geometría con IoU ≥ ${IOU_MIN}, no por texto`, () => {
  const original = ia("p1-ia-1", { x: 200, y: 200, w: 100, h: 20 });
  const review = dismiss({}, original);
  // La IA lee otros textos y corre la caja un poco: IoU ≈ 0,82.
  const moved = ia("p1-ia-3", { x: 205, y: 201, w: 100, h: 20 }, { texts: ["TEXT0 A", "TEXTO 8"] });
  assert.ok(iou(original.boxNorm, moved.boxNorm) >= IOU_MIN);
  assert.deepEqual(ids(applyReview([page([moved], { kind: "image" })], review).pages), []);
  // Corrida más: IoU ≈ 0,43 (debajo del umbral) → no se oculta.
  const far = ia("p1-ia-1", { x: 240, y: 205, w: 100, h: 20 });
  assert.ok(iou(original.boxNorm, far.boxNorm) < IOU_MIN);
  assert.deepEqual(ids(applyReview([page([far], { kind: "image" })], review).pages), ["p1-ia-1"]);
  // Un vectorial en el mismo lugar no se oculta con un descarte de IA (ni al revés).
  const vec = finding("v", original.box);
  assert.deepEqual(ids(applyReview([page([vec])], review).pages), ["v"]);
});

test("IA: un vecino real que se superpone NO queda tapado: cada descarte oculta un solo hallazgo, el de mayor IoU", () => {
  const dismissed = ia("p1-ia-1", { x: 200, y: 200, w: 100, h: 20 });
  const review = dismiss({}, dismissed);
  const same = ia("a", { x: 202, y: 200, w: 100, h: 20 }); // IoU ≈ 0,96
  const neighbor = ia("b", { x: 215, y: 202, w: 100, h: 20 }); // IoU ≈ 0,66: pasa el umbral, pero es otro
  assert.ok(iou(dismissed.boxNorm, neighbor.boxNorm) >= IOU_MIN);
  const r = applyReview([page([neighbor, same], { kind: "image" })], review);
  assert.deepEqual(ids(r.pages), ["b"]);
  assert.deepEqual(r.dismissed.map((f) => f.id), ["a"]);
});

test("deshacer y volver a mostrar: la revisión es inmutable y restore la saca", () => {
  const a = finding("a", { x: 100, y: 100, w: 80, h: 12 });
  const b = ia("b", { x: 500, y: 400, w: 90, h: 14 });
  const r0: Review = {};
  const r1 = dismiss(r0, a);
  const r2 = dismiss(r1, b);
  assert.deepEqual(r0, {}, "el estado anterior queda intacto: Deshacer vuelve a él");
  assert.equal(r1[1].descartados.length, 1);
  assert.equal(dismiss(r2, a), r2, "descartar dos veces lo mismo no cambia nada");
  const pages = [page([a, b])];
  assert.deepEqual(ids(applyReview(pages, r2).pages), []);
  assert.deepEqual(ids(applyReview(pages, restore(r2, 1, signatureOf(a))).pages), ["a"]);
  assert.deepEqual(ids(applyReview(pages, r1).pages), ["b"]);
});

test("tope de entradas: por página se queda con los más nuevos, y por navegador con los PDFs modificados más recientes", () => {
  let review: Review = {};
  for (let i = 0; i < MAX_DISMISSED_PER_PAGE + 5; i++) review = dismiss(review, finding(`f${i}`, { x: i * 3, y: 10, w: 5, h: 5 }));
  assert.equal(review[1].descartados.length, MAX_DISMISSED_PER_PAGE);
  assert.equal(review[1].descartados[0].firma, signatureOf(finding("f5", { x: 15, y: 10, w: 5, h: 5 })));

  const store = new Map<string, string>();
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  } as Storage;
  const one = dismiss({}, finding("a", { x: 1, y: 1, w: 5, h: 5 }));
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
  const review = dismiss({}, findings[0]);
  const reviewed = applyReview(results, review);

  // Pantalla: lo mismo que calcula DetectorApp.
  const screen = numberFindings(reviewed.pages);
  assert.deepEqual(screen.map((f) => [f.n, f.texts.join(" × ")]), [[1, "BAÑO × PASO"], [2, "ESTAR × 1.20"]], "se renumera desde 1");
  assert.deepEqual(summarize(reviewed.pages), { choques: 1, cercanias: 1, duplicados: 0, noVerificadas: 0 });

  const pdf = await buildMarkedPdf({
    bytes,
    fileName: "x.pdf",
    pages: reviewed.pages,
    geometry: { 1: { view: [0, 0, W, H], rotate: 0 } },
    showNear: true,
    dismissedCount: reviewed.dismissed.length,
  });
  const doc = await loadPdf(pdf);
  const text = (await (await doc.getPage(doc.numPages)).getTextContent()).items.map((i) => ("str" in i ? i.str : "")).join("\n");
  assert.match(text, /1 choque · 0 duplicados · 1 cercanía/);
  assert.match(text, /1 hallazgo descartado por el usuario/);
  assert.match(text, /BAÑO \/ PASO/);
  assert.doesNotMatch(text, /COCINA/, "lo descartado no se lista");
  // En la lista del PDF, el n.º 1 es el mismo hallazgo que en la pantalla.
  const lines = text.split("\n");
  // Cada fila de la tabla: n.º, página, tipo, zona y textos (separados por blancos).
  for (const f of screen) {
    const at = lines.indexOf(f.texts.join(" / "));
    assert.equal(lines[at - 8], String(f.n), `n.º de ${f.texts.join(" / ")}`);
  }
});
