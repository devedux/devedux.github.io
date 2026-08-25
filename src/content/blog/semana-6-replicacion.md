---
title: "Semana 6: Los 3 modelos de replicación, y por qué no hay que elegir solo uno"
description: "Sexto paso de frontend a AI engineer: single-leader, multi-leader y leaderless. Failover, conflictos de escritura, quorums, y por qué cada componente de un sistema puede usar un modelo distinto."
pubDate: 2026-08-19
tags: ["ai-engineering", "system-design"]
draft: false
---

Esta semana sigue el Módulo 1.2 con replicación (DDIA cap. 5). Arranco con single-leader, el más simple de los 3 modelos (single-leader, multi-leader, leaderless).

## El problema, antes que la solución

Si tenés un solo servidor con toda tu base de datos, tenés dos riesgos: si ese servidor muere, perdés todo y el sistema se cae por completo; y si tenés mucha carga de lectura (en mi capstone: 579 QPS de escritura vs 28,950 de lectura, calculado la semana pasada), un solo servidor tiene que aguantarlas todas él solo.

La solución en general, sea cual sea el modelo, es simple en una frase: **guardar copias del mismo dato en varias máquinas distintas**. Si una muere, hay copias en otro lado. Y como hay varias copias, se puede repartir la carga de lectura entre ellas.

## Líder + followers

Single-leader resuelve esto con una sola fuente de verdad para escrituras: el **líder** acepta escrituras, y los **followers** guardan su propia copia completa de esos datos (no solo "sirven lecturas", tienen la copia real, que es lo que los hace útiles como respaldo).

Con mi propio número de la semana pasada: si reparto mis 28,950 QPS de lectura entre 5 followers, le tocan 5,790 a cada uno, una carga perfectamente manejable para un servidor moderno.

Pero eso abre una pregunta: cuando el líder le dice "listo" al cliente, ¿ya llegó ese dato a algún follower, o no?

## Sync vs async

**Síncrono:** el líder espera a que al menos un follower confirme que ya recibió el dato, antes de responderle al cliente. Más seguro, más lento.

**Asíncrono:** el líder le responde al cliente de inmediato, sin esperar a nadie. Más rápido, pero con un riesgo real: si el líder muere justo después de confirmar, antes de que el dato llegara a ningún follower, esa escritura **desaparece por completo**. No queda "desactualizada" en algún lado, el nuevo líder que la reemplace nunca la va a conocer.

En un sistema de pagos esto es grave en serio: le confirmaste "pago aprobado" a un merchant sobre algo que el sistema, después de un failover, va a creer que nunca pasó. Por eso muchos sistemas de pagos usan una versión intermedia, **semi-síncrona**: esperan a un solo follower (no a todos, sería carísimo en latencia), balanceando seguridad y velocidad.

## Failover: heartbeat + timeout

Esto lleva al siguiente problema: ¿cómo sabe el sistema que el líder murió, y no que simplemente está lento?

El mecanismo es **heartbeat + timeout**. El líder manda un mensaje periódico ("sigo vivo") a cada follower **por su cuenta, sin que nadie se lo pida** (push, no una respuesta a un pedido del follower). Cada follower tiene su propio temporizador, que se resetea a su valor completo cada vez que le llega un heartbeat. Si ese temporizador llega a cero sin haber recibido nada en el medio, el follower asume que el líder murió y arranca una elección.

El trade-off del timeout: muy corto, más falsos positivos (un pico de latencia se confunde con una muerte real). Muy largo, tarda más en recuperarse si el líder sí murió de verdad.

Detalle real que no esperaba: cada follower usa un timeout **al azar dentro de un rango** (no el mismo valor exacto), para que no todos detecten la caída al mismo instante y disparen una elección confusa con votos divididos a la vez.

## Split-brain y fencing tokens

¿Y si el líder no había muerto, solo estaba lento, y "vuelve" mientras ya se promovió un nuevo líder? Ahí hay 2 líderes creyéndose tales al mismo tiempo, esto se llama **split-brain**.

La solución no evita que existan 2 líderes creyéndose tales (eso es casi inevitable con latencia real), evita el **daño**: cada elección le asigna al nuevo líder un **fencing token**, un número que solo sube. Cuando el líder viejo intenta escribir, el storage compara su número contra el actual y rechaza la escritura si es viejo. El líder viejo recién se entera de que ya no es líder cuando se reconecta al cluster y ve un número más alto circulando, no en el momento mismo de la escritura rechazada. Y en ese momento no queda "colgado" sin rol, se degrada él mismo a follower del nuevo líder.

## Multi-leader

En vez de un solo líder para todo el sistema, hay varios, típicamente uno por región, cada uno aceptando escrituras localmente y replicando sus cambios a los demás.

