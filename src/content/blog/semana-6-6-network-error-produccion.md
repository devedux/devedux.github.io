---
title: "Semana 6.6 aplicada: el network error que tardaba dos minutos en fallar"
description: "La teoría de networking aplicada a un caso real del trabajo: un request de tokenización de tarjetas que fallaba con status 0, por qué el error tardaba una eternidad en aparecer, percentiles para calibrar un timeout, y un request que el cliente dio por muerto pero el backend completó igual."
pubDate: 2026-09-19
tags: ["networking", "system-design", "debugging"]
draft: false
---

Una semana después de cerrar la teoría de networking, me cayó en el trabajo el caso perfecto para aplicarla. Producto reportó que un request crítico del checkout (la tokenización de la tarjeta) fallaba con "network error" para algunos usuarios, y pidió resolverlo desde el frontend. El detalle que hacía todo peor: cuando fallaba, el error tardaba muchísimo en aparecer. El usuario se quedaba mirando un spinner por más de un minuto antes de enterarse de que algo salió mal.

Este post es la historia completa del diagnóstico, porque casi cada concepto de la Semana 6.6 terminó apareciendo en algún punto: TCP y sus retransmisiones, DNS, TLS, percentiles, y un final que no vi venir.

## Por qué un error puede tardar dos minutos en aparecer

Lo primero que había que explicar no era por qué fallaba, sino por qué fallaba **tan lento**. La respuesta está en dos piezas que se combinan mal:

1. `fetch()` **no tiene timeout por defecto**. Si la respuesta no llega, el navegador espera indefinidamente.
2. Cuando una conexión muere en silencio (sin que nadie mande un reset), el TCP del dispositivo retransmite con **backoff exponencial**: espera ~1s, retransmite, espera 2s, 4s, 8s, 16s... En Linux el default son 6 reintentos, unos **127 segundos** antes de rendirse.

O sea que nadie estaba acotando la espera. El navegador hacía lo correcto a nivel protocolo (insistir con paciencia creciente), pero eso es inaceptable a nivel producto en un flujo de pago.

Un matiz que me acomodó la cabeza: "status 0" no es una respuesta HTTP. Es el valor de relleno que ponen las herramientas cuando **no existe** status, porque el request murió en DNS, TCP, TLS o en tránsito, y lo único que recibe el código es un `TypeError` local del navegador. Status solo existe cuando el servidor contesta.

## La evidencia: sesiones reales en vez de suposiciones

Antes de proponer nada, junté HARs de sesiones reales con el fallo (los exporté desde nuestra herramienta de session replay) y les armé un script en Python que clasifica cada sesión: ¿falló solo el request crítico, o fallaron también los assets estáticos y los scripts de terceros? Esa pregunta sola ya divide el mundo: si falla *todo* hacia *todos* los hosts, el problema es la red del usuario, no tu infraestructura.

Lo que salió de las sesiones:

| Sesión | Qué pasó | Red ambiente |
|---|---|---|
| 1 | Fallo tras 12.0s | Degradada (otros requests lentos o caídos) |
| 2 | Fallo tras 0.76s | Sana. El usuario reintentó a mano 44s después: éxito |
| 3 | Fallo tras 10,030ms (ojo al número redondo) | Mediocre. Reintento manual: éxito |
| 4 | Éxito... en 33 segundos | Muy degradada (la página misma tardó 12s en cargar) |
| 5 | Fallo tras 40.8s | Pérdida total: hasta los SVG estáticos fallaron |

Dos cosas saltan de la tabla. Primero: todos los fallos eran transitorios, los reintentos manuales funcionaban. Segundo: la sesión 4 no es un fallo, es un **éxito lentísimo**, y va a ser importante después.

## Latencia, no ancho de banda

Mi primer instinto fue preguntar cuánto ancho de banda manejaban los endpoints. Instinto equivocado: el payload de una tokenización son cientos de bytes, y a ese tamaño el ancho de banda es irrelevante. Todo el tiempo se va en RTTs (DNS + TCP + TLS + ida y vuelta del request) y en el procesamiento del servidor. La regla mental que me quedó: **payload chico, domina la latencia; payload grande, domina el ancho de banda**.

