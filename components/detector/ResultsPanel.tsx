"use client";

import type { NumberedFinding } from "@/lib/detector/report";
import { AI_TEXT_NOTE, reviewLabel } from "@/lib/detector/report";
import type { ReviewState } from "@/lib/detector/review";
import type { Finding } from "@/lib/detector/types";
import { CheckIcon, ReviewControls } from "./ReviewControls";

const AI_TEXT_NOTE_CAP = AI_TEXT_NOTE[0].toUpperCase() + AI_TEXT_NOTE.slice(1);
import { LOW_RES_WARNING, type PageResult } from "@/lib/detector/types";
import type { PageStatus } from "./PageView";

type PageEntry = { page: number; status: PageStatus; result?: PageResult };

type Props = {
  pages: PageEntry[];
  findings: NumberedFinding[];
  crops: Record<string, string>;
  selectedId: string | null;
  showNear: boolean;
  onToggleNear: (v: boolean) => void;
  onSelect: (id: string) => void;
  /** Revisión: confirmado, falsa alarma o de vuelta a por revisar (se puede deshacer). */
  onDecide: (finding: Finding, state: ReviewState) => void;
  /** Borra un error marcado a mano. */
  onRemoveMark: (id: string) => void;
  onRetry: (page: number) => void;
};

// Espacio no separable: el "%" no queda solo en otro renglón.
const pct = (v: number) => `${Math.round(v * 100)} %`;

