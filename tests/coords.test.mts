import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { analyzeImagePage } from "../lib/detector/image";
import { loadPdf } from "../lib/detector/pdf";
import { planTiles } from "../lib/detector/tiles";
import type { VisionProvider } from "../lib/vision/provider";

// Verdad medida en píxeles de tinta (pt de página): BAÑO × VESTIDOR.
const GT = { x: 273.3, y: 304.0, w: 48.9, h: 7.8 };

test("la conversión mosaico → página es exacta (sin sesgo propio)", async () => {
  const doc = await loadPdf(new Uint8Array(await readFile("samples/planos-prueba.pdf")));
  const page = await doc.getPage(6);
  const S = 2481 / 1190.5511; // px de imagen por pt (la imagen cubre la página)
  const tiles = planTiles(2481, 1754, 1400, 250);
  // Proveedor falso: devuelve la caja verdadera expresada en coordenadas normalizadas del mosaico recibido.
  let call = 0;
  const exact: VisionProvider = {
    name: "exacto",
    model: "test",
    async detectOverlaps(img) {
      const t = tiles.find((tt) => tt.w === img.width && tt.h === img.height && tt.index === call)!;
      call++;
      const px = { x: GT.x * S - t.x, y: (GT.y - 0.0967) * S - t.y, w: GT.w * S, h: GT.h * S };
      const inside = px.x > 10 && px.y > 10 && px.x + px.w < t.w - 10 && px.y + px.h < t.h - 10;
      return {
        boxes: inside ? [{ x: px.x / t.w, y: px.y / t.h, w: px.w / t.w, h: px.h / t.h, texts: ["BAÑO", "VESTIDOR"], confidence: 0.9 }] : [],
        usage: { inputTokens: 0, outputTokens: 0 },
        raw: "",
      };
    },
  };
  const r = await analyzeImagePage(6, page, exact, { concurrency: 1, refine: false, inkSnap: false });
  assert.equal(r.findings.length, 1);
  const b = r.findings[0].box;
  for (const [got, want] of [[b.x, GT.x], [b.y, GT.y], [b.w, GT.w], [b.h, GT.h]]) assert.ok(Math.abs(got - want) < 0.2, `${got} vs ${want}`);
});
