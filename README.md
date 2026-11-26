# Revisor de planos — WorldTeams

Detector de textos superpuestos en planos PDF, con acceso por Google (allowlist) y video obligatorio.

> README en construcción: login, video y lista de avance se documentan cuando estén terminados.

## Correr en local

```bash
npm install          # copia también el worker de pdf.js a public/
cp .env.example .env.local   # completar valores
npm run dev
npm test             # pruebas unitarias
npm run eval         # mide el detector vectorial contra samples/expected.json
```

## Detector de textos superpuestos

Cada página se analiza por separado (`POST /api/analyze?page=N`), y una página que falla queda
marcada como **no verificada**, nunca se omite.

- **Páginas con texto (vectoriales):** se leen los textos del PDF con pdf.js y se arma la caja de
  tinta de cada uno (con rotación). Hay *choque* si las cajas se pisan y *cercanía* si quedan a
  2,5 pt o menos. No usa IA, y los resultados se marcan como "Texto del PDF".
  - pdf.js 6 junta en un solo texto dos rótulos del mismo renglón si están a menos de ~0,1 × el
    cuerpo (por ejemplo "NPT +0.15" y "ESC 1:50" a 1 pt), y ya no tiene opción para evitarlo.
    `lib/detector/runs.ts` reconstruye cada operación de texto del PDF y separa esos ítems sólo si
    vienen de bloques de texto distintos (`BT…ET`) y los textos y el largo coinciden con lo que dio
    pdf.js. En los 4 PDFs de muestra eso cambia únicamente ese caso.
- **Páginas escaneadas (sin texto):** se extrae la imagen embebida y se divide en mosaicos que se
  envían a un modelo de visión (DeepSeek por defecto), que devuelve cajas normalizadas 0–1:
  1. Dos pasadas independientes: grilla de 2×2 mosaicos de ~1400 px y grilla *corrida* de 3×3,
     para que las uniones caigan en otro lugar. Se unen por posición (tolerancia 25 pt).
  2. **Ajuste a tinta:** la caja del modelo se usa como pista y se ajusta al renglón de texto
     real (el de más tinta que la toca), ignorando paredes y líneas. Se guarda la caja original
     del modelo (`modelBox`) para auditar.
  3. Se descartan duplicados (mismo texto a menos de 60 pt) y lo que sólo vio la segunda pasada
     sin encajar en un renglón.
  4. Los resultados se marcan "Detectado por IA" con su confianza, y el texto se rotula
     "texto leído por IA (aproximado)": el modelo puede leer mal ("H=0.40" por "H=2.40"). Lo
     exacto es la ubicación, no la transcripción. La imagen no se endereza: las cajas se dibujan
     sobre la misma imagen.
  5. No se mandan a la IA los mosaicos sin texto: se cuentan manchas de tinta con alto de letra
     y se saltea un mosaico sin ninguna (o con 1–2 en la pasada corrida, porque la primera ya
     cubre toda la página).
- **Tiempos:** corte de 20 s por llamada al modelo, con hasta 2 reintentos, y como mucho 6
  llamadas simultáneas por página. Pasados 60 s no se empieza ningún intento nuevo, así que la
  página termina antes de los 120 s de `maxDuration`. Una página escaneada tarda entre 5 y 60 s,
  y la interfaz lo avisa.
- **Caché de resultados:** el resultado de cada página escaneada que salió bien se guarda en el
  navegador (`localStorage`), con la clave versión del detector + SHA-256 del PDF + número de
  página. Si se vuelve a subir el mismo archivo, esa página se muestra al instante con la marca
  "Resultado guardado" y la fecha, sin consultar a la IA; "Volver a analizar" la consulta de nuevo.
  Las páginas vectoriales no se guardan, porque se analizan en milisegundos. Los resultados no
  salen del navegador. Limitación: no se comparte entre navegadores ni personas; un caché en el
  servidor necesitaría una tabla nueva en Supabase. Cambiar `DETECTOR_VERSION`
  (`lib/client/cache.ts`) invalida todo lo guardado.

### Cómo se midió

- `samples/expected.json` tiene los choques esperados de las 6 páginas del plano de prueba,
  incluidas las páginas 2 y 5 (sin choques) y las trampas que **no** deben marcarse (texto
  cruzado por una línea, arco de puerta, casos límite).
- En la página 6 las cajas esperadas se midieron sobre los píxeles de tinta de la imagen, no a
  ojo.
- **Métrica:** un choque informado acierta si su IoU con la caja esperada es ≥ 0,3, con
  emparejamiento uno a uno. Se informan aciertos, marcas de más, IoU medio y error del centro.
- **Criterio de casos límite:** ASCENSOR × "1,10x1,30" (página 1) están a 2,0 pt y la tinta no
  se toca, así que se informa como *cercanía*, no como choque.

| Páginas | Resultado |
|---|---|
| 1–5 (vectoriales) | 7/7 choques, 0 de más |
| 6 (escaneada, DeepSeek, config. final, 10 corridas) | 29/30 choques, 2 de más, IoU medio 0,93, error de centro 0,3 pt |

- **Muestras sintéticas:** `npm run muestras` corre los 4 PDFs de `samples/` y muestra, por
  página, esperado contra detectado y las marcas de más. Compara con `samples/esperados.json` (o,
  si no está, con `samples/esperados-provisorio.json`, armado mirando los PDFs) y con
  `samples/expected.json` para el plano de prueba.
- Scripts para repetir las mediciones:
  - `scripts/vision-bench.mts`: corridas reales contra el modelo.
  - `scripts/rescore-bench.mts`: vuelve a puntuar corridas guardadas.
  - `scripts/calib-synthetic.mts`: calibración de coordenadas con imágenes sintéticas.
  - `scripts/snap-offline.mts`: ajuste a tinta sin llamar a la API.