Lo comprobé con un curl con timing por fases contra el gateway: DNS 19ms, TCP 150ms, TLS 290ms. **~425ms solo de peajes de conexión fría**, desde una red buena. En un móvil con RTT alto, fácil un segundo entero antes del primer byte útil.

## Percentiles: cómo se decide un timeout sin adivinar

La solución obvia era ponerle un timeout al request. La pregunta difícil era cuánto. Y acá cometí mi mejor error de la semana: en la reunión le propuse a producto "agregarle un TTL al request". El concepto era correcto (acotar la espera), el término era otro: TTL es cuánto tiempo un dato sigue siendo válido (la fecha de vencimiento del yogurt), timeout es cuánto estoy dispuesto a esperar por una respuesta (cuánto aguanto la cola del banco antes de irme). Lo que yo quería era un timeout.

Para elegir el valor armé gráficas de duración de requests en percentiles. Si nunca los viste: ordenás todos los requests del más rápido al más lento y mirás posiciones en esa fila. El **p50** es la mediana (la experiencia típica), el **p99** es el valor que solo el 1% más lento supera. El promedio no sirve para esto: un solo request de 30s en un mar de requests de 0.5s te da un promedio que no describe la experiencia de nadie.

Con los primeros datos: p50 ≈ 0.8s, p95 ≈ 1.9s, p99 ≈ 4s. La regla práctica es poner el timeout en **p99 × 2-3**, que dio ~10 segundos. Por encima del p99 casi no cortás requests que iban a terminar bien; si lo pusieras en el p95, vos mismo estarías rompiendo el 5% de requests legítimos lentos. Con volumen real eso es mucha gente: sobre 30,000 tokenizaciones diarias, el "solo 5%" son 1,500 pagos rotos por tu propio timeout.

Y acá vuelve la sesión 4: un 201 legítimo que tardó 33 segundos, en una red horrible. Ese usuario vive en el p99.9, y un timeout de 10s seco le habría convertido su éxito en fallo. La decisión de qué hacer con esa cola no es técnica, es de producto: nosotros la presentamos como trade-off explícito (timeout seco vs timeout + reintentos con presupuesto total de ~33s) en vez de esconderla dentro de un número.

## El giro: el request que "falló" en 760ms

La sesión 2 no me cerraba. Red sana, todo lo demás rápido, y el request muere en 760ms. Mi hipótesis era CORS o un WAF. Para confirmarla pedimos correlacionar el `x-request-id` del request fallido contra los logs del servidor.

El resultado me voló la cabeza: el request **sí llegó**. El backend lo procesó en ~300ms y devolvió 201. La tarjeta se creó. **La respuesta se perdió en el camino de vuelta**, y el usuario vio un error mientras su tarjeta ya existía del otro lado.

Esto tiene nombre en sistemas distribuidos: es el escenario del request en el limbo, emparentado con el problema de los Dos Generales. Desde el cliente, "no me respondieron" tiene dos causas posibles que son **indistinguibles**: el request nunca llegó, o llegó, se procesó, y la respuesta se perdió. Ningún diseño del frontend puede diferenciarlas, porque es un límite teórico del canal, no una falla de implementación.

La correlación completa de todos los casos cerró la tipología con los tres modos posibles, los tres vistos en producción:

| Caso | ¿Llegó al backend? | Causa real |
|---|---|---|
| Fallo en 0.76s | Sí, procesó 201 en ~300ms | Respuesta perdida de vuelta (el limbo) |
| Éxito en 33s | Sí, procesó en ~340ms | 32.5s de retransmisiones TCP cliente a servidor |
| Fallos de 10s y 41s | No, cero rastros en logs | El request nunca salió del dispositivo |

