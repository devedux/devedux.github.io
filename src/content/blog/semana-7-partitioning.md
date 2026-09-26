---
title: "Semana 7: el salón que revienta, el caché que miente y el índice que salva"
description: "Séptima semana de frontend a AI engineer: particionar (rango vs hash, consistent hashing con carpas en círculo, hot partitions), caching (velocidad a cambio de frescura, TTL, Cache-Control, la estampida) e indexing (B-Tree, índices locales y globales), con las decisiones reales de mi capstone."
pubDate: 2026-09-25
tags: ["ai-engineering", "system-design", "databases"]
draft: false
---

Esta semana tuvo una particularidad: la arranqué, la pausé para hacer la Semana 6.6 de networking (que terminó convirtiéndose en [una investigación real de un network error en producción](/blog/semana-6-6-network-error-produccion)), y al volver me di cuenta de que había olvidado buena parte de lo que ya había estudiado. Así que este post sale de un repaso con recall activo: primero intenté responder de memoria, fallé en varias, y reconstruimos todo desde cero con una analogía que me funcionó tan bien que la voy a usar para explicar todo el post: **una escuela**.

La primera parte de la semana fue partitioning, consistent hashing y hot partitions. La segunda, caching/CDN e indexing. Las tres comparten el mismo hilo: ninguna decisión es gratis, y diseñar es elegir qué pagar.

## Por qué particionar: la escuela con un solo salón

Imagina una escuela con 1,000 alumnos y un solo salón. No caben y el profesor no da abasto. Dos ideas posibles:

- **Fotocopiar**: armar 3 escuelas idénticas con los mismos 1,000 alumnos cada una. No arregla nada: cada salón sigue reventado. Eso es **replicación**, y sirve para otra cosa (si una escuela se incendia, tienes otra), no para este problema.
- **Repartir**: abrir 4 salones con 250 alumnos cada uno. Eso es **particionar**.

La distinción que me llevó a entender cómo se conecta con la Semana 6: replicar = copiar TODO N veces (disponibilidad), particionar = dividir en N pedazos (escala). Y un detalle que me voló la cabeza cuando pregunté "¿si se llena una partición, se llenan sus réplicas?": **sí, exactamente igual**. Una copia es una copia: si la partición pesa 100GB, cada réplica pesa 100GB. La replicación no reparte el peso, lo multiplica. Por eso cada semana resuelve su problema y no el de la otra.

Otra cosa que tenía borrosa: ¿qué se divide exactamente? Se dividen las **filas** de una misma tabla lógica. La tabla `transactions` sigue siendo una sola en concepto (mismo schema); sus 40 millones de filas se cortan en pedazos de ~10 millones, y cada pedazo puede vivir en un servidor distinto. Cuando el corte es entre máquinas se le llama **sharding**. Para la aplicación es transparente: haces tu INSERT y el motor decide a qué pedazo va.

## La partition key: el apellido del alumno

La regla que decide quién va a qué salón necesita una clave: la **partition key**. En mi capstone (routelens, plataforma multi-tenant de pagos) la candidata natural es el `tenant_id`, el identificador del comercio. En la escuela: el apellido.

Y hay dos reglas clásicas de reparto:

**Por rango (alfabético)**: salón 1 apellidos A-F, salón 2 G-M, y así. Lo bueno: si la directora pide "todos los García", van a UN solo salón, juntitos. Lo malo: un año se inscriben 300 alumnos de apellido Quispe y el salón 3 revienta mientras el salón 1 tiene 40 alumnos jugando cartas. El orden no reparte parejo.

**Por hash (la licuadora)**: cada nombre pasa por una licuadora mágica que siempre da el mismo número para el mismo nombre, y ese número decide el salón. Lo bueno: reparto parejo garantizado. Lo malo: los hermanos García quedaron regados por los 4 salones, y juntarlos ahora cuesta recorrer toda la escuela. Eso tiene nombre: **scatter/gather** (desparramar la pregunta a todas las particiones, recolectar las respuestas), y es el peaje escondido del hash.

