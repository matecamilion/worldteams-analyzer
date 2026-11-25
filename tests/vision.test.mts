import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { planTiles, touchesInnerEdge } from "../lib/detector/tiles";
import { analyzeImagePage, mergeCandidates } from "../lib/detector/image";
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
    { box: { x: 270, y: 300, w: 56, h: 13 }, texts: ["BAÑO", "VESTIDOR"], confidence: 0.9, tiles: [0] },
    { box: { x: 272, y: 301, w: 55, h: 12 }, texts: ["BAÑO", "VESTIDOR"], confidence: 0.8, tiles: [1] },
    { box: { x: 270, y: 450, w: 56, h: 13 }, texts: ["BAÑO", "VESTIDOR"], confidence: 0.9, tiles: [2] },
  ]);
  assert.equal(merged.length, 2);
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
  const r = await analyzeImagePage(6, await doc.getPage(6), failing, { retries: 0 });
  assert.equal(r.status, "no_verificada");
  assert.equal(r.page, 6);
  assert.match(r.error ?? "", /No se pudo analizar/);
});
