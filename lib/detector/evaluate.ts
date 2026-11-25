import { padRect, rectIntersection, type Rect } from "./geometry";
import type { Finding } from "./types";

export type ExpectedClash = { id: string; texts: string[]; box: [number, number, number, number] };
export type ExpectedPage = { page: number; kind: string; clashes: ExpectedClash[] };

export type PageScore = {
  page: number;
  expected: number;
  reported: number;
  truePositives: string[];
  falseNegatives: string[];
  falsePositives: Finding[];
};

const MARGIN_PT = 6;

/** Empareja por posición: cada hallazgo "choque" puede acertar como mucho un esperado. */
export function scorePage(expected: ExpectedPage, findings: Finding[]): PageScore {
  const clashes = findings.filter((f) => f.severity === "choque");
  const used = new Set<string>();
  const fps: Finding[] = [];
  for (const f of clashes) {
    const hit = expected.clashes.find((e) => {
      if (used.has(e.id)) return false;
      const box: Rect = { x: e.box[0], y: e.box[1], w: e.box[2], h: e.box[3] };
      return rectIntersection(padRect(f.box, MARGIN_PT), box) !== null;
    });
    if (hit) used.add(hit.id);
    else fps.push(f);
  }
  return {
    page: expected.page,
    expected: expected.clashes.length,
    reported: clashes.length,
    truePositives: [...used],
    falseNegatives: expected.clashes.filter((e) => !used.has(e.id)).map((e) => e.id),
    falsePositives: fps,
  };
}

export function totals(scores: PageScore[]) {
  const tp = scores.reduce((n, s) => n + s.truePositives.length, 0);
  const fp = scores.reduce((n, s) => n + s.falsePositives.length, 0);
  const fn = scores.reduce((n, s) => n + s.falseNegatives.length, 0);
  return {
    tp,
    fp,
    fn,
    precision: tp + fp ? tp / (tp + fp) : 1,
    recall: tp + fn ? tp / (tp + fn) : 1,
  };
}
