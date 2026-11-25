"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import { openPdf, validatePdfFile } from "@/lib/client/pdf";
import { numberFindings, summarize, toCsv } from "@/lib/detector/report";
import type { PageResult } from "@/lib/detector/types";
import { PageView, type PageStatus } from "./PageView";
import { ResultsPanel } from "./ResultsPanel";
import { UploadZone } from "./UploadZone";

type PageEntry = { page: number; status: PageStatus; result?: PageResult };
type Loaded = { name: string; bytes: ArrayBuffer; doc: PDFDocumentProxy; run: number };

/** Reintentos automáticos por página ante fallas de red o del servidor (además del manual). */
const AUTO_RETRIES = 1;

class RequestError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

async function requestPage(bytes: ArrayBuffer, page: number): Promise<PageResult> {
  let res: Response;
  try {
    res = await fetch(`/api/analyze?page=${page}`, {
      method: "POST",
      headers: { "Content-Type": "application/pdf" },
      body: bytes,
    });
  } catch {
    throw new RequestError("Sin conexión con el servidor.", true);
  }
  const body = (await res.json().catch(() => null)) as { result?: PageResult; error?: string } | null;
  if (res.ok && body?.result) return body.result;
  if (res.status === 504) throw new RequestError("El análisis tardó demasiado y se cortó.", true);
  throw new RequestError(body?.error ?? `El servidor respondió ${res.status}.`, res.status >= 500 || res.status === 429);
}

function unverified(page: number, error: string): PageResult {
  return { page, kind: "empty", width: 0, height: 0, textCount: 0, findings: [], status: "no_verificada", error, ms: 0 };
}

