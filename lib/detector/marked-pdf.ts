// PDF con marcas: el PDF original con una caja por hallazgo y una hoja de resumen al final.
// Corre igual en el navegador y en Node (no usa DOM): nada pasa por el servidor.
import { PDFDocument, StandardFonts, degrees, rgb, type PDFFont, type PDFPage, type RGB } from "pdf-lib";
import type { Rect } from "./geometry";
import { AI_TEXT_NOTE, numberFindings, SEVERITY_LABEL, summarize, type NumberedFinding } from "./report";
import { LOW_RES_WARNING, type Finding, type PageResult, type Severity } from "./types";

/** Lo que pdfjs sabe de la página: `view` (CropBox ∩ MediaBox, [x0, y0, x1, y1]) y `/Rotate`. */
export type PageGeometry = { view: [number, number, number, number]; rotate: number };

type Matrix = [number, number, number, number, number, number];
type Point = [number, number];

/**
 * Matriz espacio PDF → pantalla de pdfjs a escala 1 (`page.getViewport({ scale: 1 }).transform`).
 * La pantalla dibuja las cajas en ese espacio: origen arriba a la izquierda, ya rotado y sin el
 * corrimiento de la caja de página. Es la misma cuenta que hace pdfjs (PageViewport).
 */
export function viewportTransform({ view, rotate }: PageGeometry): Matrix {
  const [x0, y0, x1, y1] = [Math.min(view[0], view[2]), Math.min(view[1], view[3]), Math.max(view[0], view[2]), Math.max(view[1], view[3])];
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const r = normalizeRotation(rotate);
  const [a, b, c, d] = r === 90 ? [0, 1, 1, 0] : r === 180 ? [-1, 0, 0, 1] : r === 270 ? [0, -1, -1, 0] : [1, 0, 0, -1];
  // Con la página acostada (90/270) el ancho en pantalla es el alto del PDF.
  const [ox, oy] = a === 0 ? [cy - y0, cx - x0] : [cx - x0, cy - y0];
  return [a, b, c, d, ox - a * cx - c * cy, oy - b * cx - d * cy];
}

function normalizeRotation(rotate: number): 0 | 90 | 180 | 270 {
  // pdfjs ignora rotaciones que no son múltiplo de 90.
  if (!Number.isFinite(rotate) || rotate % 90 !== 0) return 0;
  return (((rotate % 360) + 360) % 360) as 0 | 90 | 180 | 270;
}

/** Tamaño de la página tal como se ve (en pantalla y en el visor): ancho × alto ya rotados. */
export function viewportSize(g: PageGeometry): { w: number; h: number } {
  const w = Math.abs(g.view[2] - g.view[0]);
  const h = Math.abs(g.view[3] - g.view[1]);
  return normalizeRotation(g.rotate) % 180 === 0 ? { w, h } : { w: h, h: w };
}

