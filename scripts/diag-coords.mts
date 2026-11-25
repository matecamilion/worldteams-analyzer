// Diagnóstico de coordenadas de visión en la página 6.
//   npx tsx scripts/diag-coords.mts [corridas]
// Para cada mosaico registra la caja cruda del modelo y la compara con la verdad medida en
// píxeles de tinta. Compara mosaicos nativos (no cuadrados) contra mosaicos rellenados a cuadrado
// con blanco, para ver si el reescalado interno de DeepSeek deforma las coordenadas.
import { readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { loadPdf, extractLargestImage } from "../lib/detector/pdf";
import { planTiles } from "../lib/detector/tiles";
import { DeepSeekProvider } from "../lib/vision/deepseek";

process.loadEnvFile(".env.local");
const provider = new DeepSeekProvider(process.env.DEEPSEEK_API_KEY!);
const runs = Number(process.argv[2] ?? 3);

// Verdad en pt (tinta medida en la imagen), centro y caja.
const GT: Record<string, [number, number, number, number]> = {
  banio: [273.3, 304.0, 48.9, 7.8],
  estar: [186.0, 561.0, 69.6, 7.2],
  cocina: [347.9, 588.6, 51.4, 8.6],
};

const doc = await loadPdf(new Uint8Array(await readFile("samples/planos-prueba.pdf")));
const img = (await extractLargestImage(await doc.getPage(6)))!;
const S = img.width / img.placement.w;
const src = sharp(Buffer.from(img.data), { raw: { width: img.width, height: img.height, channels: img.channels } });
const tiles = planTiles(img.width, img.height, 1400, 250);

type Row = { variant: string; run: number; tile: number; k: string; gtNx: number; gtNy: number; errNx: number; errNy: number; dxPt: number; dyPt: number; hRatio: number };
const rows: Row[] = [];

for (const variant of ["nativo", "cuadrado"]) {
  for (let run = 1; run <= runs; run++) {
    await Promise.all(
      tiles.map(async (t) => {
        let buf = src.clone().extract({ left: t.x, top: t.y, width: t.w, height: t.h });
        const side = Math.max(t.w, t.h);
        if (variant === "cuadrado") buf = buf.extend({ right: side - t.w, bottom: side - t.h, background: "#ffffff" });
        const data = await buf.jpeg({ quality: 88 }).toBuffer();
        const fw = variant === "cuadrado" ? side : t.w;
        const fh = variant === "cuadrado" ? side : t.h;
        const r = await provider.detectOverlaps({ data, mime: "image/jpeg", width: fw, height: fh });
        for (const b of r.boxes) {
          // Centro predicho en px de imagen.
          const pcx = t.x + (b.x + b.w / 2) * fw;
          const pcy = t.y + (b.y + b.h / 2) * fh;
          let best: Row | null = null;
          for (const [k, g] of Object.entries(GT)) {
            const gcx = (g[0] + g[2] / 2) * S;
            const gcy = (g[1] - img.placement.y + g[3] / 2) * S;
            const inside = gcx > t.x && gcx < t.x + t.w && gcy > t.y && gcy < t.y + t.h;
            const d = Math.hypot(pcx - gcx, pcy - gcy) / S;
            if (!inside || d > 45) continue;
            const row: Row = {
              variant, run, tile: t.index, k,
              gtNx: (gcx - t.x) / fw, gtNy: (gcy - t.y) / fh,
              errNx: (pcx - gcx) / fw, errNy: (pcy - gcy) / fh,
              dxPt: (pcx - gcx) / S, dyPt: (pcy - gcy) / S,
              hRatio: (b.h * fh) / S / g[3],
            };
            if (!best || Math.hypot(row.dxPt, row.dyPt) < Math.hypot(best.dxPt, best.dyPt)) best = row;
          }
          if (best) rows.push(best);
        }
      }),
    );
  }
}

await writeFile("bench/diag-coords.json", JSON.stringify(rows, null, 2));
const stat = (a: number[]) => {
  const m = a.reduce((s, v) => s + v, 0) / a.length;
  return { m, sd: Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length) };
};
// Pendiente del error vs. posición dentro del mosaico: ≠0 indicaría un reescalado.
const slope = (xs: number[], ys: number[]) => {
  const mx = stat(xs).m, my = stat(ys).m;
  const num = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0);
  const den = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
  return den ? num / den : NaN;
};
for (const variant of ["nativo", "cuadrado"]) {
  const r = rows.filter((x) => x.variant === variant);
  const dx = stat(r.map((x) => x.dxPt)), dy = stat(r.map((x) => x.dyPt)), h = stat(r.map((x) => x.hRatio));
  console.log(
    `${variant}: n=${r.length} · dx ${dx.m.toFixed(1)}±${dx.sd.toFixed(1)} pt · dy ${dy.m.toFixed(1)}±${dy.sd.toFixed(1)} pt` +
      ` · pendiente errY/posY ${slope(r.map((x) => x.gtNy), r.map((x) => x.errNy)).toFixed(3)}` +
      ` · pendiente errX/posX ${slope(r.map((x) => x.gtNx), r.map((x) => x.errNx)).toFixed(3)} · alto× ${h.m.toFixed(1)}`,
  );
  for (const k of Object.keys(GT)) {
    const q = r.filter((x) => x.k === k);
    if (!q.length) continue;
    console.log(`   ${k}: n=${q.length} dy ${q.map((x) => x.dyPt.toFixed(0)).join(",")} (mosaicos ${[...new Set(q.map((x) => x.tile))].join(",")})`);
  }
}
