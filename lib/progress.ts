import "server-only";
import { createSupabaseAdmin } from "./supabase/admin";
import { isComplete, nextCredit, VIDEO_DURATION_S } from "./video";
import type { SessionUser } from "./guard";

export type VideoState = { credited: number; duration: number; completed: boolean; completedAt: string | null };

type Row = {
  credited_seconds: number | string | null;
  last_heartbeat_at: string | null;
  completed_at: string | null;
};

async function readRow(email: string): Promise<Row | null> {
  const { data, error } = await createSupabaseAdmin()
    .from("video_progress")
    .select("credited_seconds, last_heartbeat_at, completed_at")
    .eq("email", email)
    .maybeSingle();
  if (error) throw new Error(`No se pudo leer el avance: ${error.message}`);
  return data as Row | null;
}

const toState = (row: Row | null): VideoState => {
  const credited = Number(row?.credited_seconds ?? 0);
  return { credited, duration: VIDEO_DURATION_S, completed: !!row?.completed_at || isComplete(credited), completedAt: row?.completed_at ?? null };
};

export async function getVideoState(email: string): Promise<VideoState> {
  return toState(await readRow(email));
}

/**
 * Registra un latido del reproductor. La posición informada por el navegador no se cree:
 * se acota con nextCredit (monótono, no más que el tiempo real) y recién esa posición validada
 * se pasa a record_heartbeat (sólo service role). Después se relee la fila como fuente de verdad.
 */
export async function recordHeartbeat(user: SessionUser, reported: number, now = Date.now()): Promise<VideoState> {
  const before = await readRow(user.email);
  if (before?.completed_at) return toState(before);
  const lastBeatAt = before?.last_heartbeat_at ? Date.parse(before.last_heartbeat_at) : null;
  const position = nextCredit({ credited: Number(before?.credited_seconds ?? 0), lastBeatAt, now, reported });

  const admin = createSupabaseAdmin();
  const { error } = await admin.rpc("record_heartbeat", {
    p_email: user.email,
    p_user_id: user.id,
    p_position: position,
    p_duration: VIDEO_DURATION_S,
  });
  if (error) throw new Error(`No se pudo registrar el avance: ${error.message}`);

  let after = await readRow(user.email);
  // Si la función no marca el completado (o la fecha del latido), lo asegura el servidor.
  const patch: Record<string, string> = {};
  if (after && !after.completed_at && isComplete(Number(after.credited_seconds ?? 0))) patch.completed_at = new Date(now).toISOString();
  if (after && (!after.last_heartbeat_at || Date.parse(after.last_heartbeat_at) < now - 5_000)) patch.last_heartbeat_at = new Date(now).toISOString();
  if (Object.keys(patch).length) {
    const { error: e2 } = await admin.from("video_progress").update(patch).eq("email", user.email);
    if (e2) throw new Error(`No se pudo cerrar el avance: ${e2.message}`);
    after = await readRow(user.email);
  }
  return toState(after);
}

export type ProgressEntry = {
  email: string;
  name: string | null;
  status: "completo" | "en_curso" | "sin_empezar";
  percent: number;
  completedAt: string | null;
  lastSeenAt: string | null;
};

/** Lista de avance: todos los de la allowlist (vista progress_list), con o sin ingreso. */
export async function getProgressList(): Promise<ProgressEntry[]> {
  const admin = createSupabaseAdmin();
  const [{ data: list, error: e1 }, { data: rows, error: e2 }] = await Promise.all([
    admin.from("progress_list").select("email, display_name, completed, completed_at"),
    admin.from("video_progress").select("email, credited_seconds, last_heartbeat_at"),
  ]);
  if (e1 || e2) throw new Error(`No se pudo leer la lista de avance: ${(e1 ?? e2)!.message}`);
  const byEmail = new Map((rows ?? []).map((r) => [String(r.email).toLowerCase(), r]));
  return (list ?? [])
    .map((r): ProgressEntry => {
      const p = byEmail.get(String(r.email).toLowerCase());
      const credited = Number(p?.credited_seconds ?? 0);
      const done = !!r.completed || !!r.completed_at;
      return {
        email: String(r.email),
        name: r.display_name ?? null,
        status: done ? "completo" : p ? "en_curso" : "sin_empezar",
        percent: done ? 100 : Math.min(99, Math.floor((credited / VIDEO_DURATION_S) * 100)),
        completedAt: r.completed_at ?? null,
        lastSeenAt: p?.last_heartbeat_at ?? null,
      };
    })
    .sort((a, b) => ["sin_empezar", "en_curso", "completo"].indexOf(a.status) - ["sin_empezar", "en_curso", "completo"].indexOf(b.status) || a.email.localeCompare(b.email));
}
