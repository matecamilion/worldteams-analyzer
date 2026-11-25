import type { Rect } from "./geometry";
import type { TextBox } from "./types";

export type Axis = { label: string; at: number };
export type GridAxes = { columns: Axis[]; rows: Axis[] };

/**
 * Busca los ejes del plano: rótulos de una sola letra alineados en una fila (columnas A, B, C…)
 * y de un solo número alineados en una columna (filas 1, 2, 3…). Así la zona se informa como
 * la nombra un arquitecto ("entre ejes B–C / 4–5") y no sólo con coordenadas.
 */
export function findGridAxes(boxes: TextBox[]): GridAxes {
  const center = (b: TextBox) => ({ x: b.bounds.x + b.bounds.w / 2, y: b.bounds.y + b.bounds.h / 2 });
  const letters = boxes.filter((b) => b.angle === 0 && /^[A-Z]$/.test(b.text));
  const numbers = boxes.filter((b) => b.angle === 0 && /^\d{1,2}$/.test(b.text));

  const bestLine = (items: TextBox[], key: "x" | "y") => {
    let best: TextBox[] = [];
    for (const it of items) {
      const c = center(it)[key];
      const line = items.filter((o) => Math.abs(center(o)[key] - c) < 3);
      if (line.length > best.length) best = line;
    }
    return best.length >= 3 ? best : [];
  };

  const columns = bestLine(letters, "y")
    .map((b) => ({ label: b.text, at: center(b).x }))
    .sort((a, b) => a.at - b.at);
  const rows = bestLine(numbers, "x")
    .map((b) => ({ label: b.text, at: center(b).y }))
    .sort((a, b) => a.at - b.at);
  return { columns, rows };
}

function between(axes: Axis[], v: number): string | null {
  if (axes.length < 2) return null;
  if (v < axes[0].at || v > axes[axes.length - 1].at) return null;
  for (let i = 0; i < axes.length - 1; i++) {
    if (v >= axes[i].at && v <= axes[i + 1].at) {
      const [p, q] = [axes[i].label, axes[i + 1].label].sort((a, b) => a.localeCompare(b, "es", { numeric: true }));
      return `${p}–${q}`;
    }
  }
  return null;
}

export function sectorName(box: Rect, page: { width: number; height: number }): string {
  const cx = (box.x + box.w / 2) / page.width;
  const cy = (box.y + box.h / 2) / page.height;
  const v = cy < 1 / 3 ? "superior" : cy < 2 / 3 ? "central" : "inferior";
  const h = cx < 1 / 3 ? "izquierdo" : cx < 2 / 3 ? "central" : "derecho";
  return v === "central" && h === "central" ? "sector central" : `sector ${v} ${h}`;
}

export function describeZone(box: Rect, axes: GridAxes, page: { width: number; height: number }): string {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const col = between(axes.columns, cx);
  const row = between(axes.rows, cy);
  if (col && row) return `entre ejes ${col} / ${row}`;
  if (col) return `ejes ${col}, fuera de las filas · ${sectorName(box, page)}`;
  if (row) return `ejes ${row}, fuera de las columnas · ${sectorName(box, page)}`;
  return sectorName(box, page);
}
