// Corre el detector vectorial sobre un PDF y muestra los hallazgos por página.
import { readFile } from "node:fs/promises";
import { loadPdf } from "../lib/detector/pdf";
import { analyzeVector, inspectPage } from "../lib/detector/analyze";

const doc = await loadPdf(new Uint8Array(await readFile(process.argv[2])));
for (let n = 1; n <= doc.numPages; n++) {
  const info = await inspectPage(await doc.getPage(n));
  if (info.kind !== "vector") { console.log(`p${n}: ${info.kind}`); continue; }
  const r = analyzeVector(n, info);
  console.log(`p${n}: ${r.textCount} textos, ${r.findings.length} hallazgos`);
  for (const f of r.findings) console.log(`   [${f.severity}] ${f.texts.join(" × ")} · ${f.zone} · r=${f.overlapRatio} c=${f.confidence} box=${[f.box.x, f.box.y, f.box.w, f.box.h].map(v => v.toFixed(1)).join(",")}`);
}
