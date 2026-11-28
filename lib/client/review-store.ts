// Revisión del usuario en el navegador (localStorage), por PDF: revisor:revision:<SHA-256 del PDF>.
// Sin DETECTOR_VERSION a propósito: una versión nueva del detector no borra lo que la persona revisó.
// Aparte de la caché de resultados: "Reintentar" o un cambio de versión no la tocan.
import { isEmptyReview, migrateReview, type Review } from "@/lib/detector/review";

const PREFIX = "revisor:revision:";
const INDEX = "revisor:revision:indice";
/** PDFs con revisión guardada: al pasarse, se borra la que se modificó hace más tiempo. */
export const MAX_REVIEWED_PDFS = 100;

const keyOf = (hash: string) => `${PREFIX}${hash}`;

function readIndex(storage: Storage): string[] {
  try {
    const v = JSON.parse(storage.getItem(INDEX) ?? "[]");
    return Array.isArray(v) ? v.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}

/** Revisión guardada de un PDF ({} si no hay, si está dañada o si no hay localStorage). */
export function loadReview(hash: string, storage: Storage | undefined = globalThis.localStorage): Review {
  try {
    const raw = storage?.getItem(keyOf(hash));
    // Las revisiones guardadas con el formato anterior ("Está bien") se migran al leerlas.
    return raw ? migrateReview(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

/** Guarda la revisión (vacía: la borra). Nunca lanza: si no hay lugar, se libera lo más viejo. */
export function saveReview(hash: string, review: Review, storage: Storage | undefined = globalThis.localStorage): void {
  if (!storage) return;
  const key = keyOf(hash);
  try {
    const index = readIndex(storage).filter((k) => k !== key);
    if (isEmptyReview(review)) {
      storage.removeItem(key);
      storage.setItem(INDEX, JSON.stringify(index));
      return;
    }
    index.push(key);
    const value = JSON.stringify(review);
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        while (index.length > MAX_REVIEWED_PDFS) storage.removeItem(index.shift()!);
        storage.setItem(key, value);
        storage.setItem(INDEX, JSON.stringify(index));
        return;
      } catch {
        const oldest = index.shift();
        if (!oldest || oldest === key) return;
        storage.removeItem(oldest);
      }
    }
  } catch {
    // Sin acceso a localStorage: la revisión queda sólo en memoria.
  }
}
