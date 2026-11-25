// Vuelve a puntuar resultados guardados en bench/ con la métrica de contacto y con IoU.
//   npx tsx scripts/rescore-bench.mts [filtro]
import { readdir, readFile } from "node:fs/promises";
import { scorePage, totals, type ExpectedPage, type Metric } from "../lib/detector/evaluate";
import type { PageResult } from "../lib/detector/types";

const filter = process.argv[2] ?? "";
const expected = JSON.parse(await readFile("samples/expected.json", "utf8")) as { pages: ExpectedPage[] };
const files = (await readdir("bench")).filter((f) => f.startsWith("p6-") && f.includes(filter) && f.endsWith(".json"));

for (const metric of ["contacto", "iou"] as Metric[]) {
  const scores = [];
  for (const f of files) {
    const j = JSON.parse(await readFile(`bench/${f}`, "utf8")) as { pages: PageResult[] };
    for (const p of j.pages) {
      const exp = expected.pages.find((e) => e.page === p.page)!;
      scores.push(scorePage(exp, p.findings, metric));
    }
  }
  const t = totals(scores);
  const perfect = scores.filter((s) => s.truePositives.length === s.expected && s.falsePositives.length === 0).length;
  console.log(
    `${metric.padEnd(8)} corridas=${scores.length} · aciertos ${t.tp}/${t.tp + t.fn} · de más ${t.fp}` +
      ` · corridas perfectas ${perfect}/${scores.length} · IoU medio ${t.meanIou.toFixed(2)} · error de centro ${t.meanCenterErr.toFixed(1)} pt`,
  );
}
