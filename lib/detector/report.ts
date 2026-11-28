import type { Finding, PageResult, Severity } from "./types";

export const SEVERITY_LABEL: Record<Severity, string> = {
  choque: "Choque",
  cercania: "Cercanía",
  duplicado: "Duplicado",
};

/** Sin revisar: la herramienta lo propone, la persona todavía no decidió. */
export const POSSIBLE_LABEL: Record<Severity, string> = {
  choque: "Posible choque",
  cercania: "Posible cercanía",
  duplicado: "Posible duplicado",
};
/** Confirmado por la persona (o agregado a mano). */
export const CONFIRMED_LABEL: Record<Severity, string> = {
  choque: "Choque confirmado",
  cercania: "Cercanía confirmada",
  duplicado: "Duplicado confirmado",
};
/** La pregunta que se le hace a la persona sobre cada hallazgo sin revisar. */
export const REVIEW_QUESTION: Record<Severity, string> = {
  choque: "¿Es un choque real?",
  cercania: "¿Es una cercanía real?",
  duplicado: "¿Es un duplicado real?",
};
export const FALSE_ALARM_LABEL = "Falsa alarma";
export const CONFIRM_ACTION = "Sí, es real";
export const FALSE_ALARM_ACTION = "No, falsa alarma";

/** Etiqueta de un hallazgo según su estado de revisión. */
export const reviewLabel = (f: Pick<Finding, "severity" | "reviewState">) =>
  f.reviewState === "confirmado" ? CONFIRMED_LABEL[f.severity] : POSSIBLE_LABEL[f.severity];

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
