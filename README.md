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
- **Páginas escaneadas (sin texto):** se extrae la imagen embebida y se divide en mosaicos que se
  envían a un modelo de visión (DeepSeek por defecto), que devuelve cajas normalizadas 0–1:
  1. Dos pasadas independientes: grilla de 2×2 mosaicos de ~1400 px y grilla *corrida* de 3×3,
     para que las uniones caigan en otro lugar. Se unen por posición (tolerancia 25 pt).
  2. **Ajuste a tinta:** la caja del modelo se usa como pista y se ajusta al renglón de texto
     real (el de más tinta que la toca), ignorando paredes y líneas. Se guarda la caja original
     del modelo (`modelBox`) para auditar.
  3. Se descartan duplicados (mismo texto a menos de 60 pt) y lo que sólo vio la segunda pasada
     sin encajar en un renglón.
  4. Los resultados se marcan "Detectado por IA" con su confianza. La imagen no se endereza:
     las cajas se dibujan sobre la misma imagen.
- **Tiempos:** corte de 20 s por llamada al modelo, con hasta 2 reintentos. Pasados 60 s no se
  empieza ningún intento nuevo, así que la página termina antes de los 120 s de `maxDuration`. Una
  página escaneada tarda entre 5 y 60 s, y la interfaz lo avisa.

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

- Costo de la página 6: USD 0,005–0,023 por análisis (13 llamadas).
- Scripts para repetir las mediciones:
  - `scripts/vision-bench.mts`: corridas reales contra el modelo.
  - `scripts/rescore-bench.mts`: vuelve a puntuar corridas guardadas.
  - `scripts/calib-synthetic.mts`: calibración de coordenadas con imágenes sintéticas.
  - `scripts/snap-offline.mts`: ajuste a tinta sin llamar a la API.
- Los resultados crudos quedan en `bench/`.

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
- **Variabilidad entre corridas:** el modelo no es determinista aunque se pida `temperature=0`. El
  mismo plano puede dar un resultado distinto en otra corrida; en las medidas, 1 de cada 5 corridas
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
| `GEMINI_API_KEY`, `GEMINI_MODEL` | Sólo servidor (opcional) |
