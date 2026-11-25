import "server-only";
import { createSupabaseAdmin } from "./supabase/admin";
import { createSupabaseServer } from "./supabase/server";
import { isComplete } from "./video";

export type SessionUser = { id: string; email: string };
export type ToolAccess =
  | { ok: true; user: SessionUser }
  | { ok: false; reason: "sin_sesion" }
  | { ok: false; reason: "no_habilitado"; user: SessionUser }
  | { ok: false; reason: "video_pendiente"; user: SessionUser };

const norm = (email: string) => email.trim().toLowerCase();

/** Usuario de la sesión, validado contra Supabase Auth (getUser verifica el token, no sólo lo lee). */
export async function getSessionUser(): Promise<SessionUser | null> {
  const supabase = await createSupabaseServer();
  const { data } = await supabase.auth.getUser();
  const u = data.user;
  return u?.email ? { id: u.id, email: norm(u.email) } : null;
}

/** ¿El correo está en la allowlist? Se compara sin distinguir mayúsculas. */
export async function isAllowedEmail(email: string): Promise<boolean> {
  const { data, error } = await createSupabaseAdmin().from("allowed_emails").select("email");
  if (error) throw new Error(`No se pudo leer la allowlist: ${error.message}`);
  return (data ?? []).some((r) => norm(String(r.email)) === norm(email));
}

/** Sesión + allowlist (para /video y /avance). */
export async function requireAllowed(): Promise<ToolAccess> {
  const user = await getSessionUser();
  if (!user) return { ok: false, reason: "sin_sesion" };
  if (!(await isAllowedEmail(user.email))) return { ok: false, reason: "no_habilitado", user };
  return { ok: true, user };
}

/**
 * Punto único de control de la herramienta: lo usan /detector y /api/analyze.
 * Exige sesión, allowlist y video completado según el servidor (video_progress).
 */
export async function requireToolAccess(): Promise<ToolAccess> {
  const allowed = await requireAllowed();
  if (!allowed.ok) return allowed;
  const { data, error } = await createSupabaseAdmin()
    .from("video_progress")
    .select("credited_seconds, completed_at")
    .eq("email", allowed.user.email)
    .maybeSingle();
  if (error) throw new Error(`No se pudo leer el avance del video: ${error.message}`);
  const done = !!data?.completed_at || isComplete(Number(data?.credited_seconds ?? 0));
  return done ? allowed : { ok: false, reason: "video_pendiente", user: allowed.user };
}

/** A dónde mandar a alguien sin acceso. */
export function deniedPath(access: Exclude<ToolAccess, { ok: true }>): string {
  if (access.reason === "sin_sesion") return "/login";
  if (access.reason === "no_habilitado") return "/auth/salir?motivo=no_habilitado";
  return "/video";
}
