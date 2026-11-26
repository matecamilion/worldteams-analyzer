import sharp from "sharp";
import type { PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import { rectIntersection, unionRect, type Rect } from "./geometry";
import { extractLargestImage } from "./pdf";
import { planTiles, touchesInnerEdge, type Tile } from "./tiles";
import { LOW_RES_WARNING, ORIGIN_LABEL, type Finding, type PageResult } from "./types";
import { sectorName } from "./zones";
import { CALL_TIMEOUT_MS, RETRY_TIMEOUT_MS, VisionError, type VisionBox, type VisionProvider, type VisionUsage } from "../vision/provider";
import { REFINE_PROMPT } from "../vision/prompt";
import { countTextBlobs, snapToInk, toGray } from "./ink";

/** Una pasada de visión: la imagen cortada en mosaicos de un tamaño dado. */
export type VisionPass = { name: string; tileSize: number; overlap: number; extraPerAxis?: number };

export const TILES_PASS: VisionPass = { name: "mosaicos", tileSize: 1400, overlap: 250 };
/** tileSize enorme = un solo mosaico con la página entera. */
/**
 * Segunda mirada independiente con la grilla corrida: un mosaico más por eje, así las uniones
 * caen en otro lugar y el modelo ve cada rótulo con otro encuadre. Sirve para recuperar choques
 * que la primera pasada pierde al azar.
 */
export const SHIFTED_PASS: VisionPass = { name: "corrida", tileSize: 1400, overlap: 250, extraPerAxis: 1 };

export const WHOLE_PAGE_PASS: VisionPass = { name: "pagina", tileSize: 100_000, overlap: 0 };

export type ImageOptions = {
  passes: VisionPass[];
  /** Dos candidatos son el mismo choque si sus centros están a menos de esto (pt) o se pisan. */
  mergeTolerancePt: number;
  /** Descarta cajas pegadas a un borde interno del mosaico (px). */
  edgeMargin: number;
  /** Confianza mínima para informar. */
  minConfidence: number;
  /** Llamadas simultáneas al proveedor (todas las de la página caben en una tanda). */
  concurrency: number;
  retries: number;
  /**
   * Pasado este tiempo desde el inicio de la página no se empieza ningún intento nuevo. Con el
   * corte de 20 s por llamada, la página termina en ~80 s como máximo (maxDuration de la ruta: 120 s).
   */
  deadlineMs: number;
  /**
   * Reintento tras un corte por tiempo: plazo `retryTimeoutMs` en vez del de siempre, pero ninguna
   * llamada pasa de `hardStopMs` desde el inicio de la página (maxDuration de la ruta: 120 s). Si
   * quedan menos de `minCallMs` hasta ese tope, no se reintenta.
   */
  retryTimeoutMs: number;
  hardStopMs: number;
  minCallMs: number;
  jpegQuality: number;
  /**
   * Segunda mirada por choque: recorte de la imagen original con `refineMarginPt` de margen,
   * ampliado ×`refineUpscale`, para ajustar la caja. El error de ubicación de la primera pasada
   * es aleatorio (±9 pt, medido), así que no se corrige con un desplazamiento fijo.
   */
  refine: boolean;
  refineMarginPt: number;
  refineUpscale: number;
  /**
   * No mandar a la IA mosaicos sin texto: se saltea un mosaico sin ninguna mancha con alto de
   * letra; en las pasadas secundarias también con 1–2 (la primera pasada ya cubre toda la página).
   */
  skipBlankTiles: boolean;
  /**
   * Ajuste a tinta: toma la caja del modelo como pista y la ajusta al renglón de texto real
   * (el de más tinta que toca la caja). Medido offline sobre 18 corridas: IoU medio 0,40 → 0,92.
   */
  inkSnap: boolean;
  /**
   * Páginas de baja resolución: por debajo de `lowResPpi` (px de imagen por pulgada de hoja) se
   * amplía la imagen hacia `targetPpi` antes de partirla en mosaicos, así la IA ve letras de alto
   * parecido al de las muestras que funcionan y el ajuste a tinta (calibrado en px) no abarca de
   * más. Topes de costo: ampliación de hasta ×`maxUpscale` y no más de `maxTiles` mosaicos por
   * página entre todas las pasadas (si una página ya tenía más sin ampliar, no se amplía).
   */
  lowResPpi: number;
  targetPpi: number;
  maxUpscale: number;
  maxTiles: number;
};

// La pasada de página entera está disponible pero apagada por defecto: en 5 corridas medidas
// (bench/*-ambas-dos-pasadas-*) no rescató ningún choque y agregó 4 marcas de más. Ver README.
export const DEFAULT_IMAGE_OPTIONS: ImageOptions = {
  // La grilla corrida suma recuperación de choques perdidos al azar (medido: 25/30 → 35/39).
  passes: [TILES_PASS, SHIFTED_PASS],
  mergeTolerancePt: 25,
  edgeMargin: 6,
  minConfidence: 0.5,
  // Tope de llamadas simultáneas por página (medido: con 6 el tiempo no empeora frente a 16).
  concurrency: 6,
  retries: 2,
  deadlineMs: 60_000,
  retryTimeoutMs: RETRY_TIMEOUT_MS,
  hardStopMs: 95_000,
  minCallMs: 10_000,
  jpegQuality: 88,
  // Apagado: en 5 corridas medidas el ajuste a tinta solo logra lo mismo sin llamadas extra.
  refine: false,
  refineMarginPt: 40,
  refineUpscale: 2,
  inkSnap: true,
  // Medido en 3 corridas × 3 páginas escaneadas: misma calidad (69/69), 1 llamada menos por página.
  skipBlankTiles: true,
  // Medido (scripts/diag-resolucion.mts): el plano real a 102 ppi (rótulos de ~9 px, cotas de ~6 px)
  // falla; el mismo a 204 ppi (rótulos de ~18 px) anda. Las muestras que andan van de 150 a 204 ppi.
  lowResPpi: 140,
  targetPpi: 200,
  maxUpscale: 2.5,
  maxTiles: 16,
};

/** Mosaicos que planifican todas las pasadas para una imagen de ese tamaño. */
const countJobs = (passes: VisionPass[], width: number, height: number) =>
  passes.reduce((n, p) => n + planTiles(width, height, p.tileSize, p.overlap, p.extraPerAxis).length, 0);

/**
 * Factor de ampliación para una imagen de `ppi` px por pulgada de hoja: 1 si la resolución
 * alcanza; si no, hacia `targetPpi`, con tope de factor y de mosaicos por página.
 */
export function upscaleFactor(
  ppi: number,
  width: number,
  height: number,
  opts: Pick<ImageOptions, "passes" | "lowResPpi" | "targetPpi" | "maxUpscale" | "maxTiles">,
): number {
  if (!(ppi > 0) || ppi >= opts.lowResPpi) return 1;
  const cap = Math.max(opts.maxTiles, countJobs(opts.passes, width, height));
  let f = Math.min(opts.maxUpscale, opts.targetPpi / ppi);
  while (f > 1 && countJobs(opts.passes, Math.round(width * f), Math.round(height * f)) > cap) f -= 0.05;
  return Math.max(1, Number(f.toFixed(2)));
}

export type Candidate = {
  box: Rect;
  texts: string[];
  confidence: number;
  tiles: string[];
  passes: string[];
  refinement?: "ajustada" | "sin_confirmar" | "error";
  inkSnapped?: boolean;
  modelBox?: Rect;
};

export type PassStats = {
  /** Mosaicos que planificó la pasada. */
  tiles: number;
  /** Mosaicos que no se mandaron (casi vacíos). */
  skipped: number;
  /** Llamadas HTTP reales a la API, reintentos incluidos. */
  apiCalls: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
};

export type ImagePageResult = PageResult & {
  usage: VisionUsage & { calls: number };
  tiles: number;
  byPass?: Record<string, PassStats>;
};

async function withRetries<T>(fn: (lastError: unknown) => Promise<T>, retries: number, deadline = Infinity): Promise<T> {
  let last: unknown = new VisionError("Se agotó el tiempo de la página", false);
  let previous: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    // Sin tiempo para otro intento completo: mejor "no verificada" que un corte de la función.
    if (Date.now() > deadline) break;
    try {
      return await fn(previous);
    } catch (e) {
      last = previous = e;
      if (e instanceof VisionError && !e.retryable) break;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
    }
  }
  throw last;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

const center = (r: Rect) => [r.x + r.w / 2, r.y + r.h / 2];

/**
 * Une candidatos de distintos mosaicos y pasadas que señalan el mismo lugar. Compara por
 * posición, nunca por texto: dos choques distintos pueden compartir palabras (dos "BAÑO").
 */
const words = (texts: string[]) =>
  new Set(
    texts
      .join(" ")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toUpperCase()
      .split(/[^A-Z0-9]+/)
      .filter((w) => w.length >= 3),
  );

/**
 * Une hallazgos que nombran los mismos textos y están cerca: es el mismo choque visto desde dos
 * mosaicos con ubicaciones distintas. Se queda con el ajustado a tinta y, entre iguales, el de más confianza.
 */
export function dedupeByText(cands: Candidate[], radiusPt: number): Candidate[] {
  const rank = (c: Candidate) => (c.inkSnapped ? 1 : 0) * 10 + c.confidence;
  const sorted = [...cands].sort((a, b) => rank(b) - rank(a));
  const kept: Candidate[] = [];
  for (const c of sorted) {
    const wc = words(c.texts);
    const cx = c.box.x + c.box.w / 2;
    const cy = c.box.y + c.box.h / 2;
    const twin = kept.find((k) => {
      const shared = [...words(k.texts)].filter((w) => wc.has(w)).length;
      return shared >= 1 && Math.hypot(k.box.x + k.box.w / 2 - cx, k.box.y + k.box.h / 2 - cy) <= radiusPt;
    });
    if (twin) twin.passes = [...new Set([...twin.passes, ...c.passes])];
    else kept.push({ ...c, passes: [...c.passes] });
  }
  return kept;
}

export function mergeCandidates(cands: Candidate[], tolerancePt = 25): Candidate[] {
  const merged: Candidate[] = [];
  for (const c of [...cands].sort((a, b) => b.confidence - a.confidence)) {
    const twin = merged.find((m) => {
      const [mx, my] = center(m.box);
      const [cx, cy] = center(c.box);
      if (Math.hypot(mx - cx, my - cy) <= tolerancePt) return true;
      const i = rectIntersection(m.box, c.box);
      if (!i) return false;
      return (i.w * i.h) / Math.min(m.box.w * m.box.h, c.box.w * c.box.h) > 0.3;
    });
    if (twin) {
      // Conservamos la caja del candidato más confiable (el primero, por el orden) y
      // sólo la ampliamos si el otro es de la misma pasada (un texto cortado entre mosaicos).
      if (twin.passes.every((p) => c.passes.includes(p))) twin.box = unionRect([twin.box, c.box]);
      twin.tiles.push(...c.tiles);
      twin.passes = [...new Set([...twin.passes, ...c.passes])];
      if (twin.texts.length < c.texts.length) twin.texts = c.texts;
    } else {
      merged.push({ ...c, tiles: [...c.tiles], passes: [...c.passes] });
    }
  }
  return merged;
}

export async function analyzeImagePage(
  pageNumber: number,
  page: PDFPageProxy,
  provider: VisionProvider,
  options: Partial<ImageOptions> = {},
): Promise<ImagePageResult> {
  const opts = { ...DEFAULT_IMAGE_OPTIONS, ...options };
  const started = Date.now();
  const deadline = started + opts.deadlineMs;
  const hardStop = started + opts.hardStopMs;
  // Tamaño de la hoja como se ve (con /Rotate 90 el ancho es el alto del PDF).
  const viewport = page.getViewport({ scale: 1 });
  const pageSize = { width: viewport.width, height: viewport.height };
  const base = {
    page: pageNumber,
    kind: "image" as const,
    ...pageSize,
    textCount: 0,
    findings: [] as Finding[],
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, calls: 0 },
    tiles: 0,
    byPass: {} as Record<string, PassStats>,
  };
  const stats = (name: string) =>
    (base.byPass[name] ??= { tiles: 0, skipped: 0, apiCalls: 0, failed: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 });

  const extracted = await extractLargestImage(page);
  if (!extracted) {
    return { ...base, status: "no_verificada", error: "No se pudo extraer la imagen de la página.", ms: Date.now() - started };
  }
  // Resolución efectiva: px de imagen por pulgada de hoja, en el eje más pobre.
  const ppi = Math.min(extracted.width / extracted.placement.w, extracted.height / extracted.placement.h) * 72;
  const factor = upscaleFactor(ppi, extracted.width, extracted.height, opts);
  let img = extracted;
  if (factor > 1) {
    const width = Math.round(extracted.width * factor);
    const height = Math.round(extracted.height * factor);
    const { data, info } = await sharp(Buffer.from(extracted.data), {
      raw: { width: extracted.width, height: extracted.height, channels: extracted.channels },
    })
      .resize(width, height, { kernel: "lanczos3" })
      .raw()
      .toBuffer({ resolveWithObject: true });
    img = { ...extracted, data: new Uint8Array(data.buffer, data.byteOffset, data.length), width, height, channels: info.channels as typeof extracted.channels };
  }
  const lowResolution = ppi < opts.lowResPpi ? { ppi: Math.round(ppi), upscale: factor } : undefined;

  const source = sharp(Buffer.from(img.data), {
    raw: { width: img.width, height: img.height, channels: img.channels },
  });
  // Todas las llamadas de todas las pasadas salen juntas: la página tarda lo que tarda el mosaico más lento.
  const jobs = opts.passes.flatMap((pass) =>
    planTiles(img.width, img.height, pass.tileSize, pass.overlap, pass.extraPerAxis).map((tile) => ({ pass, tile })),
  );

  for (const j of jobs) stats(j.pass.name).tiles++;

  let toSend = jobs;
  if (opts.skipBlankTiles) {
    const gray = toGray(img.data, img.width, img.height, img.channels);
    const primary = opts.passes[0]?.name;
    toSend = jobs.filter(({ pass, tile }) => {
      const blobs = countTextBlobs(gray, tile);
      const skip = blobs === 0 || (pass.name !== primary && blobs <= 2);
      if (skip) stats(pass.name).skipped++;
      return !skip;
    });
  }

  const results = await mapLimit(toSend, opts.concurrency, async ({ pass, tile }: { pass: VisionPass; tile: Tile }) => {
    const data = await source
      .clone()
      .extract({ left: tile.x, top: tile.y, width: tile.w, height: tile.h })
      .jpeg({ quality: opts.jpegQuality })
      .toBuffer();
    try {
      const r = await withRetries(
        (previous) => {
          // Tras un corte por tiempo, el modelo suele estar razonando de más, no colgado: el
          // reintento espera más, sin pasarse del tope duro de la página.
          const left = hardStop - Date.now();
          // Por la propiedad y no por instanceof: el error puede venir de otra copia del módulo.
          const timedOut = (previous as { timedOut?: unknown } | null)?.timedOut === true;
          const timeoutMs = timedOut ? Math.min(opts.retryTimeoutMs, left) : left < CALL_TIMEOUT_MS ? left : undefined;
          if (timeoutMs !== undefined && timeoutMs < opts.minCallMs) throw new VisionError("Se agotó el tiempo de la página", false, true);
          stats(pass.name).apiCalls++;
          return provider.detectOverlaps({ data, mime: "image/jpeg", width: tile.w, height: tile.h }, undefined, { timeoutMs });
        },
        opts.retries,
        deadline,
      );
      return { pass, tile, ...r, error: null as string | null };
    } catch (e) {
      return { pass, tile, boxes: [] as VisionBox[], usage: { inputTokens: 0, outputTokens: 0 }, raw: "", error: String(e) };
    }
  });

  const errors: string[] = [];
  const candidates: Candidate[] = [];
  const sx = img.placement.w / img.width;
  const sy = img.placement.h / img.height;
  for (const r of results) {
    base.usage.calls++;
    base.usage.inputTokens += r.usage.inputTokens;
    base.usage.outputTokens += r.usage.outputTokens;
    base.usage.cachedInputTokens += r.usage.cachedInputTokens ?? 0;
    base.usage.reasoningTokens += r.usage.reasoningTokens ?? 0;
    const st = stats(r.pass.name);
    st.inputTokens += r.usage.inputTokens;
    st.outputTokens += r.usage.outputTokens;
    st.cachedInputTokens += r.usage.cachedInputTokens ?? 0;
    st.reasoningTokens += r.usage.reasoningTokens ?? 0;
    if (r.error) {
      st.failed++;
      errors.push(`${r.pass.name}#${r.tile.index}: ${r.error}`);
      continue;
    }
    for (const b of r.boxes) {
      if (b.confidence < opts.minConfidence) continue;
      // Mosaico normalizado → px de imagen.
      const px = { x: r.tile.x + b.x * r.tile.w, y: r.tile.y + b.y * r.tile.h, w: b.w * r.tile.w, h: b.h * r.tile.h };
      if (touchesInnerEdge(px, r.tile, img, opts.edgeMargin)) continue;
      // px de imagen → pt de la hoja según dónde se ve la imagen (ya girada como en pantalla).
      // No enderezamos una imagen torcida unos grados: la caja se dibuja sobre ella tal cual.
      candidates.push({
        box: { x: img.placement.x + px.x * sx, y: img.placement.y + px.y * sy, w: px.w * sx, h: px.h * sy },
        texts: b.texts,
        confidence: b.confidence,
        tiles: [`${r.pass.name}#${r.tile.index}`],
        passes: [r.pass.name],
      });
    }
  }

  let merged = mergeCandidates(candidates, opts.mergeTolerancePt);

  if (opts.refine && merged.length) {
    const ptPerPx = { x: sx, y: sy };
    const refined = await mapLimit(merged, opts.concurrency, async (c): Promise<Candidate> => {
      const m = opts.refineMarginPt;
      const left = Math.max(0, Math.floor((c.box.x - m - img.placement.x) / ptPerPx.x));
      const top = Math.max(0, Math.floor((c.box.y - m - img.placement.y) / ptPerPx.y));
      const right = Math.min(img.width, Math.ceil((c.box.x + c.box.w + m - img.placement.x) / ptPerPx.x));
      const bottom = Math.min(img.height, Math.ceil((c.box.y + c.box.h + m - img.placement.y) / ptPerPx.y));
      const w = right - left;
      const h = bottom - top;
      const data = await source
        .clone()
        .extract({ left, top, width: w, height: h })
        .resize({ width: w * opts.refineUpscale, height: h * opts.refineUpscale, kernel: "lanczos3" })
        .jpeg({ quality: 92 })
        .toBuffer();
      try {
        const r = await withRetries(
          () =>
            provider.detectOverlaps(
              { data, mime: "image/jpeg", width: w * opts.refineUpscale, height: h * opts.refineUpscale },
              REFINE_PROMPT,
            ),
          opts.retries,
          deadline,
        );
        base.usage.calls++;
        base.usage.inputTokens += r.usage.inputTokens;
        base.usage.outputTokens += r.usage.outputTokens;
        // De lo que devuelva, nos quedamos con la caja más cercana al choque original.
        const ocx = (c.box.x + c.box.w / 2 - img.placement.x) / ptPerPx.x;
        const ocy = (c.box.y + c.box.h / 2 - img.placement.y) / ptPerPx.y;
        const toPt = (b: VisionBox): Rect => ({
          x: img.placement.x + (left + b.x * w) * ptPerPx.x,
          y: img.placement.y + (top + b.y * h) * ptPerPx.y,
          w: b.w * w * ptPerPx.x,
          h: b.h * h * ptPerPx.y,
        });
        const best = r.boxes
          .map((b) => ({ b, d: Math.hypot(left + (b.x + b.w / 2) * w - ocx, top + (b.y + b.h / 2) * h - ocy) }))
          .sort((a, b) => a.d - b.d)[0];
        if (!best) return { ...c, confidence: c.confidence * 0.8, refinement: "sin_confirmar" };
        return {
          ...c,
          box: toPt(best.b),
          texts: best.b.texts.length >= c.texts.length ? best.b.texts : c.texts,
          confidence: Math.max(c.confidence, best.b.confidence),
          refinement: "ajustada",
        };
      } catch {
        base.usage.calls++;
        return { ...c, refinement: "error" };
      }
    });
    // Dos candidatos pueden haber convergido al mismo choque al ajustarse.
    merged = mergeCandidates(refined, opts.mergeTolerancePt);
  }

  if (opts.inkSnap && merged.length) {
    const gray = toGray(img.data, img.width, img.height, img.channels);
    merged = mergeCandidates(
      merged.map((c) => {
        const px = { x: (c.box.x - img.placement.x) / sx, y: (c.box.y - img.placement.y) / sy, w: c.box.w / sx, h: c.box.h / sy };
        const snapped = snapToInk(gray, px);
        // Un renglón de rótulo mide al menos ~4 pt de alto y ~12 pt de ancho; menos es ruido.
        if (!snapped || snapped.h * sy < 4 || snapped.w * sx < 12) return c;
        return {
          ...c,
          box: { x: img.placement.x + snapped.x * sx, y: img.placement.y + snapped.y * sy, w: snapped.w * sx, h: snapped.h * sy },
          modelBox: c.box,
          inkSnapped: true,
        };
      }),
      opts.mergeTolerancePt,
    );
    // Lo que sólo vio una pasada secundaria y no encaja en ningún renglón de texto no se informa:
    // la pasada secundaria está para recuperar choques, no para sumar dudas.
    const primary = opts.passes[0]?.name;
    merged = merged.filter((c) => c.inkSnapped || c.passes.includes(primary));
    merged = dedupeByText(merged, 60);
  }

  const findings: Finding[] = merged.map((c, i) => ({
    id: `p${pageNumber}-ia-${i + 1}`,
    page: pageNumber,
    severity: "choque",
    box: c.box,
    boxNorm: { x: c.box.x / pageSize.width, y: c.box.y / pageSize.height, w: c.box.w / pageSize.width, h: c.box.h / pageSize.height },
    texts: c.texts,
    zone: sectorName(c.box, pageSize),
    // Visto por las dos pasadas → más creíble.
    confidence: Number(Math.min(0.97, c.confidence + (c.passes.length > 1 ? 0.05 : 0)).toFixed(2)),
    source: "vision",
    originLabel: ORIGIN_LABEL.vision,
    provider: `${provider.name}:${provider.model}`,
    passes: c.passes,
    refinement: c.refinement,
    inkSnapped: c.inkSnapped,
    modelBox: c.modelBox,
  }));

  const failed = errors.length;
  return {
    ...base,
    tiles: jobs.length,
    findings,
    status: failed ? "no_verificada" : "ok",
    error: failed
      ? failed === toSend.length
        ? `No se pudo analizar la página: ${errors[0]}`
        : `Fallaron ${failed} de ${toSend.length} llamadas; el resultado es parcial.`
      : undefined,
    lowResolution,
    notes: [
      ...(lowResolution ? [`${LOW_RES_WARNING} (${lowResolution.ppi} ppi; imagen ampliada ×${factor} antes de los mosaicos)`] : []),
      ...opts.passes.map((p) => `pasada ${p.name}: mosaicos de ~${Math.min(p.tileSize, Math.max(img.width, img.height))}px, solape ${p.overlap}px`),
      ...errors.map((e) => `falló ${e}`),
    ],
    ms: Date.now() - started,
  };
}
