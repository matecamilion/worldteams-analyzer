import { requireToolAccess } from "@/lib/guard";
import { handleHistoryPost } from "@/lib/historial";
import { createSupabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/**
 * Guarda los metadatos de un análisis terminado (nombre del archivo y conteos) para "Mi
 * actividad". Misma guarda que /api/analyze. Inserta con service_role: desde el navegador nadie
 * puede escribir en public.analisis (RLS sin políticas de escritura).
 */
export async function POST(request: Request) {
  return handleHistoryPost(request, {
    requireAccess: requireToolAccess,
    countSince: async (email, since) => {
      const { count, error } = await createSupabaseAdmin()
        .from("analisis")
        .select("id", { count: "exact", head: true })
        .eq("email", email)
        .gte("creado_en", since.toISOString());
      if (error) throw new Error(error.message);
      return count ?? 0;
    },
    insert: async (row) => {
      const { error } = await createSupabaseAdmin().from("analisis").insert(row);
      if (error) throw new Error(error.message);
    },
  });
}