- Los resultados crudos quedan en `bench/`.

### Consumo de la IA

Medido el 26/11/2026 con `scripts/run-samples.mts` y `scripts/consumo.mts`, 3 corridas por
configuración, sobre las 3 páginas escaneadas de las muestras. Costo con tarifas de DeepSeek
(fuera de pico – pico), contando la entrada que sale del caché de DeepSeek (más barata).

| Página escaneada | Antes: llamadas · tiempo · USD | Ahora: llamadas · tiempo · USD |
|---|---|---|
| planos-prueba p6 | 13–15 · 24 s · 0,0056–0,0112 | 12–13 · 23–27 s · 0,0047–0,0121 |
| 2-escaneado p1 | 18–19 · 17 s · 0,0064–0,0128 | 17 · 13–15 s · 0,0043–0,0105 |
| 3-mixto p2 | 18 · 10 s · 0,0037–0,0075 | 17 · 11–14 s · 0,0040–0,0086 |

- **Dónde está el costo:** ~90 % es salida, y ~94 % de esa salida es **razonamiento interno**
  del modelo (DeepSeek razona por defecto). El JSON de respuesta ya es compacto (~50 tokens).
  El ~80 % de la entrada sale del caché de DeepSeek.
- **Qué se aplicó:** saltear mosaicos sin texto (1 llamada menos por página), 6 llamadas
  simultáneas como tope y `max_tokens` 8192 como seguridad (una respuesta cortada se reintenta).
  Calidad en 6 corridas: 137/138 detectados y 3 marcas de más, todas en una misma corrida, contra
  68/69 y 1 de más en las 3 corridas previas. Es variabilidad del modelo y no un efecto de los
  cambios: no hubo respuestas cortadas.
- **Qué se probó y se descartó:** razonamiento "low" no bajó el costo y sumó marcas de más.
- **Opción medida, no activada:** `VISION_REASONING=none` apaga el razonamiento. En 8 corridas:
  costo entre 7 y 9 veces menor (USD 0,0006–0,0018 por página), 4–6 s por página, sin marcas de más e IoU
  igual en la página 6 (24/24). Pero en 4 de 8 corridas perdió el choque "3.50 × 3.25" del PDF 2,
  que con razonamiento se encuentra siempre.
- **Temperatura:** en modo razonamiento DeepSeek ignora `temperature` (según su documentación).
  Por eso las corridas varían aunque se pida 0.

### Decisiones descartadas, con números

- **Pasada de página entera:** sumó 4 marcas dudosas en 5 corridas y no rescató ningún choque.
- **Refinamiento con IA sobre un recorte de 40 pt:** IoU 0,59 contra 0,93 del ajuste a tinta, con
  el doble de llamadas. Quedó implementado pero apagado (`refine`).
- **Corrección de escala de coordenadas:** con imágenes sintéticas, el error proporcional a la
  posición es ≤ 5 pt de punta a punta del mosaico, contra ~9 pt de error aleatorio. No se corrige.
- **Mosaicos cuadrados:** no reducen el error y encuentran menos choques (23/45 contra 36/45).

### Limitaciones

- **Muestra pequeña:** la exactitud en páginas escaneadas se midió con **un solo plano y 3
  choques**. Los números son indicativos, no una garantía para otros planos.
- **Calibrado con este plano:** estos parámetros se ajustaron con el plano de prueba y pueden
  necesitar ajuste con otros escaneos (otra resolución, texto más fino, escaneos claros o con
  ruido):
  - umbral de gris 110;
  - criterio del "renglón de más tinta";
  - mínimo de 60 % de alto del renglón;
  - márgenes de búsqueda.

  El detector vectorial también se afinó con este archivo, aunque lo cubren pruebas sintéticas.
- **Marcas de más ocasionales:** el modelo a veces inventa un choque sobre un rótulo limpio (visto
  2 veces en 18 corridas sobre ESCALERA). Medir la densidad de tinta no sirve para filtrarlo
  (0,33 contra 0,35–0,38 en choques reales).
- **Variabilidad entre corridas:** el modelo no es determinista (en modo razonamiento ignora
  `temperature`). El mismo plano puede dar un resultado distinto en otra corrida; en las medidas, 1 de cada 5 corridas
  pierde un choque o suma una marca. Algunas llamadas fallan o se demoran, y entonces la página
  queda "no verificada" y conviene reintentarla.
- **Páginas escaneadas:** sus resultados son orientativos y conviene confirmarlos a ojo (la
  interfaz lo avisa). Sólo se analiza la imagen más grande de cada página.
- **Privacidad con Gemini:** existe un proveedor Gemini (`VISION_PROVIDER=gemini`) que todavía no
  se probó contra la API real. En la **cuota gratuita** de Google AI Studio, Google puede usar las
  imágenes enviadas para mejorar sus productos, así que no conviene usarla con planos
  confidenciales. En el plan pago eso no ocurre. Con DeepSeek, los planos también salen a un
  servicio externo.
- El PDF se envía al servidor en cada página (máximo 4 MB, por el límite de 4,5 MB de Vercel).

## Variables de entorno

| Variable | Uso |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Cliente de Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Sólo servidor: escribe el avance del video |
| `VISION_PROVIDER` | `deepseek` (por defecto) o `gemini` |
| `DEEPSEEK_API_KEY`, `DEEPSEEK_MODEL` | Sólo servidor |
| `VISION_REASONING` | Vacío (razonamiento por defecto) o `none` para apagarlo (ver "Consumo de la IA") |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | Sólo servidor (opcional) |
