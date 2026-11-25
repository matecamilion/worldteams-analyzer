import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AppHeader } from "@/components/AppHeader";
import { DetectorApp } from "@/components/detector/DetectorApp";
import { deniedPath, requireToolAccess } from "@/lib/guard";

export const metadata: Metadata = { title: "Detector · Revisor de planos" };

export default async function DetectorPage() {
  // Sesión, allowlist y video completado, verificados en el servidor.
  const access = await requireToolAccess();
  if (!access.ok) redirect(deniedPath(access));

  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader current="/detector" email={access.user.email} />
      <main className="flex flex-1 flex-col">
        <DetectorApp />
      </main>
    </div>
  );
}
