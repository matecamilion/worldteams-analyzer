// Corre el detector completo (vectorial + visión) sobre todos los PDFs de samples/ y guarda
// resultados, uso y tiempos por página. Puntúa contra samples/expected.json y samples/esperados.json.
//   npx tsx scripts/run-samples.mts [etiqueta] [--solo-vector]
// REALES=1 suma los planos reales de baja resolución. SOLO=7,8,9 corre solo los PDFs cuyo nombre empieza así. CRUDAS=1 guarda la respuesta cruda de la
// IA y el JPEG de cada llamada en bench/crudas-<etiqueta>/ (diagnóstico; no cambia el resultado).
// PAGINAS_EN_PARALELO=n analiza n páginas escaneadas a la vez (por defecto 1, en serie). Es una cola
// única con todas las páginas escaneadas de la corrida, de todos los PDFs: las muestras tienen casi
// siempre una sola por PDF. Las métricas de la corrida (tiempo total y por página, llamadas, 429,
// reintentos, no verificadas) quedan en bench/samples-<etiqueta>.corrida.json.
// SIMULAR=1 usa un proveedor falso (sin IA ni costo) para probar el script; SIMULAR_429=0.2 hace que
// esa fracción de las llamadas responda 429.
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { analyzeVector, inspectPage } from "../lib/detector/analyze";
import { analyzeImagePage, type ImagePageResult } from "../lib/detector/image";
import { loadPdf } from "../lib/detector/pdf";
import type { PageResult } from "../lib/detector/types";
import { DeepSeekProvider } from "../lib/vision/deepseek";
import { VisionError, type CallOptions, type VisionImage, type VisionProvider } from "../lib/vision/provider";
import { estimateCostUsd } from "../lib/vision/pricing";

