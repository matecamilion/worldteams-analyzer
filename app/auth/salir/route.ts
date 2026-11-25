import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServer } from "@/lib/supabase/server";

const MOTIVOS = new Set(["no_habilitado"]);

/** Cierra la sesión y vuelve al login. GET lo usa el guard para echar a una cuenta no habilitada. */
async function salir(request: NextRequest) {
  const supabase = await createSupabaseServer();
  await supabase.auth.signOut();
  const motivo = new URL(request.url).searchParams.get("motivo");
  const target = new URL(motivo && MOTIVOS.has(motivo) ? `/login?motivo=${motivo}` : "/login?motivo=salio", request.url);
  // 303: después de un POST, el navegador sigue con GET.
  return NextResponse.redirect(target, 303);
}

export const GET = salir;
export const POST = salir;
