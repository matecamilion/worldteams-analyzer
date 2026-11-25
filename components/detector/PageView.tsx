"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { NumberedFinding } from "@/lib/detector/report";
import { SEVERITY_LABEL } from "@/lib/detector/report";
import type { PageResult } from "@/lib/detector/types";
import {
  clampView,
  fullView,
  interpolate,
  panBy,
  sameView,
  translation,
  viewForBox,
  zoomAround,
  type Box,
  type View,
} from "@/lib/client/zoom";

export type PageStatus = "pendiente" | "analizando" | "ok" | "no_verificada";

/** Orden de zoom que manda el detector a una página: a una caja, o a la página completa (box null). */
export type ZoomCommand = { page: number; box: Box | null; nonce: number };

type Props = {
  doc: PDFDocumentProxy;
  pageNumber: number;
  status: PageStatus;
  /** Página escaneada: el análisis con IA puede tardar hasta un minuto. */
  scanned?: boolean;
  result?: PageResult;
  findings: NumberedFinding[];
  selectedId: string | null;
  showNear: boolean;
  zoom: ZoomCommand | null;
  onSelect: (id: string) => void;
  onCrops: (crops: Record<string, string>) => void;
  onRetry: () => void;
  /** El usuario tocó el zoom a mano (pellizco, arrastre, rueda) o pidió la página completa. */
  onZoomChange: (page: number, zoomed: boolean) => void;
};

