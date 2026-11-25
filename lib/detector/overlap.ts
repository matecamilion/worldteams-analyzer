import { clipConvex, iou, polygonArea, rectGap, unionRect, boundsOf, type Rect } from "./geometry";
import { ORIGIN_LABEL, type DetectorOptions, type Finding, type Severity, type TextBox } from "./types";
import { describeZone, findGridAxes, type GridAxes } from "./zones";

type Pair = { a: TextBox; b: TextBox; severity: Severity; ratio: number; inter: Rect | null };

function normText(s: string) {
  return s.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Clasifica un par de textos distintos. Devuelve null si no hay nada que informar. */
export function classifyPair(a: TextBox, b: TextBox, opts: DetectorOptions): Pair | null {
  // Descarte rápido por cajas alineadas a ejes.
  const gap = rectGap(a.bounds, b.bounds);
  if (gap > opts.nearGap) return null;

  const interPoly = clipConvex(a.poly, b.poly);
  const interArea = interPoly.length >= 3 ? polygonArea(interPoly) : 0;
  const minArea = Math.min(polygonArea(a.poly), polygonArea(b.poly));
  const ratio = minArea > 0 ? interArea / minArea : 0;

  // Mismo texto en el mismo lugar: es una duplicación (p. ej. negrita simulada), no se ve como choque.
  if (normText(a.text) === normText(b.text) && iou(a.bounds, b.bounds) > 0.8) {
    return { a, b, severity: "duplicado", ratio, inter: interPoly.length >= 3 ? boundsOf(interPoly) : null };
  }

  if (interArea >= opts.minOverlapArea && ratio >= opts.minOverlapRatio) {
    return { a, b, severity: "choque", ratio, inter: boundsOf(interPoly) };
  }
  // Se tocan o casi: lo informamos aparte, sin contarlo como choque.
  if (interArea < opts.minOverlapArea) {
    return { a, b, severity: "cercania", ratio, inter: null };
  }
  return null;
}

/** Confianza de un choque vectorial: la geometría es exacta, así que depende sólo de cuánto se pisan. */
function confidenceFor(severity: Severity, ratio: number): number {
  if (severity === "choque") return Math.min(0.99, 0.75 + ratio * 0.5);
  if (severity === "duplicado") return 0.9;
  return 0.5;
}

export function detectVectorOverlaps(
  boxes: TextBox[],
  page: { number: number; width: number; height: number },
  opts: DetectorOptions,
): Finding[] {
  const pairs: Pair[] = [];
  // Ordenamos por x para cortar el doble bucle temprano (sweep simple).
  const sorted = [...boxes].sort((p, q) => p.bounds.x - q.bounds.x);
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j];
      if (b.bounds.x > a.bounds.x + a.bounds.w + opts.nearGap) break;
      const pair = classifyPair(a, b, opts);
      if (pair) pairs.push(pair);
    }
  }

  // Una cercanía entre textos que ya están en un choque es parte de esa misma zona: no la repetimos.
  const inClash = new Set(pairs.filter((p) => p.severity === "choque").flatMap((p) => [p.a.id, p.b.id]));
  for (let i = pairs.length - 1; i >= 0; i--) {
    const p = pairs[i];
    if (p.severity === "cercania" && (inClash.has(p.a.id) || inClash.has(p.b.id))) pairs.splice(i, 1);
  }

  // Agrupamos pares que comparten textos en una misma zona (union-find), por severidad.
  const axes: GridAxes = findGridAxes(boxes);
  const findings: Finding[] = [];
  for (const severity of ["choque", "duplicado", "cercania"] as Severity[]) {
    const group = pairs.filter((p) => p.severity === severity);
    const parent = new Map<number, number>();
    const find = (x: number): number => {
      while (parent.get(x) !== undefined && parent.get(x) !== x) x = parent.get(x)!;
      return x;
    };
    for (const p of group) {
      if (!parent.has(p.a.id)) parent.set(p.a.id, p.a.id);
      if (!parent.has(p.b.id)) parent.set(p.b.id, p.b.id);
      parent.set(find(p.a.id), find(p.b.id));
    }
    const clusters = new Map<number, Pair[]>();
    for (const p of group) {
      const root = find(p.a.id);
      clusters.set(root, [...(clusters.get(root) ?? []), p]);
    }
    for (const cluster of clusters.values()) {
      const members = new Map<number, TextBox>();
      cluster.forEach((p) => {
        members.set(p.a.id, p.a);
        members.set(p.b.id, p.b);
      });
      const texts = [...members.values()];
      const box = unionRect(texts.map((t) => t.bounds));
      const ratio = Math.max(...cluster.map((p) => p.ratio));
      findings.push({
        id: `p${page.number}-${severity}-${findings.length + 1}`,
        page: page.number,
        severity,
        box,
        boxNorm: { x: box.x / page.width, y: box.y / page.height, w: box.w / page.width, h: box.h / page.height },
        texts: texts.map((t) => t.text),
        zone: describeZone(box, axes, page),
        confidence: Number(confidenceFor(severity, ratio).toFixed(2)),
        overlapRatio: Number(ratio.toFixed(3)),
        source: "vector",
        originLabel: ORIGIN_LABEL.vector,
      });
    }
  }
  return findings;
}
