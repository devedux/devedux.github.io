---
title: "Semana 4: Todo lo que pasa entre entrenar un modelo y hablar con él"
description: "Cuarto paso de frontend a AI engineer: cómo un LLM decide qué palabra dice (sampling), por qué no hace falta recalcular todo en cada token (KV cache), por qué a veces inventa cosas, y cómo un simulador de texto se convierte en un asistente (pretraining, SFT, RLHF)."
pubDate: 2026-08-10
tags: ["ai-engineering", "llm", "sampling"]
draft: false
---

En la Semana 3 entrené mi GPT mini y lo vi generar texto, pero en ese momento no tenía muy claro qué estaba pasando exactamente en ese paso de generación, más allá de "el modelo predice el siguiente token". Esta semana cierra el Módulo 1.1 entendiendo ese paso a fondo, y todo lo que rodea a un LLM moderno: sampling, KV cache, por qué alucina, y cómo se entrena hasta convertirse en un asistente.

## Entrenamiento y generación son caminos distintos

Lo primero que tuve que corregirme: pensaba que sampling era parte del mismo flujo que cross-entropy y backward. No es así. Comparten el arranque (embeddings → Transformer → logits) pero después se separan en dos caminos que nunca se vuelven a juntar:

- **Entrenamiento:** ya tengo el target real (viene del dataset), así que comparo con cross-entropy, hago backward y actualizo pesos. No hay sampling acá.
- **Generación:** no hay target, el modelo tiene que inventar el siguiente token. Ahí es donde entran temperature, top-k/top-p, softmax y sample. No hay cross-entropy ni backward acá, los pesos quedan congelados.

De hecho, ya venía usando el flujo de generación desde la Semana 2 (`makemore` generando nombres) y la Semana 3 (mi GPT mini generando el corpus memorizado por overfitting). Lo nuevo esta semana no es generar texto, es aprender a **controlar** ese paso de sampling en vez de dejarlo crudo.

## Logits no son probabilidades

Otra confusión real: hablaba de "probabilidades" como si ya las tuviera desde que salen los logits del modelo. Pero logit y probabilidad son cosas distintas. El logit es un número crudo sin restricción (puede ser negativo, puede ser mayor a 1, no suma nada con los demás). Recién cuando se le aplica **softmax** esos números se convierten en una distribución de probabilidad válida (entre 0 y 1, sumando 1 entre todos). Todo lo que pasa antes de softmax (como temperature) trabaja sobre logits, no sobre probabilidades.

## Temperature: controlar qué tan arriesgada es la elección

Temperature es un número que divide cada logit antes de aplicar softmax (`logit / T`). Con un ejemplo de 4 tokens candidatos (`feliz=4.0, cansado=3.0, verde=1.0, auto=0.5`), sin tocar nada softmax da: feliz≈69%, cansado≈25%, verde≈3.4%, auto≈2.1%.

- **Temperature baja (T=0.5):** agranda la brecha entre logits (`8.0` vs `1.0` en vez de `4.0` vs `0.5`). Feliz sube a ≈88%. El modelo se vuelve más conservador, casi siempre elige lo más probable.
- **Temperature alta (T=2.0):** achica la brecha (`2.0` vs `0.25`). Feliz baja a ≈50%. El modelo se vuelve más creativo, reparte más chance a opciones que antes casi no tenían.

Ojo con un matiz que me costó: temperature divide a **todos** los logits por igual, no solo castiga al más alto. Lo que pasa es que softmax (por el `e^x`) amplifica esa misma operación de forma desigual — el logit más alto termina absorbiendo la mayor parte del cambio en probabilidad, mientras los logits ya bajos quedan todavía más chicos.

Y el matiz más importante: temperature **no mide qué tan bien predice el modelo**. El modelo ya predijo lo que predijo, esos logits son fijos (pesos congelados). Temperature no le da al modelo más chance de acertar — solo decide **cómo elijo** entre las opciones que el modelo ya calculó. Es una decisión de uso (código/factual → T bajo; creatividad → T alto), no una medida de calidad.

## Top-k y top-p: recortar candidatos antes de samplear

