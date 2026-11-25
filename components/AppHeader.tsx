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
      <div className="mx-auto flex h-14 max-w-[1600px] items-center gap-4 px-4 sm:gap-6 sm:px-6">
        <Link href="/detector" className="flex shrink-0 items-center gap-3 rounded focus-visible:outline-lima">
          <Image src="/logo-crema.svg" alt="WorldTeams" width={112} height={22} priority />
          <span className="hidden border-l border-papel/25 pl-3 font-display text-sm font-medium md:inline">Revisor de planos</span>
        </Link>
        <nav aria-label="Principal" className="flex gap-1">
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
