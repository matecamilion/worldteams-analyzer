import { padRect, rectIntersection, type Rect } from "./geometry";
import type { Finding } from "./types";

export type ExpectedClash = { id: string; texts: string[]; box: [number, number, number, number] };
export type ExpectedTrap = { id: string; texts: string[]; box?: [number, number, number, number]; reason: string };
export type ExpectedPage = { page: number; kind: string; clashes: ExpectedClash[]; not_clashes?: ExpectedTrap[] };

export type PageScore = {
  page: number;
  expected: number;
  reported: number;
  truePositives: string[];
  falseNegatives: string[];
  falsePositives: Finding[];
  /** Trampas (texto sobre línea, casos límite) que el detector marcó como choque. */
  trapsHit: string[];
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
    trapsHit: (expected.not_clashes ?? [])
      .filter((t) => t.box)
      .filter((t) => {
        const box: Rect = { x: t.box![0], y: t.box![1], w: t.box![2], h: t.box![3] };
        return fps.some((f) => rectIntersection(padRect(f.box, MARGIN_PT / 2), box));
      })
      .map((t) => t.id),
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
