// Compara una corrida guardada de run-samples (bench/samples-<etiqueta>.json) contra lo esperado:
// samples/esperados.json (o el provisorio) para los 3 PDFs sintéticos y samples/expected.json
// para planos-prueba. Muestra esperado vs. detectado por página y las marcas de más.
//   npx tsx scripts/eval-samples.mts <etiqueta> [<etiqueta> ...] [--detalle]
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { iou, padRect, rectIntersection, type Rect } from "../lib/detector/geometry";
import { scorePage, type ExpectedPage } from "../lib/detector/evaluate";
import type { Finding, PageResult } from "../lib/detector/types";

type Exp = { severity: string; texts: string[]; box?: [number, number, number, number] };
type ExpFile = { file: string; pages: { page: number; kind: string; expected: Exp[] }[] };

const args = process.argv.slice(2);
const detail = args.includes("--detalle");
const tags = args.filter((a) => !a.startsWith("--"));
const expPath = existsSync("samples/esperados.json") ? "samples/esperados.json" : "samples/esperados-provisorio.json";
const synthetic = [
  ...(JSON.parse(await readFile(expPath, "utf8")) as { files: ExpFile[] }).files,
  // Las rotadas tienen su propio archivo (lo arma scripts/make-rotated-samples.mts).
  ...(JSON.parse(await readFile("samples/esperados-rotados.json", "utf8")) as { files: ExpFile[] }).files,
];
const ROTATED = new Set(["4-vectorial-rotado.pdf", "5-cad-rotado.pdf", "6-escaneado-rotado.pdf"]);
const legacy = JSON.parse(await readFile("samples/expected.json", "utf8")) as { pages: ExpectedPage[] };

const words = (t: string[]) => new Set(t.join(" ").toUpperCase().split(/[^A-Z0-9=.,:+]+/).filter(Boolean));
const toRect = (b: [number, number, number, number]): Rect => ({ x: b[0], y: b[1], w: b[2], h: b[3] });

/**
 * Vectorial: mismo tipo y todas las palabras esperadas presentes; si el esperado trae caja (las
 * rotadas), además IoU ≥ 0,5 con ella. Escaneada: mismo tipo y contacto con ±10 pt.
 */
function matches(e: Exp, f: Finding, kind: string): boolean {
  if (e.severity !== f.severity) return false;
  if (kind === "image" && e.box) return !!rectIntersection(padRect(f.box, 10), toRect(e.box));
  const fw = words(f.texts);
  if (![...words(e.texts)].every((w) => fw.has(w))) return false;
  return !e.box || iou(f.box, toRect(e.box)) >= 0.5;
}

console.log(`esperados: ${expPath}${expPath.includes("provisorio") ? " (PROVISORIO, armado por Claude)" : ""}\n`);
for (const tag of tags) {
  const run = JSON.parse(await readFile(`bench/samples-${tag}.json`, "utf8")) as { file: string; pages: (PageResult & { costUsd?: { peak: number; offPeak: number } })[] }[];
  let tp = 0, fn = 0, fp = 0;
  // Subtotales: los 4 PDFs de siempre por un lado y los rotados por otro.
  const sub = { originales: { tp: 0, fn: 0, fp: 0 }, rotados: { tp: 0, fn: 0, fp: 0 } };
  const lines: string[] = [];
  for (const f of run) {
    for (const p of f.pages) {
      let expected: Exp[] = [];
      let found: Finding[] = p.findings;
      let matched: string[] = [];
      let extra: Finding[] = [];
      let missed: string[] = [];
      if (f.file === "planos-prueba.pdf") {
        const e = legacy.pages.find((x) => x.page === p.page);
        if (!e) continue;
        const s = scorePage(e, p.findings, p.kind === "image" ? "iou" : "contacto");
        expected = e.clashes.map((c) => ({ severity: "choque", texts: c.texts }));
        matched = s.truePositives;
        missed = s.falseNegatives;
        extra = s.falsePositives;
        found = p.findings.filter((x) => x.severity === "choque");
      } else {
        const page = synthetic.find((x) => x.file === f.file)?.pages.find((x) => x.page === p.page);
        if (!page) continue;
        expected = page.expected;
        const used = new Set<string>();
        for (const e of expected) {
          const hit = found.find((x) => !used.has(x.id) && matches(e, x, p.kind));
          if (hit) {
            used.add(hit.id);
            matched.push(e.texts.join(" × "));
          } else missed.push(`${e.severity} ${e.texts.join(" × ")}`);
        }
        extra = found.filter((x) => !used.has(x.id));
      }
      tp += matched.length;
      fn += missed.length;
      fp += extra.length;
      const g = sub[ROTATED.has(f.file) ? "rotados" : "originales"];
      g.tp += matched.length;
      g.fn += missed.length;
      g.fp += extra.length;
      const cost = p.costUsd ? ` · USD ${p.costUsd.offPeak.toFixed(4)}–${p.costUsd.peak.toFixed(4)}` : "";
      lines.push(
        `  ${f.file} p${p.page} (${p.kind}${p.status !== "ok" ? `, ${p.status}` : ""}): esperado ${expected.length} · detectado ${matched.length} · de más ${extra.length}` +
          ` · ${(p.ms / 1000).toFixed(1)} s${cost}` +
          (missed.length ? `\n      falta: ${missed.join("; ")}` : "") +
          (extra.length ? `\n      de más: ${extra.map((x) => `${x.severity} [${x.texts.join(" × ")}] en ${Math.round(x.box.x)},${Math.round(x.box.y)}`).join("; ")}` : ""),
      );
    }
  }
  console.log(`${tag}: detectados ${tp}/${tp + fn} · de más ${fp}`);
  for (const [name, g] of Object.entries(sub)) {
    if (g.tp + g.fn + g.fp) console.log(`  ${name}: detectados ${g.tp}/${g.tp + g.fn} · de más ${g.fp}`);
  }
  if (detail) console.log(lines.join("\n"));
}
