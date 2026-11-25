import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * Cliente de Supabase con la sesión del usuario (cookies). Sirve en Server Components, Route
 * Handlers y Server Functions. En Server Components no se pueden escribir cookies: el refresco
 * de sesión lo hace proxy.ts, así que acá se ignora ese error.
 */
export async function createSupabaseServer() {
  const store = await cookies();
  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          for (const { name, value, options } of list) store.set(name, value, options);
        } catch {
          // Server Component: proxy.ts ya refrescó la sesión en esta request.
        }
      },
    },
  });
}
