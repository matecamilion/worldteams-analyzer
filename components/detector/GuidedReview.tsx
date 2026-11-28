"use client";

import { useEffect, useRef } from "react";
import { reviewLabel, type NumberedFinding } from "@/lib/detector/report";
import type { ReviewState } from "@/lib/detector/review";
import type { Finding } from "@/lib/detector/types";
import { CheckIcon, ReviewControls } from "./ReviewControls";

type Props = {
  /** El hallazgo que se está revisando (el seleccionado), o null. */
  current: NumberedFinding | null;
  pending: number;
  total: number;
  /** Todavía hay páginas analizándose: pueden aparecer hallazgos nuevos. */
  stillRunning: boolean;
  onDecide: (finding: Finding, state: ReviewState) => void;
  onPrev: () => void;
  onNext: () => void;
  onNextPending: () => void;
  onExit: () => void;
};

/**
 * "Revisar uno por uno": barra fija abajo con la pregunta del hallazgo actual. Publica su alto en
 * --guia-alto para que los controles fijos de zoom queden encima y no tapados.
 */
export function GuidedReview({ current, pending, total, stillRunning, onDecide, onPrev, onNext, onNextPending, onExit }: Props) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = document.documentElement;
    const ro = new ResizeObserver(() => root.style.setProperty("--guia-alto", `${el.offsetHeight}px`));
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty("--guia-alto");
    };
  }, []);

  const done = pending === 0;
  const nav = "rounded border border-linea-fuerte bg-hoja px-3 py-2 text-sm font-medium hover:bg-papel disabled:opacity-40";
  return (
    <section
      ref={ref}
      aria-label="Revisión uno por uno"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-linea-fuerte bg-papel/97 pb-[env(safe-area-inset-bottom)] shadow-[0_-4px_16px_rgb(0_0_0/0.08)] backdrop-blur-sm"
    >
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:px-6">
        <p className="text-xs font-semibold tracking-wide text-gris uppercase" aria-live="polite">
          Revisión uno por uno ·{" "}
          {done ? "ninguno por revisar" : <><span className="num">{pending}</span> por revisar de <span className="num">{total}</span></>}
        </p>
        <button type="button" onClick={onExit} className="ml-auto rounded px-3 py-2 text-sm font-medium text-gris hover:bg-hoja hover:text-tinta sm:order-last">
          Salir
        </button>

        <div className="flex w-full flex-wrap items-center gap-x-4 gap-y-2" aria-live="polite">
          {done && (
            <p className="inline-flex w-full items-center gap-2 text-base font-semibold text-ok">
              <CheckIcon className="h-5 w-5" />
              {stillRunning ? "Por ahora no queda nada por revisar: faltan páginas por analizar." : "Todo revisado ✓"}
            </p>
          )}
          {current ? (
            <>
              <p className="min-w-0 flex-1 basis-60 text-sm">
                <span className="font-semibold">Hallazgo {current.n}</span> · {reviewLabel(current)} · Página {current.page}
                <span className="block break-words text-gris">
                  {current.source === "manual" ? current.note || "Agregado a mano" : current.texts.join(" × ") || "Textos ilegibles"}
                </span>
              </p>
              <ReviewControls finding={current} onDecide={onDecide} size="md" />
            </>
          ) : done ? null : (
            <button type="button" onClick={onNextPending} className="rounded bg-verde px-3 py-2 text-sm font-semibold text-papel hover:bg-tinta">
              Ir al siguiente por revisar
            </button>
          )}
          <span className="flex gap-2 sm:ml-auto">
            <button type="button" onClick={onPrev} disabled={total === 0} className={nav} aria-label="Hallazgo anterior">
              ← Anterior
            </button>
            <button type="button" onClick={onNext} disabled={total === 0} className={nav} aria-label="Hallazgo siguiente">
              Siguiente →
            </button>
          </span>
        </div>
      </div>
    </section>
  );
}
