"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import { forgetCachedPage, getCachedPage, hashPdf, putCachedPage } from "@/lib/client/cache";
import { recordFinishedRun, type PageOutcome } from "@/lib/client/historial";
import { openPdf, validatePdfFile } from "@/lib/client/pdf";
import { PAGINAS_EN_PARALELO, runPages, type PageAttempt } from "@/lib/client/run-pages";
import { numberFindings, summarize } from "@/lib/detector/report";
import type { PageResult } from "@/lib/detector/types";
import { PageView, type PageStatus, type ZoomCommand } from "./PageView";
import { ResultsPanel } from "./ResultsPanel";
import { UploadZone } from "./UploadZone";

/** `scanned`: la página casi no tiene texto (va a visión, puede tardar hasta un minuto). */
/** `cachedAt`: el resultado salió del caché del navegador (no se volvió a consultar a la IA). */
type PageEntry = { page: number; status: PageStatus; result?: PageResult; scanned?: boolean; cachedAt?: string };

/** Misma regla que el servidor (inspectPage): menos de 20 caracteres de texto = página escaneada. */
async function looksScanned(doc: PDFDocumentProxy, page: number): Promise<boolean> {
  try {
    const content = await (await doc.getPage(page)).getTextContent();
    const chars = content.items.reduce((n, it) => n + ("str" in it ? it.str.trim().length : 0), 0);
    return chars < 20;
  } catch {
    return false;
  }
}
type Loaded = { name: string; bytes: ArrayBuffer; doc: PDFDocumentProxy; run: number; hash: string | null };

/** Reintentos automáticos por página ante fallas de red o del servidor (además del manual). */
const AUTO_RETRIES = 1;