Antes de meterme con esto tuve que corregirme otro matiz: top-k y top-p no tocan la predicción del modelo. El modelo ya predijo, completo, sobre todo el vocabulario (~100,000 tokens) cuando calculó las probabilidades — eso ya pasó y no se toca. Top-k y top-p actúan después, filtrando el pool de candidatos elegibles para el paso de sample, no lo que el modelo "piensa" que es probable.

Con el mismo ejemplo (feliz≈69%, cansado≈25%, verde≈3.4%, auto≈2.1%):

- **Top-k** recorta por cantidad fija. Con top-k=2, sobreviven feliz y cansado como únicos candidatos; verde y auto pasan a probabilidad cero, no pueden salir sorteados ni por casualidad. Softmax se recalcula solo entre los que quedaron (≈73%/27%).
- **Top-p (nucleus sampling)** recorta por probabilidad acumulada: sumás de **mayor a menor** hasta juntar el umbral p. Con top-p=0.9: feliz (69%) + cansado (69+25=94%) ya supera 90%, corta ahí — mismos 2 candidatos que top-k=2, pero es coincidencia de este ejemplo puntual.

La diferencia real se nota con una distribución más pareja, el modelo bien indeciso (por ejemplo 30%/28%/25%/17%): top-k=2 fijo solo cubriría 58% de la probabilidad real, descartando candidatos casi igual de válidos. Top-p, en cambio, necesitaría los 4 tokens para llegar a 90% — se adapta a qué tan segura o insegura está la distribución en cada paso, mientras que top-k es un número rígido sin importar la forma de esa distribución.

## KV cache: por qué no hace falta recalcular todo en cada paso

Esto conecta directo con mi propio código de Semana 3. En mi clase `Head`, `key(x)` y `value(x)` son `nn.Linear` aplicadas a cada token por separado — el K y el V de un token solo dependen de su propio embedding, nada de lo que le pasa a otros tokens interviene ahí. Eso significa que una vez que calculás el K y el V de un token, **ya no cambian nunca más**, sin importar cuántos tokens se agreguen después al contexto.

Sin aprovechar eso, en cada paso de generación autorregresiva tendrías que recalcular K y V de **todo** el contexto de nuevo, incluidos los tokens que ya habías procesado antes. Para generar 5 tokens uno por uno, eso da 1+2+3+4+5 = **15** cálculos de K/V en total. Si en cambio guardás (cacheás) el K y V de cada token apenas se calcula, y solo procesás el token nuevo en cada paso, son apenas **5** cálculos — uno por token, una única vez cada uno. Con contextos largos esa diferencia es enorme: O(T²) sin cache contra O(T) con cache.

Un matiz importante: se cachea K y V, pero **no Q**. El Query de un token se usa una sola vez, en el paso donde ese token es el último del contexto, para predecir qué sigue. Una vez usado, no se vuelve a necesitar. K y V en cambio sí se reusan en todos los pasos futuros, porque cada nuevo Query tiene que compararse contra el K de todos los tokens anteriores.

Mecánicamente no hay ningún algoritmo sofisticado: es un `torch.cat` que le pega una fila nueva a un tensor que ya tenías guardado, cada vez que aparece un token nuevo.

### El trade-off: cómputo por memoria

KV cache reduce el **cómputo** necesario para generar cada token (menos operaciones = más rápido y más barato), a cambio de consumir más **memoria de GPU**, que crece a medida que el contexto es más largo (por guardar el K/V de cada token acumulado). Son dos recursos distintos de la GPU, no se compensan en la misma dirección: uno baja, el otro sube.

Esto es justo por lo que los providers limitan el tamaño de contexto — no es capricho, es que la memoria de GPU es finita y el KV cache la va llenando a medida que el contexto crece, y cada conversación activa tiene su propio cache ocupando espacio.

También aclara una distinción que confundí al principio: el KV cache "interno" (el que acabo de describir, dentro de una sola generación) no es algo que se cobre aparte, es simplemente cómo funciona la inferencia moderna. Lo que sí es un feature facturable real es **prompt caching**: si mandás el mismo contexto largo en varias llamadas seguidas a la API, el provider reusa el KV cache que ya calculó antes en vez de recalcularlo, y cobra más barato por esos tokens "cacheados" versus tokens "frescos". Es la misma idea de fondo, pero aplicada entre llamadas distintas en vez de adentro de una sola generación.

