---
title: "Semana 9: la carrera que la idempotencia sola no frena"
description: "Novena semana de frontend a AI engineer (en curso): niveles de aislamiento (read uncommitted, read committed, snapshot isolation/MVCC), por qué la idempotencia de mi flujo de pagos necesitaba un unique constraint que yo no le había puesto, y cómo una base de datos deja leer y escribir en paralelo sin bloquear a nadie."
pubDate: 2026-09-30
tags: ["ai-engineering", "system-design", "databases"]
draft: true
---

Todo lo que diseñé hasta la Semana 8 asumía que cada operación corre sola. Esta semana es la primera vez que pregunté qué pasa cuando dos operaciones tocan el mismo dato al mismo tiempo, y me encontré con un hueco real en mi propio diseño de idempotencia de la semana pasada.

## La idempotencia sola no alcanza

Mi flujo de pagos usa un `order_id` para reconocer reintentos: si ya existe un `transaction_id` para ese `order_id`, devuelvo el mismo resultado en vez de cobrar de nuevo. Pensaba que con eso ya estaba resuelto. No es así, y el motivo me costó verlo: ese chequeo se implementa como dos pasos separados, primero `SELECT` (¿existe?) y después `INSERT` (si no existe, creá). Con dos requests casi simultáneos, los dos `SELECT` pueden correr antes de que cualquiera de los dos `INSERT` pase, así que los dos ven "no existe" al mismo tiempo y los dos insertan. Resultado: dos filas para la misma orden, con dos `transaction_id` distintos.

Esto tiene nombre, **race condition de tipo check-then-act**: lo que era cierto en el momento de chequear dejó de serlo en el momento de actuar. No es un bug de mi lógica de idempotencia, es que esa lógica necesita que la base la respalde.

## Read uncommitted y read committed no lo resuelven

Con **read uncommitted** (el nivel más débil, cada transacción ve los cambios de otra incluso antes de que confirme) el problema pasa igual: las dos transacciones ven "no existe" y las dos insertan.

Con **read committed** (nunca ves un borrador ajeno sin confirmar) tampoco cambia nada, y esto es lo que más me costó entender. El motivo: en el instante en que la segunda transacción hace su `SELECT`, la primera **todavía no confirmó nada** (ni siquiera llegó a su `INSERT`). Read committed solo tiene una regla, "no muestres borradores sin confirmar", y ahí no hay ningún borrador que ocultar. El problema nunca fue "ver algo que no debía", fue que las dos decisiones se tomaron antes de que cualquiera de las dos escribiera algo.

## Lo que sí lo resuelve: un unique constraint

La solución no está en subir el nivel de aislamiento para esto en particular, está en una restricción de tabla: `order_id` no puede repetirse en ninguna fila. Con esa regla puesta, las dos transacciones pueden seguir creyendo que están solas al leer, pero al momento de escribir, **solo una de las dos gana**: la otra falla con un error de restricción única, sin excepción.

Eso cambió cómo tiene que reaccionar mi código: si el `INSERT` falla por esa restricción, no es un error real, es la señal de que alguien más ya estaba procesando esa orden, y tengo que ir a buscar esa fila y devolver su resultado en vez de inventar uno nuevo. El `order_id` viajando en el request nunca fue suficiente por sí solo; necesitaba algo en la base que hiciera imposible que dos escrituras con el mismo valor coexistieran.

## Snapshot isolation y MVCC

Hay un problema distinto que read committed tampoco resuelve: una misma transacción que lee el mismo dato dos veces puede recibir dos respuestas distintas si alguien más confirmó un cambio en el medio (lectura no repetible). Con **snapshot isolation**, en cambio, quedo anclado a una foto fija de la base desde el momento en que mi transacción arranca, sin importar qué confirmen otros mientras tanto.

Lo que hace esto posible es **MVCC** (Multi-Version Concurrency Control): la base no sobreescribe una fila al actualizarla, guarda varias versiones a la vez, cada una válida desde cierto momento. Mi transacción, si arrancó antes de que existiera una versión nueva, sigue leyendo la vieja durante toda su vida, aunque la nueva ya esté confirmada y visible para cualquier transacción que arranque después. Lo que más me sorprendió: nada de esto necesita bloquear a nadie. Lectores nunca bloquean a escritores, escritores nunca bloquean a lectores, cada uno trabaja sobre su propia versión en paralelo real, sin el costo de bloqueo que ya conozco de otras semanas.

## En qué me confundí

- Pensé que mi diseño de idempotencia de la Semana 8 (el `order_id` viajando en cada reintento) ya alcanzaba para evitar el doble cobro. Le faltaba la mitad: un unique constraint en la base, sin el cual el chequeo "¿ya existe?" puede correr dos veces en paralelo sin enterarse una de la otra.
- Necesité armar el mecanismo con líneas de tiempo muy concretas (momento por momento) para ver por qué read committed no cambiaba nada frente a la carrera del `order_id`. Pensado en abstracto, se me mezclaba con la idea de "ver borradores ajenos", que no era el problema real acá.

## Qué sigue

Quedan los niveles de aislamiento más fuertes (serializable, con optimistic concurrency control) y el resto del bloque de coordinación: consenso con Raft, Spanner y TrueTime, y transacciones distribuidas con 2PC. Publico esto en draft mientras cierro esas partes.
