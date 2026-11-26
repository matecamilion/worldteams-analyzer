import type { PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import { detectVectorOverlaps } from "./overlap";
import { DEFAULT_OPTIONS, type DetectorOptions, type PageKind, type PageResult } from "./types";
import { extractOpRuns, splitCombinedItems } from "./runs";
import { buildTextBoxes, type RawTextItem } from "./vector";
import { multiply, type Matrix } from "./pdf";

export type PageInfo = { kind: PageKind; width: number; height: number; items: RawTextItem[] };

/** Mínimo de caracteres extraíbles para tratar la página como vectorial. */
const MIN_TEXT_CHARS = 20;

/**
 * Lleva una matriz de pdfjs (espacio PDF) a la hoja tal como se ve: rotada según /Rotate y con
 * origen en la esquina inferior izquierda de la caja visible (CropBox ∩ MediaBox). Es la matriz
 * de pantalla de pdfjs a escala 1 (origen arriba) seguida de un volteo vertical, así el resto del
 * detector sigue trabajando "en PDF" y las cajas salen en las coordenadas de la pantalla.
 */
export function visibleTransform(page: Pick<PDFPageProxy, "getViewport">): { matrix: Matrix; width: number; height: number } {
  const vp = page.getViewport({ scale: 1 });
  return { matrix: multiply([1, 0, 0, -1, 0, vp.height], vp.transform as Matrix), width: vp.width, height: vp.height };
}

export async function inspectPage(page: PDFPageProxy): Promise<PageInfo> {
  // Tamaño y coordenadas de lo que se ve: con /Rotate 90 el ancho es el alto del PDF.
  const { matrix, width, height } = visibleTransform(page);
  const toVisible = (items: RawTextItem[]) => items.map((i) => ({ ...i, transform: multiply(matrix, i.transform as Matrix) }));
  const content = await page.getTextContent();
  const items = (content.items as RawTextItem[]).filter((i) => typeof i.str === "string" && i.str.trim());
  const chars = items.reduce((n, i) => n + i.str.trim().length, 0);
  if (chars >= MIN_TEXT_CHARS) {
    // pdfjs combina rótulos distintos muy juntos en un solo ítem: se separan desde las operaciones del PDF.
    let split: RawTextItem[] = items;
    try {
      split = splitCombinedItems(items, await extractOpRuns(page));
    } catch {
      // Si la lista de operaciones no se puede leer, se sigue con lo que entregó pdfjs.
    }
    // La separación compara con las operaciones del PDF, así que se hace antes de girar.
    return { kind: "vector", width, height, items: toVisible(split) };
  }

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
