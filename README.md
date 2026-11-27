# Revisor de planos — WorldTeams

Herramienta web para revisar planos en PDF: marca dónde hay **textos encimados** (choques),
rótulos repetidos en el mismo lugar (duplicados) y textos que casi se tocan (cercanías). Cada
hallazgo se ve sobre el plano y en una lista, y se puede descargar el PDF original con los
hallazgos marcados.

Para usarla hay que entrar con una cuenta de Google **habilitada** y ver completo el **video de
inducción**: las dos condiciones se verifican en el servidor. Una tercera pantalla, **Avance**,
muestra quién de la lista de habilitados ya vio el video.

Stack: Next.js 16 (App Router), TypeScript, Tailwind, Supabase (Auth, Postgres, Storage), Vercel.
Los planos vectoriales se analizan con pdf.js y las páginas escaneadas con un modelo de visión
(DeepSeek).

## Correr en local

```bash
npm install                  # copia también el worker de pdf.js a public/
cp .env.example .env.local   # completar los valores (ver tabla)
npm run dev
npm test                     # pruebas unitarias
npm run eval                 # detector vectorial contra samples/expected.json (sin IA)
npm run muestras             # los 4 PDFs de samples/ contra lo esperado (usa la IA, ver abajo)
```

Variables de entorno. Los valores nunca se commitean: `.env*` está en `.gitignore`, salvo
`.env.example`, que sólo tiene los nombres.

| Variable | Dónde | Uso |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | navegador y servidor | URL del proyecto de Supabase |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | navegador y servidor | Clave pública (anon/publishable) |
| `SUPABASE_SERVICE_ROLE_KEY` | **sólo servidor** | Lee la lista de habilitados y escribe el avance del video |
| `VISION_PROVIDER` | sólo servidor | `deepseek` (por defecto) o `gemini` (experimental) |
| `DEEPSEEK_API_KEY` | **sólo servidor** | Modelo de visión para páginas escaneadas |
| `DEEPSEEK_MODEL` | sólo servidor | Por defecto `deepseek-flash` |
| `VISION_REASONING` | sólo servidor | Vacío (razonamiento por defecto) o `none` (ver "Consumo de la IA") |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | sólo servidor | **Experimental, no probado** contra la API real |

Sin `DEEPSEEK_API_KEY` la herramienta funciona igual con planos vectoriales; las páginas
escaneadas quedan "no verificadas".

## Base de datos (Supabase)

Todo está en `supabase/`:

| Archivo | Para qué |
|---|---|
| `schema.sql` | Esquema completo para un proyecto nuevo: tablas, vista, funciones, RLS, bucket y datos de ejemplo |
| `migrations/20261126_video_tope_latidos.sql` | Cambio para un proyecto que ya tenía el esquema anterior |
| `verificar_20261126.sql` | Controles de sólo lectura: cada fila tiene que decir `ok = true` |
| `migrations/20261127_historial_analisis.sql` | Tabla `analisis` de "Mi actividad", con RLS |
| `verificar_20261127_historial.sql` | Una fila de controles del historial: `todo_ok` tiene que dar `true` |

**Proyecto nuevo:**

1. Crear el proyecto en Supabase y copiar URL, clave anon y clave service_role a `.env.local`.
2. En el SQL Editor, cambiar los correos de ejemplo del final de `schema.sql` y ejecutarlo
   entero (es idempotente).
3. Storage → bucket `video` → subir el video como `worldteams-intro.mp4`.
4. Authentication → Providers → Google: cargar el Client ID y el secret de Google Cloud. En
   Google Cloud, la URI de redirección autorizada es `https://<proyecto>.supabase.co/auth/v1/callback`.
5. Authentication → URL Configuration: Site URL = la URL de producción, y en Redirect URLs
   `http://localhost:3000/auth/callback` y `https://<sitio>/auth/callback`.
6. Recomendado: desactivar el proveedor Email, porque la app sólo usa Google.
7. Ejecutar `verificar_20261126.sql` y `verificar_20261127_historial.sql`.

**Proyecto existente:** ejecutar la migración y después `verificar_20261126.sql`. El código
funciona antes y después de aplicarla, pero el control completo (incluidos dos latidos
simultáneos) queda recién con la migración.

