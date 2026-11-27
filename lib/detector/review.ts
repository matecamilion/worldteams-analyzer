// Revisión del usuario sobre los hallazgos: lo que marcó como "Está bien" (descartado).
// Puro y sin DOM: lo usan la pantalla, el PDF con marcas y los tests. No cambia los resultados
// del análisis (ni la caché): se aplica encima, cada vez que se muestran o exportan.
import type { Rect } from "./geometry";
import type { Finding, PageResult, Severity } from "./types";

/** Un hallazgo que la persona marcó como "Está bien". `firma` empieza con "vector:" o "ia:". */
export type Dismissal = { firma: string; tipo: Severity; boxNorm: Rect; textos: string[]; fecha: string };
export type PageReview = { descartados: Dismissal[] };
/** Revisión de un PDF, por número de página. */
export type Review = Record<number, PageReview>;

/**
 * IoU mínimo para reconocer un hallazgo de IA descartado en otro análisis de la misma página.
 * Calibrado con 9 corridas guardadas en bench/ (10 páginas escaneadas, 1456 pares del mismo
 * hallazgo entre corridas): con 0,3–0,6 se reconoce el 99,7 %; con 0,7 baja a 98,8 %. Dos
 * hallazgos distintos de una misma corrida nunca se superponen (IoU máximo 0 en 201 pares).
 * Se eligió el más estricto antes de que empiece a perder: 0,6.
 */
export const IOU_MIN = 0.6;
/** Tope de descartes por página: se borran los más viejos. */
export const MAX_DISMISSED_PER_PAGE = 300;

const round = (v: number) => v.toFixed(4);
const center = (r: Rect) => [r.x + r.w / 2, r.y + r.h / 2];

/**
 * Firma de un hallazgo. Vectorial (determinista): página + tipo + textos ordenados + centro
 * redondeado. De IA: sólo identifica el descarte; se reconoce por geometría (IoU), no por firma,
 * porque la IA no lee igual ni encuadra igual en cada análisis.
 */
export function signatureOf(f: Finding): string {
  const [cx, cy] = center(f.boxNorm);
  if (f.source === "vector") {
    const texts = [...f.texts].map((t) => t.trim()).sort().join("|");
    return `vector:${f.page}:${f.severity}:${texts}:${round(cx)},${round(cy)}`;
  }
  return `ia:${f.page}:${f.severity}:${round(cx)},${round(cy)}`;
}

export function iou(a: Rect, b: Rect): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

/** Marca un hallazgo como "Está bien". Devuelve una revisión nueva (no modifica la anterior). */
export function dismiss(review: Review, f: Finding, now = new Date()): Review {
  const page = review[f.page] ?? { descartados: [] };
  const firma = signatureOf(f);
  if (page.descartados.some((d) => d.firma === firma)) return review;
  const entry: Dismissal = { firma, tipo: f.severity, boxNorm: { ...f.boxNorm }, textos: [...f.texts], fecha: now.toISOString() };
  const descartados = [...page.descartados, entry].slice(-MAX_DISMISSED_PER_PAGE);
  return { ...review, [f.page]: { ...page, descartados } };
}

/** Vuelve a mostrar un hallazgo descartado. */
export function restore(review: Review, page: number, firma: string): Review {
  const p = review[page];
  if (!p) return review;
  return { ...review, [page]: { ...p, descartados: p.descartados.filter((d) => d.firma !== firma) } };
}

export type DismissedFinding = Finding & { firma: string };

export type ReviewedPages = {
  /** Resultados con los descartes sacados: es lo que se numera, cuenta, muestra y exporta. */
  pages: PageResult[];
  /** Hallazgos ocultos por la revisión, con la firma del descarte que los ocultó. */
  dismissed: DismissedFinding[];
};

/**
 * Aplica la revisión a los resultados. Vectoriales: por firma exacta. De IA: mismo tipo y página
 * e IoU ≥ IOU_MIN contra la caja guardada; cada descarte oculta como mucho un hallazgo (el de
 * mayor IoU), así un descarte nunca tapa también a un vecino.
 */
export function applyReview(results: PageResult[], review: Review): ReviewedPages {
  const dismissed: DismissedFinding[] = [];
  const pages = results.map((p) => {
    const rules = review[p.page]?.descartados ?? [];
    if (!rules.length || !p.findings.length) return p;
    const hidden = new Map<string, string>(); // id del hallazgo → firma del descarte

    const bySignature = new Map(rules.filter((d) => d.firma.startsWith("vector:")).map((d) => [d.firma, d]));
    for (const f of p.findings) {
      if (f.source !== "vector") continue;
      const sig = signatureOf(f);
      if (bySignature.has(sig)) hidden.set(f.id, sig);
    }

    // IA: pares (descarte, hallazgo) por IoU de mayor a menor, cada uno usado una sola vez.
    const pairs: { d: Dismissal; f: Finding; v: number }[] = [];
    for (const d of rules) {
      if (!d.firma.startsWith("ia:")) continue;
      for (const f of p.findings) {
        if (f.source !== "vision" || f.severity !== d.tipo) continue;
        const v = iou(d.boxNorm, f.boxNorm);
        if (v >= IOU_MIN) pairs.push({ d, f, v });
      }
    }
    pairs.sort((a, b) => b.v - a.v);
    const usedRules = new Set<string>();
    for (const { d, f } of pairs) {
      if (usedRules.has(d.firma) || hidden.has(f.id)) continue;
      usedRules.add(d.firma);
      hidden.set(f.id, d.firma);
    }

    if (!hidden.size) return p;
    for (const f of p.findings) if (hidden.has(f.id)) dismissed.push({ ...f, firma: hidden.get(f.id)! });
    return { ...p, findings: p.findings.filter((f) => !hidden.has(f.id)) };
  });
  return { pages, dismissed };
}

/** Cantidad total de descartes guardados (aplicados o no). */
export const countDismissals = (review: Review) => Object.values(review).reduce((n, p) => n + p.descartados.length, 0);
