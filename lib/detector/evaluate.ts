import { iou, padRect, rectIntersection, type Rect } from "./geometry";
import type { Finding } from "./types";

export type ExpectedClash = { id: string; texts: string[]; box: [number, number, number, number] };
export type ExpectedTrap = { id: string; texts: string[]; box?: [number, number, number, number]; reason: string };
export type ExpectedPage = { page: number; kind: string; clashes: ExpectedClash[]; not_clashes?: ExpectedTrap[] };

export type Metric = "iou" | "contacto";

export type PageScore = {
  page: number;
  metric: Metric;
  expected: number;
  reported: number;
  truePositives: string[];
  falseNegatives: string[];
  falsePositives: Finding[];
  /** Trampas (texto sobre línea, casos límite) que el detector marcó como choque. */
  trapsHit: string[];
  /** Por cada acierto: IoU y distancia entre centros (pt). */
  matches: { id: string; iou: number; centerErr: number }[];
};

/** Umbral de IoU para contar un acierto. */
export const MIN_IOU = 0.3;
/** Criterio anterior (sólo para comparar): cualquier contacto con 6 pt de margen. */
const CONTACT_MARGIN_PT = 6;

const toRect = (b: [number, number, number, number]): Rect => ({ x: b[0], y: b[1], w: b[2], h: b[3] });
const center = (r: Rect) => [r.x + r.w / 2, r.y + r.h / 2];

export function scorePage(expected: ExpectedPage, findings: Finding[], metric: Metric = "iou"): PageScore {
  const clashes = findings.filter((f) => f.severity === "choque");
  // Todos los pares candidatos, el mejor primero; emparejamiento uno a uno.
  const pairs: { f: Finding; e: ExpectedClash; score: number }[] = [];
  for (const f of clashes) {
    for (const e of expected.clashes) {
      const box = toRect(e.box);
      const score = metric === "iou" ? iou(f.box, box) : rectIntersection(padRect(f.box, CONTACT_MARGIN_PT), box) ? 1 : 0;
      if (metric === "iou" ? score >= MIN_IOU : score > 0) pairs.push({ f, e, score: metric === "iou" ? score : iou(f.box, box) });
    }
  }
  pairs.sort((a, b) => b.score - a.score);
  const usedF = new Set<string>();
  const usedE = new Set<string>();
  const matches: PageScore["matches"] = [];
  for (const p of pairs) {
    if (usedF.has(p.f.id) || usedE.has(p.e.id)) continue;
    usedF.add(p.f.id);
    usedE.add(p.e.id);
    const [ax, ay] = center(p.f.box);
    const [bx, by] = center(toRect(p.e.box));
    matches.push({ id: p.e.id, iou: iou(p.f.box, toRect(p.e.box)), centerErr: Math.hypot(ax - bx, ay - by) });
  }
  const fps = clashes.filter((f) => !usedF.has(f.id));
  return {
    page: expected.page,
    metric,
    expected: expected.clashes.length,
    reported: clashes.length,
    truePositives: matches.map((m) => m.id),
    falseNegatives: expected.clashes.filter((e) => !usedE.has(e.id)).map((e) => e.id),
    falsePositives: fps,
    trapsHit: (expected.not_clashes ?? [])
      .filter((t) => t.box)
      .filter((t) => fps.some((f) => rectIntersection(padRect(f.box, CONTACT_MARGIN_PT / 2), toRect(t.box!))))
      .map((t) => t.id),
    matches,
  };
}

export function totals(scores: PageScore[]) {
  const tp = scores.reduce((n, s) => n + s.truePositives.length, 0);
  const fp = scores.reduce((n, s) => n + s.falsePositives.length, 0);
  const fn = scores.reduce((n, s) => n + s.falseNegatives.length, 0);
  const m = scores.flatMap((s) => s.matches);
  return {
    tp,
    fp,
    fn,
    precision: tp + fp ? tp / (tp + fp) : 1,
    recall: tp + fn ? tp / (tp + fn) : 1,
    meanIou: m.length ? m.reduce((s, x) => s + x.iou, 0) / m.length : NaN,
    meanCenterErr: m.length ? m.reduce((s, x) => s + x.centerErr, 0) / m.length : NaN,
  };
}
