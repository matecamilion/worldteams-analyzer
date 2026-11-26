// Manda UN mosaico a la IA con un plazo largo y mide cuánto tarda (diagnóstico de cortes por tiempo).
//   npx tsx scripts/probe-tile.mts archivo.pdf página pasada índice [plazo_ms]
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { loadPdf, extractLargestImage } from "../lib/detector/pdf";
import { DEFAULT_IMAGE_OPTIONS } from "../lib/detector/image";
import { planTiles } from "../lib/detector/tiles";
import { DeepSeekProvider } from "../lib/vision/deepseek";
import { estimateCostUsd } from "../lib/vision/pricing";

process.loadEnvFile(".env.local");
const [file, pageArg, passName, idx, timeout = "100000"] = process.argv.slice(2);
const doc = await loadPdf(new Uint8Array(await readFile(file)));
const img = (await extractLargestImage(await doc.getPage(Number(pageArg))))!;
const pass = DEFAULT_IMAGE_OPTIONS.passes.find((p) => p.name === passName)!;
const tile = planTiles(img.width, img.height, pass.tileSize, pass.overlap, pass.extraPerAxis)[Number(idx)];
const data = await sharp(Buffer.from(img.data), { raw: { width: img.width, height: img.height, channels: img.channels } })
  .extract({ left: tile.x, top: tile.y, width: tile.w, height: tile.h }).jpeg({ quality: 88 }).toBuffer();
const provider = new DeepSeekProvider(process.env.DEEPSEEK_API_KEY!, "deepseek-flash", undefined, Number(timeout), { maxTokens: 8192 });
const t0 = Date.now();
try {
  const r = await provider.detectOverlaps({ data, mime: "image/jpeg", width: tile.w, height: tile.h });
  console.log(`mosaico ${passName}#${idx} ${tile.w}x${tile.h}: ${((Date.now() - t0) / 1000).toFixed(1)} s, ${JSON.stringify(r.usage)}, USD ${estimateCostUsd("deepseek:deepseek-flash", r.usage)?.peak.toFixed(4)}`);
  console.log(r.raw);
} catch (e) {
  console.log(`falló a los ${((Date.now() - t0) / 1000).toFixed(1)} s: ${e}`);
}
