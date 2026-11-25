"use client";

import type { PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";

let lib: typeof import("pdfjs-dist/legacy/build/pdf.mjs") | null = null;

/** Carga pdfjs sólo en el navegador y apunta el worker al archivo servido desde /public. */
async function pdfjs() {
  if (!lib) {
    lib = await import("pdfjs-dist/legacy/build/pdf.mjs");
    lib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
  }
  return lib;
}

export async function openPdf(data: ArrayBuffer): Promise<PDFDocumentProxy> {
  const { getDocument } = await pdfjs();
  // pdfjs se queda con el buffer (lo transfiere al worker): le pasamos una copia.
  return getDocument({ data: new Uint8Array(data.slice(0)) }).promise;
}

export const MAX_PDF_BYTES = 4 * 1024 * 1024;

/** Valida tipo, tamaño y firma "%PDF-". Devuelve un mensaje de error o null. */
export async function validatePdfFile(file: File): Promise<string | null> {
  const looksPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  if (!looksPdf) return `"${file.name}" no es un PDF. Subí un archivo .pdf.`;
  if (file.size === 0) return "El archivo está vacío.";
  if (file.size > MAX_PDF_BYTES) {
    return `El PDF pesa ${(file.size / 1024 / 1024).toFixed(1)} MB y el máximo es 4 MB. Probá exportarlo con menor resolución.`;
  }
  const head = new Uint8Array(await file.slice(0, 5).arrayBuffer());
  if (String.fromCharCode(...head) !== "%PDF-") return `"${file.name}" tiene extensión .pdf pero no es un PDF válido.`;
  return null;
}
