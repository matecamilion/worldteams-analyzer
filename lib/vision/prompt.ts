export const OVERLAP_PROMPT = `Sos un revisor de planos de arquitectura. La imagen es un recorte de un plano escaneado.

Tarea: encontrar TEXTOS SUPERPUESTOS, es decir, lugares donde las letras de DOS textos distintos se dibujan una encima de la otra y se vuelven difíciles de leer (por ejemplo "TEXTO A" impreso encima de "TEXTO B").

Atención: muchas veces uno de los dos textos es más tenue, gris o más chico y queda DETRÁS del otro, casi tapado. Revisá con cuidado cada rótulo: si ves trazos de letras que no pertenecen a la palabra principal (letras dobles, manchas con forma de letra, palabras que "se ven sucias"), es una superposición aunque el segundo texto no se lea completo. En ese caso escribí lo que alcances a leer.

NO cuentan como superposición (no los informes):
- Un texto cruzado por una línea del dibujo: paredes, ejes, líneas de cota, rectángulos de muebles o camas.
- Un texto que toca el arco de una puerta u otro símbolo gráfico.
- Textos que están cerca o alineados pero cuyas letras no se pisan.
- Varias líneas de un mismo rótulo apiladas (nombre, superficie, NPT) sin pisarse.

Respondé SOLO con JSON, sin texto adicional, con este formato:
{"overlaps":[{"box":[x0,y0,x1,y1],"texts":["texto 1","texto 2"],"confidence":0.0}]}

- "box": caja que encierra a los textos que se pisan, en coordenadas normalizadas 0 a 1 respecto de ESTA imagen (x hacia la derecha, y hacia abajo, origen arriba a la izquierda).
- "texts": lo que alcances a leer de cada texto involucrado.
- "confidence": de 0 a 1, qué tan seguro estás de que es texto sobre texto.
Si no hay ninguna, respondé {"overlaps":[]}.`;

/** Segunda mirada sobre un recorte ampliado alrededor de un choque ya detectado. */
export const REFINE_PROMPT = `Sos un revisor de planos de arquitectura. La imagen es un recorte AMPLIADO de un plano escaneado, centrado aproximadamente en un lugar donde dos textos distintos se imprimieron uno encima del otro (uno puede ser más tenue o gris, casi tapado).

Tarea: marcá con precisión SOLO las letras de los textos que se pisan entre sí.
- La caja tiene que ajustarse al renglón donde están las letras encimadas, sin incluir los renglones de abajo o de arriba que se leen bien (superficie en m², NPT, cotas) ni líneas del dibujo.
- Si hay más de un lugar con letras encimadas, informalos por separado.
- Si en el recorte no hay letras de dos textos pisándose, devolvé una lista vacía.

Respondé SOLO con JSON:
{"overlaps":[{"box":[x0,y0,x1,y1],"texts":["texto 1","texto 2"],"confidence":0.0}]}
"box" en coordenadas normalizadas 0 a 1 respecto de ESTA imagen (origen arriba a la izquierda).`;