export function DetectorApp() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [pages, setPages] = useState<PageEntry[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [running, setRunning] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showNear, setShowNear] = useState(true);
  const [crops, setCrops] = useState<Record<string, string>>({});
  const runId = useRef(0);

  const setPage = (page: number, patch: Partial<PageEntry>) =>
    setPages((prev) => prev.map((p) => (p.page === page ? { ...p, ...patch } : p)));

  const analyze = useCallback(async (bytes: ArrayBuffer, page: number, run: number) => {
    setPage(page, { status: "analizando" });
    let result: PageResult | null = null;
    for (let attempt = 0; attempt <= AUTO_RETRIES && !result; attempt++) {
      try {
        result = await requestPage(bytes, page);
      } catch (e) {
        const err = e as RequestError;
        if (!err.retryable || attempt === AUTO_RETRIES) result = unverified(page, err.message);
      }
    }
    if (run !== runId.current) return; // Se subió otro archivo mientras tanto.
    setPage(page, { status: result!.status === "ok" ? "ok" : "no_verificada", result: result! });
  }, []);

  const start = useCallback(
    async (file: File) => {
      setUploadError(null);
      const problem = await validatePdfFile(file);
      if (problem) return setUploadError(problem);
      setOpening(true);
      try {
        const bytes = await file.arrayBuffer();
        const doc = await openPdf(bytes);
        const run = ++runId.current;
        setLoaded({ name: file.name, bytes, doc, run });
        setPages(Array.from({ length: doc.numPages }, (_, i) => ({ page: i + 1, status: "pendiente" as const })));
        setCrops({});
        setSelectedId(null);
        setOpening(false);
        setRunning(true);
        // Página por página: cada request entra holgado en el límite de duración de Vercel.
        for (let n = 1; n <= doc.numPages; n++) {
          if (run !== runId.current) return;
          await analyze(bytes, n, run);
        }
        if (run === runId.current) setRunning(false);
      } catch {
        setOpening(false);
        setUploadError(`No se pudo abrir "${file.name}". Puede estar dañado o protegido con contraseña.`);
      }
    },
    [analyze],
  );

  const loadSample = useCallback(async () => {
    setOpening(true);
    try {
      const res = await fetch("/ejemplo/planos-prueba.pdf");
      if (!res.ok) throw new Error();
      const blob = await res.blob();
      await start(new File([blob], "planos-prueba.pdf", { type: "application/pdf" }));
    } catch {
      setOpening(false);
      setUploadError("No se pudo descargar el plano de ejemplo. Probá de nuevo.");
    }
  }, [start]);

  const retry = useCallback(
    async (page: number) => {
      if (!loaded) return;
      await analyze(loaded.bytes, page, runId.current);
    },
    [analyze, loaded],
  );

  const reset = () => {
    runId.current++;
    setLoaded(null);
    setPages([]);
    setRunning(false);
    setUploadError(null);
  };

  const results = useMemo(() => pages.flatMap((p) => (p.result ? [p.result] : [])), [pages]);
  const findings = useMemo(() => numberFindings(results), [results]);
  const summary = useMemo(() => summarize(results), [results]);
  const done = pages.filter((p) => p.status === "ok" || p.status === "no_verificada").length;
  const current = pages.find((p) => p.status === "analizando")?.page;
  const hasScanned = results.some((r) => r.kind === "image");

  const select = useCallback(
    (id: string) => {
      const f = findings.find((x) => x.id === id);
      if (!f) return;
      if (f.severity === "cercania") setShowNear(true);
      setSelectedId(id);
      requestAnimationFrame(() => {
        const box = document.getElementById(`caja-${id}`);
        const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        box?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center", inline: "center" });
        box?.focus({ preventScroll: true });
      });
    },
    [findings],
  );

  const exportCsv = () => {
    if (!loaded) return;
    const blob = new Blob([toCsv(loaded.name, results)], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${loaded.name.replace(/\.pdf$/i, "")}-textos-superpuestos.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const onCrops = useCallback((c: Record<string, string>) => setCrops((prev) => ({ ...prev, ...c })), []);

  if (!loaded) {
    return (
      <div className="flex flex-1 flex-col justify-center px-4 py-12 sm:px-6">
        <div className="mx-auto mb-8 max-w-2xl text-center">
          <h1 className="font-display text-2xl font-semibold tracking-tight sm:text-3xl">Detector de textos superpuestos</h1>
          <p className="mt-2 text-gris">
            Subí un plano y te marcamos en qué página y entre qué ejes hay textos que se pisan.
          </p>
        </div>
        <UploadZone onFile={start} onSample={loadSample} error={uploadError} busy={opening} />
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col">
      {/* Resumen y acciones: queda fijo arriba mientras se recorre el plano. */}
      <div className="sticky top-0 z-20 border-b border-linea bg-papel/95 backdrop-blur-sm">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3 sm:px-6">
          <div className="min-w-0">
            <p className="truncate font-display font-semibold" title={loaded.name}>
              {loaded.name}
            </p>
            <p className="text-sm text-gris" aria-live="polite">
              {running && current
                ? `Analizando página ${current} de ${pages.length}`
                : `${pages.length} páginas revisadas`}
            </p>
          </div>

          <dl className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
            <div className="flex items-baseline gap-1.5">
              <dt className="sr-only">Choques</dt>
              <dd className="num font-display text-xl font-semibold text-choque">{summary.choques}</dd>
              <span aria-hidden>{summary.choques === 1 ? "choque" : "choques"}</span>
            </div>
            <div className="flex items-baseline gap-1.5">
              <dt className="sr-only">Cercanías</dt>
              <dd className="num font-display text-xl font-semibold text-cercania">{summary.cercanias}</dd>
              <span aria-hidden>{summary.cercanias === 1 ? "cercanía" : "cercanías"}</span>
            </div>
            <div className="flex items-baseline gap-1.5">
              <dt className="sr-only">Páginas no verificadas</dt>
              <dd className={`num font-display text-xl font-semibold ${summary.noVerificadas ? "text-cercania" : "text-gris"}`}>
                {summary.noVerificadas}
              </dd>
              <span aria-hidden>{summary.noVerificadas === 1 ? "página no verificada" : "páginas no verificadas"}</span>
            </div>
          </dl>

          <div className="ml-auto flex gap-2">
            <button
              type="button"
              onClick={exportCsv}
              disabled={running}
              title={running ? "Disponible cuando termine el análisis" : undefined}
              className="rounded bg-verde px-3.5 py-2 text-sm font-semibold text-papel hover:bg-tinta disabled:cursor-not-allowed disabled:opacity-50"
            >
              Exportar CSV
            </button>
            <button type="button" onClick={reset} className="rounded border border-linea-fuerte bg-hoja px-3.5 py-2 text-sm font-medium hover:bg-papel">
              Analizar otro PDF
            </button>
          </div>
        </div>
        {/* Progreso por página: un segmento por hoja. */}
        <div className="mx-auto flex max-w-[1600px] gap-1 px-4 pb-2 sm:px-6" role="progressbar" aria-label="Progreso del análisis" aria-valuemin={0} aria-valuemax={pages.length} aria-valuenow={done}>
          {pages.map((p) => (
            <span
              key={p.page}
              title={`Página ${p.page}`}
              className={`h-1.5 flex-1 rounded-full ${
                p.status === "ok"
                  ? "bg-lima"
                  : p.status === "no_verificada"
                    ? "bg-cercania"
                    : p.status === "analizando"
                      ? "animate-pulse bg-salvia"
                      : "bg-linea"
              }`}
            />
          ))}
        </div>
      </div>

      <div className="mx-auto grid w-full max-w-[1600px] flex-1 gap-6 px-4 py-5 sm:px-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 space-y-8">
          <p
            className={`flex gap-2 rounded border px-3 py-2 text-sm ${
              hasScanned ? "border-cercania/40 bg-cercania-suave text-tinta" : "border-linea bg-hoja text-gris"
            }`}
          >
            <svg aria-hidden viewBox="0 0 20 20" className="mt-0.5 h-4 w-4 shrink-0 text-cercania" fill="currentColor">
              <path d="M10 2 1 18h18L10 2Zm-.9 6h1.8v5H9.1V8Zm0 6.5h1.8v1.7H9.1v-1.7Z" />
            </svg>
            En páginas escaneadas los resultados son orientativos; conviene confirmarlos a ojo.
          </p>
          {pages.map((p) => (
            <PageView
              key={`${loaded.run}-${p.page}`}
              doc={loaded.doc}
              pageNumber={p.page}
              status={p.status}
              result={p.result}
              findings={findings.filter((f) => f.page === p.page)}
              selectedId={selectedId}
              showNear={showNear}
              onSelect={select}
              onCrops={onCrops}
              onRetry={() => retry(p.page)}
            />
          ))}
        </div>

        <aside className="lg:sticky lg:top-[92px] lg:h-[calc(100dvh-108px)]" aria-label="Resultados">
          <div className="h-full overflow-hidden rounded-md border border-linea bg-hoja">
            <ResultsPanel
              pages={pages}
              findings={findings}
              crops={crops}
              selectedId={selectedId}
              showNear={showNear}
              onToggleNear={setShowNear}
              onSelect={select}
              onRetry={retry}
            />
          </div>
        </aside>
      </div>
    </div>
  );
}
