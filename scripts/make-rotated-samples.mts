// Arma las muestras con /Rotate y con MediaBox/CropBox de origen distinto de cero, y sus esperados.
//   npx tsx scripts/make-rotated-samples.mts
//
// Dos maneras de rotar una página:
//  - "cad": como exporta un CAD. La hoja tiene /Rotate y el contenido viene girado al revés con
//    un `cm`, así que en pantalla se ve igual que la original. Mismos hallazgos, mismas cajas y
//    mismas zonas (incluidos los ejes).
//  - "girada": la página original con /Rotate agregado: en pantalla se ve girada. Mismos
//    hallazgos, con las cajas donde quedan a la vista y la zona según lo que se ve.
// Los esperados salen del detector sobre la página original (sin rotar y con origen 0, donde
// ya estaba verificado) o de samples/esperados-provisorio.json para la escaneada, llevados a la
// posición nueva con la matriz de pantalla de pdf.js. No dependen del detector sobre las rotadas.
import { readFile, writeFile } from "node:fs/promises";
import { PDFArray, PDFDocument, PDFName, PDFPage, concatTransformationMatrix, degrees, popGraphicsState, pushGraphicsState } from "pdf-lib";
import { analyzeVector, inspectPage } from "../lib/detector/analyze";
import { viewportSize, viewportTransform, type PageGeometry } from "../lib/detector/marked-pdf";
import { loadPdf } from "../lib/detector/pdf";
import { sectorName } from "../lib/detector/zones";
import type { Rect } from "../lib/detector/geometry";

type M = [number, number, number, number, number, number];
const compose = (m: M, n: M): M => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];
const invert = ([a, b, c, d, e, f]: M): M => {
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
};
const mapRect = (m: M, r: Rect): Rect => {
  const pts = [[r.x, r.y], [r.x + r.w, r.y + r.h]].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
  const x = Math.min(pts[0][0], pts[1][0]);
  const y = Math.min(pts[0][1], pts[1][1]);
  return { x, y, w: Math.abs(pts[0][0] - pts[1][0]), h: Math.abs(pts[0][1] - pts[1][1]) };
};
const r2 = (v: number) => Math.round(v * 100) / 100;

type Spec = {
  from: string;
  page: number;
  mode: "cad" | "girada";
  rotate: 0 | 90 | 180 | 270;
  /** Origen de la caja visible (CropBox) en espacio PDF. */
  origin: [number, number];
  /** Margen extra de la MediaBox alrededor de la CropBox (0 = iguales). */
  mediaMargin?: number;
};
type Out = { file: string; specs: Spec[] };

const OUTS: Out[] = [
  {
    file: "4-vectorial-rotado.pdf",
    specs: [
      { from: "1-vectorial-A3-y-A4.pdf", page: 1, mode: "girada", rotate: 90, origin: [0, 0] },
      { from: "1-vectorial-A3-y-A4.pdf", page: 1, mode: "girada", rotate: 180, origin: [0, 0] },
      { from: "1-vectorial-A3-y-A4.pdf", page: 1, mode: "girada", rotate: 270, origin: [0, 0] },
      { from: "1-vectorial-A3-y-A4.pdf", page: 2, mode: "girada", rotate: 90, origin: [0, 0] },
      { from: "1-vectorial-A3-y-A4.pdf", page: 1, mode: "girada", rotate: 90, origin: [-30, -20], mediaMargin: 30 },
    ],
  },
  {
    file: "5-cad-rotado.pdf",
    specs: [
      { from: "planos-prueba.pdf", page: 1, mode: "cad", rotate: 90, origin: [0, 0] },
      { from: "planos-prueba.pdf", page: 3, mode: "cad", rotate: 270, origin: [40, 25] },
      { from: "planos-prueba.pdf", page: 4, mode: "cad", rotate: 180, origin: [0, 0] },
      { from: "planos-prueba.pdf", page: 1, mode: "cad", rotate: 0, origin: [-100, -200], mediaMargin: 50 },
      { from: "1-vectorial-A3-y-A4.pdf", page: 1, mode: "cad", rotate: 90, origin: [12, -35], mediaMargin: 20 },
    ],
  },
  {
    file: "6-escaneado-rotado.pdf",
    specs: [
      { from: "2-escaneado-solo-imagen.pdf", page: 1, mode: "cad", rotate: 90, origin: [0, 0] },
      { from: "2-escaneado-solo-imagen.pdf", page: 1, mode: "cad", rotate: 180, origin: [0, 0] },
      { from: "2-escaneado-solo-imagen.pdf", page: 1, mode: "cad", rotate: 270, origin: [30, 15] },
      { from: "2-escaneado-solo-imagen.pdf", page: 1, mode: "cad", rotate: 0, origin: [-80, -60], mediaMargin: 40 },
    ],
  },
];

type Exp = { severity: string; texts: string[]; box: [number, number, number, number]; zone?: string };
const provisional = JSON.parse(await readFile("samples/esperados-provisorio.json", "utf8")) as {
  files: { file: string; pages: { page: number; kind: string; expected: Exp[] }[] }[];
};

