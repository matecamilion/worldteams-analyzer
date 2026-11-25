import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";

export type Matrix = [number, number, number, number, number, number];

export async function loadPdf(data: Uint8Array): Promise<PDFDocumentProxy> {
  return pdfjs.getDocument({
    data,
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0,
  }).promise;
}

export function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export type PageImage = {
  width: number;
  height: number;
  channels: 1 | 3 | 4;
  data: Uint8Array;
  /** Caja de la imagen en coordenadas de página con origen arriba a la izquierda (pt). */
  placement: { x: number; y: number; w: number; h: number };
};

/**
 * Devuelve la imagen más grande pintada en la página, con su ubicación. Recorre el
 * operator list siguiendo la matriz de transformación (save/restore/transform), porque
 * una imagen se dibuja en el cuadrado unidad escalado por la CTM.
 */
export async function extractLargestImage(page: PDFPageProxy): Promise<PageImage | null> {
  const ops = await page.getOperatorList();
  const [, , , pageTop] = page.view;
  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  const stack: Matrix[] = [];
  let best: { name: string; area: number; ctm: Matrix } | null = null;

  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i];
    if (fn === pdfjs.OPS.save) stack.push(ctm);
    else if (fn === pdfjs.OPS.restore) ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    else if (fn === pdfjs.OPS.transform) ctm = multiply(ctm, args as Matrix);
    else if (fn === pdfjs.OPS.paintImageXObject) {
      const area = Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]);
      if (!best || area > best.area) best = { name: args[0] as string, area, ctm };
    }
  }
  if (!best) return null;

  const objs = best.name.startsWith("g_") ? page.commonObjs : page.objs;
  const img = await new Promise<{ width: number; height: number; data?: Uint8Array; kind: number }>(
    (resolve) => objs.get(best!.name, resolve as (v: unknown) => void),
  );
  if (!img?.data) return null;

  const channels = (img.data.length / (img.width * img.height)) as 1 | 3 | 4;
  // Esquinas del cuadrado unidad transformadas → caja en espacio PDF (origen abajo).
  const pts = [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ].map(([u, v]) => [best!.ctm[0] * u + best!.ctm[2] * v + best!.ctm[4], best!.ctm[1] * u + best!.ctm[3] * v + best!.ctm[5]]);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs);
  const y1 = Math.max(...ys);

  return {
    width: img.width,
    height: img.height,
    channels,
    data: img.data,
    placement: { x: x0, y: pageTop - y1, w: Math.max(...xs) - x0, h: y1 - Math.min(...ys) },
  };
}
