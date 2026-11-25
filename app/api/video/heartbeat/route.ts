import { requireAllowed } from "@/lib/guard";
import { recordHeartbeat } from "@/lib/progress";

export const runtime = "nodejs";

/**
 * Latido del reproductor: { position } en segundos. El usuario sale de la sesión (nunca del
 * cuerpo), y el crédito lo decide el servidor (lib/video.ts: monótono, no más que el tiempo real).
 */
export async function POST(request: Request) {
  const access = await requireAllowed();
  if (!access.ok) {
    const status = access.reason === "sin_sesion" ? 401 : 403;
    return Response.json({ error: status === 401 ? "Iniciá sesión para continuar." : "Tu cuenta no está habilitada." }, { status });
  }
  let position: number;
  try {
    const body = (await request.json()) as { position?: unknown };
    position = Number(body.position);
  } catch {
    return Response.json({ error: "Latido inválido." }, { status: 400 });
  }
  if (!Number.isFinite(position) || position < 0) return Response.json({ error: "Latido inválido." }, { status: 400 });

  try {
    const state = await recordHeartbeat(access.user, position);
    return Response.json(state, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("latido:", (e as Error).message);
    return Response.json({ error: "No se pudo guardar tu avance. Reintentamos en unos segundos." }, { status: 503 });
  }
}
