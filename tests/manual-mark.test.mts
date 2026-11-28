import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PDFDocument } from "pdf-lib";
import { loadPdf } from "../lib/detector/pdf";
import { buildMarkedPdf, findingScreenBox, screenRectToPdf, viewportSize, type PageGeometry } from "../lib/detector/marked-pdf";
import { numberFindings, summarize } from "../lib/detector/report";
import { addManual, applyReview, decide, removeManual, setManualNote, type Review } from "../lib/detector/review";
import { clampView, dragToPageBox, pageToScreen, screenToPage, translation, type View } from "../lib/client/zoom";
import type { PageResult } from "../lib/detector/types";

const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≠ ${b}`);
const closeBox = (a: { x: number; y: number; w: number; h: number }, b: typeof a, eps = 1e-6) => {
  close(a.x, b.x, eps);
  close(a.y, b.y, eps);
  close(a.w, b.w, eps);
  close(a.h, b.h, eps);
};
const emptyPage = (page: number, w: number, h: number, over: Partial<PageResult> = {}): PageResult => ({
  page, kind: "vector", width: w, height: h, textCount: 0, findings: [], status: "ok", ms: 1, ...over,
});

test("pantalla → pt es la inversa exacta de cómo se dibujan las cajas, con y sin zoom", () => {
  const page = { w: 1190.55, h: 841.89 };
  const frame = { w: 375, h: (375 * page.h) / page.w };
  for (const v of [{ cx: page.w / 2, cy: page.h / 2, s: 1 }, { cx: 300, cy: 200, s: 4 }, { cx: 1100, cy: 800, s: 7.3 }] as View[]) {
    const c = clampView(v, page);
    const t = translation(c, page, frame);
    for (const p of [{ x: 0, y: 0 }, { x: 123.4, y: 56.7 }, { x: 374, y: frame.h }]) {
      const pt = screenToPage(p, v, page, frame);
      // Misma cuenta que PageView: left = t.tx + x·k·s.
      close(t.tx + pt.x * t.k * c.s, p.x);
      close(t.ty + pt.y * t.k * c.s, p.y);
      const back = pageToScreen(pt, v, page, frame);
      close(back.x, p.x);
      close(back.y, p.y);
    }
  }
});

test("el recuadro arrastrado: en cualquier dirección, recortado a la hoja, y vacío si queda afuera", () => {
  const page = { w: 1000, h: 800 };
  const frame = { w: 500, h: 400 };
  const v = { cx: 500, cy: 400, s: 1 };
  const box = dragToPageBox({ x: 100, y: 50 }, { x: 200, y: 150 }, v, page, frame)!;
  assert.deepEqual(box, { x: 200, y: 100, w: 200, h: 200 });
  assert.deepEqual(dragToPageBox({ x: 200, y: 150 }, { x: 100, y: 50 }, v, page, frame), box, "de abajo-derecha a arriba-izquierda");
  // Se sale por la izquierda y por abajo: se recorta a la hoja.
  assert.deepEqual(dragToPageBox({ x: -50, y: 300 }, { x: 50, y: 900 }, v, page, frame), { x: 0, y: 600, w: 100, h: 200 });
  // Con zoom, fuera de la parte visible de la hoja sigue siendo hoja (no se recorta al marco).
  const zoomed = { cx: 900, cy: 700, s: 4 };
  const z = dragToPageBox({ x: 400, y: 300 }, { x: 600, y: 500 }, zoomed, page, frame)!;
  assert.ok(z.x + z.w <= page.w && z.y + z.h <= page.h);
  assert.equal(dragToPageBox({ x: -100, y: -100 }, { x: -10, y: -10 }, v, page, frame), null);
});

for (const file of ["4-vectorial-rotado.pdf", "5-cad-rotado.pdf", "6-escaneado-rotado.pdf"]) {
  test(`${file}: el recuadro dibujado y el exportado coinciden en cada página`, async () => {
    const doc = await loadPdf(new Uint8Array(await readFile(`samples/${file}`)));
    let review: Review = {};
    const results: PageResult[] = [];
    const geometry: Record<number, PageGeometry> = {};
    const drawn: Record<number, { x: number; y: number; w: number; h: number }> = {};
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale: 1 }); // lo que usa PageView como tamaño de la hoja
      const g: PageGeometry = { view: page.view as PageGeometry["view"], rotate: page.rotate };
      geometry[n] = g;
      const size = { w: vp.width, h: vp.height };
      closeBox({ x: 0, y: 0, ...viewportSize(g) }, { x: 0, y: 0, ...size }, 1e-6);
      // Arrastre en un marco de 375 px con zoom ×3 sobre un tercio de la hoja.
      const frame = { w: 375, h: (375 * size.h) / size.w };
      const v = { cx: size.w * 0.4, cy: size.h * 0.6, s: 3 };
      const box = dragToPageBox({ x: 90, y: 60 }, { x: 260, y: 140 }, v, size, frame)!;
      drawn[n] = box;
      review = addManual(review, n, box, size, { id: `m${n}`, nota: "COTA × EJE" }).review;
      results.push(emptyPage(n, size.w, size.h));

      // La pantalla dibuja la marca donde se arrastró.
      const f = applyReview([results[n - 1]], review).pages[0].findings[0];
      const a = pageToScreen({ x: f.box.x, y: f.box.y }, v, size, frame);
      const b = pageToScreen({ x: f.box.x + f.box.w, y: f.box.y + f.box.h }, v, size, frame);
      close(a.x, 90);
      close(a.y, 60);
      close(b.x, 260);
      close(b.y, 140);

      // El PDF la ubica con la geometría de la página (caja visible y /Rotate): de vuelta a la
      // pantalla de pdf.js tiene que caer en el mismo lugar.
      const pdfRect = screenRectToPdf(findingScreenBox(f, results[n - 1]), g);
      const [x1, y1] = vp.convertToViewportPoint(pdfRect.x, pdfRect.y);
      const [x2, y2] = vp.convertToViewportPoint(pdfRect.x + pdfRect.w, pdfRect.y + pdfRect.h);
      closeBox({ x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) }, box, 1e-6);
    }

    // Y el PDF exportado lleva una marca por página y la lista con la nota.
    const reviewed = applyReview(results, review);
    const out = await loadPdf(
      await buildMarkedPdf({ bytes: await readFile(`samples/${file}`), fileName: file, pages: reviewed.pages, geometry, showNear: true }),
    );
    const text = (await (await out.getPage(out.numPages)).getTextContent()).items.map((i) => ("str" in i ? i.str : "")).join("\n");
    assert.match(text, new RegExp(`${doc.numPages} (errores marcados|error marcado) a mano`));
    assert.equal(text.match(/Marcado a mano: COTA × EJE/g)?.length, doc.numPages);
  });
}

test("marca a mano: es un choque confirmado, se cuenta, se numera, lleva nota y se puede borrar", async () => {
  const W = 800;
  const H = 600;
  const base = [emptyPage(1, W, H, {
    findings: [{
      id: "p1-choque-1", page: 1, severity: "choque", box: { x: 100, y: 100, w: 50, h: 10 },
      boxNorm: { x: 100 / W, y: 100 / H, w: 50 / W, h: 10 / H }, texts: ["A", "B"], zone: "z",
      confidence: 0.9, source: "vector", originLabel: "Texto del PDF",
    }],
  })];
  const added = addManual({}, 1, { x: 300, y: 50, w: 80, h: 40 }, { w: W, h: H }, { id: "abc" });
  assert.equal(added.findingId, "p1-manual-abc");
  let review = setManualNote(added.review, 1, "abc", "  cota encima del eje  ");
  const r = applyReview(base, review);
  const numbered = numberFindings(r.pages);
  assert.deepEqual(numbered.map((f) => [f.n, f.source]), [[1, "manual"], [2, "vector"]], "va arriba: se numera por posición");
  const m = numbered[0];
  assert.equal(m.severity, "choque");
  assert.equal(m.originLabel, "Marcado a mano");
  assert.equal(m.note, "cota encima del eje");
  assert.deepEqual(m.texts, []);
  assert.deepEqual(m.boxNorm, { x: 300 / W, y: 50 / H, w: 80 / W, h: 40 / H });
  assert.equal(summarize(r.pages).choques, 2);
  assert.equal(m.reviewState, "confirmado", "lo agregado a mano nace confirmado");
  assert.equal(decide(review, m, "falsa_alarma"), review, "una marca a mano no se revisa: se borra");
  review = removeManual(review, 1, "abc");
  assert.equal(summarize(applyReview(base, review).pages).choques, 1);

  // En el PDF: la fila dice "Marcado a mano: <nota>" y no lleva la leyenda de texto leído por IA.
  const src = await PDFDocument.create();
  src.addPage([W, H]);
  const withNote = setManualNote(added.review, 1, "abc", "cota encima del eje");
  const pdf = await buildMarkedPdf({
    bytes: await src.save(),
    fileName: "x.pdf",
    pages: applyReview(base, withNote).pages,
    geometry: { 1: { view: [0, 0, W, H], rotate: 0 } },
    showNear: true,
  });
  const out = await loadPdf(pdf);
  const text = (await (await out.getPage(out.numPages)).getTextContent()).items.map((i) => ("str" in i ? i.str : "")).join("\n");
  assert.match(text, /Marcado a mano: cota encima del eje/);
  assert.match(text, /1 error marcado a mano por el usuario/);
  assert.doesNotMatch(text, /leído por IA/);
});
