---
title: "Semana 6.6: todo lo que pasa antes de que mi servidor vea el primer byte"
description: "Sexto punto medio de frontend a AI engineer: RTT como piso físico de la latencia, DNS y su caché, TCP handshake, TLS 1.2 vs 1.3, TCP slow start, el mantra de 4 pasos, y un script propio en Python que mide las 5 fases contra un endpoint real."
pubDate: 2026-09-04
tags: ["ai-engineering", "system-design", "networking"]
draft: false
---

Toda la Semana 5 y la Semana 6 asumí que el request ya había llegado a mi servidor. Nunca pregunté qué pasa antes de eso: el viaje físico entre que el cliente aprieta Enter y el primer byte le llega a mi código. Esta semana es esa parte, y resultó que el 75% de un presupuesto de 100ms se puede ir ahí, sin que mi servidor haya procesado nada todavía.

## RTT: el piso físico que ningún código puede bajar

RTT es Round-Trip Time, el tiempo de ida y vuelta de un paquete. Y tiene un límite real detrás, no es solo "las computadoras son lentas": nada viaja más rápido que la luz, y en fibra óptica viaja más lento todavía (factor ~1.5 por el índice de refracción del vidrio).

Con eso armé una cuenta real: Lima a Frankfurt son ~10.500 km, y el mínimo teórico de RTT ahí es **105 ms**. No es una estimación pesimista, es una pared física. Si mi capstone tiene un presupuesto de <100ms y un merchant está a esa distancia, ya perdí antes de que mi servidor procese un solo token.

La única variable que puedo mover soy yo: no la velocidad (fija), sino la **distancia**. Ahí está el argumento real detrás de tener servidores en varias regiones (edge servers / CDN): no es "cachear en varios lados porque sí", es acercar físicamente el servidor al cliente para bajar esa distancia.

## DNS: el nombre no es la dirección

El navegador tiene `mi-dominio.com`, un nombre pensado para humanos. Para mandar cualquier paquete hace falta una dirección real: la **IP**. DNS es el proceso que traduce nombre a IP, y cuesta un viaje de red completo antes de que el navegador pueda mandarle nada al servidor real.

Un punto que me costó fijar bien: **el servidor DNS y el servidor de mi aplicación son máquinas completamente distintas**. El DNS solo resuelve el nombre y entrega la IP al cliente, después desaparece de la conversación. Todo lo que sigue (TCP, TLS, HTTP) es una charla directa entre el cliente y el servidor real de mi capstone, el DNS no participa de nada de eso.

La IP resuelta se guarda en caché en la máquina del cliente, con un **TTL** (Time To Live) que le pone fecha de vencimiento. La razón del TTL no es que la caché "se llene": es que **las direcciones cambian**. Si migro mi servidor a otra región y un cliente tuviera la IP vieja cacheada para siempre, le seguiría escribiendo a una dirección muerta sin ninguna forma de enterarse del cambio.

Y algo interesante que se desprende de esto: un mismo dominio puede resolver a IPs distintas según la región del cliente (geo-DNS), que es el mecanismo real detrás de mi decisión de multi-región ya tomada en el capstone. Y al revés también existe: varios dominios pueden compartir la misma IP (hosting compartido), y ahí el servidor necesita otra pieza de información para saber a cuál de todos responder.

## TCP handshake: confirmar que ambos lados escuchan, no solo uno

Antes de mandar datos reales hace falta un intercambio de 3 mensajes, el three-way handshake: SYN (cliente pregunta si lo escuchan), SYN-ACK (servidor confirma y pregunta lo mismo), ACK (cliente confirma la confirmación). Hacen falta los 3 porque con solo 2 mensajes el cliente ya tiene certeza de que la comunicación anda en ambos sentidos, pero el servidor todavía no sabe si su propia respuesta llegó.

Esto cuesta ~1.5 RTT antes de poder mandar el primer byte de datos de la aplicación. Sumado al RTT del DNS, con un RTT de ejemplo de 30ms, ya se fueron 75ms de un presupuesto de 100ms, sin que mi servidor haya visto nada todavía.

## IP y puerto: dirección del edificio, número de departamento

Un router en el medio del camino solo necesita la IP para decidir el siguiente salto (eso es ruteo), sin conocer la ruta completa de antemano. La IP te lleva a la máquina correcta, pero una máquina puede tener varios servicios corriendo a la vez, así que hace falta el **puerto** para saber a cuál de esos servicios va el paquete (443 para HTTPS, 80 para HTTP).

Y algo que tenía mal ubicado: la IP viaja en la capa más externa del paquete (la que lee cada router), mientras que el nombre de dominio (el header `Host`) viaja enterrado en la capa más interna, la del HTTP, que además va cifrada. Son capas anidadas: IP afuera de todo, Host adentro de todo. Un router nunca podría leer el `Host` aunque quisiera, ni le hace falta.

