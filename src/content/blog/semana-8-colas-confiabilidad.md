---
title: "Semana 8: la cola que aísla, el log que no olvida, el reintento que no duplica"
description: "Octava semana de frontend a AI engineer: por qué separar productor y consumidor en pools distintos, backpressure con sus dos palancas, message queue vs event streaming, y la confiabilidad completa (timeouts por percentiles, retries selectivos, backoff exponencial con jitter, idempotencia) aplicada al flujo de pagos de mi capstone."
pubDate: 2026-09-29
tags: ["ai-engineering", "system-design", "distributed-systems"]
draft: false
---

Hasta la Semana 7 todo lo que diseñé asumía trabajo que se resuelve en el momento: llega un request, respondo, listo. Esta semana fue la primera vez que separé "recibir algo" de "hacer algo con eso", y resultó que buena parte de la teoría ya la había vivido sin saberlo: en la investigación real del network error de la Semana 6.6 ya usé retry con backoff y jitter, percentiles para calibrar timeouts, e idempotency keys.

## Por qué una cola, no una llamada directa

Mi capstone tiene un agente que investiga incidentes, y esa investigación puede tardar 30 segundos o varios minutos. Si el código que detecta la alerta llama directo a la función que investiga y espera, agarra un worker y lo bloquea todo ese tiempo. Con 50 workers disponibles y 50 alertas juntas, no queda ninguno libre, y un merchant pidiendo su dashboard (que no tiene nada que ver con ningún incidente) se queda esperando detrás de trabajo completamente ajeno.

El error que cometí al razonar esto fue pensar que el problema era "lentitud" en abstracto. No es eso: es que trabajo rápido y trabajo lento compiten por el mismo recurso. Cuando comparten pool, lo rápido hereda la lentitud de lo lento. La solución es una cola: el código que detecta la alerta hace algo rápido (escribir un mensaje) y libera el worker enseguida; un pool separado de workers, dedicado solo a investigar, consume la cola a su propio ritmo. Ahora el dashboard nunca compite por el mismo recurso que las investigaciones.

Esto define tres roles: **productor** (quien escribe en la cola), **broker** (el sistema aparte que la sostiene, ni productor ni consumidor), y **consumidor** (quien la lee y hace el trabajo).

## Backpressure: dos mecanismos, no uno

Separar los pools no hace que la capacidad sea infinita. Si el pool de consumidores también se satura, los mensajes se acumulan en la cola, que vive en algo físico (memoria o disco) con su propio límite.

Hay dos formas de que un sistema lento frene a uno rápido sin explotar:

- **Push con límite:** la cola tiene un tamaño máximo, y al llegar ahí rechaza mensajes nuevos. El productor se entera del rechazo y reacciona (reintenta después, descarta, frena la fuente).
- **Pull a demanda:** el consumidor pide el siguiente mensaje solo cuando terminó con el anterior (así funciona Kafka). Nadie empuja nada, así que nadie tiene que rechazar nada explícitamente; el trabajo simplemente se acumula detrás del consumidor a su propio ritmo.

El pull no es inmune, solo compra más margen: guarda en disco en vez de RAM, y disco tolera mucho más volumen antes de llegar a un límite. Si el consumidor se atrasa de forma sostenida (no una ráfaga corta, sino para siempre), el log también llega a su tope tarde o temprano, y ahí sí alguien tiene que decidir entre descartar lo más viejo o frenar al productor.

## Message queue vs event streaming

La pregunta que separa a los dos: una vez consumido un mensaje, ¿tiene sentido volver a leerlo?

"Mandale este email al merchant X" no. Una vez enviado, releerlo solo arriesga mandarlo dos veces. Eso encaja con una **cola** clásica: se borra al consumir.

"La transacción T cambió a aprobada" sí puede necesitar releerse, porque hoy no sé todos los usos futuros de ese dato: el dashboard en vivo lo necesita ahora, y un sistema de analytics que ni existe todavía podría necesitar reprocesar los últimos 30 días. Eso encaja con un **log con retención**, tipo Kafka.

Y ahí aparece el problema real de usar una cola simple para el segundo caso: si el dashboard consume el mensaje primero, se borra, y el sistema de analytics se queda sin nada, aunque los dos lo necesitaran igual de legítimo. Un log lo resuelve dándole a cada consumidor su propio **offset**: un puntero de "hasta acá ya leí", independiente del de los demás. Nadie borra nada al leer, y varios consumidores pueden procesar el mismo evento a ritmos completamente distintos sin pisarse.

## Confiabilidad: lo que ya había vivido, ahora con nombre

### Timeout no es TTL

