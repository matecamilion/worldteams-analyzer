import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AppHeader } from "@/components/AppHeader";
import { HistoryView } from "@/components/historial/HistoryView";
import { deniedPath, requireAllowed } from "@/lib/guard";
import { getMyHistory, type MyHistory } from "@/lib/historial-data";

export const metadata: Metadata = { title: "Mi actividad · Revisor de planos" };

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
        <HistoryView history={history} />
      </main>
    </div>
  );
}