process.loadEnvFile(".env.local");
const tag = process.argv[2] ?? "corrida";
const onlyVector = process.argv.includes("--solo-vector");
const positiveInt = (name: string, fallback: number) => {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} tiene que ser un entero ≥ 1 (vino "${raw}").`);
  return n;
};
const pagesInParallel = positiveInt("PAGINAS_EN_PARALELO", 1);
// Variantes para medir: ESFUERZO=none|low|high, MAX_TOKENS=n, CONCURRENCIA=n, SALTEAR=1.
const simulated = process.env.SIMULAR === "1";
const sim429 = Number(process.env.SIMULAR_429 ?? 0);
const base: VisionProvider = simulated
  ? {
      name: "simulado",
      model: "sin-ia",
      async detectOverlaps() {
        await new Promise((r) => setTimeout(r, 150 + Math.random() * 350));
        if (Math.random() < sim429) throw new VisionError("Simulado respondió 429: demasiados pedidos", true);
        return { boxes: [], usage: { inputTokens: 0, outputTokens: 0 }, raw: "{}" };
      },
    }
  : new DeepSeekProvider(process.env.DEEPSEEK_API_KEY!, "deepseek-flash", undefined, undefined, {
      reasoningEffort: process.env.ESFUERZO as "none" | "low" | "high" | undefined,
      maxTokens: process.env.MAX_TOKENS ? Number(process.env.MAX_TOKENS) : 8192,
    });
const rawDir = `bench/crudas-${tag}`;
const rawLog: { file: string; page: number; call: number; width: number; height: number; jpeg: string; raw: string }[] = [];
let rawCalls = 0;

/** Contadores de la página que se está analizando; viajan con el contexto asíncrono, así que no se mezclan entre páginas en paralelo. */
type PageCounters = { file: string; page: number; calls: number; errors: number; rateLimited: number; timedOut: number };
const pageContext = new AsyncLocalStorage<PageCounters>();

// Envoltorio de medición: la misma llamada (con sus opciones de plazo), contando llamadas, errores,
// 429 y cortes por tiempo de la página en curso. Con CRUDAS=1 además guarda la respuesta y el JPEG.
const provider: VisionProvider = {
  name: base.name,
  model: base.model,
  async detectOverlaps(image: VisionImage, prompt?: string, call?: CallOptions) {
    const c = pageContext.getStore();
    if (c) c.calls++;
    try {
      const r = await base.detectOverlaps(image, prompt, call);
      if (process.env.CRUDAS && c) {
        const n = ++rawCalls;
        const jpeg = `${c.file.replace(/\.pdf$/, "")}-p${c.page}-${n}.jpg`;
        await mkdir(rawDir, { recursive: true });
        await writeFile(`${rawDir}/${jpeg}`, image.data);
        rawLog.push({ file: c.file, page: c.page, call: n, width: image.width, height: image.height, jpeg, raw: r.raw });
      }
      return r;
    } catch (e) {
      if (c) {
        c.errors++;
        if (/respondió 429\b/.test(String((e as Error)?.message))) c.rateLimited++;
        if ((e as { timedOut?: unknown })?.timedOut === true) c.timedOut++;
      }
      throw e;
    }
  },
};
const only = process.env.SOLO?.split(",").filter(Boolean);
const imageOpts = {
  ...(process.env.CONCURRENCIA ? { concurrency: positiveInt("CONCURRENCIA", 6) } : {}),
  ...(process.env.SALTEAR ? { skipBlankTiles: process.env.SALTEAR === "1" } : {}),
};

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

export const FILES = [
  "planos-prueba.pdf",
  "1-vectorial-A3-y-A4.pdf",
  "2-escaneado-solo-imagen.pdf",
  "3-mixto-vector-escaneado-limpio.pdf",
  // Con /Rotate y caja de página corrida (scripts/make-rotated-samples.mts).
  "4-vectorial-rotado.pdf",
  "5-cad-rotado.pdf",
  "6-escaneado-rotado.pdf",
];
// Plano real de baja resolución (~102 ppi) y el mismo ampliado al doble. Fuera de la corrida por
// defecto (cuesta ~USD 0,04 más): entran con SOLO=7,8,9 o REALES=1.
export const REAL_FILES = [
  "7-plano-real-limpio-control.pdf",
  "8-plano-real-con-errores.pdf",
  "9-plano-real-con-errores-x2-resolucion.pdf",
];

/** Medición de una página escaneada en esta corrida. `retries` = llamadas hechas − mosaicos enviados. */
type PageBench = { calls: number; errors: number; rateLimited: number; timedOut: number; retries: number };
type OutPage = PageResult & Partial<ImagePageResult> & { costUsd?: { peak: number; offPeak: number } | null; bench?: PageBench };
type Out = { file: string; pages: OutPage[] };
const out: Out[] = [];
const runStarted = Date.now();

// 1) Vectoriales en el momento (milisegundos); las escaneadas quedan en una cola, cada una con su lugar.
type ImageJob = { file: string; n: number; page: Awaited<ReturnType<Awaited<ReturnType<typeof loadPdf>>["getPage"]>>; slot: OutPage[]; index: number };
const jobs: ImageJob[] = [];
for (const file of [...FILES, ...(only || process.env.REALES ? REAL_FILES : [])]) {
  if (!existsSync(`samples/${file}`)) continue;
  if (only && !only.some((p) => file.startsWith(p))) continue;
  const doc = await loadPdf(new Uint8Array(await readFile(`samples/${file}`)));
  const pages: OutPage[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const started = Date.now();
    const info = await inspectPage(page);
    if (info.kind === "vector") {
      pages.push({ ...analyzeVector(n, info), status: "ok", ms: Date.now() - started });
    } else if (info.kind === "image" && !onlyVector) {
      jobs.push({ file, n, page, slot: pages, index: pages.length });
      pages.push(undefined as unknown as OutPage); // lo completa la cola, en su orden
    } else {
      pages.push({ page: n, kind: info.kind, width: info.width, height: info.height, textCount: 0, findings: [], status: "no_verificada", ms: 0 });
    }
  }
  out.push({ file, pages });
}

// 2) Escaneadas: de a `pagesInParallel`, cada una con hasta CONCURRENCIA llamadas simultáneas.
const imageStarted = Date.now();
await mapLimit(jobs, pagesInParallel, async ({ file, n, page, slot, index }) => {
  const counters: PageCounters = { file, page: n, calls: 0, errors: 0, rateLimited: 0, timedOut: 0 };
  const r = await pageContext.run(counters, () => analyzeImagePage(n, page, provider, imageOpts));
  const sent = Object.values(r.byPass ?? {}).reduce((s, p) => s + p.tiles - p.skipped, 0);
  const { calls, errors, rateLimited, timedOut } = counters;
  slot[index] = {
    ...r,
    costUsd: estimateCostUsd(`${provider.name}:${provider.model}`, r.usage),
    bench: { calls, errors, rateLimited, timedOut, retries: Math.max(0, calls - sent) },
  };
  console.log(`  ${file} p${n}: ${(r.ms / 1000).toFixed(1)} s · ${calls} llamadas · ${rateLimited} con 429 · ${r.status}`);
});
const imageMs = Date.now() - imageStarted;

await mkdir("bench", { recursive: true });
const path = `bench/samples-${tag}.json`;
await writeFile(path, JSON.stringify(out, null, 2));
console.log(`guardado en ${path}\n`);

// Métricas de la corrida, aparte (eval-samples.mts lee sólo el archivo de arriba).
const scanned = out.flatMap((f) => f.pages.filter((p) => p.bench).map((p) => ({ file: f.file, p })));
const sum = (k: keyof PageBench) => scanned.reduce((s, { p }) => s + p.bench![k], 0);
const run = {
  tag,
  simulated,
  pagesInParallel,
  tileConcurrency: imageOpts.concurrency ?? "por defecto (6)",
  totalMs: Date.now() - runStarted,
  scannedWallMs: imageMs,
  scannedPages: scanned.length,
  calls: sum("calls"),
  rateLimited: sum("rateLimited"),
  retries: sum("retries"),
  errors: sum("errors"),
  timedOut: sum("timedOut"),
  unverified: out.reduce((s, f) => s + f.pages.filter((p) => p.status === "no_verificada").length, 0),
  unverifiedScanned: scanned.filter(({ p }) => p.status === "no_verificada").length,
  costUsd: scanned.reduce(
    (s, { p }) => ({ peak: s.peak + (p.costUsd?.peak ?? 0), offPeak: s.offPeak + (p.costUsd?.offPeak ?? 0) }),
    { peak: 0, offPeak: 0 },
  ),
  pages: scanned.map(({ file, p }) => ({ file, page: p.page, ms: p.ms, status: p.status, ...p.bench })),
};
await writeFile(`bench/samples-${tag}.corrida.json`, JSON.stringify(run, null, 2));
console.log(
  `Corrida: ${pagesInParallel} página(s) a la vez · ${(run.totalMs / 1000).toFixed(1)} s en total (escaneadas ${(imageMs / 1000).toFixed(1)} s)` +
    ` · ${run.calls} llamadas · ${run.rateLimited} con 429 · ${run.retries} reintentos · ${run.unverifiedScanned} escaneadas no verificadas` +
    ` · USD ${run.costUsd.offPeak.toFixed(4)}–${run.costUsd.peak.toFixed(4)}\n`,
);
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
