import "server-only";
import { createSupabaseServer } from "./supabase/server";

export type HistoryRow = {
  id: string;
  nombre_archivo: string;
  paginas: number;
  paginas_escaneadas: number;
  choques: number;
  duplicados: number;
  cercanias: number;
  paginas_no_verificadas: number;
  creado_en: string;
};

export type MyHistory = {
  total: number;
  totals: { choques: number; duplicados: number; cercanias: number };
  recent: HistoryRow[];
};

/** Filas por pedido: Supabase devuelve como mucho 1000 por consulta. */
const PAGE = 1000;
/** Tope de filas que se suman (a 300 por día, son años de uso). */
const MAX_ROWS = 50_000;

/**
 * "Mi actividad" de quien tiene la sesión. Lee con la sesión del usuario (no con service_role):
 * la política RLS de public.analisis es la que deja ver sólo las filas propias.
 */
export async function getMyHistory(): Promise<MyHistory> {
  const supabase = await createSupabaseServer();
  const recent = await supabase
    .from("analisis")
    .select("id, nombre_archivo, paginas, paginas_escaneadas, choques, duplicados, cercanias, paginas_no_verificadas, creado_en", {
      count: "exact",
    })
    .order("creado_en", { ascending: false })
    .limit(20);
  if (recent.error) throw new Error(recent.error.message);

  const totals = { choques: 0, duplicados: 0, cercanias: 0 };
  const total = recent.count ?? recent.data.length;
  for (let from = 0; from < Math.min(total, MAX_ROWS); from += PAGE) {
    const { data, error } = await supabase
      .from("analisis")
      .select("choques, duplicados, cercanias")
      .order("creado_en", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    for (const r of data) {
      totals.choques += r.choques;
      totals.duplicados += r.duplicados;
      totals.cercanias += r.cercanias;
    }
    if (data.length < PAGE) break;
  }
  return { total, totals, recent: recent.data as HistoryRow[] };
}