La ley sin excepciones: o los grupos quedan juntos (búsquedas baratas, riesgo de salón reventado), o quedan parejos (balance, búsquedas de grupo caras). No existe la regla que te dé ambas gratis.

## Consistent hashing: el desastre del salón nuevo y el truco del círculo

Con hash, la regla obvia es `hash(key) % N` con N = número de servidores. Funciona hasta que N cambia. Abres el salón 5 y la regla pasa de "dividir entre 4" a "dividir entre 5": al cambiar el divisor, casi todos los residuos cambian, y **~80% de los niños tienen que mudarse de salón** el primer día de clases. Por agregar UN salón.

El truco: poner los salones en **círculo**, como carpas alrededor de una fogata. Cada niño se para en el punto del círculo que le dio la licuadora y camina hacia adelante hasta la primera carpa que encuentre. Cuando llega una carpa nueva, se planta en algún punto del círculo y solo se mudan **los niños que iban caminando hacia la carpa siguiente y ahora se topan con la nueva antes**. Todos los demás ni se enteran: adelante suyo no apareció nada nuevo, así que su carpa sigue siendo la misma.

Con números: de 10 a 11 carpas se muda ~1/11 de los niños (~9%), contra el ~80% del residuo. La regla general es 1/N con N el total nuevo. Y un matiz que yo recordaba mal: la carpa nueva no reparte "entre izquierda y derecha", le roba niños a **UN solo vecino** (el siguiente en el sentido de la caminata).

Lo que más me gustó del anillo es algo que descubrí respondiendo una pregunta de consolidación: te deja **apuntar la cirugía**. Si la partición 1 está al 90% de disco, plantas el nodo nuevo deliberadamente en medio de SU arco: se muda ~la mitad de esa partición (ni siquiera 1/N del total) y el resto del cluster sigue trabajando sin enterarse. Con `% N` esto era imposible: cambiar N mudaba a todos, quisieras o no.

(Detalle fino: para que un servidor nuevo no herede un solo arco gigante, cada servidor físico se pone en el anillo varias veces como "nodos virtuales", y su carga viene de pedacitos repartidos por todo el círculo.)

## Cómo encaja con la replicación de la Semana 6

Esta conexión me hizo el clic más grande de la semana. Las dos historias usan "varios servidores" pero para cosas opuestas: replicación = varios servidores con el MISMO dato (sobrevivir fallos), partitioning = varios servidores con pedazos DIFERENTES (escalar). Y en un sistema real se combinan así: **cada partición tiene su propio equipo de réplicas**, y los roles de líder/follower que aprendí en la Semana 6 son POR PARTICIÓN, no de toda la base de datos.

O sea: la máquina A puede ser líder de la partición 1 y a la vez follower de las particiones 3 y 4. No existe "el servidor líder de la base"; existen tantos líderes como particiones, desparramados a propósito. Y un failover ahora es por partición: si se muere la máquina que lideraba la partición 2, solo la partición 2 elige líder nuevo. El radio de daño se achicó, regalo extra del partitioning.

Vocabulario que también aclaré: máquina = servidor = **nodo** (el término favorito de los libros, porque no importa si es fierro, VM o contenedor). Líder y follower no son tipos de máquina: son roles que un nodo juega para una partición específica.

## Hot partitions: el hash reparte claves, no carga

La licuadora garantiza salones parejos... en cantidad de claves. Pero un día se inscribe Amazon, y todas sus transacciones llevan la misma clave, así que caen TODAS al mismo salón. Para la licuadora, Amazon y la bodega de la esquina pesan igual: una clave cada uno. La frase que me quedó grabada: **el hash balancea claves, no carga, y no puede partir una clave**. Eso es una hot partition.

