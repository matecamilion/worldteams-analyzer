import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AppHeader } from "@/components/AppHeader";
import { VideoPlayer } from "@/components/video/VideoPlayer";
import { deniedPath, requireAllowed } from "@/lib/guard";
import { getVideoState } from "@/lib/progress";
import { COMPLETE_AT_S, HEARTBEAT_MS, VIDEO_DURATION_S, VIDEO_OBJECT } from "@/lib/video";

export const metadata: Metadata = { title: "Video de inducción · Revisor de planos" };

export default async function VideoPage() {
  const access = await requireAllowed();
  if (!access.ok) redirect(deniedPath(access));
  const state = await getVideoState(access.user.email);
  const src = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/video/${VIDEO_OBJECT}`;

  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader current="/video" email={access.user.email} />
      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-8 sm:px-6">
        <h1 className="font-display text-2xl font-semibold">Video de inducción</h1>
        <p className="mt-2 max-w-2xl text-gris">
          {state.completed
            ? "Ya lo viste completo. Podés volver a verlo cuando quieras."
            : "Para usar el detector tenés que verlo completo (2 min 33 s). No se puede adelantar; si cambiás de pestaña se pausa. Tu avance se guarda solo: si salís, retomás donde quedaste."}
        </p>
        <div className="mt-6">
          <VideoPlayer
            src={src}
            duration={VIDEO_DURATION_S}
            completeAt={COMPLETE_AT_S}
            heartbeatMs={HEARTBEAT_MS}
            initialCredited={state.completed ? 0 : state.credited}
            initialCompleted={state.completed}
          />
        </div>
      </main>
    </div>
  );
}
