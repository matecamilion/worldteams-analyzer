import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AppHeader } from "@/components/AppHeader";
import { deniedPath, requireAllowed } from "@/lib/guard";
import { getMyHistory, type MyHistory } from "@/lib/historial-data";

export const metadata: Metadata = { title: "Mi actividad · Revisor de planos" };

const fecha = new Intl.DateTimeFormat("es-AR", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "America/Argentina/Buenos_Aires",
});
const numero = new Intl.NumberFormat("es-AR");
const plural = (n: number, uno: string, varios: string) => `${numero.format(n)} ${n === 1 ? uno : varios}`;

export default async function HistorialPage() {
  // Sólo personas habilitadas (no hace falta haber terminado el video para ver lo propio).
  const access = await requireAllowed();
  if (!access.ok) redirect(deniedPath(access));

  let history: MyHistory | null = null;
  try {
    history = await getMyHistory();
  } catch (e) {
    console.error(`historial: no se pudo leer: ${(e as Error).message}`);
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader current="/historial" email={access.user.email} />
      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-6 sm:px-6 sm:py-8">
        <h1 className="font-display text-2xl font-semibold">Mi actividad</h1>
        <p className="mt-1 text-sm text-gris">Los PDFs que analizaste. Sólo se guardan el nombre del archivo y los conteos, nunca el plano.</p>

        {!history ? (
          <div role="alert" className="mt-6 rounded-lg border border-choque/30 bg-choque-suave px-4 py-3 text-sm">
            <p className="font-semibold text-choque">No se pudo cargar tu actividad.</p>
            <p className="mt-1 text-tinta">Probá recargar la página en un rato. Tus análisis no se perdieron.</p>
          </div>
        ) : history.total === 0 ? (
          <div className="mt-6 rounded-lg border border-dashed border-linea-fuerte bg-hoja px-4 py-8 text-center">
            <p className="font-semibold">Todavía no analizaste ningún PDF.</p>
            <p className="mt-1 text-sm text-gris">Cuando termines un análisis en el detector, va a aparecer acá.</p>
            <Link href="/detector" className="mt-4 inline-block rounded bg-verde px-4 py-2 text-sm font-semibold text-papel hover:bg-verde/90">
              Ir al detector
            </Link>
          </div>
        ) : (
          <>
            <dl className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                { label: "PDFs analizados", value: history.total, className: "text-tinta" },
                { label: "Choques", value: history.totals.choques, className: "text-choque" },
                { label: "Duplicados", value: history.totals.duplicados, className: "text-gris" },
                { label: "Cercanías", value: history.totals.cercanias, className: "text-cercania" },
              ].map((s) => (
                <div key={s.label} className="rounded-lg border border-linea bg-hoja px-4 py-3">
                  <dt className="text-xs text-gris">{s.label}</dt>
                  <dd className={`mt-0.5 font-display text-2xl font-semibold tabular-nums ${s.className}`}>{numero.format(s.value)}</dd>
                </div>
              ))}
            </dl>

            <h2 className="mt-8 font-display text-lg font-semibold">
              {history.total > history.recent.length ? `Últimos ${history.recent.length}` : "Todos los análisis"}
            </h2>
            <ul className="mt-3 divide-y divide-linea overflow-hidden rounded-lg border border-linea bg-hoja">
              {history.recent.map((r) => (
                <li key={r.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                    <p className="min-w-0 font-medium break-all">{r.nombre_archivo}</p>
                    <time dateTime={r.creado_en} className="shrink-0 text-xs text-gris">
                      {fecha.format(new Date(r.creado_en))}
                    </time>
                  </div>
                  <p className="mt-1 text-sm text-gris">
                    {plural(r.paginas, "página", "páginas")}
                    {r.paginas_escaneadas > 0 && ` (${numero.format(r.paginas_escaneadas)} escaneada${r.paginas_escaneadas === 1 ? "" : "s"})`}
                  </p>
                  <p className="mt-1.5 flex flex-wrap gap-1.5 text-xs">
                    <span className={`rounded px-2 py-0.5 font-medium ${r.choques ? "bg-choque-suave text-choque" : "bg-papel text-gris"}`}>
                      {plural(r.choques, "choque", "choques")}
                    </span>
                    <span className="rounded bg-papel px-2 py-0.5 font-medium text-gris">{plural(r.duplicados, "duplicado", "duplicados")}</span>
                    <span className="rounded bg-papel px-2 py-0.5 font-medium text-cercania">{plural(r.cercanias, "cercanía", "cercanías")}</span>
                    {r.paginas_no_verificadas > 0 && (
                      <span className="rounded bg-cercania-suave px-2 py-0.5 font-medium text-cercania">
                        {plural(r.paginas_no_verificadas, "página no verificada", "páginas no verificadas")}
                      </span>
                    )}
                  </p>
                </li>
              ))}
            </ul>
          </>
        )}
      </main>
    </div>
  );
}
