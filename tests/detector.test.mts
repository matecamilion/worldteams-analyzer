import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTextBoxes, type RawTextItem } from "../lib/detector/vector";
import { detectVectorOverlaps } from "../lib/detector/overlap";
import { DEFAULT_OPTIONS } from "../lib/detector/types";

const H = 842;
const page = { number: 1, width: 1190, height: H };
// Item horizontal: transform [fs,0,0,fs,x,y] en espacio PDF (y hacia arriba).
const h = (str: string, x: number, y: number, fs = 8, width = str.length * fs * 0.55): RawTextItem => ({
  str,
  transform: [fs, 0, 0, fs, x, y],
  width,
});
// Item rotado 90° (se lee de abajo hacia arriba), como las cotas verticales.
const v = (str: string, x: number, y: number, fs = 6.5, width = str.length * fs * 0.55): RawTextItem => ({
  str,
  transform: [0, fs, -fs, 0, x, y],
  width,
});

const run = (items: RawTextItem[]) =>
  detectVectorOverlaps(buildTextBoxes(items, H, DEFAULT_OPTIONS), page, DEFAULT_OPTIONS);

test("dos textos horizontales que se pisan son un choque", () => {
  const f = run([h("HALL DE ACCESO", 100, 300), h("VER DETALLE D-4", 110, 298)]);
  assert.equal(f.filter((x) => x.severity === "choque").length, 1);
});

test("renglones apilados de un mismo rótulo no chocan", () => {
  const f = run([h("COCHERA", 100, 300, 8), h("36.00 m²", 104, 290, 6.5), h("NPT +0.00", 102, 281, 6)]);
  assert.equal(f.filter((x) => x.severity === "choque").length, 0);
});

test("texto separado 2 pt se informa como cercanía, no como choque", () => {
  const a = h("ASCENSOR", 100, 300, 8, 45);
  const f = run([a, h("1,10x1,30", 147, 300, 6, 30)]);
  assert.equal(f.filter((x) => x.severity === "choque").length, 0);
  assert.equal(f.filter((x) => x.severity === "cercania").length, 1);
});

test("cota vertical que cruza un texto horizontal es un choque", () => {
  const f = run([h("DORMITORIO", 100, 300, 8, 50), v("4.00", 120, 290)]);
  assert.equal(f.filter((x) => x.severity === "choque").length, 1);
});

test("cota vertical al lado de un texto no choca", () => {
  const f = run([h("DORMITORIO", 100, 300, 8, 50), v("4.00", 60, 290)]);
  assert.equal(f.length, 0);
});

test("un texto partido en tramos por pdfjs no choca consigo mismo", () => {
  // "ESTAR-" y "COMEDOR" contiguos en la misma línea base, con leve kerning negativo.
  const f = run([h("ESTAR-", 100, 300, 8, 28), h("COMEDOR", 127.5, 300, 8, 38)]);
  assert.equal(f.length, 0);
});

test("el mismo texto dos veces en el mismo lugar es duplicado, no choque", () => {
  const f = run([h("PLANTA BAJA", 100, 300), h("PLANTA BAJA", 100.2, 300)]);
  assert.deepEqual(
    f.map((x) => x.severity),
    ["duplicado"],
  );
});

test("rótulos con el mismo texto en lugares distintos no se confunden", () => {
  const f = run([h("BAÑO", 100, 300), h("VESTIDOR", 110, 300.5), h("BAÑO", 100, 150)]);
  const clashes = f.filter((x) => x.severity === "choque");
  assert.equal(clashes.length, 1);
  assert.ok(clashes[0].box.y < H - 290);
});

test("tres textos encimados forman una sola zona", () => {
  const f = run([h("SALIDA A TERRAZA", 100, 300), h("TANQUE 1000 L", 120, 301), h("NOTA", 160, 299)]);
  const clashes = f.filter((x) => x.severity === "choque");
  assert.equal(clashes.length, 1);
  assert.equal(clashes[0].texts.length, 3);
});

test("el umbral es configurable", () => {
  const items = [h("AAAAAAAAAA", 100, 300, 8, 50), h("B", 148, 300.5, 8, 5)];
  const boxes = buildTextBoxes(items, H, DEFAULT_OPTIONS);
  const strict = detectVectorOverlaps(boxes, page, { ...DEFAULT_OPTIONS, minOverlapRatio: 0.9 });
  const loose = detectVectorOverlaps(boxes, page, { ...DEFAULT_OPTIONS, minOverlapRatio: 0.1 });
  assert.equal(strict.filter((x) => x.severity === "choque").length, 0);
  assert.equal(loose.filter((x) => x.severity === "choque").length, 1);
});
