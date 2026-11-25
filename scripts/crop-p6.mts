// Recorte ampliado de la imagen de la página 6 en coordenadas de página (pt), para revisar hallazgos a ojo.
//   npx tsx scripts/crop-p6.mts x y w h salida.png
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { loadPdf, extractLargestImage } from "../lib/detector/pdf";
const [x, y, w, h, out] = process.argv.slice(2);
const doc = await loadPdf(new Uint8Array(await readFile("samples/planos-prueba.pdf")));
const img = (await extractLargestImage(await doc.getPage(6)))!;
const S = img.width / img.placement.w;
await sharp(Buffer.from(img.data), { raw: { width: img.width, height: img.height, channels: img.channels } })
  .extract({ left: Math.round(+x * S), top: Math.round((+y - img.placement.y) * S), width: Math.round(+w * S), height: Math.round(+h * S) })
  .resize({ width: Math.round(+w * S * 2) }).png().toFile(out);