Y los comercios chicos que cayeron en ese mismo salón la pasan mal sin culpa: comparten CPU, disco y conexiones con el gigante, y cuando Amazon tiene su pico de Black Friday, las transacciones de los inocentes se vuelven lentas. Eso se llama **noisy neighbor** (vecino ruidoso). De hecho me lo reencontré a otro nivel en la misma sesión: si la partición 1 se devora el disco de la máquina A, las réplicas de otras particiones que viven en esa misma máquina también sufren. Noisy neighbor a nivel de fierro.

Las tres salidas, cada una pagando algo:

1. **Aislamiento**: partición dedicada para el gigante. Pagas infraestructura dedicada, y si el gigante sigue creciendo, el problema vuelve en privado.
2. **Salting / key splitting**: partir la clave caliente agregándole un sufijo (Amazon-1 a Amazon-8) para que el hash sí pueda repartirla. Pagas scatter/gather cada vez que leas todo lo del tenant.
3. **Rate limiting**: cuota de tráfico por tenant. No arregla el desbalance, pero protege a los vecinos. Pagas rechazar tráfico de tu mejor cliente, decisión de negocio tanto como técnica.

El meta-patrón de toda la semana: ninguna opción es gratis, y elegir qué pagar es el trabajo de diseño.

## La decisión real del capstone

El pendiente oficial de la semana era confirmar `tenant_id` como partition key de routelens considerando hot partitions. Mi decisión: **clave compuesta `hash(tenant_id + store_id)`**, más rate limiting por tenant.

La parte que más me gustó es que la propuse pensando en el negocio antes de saber que existía con nombre: en vez del sufijo aleatorio del salting clásico, usar un sub-dato natural que mi modelo ya tenía (un merchant tiene tiendas en distintas regiones). Cada tienda cae en su partición, así que un merchant gigante se reparte solo, y las consultas "todo lo de la tienda X" siguen siendo un solo viaje. Eso se llama composite partition key, y es el salting elegante.

El trade-off que acepto, dicho explícitamente: "todo el merchant completo" ahora es scatter/gather entre sus tiendas, y si UNA sola tienda concentra el 90% del tráfico del merchant, la clave compuesta no me salva (esa sub-clave sigue siendo una e imposible de partir). Para eso queda el rate limiting como defensa, que además se puede vender como modelo de planes: tantas transacciones por segundo incluidas, pagas más para subir tu cuota. El límite deja de ser castigo y se vuelve contrato.

## Caching: velocidad a cambio de frescura

Empecé por lo que ya había vivido con el DNS. Lo que se gana al guardar algo en caché es que la próxima visita sale más veloz. El riesgo es que el dato cambie: si la IP se mueve, el cliente sigue yendo a una dirección vieja. El TTL le pone un tiempo de vida a esa copia. Ese es todo el trade-off: **velocidad a cambio de frescura**, y el TTL es el dial.

Para sentir cuánto pesa, usé mis números del capstone: 28,950 QPS de lectura contra 579 de escritura. Suponiendo 20 ms por lectura a la base y 1 ms al caché:

| Hit rate | Latencia promedio | QPS que llegan a la base |
|---|---|---|
| 0% | 21 ms | 28,950 |
| 50% | 11 ms | 14,475 |
| 90% | 3 ms | 2,895 |
| 99% | 1.2 ms | 290 |

Pasar de 50% a 90% de aciertos no es "un poco mejor": le saca 12,000 QPS de encima a la base.

El TTL correcto no existe en general, depende de cuánto cuesta que ese dato esté viejo. Si cacheo la tasa de aprobación de un PSP con TTL de 5 minutos y el PSP se cae hace 30 segundos, sigo mandándole transacciones durante 4 minutos y medio: suponiendo que recibe 1 de cada 5, son más de 30,000 pagos fallidos. Con un TTL de 1 segundo el caché casi no ayuda y vuelvo a la fila de 0%.

### Qué cachear: tres reglas

