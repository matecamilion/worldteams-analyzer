import { test } from "node:test";
import assert from "node:assert/strict";
import { clampView, fullView, interpolate, translation, viewForBox, zoomAround, MIN_FOCUS_ZOOM } from "../lib/client/zoom";

const page = { w: 1190, h: 842 };
const frame = { w: 1000, h: (1000 * 842) / 1190 };

test("la caja enfocada ocupa ~1/3 del ancho visible y queda centrada", () => {
  const box = { x: 534, y: 470, w: 91, h: 10 };
  const v = viewForBox(box, page);
  const { k, tx, ty } = translation(v, page, frame);
  const left = tx + box.x * k * v.s;
  const width = box.w * k * v.s;
  assert.ok(Math.abs(width / frame.w - 1 / 3) < 0.01);
  assert.ok(Math.abs(left + width / 2 - frame.w / 2) < 1);
  assert.ok(Math.abs(ty + (box.y + box.h / 2) * k * v.s - frame.h / 2) < 1);
});

test("una caja grande igual recibe el zoom mínimo", () => {
  assert.equal(viewForBox({ x: 100, y: 100, w: 900, h: 30 }, page).s, MIN_FOCUS_ZOOM);
});

test("una caja en el borde no muestra fuera de la hoja", () => {
  const v = viewForBox({ x: 2, y: 2, w: 20, h: 8 }, page);
  const { tx, ty } = translation(v, page, frame);
  assert.ok(tx <= 0.001 && ty <= 0.001);
});

test("el pellizco deja fijo el punto entre los dedos", () => {
  const v0 = clampView({ cx: 500, cy: 400, s: 3 }, page);
  const m = { x: 300, y: 200 };
  const before = translation(v0, page, frame);
  const pt = { x: (m.x - before.tx) / (before.k * v0.s), y: (m.y - before.ty) / (before.k * v0.s) };
  const v1 = zoomAround(v0, 1.5, m, page, frame);
  const after = translation(v1, page, frame);
  assert.ok(Math.abs(after.tx + pt.x * after.k * v1.s - m.x) < 0.5);
  assert.ok(Math.abs(after.ty + pt.y * after.k * v1.s - m.y) < 0.5);
});

test("la animación empieza y termina exacto", () => {
  const a = fullView(page);
  const b = { cx: 300, cy: 200, s: 6 };
  assert.deepEqual(interpolate(a, b, 0), a);
  const end = interpolate(a, b, 1);
  assert.ok(Math.abs(end.s - 6) < 1e-9 && Math.abs(end.cx - 300) < 1e-9);
});
