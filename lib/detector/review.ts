// Revisión del usuario sobre los hallazgos: lo que marcó como "Está bien" (descartado) y los
// errores que marcó a mano con un recuadro.
// Puro y sin DOM: lo usan la pantalla, el PDF con marcas y los tests. No cambia los resultados
// del análisis (ni la caché): se aplica encima, cada vez que se muestran o exportan.
import type { Rect } from "./geometry";
import { ORIGIN_LABEL, type Finding, type PageResult, type Severity } from "./types";
import { sectorName } from "./zones";

/** Un hallazgo que la persona marcó como "Está bien". `firma` empieza con "vector:" o "ia:". */
export type Dismissal = { firma: string; tipo: Severity; boxNorm: Rect; textos: string[]; fecha: string };
/** Un error marcado a mano: `box` en pt de la página visible (origen arriba-izquierda), como los demás. */
export type ManualMark = { id: string; box: Rect; boxNorm: Rect; nota?: string; fecha: string };
export type PageReview = { descartados: Dismissal[]; manuales?: ManualMark[] };
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
/** Tope de marcas a mano por página y largo máximo de la nota. */
export const MAX_MANUAL_PER_PAGE = 200;
export const MAX_NOTE = 200;

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
  if (f.source === "manual") return review; // una marca a mano se borra, no se descarta
  const page = review[f.page] ?? { descartados: [] };
  const firma = signatureOf(f);
  const previous = page.descartados ?? [];
  if (previous.some((d) => d.firma === firma)) return review;
  const entry: Dismissal = { firma, tipo: f.severity, boxNorm: { ...f.boxNorm }, textos: [...f.texts], fecha: now.toISOString() };
  const descartados = [...previous, entry].slice(-MAX_DISMISSED_PER_PAGE);
  return { ...review, [f.page]: { ...page, descartados } };
}

/** Vuelve a mostrar un hallazgo descartado. */
export function restore(review: Review, page: number, firma: string): Review {
  const p = review[page];
  if (!p) return review;
  return { ...review, [page]: { ...p, descartados: (p.descartados ?? []).filter((d) => d.firma !== firma) } };
}

const emptyPage = (): PageReview => ({ descartados: [] });
const manualId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** Id del hallazgo que se muestra para una marca a mano. */
export const manualFindingId = (page: number, markId: string) => `p${page}-manual-${markId}`;

/** Agrega un error marcado a mano. `box` en pt y `page` = tamaño de la hoja en pt (ya rotada). */
export function addManual(
  review: Review,
  pageNumber: number,
  box: Rect,
  page: { w: number; h: number },
  opts: { id?: string; nota?: string; now?: Date } = {},
): { review: Review; findingId: string } {
  const id = opts.id ?? manualId();
  const p = review[pageNumber] ?? emptyPage();
  const nota = opts.nota?.trim().slice(0, MAX_NOTE);
  const mark: ManualMark = {
    id,
    box: { ...box },
    boxNorm: { x: box.x / page.w, y: box.y / page.h, w: box.w / page.w, h: box.h / page.h },
    ...(nota ? { nota } : {}),
    fecha: (opts.now ?? new Date()).toISOString(),
  };
  const manuales = [...(p.manuales ?? []), mark].slice(-MAX_MANUAL_PER_PAGE);
  return { review: { ...review, [pageNumber]: { ...p, manuales } }, findingId: manualFindingId(pageNumber, id) };
}

/** Borra una marca a mano. */
export function removeManual(review: Review, pageNumber: number, markId: string): Review {
  const p = review[pageNumber];
  if (!p?.manuales?.some((m) => m.id === markId)) return review;
  return { ...review, [pageNumber]: { ...p, manuales: p.manuales.filter((m) => m.id !== markId) } };
}

/** Cambia la nota de una marca a mano (vacía: sin nota). */
export function setManualNote(review: Review, pageNumber: number, markId: string, nota: string): Review {
  const p = review[pageNumber];
  const clean = nota.trim().slice(0, MAX_NOTE);
  if (!p?.manuales?.some((m) => m.id === markId && (m.nota ?? "") !== clean)) return review;
  const manuales = p.manuales.map((m) => {
    if (m.id !== markId) return m;
    const { nota: _old, ...rest } = m; // eslint-disable-line @typescript-eslint/no-unused-vars
    return clean ? { ...rest, nota: clean } : rest;
  });
  return { ...review, [pageNumber]: { ...p, manuales } };
}

/** La marca a mano como hallazgo: un choque, con la caja que dibujó la persona. */
function manualFinding(pageNumber: number, m: ManualMark, page: { width: number; height: number }): Finding {
  return {
    id: manualFindingId(pageNumber, m.id),
    page: pageNumber,
    severity: "choque",
    box: { ...m.box },
    boxNorm: { ...m.boxNorm },
    texts: [],
    zone: page.width > 0 && page.height > 0 ? sectorName(m.box, page) : "marcado en la hoja",
    confidence: 1,
    source: "manual",
    originLabel: ORIGIN_LABEL.manual,
    ...(m.nota ? { note: m.nota } : {}),
  };
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
  const pages = results.map((r) => {
    const manuales = review[r.page]?.manuales ?? [];
    // Las marcas a mano se suman a los hallazgos de la página; nunca se ocultan con un descarte.
    const p = manuales.length ? { ...r, findings: [...r.findings, ...manuales.map((m) => manualFinding(r.page, m, r))] } : r;
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
export const countDismissals = (review: Review) => Object.values(review).reduce((n, p) => n + (p.descartados?.length ?? 0), 0);

/** La revisión no tiene nada (para no guardar claves vacías). */
export const isEmptyReview = (review: Review) =>
  Object.values(review).every((p) => !p.descartados?.length && !p.manuales?.length);
