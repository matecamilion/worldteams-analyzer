import "server-only";
import { createClient } from "@supabase/supabase-js";

/**
 * Cliente con service role: salta RLS. Sólo en el servidor y sólo para lo que el usuario no
 * puede hacer por sí mismo (acreditar avance del video, leer la allowlist y el avance de todos).
 */
export function createSupabaseAdmin() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("Falta SUPABASE_SERVICE_ROLE_KEY");
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
