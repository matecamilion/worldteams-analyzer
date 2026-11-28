// Revisión del usuario sobre los hallazgos. La herramienta propone y la persona decide: cada
// hallazgo está "por revisar" hasta que lo marca como confirmado (es un choque real) o como falsa
// alarma (la herramienta o la IA se equivocó). También guarda los errores que la persona agrega a
// mano. Puro y sin DOM: lo usan la pantalla, el PDF y los tests. No cambia los resultados del
// análisis (ni la caché): se aplica encima, cada vez que se muestran o exportan.
import type { Rect } from "./geometry";
import { ORIGIN_LABEL, type Finding, type PageResult, type Severity } from "./types";
import { sectorName } from "./zones";

export type ReviewState = "por_revisar" | "confirmado" | "falsa_alarma";

/** Lo que decidió la persona sobre un hallazgo. `firma` empieza con "vector:" o "ia:". */
export type Decision = {
  firma: string;
  tipo: Severity;
  boxNorm: Rect;
  textos: string[];
  fecha: string;
  estado: Exclude<ReviewState, "por_revisar">;
};
/** Un error agregado a mano: `box` en pt de la página visible (origen arriba-izquierda), como los demás. */
export type ManualMark = { id: string; box: Rect; boxNorm: Rect; nota?: string; fecha: string };
export type PageReview = { decisiones: Decision[]; manuales?: ManualMark[] };
/** Revisión de un PDF, por número de página. */
export type Review = Record<number, PageReview>;

/**
 * IoU mínimo para reconocer un hallazgo de IA ya revisado en otro análisis de la misma página.
 * Calibrado con 9 corridas guardadas en bench/ (10 páginas escaneadas, 1456 pares del mismo
 * hallazgo entre corridas): con 0,3–0,6 se reconoce el 99,7 %; con 0,7 baja a 98,8 %. Dos
 * hallazgos distintos de una misma corrida nunca se superponen (IoU máximo 0 en 201 pares).
 * Se eligió el más estricto antes de que empiece a perder: 0,6.
 */
export const IOU_MIN = 0.6;
/** Tope de decisiones por página: se borran las más viejas. */
export const MAX_DECISIONS_PER_PAGE = 300;
/** Tope de marcas a mano por página y largo máximo de la nota. */
export const MAX_MANUAL_PER_PAGE = 200;
export const MAX_NOTE = 200;

const round = (v: number) => v.toFixed(4);
const center = (r: Rect) => [r.x + r.w / 2, r.y + r.h / 2];

/**
 * Firma de un hallazgo. Vectorial (determinista): página + tipo + textos ordenados + centro
 * redondeado. De IA: sólo identifica la decisión; se reconoce por geometría (IoU), no por firma,
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

/** Estado de un hallazgo tal como sale de applyReview (las falsas alarmas van aparte). */
export const stateOf = (f: Pick<Finding, "reviewState">): ReviewState => f.reviewState ?? "por_revisar";

/**
 * Cambia el estado de un hallazgo: confirmado, falsa alarma o de vuelta a por revisar. Reemplaza
 * la decisión anterior sobre ese mismo hallazgo (la que lo reconoció, `reviewFirma`). Devuelve una
 * revisión nueva (no modifica la anterior), o la misma si no cambia nada. Las marcas a mano no se
 * revisan: nacen confirmadas y se borran.
 */
export function decide(review: Review, f: Finding, estado: ReviewState, now = new Date()): Review {
  if (f.source === "manual") return review;
  const page = review[f.page] ?? emptyPage();
  const firma = signatureOf(f);
  const previous = page.decisiones ?? [];
  const current = previous.find((d) => d.firma === (f.reviewFirma ?? firma));
  if ((current?.estado ?? "por_revisar") === estado) return review;
  const rest = previous.filter((d) => d.firma !== f.reviewFirma && d.firma !== firma);
  const decisiones =
    estado === "por_revisar"
      ? rest
      : [...rest, { firma, tipo: f.severity, boxNorm: { ...f.boxNorm }, textos: [...f.texts], fecha: now.toISOString(), estado }].slice(
          -MAX_DECISIONS_PER_PAGE,
        );
  return { ...review, [f.page]: { ...page, decisiones } };
}

const emptyPage = (): PageReview => ({ decisiones: [] });
const manualId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** Id del hallazgo que se muestra para una marca a mano. */
export const manualFindingId = (page: number, markId: string) => `p${page}-manual-${markId}`;

/** Agrega un error que no vio la herramienta. `box` en pt y `page` = tamaño de la hoja en pt (ya rotada). */
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

/** La marca a mano como hallazgo: un choque ya confirmado, con la caja que dibujó la persona. */
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
    reviewState: "confirmado",
    ...(m.nota ? { note: m.nota } : {}),
  };
}

export type ReviewCounts = {
  /** Todo lo que se revisa: confirmados + falsas alarmas + por revisar (incluye lo agregado a mano). */
  total: number;
  revisados: number;
  confirmados: number;
  falsasAlarmas: number;
  porRevisar: number;
};

export type ReviewedPages = {
  /** Resultados sin las falsas alarmas y con el estado de cada hallazgo: es lo que se numera, cuenta, muestra y exporta. */
  pages: PageResult[];
  /** Hallazgos que la persona marcó como falsa alarma (con `reviewFirma`), para poder volver atrás. */
  falseAlarms: Finding[];
  counts: ReviewCounts;
};

