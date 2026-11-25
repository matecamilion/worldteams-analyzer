import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AppHeader } from "@/components/AppHeader";
import { deniedPath, requireAllowed } from "@/lib/guard";
import { getProgressList, type ProgressEntry } from "@/lib/progress";

export const metadata: Metadata = { title: "Avance del video · Revisor de planos" };

const fecha = new Intl.DateTimeFormat("es-AR", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "America/Argentina/Buenos_Aires",
});

const ESTADO: Record<ProgressEntry["status"], { label: string; className: string }> = {
  completo: { label: "Completo", className: "bg-ok/10 text-ok" },
  en_curso: { label: "En curso", className: "bg-cercania-suave text-cercania" },
  sin_empezar: { label: "Nunca ingresó", className: "bg-linea/60 text-gris" },
};

export default async function AvancePage() {
  const access = await requireAllowed();
  if (!access.ok) redirect(deniedPath(access));
  const list = await getProgressList();
  const done = list.filter((p) => p.status === "completo").length;

  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader current="/avance" email={access.user.email} />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6">
        <h1 className="font-display text-2xl font-semibold">Avance del video de inducción</h1>
        <p className="mt-2 text-gris">
          {done} de {list.length} {list.length === 1 ? "persona habilitada lo completó" : "personas habilitadas lo completaron"}. La lista
          incluye a quienes todavía no ingresaron.
        </p>

        <div className="mt-6 overflow-x-auto rounded-lg border border-linea bg-hoja">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead className="border-b border-linea text-gris">
              <tr>
                <th scope="col" className="px-4 py-2.5 font-medium">Persona</th>
                <th scope="col" className="px-4 py-2.5 font-medium">Estado</th>
                <th scope="col" className="px-4 py-2.5 font-medium">Avance</th>
                <th scope="col" className="px-4 py-2.5 font-medium">Completado</th>
              </tr>
            </thead>
            <tbody>
              {list.map((p) => (
                <tr key={p.email} className="border-b border-linea last:border-0">
                  <td className="px-4 py-3">
                    <div className="font-medium text-tinta">{p.name ?? p.email}</div>
                    {p.name && <div className="text-gris">{p.email}</div>}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded px-2 py-0.5 text-xs font-medium ${ESTADO[p.status].className}`}>{ESTADO[p.status].label}</span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-linea" aria-hidden>
                        <div className="h-full bg-verde" style={{ width: `${p.percent}%` }} />
                      </div>
                      <span className="num text-gris">{p.percent}&nbsp;%</span>
                    </div>
                  </td>
                  <td className="num px-4 py-3 text-gris">{p.completedAt ? fecha.format(new Date(p.completedAt)) : "—"}</td>
                </tr>
              ))}
              {list.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-gris">
                    La allowlist está vacía: no hay personas habilitadas.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  );
}
