// Repite offline el ajuste a tinta sobre una caja del modelo (pt), a la resolución original y ampliada.
//   npx tsx scripts/diag-snap.mts archivo.pdf x y w h [factor]
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { loadPdf, extractLargestImage } from "../lib/detector/pdf";
import { snapToInk, toGray } from "../lib/detector/ink";

const [file, ...nums] = process.argv.slice(2);
const [x, y, w, h, factor = 1] = nums.map(Number);
const doc = await loadPdf(new Uint8Array(await readFile(file)));
const img = (await extractLargestImage(await doc.getPage(1)))!;
for (const f of [1, factor].filter((v, i, a) => a.indexOf(v) === i)) {
  const W = Math.round(img.width * f), H = Math.round(img.height * f);
  const { data, info } = await sharp(Buffer.from(img.data), { raw: { width: img.width, height: img.height, channels: img.channels } })
    .resize(W, H, { kernel: "lanczos3" }).raw().toBuffer({ resolveWithObject: true });
  const s = img.placement.w / W;
  const gray = toGray(new Uint8Array(data), W, H, info.channels);
  const px = { x: (x - img.placement.x) / s, y: (y - img.placement.y) / s, w: w / s, h: h / s };
  const r = snapToInk(gray, px);
  console.log(`×${f}: caja del modelo ${[x, y, w, h].join(",")} pt → tinta`, r ? [img.placement.x + r.x * s, r.y * s, r.w * s, r.h * s].map((v) => v.toFixed(1)).join(",") + " pt" : "ninguna");
}
