// Historial de análisis ("Mi actividad"): validación del cuerpo y lógica de POST /api/historial.
// Sin dependencias del servidor: la ruta le pasa la guarda y el acceso a la base, así se prueba
// con dobles (tests/historial.test.mts).
//
// Sólo metadatos: nombre del archivo y conteos. Nunca el PDF, sus textos ni los de los hallazgos.
import { z } from "zod";
import type { ToolAccess } from "./guard";
import { cleanFileName, MAX_FILE_NAME, MAX_PAGES } from "./historial-limits";

export { cleanFileName, MAX_FILE_NAME, MAX_PAGES };
const MAX_COUNT = 1_000_000;
/** Un cuerpo válido mide unos 300 bytes; más que esto se rechaza sin leerlo. */
export const MAX_BODY_BYTES = 2048;

/** Límite de frecuencia por persona: un análisis tarda segundos por página, esto sobra. */
export const RATE_LIMITS = [
  { windowMs: 60_000, max: 10, label: "por minuto" },
  { windowMs: 24 * 60 * 60_000, max: 300, label: "por día" },
] as const;

const count = (max: number) => z.number().int().min(0).max(max);

export const historyEntrySchema = z
  .object({
    nombre_archivo: z
      .string()
      .transform(cleanFileName)
      .pipe(z.string().min(1, "Falta el nombre del archivo.").max(MAX_FILE_NAME, `El nombre del archivo supera ${MAX_FILE_NAME} caracteres.`)),
    paginas: z.number().int().min(1).max(MAX_PAGES),
    paginas_escaneadas: count(MAX_PAGES),
    choques: count(MAX_COUNT),
    duplicados: count(MAX_COUNT),
    cercanias: count(MAX_COUNT),
    paginas_no_verificadas: count(MAX_PAGES),
  })
  .strict()
  .refine((e) => e.paginas_escaneadas <= e.paginas, { message: "Hay más páginas escaneadas que páginas.", path: ["paginas_escaneadas"] })
  .refine((e) => e.paginas_no_verificadas <= e.paginas, { message: "Hay más páginas no verificadas que páginas.", path: ["paginas_no_verificadas"] });

export type HistoryEntry = z.infer<typeof historyEntrySchema>;

/** Lo que la ruta necesita del servidor. En producción: requireToolAccess y Supabase con service_role. */
export type HistoryDeps = {
  requireAccess: () => Promise<ToolAccess>;
  /** Cuántas filas guardó esta persona desde `since`. */
  countSince: (email: string, since: Date) => Promise<number>;
  insert: (row: HistoryEntry & { email: string }) => Promise<void>;
  now?: () => Date;
  log?: (msg: string) => void;
};

const json = (status: number, body: Record<string, unknown>) => Response.json(body, { status });

/** POST /api/historial: guarda una fila con los metadatos de un análisis terminado. */
export async function handleHistoryPost(request: Request, deps: HistoryDeps): Promise<Response> {
  const log = deps.log ?? ((m: string) => console.error(m));
  let access: ToolAccess;
  try {
    access = await deps.requireAccess();
  } catch (e) {
    log(`historial: no se pudo verificar el acceso: ${(e as Error).message}`);
    return json(500, { error: "No se pudo verificar el acceso." });
  }
  if (!access.ok) {
    return access.reason === "sin_sesion"
      ? json(401, { error: "Iniciá sesión." })
      : json(403, { error: "Tu cuenta no puede usar la herramienta." });
  }

  const declared = Number(request.headers.get("content-length"));
  if (declared > MAX_BODY_BYTES) return json(413, { error: "El cuerpo es demasiado grande." });
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return json(413, { error: "El cuerpo es demasiado grande." });

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return json(400, { error: "El cuerpo no es JSON válido." });
  }
  const parsed = historyEntrySchema.safeParse(raw);
  if (!parsed.success) {
    return json(400, { error: "Datos inválidos.", campos: [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(cuerpo)"))] });
  }

  const email = access.user.email.trim().toLowerCase();
  const now = (deps.now ?? (() => new Date()))();
  try {
    for (const limit of RATE_LIMITS) {
      const n = await deps.countSince(email, new Date(now.getTime() - limit.windowMs));
      if (n >= limit.max) {
        return new Response(JSON.stringify({ error: `Demasiados registros ${limit.label}. Probá más tarde.` }), {
          status: 429,
          headers: { "Content-Type": "application/json", "Retry-After": String(Math.ceil(limit.windowMs / 1000)) },
        });
      }
    }
    await deps.insert({ ...parsed.data, email });
  } catch (e) {
    log(`historial: no se pudo guardar: ${(e as Error).message}`);
    return json(500, { error: "No se pudo guardar el historial." });
  }
  return json(201, { ok: true });
}
