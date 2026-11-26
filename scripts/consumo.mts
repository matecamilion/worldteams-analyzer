// Resume el consumo de visión por página escaneada a partir de corridas guardadas de run-samples.
//   npx tsx scripts/consumo.mts antes-1 antes-2 antes-3
import { readFile } from "node:fs/promises";
const tags = process.argv.slice(2);
type P = { page: number; kind: string; ms: number; status: string; usage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number; reasoningTokens?: number }; byPass?: Record<string, { tiles: number; skipped: number; apiCalls: number; failed: number; inputTokens: number; outputTokens: number }>; costUsd?: { peak: number; offPeak: number } };
const rows = new Map<string, P[]>();
for (const t of tags) {
  const j = JSON.parse(await readFile(`bench/samples-${t}.json`, "utf8")) as { file: string; pages: P[] }[];
  for (const f of j) for (const p of f.pages.filter((p) => p.kind === "image")) {
    const k = `${f.file} p${p.page}`;
    rows.set(k, [...(rows.get(k) ?? []), p]);
  }
}
const avg = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
const rng = (a: number[], d = 0) => `${avg(a).toFixed(d)} (${Math.min(...a).toFixed(d)}–${Math.max(...a).toFixed(d)})`;
for (const [k, ps] of rows) {
  console.log(`${k} · ${ps.length} corridas`);
  const passes = Object.keys(ps[0].byPass ?? {});
  for (const name of passes) {
    const s = ps.map((p) => p.byPass![name]);
    console.log(
      `   pasada ${name}: mosaicos ${s[0].tiles}${s.some((x) => x.skipped) ? `, salteados ${rng(s.map((x) => x.skipped), 1)}` : ""} · llamadas ${rng(s.map((x) => x.apiCalls), 1)}` +
        ` · fallidas ${rng(s.map((x) => x.failed), 1)} · tokens ${rng(s.map((x) => x.inputTokens))} + ${rng(s.map((x) => x.outputTokens))}`,
    );
  }
  console.log(
    `   total: tokens ${rng(ps.map((p) => p.usage!.inputTokens))} (en caché ${rng(ps.map((p) => p.usage!.cachedInputTokens ?? 0))})` +
      ` + ${rng(ps.map((p) => p.usage!.outputTokens))} (razonamiento ${rng(ps.map((p) => p.usage!.reasoningTokens ?? 0))}) · ${rng(ps.map((p) => p.ms / 1000), 1)} s` +
      ` · USD ${avg(ps.map((p) => p.costUsd!.offPeak)).toFixed(4)}–${avg(ps.map((p) => p.costUsd!.peak)).toFixed(4)} (fuera de pico–pico) · estado ${ps.map((p) => p.status).join(",")}`,
  );
}
