import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AppHeader } from "@/components/AppHeader";
import { DetectorApp } from "@/components/detector/DetectorApp";
import { requireToolAccess } from "@/lib/guard";

export const metadata: Metadata = { title: "Detector · Revisor de planos" };

export default async function DetectorPage() {
  // Punto de integración del bloqueo: hoy siempre pasa; después exige sesión, allowlist y video.
  const access = await requireToolAccess();
  if (!access.ok) redirect(access.reason === "video_pendiente" ? "/video" : "/login");

  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader current="/detector" />
      <main className="flex flex-1 flex-col">
        <DetectorApp />
      </main>
    </div>
  );
}
