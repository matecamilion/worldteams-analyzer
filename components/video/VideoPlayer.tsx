"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

type Props = {
  src: string;
  duration: number;
  completeAt: number;
  heartbeatMs: number;
  initialCredited: number;
  initialCompleted: boolean;
};

type ServerState = { credited: number; completed: boolean };

const clock = (s: number) => {
  const t = Math.max(0, Math.floor(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};

/**
 * Reproductor sin controles nativos (no trae barra para adelantar). En el navegador se impide
 * adelantar, cambiar la velocidad y seguir reproduciendo en otra pestaña, pero lo que vale es
 * el servidor: cada latido informa la posición y el servidor decide cuánto acreditar.
 */
export function VideoPlayer({ src, duration, completeAt, heartbeatMs, initialCredited, initialCompleted }: Props) {
  const video = useRef<HTMLVideoElement>(null);
  /** Hasta dónde llegó reproduciendo de corrido: no se puede saltar más allá. */
  const reached = useRef(initialCredited);
  const [server, setServer] = useState<ServerState>({ credited: initialCredited, completed: initialCompleted });
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [ended, setEnded] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);

  const beat = useCallback(async () => {
    const v = video.current;
    if (!v) return;
    try {
      const res = await fetch("/api/video/heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ position: v.currentTime }),
        keepalive: true,
      });
      if (res.status === 401) {
        // Recarga completa a propósito: descarta el estado de la sesión vencida.
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
        window.location.assign(`${window.location.origin}/login`);
        return;
      }
      const data = (await res.json()) as ServerState & { error?: string };
      if (!res.ok) throw new Error(data.error ?? "No se pudo guardar tu avance.");
      setServer({ credited: data.credited, completed: data.completed });
      setSyncError(null);
    } catch (e) {
      setSyncError((e as Error).message || "No se pudo guardar tu avance. Reintentamos en unos segundos.");
    }
  }, []);

  // Latidos mientras reproduce.
  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(beat, heartbeatMs);
    return () => window.clearInterval(id);
  }, [playing, beat, heartbeatMs]);

  // Si la pestaña pierde el foco, se pausa.
  useEffect(() => {
    const pause = (why: string) => {
      const v = video.current;
      if (v && !v.paused) {
        v.pause();
        setNotice(why);
      }
    };
    const onVisibility = () => document.hidden && pause("Pausamos el video porque cambiaste de pestaña.");
    const onBlur = () => pause("Pausamos el video porque saliste de la ventana.");
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  const toggle = () => {
    const v = video.current;
    if (!v) return;
    if (v.paused) {
      setNotice(null);
      if (ended) setEnded(false);
      void v.play().catch(() => setNotice("El navegador no dejó reproducir. Tocá de nuevo el botón."));
    } else v.pause();
  };

  const resumeFromValidated = () => {
    const v = video.current;
    if (!v) return;
    v.currentTime = Math.min(server.credited, reached.current);
    setEnded(false);
    setNotice(null);
    void v.play();
  };

  const remaining = Math.max(0, completeAt - server.credited);
  const shown = Math.min(100, (time / duration) * 100);
  const validated = Math.min(100, (server.credited / duration) * 100);

  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-lg border border-linea bg-tinta">
        <video
          ref={video}
          src={src}
          className="aspect-video w-full cursor-pointer bg-tinta"
          preload="auto"
          playsInline
          disablePictureInPicture
          disableRemotePlayback
          controlsList="nodownload noplaybackrate noremoteplayback nofullscreen"
          tabIndex={-1}
          onClick={toggle}
          onContextMenu={(e) => e.preventDefault()}
          onLoadedMetadata={(e) => {
            // Retoma desde lo ya validado por el servidor.
            const v = e.currentTarget;
            const start = Math.min(initialCredited, Math.max(0, v.duration - 1));
            if (start > 0) v.currentTime = start;
          }}
          onTimeUpdate={(e) => {
            const t = e.currentTarget.currentTime;
            // Avance de corrido (no un salto): mueve el tope.
            if (t > reached.current && t - reached.current < 1.5) reached.current = t;
            setTime(t);
          }}
          onSeeking={(e) => {
            const v = e.currentTarget;
            if (v.currentTime > reached.current + 0.5) {
              v.currentTime = reached.current;
              setNotice("El video no se puede adelantar.");
            }
          }}
          onRateChange={(e) => {
            if (e.currentTarget.playbackRate !== 1) e.currentTarget.playbackRate = 1;
          }}
          onPlay={() => {
            setPlaying(true);
            void beat(); // marca el inicio del tramo en el servidor
          }}
          onPause={() => {
            setPlaying(false);
            void beat();
          }}
          onEnded={() => {
            setPlaying(false);
            setEnded(true);
            void beat();
          }}
          onError={() => setLoadError(true)}
        />
      </div>

      {/* Barra informativa: no se puede tocar. Oscuro = validado por el servidor. */}
      <div>
        <div
          className="relative h-2 overflow-hidden rounded-full bg-linea"
          role="progressbar"
          aria-label="Avance validado del video"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.floor(validated)}
        >
          <div className="absolute inset-y-0 left-0 bg-salvia/40" style={{ width: `${shown}%` }} />
          <div className="absolute inset-y-0 left-0 bg-verde" style={{ width: `${validated}%` }} />
        </div>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3 text-sm">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={toggle}
              disabled={loadError}
              className="rounded-md bg-verde px-4 py-2 font-medium text-papel hover:bg-tinta disabled:opacity-50"
            >
              {playing ? "Pausar" : time > 0 && !ended ? "Seguir" : "Reproducir"}
            </button>
            <span className="num text-gris">
              {clock(time)} / {clock(duration)}
            </span>
          </div>
          <span className="text-gris" aria-live="polite">
            {server.completed ? "Video completo" : `Validado: ${Math.floor(validated)} %`}
          </span>
        </div>
      </div>

      {loadError && (
        <p role="alert" className="rounded-md border border-choque/30 bg-choque-suave px-3 py-2 text-sm text-choque">
          No se pudo cargar el video. Revisá la conexión y recargá la página.
        </p>
      )}
      {notice && !server.completed && <p className="rounded-md border border-linea bg-hoja px-3 py-2 text-sm text-tinta">{notice}</p>}
      {syncError && !server.completed && (
        <p role="alert" className="rounded-md border border-cercania/30 bg-cercania-suave px-3 py-2 text-sm text-cercania">
          {syncError}
        </p>
      )}

      {server.completed ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-ok/30 bg-hoja px-4 py-3">
          <p className="text-tinta">Listo: tu video quedó registrado. Ya podés usar el detector.</p>
          <Link href="/detector" className="rounded-md bg-lima px-4 py-2 font-medium text-tinta hover:brightness-95">
            Ir al detector
          </Link>
        </div>
      ) : (
        ended && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-cercania/30 bg-cercania-suave px-4 py-3 text-sm">
            <p className="text-tinta">
              Quedaron {Math.ceil(remaining)} s sin validar (por pausas, cortes de red o cambio de pestaña). Volvé a verlos para terminar.
            </p>
            <button type="button" onClick={resumeFromValidated} className="rounded-md bg-verde px-4 py-2 font-medium text-papel">
              Seguir desde {clock(server.credited)}
            </button>
          </div>
        )
      )}
    </div>
  );
}
