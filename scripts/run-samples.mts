// Corre el detector completo (vectorial + visión) sobre todos los PDFs de samples/ y guarda
// resultados, uso y tiempos por página. Puntúa contra samples/expected.json y samples/esperados.json.
//   npx tsx scripts/run-samples.mts [etiqueta] [--solo-vector]
// SOLO=7,8,9 corre solo los PDFs cuyo nombre empieza así. CRUDAS=1 guarda la respuesta cruda de la
// IA y el JPEG de cada llamada en bench/crudas-<etiqueta>/ (diagnóstico; no cambia el resultado).
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { analyzeVector, inspectPage } from "../lib/detector/analyze";
import { analyzeImagePage, type ImagePageResult } from "../lib/detector/image";
import { loadPdf } from "../lib/detector/pdf";
import type { PageResult } from "../lib/detector/types";
import { DeepSeekProvider } from "../lib/vision/deepseek";
import type { VisionImage, VisionProvider } from "../lib/vision/provider";
import { estimateCostUsd } from "../lib/vision/pricing";

process.loadEnvFile(".env.local");
const tag = process.argv[2] ?? "corrida";
const onlyVector = process.argv.includes("--solo-vector");
// Variantes para medir: ESFUERZO=none|low|high, MAX_TOKENS=n, CONCURRENCIA=n, SALTEAR=1.
const deepseek = new DeepSeekProvider(process.env.DEEPSEEK_API_KEY!, "deepseek-flash", undefined, undefined, {
  reasoningEffort: process.env.ESFUERZO as "none" | "low" | "high" | undefined,
  maxTokens: process.env.MAX_TOKENS ? Number(process.env.MAX_TOKENS) : 8192,
});
const rawDir = `bench/crudas-${tag}`;
const rawLog: { file: string; page: number; call: number; width: number; height: number; jpeg: string; raw: string }[] = [];
let current = { file: "", page: 0 };
let calls = 0;
// Envoltorio de diagnóstico: misma llamada, pero anota la respuesta cruda y guarda el JPEG enviado.
const provider: VisionProvider = process.env.CRUDAS
  ? {
      name: deepseek.name,
      model: deepseek.model,
      async detectOverlaps(image: VisionImage, prompt?: string) {
        const call = ++calls;
        const r = await deepseek.detectOverlaps(image, prompt);
        const jpeg = `${current.file.replace(/\.pdf$/, "")}-p${current.page}-${call}.jpg`;
        await mkdir(rawDir, { recursive: true });
        await writeFile(`${rawDir}/${jpeg}`, image.data);
        rawLog.push({ ...current, call, width: image.width, height: image.height, jpeg, raw: r.raw });
        return r;
      },
    }
  : deepseek;
const only = process.env.SOLO?.split(",").filter(Boolean);
const imageOpts = {
  ...(process.env.CONCURRENCIA ? { concurrency: Number(process.env.CONCURRENCIA) } : {}),
  ...(process.env.SALTEAR ? { skipBlankTiles: process.env.SALTEAR === "1" } : {}),
};

export const FILES = [
  "planos-prueba.pdf",
  "1-vectorial-A3-y-A4.pdf",
  "2-escaneado-solo-imagen.pdf",
  "3-mixto-vector-escaneado-limpio.pdf",
  // Con /Rotate y caja de página corrida (scripts/make-rotated-samples.mts).
  "4-vectorial-rotado.pdf",
  "5-cad-rotado.pdf",
  "6-escaneado-rotado.pdf",
  // Plano real de baja resolución (~102 ppi) y el mismo ampliado al doble.
  "7-plano-real-limpio-control.pdf",
  "8-plano-real-con-errores.pdf",
  "9-plano-real-con-errores-x2-resolucion.pdf",
];

type Out = { file: string; pages: (PageResult & Partial<ImagePageResult> & { costUsd?: { peak: number; offPeak: number } | null })[] };
const out: Out[] = [];

for (const file of FILES) {
  if (!existsSync(`samples/${file}`)) continue;
  if (only && !only.some((p) => file.startsWith(p))) continue;
  const doc = await loadPdf(new Uint8Array(await readFile(`samples/${file}`)));
  const pages: Out["pages"] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const started = Date.now();
    const info = await inspectPage(page);
    if (info.kind === "vector") {
      pages.push({ ...analyzeVector(n, info), status: "ok", ms: Date.now() - started });
    } else if (info.kind === "image" && !onlyVector) {
      current = { file, page: n };
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
if (rawLog.length) {
  await writeFile(`${rawDir}/crudas.json`, JSON.stringify(rawLog, null, 2));
  console.log(`respuestas crudas en ${rawDir}/crudas.json\n`);
}

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
