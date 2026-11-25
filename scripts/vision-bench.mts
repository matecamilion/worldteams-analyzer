// Banco de pruebas de visión sobre las páginas imagen del PDF de ejemplo.
//   npx tsx scripts/vision-bench.mts <tileSize> <overlap> [repeticiones]
// Mide contra samples/expected.json. Costo: tokens reportados por la API × precio publicado
// (el saldo de DeepSeek se informa con 2 decimales y no alcanza para medir una página).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { loadPdf } from "../lib/detector/pdf";
import { inspectPage } from "../lib/detector/analyze";
import { analyzeImagePage } from "../lib/detector/image";
import { scorePage, type ExpectedPage } from "../lib/detector/evaluate";
import { DeepSeekProvider } from "../lib/vision/deepseek";
import { estimateCostUsd } from "../lib/vision/pricing";

process.loadEnvFile(".env.local");
const key = process.env.DEEPSEEK_API_KEY;
if (!key) throw new Error("Falta DEEPSEEK_API_KEY en .env.local");

const tileSize = Number(process.argv[2] ?? 1400);
const overlap = Number(process.argv[3] ?? 250);
const reps = Number(process.argv[4] ?? 1);

async function balance(): Promise<number> {
  const r = await fetch("https://api.deepseek.com/user/balance", { headers: { Authorization: `Bearer ${key}` } });
  const j = (await r.json()) as { balance_infos: { total_balance: string }[] };
  return Number(j.balance_infos[0].total_balance);
}

const expected = JSON.parse(await readFile("samples/expected.json", "utf8")) as { file: string; pages: ExpectedPage[] };
const doc = await loadPdf(new Uint8Array(await readFile(`samples/${expected.file}`)));
const provider = new DeepSeekProvider(key);
await mkdir("bench", { recursive: true });

for (let rep = 1; rep <= reps; rep++) {
  for (const exp of expected.pages.filter((p) => p.kind === "image")) {
    const page = await doc.getPage(exp.page);
    const info = await inspectPage(page);
    if (info.kind !== "image") continue;
    const before = await balance();
    const result = await analyzeImagePage(exp.page, page, provider, { tileSize, overlap });
    // El saldo se actualiza con algo de demora; esperamos un poco antes de leerlo.
    await new Promise((r) => setTimeout(r, 4000));
    const after = await balance();
    const s = scorePage(exp, result.findings);
    const cost = estimateCostUsd(`${provider.name}:${provider.model}`, result.usage);
    console.log(
      `p${exp.page} tile=${tileSize}/${overlap} rep${rep}: ${result.tiles} mosaicos, ${result.status}` +
        ` · aciertos ${s.truePositives.length}/${s.expected} · de más ${s.falsePositives.length}` +
        (s.trapsHit.length ? ` (trampas: ${s.trapsHit.join(", ")})` : "") +
        (s.falseNegatives.length ? ` · faltan ${s.falseNegatives.join(", ")}` : "") +
        ` · tokens ${result.usage.inputTokens}+${result.usage.outputTokens}` +
        ` · costo est. USD ${cost?.offPeak.toFixed(4)}–${cost?.peak.toFixed(4)} · ${(result.ms / 1000).toFixed(1)}s`,
    );
    for (const f of result.findings) {
      console.log(`    ${f.confidence} [${f.texts.join(" × ")}] box=${[f.box.x, f.box.y, f.box.w, f.box.h].map((v) => v.toFixed(0)).join(",")}`);
    }
    if (result.error) console.log(`    error: ${result.error}`);
    await writeFile(
      `bench/p${exp.page}-deepseek-${tileSize}-${overlap}-rep${rep}.json`,
      JSON.stringify({ tileSize, overlap, score: s, costUsd: cost, balanceDelta: before - after, pages: [result] }, null, 2),
    );
  }
}
