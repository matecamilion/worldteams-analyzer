"use client";

import {
  CONFIRM_ACTION,
  CONFIRMED_LABEL,
  FALSE_ALARM_ACTION,
  REVIEW_QUESTION,
} from "@/lib/detector/report";
import type { ReviewState } from "@/lib/detector/review";
import type { Finding } from "@/lib/detector/types";

type Props = {
  finding: Finding;
  onDecide: (finding: Finding, state: ReviewState) => void;
  /** "md": botones más grandes (barra del seleccionado y modo guiado). */
  size?: "sm" | "md";
};

/** Ícono de "confirmado": la marca no depende sólo del color. */
export function CheckIcon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 8.5 6.5 12 13 4.5" />
    </svg>
  );
}

function CrossIcon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round">
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

/**
 * La revisión de un hallazgo: si está por revisar, la pregunta con "Sí, es real" y "No, falsa
 * alarma"; si ya está confirmado, el estado con la opción de cambiarlo o volver a por revisar.
 */
export function ReviewControls({ finding, onDecide, size = "sm" }: Props) {
  const btn =
    size === "md"
      ? "inline-flex items-center gap-1.5 rounded px-3 py-2 text-sm font-semibold"
      : "inline-flex items-center gap-1 rounded px-2.5 py-1 text-xs font-semibold";
  const quiet = size === "md" ? "rounded px-2.5 py-2 text-sm text-gris underline-offset-2 hover:text-tinta hover:underline" : "rounded px-1.5 py-1 text-xs text-gris underline-offset-2 hover:text-tinta hover:underline";

  if (finding.source === "manual") {
    return (
      <p className="inline-flex items-center gap-1.5 text-xs font-semibold text-ok">
        <CheckIcon /> {CONFIRMED_LABEL[finding.severity]} · agregado a mano
      </p>
    );
  }
  if (finding.reviewState === "confirmado") {
    return (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className={`inline-flex items-center gap-1.5 font-semibold text-ok ${size === "md" ? "text-sm" : "text-xs"}`}>
          <CheckIcon /> {CONFIRMED_LABEL[finding.severity]}
        </span>
        <button type="button" onClick={() => onDecide(finding, "falsa_alarma")} className={quiet}>
          Era una falsa alarma
        </button>
        <button type="button" onClick={() => onDecide(finding, "por_revisar")} className={quiet}>
          Volver a por revisar
        </button>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5" role="group" aria-label={REVIEW_QUESTION[finding.severity]}>
      <span className={`font-medium text-tinta ${size === "md" ? "text-sm" : "text-xs"}`}>{REVIEW_QUESTION[finding.severity]}</span>
      <span className="flex gap-1.5">
        <button type="button" onClick={() => onDecide(finding, "confirmado")} className={`${btn} bg-verde text-papel hover:bg-tinta`}>
          <CheckIcon /> {CONFIRM_ACTION}
        </button>
        <button type="button" onClick={() => onDecide(finding, "falsa_alarma")} className={`${btn} border border-linea-fuerte bg-hoja text-tinta hover:bg-papel`}>
          <CrossIcon /> {FALSE_ALARM_ACTION}
        </button>
      </span>
    </div>
  );
}
