import Image from "next/image";
import Link from "next/link";

const NAV = [{ href: "/detector", label: "Detector" }];

export function AppHeader({ current }: { current?: string }) {
  return (
    <header className="bg-verde text-papel">
      <div className="mx-auto flex h-14 max-w-[1600px] items-center gap-6 px-4 sm:px-6">
        <Link href="/detector" className="flex items-center gap-3 rounded focus-visible:outline-lima">
          <Image src="/logo-crema.svg" alt="WorldTeams" width={112} height={22} priority />
          <span className="hidden border-l border-papel/25 pl-3 font-display text-sm font-medium sm:inline">Revisor de planos</span>
        </Link>
        <nav aria-label="Principal" className="flex gap-1">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              aria-current={current === item.href ? "page" : undefined}
              className="rounded px-3 py-1.5 text-sm text-papel/80 hover:text-papel aria-[current=page]:bg-papel/10 aria-[current=page]:text-papel focus-visible:outline-lima"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        {/* Acá va la cuenta del usuario y "Cerrar sesión" en la etapa de login. */}
      </div>
    </header>
  );
}
