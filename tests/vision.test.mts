import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { planTiles, touchesInnerEdge } from "../lib/detector/tiles";
import { analyzeImagePage, mergeCandidates, TILES_PASS } from "../lib/detector/image";
import { loadPdf } from "../lib/detector/pdf";
import { parseBoxes, VisionError, type VisionProvider } from "../lib/vision/provider";

test("los mosaicos cubren toda la imagen con el solape pedido", () => {
  const tiles = planTiles(2481, 1754, 1400, 250);
  assert.equal(tiles.length, 4);
  assert.equal(Math.max(...tiles.map((t) => t.x + t.w)), 2481);
  assert.equal(Math.max(...tiles.map((t) => t.y + t.h)), 1754);
  const [a, b] = tiles;
  assert.ok(a.x + a.w - b.x >= 250);
});

test("una caja pegada al corte interno se descarta, una pegada al borde de la página no", () => {
  const tile = { index: 0, x: 0, y: 0, w: 1400, h: 1000 };
  const img = { width: 2481, height: 1754 };
  assert.equal(touchesInnerEdge({ x: 1350, y: 100, w: 48, h: 20 }, tile, img, 6), true);
  assert.equal(touchesInnerEdge({ x: 0, y: 0, w: 40, h: 20 }, tile, img, 6), false);
});

test("se unen choques repetidos entre mosaicos, pero no dos choques distintos con el mismo texto", () => {
  const merged = mergeCandidates([
    { box: { x: 270, y: 300, w: 56, h: 13 }, texts: ["BAÑO", "VESTIDOR"], confidence: 0.9, tiles: ["m#0"], passes: ["mosaicos"] },
    { box: { x: 272, y: 301, w: 55, h: 12 }, texts: ["BAÑO", "VESTIDOR"], confidence: 0.8, tiles: ["m#1"], passes: ["mosaicos"] },
    { box: { x: 270, y: 450, w: 56, h: 13 }, texts: ["BAÑO", "VESTIDOR"], confidence: 0.9, tiles: ["m#2"], passes: ["mosaicos"] },
  ]);
  assert.equal(merged.length, 2);
});

test("la página entera y los mosaicos se unen con tolerancia de 25 pt y se registran ambas pasadas", () => {
  const merged = mergeCandidates(
    [
      { box: { x: 270, y: 300, w: 56, h: 13 }, texts: ["BAÑO", "VESTIDOR"], confidence: 0.9, tiles: ["m#0"], passes: ["mosaicos"] },
      // Caja corrida 18 pt hacia abajo y sin pisarse: igual es el mismo choque.
      { box: { x: 268, y: 318, w: 60, h: 14 }, texts: ["BAÑO"], confidence: 0.6, tiles: ["p#0"], passes: ["pagina"] },
      // A 60 pt: es otro choque.
      { box: { x: 270, y: 360, w: 56, h: 13 }, texts: ["X", "Y"], confidence: 0.6, tiles: ["p#0"], passes: ["pagina"] },
    ],
    25,
  );
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0].passes.sort(), ["mosaicos", "pagina"]);
  // Se conserva la caja de la pasada más confiable, sin estirarla con la otra.
  assert.equal(merged[0].box.y, 300);
});

test("la respuesta del modelo se interpreta con tolerancia (0–1000, cajas invertidas, basura)", () => {
  const boxes = parseBoxes('```json\n{"overlaps":[{"box":[500,100,400,150],"texts":["A","B"],"confidence":0.9},{"box":[1,2]}]}\n```');
  assert.equal(boxes.length, 1);
  assert.deepEqual([boxes[0].x, boxes[0].y].map((n) => +n.toFixed(2)), [0.4, 0.1]);
});

test("si el proveedor falla, la página queda 'no verificada' y no se omite", async () => {
  const doc = await loadPdf(new Uint8Array(await readFile("samples/planos-prueba.pdf")));
  const failing: VisionProvider = {
    name: "falla",
    model: "test",
    async detectOverlaps() {
      throw new VisionError("401 clave inválida", false);
    },
  };
  const r = await analyzeImagePage(6, await doc.getPage(6), failing, { retries: 0, passes: [TILES_PASS] });
  assert.equal(r.tiles, 4);
  assert.equal(r.status, "no_verificada");
  assert.equal(r.page, 6);
  assert.match(r.error ?? "", /No se pudo analizar/);
});

test("el ajuste a tinta lleva una caja corrida y alta al renglón real del choque", async () => {
  const { extractLargestImage } = await import("../lib/detector/pdf");
  const { snapToInk, toGray } = await import("../lib/detector/ink");
  const doc = await loadPdf(new Uint8Array(await readFile("samples/planos-prueba.pdf")));
  const img = (await extractLargestImage(await doc.getPage(6)))!;
  const S = img.width / img.placement.w;
  const gray = toGray(img.data, img.width, img.height, img.channels);
  // Caja típica del modelo para BAÑO × VESTIDOR: 10 pt más abajo y 2,5 veces más alta.
  const model = { x: 270 * S, y: 300 * S, w: 60 * S, h: 20 * S };
  const s = snapToInk(gray, model)!;
  const gt = { x: 273.3, y: 304.0, w: 48.9, h: 7.8 };
  assert.ok(Math.abs(s.y / S - gt.y) < 1.5, `y ${s.y / S}`);
  assert.ok(Math.abs(s.x / S - gt.x) < 1.5, `x ${s.x / S}`);
  assert.ok(Math.abs(s.w / S - gt.w) < 3, `w ${s.w / S}`);
});

test("Gemini: box_2d [ymin,xmin,ymax,xmax] 0–1000 se convierte a [x0,y0,x1,y1] 0–1 y se lee de los pasos", async () => {
  const { extractText, toOurFormat } = await import("../lib/vision/gemini");
  const { parseBoxes } = await import("../lib/vision/provider");
  const json = {
    steps: [
      { type: "thought", content: [{ type: "thought", text: "pensando {" }] },
      { type: "model_output", content: [{ type: "text", text: '{"overlaps":[{"box_2d":[100,200,150,600],"texts":["A","B"],"confidence":0.9}]}' }] },
    ],
  };
  const [b] = parseBoxes(toOurFormat(extractText(json)));
  assert.deepEqual([b.x, b.y, +b.w.toFixed(3), +b.h.toFixed(3)], [0.2, 0.1, 0.4, 0.05]);
});
