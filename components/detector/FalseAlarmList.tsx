"use client";

import { FALSE_ALARM_LABEL, SEVERITY_LABEL } from "@/lib/detector/report";
import type { ReviewState } from "@/lib/detector/review";
import type { Finding } from "@/lib/detector/types";

type Props = {
  items: Finding[];
  onDecide: (finding: Finding, state: ReviewState) => void;
  onClose: () => void;
};

/** Lo que la persona marcó como falsa alarma, con la opción de cambiar de idea. */
export function FalseAlarmList({ items, onDecide, onClose }: Props) {
  const sorted = [...items].sort((a, b) => a.page - b.page || a.box.y - b.box.y || a.box.x - b.box.x);
  return (
    <section id="falsas-alarmas" aria-labelledby="falsas-alarmas-titulo" className="scroll-mt-32 rounded-md border border-linea bg-hoja">
      <header className="flex items-center justify-between gap-3 border-b border-linea px-4 py-2.5">
        <h2 id="falsas-alarmas-titulo" className="font-display text-base font-semibold">
          Falsas alarmas ({items.length})
        </h2>
        <button type="button" onClick={onClose} className="rounded px-2 py-1 text-sm text-gris hover:bg-papel hover:text-tinta">
          Cerrar
        </button>
      </header>
      <p className="border-b border-linea px-4 py-1.5 text-xs text-gris">
        Las marcaste como &laquo;No, falsa alarma&raquo;: no se cuentan ni se marcan en el plano ni en el informe. Se guardan en este navegador.
      </p>
      <ul className="divide-y divide-linea">
        {sorted.map((f) => (
          <li key={`${f.page}-${f.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2 text-sm">
            <span className="min-w-0 flex-1 basis-48">
              <span className="block font-medium break-words">{f.texts.join(" × ") || "Textos ilegibles"}</span>
              <span className="block text-xs text-gris">
                {FALSE_ALARM_LABEL} · Página {f.page} · {SEVERITY_LABEL[f.severity]} · {f.zone}
              </span>
            </span>
            <span className="flex shrink-0 gap-1.5">
              <button
                type="button"
                onClick={() => onDecide(f, "por_revisar")}
                className="rounded border border-linea-fuerte bg-hoja px-2.5 py-1 text-xs font-medium hover:bg-papel"
              >
                Volver a por revisar
              </button>
              <button
                type="button"
                onClick={() => onDecide(f, "confirmado")}
                className="rounded border border-linea-fuerte bg-hoja px-2.5 py-1 text-xs font-medium hover:bg-papel"
              >
                Era real
              </button>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