## Por qué alucinan los modelos

Pregunta de arranque: si le preguntás al modelo *"¿Quién es Orson Kovats?"* (un nombre inventado, no existe), ¿dice "no sé" o se inventa una respuesta con tono seguro? Se inventa una respuesta segura. Tres causas explican por qué:

**Causa 1 — imita el tono confiado, no el contenido.** Durante SFT, los labelers humanos escriben respuestas ideales para preguntas tipo "¿quién es X?" siempre con tono confiado y directo, porque investigaron a la persona real antes de responder. El modelo no aprende "si sé, respondo seguro; si no sé, digo que no sé" — aprende el patrón completo "preguntas con esta forma se responden así", y lo aplica sin importar si tiene datos reales detrás, porque nunca vio ejemplos de entrenamiento donde la respuesta ideal fuera "no sé". Como no hay ninguna señal real detrás del nombre inventado, la distribución de probabilidad para el siguiente token queda plana e insegura, y cada vez que sampleás sale algo distinto — es la misma mecánica de sampling de más arriba, solo que sin una respuesta real que ancle la distribución. Prueba de esto: si le preguntás lo mismo 3 veces, muchas veces da 3 respuestas inconsistentes entre sí. En cambio con algo bien anclado en el entrenamiento (como "capital de Francia"), la distribución está súper concentrada en la respuesta correcta (como temperature baja), así que sale consistente siempre.

**Causa 2 — recuerdo vago (parámetros) vs memoria de trabajo (contexto).** El conocimiento en los parámetros del modelo es como algo que leíste hace tiempo: si era común en el entrenamiento, lo recordás bien; si era raro, mal o nada. Lo que está en la ventana de contexto ahora mismo, en cambio, es directo y fiable, no hay que "recordarlo". Por eso, si pego el artículo real sobre "Orson Kovats" directo en el prompt, el modelo ya no depende de su recuerdo vago — el dato está ahí, accesible. Esto funciona igual si lo pego yo a mano o si el modelo usa una tool (búsqueda web) para traerlo: la tool es solo una forma automática de meter el dato al contexto, el motivo real de que deje de alucinar es que el dato ya está en la memoria de trabajo, no la tool en sí.

**Causa 3 — distracción por patrones.** Caso real: muchos modelos fallan en decir si `9.11 > 9.9`. Investigadores vieron en las activaciones internas que el modelo se confunde porque `9.11` se parece al formato de versículos bíblicos (donde el versículo 9.11 viene después del 9.9), y esa asociación distrae del cálculo matemático simple.

**Mitigaciones:** fine-tuning de rechazo (interrogar al modelo para descubrir qué no sabe, y agregar ejemplos de entrenamiento donde la respuesta ideal es "no sé" o "no recuerdo"); y tools/RAG (meter datos reales a la ventana de contexto en vez de depender del recuerdo impreciso de los parámetros).

## Pretraining, SFT y RLHF: tres formas de entrenar el mismo modelo

**Pretraining es literalmente lo que hice en Semana 1-3**, a otra escala: `get_batch` sobre texto crudo, `cross_entropy`, `backward`, `optimizer.step()`. Mi corpus eran 5 nombres; a escala real es terabytes de Common Crawl, meses de entrenamiento, miles de GPUs, millones de dólares. El resultado es un **base model**: un simulador de texto (en mi caso, un simulador de nombres), no un asistente. Si le hubiera dado un prompt tipo "¿cuál es tu nombre favorito?", ni siquiera lo hubiera reconocido como pregunta — mi vocabulario eran solo caracteres de nombres, y la única conducta que aprendió fue continuar ese patrón, nunca responder algo.

**SFT** soluciona exactamente eso, y con una sorpresa: es el **mismo algoritmo de entrenamiento**, solo que cambiando el dataset. En vez de texto crudo de internet, se entrena con miles de conversaciones humanas de alta calidad (pregunta + respuesta ideal escrita por labelers). Es mucho más rápido que pretraining (horas, no meses) por dos razones simples: el dataset es muchísimo más chico, y el modelo no arranca de pesos random — ya sabe lenguaje del pretraining, SFT solo le ajusta el comportamiento/formato de asistente.

