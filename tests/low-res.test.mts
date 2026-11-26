import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { analyzeImagePage, DEFAULT_IMAGE_OPTIONS, TILES_PASS, upscaleFactor } from "../lib/detector/image";
import { loadPdf } from "../lib/detector/pdf";
import { planTiles } from "../lib/detector/tiles";
import { LOW_RES_WARNING } from "../lib/detector/types";
import { cleanTexts, parseBoxes, UNREADABLE_TEXT, type VisionImage, type VisionProvider } from "../lib/vision/provider";

const recorder = () => {
  const seen: VisionImage[] = [];
  const provider: VisionProvider = {
    name: "test",
    model: "test",
    async detectOverlaps(image) {
      seen.push(image);
      return { boxes: [], usage: { inputTokens: 0, outputTokens: 0 }, raw: '{"overlaps":[]}' };
    },
  };
  return { seen, provider };
};

test("la ampliación sólo corre por debajo de 140 ppi, hacia 200 ppi y con topes", () => {
  const o = DEFAULT_IMAGE_OPTIONS;
  assert.equal(upscaleFactor(150, 2481, 1754, o), 1);
  assert.equal(upscaleFactor(170, 2812, 1988, o), 1);
  // Plano real: 736x1195 a 102 ppi → ×1,96 (13 mosaicos entre las dos pasadas).
  assert.equal(upscaleFactor(102, 736, 1195, o), 1.96);
  // Muy baja: tope ×2,5 aunque no alcance los 200 ppi.
  assert.equal(upscaleFactor(50, 400, 600, o), 2.5);
  // Tope de mosaicos: una imagen grande de poca resolución no pasa de 16 mosaicos.
  const f = upscaleFactor(100, 2400, 1700, o);
  assert.ok(f < 2, `factor ${f}`);
  // Si ya tenía más de 16 sin ampliar, ampliar no le suma ningún mosaico.
  const jobs = (w: number, h: number) => o.passes.reduce((n, p) => n + planTiles(w, h, p.tileSize, p.overlap, p.extraPerAxis).length, 0);
  const g = upscaleFactor(100, 5000, 5000, o);
  assert.equal(jobs(Math.round(5000 * g), Math.round(5000 * g)), jobs(5000, 5000));
});

test("una página de buena resolución no se amplía ni avisa", async () => {
  const doc = await loadPdf(new Uint8Array(await readFile("samples/planos-prueba.pdf")));
  const { seen, provider } = recorder();
  const r = await analyzeImagePage(6, await doc.getPage(6), provider, { passes: [TILES_PASS] });
  assert.equal(r.lowResolution, undefined);
  assert.equal(r.tiles, 4);
  assert.ok(seen.every((i) => i.width <= 1400 && i.height <= 1400));
});

test("el plano real de 102 ppi se amplía antes de los mosaicos y avisa", { skip: !existsSync("samples/8-plano-real-con-errores.pdf") }, async () => {
  const doc = await loadPdf(new Uint8Array(await readFile("samples/8-plano-real-con-errores.pdf")));
  const { seen, provider } = recorder();
  const r = await analyzeImagePage(1, await doc.getPage(1), provider);
  assert.deepEqual(r.lowResolution, { ppi: 102, upscale: 1.96 });
  assert.equal(r.tiles, 13);
  // Mosaicos de ~850x1300 (primera pasada) y ~650x950 (corrida), no la página entera de 736x1195.
  assert.ok(seen.some((i) => i.width === 847 && i.height === 1296));
  assert.ok(seen.some((i) => i.width === 648 && i.height === 948));
  assert.ok(r.notes?.[0].startsWith(LOW_RES_WARNING));
});

test("los textos de un hallazgo no traen claves del JSON ni comentarios del modelo", () => {
  assert.deepEqual(cleanTexts(["TEXTO A", "texto ilegible superpuesto", "confidence"]), ["TEXTO A", UNREADABLE_TEXT]);
  assert.deepEqual(cleanTexts(["TEXTO A", "TEXTO ... (segundo texto superpuesto, ilegible)"]), ["TEXTO A", UNREADABLE_TEXT]);
  assert.deepEqual(cleanTexts(["BAÑO", "VESTIDOR (tenue)"]), ["BAÑO", "VESTIDOR"]);
  assert.deepEqual(cleanTexts(["1.25", "1.52", "H=2.10"]), ["1.25", "1.52", "H=2.10"]);
  assert.deepEqual(cleanTexts(["TEXTO C", "???", "", 7, "box"]), ["TEXTO C", UNREADABLE_TEXT]);
  assert.deepEqual(cleanTexts(["un texto más tenue que no alcanzo a leer bien detrás del rótulo"]), [UNREADABLE_TEXT]);
});

test("una lista de textos mal cerrada con la confianza adentro se recupera", () => {
  const [b] = parseBoxes('{"overlaps":[{"box":[0.1,0.1,0.3,0.2],"texts":["TEXTO A","texto ilegible","confidence",0.7]}]}');
  assert.deepEqual(b.texts, ["TEXTO A", UNREADABLE_TEXT]);
  assert.equal(b.confidence, 0.7);
});