class RequestError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    /** Código HTTP, si el servidor llegó a responder. */
    readonly status?: number,
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
  if (res.status === 401) {
    // La sesión venció durante el análisis: volver a entrar.
    // Recarga completa a propósito: descarta el estado de la sesión vencida.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign(`${window.location.origin}/login`);
    throw new RequestError("Tu sesión venció. Volvé a entrar.", false, 401);
  }
  if (res.status === 504) throw new RequestError("El análisis tardó demasiado y se cortó.", true, 504);
  throw new RequestError(body?.error ?? `El servidor respondió ${res.status}.`, res.status >= 500 || res.status === 429, res.status);
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
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [crops, setCrops] = useState<Record<string, string>>({});
  const [zoom, setZoom] = useState<ZoomCommand | null>(null);
  /** Página que tiene zoom (por un hallazgo o por un gesto), para que Esc sepa a quién volver. */
  const zoomedPage = useRef<number | null>(null);
  const runId = useRef(0);

  const setPage = (page: number, patch: Partial<PageEntry>) =>
    setPages((prev) => prev.map((p) => (p.page === page ? { ...p, ...patch } : p)));

  /** Corridas ya registradas en "Mi actividad": nunca dos veces la misma (aunque React re-renderice). */
  const recordedRuns = useRef(new Set<number>());

  const analyze = useCallback(async (
    doc: PDFDocumentProxy,
    bytes: ArrayBuffer,
    hash: string | null,
    page: number,
    run: number,
    useCache = true,
  ): Promise<PageAttempt<PageOutcome> | null> => {
    const scanned = await looksScanned(doc, page);
    // Página escaneada ya analizada en este navegador: se reutiliza sin llamar a la IA.
    const cached = scanned && hash && useCache ? getCachedPage(hash, page) : null;
    if (cached) {
      if (run !== runId.current) return null;
      setPage(page, { status: "ok", scanned, result: cached.result, cachedAt: cached.savedAt });
      return { outcome: { result: cached.result, fromCache: true } };
    }
    if (run !== runId.current) return null;
    setPage(page, { status: "analizando", scanned, cachedAt: undefined });
    let result: PageResult | null = null;
    let failure: PageAttempt<PageOutcome>["failure"];
    for (let attempt = 0; attempt <= AUTO_RETRIES && !result; attempt++) {
      try {
        result = await requestPage(bytes, page);
      } catch (e) {
        const err = e as RequestError;
        if (!err.retryable || attempt === AUTO_RETRIES) {
          result = unverified(page, err.message);
          failure = err.status === 401 || err.status === 403 ? "sin_acceso" : "error";
        }
      }
    }
    if (run !== runId.current) return null; // Se subió otro archivo mientras tanto.
    // Escaneada sin verificar: falló la IA (caída, lenta o parcial). Cuenta como falla del servicio.
    if (!failure && result!.kind === "image" && result!.status !== "ok") failure = "error";
    if (hash) putCachedPage(hash, page, result!);
    setPage(page, { status: result!.status === "ok" ? "ok" : "no_verificada", result: result! });
    return { outcome: { result: result!, fromCache: false }, failure };
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
        // Sin crypto.subtle (contexto no seguro) no hay caché; el análisis sigue igual.
        const hash = await hashPdf(bytes).catch(() => null);
        const run = ++runId.current;
        setLoaded({ name: file.name, bytes, doc, run, hash });
        setPages(Array.from({ length: doc.numPages }, (_, i) => ({ page: i + 1, status: "pendiente" as const })));
        setCrops({});
        setSelectedId(null);
        setZoom(null);
        zoomedPage.current = null;
        setOpening(false);
        setRunning(true);
        // Un request por página (cada uno entra holgado en el límite de duración de Vercel): la 1
        // sola y después de a PAGINAS_EN_PARALELO.
        const isCurrent = () => run === runId.current;
        const outcome = await runPages<PageOutcome>({
          total: doc.numPages,
          parallel: PAGINAS_EN_PARALELO,
          isCurrent,
          analyzePage: (n) => analyze(doc, bytes, hash, n, run),
          onPageError: (n) => {
            const result = unverified(n, "No se pudo analizar esta página.");
            setPage(n, { status: "no_verificada", result });
            return { result, fromCache: false };
          },
        });
        if (outcome.status === "cortada" || !isCurrent()) return;
        if (outcome.status === "sin_acceso") {
          // Sin acceso, las demás fallarían igual: quedan sin verificar con el mismo motivo.
          const reason = outcome.outcomes[outcome.failedPage - 1]?.result.error ?? "No se pudo analizar la página.";
          for (const n of outcome.pending) setPage(n, { status: "no_verificada", result: unverified(n, reason) });
        }
        setRunning(false);
        // "Mi actividad": una sola vez por corrida, sólo si se analizaron todas las páginas, sin
        // esperar y sin errores visibles. Los reintentos de una página y el caché no se registran.
        if (outcome.status === "completa" && !recordedRuns.current.has(run)) {
          recordedRuns.current.add(run);
          void recordFinishedRun(file.name, outcome.outcomes, doc.numPages);
        }
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
      // Reintentar o "Volver a analizar" siempre consulta de nuevo (y reemplaza lo guardado).
      if (loaded.hash) forgetCachedPage(loaded.hash, page);
      await analyze(loaded.doc, loaded.bytes, loaded.hash, page, runId.current, false);
    },
    [analyze, loaded],
  );

  const reset = () => {
    runId.current++;
    setLoaded(null);
    setPages([]);
    setRunning(false);
    setUploadError(null);
    setExportError(null);
  };

  const results = useMemo(() => pages.flatMap((p) => (p.result ? [p.result] : [])), [pages]);
  const findings = useMemo(() => numberFindings(results), [results]);
  const summary = useMemo(() => summarize(results), [results]);
  const done = pages.filter((p) => p.status === "ok" || p.status === "no_verificada").length;
  // Con varias páginas en vuelo no hay una "actual": se cuenta cuántas están listas.
  const scanningNow = pages.some((p) => p.status === "analizando" && p.scanned);
  // Sólo si alguna página pasó (o está pasando) por la IA: en un PDF vectorial el aviso confunde.
  const hasScanned = results.some((r) => r.kind === "image") || pages.some((p) => p.scanned);

  const nonce = useRef(0);
  const select = useCallback(
    (id: string) => {
      const f = findings.find((x) => x.id === id);
      if (!f) return;
      if (f.severity === "cercania") setShowNear(true);
      setSelectedId(id);
      setZoom({ page: f.page, box: f.box, nonce: ++nonce.current });
      zoomedPage.current = f.page;
      requestAnimationFrame(() => {
        const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        const behavior = reduce ? "auto" : "smooth";
        // El marco de la página queda centrado en pantalla; el zoom ocurre dentro del marco.
        const frame = document.getElementById(`marco-${f.page}`);
        if (frame) {
          const r = frame.getBoundingClientRect();
          const visible = r.top >= 90 && r.bottom <= window.innerHeight;
          if (!visible) frame.scrollIntoView({ behavior, block: "center" });
        }
        document.getElementById(`caja-${id}`)?.focus({ preventScroll: true });
        document.getElementById(`item-${id}`)?.scrollIntoView({ behavior, block: "nearest" });
      });
    },
    [findings],
  );

  const showFullPage = useCallback(() => {
    if (zoomedPage.current === null) return;
    setZoom({ page: zoomedPage.current, box: null, nonce: ++nonce.current });
    zoomedPage.current = null;
  }, []);

  const onZoomChange = useCallback((page: number, zoomed: boolean) => {
    zoomedPage.current = zoomed ? page : zoomedPage.current === page ? null : zoomedPage.current;
  }, []);

  // Teclado: ← → recorren los hallazgos visibles; Esc vuelve a la página completa.
  const navigable = useMemo(() => findings.filter((f) => showNear || f.severity !== "cercania"), [findings, showNear]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.altKey || e.ctrlKey || e.metaKey || el.closest("input, textarea, select, [contenteditable]")) return;
      if (e.key === "Escape") {
        showFullPage();
        return;
      }
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      if (!navigable.length) return;
      e.preventDefault();
      const i = navigable.findIndex((f) => f.id === selectedId);
      const next =
        i === -1
          ? e.key === "ArrowRight" ? 0 : navigable.length - 1
          : (i + (e.key === "ArrowRight" ? 1 : -1) + navigable.length) % navigable.length;
      select(navigable[next].id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigable, selectedId, select, showFullPage]);

  /** Arma el PDF con marcas en el navegador (pdf-lib se carga recién acá): nada pasa por el servidor. */
  const downloadMarkedPdf = async () => {
    if (!loaded || exporting) return;
    setExporting(true);
    setExportError(null);
    try {
      const { buildMarkedPdf, markedFileName } = await import("@/lib/detector/marked-pdf");
      // La misma geometría con la que pdfjs dibuja la página en pantalla (caja visible y rotación).
      const geometry: Record<number, { view: [number, number, number, number]; rotate: number }> = {};
      for (let n = 1; n <= loaded.doc.numPages; n++) {
        const page = await loaded.doc.getPage(n);
        geometry[n] = { view: page.view as [number, number, number, number], rotate: page.rotate };
      }
      const pdf = await buildMarkedPdf({ bytes: loaded.bytes, fileName: loaded.name, pages: results, geometry, showNear });
      const blob = new Blob([pdf as Uint8Array<ArrayBuffer>], { type: "application/pdf" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = markedFileName(loaded.name);
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    } catch {
      setExportError("No se pudo armar el PDF con marcas. Si el archivo está protegido, probá con una copia sin protección.");
    } finally {
      setExporting(false);
    }
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
              {running
                ? `${done} de ${pages.length} ${pages.length === 1 ? "página lista" : "páginas listas"}` +
                  (scanningNow ? " · hay páginas escaneadas, pueden tardar hasta un minuto" : "")
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
              <dt className="sr-only">Duplicados</dt>
              <dd className="num font-display text-xl font-semibold text-gris">{summary.duplicados}</dd>
              <span aria-hidden>{summary.duplicados === 1 ? "duplicado" : "duplicados"}</span>
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
              onClick={downloadMarkedPdf}
              disabled={running || exporting}
              aria-busy={exporting}
              title={running ? "Disponible cuando termine el análisis" : undefined}
              className="rounded bg-verde px-3.5 py-2 text-sm font-semibold text-papel hover:bg-tinta disabled:cursor-not-allowed disabled:opacity-50"
            >
              {exporting ? "Armando el PDF…" : "Descargar PDF con marcas"}
            </button>
            <button type="button" onClick={reset} className="rounded border border-linea-fuerte bg-hoja px-3.5 py-2 text-sm font-medium hover:bg-papel">
              Analizar otro PDF
            </button>
          </div>
          {exportError && (
            <p role="alert" className="basis-full text-sm text-choque">
              {exportError}
            </p>
          )}
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
          {hasScanned && (
          <p className="flex gap-2 rounded border border-cercania/40 bg-cercania-suave px-3 py-2 text-sm text-tinta">
            <svg aria-hidden viewBox="0 0 20 20" className="mt-0.5 h-4 w-4 shrink-0 text-cercania" fill="currentColor">
              <path d="M10 2 1 18h18L10 2Zm-.9 6h1.8v5H9.1V8Zm0 6.5h1.8v1.7H9.1v-1.7Z" />
            </svg>
            En páginas escaneadas los resultados son orientativos; conviene confirmarlos a ojo.
          </p>
          )}
          {pages.map((p) => (
            <PageView
              key={`${loaded.run}-${p.page}`}
              doc={loaded.doc}
              pageNumber={p.page}
              status={p.status}
              scanned={p.scanned}
              cachedAt={p.cachedAt}
              result={p.result}
              findings={findings.filter((f) => f.page === p.page)}
              selectedId={selectedId}
              showNear={showNear}
              zoom={zoom}
              onSelect={select}
              onCrops={onCrops}
              onRetry={() => retry(p.page)}
              onZoomChange={onZoomChange}
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
