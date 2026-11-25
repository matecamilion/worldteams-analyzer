import type { PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import { detectVectorOverlaps } from "./overlap";
import { DEFAULT_OPTIONS, type DetectorOptions, type PageKind, type PageResult } from "./types";
import { buildTextBoxes, type RawTextItem } from "./vector";

export type PageInfo = { kind: PageKind; width: number; height: number; items: RawTextItem[] };

/** Mínimo de caracteres extraíbles para tratar la página como vectorial. */
const MIN_TEXT_CHARS = 20;

export async function inspectPage(page: PDFPageProxy): Promise<PageInfo> {
  // view = [x0, y0, x1, y1]; ignoramos rotación de página (no se usa en planos de prueba, ver README).
  const [x0, y0, x1, y1] = page.view;
  const width = x1 - x0;
  const height = y1 - y0;
  const content = await page.getTextContent();
  const items = (content.items as RawTextItem[]).filter((i) => typeof i.str === "string" && i.str.trim());
  const chars = items.reduce((n, i) => n + i.str.trim().length, 0);
  if (chars >= MIN_TEXT_CHARS) return { kind: "vector", width, height, items };

  const ops = await page.getOperatorList();
  const { OPS } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const hasImage = ops.fnArray.some((fn) => fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject);
  return { kind: hasImage ? "image" : "empty", width, height, items };
}

export function analyzeVector(
  pageNumber: number,
  info: PageInfo,
  options: Partial<DetectorOptions> = {},
): Omit<PageResult, "ms" | "status"> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const boxes = buildTextBoxes(info.items, info.height, opts);
  const findings = detectVectorOverlaps(boxes, { number: pageNumber, width: info.width, height: info.height }, opts);
  return {
    page: pageNumber,
    kind: "vector",
    width: info.width,
    height: info.height,
    textCount: boxes.length,
    findings,
  };
}
