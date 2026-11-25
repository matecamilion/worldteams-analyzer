import { createBrowserClient } from "@supabase/ssr";

/** Cliente del navegador: sólo con la clave anon (pública). Se usa para iniciar el login con Google. */
export function createSupabaseBrowser() {
  return createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
}