Para el historial, ejecutar `migrations/20261127_historial_analisis.sql` y después
`verificar_20261127_historial.sql`. La verificación inserta una fila de prueba y prueba leer y
escribir como anon, como un usuario no habilitado y como dos personas habilitadas, dentro de una
transacción que termina en `ROLLBACK`: no deja nada guardado. Hasta aplicar la migración, el
detector funciona igual (registrar el historial falla en silencio) y "Mi actividad" muestra el
aviso de error.

Para habilitar a alguien más: `insert into public.allowed_emails (email, display_name) values
('correo@dominio.com', 'Nombre');`. El correo tiene que ir en minúsculas.

## Login con Google y lista de habilitados

- El ingreso es con Google a través de Supabase Auth (`/login` → Google → `/auth/callback`).
  El proveedor Google se configura en Supabase (Authentication → Providers), con la URL de
  `/auth/callback` del sitio en las Redirect URLs.
- **Lista de habilitados:** tabla `allowed_emails`. Al volver de Google, el callback compara el
  correo (sin distinguir mayúsculas) con esa tabla. Si no está, cierra la sesión y vuelve al login
  con el aviso "cuenta no habilitada". La comparación se repite en cada página y API protegida
  (`lib/guard.ts`), así que quitar a alguien de la lista le corta el acceso en su próximo pedido.
- La tabla sólo la lee el servidor, con la clave de service role: RLS no deja leerla con la
  clave pública.
- `proxy.ts` sólo refresca la cookie de sesión en cada pedido; no autoriza nada. El control está
  en cada página y API.
- **Limitación:** Supabase crea el usuario en `auth.users` al volver de Google, antes de que la
  app pueda revisar la lista. Una cuenta no habilitada queda registrada ahí, sin sesión ni acceso.
  Para evitarlo haría falta un *Before User Created hook* en Supabase Auth, que no está
  configurado.

## Mi actividad (historial)

- **Qué guarda:** una fila por PDF analizado en `public.analisis`, con nombre del archivo,
  páginas, páginas escaneadas, choques, duplicados, cercanías, páginas no verificadas y fecha.
  **Sólo metadatos:** ni el PDF, ni sus textos, ni el texto de los hallazgos.
- **Cuándo:** el detector lo registra una vez, al terminar todas las páginas
  (`lib/client/historial.ts`). No registra si alguna página salió del caché del navegador (ese
  archivo ya se había analizado), ni corridas cortadas, ni el "Reintentar" de una página.
- **A prueba de fallos:** el registro sale sin esperarlo, con un corte a los 10 s, y si falla
  (red, servidor, base, límite) sólo queda un aviso en la consola. El análisis y los resultados
  no dependen de él.
- **Escritura:** sólo `POST /api/historial` (`lib/historial.ts`), con la misma guarda que
  `/api/analyze`. Valida el cuerpo (tipos, rangos, campos de más, nombre hasta 255 caracteres,
  cuerpo hasta 2 KB), toma el correo de la sesión y nunca del cuerpo, e inserta con service_role.
  Límite por persona: 10 registros por minuto y 300 por día, contados en la base.
- **Lectura:** la pantalla `/historial` (sólo personas habilitadas) lee con la sesión del
  usuario. La política RLS deja ver sólo las filas propias (correo del JWT, que además tiene que
  seguir habilitado). Para eso `authenticated` puede ejecutar `is_allowed()`, que sólo responde
  por el correo de la propia sesión.
- **Al quitar a alguien de `allowed_emails`** se borra su historial (`on delete cascade`).

## Video obligatorio

El reproductor (`/video`) no deja adelantar ni cambiar la velocidad, pero eso es sólo comodidad:
**lo que vale es lo que acredita el servidor**.

- **Latidos:** mientras se reproduce, el navegador manda su posición cada 5 s (y al pausar) a
  `POST /api/video/heartbeat`. El usuario sale de la sesión, nunca del cuerpo del pedido.
