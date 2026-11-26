// Arma samples/7-plano-real-limpio-control.pdf: el plano real limpio (JPEG 736x1195) en una hoja
// A4, en el mismo lugar que en 8-plano-real-con-errores.pdf (solo imagen, sin texto).
//   npx tsx scripts/make-plano-real-control.mts ruta/al/plano-limpio.jpg
import { readFile, writeFile } from "node:fs/promises";
import { PDFDocument } from "pdf-lib";

const jpg = await readFile(process.argv[2]);
const doc = await PDFDocument.create();
const page = doc.addPage([595.28, 841.89]);
const img = await doc.embedJpg(jpg);
page.drawImage(img, { x: 38.38015, y: 0, width: 518.5197, height: 841.89 });
await writeFile("samples/7-plano-real-limpio-control.pdf", await doc.save());
console.log(`imagen ${img.width}x${img.height}`);
