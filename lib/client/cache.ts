// Caché de resultados de páginas escaneadas en el navegador (localStorage).
// Clave: versión del detector + SHA-256 del PDF + número de página. Sólo se guardan páginas que
// pasaron por la IA y salieron bien: son las que cuestan tiempo y dinero. Los datos no salen del
// navegador del usuario. Cambiar DETECTOR_VERSION invalida todo lo guardado.
import type { PageResult } from "@/lib/detector/types";

export const DETECTOR_VERSION = "2026-11-26.3";
const PREFIX = "revisor:pagina:";
const INDEX = "revisor:indice";
const MAX_ENTRIES = 200;

export type CachedPage = { result: PageResult; savedAt: string };

export async function hashPdf(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const keyOf = (hash: string, page: number) => `${PREFIX}${DETECTOR_VERSION}:${hash}:${page}`;

function readIndex(): string[] {
  try {
    return JSON.parse(localStorage.getItem(INDEX) ?? "[]") as string[];
  } catch {
    return [];
  }
}

export function getCachedPage(hash: string, page: number): CachedPage | null {
  try {
    const raw = localStorage.getItem(keyOf(hash, page));
    return raw ? (JSON.parse(raw) as CachedPage) : null;
  } catch {
    return null;
  }
}

/** Guarda sólo páginas analizadas con IA y verificadas. Si no hay lugar, borra las más viejas. */
export function putCachedPage(hash: string, page: number, result: PageResult): void {
  if (result.kind !== "image" || result.status !== "ok") return;
  const key = keyOf(hash, page);
  const value = JSON.stringify({ result, savedAt: new Date().toISOString() } satisfies CachedPage);
  const index = readIndex().filter((k) => k !== key);
  index.push(key);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      while (index.length > MAX_ENTRIES) localStorage.removeItem(index.shift()!);
      localStorage.setItem(key, value);
      localStorage.setItem(INDEX, JSON.stringify(index));
      return;
    } catch {
      // Lleno: liberamos la entrada más vieja y probamos de nuevo.
      const oldest = index.shift();
      if (!oldest || oldest === key) return;
      localStorage.removeItem(oldest);
    }
  }
}

export function forgetCachedPage(hash: string, page: number): void {
  try {
    localStorage.removeItem(keyOf(hash, page));
    localStorage.setItem(INDEX, JSON.stringify(readIndex().filter((k) => k !== keyOf(hash, page))));
  } catch {
    // Sin acceso a localStorage: no hay nada que borrar.
  }
}
