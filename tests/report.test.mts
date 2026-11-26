import { test } from "node:test";
import assert from "node:assert/strict";
import { numberFindings, summarize } from "../lib/detector/report";
import type { Finding, PageResult } from "../lib/detector/types";

const f = (page: number, severity: Finding["severity"], y: number, texts: string[]): Finding => ({
  id: `${page}-${y}`,
  page,
  severity,
  box: { x: 10, y, w: 20, h: 8 },
  boxNorm: { x: 0, y: 0, w: 0, h: 0 },
  texts,
  zone: "entre ejes A–B / 1–2",
  confidence: 0.95,
  source: "vector",
  originLabel: "Texto del PDF",
});
const page = (n: number, findings: Finding[], status: PageResult["status"] = "ok"): PageResult => ({
  page: n, kind: "vector", width: 1190, height: 842, textCount: 10, findings, status, ms: 1,
  ...(status === "no_verificada" ? { error: "Falló la IA" } : {}),
});

test("numera por página, choques primero", () => {
  const n = numberFindings([page(2, [f(2, "choque", 50, ["C"])]), page(1, [f(1, "cercania", 10, ["A"]), f(1, "choque", 90, ["B"])])]);
  assert.deepEqual(n.map((x) => [x.page, x.texts[0], x.n]), [[1, "B", 1], [1, "A", 2], [2, "C", 3]]);
});

test("el resumen cuenta por tipo y no omite páginas no verificadas", () => {
  assert.deepEqual(summarize([page(1, [f(1, "choque", 1, [])]), page(2, [], "no_verificada")]), { choques: 1, cercanias: 0, duplicados: 0, noVerificadas: 1 });
});
