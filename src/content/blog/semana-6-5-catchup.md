---
title: "Semana 6.5: lo que ya sabía se me estaba oxidando"
description: "Semana de catch-up entre Módulo 1.1 y System Design: repaso con preguntas de verdad (no lectura pasiva), tres temas nuevos (encoding vs embeddings, por qué la atención es O(n²), RNN/LSTM), y el primer intento de explicar algo técnico en voz alta y sin apuntes."
pubDate: 2026-09-03
tags: ["ai-engineering", "llm", "attention"]
draft: false
---

Después de cerrar la Semana 6 (replicación) tocaba la Semana 6.5: no es contenido nuevo del plan, es una parada para repasar Módulo 1.1 y System Design antes de seguir con partitioning. La agregué hace unas semanas, y terminó ampliándose después de una práctica de entrevista real donde encontré que mi intuición estaba bien pero el mecanismo exacto (fórmulas, el "por qué" preciso) se me erosiona más rápido de lo que pensaba.

Esta semana confirmó eso de la peor manera posible: leer un resumen se siente como saber algo. Responder una pregunta sobre eso mismo es otra cosa completamente distinta.

## Repaso: releer no es recordar

La sesión arrancó con un resumen que me habían dado en otra sesión, bien escrito y bien organizado, sobre las Semanas 1 a 6. Lo leí, me pareció que lo entendía todo, y ahí mismo me lo probaron con preguntas directas en vez de dejarme repetir el texto. Ahí aparecieron los huecos reales, no los que yo creía tener.

Algunos de los que más me costaron:

**La regla de la cadena en el grafo, invertida tres veces seguidas.** Esto lo tenía "dominado" desde la Semana 1, pero dije que en serie se suma y en paralelo se multiplica. Es al revés: **en serie multiplicás, en paralelo sumás**. Lo que me sacó del error no fue que me repitieran la regla, fue expandir la expresión a mano: `(x*4) * 2 + x * 7` se convierte en `8x + 7x = 15x`. Ahí se ve solo: los factores que van en cadena se componen (multiplican), los aportes que llegan por caminos distintos se acumulan (suman).

**El fencing token, otra vez.** Ya lo había explicado mal en la Semana 6, y esta vez también arranqué diciendo que el líder viejo "se entera y se degrada". No es así. Nadie le avisa. El líder viejo revive convencido de que sigue siendo líder, y recién se entera cuando intenta escribir y el storage le rechaza la escritura por tener un token menor al vigente. El storage ni siquiera sabe quién es el líder: solo guarda el número más alto que vio y compara. La protección está ahí, no en que el líder viejo coopere.

**Sync y semi-sync, con la misma definición para los dos.** Dije "esperar a que uno responda" para describir tanto sync como semi-sync, cuando la única diferencia entre los tres modos es **a cuántos followers espera el líder antes de confirmar**: todos (sync), al menos uno (semi-sync), o ninguno (async).

**El storage del capstone estaba subestimado casi 4 veces.** Tenía anotado "~10 TB anuales" para transacciones, pero esa cuenta solo tenía retención aplicada. Le faltaban el overhead de índices (+30%, regla de bolsillo) y el factor de replicación (×3, que ya había decidido en la Semana 6 pero nunca volví a aplicar a esta estimación). La cadena completa: 25 GB/día → 9.1 TB/año → 11.9 TB con índices → **35.6 TB reales** con replicación.

## Los tres temas nuevos

Acá sí era contenido que nunca había visto, para cerrar del todo el Módulo 1.1.

### Encoding clásico vs. embeddings

Antes de los embeddings, representar una letra era one-hot: un vector del tamaño del vocabulario, todo ceros salvo un `1` en la posición de esa letra. El problema se ve con mi propio vocabulario de `embeddings.py` (12 caracteres): el producto punto entre el one-hot de `a` y el de `e` da `0`, exactamente lo mismo que entre `a` y `.`. No hay manera de capturar que se parezcan, porque si los multiplicás columna por columna (uno y cero, cero y uno, cero y cero...) todo da cero igual.

Y no es casualidad de esas letras puntuales: es geométrico. Todos los vectores one-hot están a 90° entre sí, sin excepción, porque cada uno tiene su `1` en una posición distinta. En ese espacio no hay términos medios, todo es igual de distinto a todo.

Los embeddings arreglan esto siendo vectores densos y chicos (2 números en mi caso, no 12) donde la distancia sí puede representar similitud real. Es literalmente lo que ya había graficado en `embeddings.png` de la Semana 2, sin saber en su momento que ese agrupamiento visual era la prueba de algo que one-hot no puede hacer.

### Por qué la atención es O(n²)

Esta no me entró con matemática. Me entró con una analogía tonta: una fiesta donde todos tienen que saludarse de mano entre sí antes de que arranque la charla.

Con 4 personas: cada una saluda a las otras 4 (incluida ella misma), `4 × 4 = 16` saludos. Con 8 personas: `8 × 8 = 64`. Duplicar la gente no duplica los saludos, los **cuadruplica**, porque cada persona nueva tiene que saludar a todas las que ya estaban, y todas las que ya estaban tienen que saludar a la nueva.

