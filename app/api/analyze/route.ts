import { loadPdf } from "@/lib/detector/pdf";
import { analyzeVector, inspectPage } from "@/lib/detector/analyze";
import { analyzeImagePage } from "@/lib/detector/image";
import { getVisionProvider } from "@/lib/vision";
import type { PageResult } from "@/lib/detector/types";
import { requireToolAccess } from "@/lib/guard";

export const runtime = "nodejs";
/**
 * Una página por request: la visión de una página medida tarda 5–35 s (4 llamadas en paralelo,
 * con hasta 2 reintentos). 120 s deja margen y entra en cualquier plan de Vercel
 * (Hobby: máximo 300 s con Fluid compute).
 */
export const maxDuration = 120;

const MAX_PDF_BYTES = 4 * 1024 * 1024; // Vercel acepta cuerpos de hasta 4,5 MB.

// TODO(etapa Supabase): leer el PDF desde Storage en vez de reenviarlo en cada request.
export async function POST(request: Request) {
  // El bloqueo se valida acá, en el servidor: ocultar el botón no alcanza.
  const access = await requireToolAccess();
  if (!access.ok) {
    const [status, error] =
      access.reason === "sin_sesion"
        ? [401, "Iniciá sesión para usar la herramienta."]
        : access.reason === "no_habilitado"
          ? [403, "Tu cuenta no está habilitada para usar esta herramienta."]
          : [403, "Terminá el video de inducción para usar la herramienta."];
    return Response.json({ error }, { status });
  }
  const url = new URL(request.url);
  const pageNumber = Number(url.searchParams.get("page"));
  if (!Number.isInteger(pageNumber) || pageNumber < 1) {
    return Response.json({ error: "Indicá la página con ?page=N." }, { status: 400 });
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.length) return Response.json({ error: "Falta el PDF." }, { status: 400 });
  if (bytes.length > MAX_PDF_BYTES) return Response.json({ error: "El PDF supera los 4 MB." }, { status: 413 });

  const started = Date.now();
  let doc;
  try {
    doc = await loadPdf(bytes);
  } catch {
    return Response.json({ error: "El archivo no es un PDF válido." }, { status: 422 });
  }
  if (pageNumber > doc.numPages) {
    return Response.json({ error: `El PDF tiene ${doc.numPages} páginas.` }, { status: 400 });
  }

  const page = await doc.getPage(pageNumber);
  const info = await inspectPage(page);
  let result: PageResult;
  if (info.kind === "vector") {
    result = { ...analyzeVector(pageNumber, info), status: "ok", ms: Date.now() - started };
  } else if (info.kind === "image") {
    const provider = getVisionProvider();
    result = provider
      ? await analyzeImagePage(pageNumber, page, provider)
      : {
          page: pageNumber,
          kind: "image",
          width: info.width,
          height: info.height,
          textCount: 0,
          findings: [],
          status: "no_verificada",
          error: "No hay proveedor de visión configurado en el servidor.",
          ms: Date.now() - started,
        };
  } else {
    result = {
      page: pageNumber,
      kind: "empty",
      width: info.width,
      height: info.height,
      textCount: 0,
      findings: [],
      status: "no_verificada",
      error: "La página no tiene texto ni imágenes para revisar.",
      ms: Date.now() - started,
    };
  }
  return Response.json({ pages: doc.numPages, result });
}
