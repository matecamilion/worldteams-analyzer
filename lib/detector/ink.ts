// Ajuste de una caja aproximada a la tinta real del renglón (procesamiento de imagen clásico).
// El modelo de visión ubica bien "dónde" hay un choque pero sus cajas tienen error aleatorio
// (±9 pt medido) y suelen abarcar varios renglones. Acá se toma esa caja como pista y se busca
// el renglón de texto real: determinista, sin costo de API.

export type Gray = { data: Uint8Array; width: number; height: number };
export type PxBox = { x: number; y: number; w: number; h: number };

export type SnapOptions = {
  /** Gris por debajo del cual un píxel es tinta (0 negro, 255 blanco). */
  threshold: number;
  /** Margen de búsqueda alrededor de la caja, en px. */
  searchPx: number;
  /** Separación máxima entre letras/palabras de un mismo texto, relativa al alto del renglón. */
  gapFactor: number;
  /**
   * Cómo elegir el renglón: "cercano" al centro de la caja, o "pesado" (más tinta) entre los que
   * tocan la caja. Dos textos encimados suman tinta y el rótulo principal va en negrita.
   */
  pick: "cercano" | "pesado";
};

export const DEFAULT_SNAP: SnapOptions = { threshold: 110, searchPx: 40, gapFactor: 1.2, pick: "pesado" };

export function toGray(data: Uint8Array, width: number, height: number, channels: number): Gray {
  if (channels === 1) return { data, width, height };
  const out = new Uint8Array(width * height);
  for (let i = 0, j = 0; i < out.length; i++, j += channels) {
    out[i] = (data[j] * 77 + data[j + 1] * 150 + data[j + 2] * 29) >> 8;
  }
  return { data: out, width, height };
}

/**
 * Devuelve la caja de tinta del renglón más cercano al centro de `box`, o null si no hay texto
 * reconocible cerca. Ignora líneas del dibujo: filas casi llenas (líneas horizontales) y columnas
 * que siguen oscuras por encima y por debajo del renglón (paredes, ejes).
 */
export function snapToInk(img: Gray, box: PxBox, opts: SnapOptions = DEFAULT_SNAP): PxBox | null {
  const x0 = Math.max(0, Math.floor(box.x - opts.searchPx));
  const x1 = Math.min(img.width, Math.ceil(box.x + box.w + opts.searchPx));
  const y0 = Math.max(0, Math.floor(box.y - opts.searchPx));
  const y1 = Math.min(img.height, Math.ceil(box.y + box.h + opts.searchPx));
  const W = x1 - x0;
  const H = y1 - y0;
  if (W <= 0 || H <= 0) return null;
  const dark = (x: number, y: number) => img.data[y * img.width + x] < opts.threshold;

  // Columnas que son líneas verticales: oscuras en casi todo el alto de la ventana.
  const lineCol = new Uint8Array(W);
  for (let i = 0; i < W; i++) {
    let n = 0;
    for (let y = y0; y < y1; y++) if (dark(x0 + i, y)) n++;
    lineCol[i] = n > H * 0.6 ? 1 : 0;
  }
  // Perfil de filas sobre el ancho de la caja (sin columnas-línea), y filas-línea horizontales.
  const bx0 = Math.max(x0, Math.floor(box.x));
  const bx1 = Math.min(x1, Math.ceil(box.x + box.w));
  const rowInk = new Array<number>(H).fill(0);
  for (let j = 0; j < H; j++) {
    let n = 0;
    let wide = 0;
    for (let i = 0; i < W; i++) {
      if (lineCol[i] || !dark(x0 + i, y0 + j)) continue;
      wide++;
      if (x0 + i >= bx0 && x0 + i < bx1) n++;
    }
    rowInk[j] = wide > W * 0.7 ? 0 : n; // línea horizontal: no es texto
  }
  // Renglones = tramos de filas con tinta; elegimos el más cercano al centro de la caja.
  const bands: [number, number][] = [];
  let start = -1;
  for (let j = 0; j <= H; j++) {
    const on = j < H && rowInk[j] > 1;
    if (on && start < 0) start = j;
    if (!on && start >= 0) {
      if (j - start >= 3) bands.push([start, j]);
      start = -1;
    }
  }
  if (!bands.length) return null;
  const cy = box.y + box.h / 2 - y0;
  const near = (b: [number, number]) => Math.abs((b[0] + b[1]) / 2 - cy);
  const ink = (b: [number, number]) => rowInk.slice(b[0], b[1]).reduce((s, v) => s + v, 0);
  let chosen: [number, number];
  if (opts.pick === "pesado") {
    // Sólo renglones "de rótulo": al menos 60 % del alto del más alto de la zona. Así una caja
    // que cayó sobre el renglón fino de m² o NPT no se ajusta a él.
    const tall = Math.max(...bands.map((b) => b[1] - b[0]));
    const eligible = bands.filter((b) => b[1] - b[0] >= 0.6 * tall);
    // De los que tocan la caja del modelo, el de más tinta; si ninguno la toca, el más cercano.
    const by0 = box.y - y0 - 4;
    const by1 = box.y + box.h - y0 + 4;
    const touching = eligible.filter((b) => b[1] > by0 && b[0] < by1);
    chosen = touching.length ? touching.sort((a, b) => ink(b) - ink(a))[0] : [...eligible].sort((a, b) => near(a) - near(b))[0];
  } else {
    chosen = [...bands].sort((a, b) => near(a) - near(b))[0];
  }
  const [ry0, ry1] = chosen;
  const bandH = ry1 - ry0;

  // Columnas con tinta dentro del renglón; extendemos desde el centro mientras los huecos sean de letra.
  const colInk = new Uint8Array(W);
  for (let i = 0; i < W; i++) {
    if (lineCol[i]) continue;
    for (let j = ry0; j < ry1; j++) if (dark(x0 + i, y0 + j)) { colInk[i] = 1; break; }
  }
  const maxGap = Math.max(3, Math.round(bandH * opts.gapFactor));
  const cx = Math.round(box.x + box.w / 2 - x0);
  // Punto de partida: la columna con tinta más cercana al centro.
  let seed = -1;
  for (let d = 0; d < W && seed < 0; d++) {
    if (cx - d >= 0 && colInk[cx - d]) seed = cx - d;
    else if (cx + d < W && colInk[cx + d]) seed = cx + d;
  }
  if (seed < 0) return null;
  let left = seed;
  let right = seed;
  for (let i = seed, gap = 0; i >= 0; i--) {
    if (colInk[i]) { left = i; gap = 0; } else if (++gap > maxGap || lineCol[i]) break;
  }
  for (let i = seed, gap = 0; i < W; i++) {
    if (colInk[i]) { right = i; gap = 0; } else if (++gap > maxGap || lineCol[i]) break;
  }
  return { x: x0 + left, y: y0 + ry0, w: right - left + 1, h: bandH };
}
