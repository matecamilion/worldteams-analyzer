import { boundsOf, type Point } from "./geometry";
import type { DetectorOptions, TextBox } from "./types";

/** Lo mínimo que necesitamos de un item de `getTextContent()` de pdfjs. */
export type RawTextItem = {
  str: string;
  transform: number[];
  width: number;
  /** Bloque BT…ET de origen, cuando se separó desde las operaciones del PDF (runs.ts). */
  block?: number;
};

type Run = {
  text: string;
  /** Origen de la línea base en espacio de página con origen arriba-izquierda. */
  ox: number;
  oy: number;
  /** Vector unitario de avance y "arriba", ya invertidos en y. */
  ux: number;
  uy: number;
  vx: number;
  vy: number;
  length: number;
  fontSize: number;
  angle: number;
  block?: number;
};

function toRun(item: RawTextItem, pageHeight: number): Run | null {
  const [a, b, c, d, e, f] = item.transform;
  const scaleX = Math.hypot(a, b);
  const fontSize = Math.hypot(c, d);
  if (!item.str.trim() || scaleX === 0 || fontSize === 0) return null;
  // pdfjs entrega la matriz en espacio PDF (y hacia arriba); pasamos a pantalla (y hacia abajo).
  const ux = a / scaleX;
  const uy = -b / scaleX;
  // "Arriba" del texto: perpendicular al avance, girado 90° antihorario en espacio PDF.
  const vx = -b / scaleX;
  const vy = -a / scaleX;
  return {
    text: item.str,
    ox: e,
    oy: pageHeight - f,
    ux,
    uy,
    vx,
    vy,
    length: item.width,
    fontSize,
    angle: Math.round((Math.atan2(b, a) * 180) / Math.PI),
    block: item.block,
  };
}

/**
 * Une los tramos que pdfjs parte en una misma línea (por kerning o cambios de estilo):
 * mismo ángulo, mismo cuerpo, misma línea base y el segundo empieza donde termina el primero.
 * Sin esto, un texto "chocaría consigo mismo".
 */
function mergeRuns(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const r of runs) {
    const prev = out[out.length - 1];
    // Textos de bloques BT…ET distintos son rótulos distintos aunque estén pegados: no se unen.
    const otherBlock = prev?.block !== undefined && r.block !== undefined && prev.block !== r.block;
    if (prev && !otherBlock && prev.angle === r.angle && Math.abs(prev.fontSize - r.fontSize) < 0.05 * r.fontSize) {
      // Proyección del origen de r sobre el sistema de prev.
      const dx = r.ox - prev.ox;
      const dy = r.oy - prev.oy;
      const along = dx * prev.ux + dy * prev.uy;
      const across = dx * prev.vx + dy * prev.vy;
      const startGap = along - prev.length;
      if (Math.abs(across) < 0.1 * r.fontSize && startGap > -0.15 * r.fontSize && startGap < 0.6 * r.fontSize) {
        prev.text += (startGap > 0.15 * r.fontSize ? " " : "") + r.text;
        prev.length = along + r.length;
        continue;
      }
    }
    out.push({ ...r });
  }
  return out;
}

export function buildTextBoxes(items: RawTextItem[], pageHeight: number, opts: DetectorOptions): TextBox[] {
  const runs = mergeRuns(items.map((i) => toRun(i, pageHeight)).filter((r): r is Run => r !== null));
  return runs.map((r, id) => {
    const asc = opts.ascent * r.fontSize;
    const desc = opts.descent * r.fontSize;
    const corner = (s: number, t: number): Point => [r.ox + r.ux * s + r.vx * t, r.oy + r.uy * s + r.vy * t];
    const poly = [corner(0, -desc), corner(r.length, -desc), corner(r.length, asc), corner(0, asc)];
    return {
      id,
      text: r.text.trim(),
      poly,
      bounds: boundsOf(poly),
      fontSize: r.fontSize,
      angle: r.angle,
    };
  });
}
