import { test } from "node:test";
import assert from "node:assert/strict";

// localStorage mínimo en memoria, con cupo para probar el desalojo.
class MemoryStorage {
  map = new Map<string, string>();
  constructor(private readonly quota = Infinity) {}
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) {
    const used = [...this.map].reduce((n, [a, b]) => n + a.length + b.length, 0) - (this.map.get(k)?.length ?? 0);
    if (used + k.length + v.length > this.quota) throw new Error("QuotaExceededError");
    this.map.set(k, v);
  }
  removeItem(k: string) { this.map.delete(k); }
}

import type { PageResult } from "../lib/detector/types";

const page = (n: number, kind: "image" | "vector" = "image", status: "ok" | "no_verificada" = "ok"): PageResult => ({
  page: n,
  kind,
  width: 1,
  height: 1,
  textCount: 0,
  findings: [],
  status,
  ms: 1,
});

test("guarda y recupera sólo páginas escaneadas verificadas, por hash y página", async () => {
  (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
  const { getCachedPage, putCachedPage, forgetCachedPage, hashPdf } = await import("../lib/client/cache");
  const h1 = await hashPdf(new TextEncoder().encode("%PDF-uno").buffer as ArrayBuffer);
  const h2 = await hashPdf(new TextEncoder().encode("%PDF-dos").buffer as ArrayBuffer);
  assert.notEqual(h1, h2);
  putCachedPage(h1, 6, page(6));
  putCachedPage(h1, 2, page(2, "vector"));
  putCachedPage(h1, 3, page(3, "image", "no_verificada"));
  assert.equal(getCachedPage(h1, 6)?.result.page, 6);
  assert.equal(getCachedPage(h1, 2), null, "vectorial: no se guarda");
  assert.equal(getCachedPage(h1, 3), null, "no verificada: no se guarda");
  assert.equal(getCachedPage(h2, 6), null, "otro PDF: no comparte");
  forgetCachedPage(h1, 6);
  assert.equal(getCachedPage(h1, 6), null);
});

test("si el almacenamiento se llena, desaloja lo más viejo en vez de fallar", async () => {
  (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage(1200);
  const { getCachedPage, putCachedPage } = await import("../lib/client/cache");
  for (let n = 1; n <= 10; n++) putCachedPage("h", n, page(n));
  assert.ok(getCachedPage("h", 10), "la última queda guardada");
  assert.equal(getCachedPage("h", 1), null, "la primera se desalojó");
});
