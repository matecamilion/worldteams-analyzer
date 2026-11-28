"use client";

import { useEffect, useRef } from "react";
import { reviewLabel, type NumberedFinding } from "@/lib/detector/report";
import type { ReviewState } from "@/lib/detector/review";
import type { Finding } from "@/lib/detector/types";
import { ReviewControls } from "./ReviewControls";

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
      {/* En celular: estado y "Salir" en un renglón, el hallazgo en otro y los botones abajo; todo compacto para dejar ver el plano. */}
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-4 gap-y-1.5 px-3 py-2 sm:gap-y-2 sm:px-6 sm:py-3">
        <p className="min-w-0 flex-1 text-xs font-semibold tracking-wide text-gris uppercase" aria-live="polite">
          Revisión uno por uno ·{" "}
          {done ? "ninguno por revisar" : <><span className="num">{pending}</span> por revisar de <span className="num">{total}</span></>}
        </p>
        <button type="button" onClick={onExit} className="-my-1 rounded px-3 py-1.5 text-sm font-medium text-gris hover:bg-hoja hover:text-tinta sm:order-last">
          Salir
        </button>

        <div className="flex w-full flex-wrap items-center gap-x-4 gap-y-1.5 sm:gap-y-2" aria-live="polite">
          {done && (
            <p className="w-full text-base font-semibold text-ok">
              {stillRunning ? "Por ahora no queda nada por revisar: faltan páginas por analizar." : "Todo revisado ✓"}
            </p>
          )}
          {current ? (
            <>
              <p className="min-w-0 flex-1 basis-full text-sm sm:basis-60">
                <span className="font-semibold">Hallazgo {current.n}</span> · {reviewLabel(current)} · Pág. {current.page}
                <span className="block truncate text-gris sm:whitespace-normal sm:break-words">
                  {current.source === "manual" ? current.note || "Agregado a mano" : current.texts.join(" × ") || "Textos ilegibles"}
                </span>
              </p>
              <ReviewControls finding={current} onDecide={onDecide} size="md" hideLabel />
            </>
          ) : done ? null : (
            <button type="button" onClick={onNextPending} className="rounded bg-verde px-3 py-2 text-sm font-semibold text-papel hover:bg-tinta">
              Ir al siguiente por revisar
            </button>
          )}
          <span className="ml-auto flex gap-2">
            <button type="button" onClick={onPrev} disabled={total === 0} className={nav} aria-label="Hallazgo anterior">
              ←<span className="max-sm:sr-only"> Anterior</span>
            </button>
            <button type="button" onClick={onNext} disabled={total === 0} className={nav} aria-label="Hallazgo siguiente">
              <span className="max-sm:sr-only">Siguiente </span>→
            </button>
          </span>
        </div>
      </div>
    </section>
  );
}