1. Un dato que tolera quedar viejo (la lista de PSPs de un merchant) lleva TTL largo.
2. Un dato que cambia todo el tiempo (la tasa de aprobación) lleva TTL corto, y se invalida solo ante eventos importantes (un PSP declarado caído), no en cada recálculo. A 579 transacciones por segundo, invalidar en cada cambio vaciaría el caché.
3. Un dato con estados se cachea solo cuando ya no puede cambiar. Del estado de una transacción cacheo aprobada y rechazada, y no cacheo pendiente, porque el polling del checkout viene justo a buscar ese cambio. Y como una aprobada puede pasar a reembolsada, invalido en la transición.

### Dónde: tres niveles, y quién controla qué

Un request pasa por el caché del navegador, el edge/CDN y el caché de aplicación, y detrás de todos está la base, que es la fuente de la verdad. Cada nivel que responde le ahorra al request todos los que quedan atrás. El método para elegir es preguntar quién consume el dato y si puedo invalidarlo. La tasa de aprobación la usa mi router, que corre en mi backend y decide en menos de 100 ms, así que va en el caché de aplicación: al lado del código (~1 ms), y mi health checker puede borrarla en el instante en que un PSP se cae. Con 10 PSPs y TTL de 30 s, pasé de 579 consultas por segundo a la base a una cada 3 segundos.

Lo que aprendí sobre control: cuanto más cerca del cliente, menos puedo invalidar (no puedo alcanzar el navegador de nadie). Por eso el nivel que no controlo lleva el TTL más corto, porque **la desactualización se suma entre niveles**: 2 horas en el caché de aplicación más 2 en el navegador son hasta 4 horas. Y en los cachés compartidos el `tenant_id` va dentro de la clave, o un merchant podría recibir los datos de otro.

### Cómo se le dice a un navegador qué guardar

Con el header `Cache-Control` de la respuesta. `max-age` va en segundos, `private` deja la copia solo en el navegador (lo que uso para datos por merchant), `public` permite que la guarde un CDN, y `no-store` es no guardar nada, lo que corresponde a datos de pagos. Para lo que no puedo alcanzar, la salida es cambiar el nombre en vez de invalidar: un archivo `app.a1b2c3.js` puede vivir un año en el navegador, porque si cambia el código cambia el nombre.

### La estampida

Con cache-aside es mi código el que, ante un miss, va a la base y llena el caché. Entre el "no está" y el "ya lo guardé" pasan unos 20 ms, y todo request que llegue en esa ventana también ve el caché vacío. Predije que con 500 requests simultáneos se harían unas 500 consultas, y lo corrí: **500 consultas a la base**, todas por el mismo dato. Con un candado que deja pasar a uno solo (y que vuelve a mirar el caché adentro, por si otro ya lo llenó) fueron **1 consulta**, sin tardar más (50 ms contra 57).

## Indexing: de 18,000 millones de filas a 4 lecturas

Con 50 millones de transacciones por día, un año de retención son 18,250 millones de filas. Sin índice, encontrar una implica revisarlas una por una. Con un índice de árbol (cada nodo apunta a unos 500 hijos) son unas 4 lecturas. El B-Tree es el natural para eso porque los datos están ordenados y la búsqueda baja por un único camino de la raíz a la hoja, sin recorrer todo. El costo es el de la Semana 5: cada escritura tiene que actualizar el índice y el índice ocupa espacio.

### Donde se cruza con el particionado

Mi tabla está particionada por `hash(tenant_id + store_id)`. Si el request trae solo el `transaction_id`, la base no puede calcular en qué partición está, y tiene que preguntarle a todas (scatter/gather otra vez). Hay dos formas de indexar una tabla particionada: un **índice local** (cada partición indexa lo suyo: escribir es barato, pero buscar por algo que no es la clave de partición va a todas) y un **índice global** (una sola estructura por el valor indexado: buscar va directo a una, pero cada escritura actualiza dos lugares). Otra vez lectura contra escritura.

