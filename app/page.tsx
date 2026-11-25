import Image from "next/image";

// Pantalla provisoria del esqueleto: se reemplaza por el login en la etapa de autenticación.
export default function Home() {
  return (
    <main className="flex flex-1 items-center justify-center px-6 py-16">
      <div className="w-full max-w-md rounded-lg border border-linea bg-hoja p-8">
        <Image src="/logo-verde.svg" alt="WorldTeams" width={153} height={30} priority />
        <h1 className="mt-8 font-display text-2xl font-semibold tracking-tight">Revisor de planos</h1>
        <p className="mt-2 text-gris">
          Detecta textos que se pisan en planos PDF y te marca la página y la zona exacta.
        </p>
        <p className="mt-6 text-sm text-gris">Esqueleto en construcción.</p>
      </div>
    </main>
  );
}