export function ResultsPanel({ pages, findings, crops, selectedId, showNear, onToggleNear, onSelect, onDecide, onRemoveMark, onRetry }: Props) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-linea px-4 py-3">
        <h2 className="font-display text-base font-semibold">Hallazgos</h2>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-gris">
          <input
            type="checkbox"
            checked={showNear}
            onChange={(e) => onToggleNear(e.target.checked)}
            className="h-4 w-4 accent-verde"
          />
          Mostrar cercanías
        </label>
      </div>

      <p className="border-b border-linea px-4 py-1.5 text-xs text-gris">
        <kbd className="rounded border border-linea-fuerte bg-papel px-1">←</kbd>{" "}
        <kbd className="rounded border border-linea-fuerte bg-papel px-1">→</kbd> recorren los hallazgos ·{" "}
        <kbd className="rounded border border-linea-fuerte bg-papel px-1">Esc</kbd> vuelve a la página completa
      </p>
      <ol className="flex-1 overflow-y-auto" aria-label="Hallazgos por página">
        {pages.map((p) => {
          const own = findings.filter((f) => f.page === p.page && (showNear || f.severity !== "cercania"));
          const hidden = findings.filter((f) => f.page === p.page && !showNear && f.severity === "cercania").length;
          return (
            <li key={p.page} className="border-b border-linea last:border-b-0">
              <div className="sticky top-0 z-10 flex items-baseline justify-between bg-papel/95 px-4 py-2 backdrop-blur-sm">
                <h3 className="text-sm font-semibold">Página {p.page}</h3>
                <span className="text-xs text-gris">
                  {p.result?.kind === "image" ? "Escaneada" : p.result?.kind === "vector" ? "Vectorial" : ""}
                </span>
              </div>

              {p.result?.lowResolution && (p.status === "ok" || p.status === "no_verificada") && (
                <p role="note" className="mx-4 mb-2 rounded border border-cercania/40 bg-cercania-suave px-3 py-1.5 text-sm text-tinta">
                  {LOW_RES_WARNING}
                </p>
              )}
              {p.status === "pendiente" && <p className="px-4 pb-3 text-sm text-gris">En espera</p>}
              {p.status === "analizando" && (
                <p className="px-4 pb-3 text-sm text-tinta" aria-busy="true">
                  Analizando…
                </p>
              )}
              {p.status === "no_verificada" && (
                <div className="mx-4 mb-3 rounded border border-cercania/40 bg-cercania-suave px-3 py-2 text-sm">
                  <p className="font-semibold text-cercania">Página no verificada</p>
                  <p className="mt-0.5 text-tinta">{p.result?.error ?? "No se pudo analizar."}</p>
                  <button
                    type="button"
                    onClick={() => onRetry(p.page)}
                    className="mt-2 rounded border border-linea-fuerte bg-hoja px-2.5 py-1 font-medium hover:bg-papel"
                  >
                    Reintentar página {p.page}
                  </button>
                </div>
              )}
              {p.status === "ok" && own.length === 0 && (
                <p className="px-4 pb-3 text-sm text-ok">
                  Sin choques{hidden ? ` · ${hidden} ${hidden === 1 ? "cercanía oculta" : "cercanías ocultas"}` : ""}
                </p>
              )}

              {own.length > 0 && (
                <ul className="pb-2">
                  {own.map((f) => {
                    const selected = f.id === selectedId;
                    const badge = f.severity === "choque" ? "bg-choque" : f.severity === "cercania" ? "bg-cercania" : "bg-gris";
                    return (
                      <li key={f.id}>
                        <button
                          id={`item-${f.id}`}
                          type="button"
                          onClick={() => onSelect(f.id)}
                          aria-current={selected ? "true" : undefined}
                          className={`grid w-full grid-cols-[auto_1fr_auto] items-start gap-3 px-4 pt-2.5 pb-1 text-left hover:bg-papel ${
                            selected ? "bg-papel shadow-[inset_3px_0_0_var(--color-verde)]" : ""
                          }`}
                        >
                          <span
                            className={`num mt-0.5 grid h-6 min-w-6 place-items-center rounded-full px-1 text-xs font-bold text-white ${badge}`}
                          >
                            {f.n}
                          </span>
                          <span className="min-w-0">
                            <span className="block text-sm font-semibold break-words">
                              {f.source === "manual" ? f.note || "Marcado a mano" : f.texts.join(" × ") || "Textos ilegibles"}
                            </span>
                            {f.source === "vision" && <span className="block text-xs text-gris italic">{AI_TEXT_NOTE_CAP}</span>}
                            <span className="mt-0.5 block text-xs text-gris">
                              <span
                                className={`inline-flex items-center gap-1 ${
                                  f.severity === "choque" ? "font-semibold text-choque" : f.severity === "cercania" ? "font-semibold text-cercania" : ""
                                }`}
                              >
                                {f.reviewState === "confirmado" && <CheckIcon className="h-3 w-3" />}
                                {reviewLabel(f)}
                              </span>
                              {" · "}
                              {f.zone}
                            </span>
                            <span className="mt-0.5 block text-xs text-gris">
                              {f.originLabel}
                              {f.source !== "manual" && (
                                <>
                                  {" · "}confianza <span className="num">{pct(f.confidence)}</span>
                                </>
                              )}
                            </span>
                          </span>
                          {crops[f.id] ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={crops[f.id]}
                              alt=""
                              className="h-14 w-24 rounded-sm border border-linea bg-hoja object-contain"
                            />
                          ) : (
                            <span className="h-14 w-24 animate-pulse rounded-sm bg-linea/60" aria-hidden />
                          )}
                        </button>
                        <div
                          className={`flex flex-wrap items-center justify-between gap-2 py-2 pr-4 pl-13 ${
                            selected ? "bg-papel shadow-[inset_3px_0_0_var(--color-verde)]" : ""
                          }`}
                        >
                          <ReviewControls finding={f} onDecide={onDecide} />
                          {f.source === "manual" && (
                            <button
                              type="button"
                              onClick={() => onRemoveMark(f.id)}
                              aria-label={`Borrar la marca a mano ${f.n}`}
                              className="rounded border border-linea-fuerte bg-hoja px-2.5 py-1 text-xs font-medium hover:bg-papel"
                            >
                              Borrar marca
                            </button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
