"use client";

import { useId, useRef, useState } from "react";

type Props = {
  onFile: (file: File) => void;
  onSample: () => void;
  error: string | null;
  busy: boolean;
};

export function UploadZone({ onFile, onSample, error, busy }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const hintId = useId();
  const errorId = useId();

  return (
    <div className="mx-auto w-full max-w-2xl">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const file = e.dataTransfer.files?.[0];
          if (file) onFile(file);
        }}
        className={`rounded-md border-2 border-dashed px-6 py-14 text-center transition-colors ${
          over ? "border-verde bg-hoja" : "border-linea-fuerte bg-hoja/60"
        }`}
      >
        {/* Ícono: hoja de plano con dos textos encimados. */}
        <svg aria-hidden viewBox="0 0 48 48" className="mx-auto h-12 w-12 text-verde" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M10 6h20l8 8v28H10z" />
          <path d="M30 6v8h8" />
          <path d="M16 24h14M19 27h13" className="text-choque" stroke="currentColor" />
          <path d="M16 34h10" />
        </svg>
        <p className="mt-4 font-display text-lg font-semibold">Arrastrá un plano en PDF</p>
        <p id={hintId} className="mt-1 text-sm text-gris">
          Un solo archivo, hasta 4 MB. Se revisan todas las páginas, también las escaneadas.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <button
            type="button"
            disabled={busy}
            onClick={() => input.current?.click()}
            aria-describedby={`${hintId}${error ? ` ${errorId}` : ""}`}
            className="rounded bg-verde px-4 py-2 font-semibold text-papel hover:bg-tinta disabled:opacity-60"
          >
            {busy ? "Abriendo…" : "Elegir PDF"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onSample}
            className="rounded border border-linea-fuerte bg-hoja px-4 py-2 font-medium hover:bg-papel disabled:opacity-60"
          >
            Probar con el plano de ejemplo
          </button>
        </div>
        <input
          ref={input}
          type="file"
          accept="application/pdf,.pdf"
          className="sr-only"
          tabIndex={-1}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onFile(file);
            e.target.value = "";
          }}
        />
      </div>
      {error && (
        <p id={errorId} role="alert" className="mt-3 rounded border border-choque/30 bg-choque-suave px-3 py-2 text-sm text-choque">
          {error}
        </p>
      )}
    </div>
  );
}
