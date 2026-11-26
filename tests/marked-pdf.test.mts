import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, degrees } from "pdf-lib";
import { loadPdf } from "../lib/detector/pdf";
import {
  buildMarkedPdf,
  findingScreenBox,
  markedFileName,
  markScreenBox,
  markStyle,
  screenRectToPdf,
  screenToPdf,
  toWinAnsi,
  viewportSize,
  viewportTransform,
  type PageGeometry,
} from "../lib/detector/marked-pdf";
import type { Finding, PageResult } from "../lib/detector/types";

const close = (got: number, want: number, msg = "") => assert.ok(Math.abs(got - want) < 1e-6, `${msg} ${got} vs ${want}`);

/** PDF de prueba: A4 apaisada con MediaBox corrida y CropBox más chica, en las cuatro rotaciones. */
async function rotatedPdf() {
  const doc = await PDFDocument.create();
  for (const r of [0, 90, 180, 270, -90, 450]) {
    const p = doc.addPage([842, 595]);
    p.setMediaBox(100, 50, 842, 595);
    p.setCropBox(120, 70, 800, 500);
    p.setRotation(degrees(r));
  }
  return new Uint8Array(await doc.save());
}

test("la matriz de pantalla coincide con la de pdfjs (rotación y origen distinto de cero)", async () => {
  const doc = await loadPdf(await rotatedPdf());
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const g: PageGeometry = { view: page.view as PageGeometry["view"], rotate: page.rotate };
    const vp = page.getViewport({ scale: 1 });
    viewportTransform(g).forEach((v, i) => close(v, vp.transform[i], `página ${n} [${i}]`));
    const size = viewportSize(g);
    close(size.w, vp.width);
    close(size.h, vp.height);
    // Ida y vuelta contra pdfjs: un punto de pantalla vuelve al mismo punto PDF que da pdfjs.
    const toPdf = screenToPdf(g);
    for (const [x, y] of [[0, 0], [33.5, 210], [vp.width, vp.height]] as [number, number][]) {
      const [px, py] = vp.convertToPdfPoint(x, y);
      const [qx, qy] = toPdf([x, y]);
      close(qx, px, `p${n} x`);
      close(qy, py, `p${n} y`);
    }
  }
});

test("caja de pantalla → rectángulo PDF, sin rotar y rotada 90°", () => {
  // Sin rotar, origen en (120, 70), 680×430: la pantalla mide y desde arriba (y1 = 500).
  const flat: PageGeometry = { view: [120, 70, 800, 500], rotate: 0 };
  assert.deepEqual(screenRectToPdf({ x: 10, y: 20, w: 30, h: 5 }, flat), { x: 130, y: 475, w: 30, h: 5 });
  // Rotada 90° (horario): en pantalla mide 430 de ancho × 680 de alto. El borde superior de la
  // pantalla es el borde izquierdo del PDF (x0 = 120) y la x de pantalla crece con la y del PDF.
  const rot: PageGeometry = { view: [120, 70, 800, 500], rotate: 90 };
  assert.deepEqual(viewportSize(rot), { w: 430, h: 680 });
  const r = screenRectToPdf({ x: 10, y: 20, w: 30, h: 5 }, rot);
  for (const [got, want] of [[r.x, 140], [r.y, 80], [r.w, 5], [r.h, 30]]) close(got, want);
});

test("las cajas de IA salen de la caja normalizada; las vectoriales, de la caja en pt", () => {
  const base = { id: "a", page: 1, severity: "choque" as const, texts: [] as string[], zone: "", confidence: 1, originLabel: "" };
  const vision: Finding = { ...base, source: "vision", box: { x: 0, y: 0, w: 0, h: 0 }, boxNorm: { x: 0.5, y: 0.25, w: 0.1, h: 0.01 } };
  assert.deepEqual(findingScreenBox(vision, { width: 1000, height: 800 }), { x: 500, y: 200, w: 100, h: 8 });
  const vector: Finding = { ...base, source: "vector", box: { x: 1, y: 2, w: 3, h: 4 }, boxNorm: { x: 0, y: 0, w: 0, h: 0 } };
  assert.deepEqual(findingScreenBox(vector, { width: 1000, height: 800 }), { x: 1, y: 2, w: 3, h: 4 });
});

test("estilo proporcional a la hoja y caja mínima visible", () => {
  const a4 = markStyle({ w: 595.28, h: 841.89 });
  const a3 = markStyle({ w: 1190.55, h: 841.89 });
  close(a3.lineWidth / a4.lineWidth, 841.89 / 595.28);
  close(a3.radius / a4.radius, 841.89 / 595.28);
  // Una caja de 2×1 pt crece al mínimo, centrada; y nunca se sale de la hoja.
  const tiny = markScreenBox({ x: 300, y: 300, w: 2, h: 1 }, { w: 595.28, h: 841.89 });
  close(tiny.w, a4.minSide);
  close(tiny.x + tiny.w / 2, 301);
  const edge = markScreenBox({ x: 0, y: 0, w: 2, h: 1 }, { w: 595.28, h: 841.89 });
  assert.equal(edge.x, 0);
  assert.equal(edge.y, 0);
});

test("texto apto para Helvetica estándar y nombre del archivo", () => {
  assert.equal(toWinAnsi("BAÑO × VESTIDOR – ejes 4–5 «ñ» €"), "BAÑO × VESTIDOR – ejes 4–5 «ñ» €");
  assert.equal(toWinAnsi("Ő ≠ ☃\nfin"), "O ? ? fin");
  assert.equal(markedFileName("Planta Baja.PDF"), "Planta Baja-con-marcas.pdf");
});

test("el PDF con marcas conserva las páginas, agrega el resumen y respeta 'Mostrar cercanías'", async () => {
  const src = await PDFDocument.create();
  src.addPage([595.28, 841.89]);
  const bytes = await src.save();
  const f = (id: string, severity: Finding["severity"]): Finding => ({
    id, page: 1, severity, box: { x: 100, y: 100, w: 50, h: 10 }, boxNorm: { x: 0, y: 0, w: 0, h: 0 },
    texts: ["COCINA", "ESTAR ☃"], zone: "sector superior", confidence: 0.9, source: "vector", originLabel: "Texto del PDF",
  });
  const pages: PageResult[] = [
    { page: 1, kind: "vector", width: 595.28, height: 841.89, textCount: 2, findings: [f("a", "choque"), f("b", "cercania")], status: "ok", ms: 1 },
    { page: 2, kind: "empty", width: 0, height: 0, textCount: 0, findings: [], status: "no_verificada", error: "Falló la IA", ms: 0 },
  ];
  const geometry = { 1: { view: [0, 0, 595.28, 841.89] as PageGeometry["view"], rotate: 0 } };
  const on = await PDFDocument.load(await buildMarkedPdf({ bytes, fileName: "x.pdf", pages, geometry, showNear: true }));
  const off = await PDFDocument.load(await buildMarkedPdf({ bytes, fileName: "x.pdf", pages, geometry, showNear: false }));
  assert.equal(on.getPageCount(), 2);
  assert.equal(off.getPageCount(), 2);
  const ops = async (d: PDFDocument) => (await loadPdf(new Uint8Array(await d.save()))).getPage(1).then((p) => p.getOperatorList()).then((l) => l.fnArray.length);
  assert.ok((await ops(on)) > (await ops(off)), "con cercanías se dibuja más");
});
