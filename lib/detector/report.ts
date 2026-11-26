import type { Finding, PageResult, Severity } from "./types";

export const SEVERITY_LABEL: Record<Severity, string> = {
  choque: "Choque",
  cercania: "Cercanía",
  duplicado: "Duplicado",
};

/** Hallazgo con número correlativo en todo el documento (el que se ve sobre la hoja). */
export type NumberedFinding = Finding & { n: number };

const ORDER: Record<Severity, number> = { choque: 0, cercania: 1, duplicado: 2 };

/** Numera por página, y dentro de la página primero choques y después de arriba hacia abajo. */
export function numberFindings(pages: PageResult[]): NumberedFinding[] {
  let n = 0;
  return [...pages]
    .sort((a, b) => a.page - b.page)
    .flatMap((p) =>
      [...p.findings].sort(
        (a, b) => ORDER[a.severity] - ORDER[b.severity] || a.box.y - b.box.y || a.box.x - b.box.x,
      ),
    )
    .map((f) => ({ ...f, n: ++n }));
}

/** Leyenda de los textos transcriptos por el modelo de visión: pueden estar mal leídos. */
export const AI_TEXT_NOTE = "texto leído por IA (aproximado)";

export function summarize(pages: PageResult[]) {
  const all = pages.flatMap((p) => p.findings);
  return {
    choques: all.filter((f) => f.severity === "choque").length,
    cercanias: all.filter((f) => f.severity === "cercania").length,
    duplicados: all.filter((f) => f.severity === "duplicado").length,
    noVerificadas: pages.filter((p) => p.status === "no_verificada").length,
  };
}