Traducido: cada persona es un token, cada saludo es una comparación entre `Q` y `K`, y `n` es cuántos tokens tiene la secuencia actual, no el vocabulario. El vocabulario es el catálogo de invitados posibles; `n` es cuánta gente entró realmente a esta fiesta. Por eso duplicar el contexto no duplica el costo: lo cuadruplica.

Las dos alternativas que vimos no son la misma cosa, y esto me costó una vuelta entera de confundir:

- **Sliding window attention** cambia el **quién**: cada token solo saluda a los vecinos cercanos, no a toda la sala. Baja el `n²` real, a cambio de perder memoria de largo plazo.
- **FlashAttention** deja los mismos `n²` saludos intactos, nadie se saltea a nadie. Lo que cambia es **dónde** se hace el cálculo: en vez de anotar cada resultado parcial en la VRAM (la pizarra lejana), agrupa el trabajo en bloques chicos usando la caché de la GPU (la mesa cercana), y solo al final lleva el resultado acumulado a la memoria grande. Mismo trabajo, muchos menos viajes lentos.

### RNN/LSTM: el "antes" del Transformer

Antes de la atención, un modelo procesaba la secuencia de a una palabra por vez, en fila: cada persona entra, habla con la que tiene justo adelante, y le pasa un resumen de tamaño fijo de todo lo que escuchó antes.

Dos problemas, y me costó separarlos:

1. **Es secuencial.** No se puede paralelizar: hay que esperar a que termine la persona 1 para que arranque la 2. Con 500 tokens son 500 rondas seguidas, contra la atención que hace todo en una sola ronda simultánea.
2. **El resumen se degrada, y el motivo es concreto, no "se va perdiendo" en abstracto.** Cada reescritura del resumen aplica una transformación (multiplicar por un peso, pasar por una no linealidad), y esa transformación se repite cientos de veces. Multiplicar algo por `0.9` quinientas veces seguidas da un número indistinguible de cero. A eso se le llama **vanishing gradient**: no es que se pierda "el contexto" en sí, es que el **gradiente**, la señal que le dice a la red cómo debería ajustar sus pesos para usar mejor la información lejana, se apaga en el camino de vuelta. La red no puede aprender a usar algo cuya señal de aprendizaje ya llegó en cero.

## El entregable: explicarlo en voz alta, sin apuntes

Esta parte fue la más incómoda y la más útil. La consigna: explicar por qué la atención es O(n²) y qué alternativa usaría, hablando, sin mirar nada escrito.

Primer intento: dije "vocabulario" cuando quería decir "longitud de la secuencia", justo la confusión que ya había cerrado por escrito el día anterior. Sliding window y FlashAttention me salieron perfectos, sin dudar. Pero la causa del O(n²) se me mezcló apenas tuve que decirla en voz alta en vez de escribirla con calma.

Segundo intento, con foco solo en esa parte: salió limpio. "Cada token hace n comparaciones contra la secuencia, no contra el vocabulario, entonces son n por n comparaciones en total."

La lección no es que me haya salido mal la primera vez. Es que **escribir con tiempo para pensar y hablar bajo presión son habilidades distintas**, y hasta ahora solo venía entrenando la primera. Tiene sentido que sea justo ahí donde aparece la grieta.

## En qué me confundí

- Invertí la regla de la cadena en el grafo (serie/paralelo) tres veces seguidas, pese a que la tenía "cerrada" desde la Semana 1.
- Volví a describir el fencing token como si el líder viejo "se enterara y se degradara" solo, en vez de que el storage rechace su escritura por comparar números.
- Di la misma definición ("esperar a un follower") para sync y semi-sync, que son cosas distintas (todos vs. al menos uno).
- Mi estimación de storage del capstone no tenía aplicados el overhead de índices ni el factor de replicación, pese a haber decidido ese factor en la Semana 6 anterior.
- Dije que FlashAttention "agrupa tokens para que se miren menos entre sí" — no es así, sigue habiendo los mismos n² saludos, lo que cambia es dónde se guarda el resultado parcial (caché vs. VRAM), no a quién se mira.
- Confundí "se pierde el contexto" con por qué se llama específicamente vanishing *gradient*: no es la memoria la que se desvanece, es la señal de aprendizaje durante el backward.
- En el ejercicio oral, mezclé "vocabulario" con "longitud de secuencia" al hablar bajo presión, aunque lo tenía bien distinguido por escrito un día antes.

## Qué sigue

Semana 6.5 cerrada del todo: repaso con preguntas reales de las Semanas 1 a 6, los tres temas nuevos de Módulo 1.1, y el primer ejercicio de explicar algo técnico hablando y sin red. Sigue la Semana 7: partitioning, consistent hashing, caching, y de yapa el tema de indexing que se me había quedado sin semana asignada en el temario. Toca confirmar `tenant_id` como partition key y pensar el problema de hot partitions.