function invert([a, b, c, d, e, f]: Matrix): Matrix {
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

const apply = (m: Matrix, [x, y]: Point): Point => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/** Convierte un punto de pantalla (origen arriba-izquierda) a espacio PDF (origen abajo-izquierda). */
export function screenToPdf(g: PageGeometry): (p: Point) => Point {
  const inv = invert(viewportTransform(g));
  return (p) => apply(inv, p);
}

/** Caja de pantalla → rectángulo PDF (esquina inferior izquierda + tamaño). Con rotación las esquinas se reordenan. */
export function screenRectToPdf(box: Rect, g: PageGeometry): Rect {
  const toPdf = screenToPdf(g);
  const pts = [toPdf([box.x, box.y]), toPdf([box.x + box.w, box.y + box.h])];
  const x = Math.min(pts[0][0], pts[1][0]);
  const y = Math.min(pts[0][1], pts[1][1]);
  return { x, y, w: Math.abs(pts[0][0] - pts[1][0]), h: Math.abs(pts[0][1] - pts[1][1]) };
}

/**
 * Caja del hallazgo en pt de pantalla. Las de IA salen de la caja normalizada (0–1) escalada al
 * tamaño de la página, igual que se ubican sobre el render; las vectoriales, de la caja en pt.
 */
export function findingScreenBox(f: Finding, page: Pick<PageResult, "width" | "height">): Rect {
  if (f.source === "vision" && page.width > 0 && page.height > 0) {
    return { x: f.boxNorm.x * page.width, y: f.boxNorm.y * page.height, w: f.boxNorm.w * page.width, h: f.boxNorm.h * page.height };
  }
  return f.box;
}

/** Grosor, número y márgenes proporcionales al lado corto de la página (A3 y A4 se ven parejos). */
export function markStyle(size: { w: number; h: number }) {
  const s = Math.min(size.w, size.h);
  const lineWidth = s / 560; // A4 ≈ 1,1 pt · A3 ≈ 1,5 pt: visible sin tachar el renglón vecino
  return {
    lineWidth,
    halo: lineWidth * 0.6,
    radius: s * 0.0095, // A4 ≈ 5,7 pt · A3 ≈ 8 pt
    pad: Math.max(3, lineWidth * 1.5),
    /** Lado mínimo de la caja: una zona de un par de letras igual tiene que verse. */
    minSide: s * 0.025,
  };
}

/** Caja a dibujar en pantalla: con margen, agrandada hasta el mínimo y sin salirse de la hoja. */
export function markScreenBox(box: Rect, size: { w: number; h: number }): Rect {
  const { pad, minSide } = markStyle(size);
  let { x, y, w, h } = { x: box.x - pad, y: box.y - pad, w: box.w + 2 * pad, h: box.h + 2 * pad };
  if (w < minSide) [x, w] = [x - (minSide - w) / 2, minSide];
  if (h < minSide) [y, h] = [y - (minSide - h) / 2, minSide];
  x = Math.max(0, Math.min(x, size.w - w));
  y = Math.max(0, Math.min(y, size.h - h));
  return { x, y, w: Math.min(w, size.w), h: Math.min(h, size.h) };
}

// WinAnsi (lo que codifican las fuentes estándar): ASCII, Latin-1 y los extras de 0x80–0x9F.
const WIN_ANSI_EXTRA = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";

function isWinAnsi(ch: string): boolean {
  const c = ch.codePointAt(0)!;
  return (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || WIN_ANSI_EXTRA.includes(ch);
}

/** Deja sólo caracteres que Helvetica estándar puede escribir: saca acentos raros y cambia el resto por "?". */
export function toWinAnsi(text: string): string {
  let out = "";
  for (const ch of text.replace(/[\r\n\t]+/g, " ")) {
    if (isWinAnsi(ch)) out += ch;
    else {
      // Sólo a las letras se les saca el acento (Ő → O); a un símbolo (≠ → =) cambiaría el sentido.
      const base = /\p{L}/u.test(ch) ? ch.normalize("NFD").replace(/\p{M}/gu, "") : "";
      out += base && [...base].every(isWinAnsi) ? base : "?";
    }
  }
  return out;
}

export function markedFileName(name: string): string {
  return `${name.replace(/\.pdf$/i, "")}-con-marcas.pdf`;
}

const hex = (h: string): RGB => rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);
/** Mismos colores que la pantalla (PageView). */
const COLOR: Record<Severity, RGB> = { choque: hex("#c2261d"), cercania: hex("#9a6200"), duplicado: hex("#5b6b68") };
const FILL_OPACITY: Record<Severity, number> = { choque: 0.1, cercania: 0.08, duplicado: 0.08 };
const WHITE = rgb(1, 1, 1);
const INK = hex("#0d211f");
const GRAY = hex("#5b6b68");

function drawMark(page: PDFPage, f: NumberedFinding, result: PageResult, g: PageGeometry, bold: PDFFont) {
  const size = viewportSize(g);
  const st = markStyle(size);
  const screen = markScreenBox(findingScreenBox(f, result), size);
  const rect = screenRectToPdf(screen, g);
  const color = COLOR[f.severity];
  const dash = f.severity === "cercania" ? [st.lineWidth * 3, st.lineWidth * 2] : undefined;

  // Sin halo blanco (a diferencia de la pantalla): en el PDF taparía para siempre el texto vecino.
  page.drawRectangle({
    x: rect.x,
    y: rect.y,
    width: rect.w,
    height: rect.h,
    color,
    opacity: FILL_OPACITY[f.severity],
    borderColor: color,
    borderWidth: st.lineWidth,
    borderDashArray: dash,
  });

  // Número en la esquina superior izquierda (de la página tal como se ve), centrado en el vértice.
  const label = String(f.n);
  const fontSize = st.radius * 1.15;
  const tw = bold.widthOfTextAtSize(label, fontSize);
  const radius = Math.max(st.radius, tw / 2 + st.radius * 0.35);
  const toPdf = screenToPdf(g);
  const [cx, cy] = toPdf([screen.x, screen.y]);
  page.drawCircle({ x: cx, y: cy, size: radius, color, borderColor: WHITE, borderWidth: st.halo * 2 });
  // El texto se escribe derecho para quien mira la página: su línea base sigue el eje x de pantalla.
  const capHeight = fontSize * 0.718; // Helvetica-Bold
  const origin = toPdf([screen.x - tw / 2, screen.y + capHeight / 2]);
  const along = toPdf([screen.x + 1, screen.y]);
  const angle = (Math.atan2(along[1] - cy, along[0] - cx) * 180) / Math.PI;
  page.drawText(label, { x: origin[0], y: origin[1], size: fontSize, font: bold, color: WHITE, rotate: degrees(angle) });
}

function formatDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) <= width) line = next;
    else {
      if (line) lines.push(line);
      // Una palabra más larga que la columna se corta a la fuerza.
      let rest = word;
      while (font.widthOfTextAtSize(rest, size) > width && rest.length > 1) {
        let cut = rest.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(rest.slice(0, cut), size) > width) cut--;
        lines.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      line = rest;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

type SummaryInput = { fileName: string; pages: PageResult[]; findings: NumberedFinding[]; showNear: boolean; date: Date };

/** Hoja(s) de resumen en A4 vertical al final del documento. */
function addSummary(doc: PDFDocument, input: SummaryInput, fonts: { regular: PDFFont; bold: PDFFont; italic: PDFFont }) {
  const W = 595.28;
  const H = 841.89;
  const M = 48;
  const { regular, bold, italic } = fonts;
  const sheets: PDFPage[] = [];
  let page!: PDFPage;
  let y = 0;
  const newSheet = () => {
    page = doc.addPage([W, H]);
    sheets.push(page);
    y = H - M;
  };
  const ensure = (h: number) => {
    if (y - h < M + 14) {
      newSheet();
      tableHeader();
    }
  };
  const text = (s: string, x: number, size: number, font = regular, color = INK) =>
    page.drawText(toWinAnsi(s), { x, y, size, font, color });
  const para = (s: string, size = 10, font = regular, color = INK) => {
    for (const line of wrap(toWinAnsi(s), font, size, W - 2 * M)) {
      text(line, M, size, font, color);
      y -= size * 1.4;
    }
  };

  // Columnas de la lista.
  const col = { n: M, page: M + 34, type: M + 70, zone: M + 136, texts: M + 290 };
  const colEnd = W - M;
  const tableHeader = () => {
    for (const [k, label] of [["n", "N.º"], ["page", "Pág."], ["type", "Tipo"], ["zone", "Zona"], ["texts", "Textos involucrados"]] as const) {
      text(label, col[k], 8.5, bold, GRAY);
    }
    y -= 6;
    page.drawLine({ start: { x: M, y }, end: { x: colEnd, y }, thickness: 0.6, color: GRAY });
    y -= 14;
  };

  newSheet();
  text("Textos superpuestos: resumen", M, 18, bold);
  y -= 28;
  const s = summarize(input.pages);
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  para(`Archivo: ${input.fileName}`, 10.5);
  para(`Fecha: ${formatDate(input.date)}`, 10.5);
  para(`Páginas revisadas: ${input.pages.length}`, 10.5);
  y -= 4;
  para(
    `${plural(s.choques, "choque", "choques")} · ${plural(s.duplicados, "duplicado", "duplicados")} · ${plural(s.cercanias, "cercanía", "cercanías")}`,
    12,
    bold,
  );
  y -= 4;
  if (!input.showNear && s.cercanias) {
    para(`Las cercanías no se marcaron en el plano ni se listan abajo: "Mostrar cercanías" estaba apagado.`, 9.5, regular, GRAY);
  }

  const unverified = [...input.pages].filter((p) => p.status === "no_verificada").sort((a, b) => a.page - b.page);
  if (unverified.length) {
    y -= 4;
    para(
      `Atención: ${unverified.length === 1 ? "1 página no se pudo verificar" : `${unverified.length} páginas no se pudieron verificar`}. Sus textos pueden chocar aunque no figuren acá.`,
      10.5,
      bold,
      COLOR.cercania,
    );
    for (const p of unverified) para(`Página ${p.page}: ${p.error ?? "no se pudo analizar."}`, 9.5, regular, INK);
  } else {
    para("Todas las páginas se verificaron.", 9.5, regular, GRAY);
  }
  const lowRes = [...input.pages].filter((p) => p.lowResolution).sort((a, b) => a.page - b.page);
  if (lowRes.length) {
    y -= 4;
    para(
      `${lowRes.length === 1 ? "Página" : "Páginas"} ${lowRes.map((p) => p.page).join(", ")}: ${LOW_RES_WARNING.charAt(0).toLowerCase()}${LOW_RES_WARNING.slice(1)}`,
      10.5,
      bold,
      COLOR.cercania,
    );
  }
  if (input.findings.some((f) => f.source === "vision")) {
    para(`Los textos de las páginas escaneadas los leyó la IA y pueden tener errores: van rotulados "${AI_TEXT_NOTE}".`, 9.5, regular, GRAY);
  }

  y -= 14;
  const listed = input.findings.filter((f) => input.showNear || f.severity !== "cercania");
  if (!listed.length) {
    para("No hay hallazgos para marcar.", 10.5);
  } else {
    tableHeader();
    const size = 9;
    const lh = size * 1.35;
    for (const f of listed) {
      const zone = wrap(toWinAnsi(f.zone), regular, size, col.texts - col.zone - 10);
      const texts = wrap(toWinAnsi(f.texts.join(" / ") || "Textos ilegibles"), regular, size, colEnd - col.texts);
      const note = f.source === "vision" ? wrap(toWinAnsi(AI_TEXT_NOTE), italic, size - 1, colEnd - col.texts) : [];
      const rows = Math.max(zone.length, texts.length + note.length);
      ensure(rows * lh + 6);
      // Número en un círculo del color del hallazgo, como en la lista de la pantalla.
      const r = 6.5;
      page.drawCircle({ x: col.n + r, y: y + size * 0.35, size: r, color: COLOR[f.severity] });
      const label = String(f.n);
      const ls = label.length > 2 ? 6 : 7.5;
      page.drawText(label, { x: col.n + r - bold.widthOfTextAtSize(label, ls) / 2, y: y + size * 0.35 - ls * 0.36, size: ls, font: bold, color: WHITE });
      text(String(f.page), col.page, size);
      text(SEVERITY_LABEL[f.severity], col.type, size, bold, COLOR[f.severity]);
      const top = y;
      zone.forEach((l, i) => page.drawText(l, { x: col.zone, y: top - i * lh, size, font: regular, color: INK }));
      texts.forEach((l, i) => page.drawText(l, { x: col.texts, y: top - i * lh, size, font: regular, color: INK }));
      note.forEach((l, i) => page.drawText(l, { x: col.texts, y: top - (texts.length + i) * lh, size: size - 1, font: italic, color: GRAY }));
      y -= rows * lh + 6;
    }
  }

  sheets.forEach((sheet, i) => {
    const label = toWinAnsi(`${input.fileName} · resumen${sheets.length > 1 ? ` ${i + 1} de ${sheets.length}` : ""}`);
    sheet.drawText(label, { x: M, y: M - 20, size: 8, font: regular, color: GRAY });
  });
}

export type MarkedPdfInput = {
  /** Bytes del PDF que subió la persona (no se modifica). */
  bytes: ArrayBuffer | Uint8Array;
  fileName: string;
  pages: PageResult[];
  /** Geometría de cada página según pdfjs, por número de página. */
  geometry: Record<number, PageGeometry>;
  showNear: boolean;
  date?: Date;
};

/** Arma el PDF con marcas. Lanza si pdf-lib no puede abrir el archivo (p. ej. protegido). */
export async function buildMarkedPdf(input: MarkedPdfInput): Promise<Uint8Array> {
  const doc = await PDFDocument.load(input.bytes, { updateMetadata: false });
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const italic = await doc.embedFont(StandardFonts.HelveticaOblique);
  const findings = numberFindings(input.pages);
  const byPage = new Map(input.pages.map((p) => [p.page, p]));
  const pdfPages = doc.getPages();

  for (const f of findings) {
    if (!input.showNear && f.severity === "cercania") continue;
    const page = pdfPages[f.page - 1];
    const result = byPage.get(f.page);
    const g = input.geometry[f.page];
    if (!page || !result || !g) continue;
    drawMark(page, f, result, g, bold);
  }

  addSummary(doc, { fileName: input.fileName, pages: input.pages, findings, showNear: input.showNear, date: input.date ?? new Date() }, { regular, bold, italic });
  return doc.save();
}
