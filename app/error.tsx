"use client"; // Los límites de error tienen que ser Client Components.

import Link from "next/link";

/**
 * Error inesperado en cualquier página (por ejemplo, si no responde la base de datos).
 * No muestra detalles internos: sólo el código que permite encontrar el error en los registros.
 */
export default function ErrorPage({ error, retry }: { error: unknown; retry: () => void }) {
  const code = error instanceof Error && "digest" in error ? String((error as Error & { digest?: string }).digest ?? "") : "";
  return (
    <main className="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center px-6 py-16">
      <h1 className="font-display text-2xl font-semibold text-tinta">Algo salió mal</h1>
      <p className="mt-3 text-gris">
        No pudimos cargar esta página. Puede ser un problema momentáneo de conexión con el servidor. Probá de nuevo en unos
        segundos.
      </p>
      <div className="mt-6 flex flex-wrap gap-3">
        <button type="button" onClick={() => retry()} className="rounded-md bg-verde px-4 py-2 font-medium text-papel hover:bg-tinta">
          Reintentar
        </button>
        <Link href="/" className="rounded-md border border-linea-fuerte bg-hoja px-4 py-2 font-medium text-tinta hover:bg-papel">
          Volver al inicio
        </Link>
      </div>
      {code && (
        <p className="mt-8 text-xs text-gris">
          Si el problema sigue, pasale este código a IT (it@worldteams.com): <span className="num">{code}</span>
        </p>
      )}
    </main>
  );
}
