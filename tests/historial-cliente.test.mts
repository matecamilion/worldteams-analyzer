import { test } from "node:test";
import assert from "node:assert/strict";
import { historyEntryFor, recordFinishedRun, recordHistory, type PageOutcome } from "../lib/client/historial";
import type { Finding, PageResult } from "../lib/detector/types";

const finding = (severity: Finding["severity"]): Finding => ({
  id: Math.random().toString(36), page: 1, severity, box: { x: 0, y: 0, w: 1, h: 1 }, boxNorm: { x: 0, y: 0, w: 0, h: 0 },
  texts: ["TEXTO A", "TEXTO B"], zone: "z", confidence: 1, source: "vector", originLabel: "Texto del PDF",
});
const page = (n: number, over: Partial<PageResult> = {}): PageResult => ({
  page: n, kind: "vector", width: 1, height: 1, textCount: 3, findings: [], status: "ok", ms: 1, ...over,
});
const fresh = (r: PageResult): PageOutcome => ({ result: r, fromCache: false });

const outcomes = [
  fresh(page(1, { findings: [finding("choque"), finding("choque"), finding("cercania")] })),
  fresh(page(2, { kind: "image", findings: [finding("duplicado")] })),
  fresh(page(3, { kind: "image", status: "no_verificada", error: "x" })),
];

test("la fila sólo lleva metadatos: nombre y conteos, nunca textos", () => {
  const e = historyEntryFor("  Planta\nbaja.pdf ", outcomes)!;
  assert.deepEqual(e, {
    nombre_archivo: "Planta baja.pdf",
    paginas: 3,
    paginas_escaneadas: 2,
    choques: 2,
    duplicados: 1,
    cercanias: 1,
    paginas_no_verificadas: 1,
  });
  assert.doesNotMatch(JSON.stringify(e), /TEXTO/);
  assert.equal(historyEntryFor("a".repeat(400) + ".pdf", outcomes)!.nombre_archivo.length, 255);
});

test("no se registra si alguna página salió del caché del navegador, ni una corrida cortada", async () => {
  const cached = [...outcomes.slice(0, 2), { result: outcomes[2].result, fromCache: true }];
  assert.equal(historyEntryFor("a.pdf", cached), null);
  let sent = 0;
  const send = async () => (sent++, true);
  assert.equal(await recordFinishedRun("a.pdf", cached, 3, send), false);
  assert.equal(await recordFinishedRun("a.pdf", outcomes.slice(0, 2), 3, send), false);
  assert.equal(sent, 0);
  assert.equal(await recordFinishedRun("a.pdf", outcomes, 3, send), true);
  assert.equal(sent, 1);
});

test("un fallo al guardar nunca lanza: red caída, error del servidor, cuelgue o envío que explota", async () => {
  const quiet = console.warn;
  console.warn = () => {};
  try {
    const entry = historyEntryFor("a.pdf", outcomes)!;
    const down = (async () => { throw new TypeError("Failed to fetch"); }) as typeof fetch;
    const error500 = (async () => new Response("{}", { status: 500 })) as typeof fetch;
    const tooMany = (async () => new Response("{}", { status: 429 })) as typeof fetch;
    // Nunca responde: sólo termina por el corte de tiempo (abort).
    const hang = ((_u: unknown, init?: RequestInit) =>
      new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))) as typeof fetch;
    assert.equal(await recordHistory(entry, down), false);
    assert.equal(await recordHistory(entry, error500), false);
    assert.equal(await recordHistory(entry, tooMany), false);
    assert.equal(await recordHistory(entry, hang, 50), false);
    assert.equal(await recordHistory(entry, (async () => new Response("{}", { status: 201 })) as typeof fetch), true);
    // Aunque el envío lance de forma síncrona, el cierre de la corrida no rompe.
    const boom = () => { throw new Error("boom"); };
    assert.equal(await recordFinishedRun("a.pdf", outcomes, 3, boom as never), false);
  } finally {
    console.warn = quiet;
  }
});

test("el envío es un único POST a /api/historial con JSON y keepalive", async () => {
  const calls: [string, RequestInit][] = [];
  const spy = (async (url: string, init: RequestInit) => (calls.push([url, init]), new Response("{}", { status: 201 }))) as unknown as typeof fetch;
  await recordHistory(historyEntryFor("a.pdf", outcomes)!, spy);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "/api/historial");
  assert.equal(calls[0][1].method, "POST");
  assert.equal(calls[0][1].keepalive, true);
  assert.equal(JSON.parse(String(calls[0][1].body)).paginas, 3);
});