## TLS handshake: el huevo y la gallina que resuelve SNI

TCP confirma que ambos lados escuchan, pero la conexión sigue siendo texto plano. TLS es la capa que cifra, y tiene su propio problema interesante: para elegir qué certificado mostrar, el servidor necesita saber a qué dominio corresponde el request, pero ese dominio normalmente solo aparece dentro del header `Host` del HTTP, que va cifrado, y ese cifrado se termina de armar recién después de que el certificado ya se tendría que haber elegido.

La solución es **SNI** (Server Name Indication): una extensión del primer mensaje de TLS, el `ClientHello`, donde el nombre del dominio viaja en texto plano, antes de que exista cualquier cifrado. No es un mensaje aparte ni cuesta un RTT extra, es un campo más dentro del mensaje que ya se iba a mandar de todas formas.

## TLS 1.2 vs 1.3: dos mejoras distintas, no una

Acá me costó separar dos cosas que son mejoras diferentes:

- **El handshake completo** baja de 2 RTT (TLS 1.2) a **1 RTT** (TLS 1.3): el cliente propone el cifrado en su primer mensaje en vez de preguntar primero y proponer después, y el servidor responde todo junto.
- **0-RTT** es una mejora aparte, y solo aplica a un cliente que **ya se conectó antes**: guarda un secreto de la sesión anterior y puede mandar datos cifrados en su primerísimo paquete, sin esperar ninguna respuesta.

Con un RTT de ejemplo de 30ms, la diferencia es real: TLS 1.2 (60ms) + DNS (30ms) + TCP (45ms) ya suma 135ms, pasado el presupuesto de 100ms antes de que el servidor procese nada. Con TLS 1.3 en la primera visita son 105ms, todavía justo. Con 0-RTT en una visita repetida, 75ms, con margen real para el cómputo del modelo.

## TCP slow start: por qué un request frío es más lento que uno tibio, incluso con el mismo ancho de banda

Con TCP y TLS confirmados, todavía falta un paso antes de que los datos lleguen completos: la transferencia en sí no es instantánea, ni siquiera después de todos los handshakes.

El servidor no sabe de antemano cuánto ancho de banda soporta esa conexión puntual, ni cuánta congestión hay en la red intermedia. Si mandara todo de una sola vez y la conexión real no aguantaba eso, satura el canal y empieza a perder paquetes. Por eso TCP usa slow start: manda un paquete chico primero, espera la confirmación, y duplica la cantidad en la siguiente tanda (1, 2, 4, 8, 16 unidades de datos, así sucesivamente).

Ahí está la diferencia entre frío y tibio. Una conexión nueva arranca este algoritmo desde cero, encima de un DNS y un TCP y un TLS que también arrancaron desde cero. Una conexión que ya se venía usando tiene la ventana de slow start ya expandida de rondas anteriores, así que la transferencia sale casi instantánea aunque el archivo sea el mismo. Por eso mantener conexiones abiertas no solo ahorra los dos handshakes (TCP y TLS): también ahorra volver a arrancar la transferencia desde el paquete más chico posible.

## El mantra de 4 pasos: decomponer, medir, encontrar el dominante, repetir

Es muy fácil decir "el servidor está lento" sin evidencia, y terminar optimizando algo irrelevante. El mantra existe para reemplazar la conjetura por medición real:

1. **Decomponer** el ciclo completo del request en sus fases: DNS, TCP, TLS, procesamiento del servidor, transferencia. Las tres primeras son puro peaje de red, pasan antes de que mi servidor vea nada. Las últimas dos son las únicas donde mi código realmente participa.
2. **Medir** cada fase por separado, en milisegundos reales, no supuestos.
3. **Encontrar el dominante**: la fase que se lleva la mayor parte del tiempo total es la única que vale la pena atacar primero.
4. **Repetir**: arreglo el dominante, vuelvo a medir, aparece un nuevo dominante, sigo.

## El árbol de diagnóstico de latencia

Antes de tocar el script de medición, el video de la fuente de esta semana (AI System Design Ep. 1) trae algo más valioso que el ejemplo puntual: un árbol de decisión genérico para diagnosticar por qué un request es lento, con solo dos preguntas y cuatro diagnósticos posibles.

**Primera pregunta: ¿dónde están los usuarios afectados?**

- **En una región específica y lejana** del servidor de origen. Segunda pregunta: ¿ocurre solo en la primera petición, o en todas?
  - **Solo la primera:** es un problema de cold start (DNS, TCP y TLS arrancando de cero, más el TCP slow start pegándole a la primera transferencia). Solución: edge server para esa región, reutilizar conexiones, y migrar a TLS 1.3 si todavía estoy en 1.2.
  - **En todas, incluso con la conexión ya tibia:** ya agoté todo lo que se arregla con software. Lo único que queda es la distancia física, y ahí no hay más solución que un edge server.
