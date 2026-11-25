"use client";

import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { NumberedFinding } from "@/lib/detector/report";
import { SEVERITY_LABEL } from "@/lib/detector/report";
import type { PageResult } from "@/lib/detector/types";

export type PageStatus = "pendiente" | "analizando" | "ok" | "no_verificada";

type Props = {
  doc: PDFDocumentProxy;
  pageNumber: number;
  status: PageStatus;
  result?: PageResult;
  findings: NumberedFinding[];
  selectedId: string | null;
  showNear: boolean;
  onSelect: (id: string) => void;
  onCrops: (crops: Record<string, string>) => void;
  onRetry: () => void;
};

const STROKE = { choque: "#c2261d", cercania: "#9a6200", duplicado: "#5b6b68" } as const;
/** Margen (pt) alrededor de la caja, para que el resaltado no tape las letras. */
const PAD_PT = 3;
/** Contexto (pt) que se incluye alrededor del choque en el recorte de la lista. */
const CROP_CONTEXT_PT = 22;

export function PageView({ doc, pageNumber, status, result, findings, selectedId, showNear, onSelect, onCrops, onRetry }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [renderError, setRenderError] = useState(false);
  const findingsKey = findings.map((f) => f.id).join(",");

  // Render de la página: una sola vez, a la resolución del contenedor × densidad de pantalla.
  useEffect(() => {
    let cancelled = false;
    let task: { cancel: () => void; promise: Promise<unknown> } | null = null;
    (async () => {
      try {
        const page = await doc.getPage(pageNumber);
        const base = page.getViewport({ scale: 1 });
        const cssWidth = wrapRef.current?.clientWidth || 900;
        const scale = Math.min(3, (cssWidth * Math.min(window.devicePixelRatio || 1, 2)) / base.width);
        const viewport = page.getViewport({ scale });
        const canvas = canvasRef.current;
        if (!canvas || cancelled) return;
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        task = page.render({ canvas, viewport });
        await task.promise;
        if (!cancelled) setSize({ w: base.width, h: base.height });
      } catch (e) {
        if (!cancelled && (e as Error)?.name !== "RenderingCancelledException") setRenderError(true);
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, pageNumber]);

  // Recortes resaltados para la lista, generados desde el mismo canvas (la imagen tal cual, sin enderezar).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !size || !findings.length) return;
    const k = canvas.width / size.w;
    const crops: Record<string, string> = {};
    for (const f of findings) {
      const x = Math.max(0, f.box.x - CROP_CONTEXT_PT);
      const y = Math.max(0, f.box.y - CROP_CONTEXT_PT);
      const w = Math.min(size.w - x, f.box.w + 2 * CROP_CONTEXT_PT);
      const h = Math.min(size.h - y, f.box.h + 2 * CROP_CONTEXT_PT);
      const out = document.createElement("canvas");
      const outScale = Math.min(1, 480 / (w * k));
      out.width = Math.round(w * k * outScale);
      out.height = Math.round(h * k * outScale);
      const ctx = out.getContext("2d");
      if (!ctx) continue;
      ctx.drawImage(canvas, x * k, y * k, w * k, h * k, 0, 0, out.width, out.height);
      const s = k * outScale;
      ctx.lineWidth = Math.max(2, 2 * outScale * 1.5);
      ctx.strokeStyle = STROKE[f.severity];
      if (f.severity === "cercania") ctx.setLineDash([6, 4]);
      ctx.strokeRect((f.box.x - x - PAD_PT) * s, (f.box.y - y - PAD_PT) * s, (f.box.w + 2 * PAD_PT) * s, (f.box.h + 2 * PAD_PT) * s);
      crops[f.id] = out.toDataURL("image/png");
    }
    onCrops(crops);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size, findingsKey]);

  const visible = findings.filter((f) => showNear || f.severity !== "cercania");
  const kindLabel =
    result?.kind === "image" ? "Escaneada · revisada con IA" : result?.kind === "vector" ? "Texto del PDF" : result?.kind === "empty" ? "Sin contenido" : null;
  const clashes = findings.filter((f) => f.severity === "choque").length;

  return (
    <section id={`pagina-${pageNumber}`} aria-labelledby={`pagina-${pageNumber}-titulo`} className="scroll-mt-28">
      <header className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id={`pagina-${pageNumber}-titulo`} className="font-display text-base font-semibold">
          Página {pageNumber}
        </h2>
        {kindLabel && <span className="text-sm text-gris">{kindLabel}</span>}
        <span className="ml-auto text-sm">
          {status === "pendiente" && <span className="text-gris">En espera</span>}
          {status === "analizando" && <span className="text-tinta">Analizando…</span>}
          {status === "ok" &&
            (clashes ? (
              <span className="font-semibold text-choque">
                {clashes} {clashes === 1 ? "choque" : "choques"}
              </span>
            ) : (
              <span className="text-ok">Sin choques</span>
            ))}
          {status === "no_verificada" && (
            <span className="inline-flex items-center gap-2">
              <span className="font-semibold text-cercania">No verificada</span>
              <button type="button" onClick={onRetry} className="rounded border border-linea-fuerte bg-hoja px-2 py-0.5 text-tinta hover:bg-papel">
                Reintentar
              </button>
            </span>
          )}
        </span>
      </header>

      <div ref={wrapRef} className="relative overflow-hidden rounded-sm border border-linea-fuerte bg-hoja shadow-[0_1px_2px_rgb(13_33_31/0.06)]">
        <canvas
          ref={canvasRef}
          className="block h-auto w-full"
          role="img"
          aria-label={`Plano, página ${pageNumber}`}
          style={size ? { aspectRatio: `${size.w} / ${size.h}` } : { aspectRatio: "1190 / 842" }}
        />
        {!size && !renderError && <div className="absolute inset-0 animate-pulse bg-papel/70" aria-hidden />}
        {renderError && (
          <p className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-gris">
            No se pudo dibujar esta página en el navegador. Los resultados de la lista siguen siendo válidos.
          </p>
        )}
        {status === "analizando" && (
          <div className="absolute inset-x-0 top-0 h-1 overflow-hidden bg-salvia/20" aria-hidden>
            <div className="h-full w-1/3 animate-[barrido_1.2s_ease-in-out_infinite] bg-salvia" />
          </div>
        )}
        {size &&
          visible.map((f) => {
            const left = ((f.box.x - PAD_PT) / size.w) * 100;
            const top = ((f.box.y - PAD_PT) / size.h) * 100;
            const width = ((f.box.w + 2 * PAD_PT) / size.w) * 100;
            const height = ((f.box.h + 2 * PAD_PT) / size.h) * 100;
            const selected = f.id === selectedId;
            const tone =
              f.severity === "choque"
                ? "border-choque bg-choque/10"
                : f.severity === "cercania"
                  ? "border-dashed border-cercania bg-cercania/5"
                  : "border-gris bg-gris/5";
            const badge = f.severity === "choque" ? "bg-choque" : f.severity === "cercania" ? "bg-cercania" : "bg-gris";
            return (
              <button
                key={f.id}
                id={`caja-${f.id}`}
                type="button"
                onClick={() => onSelect(f.id)}
                aria-label={`Hallazgo ${f.n}: ${SEVERITY_LABEL[f.severity]} entre ${f.texts.join(" y ")}`}
                aria-pressed={selected}
                className={`absolute rounded-[2px] border-2 ${tone} ${selected ? "hallazgo-enfocado ring-2 ring-tinta ring-offset-1" : ""}`}
                style={{ left: `${left}%`, top: `${top}%`, width: `${width}%`, height: `${height}%` }}
              >
                <span
                  className={`num absolute -top-2.5 -left-2.5 grid h-5 min-w-5 place-items-center rounded-full px-1 text-[11px] leading-none font-bold text-white ${badge}`}
                >
                  {f.n}
                </span>
              </button>
            );
          })}
      </div>
      {result?.error && status === "no_verificada" && <p className="mt-2 text-sm text-cercania">{result.error}</p>}
    </section>
  );
}
