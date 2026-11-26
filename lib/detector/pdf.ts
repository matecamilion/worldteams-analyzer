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
  /**
   * Caja de la imagen en pt de la hoja tal como se ve (origen arriba a la izquierda, ya rotada
   * según /Rotate y relativa a la caja visible). Los píxeles vienen girados para coincidir con lo
   * que se ve: el píxel (0, 0) es la esquina superior izquierda en pantalla.
   */
  placement: { x: number; y: number; w: number; h: number };
};

/** Cómo quedan los ejes de la imagen en pantalla: si se cruzan (x ↔ y) y si se invierten. */
export type Orientation = { swap: boolean; flipX: boolean; flipY: boolean };

/**
 * Orientación a partir de la matriz píxel → pantalla. Con giros de 90° exactos es exacta; con
 * una imagen torcida unos grados se toma el eje dominante (la caja es la envolvente).
 */
export function orientationOf(a: Matrix): Orientation {
  const swap = Math.abs(a[1]) > Math.abs(a[0]);
  // Sin cruce: x de pantalla sale de x de imagen (a[0]) e y de y (a[3]). Con cruce: x de pantalla
  // sale de y de imagen (a[2]) e y de pantalla de x de imagen (a[1]).
  return swap ? { swap, flipX: a[2] < 0, flipY: a[1] < 0 } : { swap, flipX: a[0] < 0, flipY: a[3] < 0 };
}

/** Reordena los píxeles para que la imagen quede derecha en pantalla. Sin cambios, devuelve los mismos datos. */
export function reorient(
  data: Uint8Array,
  width: number,
  height: number,
  channels: number,
  o: Orientation,
): { data: Uint8Array; width: number; height: number } {
  if (!o.swap && !o.flipX && !o.flipY) return { data, width, height };
  const [W, H] = o.swap ? [height, width] : [width, height];
  const out = new Uint8Array(W * H * channels);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // Píxel de origen (i columna, j fila). Con cruce, la x de pantalla recorre las filas de la
      // imagen y la y de pantalla, las columnas.
      const i = o.swap ? (o.flipY ? width - 1 - y : y) : o.flipX ? width - 1 - x : x;
      const j = o.swap ? (o.flipX ? height - 1 - x : x) : o.flipY ? height - 1 - y : y;
      const from = (j * width + i) * channels;
      const to = (y * W + x) * channels;
      for (let c = 0; c < channels; c++) out[to + c] = data[from + c];
    }
  }
  return { data: out, width: W, height: H };
}

/**
 * Devuelve la imagen más grande pintada en la página, derecha y ubicada como se ve en pantalla.
 * Recorre el operator list siguiendo la matriz de transformación (save/restore/transform), porque
 * una imagen se dibuja en el cuadrado unidad escalado por la CTM; después compone esa CTM con la
 * matriz de pantalla de pdfjs (/Rotate y origen de la caja visible).
 */
export async function extractLargestImage(page: PDFPageProxy): Promise<PageImage | null> {
  const ops = await page.getOperatorList();
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
  // Píxel → cuadrado unidad (la fila 0 de la imagen es la de arriba, v = 1) → PDF → pantalla.
  const pixelToUnit: Matrix = [1 / img.width, 0, 0, -1 / img.height, 0, 1];
  const toScreen = multiply(multiply(page.getViewport({ scale: 1 }).transform as Matrix, best.ctm), pixelToUnit);
  const pts = [
    [0, 0],
    [img.width, 0],
    [0, img.height],
    [img.width, img.height],
  ].map(([u, v]) => [toScreen[0] * u + toScreen[2] * v + toScreen[4], toScreen[1] * u + toScreen[3] * v + toScreen[5]]);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  const upright = reorient(img.data, img.width, img.height, channels, orientationOf(toScreen));

  return {
    width: upright.width,
    height: upright.height,
    channels,
    data: upright.data,
    placement: { x: x0, y: y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0 },
  };
}