Y el dato que exonera al backend: en todos los casos que llegaron, procesó en ~300-340ms. Toda la varianza estaba en la red del cliente.

## La solución completa y el porqué de cada pieza

Con el diagnóstico cerrado, la mitigación desde el frontend quedó en cuatro piezas más una:

**Timeout por intento** con `AbortController`, calibrado con percentiles:

```js
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 10_000);
try {
  return await fetch(url, { ...opts, signal: controller.signal });
} finally {
  clearTimeout(timer);
}
```

**Retry con backoff exponencial y jitter**, máximo 2 reintentos. Solo ante errores transitorios: status 0, el propio `AbortError`, y 5xx. Nunca ante 4xx, porque un request mal formado va a fallar igual las tres veces. Y con tope, porque un retry infinito convierte una degradación del servidor en una tormenta de reintentos que la empeora.

**Idempotencia**, que es la pieza que hace seguro al retry frente al limbo. No la implementa el frontend: es una garantía del backend (en nuestro caso, el endpoint hace upsert). La secuencia que protege: intento 1 queda en el limbo (se procesó pero el cliente no lo sabe), intento 2 llega, y el backend responde con lo ya creado en vez de duplicar. Si el backend en cambio pide un header tipo `Idempotency-Key`, al frontend le toca cooperar con una regla de oro: **una key por operación, no por intento**. La key identifica la intención del usuario, y se reutiliza idéntica en todos los reintentos de ese submit; si generás una nueva por intento, el backend ve operaciones distintas y creaste el duplicado que la key existía para evitar.

**Preconnect** para pagar los ~425ms de DNS + TCP + TLS mientras el usuario tipea, con una trampa que descubrí mirando nuestras propias sesiones: los navegadores cierran las conexiones precalentadas ociosas en ~10-15 segundos, y nuestros usuarios tardan entre 35 segundos y 2 minutos llenando el formulario de tarjeta. Un preconnect al cargar la página muere antes del submit. Hay que dispararlo al enfocar el formulario, o mejor, hacer un warm-up request real, que además es observable desde JavaScript: si falla, sabés que la red está rota antes de que el usuario termine de tipear.

**Telemetría** por cada fallo (tiempo hasta el error, tipo de error, request-id, tipo de conexión). Es la pieza que calibra el timeout con distribución real, mide si el retry funciona, y avisa si algo se degrada después del rollout.

## En qué me confundí

- Le propuse a producto "agregar un TTL al request". Era un timeout. TTL le pone vencimiento a un dato (DNS cachea una IP por N segundos), timeout acota una espera. A un backend "agregar TTL" le suena a tocar DNS o caché, que es otra conversación.
- Pregunté por el ancho de banda de los endpoints cuando la métrica relevante era la latencia. Con payloads de cientos de bytes, el ancho de banda no participa.
- Cuando entendí que un request abortado pudo haberse completado en el servidor, asumí que el request "seguía en la red intentando llegar". No funciona así: los routers no guardan ni reintentan nada, son reenviadores sin memoria. El que insiste es el TCP del propio dispositivo retransmitiendo, y cuando abortás, esa insistencia se apaga con él. Lo peligroso nunca fue el request perdido: es el que sí llegó y cuya respuesta se perdió.
- Clasifiqué el fallo rápido de la sesión 2 como "sistemático, probablemente CORS". Los logs del servidor me lo desmintieron: era el limbo. La lección de método: la hipótesis desde el cliente vale hasta que la correlación server-side habla, porque el cliente literalmente no puede ver la diferencia.

## Qué sigue

El plan quedó documentado y en rollout por fases: primero telemetría sin cambiar comportamiento, después el timeout holgado, después la calibración fina con percentiles maduros, y al final el retry cuando backend confirme la idempotencia como contrato. Del lado del roadmap, esta semana confirmó algo que ya sospechaba: la teoría de la Semana 6.6 no era relleno académico, era exactamente el vocabulario que necesité para diagnosticar un problema real de producción y defender la solución con números en vez de corazonadas.
