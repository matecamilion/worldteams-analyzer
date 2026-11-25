import { readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { extractLargestImage, loadPdf } from "@/lib/detector/pdf";

// Diagnóstico temporal: verifica que pdfjs + sharp funcionan en el runtime de Vercel
// con la página-imagen del PDF de ejemplo. Se elimina antes de la entrega.
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET() {
  const started = Date.now();
  try {
    const file = await readFile(path.join(process.cwd(), "samples", "planos-prueba.pdf"));
    const doc = await loadPdf(new Uint8Array(file));
    const page = await doc.getPage(6);
    const text = await page.getTextContent();
    const img = await extractLargestImage(page);
    if (!img) return Response.json({ ok: false, error: "sin imagen" }, { status: 500 });

    const base = sharp(Buffer.from(img.data), {
      raw: { width: img.width, height: img.height, channels: img.channels },
    });
    const tile = await base.clone().extract({ left: 0, top: 0, width: 1024, height: 1024 }).jpeg({ quality: 85 }).toBuffer();

    return Response.json({
      ok: true,
      pages: doc.numPages,
      textItems: text.items.length,
      image: { width: img.width, height: img.height, channels: img.channels, placement: img.placement },
      tileBytes: tile.length,
      ms: Date.now() - started,
    });
  } catch (error) {
    return Response.json({ ok: false, error: String(error), ms: Date.now() - started }, { status: 500 });
  }
}
