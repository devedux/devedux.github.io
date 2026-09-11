---
title: "Semana 6.6: todo lo que pasa antes de que mi servidor vea el primer byte"
description: "Sexto punto medio de frontend a AI engineer: RTT como piso físico de la latencia, DNS y su caché, TCP handshake, y por qué TLS 1.3 le gana a TLS 1.2 en milisegundos que sí importan para un presupuesto de latencia ajustado."
pubDate: 2026-09-04
tags: ["ai-engineering", "system-design", "networking"]
draft: true
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

## En qué me confundí

- Confundí sync con semi-sync en un recap anterior de replicación, y esta semana volví a mezclar etiquetas dos veces: dije "el servidor le entrega la IP al cliente" refiriéndome al servidor de mi aplicación, cuando es el servidor DNS (una máquina completamente aparte) el que hace eso. Se me coló dos veces seguidas pese a la corrección.
- Al explicar el problema que resuelve SNI, primero lo planteé al revés (dije que el certificado necesitaba el dominio "que viene dentro de ese cifrado"), cuando el problema real es el opuesto: el dominio normalmente solo aparece **después** de que el certificado ya se tendría que haber elegido. Lo corregí bien en el segundo intento, sin que me lo repitieran.
- Mezclé las dos mejoras de TLS 1.3 en una sola, y le puse "0 RTT" a la mejora general del handshake completo, que en realidad es 1 RTT. El 0-RTT real es un caso aparte, solo para visitas repetidas.

## Qué sigue

Quedan dos piezas cortas de esta misma semana: TCP slow start (por qué un request "frío" es más lento que uno "tibio") y el mantra de 4 pasos para decidir dónde optimizar primero (decomponer, medir, dominante, repetir). Y el entregable real: un script de medición de DNS, TCP y TLS contra mi propio endpoint del capstone, para reemplazar los números de ejemplo de este post por mediciones reales. Publico esto en draft mientras cierro esas dos partes.