- **Reglas de crédito** (`lib/video.ts → evaluateBeat`, con pruebas en `tests/video.test.mts`;
  las mismas en la función SQL `record_heartbeat`, que bloquea la fila):
  - un latido a menos de 4 s del último aceptado se ignora (no acredita ni mueve la hora), y el
    reproductor lo reenvía cuando corresponde: mandar latidos más seguidos no acelera nada;
  - cada latido acredita como mucho el tiempo real transcurrido × 1,02, con un máximo de 15 s;
  - en total, nunca más que el tiempo real desde el primer latido × 1,02 + 2 s;
  - el crédito nunca baja ni pasa la duración.

  Resultado medido en las pruebas: con latidos inventados cada 100 ms, 250 ms o 5 s, el video
  no se completa antes de ~145 s (mirándolo de verdad, a los ~150 s). Saltar al final, acelerar o
  mandar latidos falsos no sirve.
- **Duración fija en el servidor:** 152,853 s; no se usa la que informa el navegador. El video
  cuenta como visto al **98 %** (≈ 149,8 s).
- El avance se guarda en `video_progress` con la función `record_heartbeat` (sólo service role);
  `first_heartbeat_at` es el inicio y `completed_at` marca el completado. Al volver, el reproductor retoma desde lo acreditado.
- **Guardas:** `/detector` y `POST /api/analyze` llaman a `requireToolAccess()`: sesión válida +
  lista de habilitados + video completado según `video_progress`. Sin eso, la página redirige (al
  login, a cerrar sesión si la cuenta no está habilitada, o a `/video`) y la API responde 401/403
  sin analizar nada. Ocultar el botón en la interfaz no alcanzaría.
- **Avance** (`/avance`): todas las personas de la lista de habilitados, con estado (completo, en
  curso, no empezó el video), porcentaje y fechas.

## Descargar el PDF con marcas

Cuando termina el análisis, **Descargar PDF con marcas** baja `<nombre-original>-con-marcas.pdf`:
el mismo PDF que se subió, con una caja por hallazgo y una hoja de resumen al final. Se arma
entero en el navegador con [pdf-lib](https://github.com/Hopding/pdf-lib) (licencia MIT, se carga
recién al apretar el botón); el PDF marcado no pasa por el servidor.

- **Cajas:** mismo estilo que en pantalla: choque en rojo, duplicado en gris, cercanía en ámbar
  con línea punteada; relleno semitransparente y el número de la lista en un círculo en la
  esquina superior izquierda. Grosor y número son proporcionales al lado corto de la hoja (en A4
  ≈ 1,1 pt y A3 ≈ 1,5 pt), y una caja muy chica se agranda hasta un mínimo para que se vea. Con
  "Mostrar cercanías" apagado, las cercanías no se dibujan ni se listan.
- **Resumen:** nombre del archivo, fecha, cantidad de choques, duplicados y cercanías, páginas no
  verificadas (con el motivo) y la lista de hallazgos con número, página, zona y textos. Los
  textos de páginas escaneadas van rotulados "texto leído por IA (aproximado)". Sólo usa
  caracteres de Helvetica estándar (WinAnsi): una letra fuera de ese juego pierde el acento y un
  símbolo se cambia por "?".
- **Coordenadas:** las cajas del detector están en pt con origen arriba a la izquierda, en el
  espacio en que pdf.js dibuja la página (`getViewport({ scale: 1 })`). Para pasarlas al PDF se
  invierte esa misma matriz, armada con la caja visible de la página (`view`, CropBox ∩ MediaBox,
  con su origen) y con `/Rotate`; `tests/marked-pdf.test.mts` la compara con la de pdf.js en las
  cuatro rotaciones y con origen distinto de cero. Las cajas de páginas escaneadas salen de la
  caja normalizada (0–1) escalada al tamaño de la página, igual que en pantalla.
- **El texto original sigue seleccionable:** las marcas se agregan en un flujo de contenido aparte,
  sin tocar el de la página. Los números de los círculos son texto, así que también aparecen al
  buscar o copiar.

## Cómo detecta

Cada página se analiza por separado (`POST /api/analyze?page=N`), y una página que falla queda
marcada como **no verificada**, nunca se omite.

