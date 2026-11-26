// Separación de textos que pdfjs combina en un solo ítem.
//
// pdfjs 6 une en un mismo ítem dos tramos del mismo renglón si el hueco entre ellos es menor
// que ~0,1 × el cuerpo (y ya no tiene opción para desactivarlo). Dos rótulos distintos a 1 pt
// —justo una "cercanía"— quedan como un solo texto. Acá se reconstruyen los tramos desde la
// lista de operaciones del PDF y se separa un ítem sólo cuando junta tramos de bloques de texto
// (BT…ET) distintos y todo coincide con lo que entregó pdfjs; si algo no cuadra, se deja igual.
import type { PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { RawTextItem } from "./vector";

type M = [number, number, number, number, number, number];
const mul = (m: M, n: M): M => [
  m[0] * n[0] + m[1] * n[2],
  m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2],
  m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4],
  m[4] * n[1] + m[5] * n[3] + n[5],
];
const ID: M = [1, 0, 0, 1, 0, 0];
const toM = (a: unknown): M => {
  const o = a as Record<number, number>;
  return [o[0], o[1], o[2], o[3], o[4], o[5]];
};

/** Un tramo = una operación de mostrar texto. `block` identifica su BT…ET. */
export type OpRun = RawTextItem & { block: number };

type Glyph = { unicode?: string; width?: number; isSpace?: boolean } | number | null;

export async function extractOpRuns(page: PDFPageProxy): Promise<OpRun[]> {
  const { OPS } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const ops = await page.getOperatorList();
  const runs: OpRun[] = [];
  let ctm: M = ID;
  const stack: M[] = [];
  let tm: M = ID;
  let tlm: M = ID;
  let fontSize = 0;
  let leading = 0;
  let charSpacing = 0;
  let wordSpacing = 0;
  let hScale = 1;
  let block = 0;

  const moveText = (tx: number, ty: number) => {
    tlm = mul([1, 0, 0, 1, tx, ty], tlm);
    tm = tlm;
  };

  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i] as unknown[];
    switch (fn) {
      case OPS.save:
        stack.push(ctm);
        break;
      case OPS.restore:
        ctm = stack.pop() ?? ID;
        break;
      case OPS.transform:
        ctm = mul(args as unknown as M, ctm);
        break;
      case OPS.beginText:
        block++;
        tm = tlm = ID;
        break;
      case OPS.setTextMatrix:
        tm = tlm = toM(args[0] ?? args);
        break;
      case OPS.moveText:
        moveText(args[0] as number, args[1] as number);
        break;
      case OPS.setLeadingMoveText:
        leading = -(args[1] as number);
        moveText(args[0] as number, args[1] as number);
        break;
      case OPS.nextLine:
        moveText(0, -leading);
        break;
      case OPS.setLeading:
        leading = args[0] as number;
        break;
      case OPS.setFont:
        fontSize = args[1] as number;
        break;
      case OPS.setCharSpacing:
        charSpacing = args[0] as number;
        break;
      case OPS.setWordSpacing:
        wordSpacing = args[0] as number;
        break;
      case OPS.setHScale:
        hScale = (args[0] as number) / 100;
        break;
      case OPS.showText: {
        const glyphs = (args[0] ?? []) as Glyph[];
        let str = "";
        let advance = 0; // en espacio de texto
        for (const g of glyphs) {
          if (typeof g === "number") {
            advance += (-g / 1000) * fontSize * hScale;
            continue;
          }
          if (!g) continue;
          str += g.unicode ?? "";
          advance += ((g.width ?? 0) / 1000) * fontSize * hScale + charSpacing * hScale + (g.isSpace ? wordSpacing * hScale : 0);
        }
        const trm = mul([fontSize * hScale, 0, 0, fontSize, 0, 0], mul(tm, ctm));
        const scale = Math.hypot(mul(tm, ctm)[0], mul(tm, ctm)[1]);
        if (str.trim()) runs.push({ str, transform: trm, width: advance * scale, block });
        tm = mul([1, 0, 0, 1, advance, 0], tm);
        break;
      }
    }
  }
  return runs;
}

const squash = (s: string) => s.replace(/\s+/g, "");

/**
 * Reemplaza cada ítem de pdfjs que junta tramos de bloques BT…ET distintos por esos tramos.
 * Condiciones (si no se cumplen, el ítem queda tal cual): los tramos están sobre la línea base
 * del ítem, dentro de su largo, con el mismo cuerpo; sus textos concatenados son el texto del
 * ítem; y el largo total coincide (±5 %).
 */
export function splitCombinedItems(items: RawTextItem[], runs: OpRun[]): (RawTextItem & { block?: number })[] {
  const out: (RawTextItem & { block?: number })[] = [];
  for (const item of items) {
    const [a, b, c, d, e, f] = item.transform;
    const fs = Math.hypot(c, d);
    const sx = Math.hypot(a, b);
    if (!fs || !sx) {
      out.push(item);
      continue;
    }
    const ux = a / sx;
    const uy = b / sx;
    const parts = runs
      .map((r) => {
        const dx = r.transform[4] - e;
        const dy = r.transform[5] - f;
        return { r, along: dx * ux + dy * uy, across: -dx * uy + dy * ux };
      })
      .filter(
        (p) =>
          Math.abs(p.across) < 0.1 * fs &&
          p.along > -0.5 &&
          p.along < item.width - 0.5 &&
          Math.abs(Math.hypot(p.r.transform[2], p.r.transform[3]) - fs) < 0.05 * fs,
      )
      .sort((p, q) => p.along - q.along);

    const blocks = new Set(parts.map((p) => p.r.block));
    const last = parts[parts.length - 1];
    const sameText = squash(parts.map((p) => p.r.str).join("")) === squash(item.str);
    const sameLength = last && Math.abs(last.along + last.r.width - item.width) <= 0.05 * item.width + 0.5;
    if (parts.length < 2 || blocks.size < 2 || !sameText || !sameLength) {
      out.push(item);
      continue;
    }
    // Tramos contiguos del mismo bloque siguen siendo un solo texto.
    const groups: (typeof parts)[] = [];
    for (const p of parts) {
      const g = groups[groups.length - 1];
      if (g && g[0].r.block === p.r.block) g.push(p);
      else groups.push([p]);
    }
    for (const g of groups) {
      const first = g[0];
      const end = g[g.length - 1];
      out.push({
        str: g.map((p) => p.r.str).join(""),
        transform: first.r.transform,
        width: end.along + end.r.width - first.along,
        block: first.r.block,
      });
    }
  }
  return out;
}
