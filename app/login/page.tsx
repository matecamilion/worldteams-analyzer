import type { Metadata } from "next";
import Image from "next/image";
import { redirect } from "next/navigation";
import { GoogleButton } from "@/components/auth/GoogleButton";
import { requireAllowed } from "@/lib/guard";

export const metadata: Metadata = { title: "Ingresar · Revisor de planos" };

const MENSAJES: Record<string, { tono: "error" | "info"; texto: string }> = {
  no_habilitado: {
    tono: "error",
    texto: "Tu cuenta de Google no está habilitada para esta herramienta, así que cerramos la sesión. Si necesitás acceso, pedíselo a IT (it@worldteams.com).",
  },
  google_cancelado: { tono: "error", texto: "No se completó el ingreso con Google. Probá de nuevo." },
  sin_codigo: { tono: "error", texto: "No pudimos completar el ingreso. Probá de nuevo." },
  fallo_sesion: { tono: "error", texto: "No pudimos completar el ingreso. Probá de nuevo." },
  fallo_allowlist: { tono: "error", texto: "No pudimos verificar tu acceso. Probá de nuevo en unos minutos." },
  salio: { tono: "info", texto: "Cerraste la sesión." },
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ motivo?: string }> }) {
  const access = await requireAllowed();
  if (access.ok) redirect("/detector");

  const { motivo } = await searchParams;
  const mensaje = motivo ? MENSAJES[motivo] : undefined;

  return (
    <main className="grid min-h-dvh place-items-center bg-papel px-4 py-12">
      <div className="w-full max-w-sm">
        <Image src="/logo-verde.svg" alt="WorldTeams" width={150} height={30} priority />
        <h1 className="mt-8 font-display text-2xl font-semibold text-tinta">Revisor de planos</h1>
        <p className="mt-2 text-gris">
          Detecta textos encimados en planos PDF. Entrá con tu cuenta de Google habilitada.
        </p>

        {mensaje && (
          <p
            role={mensaje.tono === "error" ? "alert" : "status"}
            className={
              mensaje.tono === "error"
                ? "mt-6 rounded-md border border-choque/30 bg-choque-suave px-3 py-2 text-sm text-choque"
                : "mt-6 rounded-md border border-linea bg-hoja px-3 py-2 text-sm text-gris"
            }
          >
            {mensaje.texto}
          </p>
        )}

        <div className="mt-6">
          <GoogleButton />
        </div>
        <p className="mt-6 text-sm text-gris">
          Antes de usar la herramienta vas a ver un video de inducción de 2 minutos y medio, completo.
        </p>
      </div>
    </main>
  );
}
