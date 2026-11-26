import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { analyzeVector, inspectPage } from "../lib/detector/analyze";
import { loadPdf } from "../lib/detector/pdf";

// Páginas con /Rotate 90, 180 y 270 y con MediaBox/CropBox de origen distinto de cero
// (samples/*-rotado.pdf, armadas por scripts/make-rotated-samples.mts). El detector tiene que
// dar los mismos hallazgos que en la página original, con la caja donde se ve en pantalla y la
// zona según lo que se ve.
type Exp = { severity: string; texts: string[]; box: [number, number, number, number]; zone?: string };
const expected = JSON.parse(await readFile("samples/esperados-rotados.json", "utf8")) as {
  files: { file: string; pages: { page: number; kind: string; rotate: number; modo: string; expected: Exp[] }[] }[];
};

const key = (severity: string, texts: string[]) => `${severity}:${[...texts].sort().join("|")}`;

for (const file of expected.files.filter((f) => f.pages.every((p) => p.kind === "vector"))) {
  test(`${file.file}: mismos hallazgos, en la posición y la zona que se ven`, async () => {
    const doc = await loadPdf(new Uint8Array(await readFile(`samples/${file.file}`)));
    for (const exp of file.pages) {
      const page = await doc.getPage(exp.page);
      const vp = page.getViewport({ scale: 1 });
      const info = await inspectPage(page);
      const where = `p${exp.page} (${exp.modo}, /Rotate ${exp.rotate})`;
      assert.equal(info.kind, "vector", where);
      const r = analyzeVector(exp.page, info);
      assert.ok(Math.abs(r.width - vp.width) < 0.01 && Math.abs(r.height - vp.height) < 0.01, `${where}: tamaño ${r.width}×${r.height}`);
      assert.deepEqual(r.findings.map((f) => key(f.severity, f.texts)).sort(), exp.expected.map((e) => key(e.severity, e.texts)).sort(), where);
      for (const e of exp.expected) {
        const f = r.findings.find((x) => key(x.severity, x.texts) === key(e.severity, e.texts))!;
        const got = [f.box.x, f.box.y, f.box.w, f.box.h];
        got.forEach((v, i) => assert.ok(Math.abs(v - e.box[i]) < 0.5, `${where} ${e.texts.join(" × ")}: caja ${got.map(Math.round)} vs ${e.box.map(Math.round)}`));
        assert.equal(f.zone, e.zone, `${where} ${e.texts.join(" × ")}: zona`);
        // La caja normalizada es la misma caja relativa a lo que se ve.
        assert.ok(Math.abs(f.boxNorm.x - f.box.x / vp.width) < 1e-9 && Math.abs(f.boxNorm.y - f.box.y / vp.height) < 1e-9, `${where}: boxNorm`);
      }
    }
  });
}
