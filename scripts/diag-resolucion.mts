// Diagnóstico sin IA de una página escaneada: tamaño de la imagen, resolución efectiva,
// mosaicos que se mandarían por pasada y alto de las letras (manchas de tinta).
//   npx tsx scripts/diag-resolucion.mts archivo.pdf [página] [png-salida]
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { loadPdf, extractLargestImage } from "../lib/detector/pdf";
import { DEFAULT_IMAGE_OPTIONS, upscaleFactor } from "../lib/detector/image";
import { planTiles } from "../lib/detector/tiles";
import { countTextBlobs, toGray, type Gray } from "../lib/detector/ink";

const [file, pageArg, pngOut] = process.argv.slice(2);
const doc = await loadPdf(new Uint8Array(await readFile(file)));
const page = await doc.getPage(Number(pageArg ?? 1));
const vp = page.getViewport({ scale: 1 });
const img = (await extractLargestImage(page))!;
const ppi = (img.width / img.placement.w) * 72;
console.log(`${file}: hoja ${vp.width.toFixed(0)}x${vp.height.toFixed(0)} pt, imagen ${img.width}x${img.height} px, ${ppi.toFixed(0)} ppi efectivos (${(img.width / img.placement.w).toFixed(2)} px/pt), ubicada en ${JSON.stringify(img.placement)}, /Rotate ${page.rotate}`);
const factor = upscaleFactor(Math.min(img.width / img.placement.w, img.height / img.placement.h) * 72, img.width, img.height, DEFAULT_IMAGE_OPTIONS);
if (factor > 1) {
  const W = Math.round(img.width * factor), H = Math.round(img.height * factor);
  console.log(`  baja resolución: se amplía ×${factor} → ${W}x${H} px`);
  for (const pass of DEFAULT_IMAGE_OPTIONS.passes) {
    const tiles = planTiles(W, H, pass.tileSize, pass.overlap, pass.extraPerAxis);
    console.log(`    pasada ${pass.name} ampliada: ${tiles.length} mosaicos de ${tiles[0].w}x${tiles[0].h} px (≈${Math.round(tiles[0].w / factor)}x${Math.round(tiles[0].h / factor)} px de la original)`);
  }
} else console.log("  resolución suficiente: no se amplía");
const gray = toGray(img.data, img.width, img.height, img.channels);
for (const pass of DEFAULT_IMAGE_OPTIONS.passes) {
  const tiles = planTiles(img.width, img.height, pass.tileSize, pass.overlap, pass.extraPerAxis);
  console.log(`  pasada ${pass.name}: ${tiles.length} mosaicos: ` + tiles.map((t) => `${t.w}x${t.h}(manchas ${countTextBlobs(gray, t)})`).join(" "));
}
// Manchas de tinta (componentes conexos) de cualquier tamaño: histograma de altos.
function blobs(g: Gray, thr = 110) {
  const { width: w, height: h } = g;
  const seen = new Uint8Array(w * h);
  const out: { x: number; y: number; w: number; h: number; area: number }[] = [];
  const st: number[] = [];
  for (let k0 = 0; k0 < w * h; k0++) {
    if (seen[k0] || g.data[k0] >= thr) continue;
    let x0 = k0 % w, x1 = x0, y0 = (k0 / w) | 0, y1 = y0, area = 0;
    seen[k0] = 1; st.push(k0);
    while (st.length) {
      const c = st.pop()!; const cx = c % w, cy = (c / w) | 0; area++;
      if (cx < x0) x0 = cx; if (cx > x1) x1 = cx; if (cy < y0) y0 = cy; if (cy > y1) y1 = cy;
      for (const n of [c + 1, c - 1, c + w, c - w]) {
        if (n < 0 || n >= w * h || seen[n] || g.data[n] >= thr) continue;
        if ((n === c + 1 && cx === w - 1) || (n === c - 1 && cx === 0)) continue;
        seen[n] = 1; st.push(n);
      }
    }
    out.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, area });
  }
  return out;
}
const all = blobs(gray);
// Letras sueltas: chicas, ni líneas (muy anchas/altas) ni ruido.
const letters = all.filter((b) => b.h >= 3 && b.h <= 40 && b.w <= b.h * 2.5 && b.area >= 4);
const hist = new Map<number, number>();
for (const b of letters) hist.set(b.h, (hist.get(b.h) ?? 0) + 1);
const hs = letters.map((b) => b.h).sort((a, b) => a - b);
const q = (p: number) => hs[Math.floor(p * (hs.length - 1))];
console.log(`  manchas tipo letra: ${letters.length}; alto px p25=${q(0.25)} mediana=${q(0.5)} p75=${q(0.75)} p90=${q(0.9)}`);
console.log(`  histograma alto(px):cantidad ` + [...hist].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}:${v}`).join(" "));
console.log(`  manchas que cuentan como texto (6–60 px) en toda la imagen: ${countTextBlobs(gray, { x: 0, y: 0, w: img.width, h: img.height })}`);
if (pngOut) await sharp(Buffer.from(img.data), { raw: { width: img.width, height: img.height, channels: img.channels } }).png().toFile(pngOut);