**La motivación, con mi propio capstone:** si mi plataforma atiende merchants en varias regiones (EE.UU., México, Brasil), con single-leader toda escritura, sin importar de dónde venga, tiene que viajar hasta el único líder. Con multi-leader, cada región escribe cerca, rápido, ganando la latencia baja que necesito para mi requisito de <100ms.

**El problema nuevo que esto introduce, distinto al de single-leader:** no es que un líder esté "atrasado" respecto a otro (eso ya existía como lag de replicación). Es que dos líderes reciben escrituras **distintas y contradictorias sobre el mismo dato, casi al mismo tiempo, sin saber uno del otro**. No hay una versión adelantada y otra atrasada, hay dos versiones divergentes, ambas válidas en el momento en que ocurrieron.

**Ejemplo concreto:** un merchant tiene configurado qué PSPs acepta. Casi al mismo instante, alguien en la región US habilita el PSP X, y alguien en la región Brasil deshabilita el mismo PSP X. Ninguno de los dos líderes sabía del otro. ¿Cuál versión gana cuando se replican entre sí?

**Las 3 estrategias reales para resolver esto:**
1. **Last-Write-Wins (LWW):** gana la escritura con el timestamp más reciente. Simple, pero puede sobreescribir en silencio una escritura válida sin que nadie se entere.
2. **Merge:** combinar ambas escrituras, pero solo funciona cuando "combinar" tiene sentido matemático (sets, listas, contadores, esto se formaliza con algo llamado CRDTs). No funciona para una contradicción directa como habilitar vs deshabilitar el mismo campo booleano, ahí no hay forma de "mezclar" ambas.
3. **Marcar el conflicto y resolver a nivel de aplicación o humano:** no decidir en automático, exponer que hay un conflicto y dejar que una regla de negocio o una persona lo resuelva explícitamente.

La tercera es la más segura para contradicciones directas como la mía, y es el mismo principio que ya tengo en otra parte del capstone: la recomendación activa de cambios de routing con aprobación humana obligatoria. Mismo patrón de fondo (no decidir solo cuando hay incertidumbre real) aplicado en dos lugares distintos.

## Leaderless

Acá no hay ningún nodo especial, ningún líder. Cualquier nodo acepta lecturas y escrituras. El cliente escribe directo a varios nodos a la vez y lee de varios nodos a la vez, sin pasar por ningún intermediario que decida "la verdad".

Los nodos acá no son "followers" (ese término solo tiene sentido si hay un líder al que seguir), son simplemente **nodos pares**, todos con el mismo rol.

**El problema:** si el cliente escribe a algunos nodos pero no a todos (porque algunos estaban lentos o caídos en ese momento), y después alguien lee de uno de los nodos que no llegó a recibir esa escritura, puede leer un dato viejo.

**La solución: quorums.** Se definen `N` (total de nodos con copia del dato), `W` (mínimo de nodos a los que hay que escribir para que la escritura cuente), y `R` (mínimo de nodos de los que hay que leer). La garantía matemática: si `W + R > N`, cualquier lectura está garantizada de solapar con al menos un nodo que sí tenía la escritura más reciente, es un argumento de conteo simple, los conjuntos de "a quién escribí" y "a quién le leí" no pueden ser completamente disjuntos si juntos suman más que el total.

Ejemplo: con `N=5` y `W=3`, hace falta `R` mínimo de **3** para que `3+3=6 > 5` se cumpla. Si en cambio leyera con `R=1`, `3+1=4` no supera a 5, y ahí sí corro el riesgo real de leer un nodo desactualizado.

El trade-off de siempre: `W`/`R` más altos dan más garantía de consistencia, pero cuesta velocidad (hay que esperar la confirmación de más nodos).

**Cómo se sincronizan los nodos entre sí, sin un líder que lo coordine:** para escribir o leer, el que habla directo con varios nodos es el cliente (o un coordinador para esa request puntual), no un nodo fijo que reparte. Pero para mantenerse al día con el tiempo, los nodos sí se comunican entre ellos, de 2 formas:

- **Read repair:** cuando un cliente lee de varios nodos y nota que alguno tiene una versión más vieja, ese nodo se corrige ahí mismo, en el momento de la lectura.
- **Hinted handoff:** si un nodo estaba caído durante una escritura, los demás nodos que sí la recibieron guardan una "nota" para él, y se la mandan apenas vuelve a estar disponible.

Y de fondo, muchos sistemas leaderless corren **anti-entropy**: un proceso en segundo plano que compara los nodos entre sí periódicamente, para corregir diferencias antes de que alguien pida un dato desactualizado, sin depender de que alguien lea justo ese dato para detectar el problema.

## Resumen de los 3 modelos

- **Single-leader:** una sola fuente de verdad, simple, pero el líder es punto único de falla para escrituras (mitigado con heartbeat+timeout para detectar la caída, y fencing tokens para evitar daño por split-brain).
- **Multi-leader:** varios líderes por región, gana latencia de escritura, pero introduce conflictos (resueltos con LWW, merge/CRDTs cuando el tipo de dato lo permite, o resolución humana/de negocio para contradicciones directas).
- **Leaderless:** sin líder, cualquier nodo lee/escribe, usa quorums (`W+R > N`) para garantizar lecturas actualizadas, con el mismo dial de siempre: más consistencia cuesta velocidad.