**RLHF** es conceptualmente distinto a los dos anteriores, porque resuelve un problema que cross-entropy no puede: en dominios no verificables (como pedir un chiste), no existe "la" respuesta correcta contra la cual comparar — cada persona tiene un humor distinto. Pero aunque no se pueda definir una respuesta ideal, sí es fácil para un humano **ordenar** varias respuestas de mejor a peor. Con esos rankings se entrena una red separada, el **reward model**, que aprende a imitar el juicio humano — un simulador barato y escalable, porque no se puede pedir a humanos que puntúen millones de respuestas en un loop de RL real. Una vez entrenado ese simulador, se optimiza el modelo de lenguaje contra él.

El problema real de RLHF: el reward model es "gameable" — si corrés RL demasiadas actualizaciones, el modelo encuentra combinaciones de tokens sin sentido que engañan al reward model (caso documentado real: el "mejor chiste" que encontró un modelo después de entrenar de más fue literalmente `"the the the"`, sin sentido, pero con nota perfecta del reward model). Por eso RLHF se corta temprano a propósito.

*(Fuera de mis fuentes de Karpathy, agregado por mí)*: **DPO** es una alternativa más moderna que evita el reward model intermedio — ajusta los pesos directo a partir de los pares de preferencias humanas, sin simulador ni RL real de por medio, más simple y sin riesgo de gaming.

## En qué me confundí

- Pensé que sampling seguía en el mismo flujo que cross-entropy/backward. Son caminos alternativos que arrancan en el mismo punto (los logits), no pasos consecutivos.
- Hablé de "probabilidades" antes de tiempo, cuando en realidad son logits hasta que softmax los transforma.
- Pensé que temperature "castigaba" solo al logit más alto. En realidad divide a todos por igual; el efecto desigual es de softmax, no de temperature.
- Pensé que temperature servía para medir qué tan bien predice el LLM. En realidad no toca la calidad de la predicción, solo controla la estrategia de elección entre opciones ya fijas.
- En top-p, sumé la probabilidad acumulada de menor a mayor en vez de mayor a menor. Sumando de menor a mayor nunca se descarta la cola improbable, que es justo el propósito del método.
- Pensé que consumir más memoria era lo que "lograba" tener más contexto, invirtiendo la causalidad. Es al revés: más contexto es la causa, más memoria consumida es la consecuencia.
- Pensé que cachear K/V usaba más cómputo GPU y hacía todo más lento. Es lo contrario: cachear reduce el cómputo total (15 vs 5 en el ejemplo de 5 tokens), lo que lo hace más rápido y más barato. Lo que sube es la memoria, un recurso distinto.
- Pensé que explicar por qué el modelo alucina un nombre inventado era sobre "buscar tokens parecidos" al nombre. En realidad es imitar el estilo/formato de respuesta confiada aprendido en SFT, sampleando sobre una distribución insegura porque no hay dato real detrás.
- Pensé que pegar un dato real al contexto funcionaba "porque el modelo llama a una tool". No hace falta tool alguna: alcanza con que el dato esté en el contexto (memoria de trabajo); la tool es solo una forma automática de conseguirlo.
- Pensé que SFT era más rápido porque "el modelo ya reconoce las preguntas". En realidad es porque el dataset es muchísimo más chico (miles de conversaciones vs terabytes) y el modelo no arranca de cero — ya sabe lenguaje del pretraining, SFT solo le ajusta el comportamiento.
- No tenía claro por qué RLHF necesita un reward model en vez de usar los rankings humanos directo para entrenar: es porque no se puede pedir a humanos que puntúen millones de respuestas en tiempo real, así que se entrena un simulador barato de su juicio.

## Qué sigue

Con esto cierro el Módulo 1.1 completo: tokenización, embeddings, atención, Transformer, y ahora sampling, KV cache, alucinaciones y las etapas de entrenamiento. Para la Semana 5 arranca el Módulo 1.2, System Design — estimación de capacidad, storage internals, y la primera comparación real entre B-Tree y LSM-Tree.
