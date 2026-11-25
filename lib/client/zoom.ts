// Matemática del visor con zoom, sin DOM (se testea aparte).
// Una vista es el punto de la página (pt) que queda en el centro del marco y un factor de zoom
// relativo a "página entera" (s = 1). Así la vista no depende del tamaño del marco.

export type View = { cx: number; cy: number; s: number };
export type Size = { w: number; h: number };
export type Box = { x: number; y: number; w: number; h: number };

export const MIN_FOCUS_ZOOM = 2;
export const MAX_ZOOM = 10;

export const fullView = (page: Size): View => ({ cx: page.w / 2, cy: page.h / 2, s: 1 });

/** Mantiene la vista dentro de la hoja: nunca se ve "afuera" del papel. */
export function clampView(v: View, page: Size): View {
  const s = Math.min(MAX_ZOOM, Math.max(1, v.s));
  const hw = page.w / (2 * s);
  const hh = page.h / (2 * s);
  return {
    s,
    cx: Math.min(page.w - hw, Math.max(hw, v.cx)),
    cy: Math.min(page.h - hh, Math.max(hh, v.cy)),
  };
}

/**
 * Vista que centra la caja de un hallazgo: la caja ocupa ~1/3 del ancho visible, con un
 * zoom mínimo para que se lea, y sin que su alto pase de la mitad del alto visible.
 */
export function viewForBox(box: Box, page: Size): View {
  const byWidth = page.w / (3 * Math.max(box.w, 1));
  const byHeight = page.h / (2 * Math.max(box.h, 1));
  const s = Math.max(MIN_FOCUS_ZOOM, Math.min(MAX_ZOOM, byWidth, byHeight));
  return clampView({ cx: box.x + box.w / 2, cy: box.y + box.h / 2, s }, page);
}

/** Traslación en px de pantalla para dibujar la capa: pantalla = t + punto × k × s. */
export function translation(v: View, page: Size, frame: Size) {
  const k = frame.w / page.w;
  return { k, tx: frame.w / 2 - v.cx * k * v.s, ty: frame.h / 2 - v.cy * k * v.s };
}

/** Zoom alrededor de un punto de pantalla (pellizco, ctrl+rueda): ese punto queda fijo. */
export function zoomAround(v: View, factor: number, screen: { x: number; y: number }, page: Size, frame: Size): View {
  const k = frame.w / page.w;
  const px = v.cx + (screen.x - frame.w / 2) / (k * v.s);
  const py = v.cy + (screen.y - frame.h / 2) / (k * v.s);
  const s = Math.min(MAX_ZOOM, Math.max(1, v.s * factor));
  return clampView({ s, cx: px - (screen.x - frame.w / 2) / (k * s), cy: py - (screen.y - frame.h / 2) / (k * s) }, page);
}

export function panBy(v: View, dx: number, dy: number, page: Size, frame: Size): View {
  const k = frame.w / page.w;
  return clampView({ s: v.s, cx: v.cx - dx / (k * v.s), cy: v.cy - dy / (k * v.s) }, page);
}

export const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** Interpola el zoom en escala logarítmica (se percibe parejo) y el centro en línea recta. */
export function interpolate(a: View, b: View, t: number): View {
  const e = easeInOutCubic(t);
  return {
    cx: a.cx + (b.cx - a.cx) * e,
    cy: a.cy + (b.cy - a.cy) * e,
    s: Math.exp(Math.log(a.s) + (Math.log(b.s) - Math.log(a.s)) * e),
  };
}

export const sameView = (a: View, b: View) =>
  Math.abs(a.cx - b.cx) < 0.01 && Math.abs(a.cy - b.cy) < 0.01 && Math.abs(a.s - b.s) < 0.0001;
