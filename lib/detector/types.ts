import type { Polygon, Rect } from "./geometry";

/** Un texto del plano con su caja de tinta orientada. */
export type TextBox = {
  id: number;
  text: string;
  /** Esquinas de la caja (orden: inicio-abajo, fin-abajo, fin-arriba, inicio-arriba). */
  poly: Polygon;
  bounds: Rect;
  fontSize: number;
  /** Ángulo de la línea base en grados (0 horizontal, 90 vertical hacia arriba). */
  angle: number;
};

export type DetectorOptions = {
  /** Área intersectada mínima relativa al texto más chico (0–1). */
  minOverlapRatio: number;
  /** Área intersectada mínima absoluta en pt², para descartar roces de borde. */
  minOverlapArea: number;
  /** Ascendente y descendente como fracción del cuerpo de la fuente. */
  ascent: number;
  descent: number;
  /** Distancia (pt) por debajo de la cual dos textos se informan como "muy cerca" (no cuenta como choque). */
  nearGap: number;
};

export const DEFAULT_OPTIONS: DetectorOptions = {
  minOverlapRatio: 0.08,
  minOverlapArea: 1,
  ascent: 0.75,
  descent: 0.21,
  nearGap: 2.5,
};

export type Severity = "choque" | "cercania" | "duplicado";

export type Finding = {
  id: string;
  page: number;
  severity: Severity;
  /** Caja de la zona en pt de página (origen arriba-izquierda). */
  box: Rect;
  /** Caja normalizada 0–1 respecto de la página, para dibujar sobre cualquier render. */
  boxNorm: Rect;
  texts: string[];
  /** Ubicación legible: "entre ejes B–C / 4–5" o "sector superior izquierdo". */
  zone: string;
  confidence: number;
  /** Máximo solape relativo entre los textos de la zona (0–1); sólo páginas vectoriales. */
  overlapRatio?: number;
  source: "vector" | "vision";
  /** Etiqueta para mostrar y exportar: "Texto del PDF" o "Detectado por IA". */
  originLabel: string;
  provider?: string;
  /** Pasadas de visión que vieron este choque ("mosaicos", "pagina"). */
  passes?: string[];
  /** Resultado de la segunda mirada sobre el recorte (sólo visión). */
  refinement?: "ajustada" | "sin_confirmar" | "error";
  /** La caja se ajustó a la tinta del renglón real (sólo visión). */
  inkSnapped?: boolean;
  /** Caja original del modelo antes del ajuste a tinta (para auditar y volver a medir). */
  modelBox?: Rect;
};

export const ORIGIN_LABEL = { vector: "Texto del PDF", vision: "Detectado por IA" } as const;

export type PageKind = "vector" | "image" | "empty";

export type PageResult = {
  page: number;
  kind: PageKind;
  width: number;
  height: number;
  textCount: number;
  findings: Finding[];
  /** "no_verificada": la página no pudo analizarse (o sólo en parte). Nunca se omite. */
  status: "ok" | "no_verificada";
  error?: string;
  ms: number;
  notes?: string[];
};
