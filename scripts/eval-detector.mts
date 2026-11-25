// Mide el detector contra samples/expected.json.
//   npx tsx scripts/eval-detector.mts                       → sólo páginas vectoriales
//   npx tsx scripts/eval-detector.mts resultados.json        → además, hallazgos de visión guardados
// El JSON de visión es el reporte exportado desde la app (lista de PageResult).
import { readFile } from "node:fs/promises";
import { loadPdf } from "../lib/detector/pdf";
import { analyzeVector, inspectPage } from "../lib/detector/analyze";
import { scorePage, totals, type ExpectedPage, type PageScore } from "../lib/detector/evaluate";
import type { Finding, PageResult } from "../lib/detector/types";

const expected = JSON.parse(await readFile("samples/expected.json", "utf8")) as { file: string; pages: ExpectedPage[] };
const visionFile = process.argv[2];
const vision: PageResult[] = visionFile ? JSON.parse(await readFile(visionFile, "utf8")).pages ?? [] : [];

const doc = await loadPdf(new Uint8Array(await readFile(`samples/${expected.file}`)));
const scores: PageScore[] = [];
for (const exp of expected.pages) {
  const info = await inspectPage(await doc.getPage(exp.page));
  let findings: Finding[] | null = null;
  if (info.kind === "vector") findings = analyzeVector(exp.page, info).findings;
  else findings = vision.find((p) => p.page === exp.page)?.findings ?? null;

  if (!findings) {
    console.log(`p${exp.page} (${info.kind}): sin resultados de visión, no se mide`);
    continue;
  }
  const s = scorePage(exp, findings);
  scores.push(s);
  const fpTxt = s.falsePositives.map((f) => f.texts.join(" × ")).join("; ");
  console.log(
    `p${exp.page} (${info.kind}): esperados ${s.expected}, informados ${s.reported}, aciertos ${s.truePositives.length}` +
      (s.falseNegatives.length ? `, faltan [${s.falseNegatives.join(", ")}]` : "") +
      (s.falsePositives.length ? `, de más [${fpTxt}]` : ""),
  );
}
const t = totals(scores);
console.log(`\nTotal: TP=${t.tp} FP=${t.fp} FN=${t.fn} · precisión ${(t.precision * 100).toFixed(0)}% · exhaustividad ${(t.recall * 100).toFixed(0)}%`);
