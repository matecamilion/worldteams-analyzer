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

export function summarize(pages: PageResult[]) {
  const all = pages.flatMap((p) => p.findings);
  return {
    choques: all.filter((f) => f.severity === "choque").length,
    cercanias: all.filter((f) => f.severity === "cercania").length,
    duplicados: all.filter((f) => f.severity === "duplicado").length,
    noVerificadas: pages.filter((p) => p.status === "no_verificada").length,
  };
}

function cell(v: string | number): string {
  const s = String(v);
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * CSV con ";" (Excel en español lo abre en columnas) y BOM UTF-8 para que respete los acentos.
 * Las páginas no verificadas van como fila propia: un reporte no puede callarlas.
 */
export function toCsv(fileName: string, pages: PageResult[]): string {
  const numbered = numberFindings(pages);
  const header = [
    "archivo",
    "pagina",
    "numero",
    "tipo",
    "textos",
    "zona",
    "origen",
    "confianza",
    "x_pt",
    "y_pt",
    "ancho_pt",
    "alto_pt",
    "estado_pagina",
  ];
  const rows: (string | number)[][] = [];
  for (const p of [...pages].sort((a, b) => a.page - b.page)) {
    const estado = p.status === "ok" ? "verificada" : "no verificada";
    const own = numbered.filter((f) => f.page === p.page);
    if (p.status === "no_verificada") {
      rows.push([fileName, p.page, "", "Página no verificada", p.error ?? "", "", "", "", "", "", "", "", estado]);
    }
    for (const f of own) {
      rows.push([
        fileName,
        f.page,
        f.n,
        SEVERITY_LABEL[f.severity],
        f.texts.join(" / "),
        f.zone,
        f.originLabel,
        f.confidence.toFixed(2).replace(".", ","),
        f.box.x.toFixed(1).replace(".", ","),
        f.box.y.toFixed(1).replace(".", ","),
        f.box.w.toFixed(1).replace(".", ","),
        f.box.h.toFixed(1).replace(".", ","),
        estado,
      ]);
    }
  }
  return "﻿" + [header, ...rows].map((r) => r.map(cell).join(";")).join("\r\n") + "\r\n";
}
