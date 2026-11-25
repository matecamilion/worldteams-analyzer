import "server-only";

export type ToolAccess = { ok: true; email: string | null } | { ok: false; reason: "sin_sesion" | "no_habilitado" | "video_pendiente" };

/**
 * Punto único de control de acceso a la herramienta. Lo llaman la página /detector y la
 * ruta /api/analyze. Hoy deja pasar a todos; en la etapa de login va a verificar sesión de
 * Supabase, allowlist y video completado (consultando video_progress con service role).
 */
export async function requireToolAccess(): Promise<ToolAccess> {
  return { ok: true, email: null };
}