/**
 * Aplica la revisión a los resultados. Reconoce cada decisión en el análisis actual —vectoriales
 * por firma exacta; de IA por mismo tipo y página e IoU ≥ IOU_MIN, con cada decisión aplicada a
 * un solo hallazgo (el de mayor IoU), así nunca alcanza también a un vecino—. Saca las falsas
 * alarmas y marca el resto como confirmado o por revisar.
 */
export function applyReview(results: PageResult[], review: Review): ReviewedPages {
  const falseAlarms: Finding[] = [];
  const counts: ReviewCounts = { total: 0, revisados: 0, confirmados: 0, falsasAlarmas: 0, porRevisar: 0 };
  const pages = results.map((r) => {
    const pr = review[r.page];
    const decisions = pr?.decisiones ?? [];
    const matched = new Map<string, Decision>(); // id del hallazgo → decisión

    const bySignature = new Map(decisions.filter((d) => d.firma.startsWith("vector:")).map((d) => [d.firma, d]));
    for (const f of r.findings) {
      if (f.source !== "vector") continue;
      const d = bySignature.get(signatureOf(f));
      if (d) matched.set(f.id, d);
    }
    // IA: pares (decisión, hallazgo) por IoU de mayor a menor, cada uno usado una sola vez.
    const pairs: { d: Decision; f: Finding; v: number }[] = [];
    for (const d of decisions) {
      if (!d.firma.startsWith("ia:")) continue;
      for (const f of r.findings) {
        if (f.source !== "vision" || f.severity !== d.tipo) continue;
        const v = iou(d.boxNorm, f.boxNorm);
        if (v >= IOU_MIN) pairs.push({ d, f, v });
      }
    }
    pairs.sort((a, b) => b.v - a.v);
    const used = new Set<string>();
    for (const { d, f } of pairs) {
      if (used.has(d.firma) || matched.has(f.id)) continue;
      used.add(d.firma);
      matched.set(f.id, d);
    }

    const shown: Finding[] = [];
    for (const f of r.findings) {
      const d = matched.get(f.id);
      if (d?.estado === "falsa_alarma") {
        falseAlarms.push({ ...f, reviewFirma: d.firma });
        counts.falsasAlarmas++;
        continue;
      }
      shown.push(d ? { ...f, reviewState: "confirmado", reviewFirma: d.firma } : { ...f, reviewState: "por_revisar" });
      if (d) counts.confirmados++;
      else counts.porRevisar++;
    }
    // Lo agregado a mano se suma confirmado: lo marcó la persona.
    for (const m of pr?.manuales ?? []) {
      shown.push(manualFinding(r.page, m, r));
      counts.confirmados++;
    }
    return { ...r, findings: shown };
  });
  counts.revisados = counts.confirmados + counts.falsasAlarmas;
  counts.total = counts.revisados + counts.porRevisar;
  return { pages, falseAlarms, counts };
}

/** La revisión no tiene nada (para no guardar claves vacías). */
export const isEmptyReview = (review: Review) => Object.values(review).every((p) => !p.decisiones?.length && !p.manuales?.length);

/**
 * Pasa una revisión guardada al formato actual sin perder nada. El formato anterior sólo tenía
 * `descartados` ("Está bien"): cada uno pasa a ser una falsa alarma. Lo que no se entiende se ignora.
 */
export function migrateReview(raw: unknown): Review {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Review = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const page = Number(key);
    if (!Number.isInteger(page) || page < 1 || !value || typeof value !== "object") continue;
    const v = value as { decisiones?: unknown; descartados?: unknown; manuales?: unknown };
    const isEntry = (d: unknown): d is Omit<Decision, "estado"> =>
      !!d && typeof d === "object" && typeof (d as Decision).firma === "string" && typeof (d as Decision).boxNorm === "object";
    const decisiones: Decision[] = Array.isArray(v.decisiones)
      ? v.decisiones.filter((d): d is Decision => isEntry(d) && ((d as Decision).estado === "confirmado" || (d as Decision).estado === "falsa_alarma"))
      : [];
    const known = new Set(decisiones.map((d) => d.firma));
    if (Array.isArray(v.descartados)) {
      for (const d of v.descartados) {
        if (isEntry(d) && !known.has(d.firma)) decisiones.push({ ...d, estado: "falsa_alarma" });
      }
    }
    const manuales = Array.isArray(v.manuales) ? (v.manuales as ManualMark[]).filter((m) => m && typeof m.id === "string" && m.box && m.boxNorm) : [];
    if (decisiones.length || manuales.length) out[page] = { decisiones, ...(manuales.length ? { manuales } : {}) };
  }
  return out;
}

/**
 * Modo guiado: el próximo hallazgo por revisar después de `fromId`, en el orden de la lista
 * (la numeración), dando la vuelta al final. `skip` se saltea aunque figure por revisar (el que
 * se acaba de decidir, porque su estado nuevo todavía no está aplicado). Null si no queda ninguno.
 */
export function nextToReview<T extends Pick<Finding, "id" | "reviewState">>(list: T[], fromId: string | null, skip?: string): T | null {
  const start = fromId === null ? -1 : list.findIndex((f) => f.id === fromId);
  for (let k = 1; k <= list.length; k++) {
    const f = list[(start + k + list.length) % list.length];
    if (f.id !== skip && stateOf(f) === "por_revisar") return f;
  }
  return null;
}
