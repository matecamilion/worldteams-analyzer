import { NextResponse, type NextRequest } from "next/server";
import { isAllowedEmail } from "@/lib/guard";
import { createSupabaseServer } from "@/lib/supabase/server";

/**
 * Vuelta de Google (vía Supabase). Canjea el código por la sesión y verifica la allowlist:
 * si la cuenta no está habilitada, cierra la sesión al instante y vuelve al login con el motivo.
 * Los motivos viajan en la URL sin datos personales (nunca el correo).
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const login = (motivo: string) => NextResponse.redirect(new URL(`/login?motivo=${motivo}`, url.origin));

  if (url.searchParams.get("error")) return login("google_cancelado");
  const code = url.searchParams.get("code");
  if (!code) return login("sin_codigo");

  const supabase = await createSupabaseServer();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error || !data.user?.email) return login("fallo_sesion");

  let allowed = false;
  try {
    allowed = await isAllowedEmail(data.user.email);
  } catch {
    await supabase.auth.signOut();
    return login("fallo_allowlist");
  }
  if (!allowed) {
    await supabase.auth.signOut();
    return login("no_habilitado");
  }
  return NextResponse.redirect(new URL("/detector", url.origin));
}
