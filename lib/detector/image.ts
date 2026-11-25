import sharp from "sharp";
import type { PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import { rectIntersection, unionRect, type Rect } from "./geometry";
import { extractLargestImage } from "./pdf";
import { planTiles, touchesInnerEdge, type Tile } from "./tiles";
import type { Finding, PageResult } from "./types";
import { sectorName } from "./zones";
import { VisionError, type VisionBox, type VisionProvider, type VisionUsage } from "../vision/provider";

export type ImageOptions = {
  tileSize: number;
  overlap: number;
  /** Descarta cajas pegadas a un borde interno del mosaico (px). */
  edgeMargin: number;
  /** Confianza mínima para informar. */
  minConfidence: number;
  concurrency: number;
  retries: number;
  jpegQuality: number;
};

export const DEFAULT_IMAGE_OPTIONS: ImageOptions = {
  tileSize: 1400,
  overlap: 250,
  edgeMargin: 6,
  minConfidence: 0.5,
  concurrency: 4,
  retries: 2,
  jpegQuality: 88,
};

type Candidate = { box: Rect; texts: string[]; confidence: number; tiles: number[] };

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
      await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
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

/**
 * Une candidatos de distintos mosaicos que señalan el mismo lugar. Compara por posición
 * (no por texto): dos choques distintos pueden compartir palabras, como dos "BAÑO".
 */
export function mergeCandidates(cands: Candidate[]): Candidate[] {
  const merged: Candidate[] = [];
  for (const c of [...cands].sort((a, b) => b.confidence - a.confidence)) {
    const twin = merged.find((m) => {
      const i = rectIntersection(m.box, c.box);
      if (!i) return false;
      const minArea = Math.min(m.box.w * m.box.h, c.box.w * c.box.h);
      return (i.w * i.h) / minArea > 0.3;
    });
    if (twin) {
      twin.box = unionRect([twin.box, c.box]);
      twin.tiles.push(...c.tiles);
      twin.confidence = Math.max(twin.confidence, c.confidence);
      if (twin.texts.length < c.texts.length) twin.texts = c.texts;
    } else {
      merged.push({ ...c, tiles: [...c.tiles] });
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
    return {
      ...base,
      status: "no_verificada",
      error: "No se pudo extraer la imagen de la página.",
      ms: Date.now() - started,
    };
  }

  const source = sharp(Buffer.from(img.data), {
    raw: { width: img.width, height: img.height, channels: img.channels },
  });
  const tiles = planTiles(img.width, img.height, opts.tileSize, opts.overlap);
  const failed: number[] = [];
  const candidates: Candidate[] = [];

  const perTile = await mapLimit(tiles, opts.concurrency, async (tile: Tile) => {
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
      return { tile, ...r, error: null as string | null };
    } catch (e) {
      return { tile, boxes: [] as VisionBox[], usage: { inputTokens: 0, outputTokens: 0 }, raw: "", error: String(e) };
    }
  });

  const errors: string[] = [];
  for (const r of perTile) {
    base.usage.calls++;
    base.usage.inputTokens += r.usage.inputTokens;
    base.usage.outputTokens += r.usage.outputTokens;
    if (r.error) {
      failed.push(r.tile.index);
      errors.push(r.error);
      continue;
    }
    for (const b of r.boxes) {
      if (b.confidence < opts.minConfidence) continue;
      // Mosaico normalizado → px de imagen.
      const px = { x: r.tile.x + b.x * r.tile.w, y: r.tile.y + b.y * r.tile.h, w: b.w * r.tile.w, h: b.h * r.tile.h };
      if (touchesInnerEdge(px, r.tile, img, opts.edgeMargin)) continue;
      // px de imagen → pt de página, usando dónde está pintada la imagen. No enderezamos:
      // la caja se dibuja sobre la misma imagen, torcida como esté.
      const sx = img.placement.w / img.width;
      const sy = img.placement.h / img.height;
      candidates.push({
        box: { x: img.placement.x + px.x * sx, y: img.placement.y + px.y * sy, w: px.w * sx, h: px.h * sy },
        texts: b.texts,
        confidence: b.confidence,
        tiles: [r.tile.index],
      });
    }
  }

  const findings: Finding[] = mergeCandidates(candidates).map((c, i) => ({
    id: `p${pageNumber}-vision-${i + 1}`,
    page: pageNumber,
    severity: "choque",
    box: c.box,
    boxNorm: {
      x: c.box.x / pageSize.width,
      y: c.box.y / pageSize.height,
      w: c.box.w / pageSize.width,
      h: c.box.h / pageSize.height,
    },
    texts: c.texts,
    zone: sectorName(c.box, pageSize),
    // Un mismo choque visto por más de un mosaico es más creíble.
    confidence: Number(Math.min(0.95, c.confidence + (new Set(c.tiles).size > 1 ? 0.05 : 0)).toFixed(2)),
    source: "vision",
    provider: `${provider.name}:${provider.model}`,
  }));

  const allFailed = failed.length === tiles.length;
  return {
    ...base,
    tiles: tiles.length,
    findings,
    status: failed.length ? "no_verificada" : "ok",
    error: failed.length
      ? allFailed
        ? `No se pudo analizar la página: ${errors[0]}`
        : `Fallaron ${failed.length} de ${tiles.length} mosaicos; el resultado es parcial.`
      : undefined,
    notes: [`${tiles.length} mosaicos de ~${opts.tileSize}px con ${opts.overlap}px de solape`],
    ms: Date.now() - started,
  };
}
