// Banco de pruebas de visión sobre las páginas imagen del PDF de ejemplo.
//   npx tsx scripts/vision-bench.mts [ambas|mosaicos|pagina|corrida] [repeticiones] [etiqueta] [ajuste-ia]
// Mide contra samples/expected.json. Costo: tokens reportados por la API × precio publicado
// (el saldo de DeepSeek se informa con 2 decimales y no alcanza para medir una página).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { loadPdf } from "../lib/detector/pdf";
import { inspectPage } from "../lib/detector/analyze";
import { analyzeImagePage, SHIFTED_PASS, TILES_PASS, WHOLE_PAGE_PASS } from "../lib/detector/image";
import { scorePage, type ExpectedPage } from "../lib/detector/evaluate";
import { DeepSeekProvider } from "../lib/vision/deepseek";
import { GeminiProvider } from "../lib/vision/gemini";
import { estimateCostUsd } from "../lib/vision/pricing";

process.loadEnvFile(".env.local");
const key = process.env.DEEPSEEK_API_KEY;
if (!key) throw new Error("Falta DEEPSEEK_API_KEY en .env.local");

const mode = process.argv[2] ?? "ambas";
const reps = Number(process.argv[3] ?? 1);
const tag = process.argv[4] ?? new Date().toISOString().slice(0, 16).replace(/[:T]/g, "");
const refine = process.argv[5] === "ajuste-ia";
const passes =
  mode === "mosaicos" ? [TILES_PASS]
  : mode === "pagina" ? [WHOLE_PAGE_PASS]
  : mode === "corrida" ? [TILES_PASS, SHIFTED_PASS]
  : [TILES_PASS, WHOLE_PAGE_PASS];

const expected = JSON.parse(await readFile("samples/expected.json", "utf8")) as { file: string; pages: ExpectedPage[] };
const doc = await loadPdf(new Uint8Array(await readFile(`samples/${expected.file}`)));
// PROVEEDOR=gemini para comparar; por defecto DeepSeek.
const which = process.env.PROVEEDOR ?? "deepseek";
const provider = which === "gemini" ? new GeminiProvider(process.env.GEMINI_API_KEY!, process.env.GEMINI_MODEL) : new DeepSeekProvider(key);
await mkdir("bench", { recursive: true });

for (let rep = 1; rep <= reps; rep++) {
  for (const exp of expected.pages.filter((p) => p.kind === "image")) {
    const page = await doc.getPage(exp.page);
    if ((await inspectPage(page)).kind !== "image") continue;
    const result = await analyzeImagePage(exp.page, page, provider, { passes, refine });
    const s = scorePage(exp, result.findings);
    const cost = estimateCostUsd(`${provider.name}:${provider.model}`, result.usage);
    const fpIds = new Set(s.falsePositives.map((f) => f.id));
    const second = mode === "corrida" ? "corrida" : "pagina";
    const onlyPage = result.findings.filter((f) => f.passes?.length === 1 && f.passes[0] === second);
    console.log(
      `p${exp.page} ${mode} corrida ${rep}: ${result.tiles} llamadas, ${result.status}` +
        ` · aciertos IoU ${s.truePositives.length}/${s.expected} · de más ${s.falsePositives.length}` +
        ` · IoU ${s.matches.map((m) => m.iou.toFixed(2)).join("/") || "-"}` +
        (s.trapsHit.length ? ` (trampas: ${s.trapsHit.join(", ")})` : "") +
        (s.falseNegatives.length ? ` · faltan ${s.falseNegatives.join(", ")}` : "") +
        ` · sólo-${second} ${onlyPage.length} (${onlyPage.filter((f) => fpIds.has(f.id)).length} de más)` +
        ` · tokens ${result.usage.inputTokens}+${result.usage.outputTokens}` +
        ` · USD ${cost?.offPeak.toFixed(4)}–${cost?.peak.toFixed(4)} · ${(result.ms / 1000).toFixed(1)}s`,
    );
    for (const f of result.findings) {
      console.log(
        `    ${fpIds.has(f.id) ? "✗" : "✓"} ${f.confidence} [${f.texts.join(" × ")}] ${f.passes?.join("+")} ${f.refinement ?? ""}${f.inkSnapped ? " tinta" : ""} box=${[f.box.x, f.box.y, f.box.w, f.box.h].map((v) => v.toFixed(0)).join(",")}`,
      );
    }
    if (result.error) console.log(`    error: ${result.error}`);
    await writeFile(
      `bench/p${exp.page}-${which}-${mode}-${tag}-${rep}.json`,
      JSON.stringify({ mode, score: s, costUsd: cost, pages: [result] }, null, 2),
    );
  }
}
