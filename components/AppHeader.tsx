import Image from "next/image";
import Link from "next/link";

const NAV = [
  { href: "/detector", label: "Detector" },
  { href: "/video", label: "Video" },
  { href: "/avance", label: "Avance" },
];

export function AppHeader({ current, email }: { current?: string; email?: string }) {
  return (
    <header className="bg-verde text-papel">
      {/* En teléfonos: logo y "Salir" arriba, navegación abajo. Desde sm, todo en una fila. */}
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-4 gap-y-1 px-4 pt-2.5 pb-1.5 sm:h-14 sm:flex-nowrap sm:gap-6 sm:px-6 sm:py-0">
        <Link href="/detector" className="flex shrink-0 items-center gap-3 rounded focus-visible:outline-lima">
          <Image src="/logo-crema.svg" alt="WorldTeams" width={112} height={22} priority />
          <span className="hidden border-l border-papel/25 pl-3 font-display text-sm font-medium md:inline">Revisor de planos</span>
        </Link>
        <nav aria-label="Principal" className="order-last -ml-2.5 flex w-full gap-1 sm:order-none sm:ml-0 sm:w-auto">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              aria-current={current === item.href ? "page" : undefined}
              className="rounded px-2.5 py-1.5 text-sm text-papel/80 hover:text-papel aria-[current=page]:bg-papel/10 aria-[current=page]:text-papel focus-visible:outline-lima sm:px-3"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        {email && (
          <div className="ml-auto flex min-w-0 items-center gap-3 text-sm">
            <span className="hidden truncate text-papel/70 lg:inline" title={email}>
              {email}
            </span>
            <form action="/auth/salir" method="post">
              <button type="submit" className="rounded px-2.5 py-1.5 text-papel/80 hover:bg-papel/10 hover:text-papel focus-visible:outline-lima">
                Salir
              </button>
            </form>
          </div>
        )}
      </div>
    </header>
  );
}
