import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanFileName, handleHistoryPost, MAX_BODY_BYTES, type HistoryDeps } from "../lib/historial";
import type { ToolAccess } from "../lib/guard";

const valid = {
  nombre_archivo: "Planta baja.pdf",
  paginas: 6,
  paginas_escaneadas: 1,
  choques: 7,
  duplicados: 1,
  cercanias: 4,
  paginas_no_verificadas: 0,
};
const user = { id: "u1", email: "Ana@Ejemplo.com" };

function deps(over: Partial<HistoryDeps> & { access?: ToolAccess; recent?: number[] } = {}) {
  const inserted: Record<string, unknown>[] = [];
  const recent = over.recent ?? [0, 0];
  let call = 0;
  const d: HistoryDeps = {
    requireAccess: async () => over.access ?? { ok: true, user },
    countSince: async () => recent[call++ % recent.length],
    insert: async (row) => {
      inserted.push(row);
    },
    log: () => {},
    ...over,
  };
  return { d, inserted };
}

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://x/api/historial", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

test("guarda una fila válida con el email de la sesión en minúsculas y sólo metadatos", async () => {
  const { d, inserted } = deps();
  const res = await handleHistoryPost(post(valid), d);
  assert.equal(res.status, 201);
  assert.deepEqual(inserted, [{ ...valid, email: "ana@ejemplo.com" }]);
});

test("el email del cuerpo se rechaza: la fila siempre es de quien tiene la sesión", async () => {
  const { d, inserted } = deps();
  const res = await handleHistoryPost(post({ ...valid, email: "otra@ejemplo.com" }), d);
  assert.equal(res.status, 400);
  assert.equal(inserted.length, 0);
});

test("misma guarda que /api/analyze: sin sesión 401, no habilitado o video pendiente 403", async () => {
  for (const [access, status] of [
    [{ ok: false, reason: "sin_sesion" }, 401],
    [{ ok: false, reason: "no_habilitado", user }, 403],
    [{ ok: false, reason: "video_pendiente", user }, 403],
  ] as [ToolAccess, number][]) {
    const { d, inserted } = deps({ access });
    assert.equal((await handleHistoryPost(post(valid), d)).status, status);
    assert.equal(inserted.length, 0);
  }
});

test("valida tipos, rangos y campos de más", async () => {
  const bad: unknown[] = [
    { ...valid, paginas: 0 },
    { ...valid, paginas: 5001 },
    { ...valid, paginas: 2.5 },
    { ...valid, paginas: "6" },
    { ...valid, choques: -1 },
    { ...valid, cercanias: 1_000_001 },
    { ...valid, paginas_escaneadas: 7 },
    { ...valid, paginas_no_verificadas: 7 },
    { ...valid, nombre_archivo: "" },
    { ...valid, nombre_archivo: "   \u0000\t " },
    { ...valid, nombre_archivo: "a".repeat(256) },
    { ...valid, hallazgos: ["COCINA × LAVADERO"] },
    { ...valid, textos: "TEXTO A" },
    (({ choques: _, ...rest }) => rest)(valid),
    [valid],
    null,
  ];
  for (const body of bad) {
    const { d, inserted } = deps();
    const res = await handleHistoryPost(post(body), d);
    assert.equal(res.status, 400, JSON.stringify(body)?.slice(0, 80));
    assert.equal(inserted.length, 0);
  }
  const { d } = deps();
  assert.equal((await handleHistoryPost(post("{no es json"), d)).status, 400);
});

test("el nombre del archivo se limpia y acepta hasta 255 caracteres", async () => {
  assert.equal(cleanFileName("  plano\u0000 final\n.pdf "), "plano final .pdf");
  const { d, inserted } = deps();
  const res = await handleHistoryPost(post({ ...valid, nombre_archivo: `${"a".repeat(251)}.pdf` }), d);
  assert.equal(res.status, 201);
  assert.equal((inserted[0].nombre_archivo as string).length, 255);
});

test("un cuerpo de más de 2 KB se rechaza con 413", async () => {
  const { d, inserted } = deps();
  const big = JSON.stringify({ ...valid, nombre_archivo: "a".repeat(MAX_BODY_BYTES) });
  assert.equal((await handleHistoryPost(post(big), d)).status, 413);
  assert.equal((await handleHistoryPost(post(valid, { "Content-Length": "999999" }), d)).status, 413);
  assert.equal(inserted.length, 0);
});

test("límite de frecuencia: 10 por minuto y 300 por día por persona", async () => {
  const perMinute = deps({ recent: [10, 0] });
  const r1 = await handleHistoryPost(post(valid), perMinute.d);
  assert.equal(r1.status, 429);
  assert.equal(r1.headers.get("Retry-After"), "60");
  const perDay = deps({ recent: [3, 300] });
  assert.equal((await handleHistoryPost(post(valid), perDay.d)).status, 429);
  assert.equal(perMinute.inserted.length + perDay.inserted.length, 0);
  const ok = deps({ recent: [9, 299] });
  assert.equal((await handleHistoryPost(post(valid), ok.d)).status, 201);
});

test("si la base o la guarda fallan, responde 500 sin filtrar el detalle", async () => {
  const failing = deps({ insert: async () => { throw new Error("connection refused 10.0.0.1"); } });
  const res = await handleHistoryPost(post(valid), failing.d);
  assert.equal(res.status, 500);
  assert.doesNotMatch(await res.text(), /10\.0\.0\.1/);
  const guard = deps({ requireAccess: async () => { throw new Error("allowlist caída"); } });
  assert.equal((await handleHistoryPost(post(valid), guard.d)).status, 500);
});