/** Hallazgos esperados de la página original, en su espacio de pantalla. */
async function originalExpected(file: string, n: number): Promise<{ kind: string; size: { w: number; h: number }; items: Exp[] }> {
  const doc = await loadPdf(new Uint8Array(await readFile(`samples/${file}`)));
  const page = await doc.getPage(n);
  const [, , w, h] = page.view;
  if (page.rotate !== 0 || page.view[0] !== 0 || page.view[1] !== 0) throw new Error(`${file} p${n} no es una página de origen 0 sin rotar`);
  const info = await inspectPage(page);
  if (info.kind === "vector") {
    const r = analyzeVector(n, info);
    return {
      kind: "vector",
      size: { w, h },
      items: r.findings.map((f) => ({ severity: f.severity, texts: f.texts, box: [f.box.x, f.box.y, f.box.w, f.box.h], zone: f.zone })),
    };
  }
  const exp = provisional.files.find((f) => f.file === file)?.pages.find((p) => p.page === n);
  if (!exp) throw new Error(`sin esperados para ${file} p${n}`);
  return { kind: "image", size: { w, h }, items: exp.expected };
}

const expectedFiles: { file: string; pages: { page: number; kind: string; rotate: number; modo: string; expected: Exp[] }[] }[] = [];

for (const out of OUTS) {
  const doc = await PDFDocument.create();
  const pages: (typeof expectedFiles)[number]["pages"] = [];
  // Cada página de origen se copia una vez (la imagen escaneada no se repite) y cada variante
  // usa un clon de su diccionario: pdf-lib devuelve el mismo objeto si se copia dos veces.
  const copies = new Map<string, PDFPage>();
  for (const from of new Set(out.specs.map((s) => s.from))) {
    const src = await PDFDocument.load(await readFile(`samples/${from}`));
    const wanted = [...new Set(out.specs.filter((s) => s.from === from).map((s) => s.page))];
    const pages = await doc.copyPages(src, wanted.map((n) => n - 1));
    wanted.forEach((n, i) => copies.set(`${from}#${n}`, pages[i]));
  }
  for (const [i, s] of out.specs.entries()) {
    const leaf = copies.get(`${s.from}#${s.page}`)!.node.clone(doc.context);
    const contents = leaf.get(PDFName.of("Contents"));
    // /Contents como arreglo propio de esta página (wrapContentStreams no hace nada si no lo es).
    leaf.set(PDFName.of("Contents"), contents instanceof PDFArray ? contents.clone(doc.context) : doc.context.obj([contents!]));
    const page = PDFPage.of(leaf, doc.context.register(leaf), doc);
    doc.addPage(page);
    const { width: W, height: H } = page.getSize();
    const orig: PageGeometry = { view: [0, 0, W, H], rotate: 0 };
    // En "cad" la hoja guarda el contenido acostado: el ancho en PDF es el alto que se ve.
    const lying = s.mode === "cad" && s.rotate % 180 !== 0;
    const [vw, vh] = lying ? [H, W] : [W, H];
    const view: PageGeometry["view"] = [s.origin[0], s.origin[1], s.origin[0] + vw, s.origin[1] + vh];
    const geom: PageGeometry = { view, rotate: s.rotate };
    const m = s.mediaMargin ?? 0;
    page.setMediaBox(view[0] - m, view[1] - m, vw + 2 * m, vh + 2 * m);
    page.setCropBox(view[0], view[1], vw, vh);
    page.setRotation(degrees(s.rotate));
    // Pantalla original → pantalla nueva. En "cad" es la identidad (se ve igual); en "girada", el giro.
    let screenMap: M;
    if (s.mode === "cad") {
      // Contenido: espacio PDF original → espacio PDF nuevo, tal que se vea igual: C = Vnuevo⁻¹ · Voriginal.
      const C = compose(invert(viewportTransform(geom)), viewportTransform(orig));
      const start = doc.context.register(doc.context.contentStream([pushGraphicsState(), concatTransformationMatrix(...C)]));
      const end = doc.context.register(doc.context.contentStream([popGraphicsState()]));
      if (!page.node.wrapContentStreams(start, end)) throw new Error(`no se pudo girar el contenido de ${s.from} p${s.page}`);
      screenMap = [1, 0, 0, 1, 0, 0];
    } else {
      screenMap = compose(viewportTransform(geom), invert(viewportTransform(orig)));
    }
    const o = await originalExpected(s.from, s.page);
    const size = viewportSize(geom);
    pages.push({
      page: i + 1,
      kind: o.kind,
      rotate: s.rotate,
      modo: `${s.mode} desde ${s.from} p${s.page}${s.origin[0] || s.origin[1] ? `, origen ${s.origin.join(",")}` : ""}${m ? `, MediaBox ${m} pt más grande` : ""}`,
      expected: o.items.map((e) => {
        const b = mapRect(screenMap, { x: e.box[0], y: e.box[1], w: e.box[2], h: e.box[3] });
        // La zona por ejes sólo se conserva si la hoja se ve igual; girada, vale el sector que se ve.
        const zone = o.kind !== "vector" ? undefined : s.mode === "cad" ? e.zone : sectorName(b, { width: size.w, height: size.h });
        return { severity: e.severity, texts: e.texts, box: [r2(b.x), r2(b.y), r2(b.w), r2(b.h)], ...(zone ? { zone } : {}) };
      }),
    });
  }
  await writeFile(`samples/${out.file}`, await doc.save({ useObjectStreams: false }));
  expectedFiles.push({ file: out.file, pages });
  console.log(`samples/${out.file}: ${out.specs.length} páginas`);
}

await writeFile(
  "samples/esperados-rotados.json",
  JSON.stringify(
    {
      nota:
        "Generado por scripts/make-rotated-samples.mts. Mismos hallazgos que la página original (sin rotar, origen 0), con la caja en pt de pantalla (origen arriba-izquierda, ya rotada) y, en vectoriales, la zona que se ve.",
      files: expectedFiles,
    },
    null,
    1,
  ) + "\n",
);
console.log("samples/esperados-rotados.json");
