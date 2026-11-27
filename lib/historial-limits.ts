// Límites del historial compartidos entre el navegador y el servidor (sin zod: entra en el bundle del cliente).

/** Largo máximo del nombre del archivo (igual que el check de public.analisis). */
export const MAX_FILE_NAME = 255;
/** Tope de páginas (igual que el check de public.analisis). */
export const MAX_PAGES = 5000;

/** Saca caracteres de control y espacios de más; el nombre se guarda tal como se ve. */
export function cleanFileName(name: string): string {
  return name.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
}
