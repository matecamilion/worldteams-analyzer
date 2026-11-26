// Corre el detector completo (vectorial + visión) sobre todos los PDFs de samples/ y guarda
// resultados, uso y tiempos por página. Puntúa contra samples/expected.json y samples/esperados.json.
//   npx tsx scripts/run-samples.mts [etiqueta] [--solo-vector]
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { analyzeVector, inspectPage } from "../lib/detector/analyze";
import { analyzeImagePage, type ImagePageResult } from "../lib/detector/image";
import { loadPdf } from "../lib/detector/pdf";
import type { PageResult } from "../lib/detector/types";
import { DeepSeekProvider } from "../lib/vision/deepseek";
import { estimateCostUsd } from "../lib/vision/pricing";

process.loadEnvFile(".env.local");
const tag = process.argv[2] ?? "corrida";
const onlyVector = process.argv.includes("--solo-vector");
// Variantes para medir: ESFUERZO=none|low|high, MAX_TOKENS=n, CONCURRENCIA=n, SALTEAR=1.
const provider = new DeepSeekProvider(process.env.DEEPSEEK_API_KEY!, "deepseek-flash", undefined, undefined, {
  reasoningEffort: process.env.ESFUERZO as "none" | "low" | "high" | undefined,
  maxTokens: process.env.MAX_TOKENS ? Number(process.env.MAX_TOKENS) : 8192,
});
const imageOpts = {
  ...(process.env.CONCURRENCIA ? { concurrency: Number(process.env.CONCURRENCIA) } : {}),
  ...(process.env.SALTEAR ? { skipBlankTiles: process.env.SALTEAR === "1" } : {}),
};

export const FILES = ["planos-prueba.pdf", "1-vectorial-A3-y-A4.pdf", "2-escaneado-solo-imagen.pdf", "3-mixto-vector-escaneado-limpio.pdf"];

type Out = { file: string; pages: (PageResult & Partial<ImagePageResult> & { costUsd?: { peak: number; offPeak: number } | null })[] };
const out: Out[] = [];

for (const file of FILES) {
  if (!existsSync(`samples/${file}`)) continue;
  const doc = await loadPdf(new Uint8Array(await readFile(`samples/${file}`)));
  const pages: Out["pages"] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const started = Date.now();
    const info = await inspectPage(page);
    if (info.kind === "vector") {
      pages.push({ ...analyzeVector(n, info), status: "ok", ms: Date.now() - started });
    } else if (info.kind === "image" && !onlyVector) {
      const r = await analyzeImagePage(n, page, provider, imageOpts);
      pages.push({ ...r, costUsd: estimateCostUsd(`${provider.name}:${provider.model}`, r.usage) });
    } else {
      pages.push({ page: n, kind: info.kind, width: info.width, height: info.height, textCount: 0, findings: [], status: "no_verificada", ms: 0 });
    }
  }
  out.push({ file, pages });
}

await mkdir("bench", { recursive: true });
const path = `bench/samples-${tag}.json`;
await writeFile(path, JSON.stringify(out, null, 2));
console.log(`guardado en ${path}\n`);

// Consumo de las páginas escaneadas.
console.log("Páginas escaneadas: llamadas por pasada, mosaicos, tokens, tiempo, costo");
for (const f of out) {
  for (const p of f.pages.filter((p) => p.kind === "image" && p.byPass)) {
    const passes = Object.entries(p.byPass!)
      .map(([name, s]) => `${name}: ${s.tiles} mosaicos${s.skipped ? ` (${s.skipped} salteados)` : ""}, ${s.apiCalls} llamadas${s.failed ? `, ${s.failed} fallidas` : ""}, ${s.inputTokens}+${s.outputTokens} tok`)
      .join(" | ");
    const c = p.costUsd;
    console.log(
      `  ${f.file} p${p.page}: ${passes} · total ${p.usage!.inputTokens}+${p.usage!.outputTokens} tok · ${(p.ms / 1000).toFixed(1)} s` +
        ` · USD ${c ? `${c.offPeak.toFixed(4)}–${c.peak.toFixed(4)}` : "?"} · ${p.status}`,
    );
  }
}
