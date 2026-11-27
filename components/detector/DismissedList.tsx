"use client";

import { SEVERITY_LABEL } from "@/lib/detector/report";
import type { DismissedFinding } from "@/lib/detector/review";

type Props = {
  items: DismissedFinding[];
  onRestore: (page: number, firma: string) => void;
  onClose: () => void;
};

/** Hallazgos que la persona marcó como "Está bien", con la opción de volver a mostrarlos. */
export function DismissedList({ items, onRestore, onClose }: Props) {
  const sorted = [...items].sort((a, b) => a.page - b.page || a.box.y - b.box.y || a.box.x - b.box.x);
  return (
    <section id="descartados" aria-labelledby="descartados-titulo" className="scroll-mt-32 rounded-md border border-linea bg-hoja">
      <header className="flex items-center justify-between gap-3 border-b border-linea px-4 py-2.5">
        <h2 id="descartados-titulo" className="font-display text-base font-semibold">
          Descartados ({items.length})
        </h2>
        <button type="button" onClick={onClose} className="rounded px-2 py-1 text-sm text-gris hover:bg-papel hover:text-tinta">
          Cerrar
        </button>
      </header>
      <p className="border-b border-linea px-4 py-1.5 text-xs text-gris">
        Los marcaste como &laquo;Está bien&raquo;: no se cuentan, no se marcan en el plano ni en el PDF. Se guardan en este navegador.
      </p>
      <ul className="divide-y divide-linea">
        {sorted.map((f) => (
          <li key={`${f.page}-${f.id}`} className="flex items-center gap-3 px-4 py-2 text-sm">
            <span className="min-w-0 flex-1">
              <span className="block font-medium break-words">{f.texts.join(" × ") || "Textos ilegibles"}</span>
              <span className="block text-xs text-gris">
                Página {f.page} · {SEVERITY_LABEL[f.severity]} · {f.zone}
              </span>
            </span>
            <button
              type="button"
              onClick={() => onRestore(f.page, f.firma)}
              className="shrink-0 rounded border border-linea-fuerte bg-hoja px-2.5 py-1 font-medium hover:bg-papel"
            >
              Volver a mostrar
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