Para el polling elegí que el request traiga siempre `tenant_id` y `store_id`, así va directo a una partición y no cuesta nada en escrituras. El precio: acoplo el contrato de la API, y no sirve cuando no tengo esos datos, como el webhook de un PSP, que solo trae su propia referencia.

### Los tres índices del capstone

| Índice | Tipo | Para qué |
|---|---|---|
| `(tenant_id, store_id, transaction_id)` | local | estado de una transacción |
| `(tenant_id, store_id, created_at)` | local | panel del merchant por fechas |
| `(processor_id, psp_reference)` | global | webhooks del PSP |

En un índice compuesto va primero lo que filtro por igualdad y al final el rango. Y el del webhook lleva el par completo, porque `processor_id` solo tiene unos 10 valores distintos y casi no filtra. El costo: cada transacción nueva actualiza la tabla y 3 índices, unas 4 escrituras en vez de 1 (cerca de 2,300 por segundo a mi ritmo), y suponiendo ~50 bytes por entrada contra filas de 500, son aprox. 30% de espacio extra, el mismo +30% que ya usaba en la estimación de storage.

## El entregable

Todo esto quedó escrito en `capstone-requisitos.md`: la partition key, las defensas contra hot partitions, los índices con su costo, y la regla de caching de cada dato, marcando qué es decisión y qué es supuesto.

## En qué me confundí

- Al retomar la semana después del desvío por la 6.6, había olvidado los conceptos casi por completo: solo me quedaban fragmentos sueltos ("asignar comercios a particiones", "una partición para un cliente importante", "algo de repartir entre izquierda y derecha"). El recall activo lo detectó de una: no es lo mismo reconocer un concepto leyéndolo que reconstruirlo de memoria.
- Dije que al agregar la carpa 11 se mudaba "15-20% del salón izquierdo". Doble error: la fracción es ~1/N (1/11 ≈ 9%), y el nodo nuevo le roba a UN vecino, no reparte entre dos.
- Tuve que preguntar qué era exactamente un tenant_id. Tenant = inquilino: cada cliente-empresa de un sistema multi-tenant, que comparte el edificio (la plataforma) pero tiene su departamento con llave. En mi capstone, cada comercio.
- Me hizo ruido si al llenarse una partición "se llenaban también sus followers": sí, idéntico, porque son copias. Lo que me faltaba era la consecuencia: replicar multiplica el almacenamiento (100GB × 3 copias = 300GB), nunca lo reparte.
- No nombré el riesgo de mi propia decisión de partition key al defenderla (hot partition + noisy neighbor); di la solución correcta pero sin enunciar contra qué protegía. En una entrevista o un ADR, el riesgo se nombra primero.
- En caching puse "la base" como uno de los niveles de caché. La base es la fuente de la verdad que el caché protege; los cachés son el navegador, el edge/CDN y la aplicación.
- Dije que `max-age` iba en milisegundos. Va en segundos: 5 minutos son `max-age=300`, no 300000.
- Para el estado pendiente de una transacción elegí `no-cache`, creyendo que significaba "no guardar". Es una trampa de nombre: sí guarda, pero pregunta antes de usarlo. La directiva para no guardar nada es `no-store`, y con datos de pagos conviene esa.
- Le puse 20 a 30 segundos de TTL al estado pendiente diciendo a la vez que el polling siempre quiere lo último: me contradije. Lo resolví cuando pensé en estados finales.
- En el índice del panel por fechas puse `created_at` y `updated_at` como si el rango fueran dos columnas, y me faltó la tienda. Un rango de fechas es una columna entre dos valores, y va al final, después de lo que se filtra por igualdad.
- Para el webhook del PSP propuse indexar por `processor_id`. Con pocos valores distintos casi no filtra; hace falta el par `(processor_id, psp_reference)`.

## Qué sigue

Semana 7 cerrada, con un pendiente anotado en el capstone: definir el umbral con el que detecto una hot partition y el criterio para pasar una tienda a partición dedicada. Sigue la Semana 8: colas, streaming y confiabilidad (retries, backoff, idempotencia).
