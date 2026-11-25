import sharp from "sharp";
import type { PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import { rectIntersection, unionRect, type Rect } from "./geometry";
import { extractLargestImage } from "./pdf";
import { planTiles, touchesInnerEdge, type Tile } from "./tiles";
import { ORIGIN_LABEL, type Finding, type PageResult } from "./types";
import { sectorName } from "./zones";
import { VisionError, type VisionBox, type VisionProvider, type VisionUsage } from "../vision/provider";
import { REFINE_PROMPT } from "../vision/prompt";
import { snapToInk, toGray } from "./ink";

/** Una pasada de visión: la imagen cortada en mosaicos de un tamaño dado. */
export type VisionPass = { name: string; tileSize: number; overlap: number };

export const TILES_PASS: VisionPass = { name: "mosaicos", tileSize: 1400, overlap: 250 };
/** tileSize enorme = un solo mosaico con la página entera. */
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
   * Ajuste a tinta: toma la caja del modelo como pista y la ajusta al renglón de texto real
   * (el de más tinta que toca la caja). Medido offline sobre 18 corridas: IoU medio 0,40 → 0,92.
   */
  inkSnap: boolean;
};

// La pasada de página entera está disponible pero apagada por defecto: en 5 corridas medidas
// (bench/*-ambas-dos-pasadas-*) no rescató ningún choque y agregó 4 marcas de más. Ver README.
export const DEFAULT_IMAGE_OPTIONS: ImageOptions = {
  passes: [TILES_PASS],
  mergeTolerancePt: 25,
  edgeMargin: 6,
  minConfidence: 0.5,
  concurrency: 8,
  retries: 2,
  jpegQuality: 88,
  // Apagado: en 5 corridas medidas el ajuste a tinta solo logra lo mismo sin llamadas extra.
  refine: false,
  refineMarginPt: 40,
  refineUpscale: 2,
  inkSnap: true,
};

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

export type ImagePageResult = PageResult & {
  usage: VisionUsage & { calls: number };
  tiles: number;
};

async function withRetries<T>(fn: () => Promise<T>, retries: number): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
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
  const [x0, y0, x1, y1] = page.view;
  const pageSize = { width: x1 - x0, height: y1 - y0 };
  const base = {
    page: pageNumber,
    kind: "image" as const,
    ...pageSize,
    textCount: 0,
    findings: [] as Finding[],
    usage: { inputTokens: 0, outputTokens: 0, calls: 0 },
    tiles: 0,
  };

  const img = await extractLargestImage(page);
  if (!img) {
    return { ...base, status: "no_verificada", error: "No se pudo extraer la imagen de la página.", ms: Date.now() - started };
  }

  const source = sharp(Buffer.from(img.data), {
    raw: { width: img.width, height: img.height, channels: img.channels },
  });
  // Todas las llamadas de todas las pasadas salen juntas: la página tarda lo que tarda el mosaico más lento.
  const jobs = opts.passes.flatMap((pass) =>
    planTiles(img.width, img.height, pass.tileSize, pass.overlap).map((tile) => ({ pass, tile })),
  );

  const results = await mapLimit(jobs, opts.concurrency, async ({ pass, tile }: { pass: VisionPass; tile: Tile }) => {
    const data = await source
      .clone()
      .extract({ left: tile.x, top: tile.y, width: tile.w, height: tile.h })
      .jpeg({ quality: opts.jpegQuality })
      .toBuffer();
    try {
      const r = await withRetries(
        () => provider.detectOverlaps({ data, mime: "image/jpeg", width: tile.w, height: tile.h }),
        opts.retries,
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
    if (r.error) {
      errors.push(`${r.pass.name}#${r.tile.index}: ${r.error}`);
      continue;
    }
    for (const b of r.boxes) {
      if (b.confidence < opts.minConfidence) continue;
      // Mosaico normalizado → px de imagen.
      const px = { x: r.tile.x + b.x * r.tile.w, y: r.tile.y + b.y * r.tile.h, w: b.w * r.tile.w, h: b.h * r.tile.h };
      if (touchesInnerEdge(px, r.tile, img, opts.edgeMargin)) continue;
      // px de imagen → pt de página según dónde está pintada la imagen. No enderezamos:
      // la caja se dibuja sobre la misma imagen, torcida como esté.
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
        if (!snapped) return c;
        return {
          ...c,
          box: { x: img.placement.x + snapped.x * sx, y: img.placement.y + snapped.y * sy, w: snapped.w * sx, h: snapped.h * sy },
          modelBox: c.box,
          inkSnapped: true,
        };
      }),
      opts.mergeTolerancePt,
    );
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
      ? failed === jobs.length
        ? `No se pudo analizar la página: ${errors[0]}`
        : `Fallaron ${failed} de ${jobs.length} llamadas; el resultado es parcial.`
      : undefined,
    notes: opts.passes.map((p) => `pasada ${p.name}: mosaicos de ~${Math.min(p.tileSize, Math.max(img.width, img.height))}px, solape ${p.overlap}px`),
    ms: Date.now() - started,
  };
}
