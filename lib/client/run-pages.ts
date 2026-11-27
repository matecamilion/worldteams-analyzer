// Orden de análisis de las páginas de un PDF: la 1 sola y después las demás de a varias.
// Sin React ni red: DetectorApp le pasa cómo analizar una página, y acá sólo se decide el orden.

/** Páginas que se analizan a la vez después de la primera. Medido en el bench (README): con 3 la
 * corrida tarda ~45 % menos que en serie, con la misma detección y sin respuestas 429. */
export const PAGINAS_EN_PARALELO = 3;

/**
 * Lo que devuelve el análisis de una página. `failure` sólo si falló el pedido al servidor o la IA:
 * - "sin_acceso": sesión vencida o cuenta sin acceso (401/403). Las demás páginas fallarían igual.
 * - "error": red, servidor o proveedor de IA con problemas. Puede ser pasajero.
 */
export type PageAttempt<T> = { outcome: T; failure?: "sin_acceso" | "error" };

export type RunPagesOptions<T> = {
  total: number;
  parallel?: number;
  /** false si se subió otro archivo o se volvió al inicio: no se empieza ninguna página más. */
  isCurrent: () => boolean;
  /** null si la corrida dejó de ser la actual mientras se analizaba. */
  analyzePage: (page: number) => Promise<PageAttempt<T> | null>;
  /** Si analizar una página lanza, su resultado de reemplazo (p. ej. "no verificada"); las demás siguen. */
  onPageError: (page: number, error: unknown) => T;
};

export type RunPagesResult<T> =
  /** Todas las páginas tienen resultado, en el orden del PDF. */
  | { status: "completa"; outcomes: T[]; mode: "paralelo" | "serie" }
  /** La corrida dejó de ser la actual: no se muestra ni se registra nada más. */
  | { status: "cortada" }
  /** Una página respondió sin acceso: no se pidió ninguna más. `pending`: las que quedaron sin analizar. */
  | { status: "sin_acceso"; outcomes: (T | undefined)[]; failedPage: number; pending: number[] };

/**
 * Analiza la página 1 sola, para fallar temprano: si la sesión venció, no se disparan más pedidos;
 * si el servidor o la IA fallan, el resto sigue de a una (sin cargar más a un servicio con
 * problemas). Si la 1 anda, las demás van de a `parallel`. Cada resultado queda en `outcomes[n-1]`.
 */
export async function runPages<T>(opts: RunPagesOptions<T>): Promise<RunPagesResult<T>> {
  const { total, isCurrent, analyzePage, onPageError } = opts;
  const outcomes: (T | undefined)[] = new Array(total).fill(undefined);
  let blockedAt: number | null = null;

  const one = async (page: number) => {
    let attempt: PageAttempt<T> | null;
    try {
      attempt = await analyzePage(page);
    } catch (e) {
      attempt = isCurrent() ? { outcome: onPageError(page, e) } : null;
    }
    if (attempt) {
      outcomes[page - 1] = attempt.outcome;
      if (attempt.failure === "sin_acceso" && blockedAt === null) blockedAt = page;
    }
    return attempt;
  };

  if (total < 1) return { status: "completa", outcomes: [], mode: "serie" };
  const first = await one(1);
  if (!isCurrent() || !first) return { status: "cortada" };

  const mode = first.failure ? "serie" : "paralelo";
  const limit = mode === "serie" ? 1 : Math.max(1, Math.floor(opts.parallel ?? PAGINAS_EN_PARALELO));
  let next = 2;
  await Promise.all(
    Array.from({ length: Math.min(limit, total - 1) }, async () => {
      while (next <= total && blockedAt === null && isCurrent()) await one(next++);
    }),
  );

  // Sin resultado de alguna página sólo si la corrida dejó de ser la actual mientras tanto.
  if (!isCurrent() || (blockedAt === null && outcomes.includes(undefined))) return { status: "cortada" };
  if (blockedAt !== null) {
    const pending = outcomes.flatMap((o, i) => (o === undefined ? [i + 1] : []));
    return { status: "sin_acceso", outcomes, failedPage: blockedAt, pending };
  }
  return { status: "completa", outcomes: outcomes as T[], mode };
}