Todo se mide sobre la hoja **tal como se ve**: en pt, con origen arriba a la izquierda de la caja
visible (CropBox ∩ MediaBox) y ya girada según `/Rotate`. Es el mismo espacio en que pdf.js
dibuja la página (`getViewport({ scale: 1 })`), así que las cajas caen sobre el texto en pantalla
y en el PDF con marcas, y "sector superior izquierdo" o "entre ejes B–C" se refieren a lo que se
ve. Los planos de CAD suelen traer `/Rotate 90` con el contenido acostado en el PDF.

- **Páginas con texto (vectoriales):** se leen los textos del PDF con pdf.js, se llevan a la hoja
  que se ve con la matriz de pantalla de pdf.js y se arma la caja de tinta de cada uno (con la
  rotación del texto). Hay *choque* si las cajas se pisan y *cercanía* si quedan a
  2,5 pt o menos. No usa IA, y los resultados se marcan como "Texto del PDF".
  - pdf.js 6 junta en un solo texto dos rótulos del mismo renglón si están a menos de ~0,1 × el
    cuerpo (por ejemplo "NPT +0.15" y "ESC 1:50" a 1 pt), y ya no tiene opción para evitarlo.
    `lib/detector/runs.ts` reconstruye cada operación de texto del PDF y separa esos ítems sólo si
    vienen de bloques de texto distintos (`BT…ET`) y los textos y el largo coinciden con lo que dio
    pdf.js. En los 4 PDFs de muestra eso cambia únicamente ese caso.
- **Páginas escaneadas (sin texto):** se extrae la imagen embebida, se gira para que quede como se
  ve en pantalla (con `/Rotate 90` la IA ve el plano derecho, no acostado) y se divide en mosaicos
  que se envían a un modelo de visión (DeepSeek por defecto), que devuelve cajas normalizadas 0–1:
  1. Dos pasadas independientes: grilla de 2×2 mosaicos de ~1400 px y grilla *corrida* de 3×3,
     para que las uniones caigan en otro lugar. Se unen por posición (tolerancia 25 pt).
  2. **Ajuste a tinta:** la caja del modelo se usa como pista y se ajusta al renglón de texto
     real (el de más tinta que la toca), ignorando paredes y líneas. Se guarda la caja original
     del modelo (`modelBox`) para auditar.
  3. Se descartan duplicados (mismo texto a menos de 60 pt) y lo que sólo vio la segunda pasada
     sin encajar en un renglón.
  4. Los resultados se marcan "Detectado por IA" con su confianza, y el texto se rotula
     "texto leído por IA (aproximado)": el modelo puede leer mal ("H=0.40" por "H=2.40"). Lo
     exacto es la ubicación, no la transcripción. Una imagen torcida unos grados no se endereza:
     las cajas se dibujan sobre la misma imagen.
  5. No se mandan a la IA los mosaicos sin texto: se cuentan manchas de tinta con alto de letra
     y se saltea un mosaico sin ninguna (o con 1–2 en la pasada corrida, porque la primera ya
     cubre toda la página).
- **Tiempos:** corte de 20 s por llamada al modelo, con hasta 2 reintentos, y como mucho 6
  llamadas simultáneas por página. Pasados 60 s no se empieza ningún intento nuevo, así que la
  página termina antes de los 120 s de `maxDuration`. Una página escaneada tarda entre 5 y 60 s,
  y la interfaz lo avisa.
- **Duplicados:** el mismo texto dos veces casi en el mismo lugar (por ejemplo, negrita simulada
  o un rótulo pegado dos veces) se informa aparte, no como choque.

### Confianza de cada hallazgo

- **Choque vectorial:** la geometría es exacta, así que sólo mide cuánto se pisan:
  `0,75 + 0,5 × solapamiento`, con tope 0,99. El solapamiento es el área común dividida por el
  área del texto más chico (un choque necesita al menos 8 %).
- **Duplicado:** 0,90 fijo.
- **Cercanía:** 0,50 fijo. No es un error seguro, sino algo para mirar.
- **IA:** la confianza que declara el modelo (0–1; si no la da, 0,5). Se descarta lo que viene
  por debajo de 0,5. Si las dos pasadas vieron el mismo choque, suma 0,05, con tope 0,97. Es la
  opinión del modelo, no una probabilidad medida.

