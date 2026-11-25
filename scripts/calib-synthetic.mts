// Calibración sintética de coordenadas: ¿el error de ubicación crece con la posición en el mosaico?
//   npx tsx scripts/calib-synthetic.mts [corridas] [proveedor]
// Genera imágenes del mismo tamaño que los mosaicos reales con 9 choques en posiciones conocidas
// (grilla 3×3), mide la tinta real de cada uno y ajusta predicho = a·real + b por eje.
// a ≈ 1 y b ≈ 0 → sin error de escala; a ≠ 1 → error proporcional a la posición.
import { writeFile } from "node:fs/promises";
import sharp from "sharp";
import { DeepSeekProvider } from "../lib/vision/deepseek";
import type { VisionProvider } from "../lib/vision/provider";

process.loadEnvFile(".env.local");
const runs = Number(process.argv[2] ?? 3);
const which = process.argv[3] ?? "deepseek";
let provider: VisionProvider;
if (which === "gemini") {
  const { GeminiProvider } = await import("../lib/vision/gemini");
  provider = new GeminiProvider(process.env.GEMINI_API_KEY!);
} else provider = new DeepSeekProvider(process.env.DEEPSEEK_API_KEY!);

const PAIRS = [
  ["BAÑO", "VESTIDOR"], ["COCINA", "LAVADERO"], ["ESTAR", "COMEDOR"],
  ["PALIER", "HALL"], ["DEPÓSITO", "BAULERA"], ["SUM", "GIMNASIO"],
  ["PATIO", "TERRAZA"], ["DORMITORIO", "PLACARD"], ["OFICINA", "ARCHIVO"],
];

async function makeImage(W: number, H: number) {
  const fs = 17; // ~8 pt a 150 dpi, como los rótulos del escaneo
  const cells: { x: number; y: number }[] = [];
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#f6f6f4"/>`;
  // Un poco de "plano": paredes y renglones de superficie que no se pisan (distractores).
  for (let i = 1; i < 3; i++) {
    svg += `<line x1="${(W * i) / 3}" y1="0" x2="${(W * i) / 3}" y2="${H}" stroke="#222" stroke-width="5"/>`;
    svg += `<line x1="0" y1="${(H * i) / 3}" x2="${W}" y2="${(H * i) / 3}" stroke="#222" stroke-width="5"/>`;
  }
  PAIRS.forEach(([a, b], i) => {
    const col = i % 3, row = Math.floor(i / 3);
    // Posición dentro de la celda variada a propósito, para cubrir bordes y centro del mosaico.
    const jitterX = [0.2, 0.5, 0.75][(i + row) % 3];
    const jitterY = [0.25, 0.55, 0.8][(i * 2) % 3];
    const x = Math.round((col + jitterX) * (W / 3) - 60);
    const y = Math.round((row + jitterY) * (H / 3));
    cells.push({ x, y });
    svg += `<text x="${x}" y="${y}" font-family="Arial" font-weight="bold" font-size="${fs}" fill="#111">${a}</text>`;
    svg += `<text x="${x + 14}" y="${y + 1}" font-family="Arial" font-weight="bold" font-size="${fs}" fill="#555">${b}</text>`;
    svg += `<text x="${x + 8}" y="${y + 22}" font-family="Arial" font-size="13" fill="#333">12.00 m²</text>`;
    svg += `<text x="${x + 8}" y="${y + 40}" font-family="Arial" font-size="12" fill="#333">NPT +9.00</text>`;
  });
  svg += "</svg>";
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  const { data, info } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true });
  // Caja verdadera: tinta del renglón del choque (desde 22 px arriba de la línea base hasta 5 abajo).
  const truth = cells.map(({ x, y }) => {
    let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
    for (let yy = y - 22; yy <= y + 5; yy++)
      for (let xx = x - 4; xx < x + 260 && xx < W; xx++) {
        if (data[yy * info.width + xx] < 140) {
          x0 = Math.min(x0, xx); x1 = Math.max(x1, xx); y0 = Math.min(y0, yy); y1 = Math.max(y1, yy);
        }
      }
    return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 };
  });
  return { jpeg: await sharp(png).jpeg({ quality: 88 }).toBuffer(), truth };
}

const fit = (xs: number[], ys: number[]) => {
  const n = xs.length, mx = xs.reduce((s, v) => s + v, 0) / n, my = ys.reduce((s, v) => s + v, 0) / n;
  const a = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / xs.reduce((s, x) => s + (x - mx) ** 2, 0);
  const b = my - a * mx;
  const res = Math.sqrt(xs.reduce((s, x, i) => s + (ys[i] - (a * x + b)) ** 2, 0) / n);
  return { a, b, res };
};

const out: unknown[] = [];
for (const [W, H] of [[1366, 1002], [1366, 1366]]) {
  const pts: { tx: number; ty: number; px: number; py: number }[] = [];
  let found = 0;
  for (let r = 0; r < runs; r++) {
    const { jpeg, truth } = await makeImage(W, H);
    let res;
    try {
      res = await provider.detectOverlaps({ data: jpeg, mime: "image/jpeg", width: W, height: H });
    } catch (e) {
      console.log(`  corrida ${r + 1} ${W}×${H}: falló (${(e as Error).message})`);
      continue;
    }
    for (const b of res.boxes) {
      const px = (b.x + b.w / 2) * W, py = (b.y + b.h / 2) * H;
      const t = truth.map((t) => ({ t, d: Math.hypot(t.cx - px, t.cy - py) })).sort((a, b) => a.d - b.d)[0];
      if (t.d > 120) continue;
      found++;
      pts.push({ tx: t.t.cx, ty: t.t.cy, px, py });
    }
  }
  const fx = fit(pts.map((p) => p.tx), pts.map((p) => p.px));
  const fy = fit(pts.map((p) => p.ty), pts.map((p) => p.py));
  const errY = pts.map((p) => p.py - p.ty);
  const meanY = errY.reduce((s, v) => s + v, 0) / errY.length;
  console.log(
    `${provider.name} ${W}×${H}: ${found}/${runs * 9} choques ubicados · ` +
      `x: predicho = ${fx.a.toFixed(4)}·real ${fx.b >= 0 ? "+" : ""}${fx.b.toFixed(1)} (residuo ${fx.res.toFixed(1)} px) · ` +
      `y: predicho = ${fy.a.toFixed(4)}·real ${fy.b >= 0 ? "+" : ""}${fy.b.toFixed(1)} (residuo ${fy.res.toFixed(1)} px) · ` +
      `error y medio ${meanY.toFixed(1)} px`,
  );
  out.push({ W, H, fx, fy, pts });
}
await writeFile(`bench/calib-${which}.json`, JSON.stringify(out, null, 2));
