// Geometría plana para cajas de texto orientadas. Coordenadas de página en pt, origen arriba-izquierda.

export type Point = [number, number];
export type Polygon = Point[];
export type Rect = { x: number; y: number; w: number; h: number };

export function polygonArea(poly: Polygon): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}

function signedArea(poly: Polygon): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    s += x1 * y2 - x2 * y1;
  }
  return s / 2;
}

/**
 * Intersección de dos polígonos convexos (Sutherland–Hodgman). Sirve para cajas
 * rotadas en cualquier ángulo, no sólo 0° y 90°.
 */
export function clipConvex(subject: Polygon, clip: Polygon): Polygon {
  // Normalizamos la orientación del recorte a antihoraria para que "adentro" sea a la izquierda.
  const c = signedArea(clip) < 0 ? [...clip].reverse() : clip;
  let output = subject;
  for (let i = 0; i < c.length && output.length; i++) {
    const a = c[i];
    const b = c[(i + 1) % c.length];
    const inside = (p: Point) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= 0;
    const intersect = (p: Point, q: Point): Point => {
      const a1 = b[1] - a[1];
      const b1 = a[0] - b[0];
      const c1 = a1 * a[0] + b1 * a[1];
      const a2 = q[1] - p[1];
      const b2 = p[0] - q[0];
      const c2 = a2 * p[0] + b2 * p[1];
      const det = a1 * b2 - a2 * b1;
      if (Math.abs(det) < 1e-12) return p;
      return [(b2 * c1 - b1 * c2) / det, (a1 * c2 - a2 * c1) / det];
    };
    const input = output;
    output = [];
    for (let j = 0; j < input.length; j++) {
      const cur = input[j];
      const prev = input[(j + input.length - 1) % input.length];
      if (inside(cur)) {
        if (!inside(prev)) output.push(intersect(prev, cur));
        output.push(cur);
      } else if (inside(prev)) {
        output.push(intersect(prev, cur));
      }
    }
  }
  return output;
}

export function boundsOf(points: Point[]): Rect {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

export function unionRect(rects: Rect[]): Rect {
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const x2 = Math.max(...rects.map((r) => r.x + r.w));
  const y2 = Math.max(...rects.map((r) => r.y + r.h));
  return { x, y, w: x2 - x, h: y2 - y };
}

export function rectIntersection(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  if (x2 <= x || y2 <= y) return null;
  return { x, y, w: x2 - x, h: y2 - y };
}

export function iou(a: Rect, b: Rect): number {
  const i = rectIntersection(a, b);
  if (!i) return 0;
  const ia = i.w * i.h;
  return ia / (a.w * a.h + b.w * b.h - ia);
}

export function padRect(r: Rect, p: number): Rect {
  return { x: r.x - p, y: r.y - p, w: r.w + 2 * p, h: r.h + 2 * p };
}

/** Distancia mínima entre dos rectángulos (0 si se tocan o se pisan). */
export function rectGap(a: Rect, b: Rect): number {
  const dx = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w));
  const dy = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h));
  return Math.hypot(dx, dy);
}
