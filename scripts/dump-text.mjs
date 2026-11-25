// Vuelca los textos de cada página con su transform y tamaño (pdfjs), y lista pares cercanos.
import { readFile } from "node:fs/promises";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
const data = new Uint8Array(await readFile(process.argv[2]));
const only = process.argv[3] ? Number(process.argv[3]) : null;
const doc = await pdfjs.getDocument({ data, verbosity: 0 }).promise;
for (let p = 1; p <= doc.numPages; p++) {
  if (only && p !== only) continue;
  const page = await doc.getPage(p);
  const H = page.view[3];
  const tc = await page.getTextContent();
  const items = tc.items.filter(i => i.str && i.str.trim());
  const boxes = items.map(it => {
    const [a, b, c, d, e, f] = it.transform;
    const fs = Math.hypot(c, d);
    const ux = a / Math.hypot(a, b), uy = b / Math.hypot(a, b);
    const vx = -uy, vy = ux; // perpendicular "arriba"
    const L = it.width, asc = 0.75 * fs, desc = 0.21 * fs;
    const pts = [[0, -desc], [L, -desc], [L, asc], [0, asc]].map(([s, t]) => [e + ux * s + vx * t, H - (f + uy * s + vy * t)]);
    const xs = pts.map(q => q[0]), ys = pts.map(q => q[1]);
    return { s: it.str, rot: Math.round(Math.atan2(b, a) * 180 / Math.PI), fs: +fs.toFixed(1), x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  });
  console.log(`\n== p${p} items=${boxes.length}`);
  if (process.argv[4] === "all") boxes.forEach(b => console.log(`  ${JSON.stringify(b.s)} rot=${b.rot} fs=${b.fs} [${b.x0.toFixed(1)},${b.y0.toFixed(1)},${b.x1.toFixed(1)},${b.y1.toFixed(1)}]`));
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const A = boxes[i], B = boxes[j];
    const ix = Math.min(A.x1, B.x1) - Math.max(A.x0, B.x0), iy = Math.min(A.y1, B.y1) - Math.max(A.y0, B.y0);
    const gap = Math.max(-ix, -iy);
    if (gap > 2) continue;
    const inter = Math.max(0, ix) * Math.max(0, iy);
    const amin = Math.min((A.x1 - A.x0) * (A.y1 - A.y0), (B.x1 - B.x0) * (B.y1 - B.y0));
    console.log(`  ${(inter / amin).toFixed(3)} gap=${gap.toFixed(2)} ${JSON.stringify(A.s)} × ${JSON.stringify(B.s)} @${Math.round(Math.max(A.x0, B.x0))},${Math.round(Math.max(A.y0, B.y0))}`);
  }
}