## Un modelo de replicación distinto por componente, no uno para todo el sistema

Esto se me pasó al principio: pensaba que había que elegir un solo modelo de replicación para todo el capstone. No es así, es la misma idea de polyglot persistence que ya vi con B-Tree vs LSM-Tree, pero aplicada a replicación.

Cada componente tiene su propio perfil de lectura:escritura, y se evalúa por separado:

- **Transacciones** (579 escritura : 28,950 lectura, lectura domina) → single-leader con réplicas de lectura.
- **Log de auditoría** (escritura domina, casi no se relee, requisito PCI-DSS) → acá single-leader sería mala elección, el único líder se volvería cuello de botella para todo ese volumen de escrituras.

Para el log de auditoría, un detalle importante: es **append-only** (solo se crean registros nuevos, nunca se actualiza uno existente). El problema central de multi-leader (dos escrituras distintas sobre el mismo campo) casi no aplica ahí, porque cada evento es único, no hay "el mismo dato" siendo modificado por dos lados. Eso inclina la balanza hacia **leaderless**: reparte la carga de escritura entre muchos nodos sin cuello de botella central. Y no es casualidad que Cassandra (la base que ya había elegido para este log, por ser LSM-Tree) sea leaderless por diseño, storage engine y modelo de replicación suelen venir empaquetados juntos en sistemas reales.

## El entregable: diagrama + failover aplicado a mi propio capstone

Armé el diagrama de los 3 modelos en Excalidraw, con la secuencia completa de failover en el panel de single-leader (heartbeat, timeout, elección, fencing token) y la fórmula de quorum en el de leaderless.

Y en `capstone-requisitos.md` dejé el ejemplo de failover aplicado a mi propio sistema de transacciones, no genérico:

1. El líder deja de mandar heartbeat.
2. Cada follower detecta el timeout y arranca la elección del más actualizado, garantizado como actualizado gracias a la replicación semi-síncrona que ya había elegido para este componente.
3. Nuevo líder promovido con fencing token incrementado.
4. **Solo las escrituras quedan indisponibles durante la elección, las lecturas siguen sirviéndose desde los followers**, y como mi sistema es 98% lectura, la mayoría del tráfico ni nota el corte.
5. Las escrituras que estaban en curso justo cuando el líder murió se reintentan con el mismo `transaction_id` (idempotency key), seguro contra doble cobro incluso contra el nuevo líder que nunca vio el intento original.
6. El líder viejo, si vuelve, se entera al reconectarse y ver un fencing token más alto, y se degrada a follower.

## En qué me confundí

- Dije que "el líder sirve para guardar copias en varias máquinas". Es al revés de preciso: el líder solo acepta escrituras, es la replicación en conjunto (líder + followers) la que produce las copias.
- Al principio no mencioné que los followers guardan una copia **completa** de los datos, solo dije que "pueden leer". La copia es la razón de fondo por la que la replicación da tolerancia a fallos, no un detalle aparte.
- Dije que el flujo asíncrono "responde rápido al follower". No, responde rápido al **cliente**, el follower no es quien espera nada ahí.
- En un resumen posterior, invertí las etiquetas: describí el mecanismo síncrono (esperar a un follower antes de responder) pero le puse el nombre "asíncrono".
- Pensé que el líder viejo "se entera solo" de que ya no es líder al consultar su propio fencing token durante un intento de escritura. En realidad es el storage el que rechaza la escritura; el líder viejo recién se entera formalmente cuando se reconecta al cluster y ve un número más alto que el suyo.
- Pensé que el temporizador de cada follower se "reinicia a cero" con cada heartbeat. Es al revés: se reinicia a su valor completo (ej. 200ms) y cuenta hacia abajo; llegar a cero es lo que dispara la elección, no el punto de reinicio.
- Describí el heartbeat como si el líder "le respondiera" al follower, como si fuera petición-respuesta. Es al revés: el líder lo manda por su cuenta, sin que nadie se lo pida (push). Se me volvió a colar la misma confusión al escribir "envía un request" en el diagrama.
- En leaderless, seguí llamando "followers" a los nodos, tanto al explicarlo como en el primer diagrama. Ese término solo tiene sentido si hay un líder al que seguir, acá son simplemente nodos pares.

## Qué sigue

Los 3 modelos de replicación cerrados, más la idea de elegir el modelo por componente en vez de uno solo para todo el sistema (transacciones en single-leader, log de auditoría en leaderless). Entregable de la semana completo: diagrama, notas de trade-offs, ejemplo de failover, y `capstone-requisitos.md` actualizado. Sigue la Semana 7: partitioning, consistent hashing, caching.