- **En todas partes por igual**, sin importar la región. La distancia queda descartada. Segunda pregunta: ¿la respuesta es grande o chica?
  - **Grande:** cuello de botella de ancho de banda, agravado por el TCP slow start si la conexión no está tibia. Solución: comprimir los datos (40-60% menos peso) y mantener conexiones abiertas.
  - **Chica y constante:** por eliminación, ni es distancia ni es transferencia. El problema está en el procesamiento del propio servidor: ahí sí entra optimizar las llamadas a un LLM o el pipeline de código, pero recién como última hoja del árbol, no como primera sospecha.

Lo que rescato de esto no es el ejemplo puntual, es el método: dos preguntas bien elegidas descartan la mitad de las causas posibles en cada paso, en vez de adivinar "el servidor está lento" sin evidencia.

## El script real: medir las 5 fases con Python puro

El entregable de la semana no era leer sobre latencia, era escribirla. Armé `latency_measurement.py` con `socket`, `ssl` y `time`, sin `requests` de por medio a propósito: esa librería esconde justo las 5 fases que quería medir por separado.

Cada fase es una función que devuelve un `NamedTuple` tipado (el equivalente en Python a una `interface` de TypeScript), y cada una abre su propia conexión en vez de compartir una entre fases. Repetir la apertura de conexión entre funciones es intencional, no desperdicio: es la única forma de que cada fase sea medible de forma aislada, la misma idea del paso 1 del mantra.

Contra `google.com` (todavía no tengo un endpoint propio del capstone desplegado, eso llega recién en el Módulo 1.4), el resultado real:

| Fase | Tiempo medido |
|---|---|
| DNS | 3.93 ms |
| TCP | 59.46 ms |
| TLS | 64.81 ms (confirmé TLSv1.3 real, no asumido) |
| Servidor | 136.65 ms |
| Transferencia | 0.43 ms |
| **Total** | **~265 ms** |

Aplicando el paso 3 del mantra sobre mis propios números: el servidor es el 51% del tiempo total, más que DNS, TCP y TLS juntos. Y la transferencia salió casi cero porque la respuesta fue chica (una redirección de 220 bytes que entra completa en la primera ronda de slow start, sin necesitar duplicar nada), confirma en código real la hoja del árbol de arriba: "respuesta chica y constante, la transferencia no es el cuello de botella".

## En qué me confundí

- Confundí sync con semi-sync en un recap anterior de replicación, y esta semana volví a mezclar etiquetas dos veces: dije "el servidor le entrega la IP al cliente" refiriéndome al servidor de mi aplicación, cuando es el servidor DNS (una máquina completamente aparte) el que hace eso. Se me coló dos veces seguidas pese a la corrección.
- Al explicar el problema que resuelve SNI, primero lo planteé al revés (dije que el certificado necesitaba el dominio "que viene dentro de ese cifrado"), cuando el problema real es el opuesto: el dominio normalmente solo aparece **después** de que el certificado ya se tendría que haber elegido. Lo corregí bien en el segundo intento, sin que me lo repitieran.
- Mezclé las dos mejoras de TLS 1.3 en una sola, y le puse "0 RTT" a la mejora general del handshake completo, que en realidad es 1 RTT. El 0-RTT real es un caso aparte, solo para visitas repetidas.
- Escribiendo el script: intenté sacar un valor de una función asignándolo a una variable global con el mismo nombre, sin entender que una asignación dentro de una función crea una variable local nueva que no toca a la de afuera, aunque se llamen igual. La variable global se quedaba vacía para siempre. La solución no fue agregar `global`, fue devolver un `NamedTuple` con todo lo que necesitaba.
- Llamé `.version()` sobre el socket de TLS **después** de cerrarlo, y me devolvió `None` en vez de la versión real negociada. Mismo error de fondo que el `print` contaminando una medición: usar algo después de haberlo liberado.
- En la función que mide servidor y transferencia, calculé los dos tiempos restando siempre contra el mismo punto de partida, en vez de que el segundo tramo se midiera desde donde terminó el primero. Los dos números me salieron casi idénticos (134.59ms y 134.77ms) hasta que resté uno del otro y noté que esa diferencia de 0.18ms era el número real de transferencia, escondido adentro del bug.

## Qué sigue

Semana 6.6 cerrada del todo: teoría completa y el script funcionando de punta a punta, con tipos, sin variables globales, sin fugas de recursos, y con las 5 fases genuinamente aisladas entre sí. Cuando tenga un endpoint propio desplegado en el Módulo 1.4, corro este mismo script sin cambiar una línea de lógica, solo el target. Sigue la Semana 7: partitioning, consistent hashing, hot partitions, caching/CDN e indexing, aplicados al capstone.