const STROKE = { choque: "#c2261d", cercania: "#9a6200", duplicado: "#5b6b68" } as const;
/** Margen (pt) alrededor de la caja, para que el resaltado no tape las letras. */
const PAD_PT = 3;
/** Contexto (pt) que se incluye alrededor del choque en el recorte de la lista. */
const CROP_CONTEXT_PT = 22;
const ANIMATION_MS = 520;
/** Espera tras el último movimiento antes de redibujar nítido. */
const SETTLE_MS = 120;

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function PageView({
  doc,
  pageNumber,
  status,
  scanned,
  result,
  findings,
  selectedId,
  showNear,
  zoom,
  onSelect,
  onCrops,
  onRetry,
  onZoomChange,
}: Props) {
  const frameRef = useRef<HTMLDivElement>(null);
  const baseCanvasRef = useRef<HTMLCanvasElement>(null);
  const detailCanvasRef = useRef<HTMLCanvasElement>(null);
  const pageRef = useRef<PDFPageProxy | null>(null);
  const [pageSize, setPageSize] = useState<{ w: number; h: number } | null>(null);
  const [frameW, setFrameW] = useState(0);
  const [baseReady, setBaseReady] = useState(false);
  const [renderError, setRenderError] = useState(false);
  const [view, setView] = useState<View | null>(null);
  /** Vista para la que está dibujado el canvas nítido (si no coincide con la actual, se oculta). */
  const [detailView, setDetailView] = useState<View | null>(null);
  const [moving, setMoving] = useState(false);
  const viewRef = useRef<View | null>(null);
  const animRef = useRef<number | null>(null);
  const settleRef = useRef<number | null>(null);
  const detailTaskRef = useRef<{ cancel: () => void } | null>(null);
  const findingsKey = findings.map((f) => f.id).join(",");

  const frame = pageSize && frameW ? { w: frameW, h: (frameW * pageSize.h) / pageSize.w } : null;
  const zoomed = !!view && view.s > 1.01;

  // Tamaño del marco: sigue al ancho de la columna (la vista se guarda en pt y sobrevive al cambio).
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setFrameW(Math.round(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Vista general: se dibuja una vez, al ancho de la columna × densidad de pantalla.
  useEffect(() => {
    let cancelled = false;
    let task: { cancel: () => void; promise: Promise<unknown> } | null = null;
    (async () => {
      try {
        const page = await doc.getPage(pageNumber);
        pageRef.current = page;
        const base = page.getViewport({ scale: 1 });
        if (!cancelled) {
          setPageSize({ w: base.width, h: base.height });
          const v = fullView({ w: base.width, h: base.height });
          viewRef.current = v;
          setView(v);
        }
        const cssWidth = frameRef.current?.clientWidth || 900;
        const scale = Math.min(3, (cssWidth * Math.min(window.devicePixelRatio || 1, 2)) / base.width);
        const viewport = page.getViewport({ scale });
        const canvas = baseCanvasRef.current;
        if (!canvas || cancelled) return;
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        task = page.render({ canvas, viewport });
        await task.promise;
        if (!cancelled) setBaseReady(true);
      } catch (e) {
        if (!cancelled && (e as Error)?.name !== "RenderingCancelledException") setRenderError(true);
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, pageNumber]);

  // Recortes resaltados para la lista, desde la vista general (la imagen tal cual, sin enderezar).
  useEffect(() => {
    const canvas = baseCanvasRef.current;
    if (!canvas || !pageSize || !baseReady || !findings.length) return;
    const k = canvas.width / pageSize.w;
    const crops: Record<string, string> = {};
    for (const f of findings) {
      const x = Math.max(0, f.box.x - CROP_CONTEXT_PT);
      const y = Math.max(0, f.box.y - CROP_CONTEXT_PT);
      const w = Math.min(pageSize.w - x, f.box.w + 2 * CROP_CONTEXT_PT);
      const h = Math.min(pageSize.h - y, f.box.h + 2 * CROP_CONTEXT_PT);
      const out = document.createElement("canvas");
      const outScale = Math.min(1, 480 / (w * k));
      out.width = Math.round(w * k * outScale);
      out.height = Math.round(h * k * outScale);
      const ctx = out.getContext("2d");
      if (!ctx) continue;
      ctx.drawImage(canvas, x * k, y * k, w * k, h * k, 0, 0, out.width, out.height);
      const s = k * outScale;
      ctx.lineWidth = 2;
      ctx.strokeStyle = STROKE[f.severity];
      if (f.severity === "cercania") ctx.setLineDash([6, 4]);
      ctx.strokeRect((f.box.x - x - PAD_PT) * s, (f.box.y - y - PAD_PT) * s, (f.box.w + 2 * PAD_PT) * s, (f.box.h + 2 * PAD_PT) * s);
      crops[f.id] = out.toDataURL("image/png");
    }
    onCrops(crops);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseReady, pageSize, findingsKey]);

  const applyView = useCallback((v: View) => {
    viewRef.current = v;
    setView(v);
  }, []);

  const stopAnimation = () => {
    if (animRef.current !== null) cancelAnimationFrame(animRef.current);
    animRef.current = null;
  };

  /** Lleva la vista a `target` con easing, o de golpe si el usuario pidió menos movimiento. */
  const animateTo = useCallback(
    (target: View) => {
      stopAnimation();
      const from = viewRef.current;
      if (!from || reducedMotion() || sameView(from, target)) {
        applyView(target);
        setMoving(false);
        return;
      }
      setMoving(true);
      const start = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - start) / ANIMATION_MS);
        applyView(interpolate(from, target, t));
        if (t < 1) animRef.current = requestAnimationFrame(step);
        else {
          animRef.current = null;
          setMoving(false);
        }
      };
      animRef.current = requestAnimationFrame(step);
    },
    [applyView],
  );

  // Órdenes de zoom del detector (clic en un hallazgo, flechas, Esc, "Ver página completa").
  useEffect(() => {
    if (!zoom || !pageSize) return;
    if (zoom.page !== pageNumber) {
      // Otra página tomó el foco: ésta vuelve a la vista general sin animar (ya no está a la vista).
      if (viewRef.current && viewRef.current.s > 1) {
        stopAnimation();
        applyView(fullView(pageSize));
      }
      return;
    }
    animateTo(zoom.box ? viewForBox(zoom.box, pageSize) : fullView(pageSize));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom?.nonce, pageSize]);

  // Redibujo nítido de lo visible cuando la vista se queda quieta.
  useEffect(() => {
    if (!view || !frame || !pageSize || moving) return;
    if (settleRef.current) window.clearTimeout(settleRef.current);
    // Sin zoom alcanza la vista general (la capa nítida se oculta sola: detailVisible exige zoom).
    if (view.s <= 1.01) return;
    settleRef.current = window.setTimeout(async () => {
      const page = pageRef.current;
      const canvas = detailCanvasRef.current;
      if (!page || !canvas) return;
      detailTaskRef.current?.cancel();
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const { k, tx, ty } = translation(view, pageSize, frame);
      // Viewport de pdfjs a la escala final real (px por pt × dpr). La página escaneada se pinta
      // desde la imagen original embebida a esta escala, no ampliando la vista general.
      const viewport = page.getViewport({ scale: k * view.s * dpr });
      const off = document.createElement("canvas");
      off.width = Math.round(frame.w * dpr);
      off.height = Math.round(frame.h * dpr);
      const task = page.render({ canvas: off, viewport, transform: [1, 0, 0, 1, tx * dpr, ty * dpr] });
      detailTaskRef.current = task;
      try {
        await task.promise;
      } catch {
        return; // cancelado por un movimiento nuevo
      }
      if (!sameView(viewRef.current ?? view, view)) return;
      canvas.width = off.width;
      canvas.height = off.height;
      canvas.getContext("2d")?.drawImage(off, 0, 0);
      setDetailView(view);
    }, SETTLE_MS);
    return () => {
      if (settleRef.current) window.clearTimeout(settleRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, moving, frameW]);

  useEffect(() => () => {
    stopAnimation();
    detailTaskRef.current?.cancel();
  }, []);

  // Gestos: arrastre con un dedo/mouse cuando hay zoom, pellizco con dos dedos, ctrl+rueda (trackpad).
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ dragging: boolean; startX: number; startY: number; pinchDist: number | null }>({
    dragging: false,
    startX: 0,
    startY: 0,
    pinchDist: null,
  });
  const suppressClick = useRef(false);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = frameRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!frame) return;
    pointers.current.set(e.pointerId, local(e));
    gesture.current = { dragging: false, startX: e.clientX, startY: e.clientY, pinchDist: null };
    suppressClick.current = false;
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      stopAnimation();
      setMoving(true);
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!frame || !pageSize || !pointers.current.has(e.pointerId)) return;
    const prev = pointers.current.get(e.pointerId)!;
    const cur = local(e);
    pointers.current.set(e.pointerId, cur);
    const v = viewRef.current ?? fullView(pageSize);

    if (pointers.current.size === 2 && gesture.current.pinchDist) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      applyView(zoomAround(v, dist / gesture.current.pinchDist, mid, pageSize, frame));
      gesture.current.pinchDist = dist;
      suppressClick.current = true;
      onZoomChange(pageNumber, true);
      return;
    }
    if (pointers.current.size !== 1 || v.s <= 1.01) return;
    if (!gesture.current.dragging) {
      if (Math.hypot(e.clientX - gesture.current.startX, e.clientY - gesture.current.startY) < 5) return;
      gesture.current.dragging = true;
      suppressClick.current = true;
      stopAnimation();
      setMoving(true);
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }
    applyView(panBy(v, cur.x - prev.x, cur.y - prev.y, pageSize, frame));
  };

  const endPointer = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size === 0) {
      if (gesture.current.dragging || gesture.current.pinchDist) setMoving(false);
      gesture.current.dragging = false;
      gesture.current.pinchDist = null;
      if (viewRef.current && viewRef.current.s <= 1.01) onZoomChange(pageNumber, false);
    }
  };

  // La rueda se registra a mano para poder cancelar el zoom del navegador (listener no pasivo).
  useEffect(() => {
    const el = frameRef.current;
    if (!el || !frame || !pageSize) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      stopAnimation();
      const r = el.getBoundingClientRect();
      const v = viewRef.current ?? fullView(pageSize);
      const next = zoomAround(v, Math.exp(-e.deltaY * 0.01), { x: e.clientX - r.left, y: e.clientY - r.top }, pageSize, frame);
      applyView(next);
      onZoomChange(pageNumber, next.s > 1.01);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [frame?.w, frame?.h, pageSize, applyView, onZoomChange, pageNumber]); // eslint-disable-line react-hooks/exhaustive-deps

  const showFull = () => {
    if (!pageSize) return;
    animateTo(fullView(pageSize));
    onZoomChange(pageNumber, false);
  };

  const visible = findings.filter((f) => showNear || f.severity !== "cercania");
  const kindLabel =
    result?.kind === "image" ? "Escaneada · revisada con IA" : result?.kind === "vector" ? "Texto del PDF" : result?.kind === "empty" ? "Sin contenido" : null;
  const clashes = findings.filter((f) => f.severity === "choque").length;
  const t = view && frame && pageSize ? translation(clampView(view, pageSize), pageSize, frame) : null;
  const detailVisible = !!detailView && !!view && sameView(detailView, view) && zoomed;

  return (
    <section id={`pagina-${pageNumber}`} aria-labelledby={`pagina-${pageNumber}-titulo`} className="scroll-mt-28">
      <header className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id={`pagina-${pageNumber}-titulo`} className="font-display text-base font-semibold">
          Página {pageNumber}
        </h2>
        {kindLabel && <span className="text-sm text-gris">{kindLabel}</span>}
        <span className="ml-auto text-sm">
          {status === "pendiente" && <span className="text-gris">En espera</span>}
          {status === "analizando" && (
            <span className="text-tinta">{scanned ? "Analizando con IA, puede tardar hasta un minuto…" : "Analizando…"}</span>
          )}
          {status === "ok" &&
            (clashes ? (
              <span className="font-semibold text-choque">
                {clashes} {clashes === 1 ? "choque" : "choques"}
              </span>
            ) : (
              <span className="text-ok">Sin choques</span>
            ))}
          {status === "no_verificada" && (
            <span className="inline-flex items-center gap-2">
              <span className="font-semibold text-cercania">No verificada</span>
              <button type="button" onClick={onRetry} className="rounded border border-linea-fuerte bg-hoja px-2 py-0.5 text-tinta hover:bg-papel">
                Reintentar
              </button>
            </span>
          )}
        </span>
      </header>

      <div
        id={`marco-${pageNumber}`}
        ref={frameRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onClickCapture={(e) => {
          // Un arrastre o pellizco no debe terminar seleccionando la caja que quedó debajo.
          if (suppressClick.current) {
            e.stopPropagation();
            suppressClick.current = false;
          }
        }}
        className={`relative overflow-hidden rounded-sm border border-linea-fuerte bg-hoja shadow-[0_1px_2px_rgb(13_33_31/0.06)] select-none ${
          zoomed ? "cursor-grab touch-none active:cursor-grabbing" : "touch-pan-y"
        }`}
        style={{ aspectRatio: pageSize ? `${pageSize.w} / ${pageSize.h}` : "1190 / 842" }}
      >
        {/* Capa de la vista general: se mueve con transform durante la animación y los gestos. */}
        <div
          className="absolute top-0 left-0 origin-top-left will-change-transform"
          style={
            t && frame
              ? { width: frame.w, height: frame.h, transform: `translate(${t.tx}px, ${t.ty}px) scale(${view!.s})` }
              : { inset: 0 }
          }
        >
          <canvas ref={baseCanvasRef} className="block h-full w-full" role="img" aria-label={`Plano, página ${pageNumber}`} />
        </div>
        {/* Capa nítida: lo visible redibujado a la escala final. Se oculta apenas la vista cambia. */}
        <canvas
          ref={detailCanvasRef}
          aria-hidden
          className={`pointer-events-none absolute inset-0 h-full w-full ${detailVisible ? "opacity-100" : "opacity-0"}`}
        />

        {!baseReady && !renderError && <div className="absolute inset-0 animate-pulse bg-papel/70" aria-hidden />}
        {renderError && (
          <p className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-gris">
            No se pudo dibujar esta página en el navegador. Los resultados de la lista siguen siendo válidos.
          </p>
        )}
        {status === "analizando" && (
          <div className="absolute inset-x-0 top-0 h-1 overflow-hidden bg-salvia/20" aria-hidden>
            <div className="h-full w-1/3 animate-[barrido_1.2s_ease-in-out_infinite] bg-salvia" />
          </div>
        )}

        {/* Cajas en coordenadas de pantalla: el borde mantiene su grosor con cualquier zoom. */}
        {t &&
          view &&
          visible.map((f) => {
            const sc = t.k * view.s;
            const selected = f.id === selectedId;
            const tone =
              f.severity === "choque"
                ? "border-choque bg-choque/[0.07]"
                : f.severity === "cercania"
                  ? "border-dashed border-cercania bg-cercania/[0.05]"
                  : "border-gris bg-gris/5";
            const badge = f.severity === "choque" ? "bg-choque" : f.severity === "cercania" ? "bg-cercania" : "bg-gris";
            return (
              <button
                key={f.id}
                id={`caja-${f.id}`}
                type="button"
                onClick={() => onSelect(f.id)}
                aria-label={`Hallazgo ${f.n}: ${SEVERITY_LABEL[f.severity]} entre ${f.texts.join(" y ")}`}
                aria-pressed={selected}
                className={`absolute rounded-[2px] border-2 ${tone} shadow-[0_0_0_1px_rgb(255_255_255/0.9)] ${
                  selected ? "ring-2 ring-tinta ring-offset-2 ring-offset-white" : ""
                }`}
                style={{
                  left: t.tx + (f.box.x - PAD_PT) * sc,
                  top: t.ty + (f.box.y - PAD_PT) * sc,
                  width: (f.box.w + 2 * PAD_PT) * sc,
                  height: (f.box.h + 2 * PAD_PT) * sc,
                }}
              >
                <span
                  className={`num absolute -top-2.5 -left-2.5 grid h-5 min-w-5 place-items-center rounded-full px-1 text-[11px] leading-none font-bold text-white ring-2 ring-white ${badge}`}
                >
                  {f.n}
                </span>
              </button>
            );
          })}

        {/* Controles fijos en pantalla: el marco puede ser más alto que la ventana y su borde quedar fuera de vista. */}
        {zoomed && (
          <div className="fixed bottom-4 left-4 z-30 flex items-center gap-2 sm:left-6">
            <span className="num rounded bg-verde/85 px-2 py-1 text-xs font-medium text-papel" aria-live="polite">
              {Math.round(view!.s * 100)}&nbsp;%
            </span>
            <button
              type="button"
              onClick={showFull}
              className="rounded bg-hoja px-3 py-1.5 text-sm font-semibold shadow-[0_1px_3px_rgb(13_33_31/0.25)] hover:bg-papel"
            >
              Ver página completa <kbd className="ml-1 rounded border border-linea-fuerte px-1 text-[11px] font-normal text-gris">Esc</kbd>
            </button>
          </div>
        )}
      </div>
      {result?.error && status === "no_verificada" && <p className="mt-2 text-sm text-cercania">{result.error}</p>}
    </section>
  );
}
