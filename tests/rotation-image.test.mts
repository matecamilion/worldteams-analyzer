import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PDFDocument, degrees } from "pdf-lib";
import { analyzeImagePage } from "../lib/detector/image";
import { extractLargestImage, loadPdf, orientationOf, reorient } from "../lib/detector/pdf";
import type { VisionProvider } from "../lib/vision/provider";

// Páginas escaneadas con /Rotate y con caja de página corrida. La imagen que va a la IA tiene que
// estar derecha como se ve en pantalla, y las cajas, en las coordenadas de la pantalla.

const original = await loadPdf(new Uint8Array(await readFile("samples/2-escaneado-solo-imagen.pdf")));
const rotated = await loadPdf(new Uint8Array(await readFile("samples/6-escaneado-rotado.pdf")));
const base = (await extractLargestImage(await original.getPage(1)))!;

test("reorient: giros de 90° y espejos sobre una imagen de 3×2", () => {
  // Píxeles (1 canal) numerados por posición: fila 0 = [1 2 3], fila 1 = [4 5 6].
  const img = new Uint8Array([1, 2, 3, 4, 5, 6]);
  const r = (o: Parameters<typeof reorient>[4]) => {
    const out = reorient(img, 3, 2, 1, o);
    return [out.width, out.height, [...out.data]];
  };
  assert.deepEqual(r({ swap: false, flipX: false, flipY: false }), [3, 2, [1, 2, 3, 4, 5, 6]]);
  assert.deepEqual(r({ swap: false, flipX: true, flipY: true }), [3, 2, [6, 5, 4, 3, 2, 1]]); // 180°
  // 90° horario: la columna izquierda (de abajo hacia arriba) pasa a ser la fila de arriba.
  assert.deepEqual(r({ swap: true, flipX: true, flipY: false }), [2, 3, [4, 1, 5, 2, 6, 3]]);
  // 90° antihorario.
  assert.deepEqual(r({ swap: true, flipX: false, flipY: true }), [2, 3, [3, 6, 2, 5, 1, 4]]);
  // /Rotate 90 sobre una imagen pintada derecha: matriz píxel → pantalla [0, s, -s, 0, …] → giro horario.
  assert.deepEqual(orientationOf([0, 1, -1, 0, 0, 0]), { swap: true, flipX: true, flipY: false });
});

test("escaneada 'a lo CAD' (90/180/270 y origen corrido): la IA recibe la misma imagen, en el mismo lugar", async () => {
  for (let n = 1; n <= rotated.numPages; n++) {
    const page = await rotated.getPage(n);
    const img = (await extractLargestImage(page))!;
    const where = `p${n} (/Rotate ${page.rotate}, caja ${page.view.map(Math.round)})`;
    assert.deepEqual([img.width, img.height, img.channels], [base.width, base.height, base.channels], where);
    assert.ok(Buffer.from(img.data).equals(Buffer.from(base.data)), `${where}: píxeles distintos`);
    for (const k of ["x", "y", "w", "h"] as const) assert.ok(Math.abs(img.placement[k] - base.placement[k]) < 0.01, `${where}: ${k}`);
  }
});

test("escaneada girada tal cual (/Rotate 90): imagen girada 90° horario que cubre la hoja que se ve", async () => {
  const src = await PDFDocument.load(await readFile("samples/2-escaneado-solo-imagen.pdf"));
  src.getPage(0).setRotation(degrees(90));
  const doc = await loadPdf(await src.save());
  const page = await doc.getPage(1);
  const vp = page.getViewport({ scale: 1 });
  const img = (await extractLargestImage(page))!;
  assert.deepEqual([img.width, img.height], [base.height, base.width]);
  // Cubre la hoja como la cubría sin girar, con ancho y alto cruzados.
  const near = (a: number, b: number) => Math.abs(a - b) < 0.05;
  assert.ok(near(img.placement.w, base.placement.h) && near(img.placement.h, base.placement.w), "tamaño");
  assert.ok(img.placement.x >= -0.05 && img.placement.x + img.placement.w <= vp.width + 0.05, "dentro de la hoja");
  // Píxel (x, y) girado = píxel original (columna y, fila alto−1−x).
  const ch = base.channels;
  for (const [x, y] of [[0, 0], [100, 7], [img.width - 1, img.height - 1], [903, 1500]]) {
    const got = img.data.subarray((y * img.width + x) * ch, (y * img.width + x + 1) * ch);
    const [i, j] = [y, base.height - 1 - x];
    const want = base.data.subarray((j * base.width + i) * ch, (j * base.width + i + 1) * ch);
    assert.deepEqual([...got], [...want], `píxel ${x},${y}`);
  }
});

test("escaneada 'a lo CAD': con la misma respuesta de la IA, mismos hallazgos, cajas y zonas", async () => {
  // Proveedor falso determinista: en cada mosaico marca una franja fija (sólo depende del mosaico).
  const fake: VisionProvider = {
    name: "fijo",
    model: "test",
    async detectOverlaps() {
      return { boxes: [{ x: 0.3, y: 0.4, w: 0.12, h: 0.02, texts: ["A", "B"], confidence: 0.9 }], usage: { inputTokens: 0, outputTokens: 0 }, raw: "" };
    },
  };
  const opts = { concurrency: 2, retries: 0 };
  const want = await analyzeImagePage(1, await original.getPage(1), fake, opts);
  assert.ok(want.findings.length > 0);
  for (let n = 1; n <= rotated.numPages; n++) {
    const got = await analyzeImagePage(n, await rotated.getPage(n), fake, opts);
    assert.deepEqual([got.width, got.height].map(Math.round), [want.width, want.height].map(Math.round));
    assert.deepEqual(
      got.findings.map((f) => [Object.values(f.box).map((v) => v.toFixed(2)), f.zone]),
      want.findings.map((f) => [Object.values(f.box).map((v) => v.toFixed(2)), f.zone]),
      `p${n}`,
    );
  }
});