### Caché del navegador y "Volver a analizar"

- El resultado de cada página escaneada que salió bien se guarda en el navegador
  (`localStorage`). La clave es versión del detector + SHA-256 del PDF + número de página.
- Si se vuelve a subir el mismo archivo, esa página aparece al instante con la marca **"Resultado
  guardado"** y la fecha, sin consultar a la IA.
- **"Volver a analizar"** (junto a esa marca) borra lo guardado de esa página y la consulta de
  nuevo. "Reintentar", en una página no verificada, hace lo mismo.
- No se guardan las páginas vectoriales (se analizan en milisegundos) ni las no verificadas.
- Los resultados no salen del navegador. Limitación: no se comparten entre navegadores ni
  personas; un caché en el servidor necesitaría una tabla nueva en Supabase. Cambiar
  `DETECTOR_VERSION` (`lib/client/cache.ts`) invalida todo lo guardado. Si el almacenamiento se
  llena, se borran las entradas más viejas.

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
| 6 (escaneada, DeepSeek, antes de los ajustes de consumo, 10 corridas) | 29/30 choques, 2 de más, IoU medio 0,93, error de centro 0,3 pt |
| 6 (escaneada, configuración actual, 6 corridas) | 17/18 choques, 3 de más (todas en una corrida), IoU medio 0,92–0,93 |

- Los scripts para repetir estas mediciones están en "Scripts de medición", al final.

### Set de muestras y `npm run muestras`

`samples/` tiene 4 PDFs, más 3 con páginas rotadas:

| Archivo | Páginas | Qué prueba |
|---|---|---|
| `planos-prueba.pdf` | 5 vectoriales + 1 escaneada | Plano del enunciado, con trampas que no deben marcarse |
| `1-vectorial-A3-y-A4.pdf` | 2 vectoriales (A3 y A4) | Choques, un duplicado y una cercanía a 1 pt |
| `2-escaneado-solo-imagen.pdf` | 1 escaneada | Los mismos choques, sólo como imagen |
| `3-mixto-vector-escaneado-limpio.pdf` | vectorial, escaneada, vectorial limpia | Mezcla de tipos y una página sin hallazgos |
| `4-vectorial-rotado.pdf` | 5 vectoriales | Páginas de la muestra 1 con `/Rotate` 90, 180 y 270 (se ven giradas) y una con MediaBox/CropBox de origen distinto de cero |
| `5-cad-rotado.pdf` | 5 vectoriales | Como exporta un CAD: `/Rotate` 90/180/270 con el contenido girado al revés, y cajas corridas. Se ven igual que el original, con sus ejes |
| `6-escaneado-rotado.pdf` | 4 escaneadas | La escaneada de la muestra 2 del mismo modo (90, 180, 270 y origen corrido) |

- Las 3 rotadas y `samples/esperados-rotados.json` las arma `scripts/make-rotated-samples.mts`:
  mismos hallazgos que la página original, con la caja donde se ve y, en vectoriales, la zona
  que se ve. `tests/rotation.test.mts` y `tests/rotation-image.test.mts` las cubren sin IA.

- Lo esperado está en `samples/expected.json` (plano de prueba) y en `samples/esperados.json`
  (los 3 sintéticos). Si este último no está, se usa `samples/esperados-provisorio.json`, armado
  mirando los PDFs.
- `npm run muestras` analiza todo y muestra, por página: esperado, detectado, de más, tiempo y
  costo, con el detalle de lo que falta y lo que sobra. Las páginas escaneadas usan la IA
  (alrededor de 1 centavo de dólar por página).
- Criterio: en páginas vectoriales, mismo tipo y mismos textos (en las rotadas, además, la caja
  con IoU ≥ 0,5); en escaneadas, mismo tipo y posición (±10 pt), porque los textos que lee la IA
  pueden estar mal. El total se informa también por separado para los 4 PDFs originales y los
  rotados.
