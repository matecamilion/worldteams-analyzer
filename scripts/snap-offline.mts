// Aplica el ajuste a tinta sobre los resultados guardados en bench/ (sin llamar a la API)
// y compara las métricas antes y después.
//   npx tsx scripts/snap-offline.mts [filtro]
import { readdir, readFile } from "node:fs/promises";
import { extractLargestImage, loadPdf } from "../lib/detector/pdf";
import { DEFAULT_SNAP, snapToInk, toGray } from "../lib/detector/ink";
import { scorePage, totals, type ExpectedPage } from "../lib/detector/evaluate";
import type { Finding, PageResult } from "../lib/detector/types";

const filter = process.argv[2] ?? "";
const expected = JSON.parse(await readFile("samples/expected.json", "utf8")) as { pages: ExpectedPage[] };
const exp6 = expected.pages.find((p) => p.page === 6)!;
const doc = await loadPdf(new Uint8Array(await readFile("samples/planos-prueba.pdf")));
const img = (await extractLargestImage(await doc.getPage(6)))!;
const gray = toGray(img.data, img.width, img.height, img.channels);
const sx = img.placement.w / img.width;
const sy = img.placement.h / img.height;

const snapWith = (pick: "cercano" | "pesado") => (f0: Finding): Finding => {
  // Si la corrida ya venía ajustada, se parte de la caja original del modelo.
  const f = f0.modelBox ? { ...f0, box: f0.modelBox } : f0;
  const px = { x: (f.box.x - img.placement.x) / sx, y: (f.box.y - img.placement.y) / sy, w: f.box.w / sx, h: f.box.h / sy };
  const s = snapToInk(gray, px, { ...DEFAULT_SNAP, pick });
  if (!s) return f;
  return { ...f, box: { x: img.placement.x + s.x * sx, y: img.placement.y + s.y * sy, w: s.w * sx, h: s.h * sy } };
};

const files = (await readdir("bench")).filter((f) => f.startsWith("p6-") && f.includes(filter) && f.endsWith(".json"));
const groups: Record<string, string[]> = {};
for (const f of files) {
  if (f.includes("-tinta-")) continue; // guardadas antes de registrar modelBox
  const g = f.includes("-ajuste-") ? "con refinamiento IA" : "sin refinamiento";
  (groups[g] ??= []).push(f);
}
for (const [g, list] of Object.entries(groups)) {
  for (const variant of ["tal cual", "+ tinta cercano", "+ tinta pesado"]) {
    const scores = [];
    for (const f of list) {
      const j = JSON.parse(await readFile(`bench/${f}`, "utf8")) as { pages: PageResult[] };
      const findings = j.pages[0].findings
        .filter((x) => !x.passes || x.passes.includes("mosaicos"))
        .map((x) => (x.modelBox ? { ...x, box: x.modelBox } : x));
      scores.push(scorePage(exp6, variant === "tal cual" ? findings : findings.map(snapWith(variant.includes("pesado") ? "pesado" : "cercano")), "iou"));
    }
    const t = totals(scores);
    const perfect = scores.filter((s) => s.truePositives.length === s.expected && !s.falsePositives.length).length;
    console.log(
      `${g.padEnd(20)} ${variant.padEnd(17)} corridas=${scores.length} · aciertos IoU ${t.tp}/${t.tp + t.fn} · de más ${t.fp}` +
        ` · perfectas ${perfect} · IoU medio ${t.meanIou.toFixed(2)} · error centro ${t.meanCenterErr.toFixed(1)} pt`,
    );
  }
}