Los dos le ponen un límite de tiempo a algo, pero a cosas distintas y decididos por partes distintas: el TTL lo decide quien **guarda** un dato en caché (cuánto tiempo sigue siendo válido); el timeout lo decide quien **hace una llamada** (cuánto está dispuesto a esperar una respuesta). Confundirlos no es un detalle de nombre: si por error uso un TTL de 5 minutos como timeout de una llamada a un PSP caído, el worker queda preso 5 minutos enteros, y es el mismo problema de agotamiento de pool del principio de la semana, con otra causa.

### Calibrar el timeout con percentiles

Con p50=200ms, p95=800ms, p99=2.5s: poner el timeout en el p50 corta a la mitad de mis requests legítimos que solo estaban siendo un poco más lentos de lo normal. Ponerlo muy alto (15 segundos, "para estar seguros") no es un problema de paciencia del usuario en primer lugar, es el mismo agotamiento de workers de siempre: un worker preso 15 segundos en un PSP que puede estar muerto, no solo lento. La regla: cerca del p99, con un poco de margen por encima (no exacto), porque justo en el p99 hay un 1% de requests legítimos que terminarían bien con un poco más de tiempo.

### Retry solo en fallos transitorios

Un `503` (el servicio está sobrecargado ahora mismo) sí conviene reintentar: es una condición pasajera. Un `400` (la tarjeta está mal formada) no: va a fallar exactamente igual las veces que lo reintente, porque el error está en lo que yo mandé, no en el servidor. Y reintentar el que no corresponde no es neutro: si un bug en el frontend manda mal el número de tarjeta a todos los usuarios de golpe, cada retry automático multiplica por 3 o 5 el trabajo real sobre la cola, los workers, CPU, RAM y disco, del mismo tipo de problema que el resto de la semana.

### Backoff exponencial + jitter, juntos, no en dos pasos

Este es el que más me costó ordenar. No es "backoff calcula un número fijo, y después le sumo jitter aparte". Es una sola fórmula: `delay = random(0, base × 2^intento)`. El backoff exponencial define **hasta dónde** puede llegar la ventana en cada intento (crece: 1s, 2s, 4s, 8s...). El jitter es el número al azar **dentro** de esa ventana en cada intento. Sin jitter, si 1,000 clientes reintentan con el mismo delay fijo, los 1,000 caen exactamente en el mismo instante sobre un PSP que ya estaba sufriendo: es la misma estampida que ya había visto con 500 lecturas simultáneas a una base cuando vence un caché popular, con otro disparador. Medido: sin jitter, los 1,000 caen juntos; con jitter, el pico máximo en cualquier ventana baja a 67.

### Idempotencia: lo que cierra el flujo de pagos

Un reintento después de que la respuesta se perdió (el limbo, ya lo viví en producción) puede terminar mandando el mismo cobro dos veces si nada distingue "intento nuevo" de "mismo intento de antes". La solución es que el mismo `order_id` viaje en cada reintento de una misma orden, y el backend lo use para reconocer que ya generó un `transaction_id` para esa orden: si ya existe, devuelve el mismo resultado en vez de cobrar de nuevo.

## En qué me confundí

- Pensé que la cola de una investigación se llena solo cuando el consumidor "ya no da para más". No es un modo de falla que aparece de golpe: cualquier desface momentáneo entre producir y consumir hace que la cola tenga algo esperando, todo el tiempo, como trabajo normal. El problema real es que crezca sin parar, no que tenga algo adentro.
- Esta semana entendía el mecanismo pull al revés: creía que el consumidor "genera" el log. Lo escribe el productor, igual que en el mecanismo push; el consumidor solo lee, a su propio ritmo.
- Cuando 1,000 clientes reintentan con el mismo delay fijo y le pegan juntos al mismo PSP, dije que el resultado era "backpressure". No lo es: backpressure es mi propio sistema protegiéndose a sí mismo. Esto es la misma estampida que ya había visto con la caché (muchos consumidores sincronizados golpeando algo al mismo tiempo), aplicada a reintentos en vez de a un caché vencido.
- Al calibrar el timeout, expliqué por qué no ir muy alto con lenguaje de experiencia de usuario ("el usuario puede esperar 2-3 segundos"), cuando el motivo de fondo es el mismo agotamiento de workers de todo el resto de la semana, no la paciencia de quien espera.
- Pensaba el backoff exponencial y el jitter como dos pasos separados: primero calcular un delay fijo que crece, después sumarle aleatoriedad aparte. Es una sola fórmula: el backoff define la ventana que crece en cada intento, y el jitter es el número al azar elegido dentro de esa ventana, no algo que se aplica después y por afuera.

## Qué sigue

Entregable de la semana: diseñar el pipeline async con cola para mi capstone y documentar la estrategia de retry/backoff+jitter/idempotencia para el flujo `order_id` → `transaction_id`, que ya estaba pendiente en `capstone-requisitos.md` desde hace semanas. Sigue la Semana 9: consenso, transacciones y coordinación.