- La corrida queda en `bench/samples-ultima.json`.

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
  costo entre 7 y 9 veces menor (USD 0,0006–0,0018 por página), 4–6 s por página, sin marcas de
  más e IoU igual en la página 6 (24/24). Pero en 4 de 8 corridas perdió el choque "3.50 × 3.25" del PDF 2,
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
- **Baja resolución:** por debajo de 140 ppi (px de imagen por pulgada de hoja) la imagen se
  amplía hacia 200 ppi antes de partirla en mosaicos (tope ×2,5 y 16 mosaicos por página), y la
  interfaz y la hoja de resumen avisan "imagen de baja resolución". Con un plano real de 102 ppi
  (samples/7–9, opcionales con `REALES=1`; **requieren archivos locales no incluidos en el repo**: los 3 PDFs y `samples/esperados-planos-reales.json`) pasó de 1/5 con una marca de más a 4/5 sin marcas de
  más, pero ampliar no agrega detalle: las cotas chicas se leen mal (salen
  con otros números) y la cota vertical que pisa a otro texto no se detecta.
- **Marcas de más ocasionales:** el modelo a veces inventa un choque sobre un rótulo limpio (visto
  2 veces en 18 corridas sobre ESCALERA). Medir la densidad de tinta no sirve para filtrarlo
  (0,33 contra 0,35–0,38 en choques reales).
- **Variabilidad entre corridas:** el modelo no es determinista (en modo razonamiento ignora
  `temperature`). El mismo plano puede dar un resultado distinto en otra corrida: en las medidas,
  1 de cada 5 corridas pierde un choque o suma una marca. Algunas llamadas fallan o se demoran, y entonces la página
  queda "no verificada" y conviene reintentarla.
- **Páginas escaneadas:** sus resultados son orientativos y conviene confirmarlos a ojo (la
  interfaz lo avisa). Sólo se analiza la imagen más grande de cada página.
- **Gemini es experimental y no está probado:** existe un proveedor (`VISION_PROVIDER=gemini`),
  pero nunca se corrió contra la API real, porque no hubo clave para hacerlo. En la **cuota gratuita** de Google AI Studio, Google puede usar las
  imágenes enviadas para mejorar sus productos, así que no conviene usarla con planos
  confidenciales. En el plan pago eso no ocurre. Con DeepSeek, los planos también salen a un
  servicio externo.
- El PDF se envía al servidor en cada página (máximo 4 MB, por el límite de 4,5 MB de Vercel).
- **Páginas rotadas:** `/Rotate` y el origen de la MediaBox/CropBox se tienen en cuenta (ver
  "Cómo detecta"), pero sólo se probó con PDFs armados para eso (`samples/*-rotado.pdf`), no con
  planos reales de un CAD. Si una página escaneada se ve girada en pantalla (no "a lo CAD"), la
  IA recibe el texto de costado, como lo ve una persona; es esperable que acierte menos (no se midió).
- **Imágenes torcidas:** una imagen escaneada pegada con un giro que no es múltiplo de 90° se
  ubica por su envolvente y no se endereza: las cajas pueden quedar algo corridas.

## Scripts de medición (`scripts/`)

| Script | Para qué |
|---|---|
| `run-samples.mts`, `eval-samples.mts` | Corren los PDFs de `samples/` y los comparan con lo esperado (`npm run muestras`) |
| `consumo.mts` | Llamadas, mosaicos, tokens, tiempo y costo por página escaneada, sobre varias corridas |
| `eval-detector.mts` | Detector vectorial contra `samples/expected.json` (`npm run eval`) |
| `vision-bench.mts`, `rescore-bench.mts` | Corridas reales de la página 6 y su puntuación |
| `calib-synthetic.mts` | Calibración de coordenadas con imágenes sintéticas (respalda no corregir la escala) |
| `snap-offline.mts` | Ajuste a tinta sin llamar a la API |
| `../supabase/*.sql` | Esquema, migración y verificación de la base (ver "Base de datos") |
| `diag-coords.mts`, `crop-p6.mts`, `probe-image.mjs`, `dump-text.mjs`, `run-detector.mts` | Diagnósticos puntuales |

Los scripts que llaman a la IA leen las claves de `.env.local`. Los resultados quedan en `bench/`.
