---
title: "Semana 5: ¿Qué hace el sistema vs qué tan bien lo hace?"
description: "Quinto paso de frontend a AI engineer: arranca System Design. Requisitos funcionales vs no funcionales, con ejemplos de mi propio capstone de pagos, y un error real sobre dónde va la seguridad."
pubDate: 2026-08-15
tags: ["ai-engineering", "system-design"]
draft: false
---

Después del Módulo 1.1 (internals de LLMs, todo código desde cero), esta semana arranca el Módulo 1.2: System Design. Cambia el método: en vez de escribir todo a mano, uso mi propio capstone (una plataforma de pagos multi-tenant) como caso de estudio para practicar diseño de sistemas.

## Funcionales vs no funcionales

La distinción base: **funcional = qué hace el sistema** (una acción de negocio concreta, un verbo). **No funcional = qué tan bien lo hace** (una cualidad o restricción que aplica sobre esas acciones: confiabilidad, escalabilidad, latencia, seguridad).

Practiqué clasificando 5 enunciados de mi propio capstone:

1. "El sistema debe decidir a qué PSP rutear cada transacción." → **Funcional.** Es lógica de negocio concreta.
2. "El servicio de scoring debe responder en menos de 100ms." → **No funcional.** Describe una restricción de calidad sobre cómo se comporta el sistema, no una acción de negocio.
3. "El agente debe generar una hipótesis de causa raíz cuando cae la tasa de auth." → **Funcional.** Es una acción concreta que el sistema hace ante un evento.
4. "El sistema debe soportar 10,000 transacciones por segundo en hora pico." → **No funcional.** Describe una restricción de capacidad/carga, no una acción de negocio puntual.
5. "Los datos de un merchant nunca deben ser visibles para otro merchant." → **No funcional.** Es seguridad (aislamiento/autorización).

La regla que me quedó para no confundirlo: **funcional = un verbo específico de negocio** ("rutea", "genera hipótesis", "procesa el pago"). **No funcional = una restricción que aplica sobre todas esas acciones** (qué tan rápido, qué tan seguro, qué tan aislado, qué tan disponible). "Nunca deben ser visibles" no es una acción que el sistema hace, es un límite que el sistema respeta siempre, y esa es la marca de un no funcional. La razón "es lógica de negocio" es demasiado amplia para servir de criterio, casi cualquier requisito se puede justificar así.

## Estimación de capacidad: QPS

Esto es literalmente el mismo requisito #4 de arriba ("soportar 10,000 TPS"), pero puesto en números en vez de solo nombrado. La estimación de capacidad (QPS, storage, bandwidth) es la versión cuantificada de un requisito no funcional de escalabilidad.

**QPS de escritura**, con mi propio capstone como ejemplo: si el sistema procesa 50,000,000 de transacciones por día, la fórmula es `eventos totales / segundos totales del período`. Un día tiene 86,400 segundos (24×60×60), entonces:

```
50,000,000 / 86,400 ≈ 579 QPS de escritura
```

**QPS de lectura** usa un ratio lectura:escritura, porque un mismo dato se escribe una vez pero se lee muchas veces después (en mi caso: dashboards de monitoreo consultando constantemente, más el agente de investigación consultando varias veces por incidente). La fórmula:

```
QPS de lectura = QPS de escritura × ratio lectura:escritura
```

Con un ratio de 50:1 (elegido como supuesto razonable para el ejercicio, no un dato real medido de ninguna empresa):

```
579 × 50 = 28,950 QPS de lectura
```

Casi 50 veces más carga de lectura que de escritura sobre el mismo dato, un número que en un diseño real te diría dónde priorizar optimización (cache, réplicas de lectura).

**Dos matices importantes que aprendí en el camino:**

- Este es el QPS **promedio**, no el de **hora pico**. Un sistema real no recibe tráfico parejo; para dimensionar infraestructura de verdad hay que aplicarle un factor de pico al promedio (una regla común es 2-3x el promedio, aunque varía según el dominio).
- El ratio (50:1) no tiene unidades, es solo una proporción/multiplicador. El QPS sí tiene unidades (consultas por segundo). Al principio los mezclé mentalmente, como si el "1" del ratio fuera en sí mismo un valor de QPS. No lo es: el ratio es la herramienta que multiplicás sobre un QPS ya calculado, no un resultado en sí mismo.

## Storage y bandwidth (transacciones)

Storage usa una fórmula distinta a QPS, y no hay que confundirlas: storage no usa QPS para nada, usa el conteo total de eventos del día (sin dividir por segundos) multiplicado por el tamaño de cada registro.

```
Storage = cantidad total de registros × tamaño por registro
```

Con 50,000,000 transacciones/día y un registro estimado en 500 bytes:

```
50,000,000 × 500 bytes = 25 GB diarios
25 GB × 400 días (atajo de redondeo, en vez de 365) ≈ 10 TB al año
```

Con el test de Hello Interview, "¿y entonces qué?", comparando contra dos referencias reales de mis fuentes (acortador de URLs: 15 TB en 5 años, "cabe en una máquina"; WhatsApp: 4-12 PB en 5 años, "necesita distribuido"), mis 10 TB/año caen en el medio, así que la conclusión es: **almacenamiento distribuido con particionamiento**, y específicamente **particionado por `tenant_id`** (porque las consultas típicas son "dame las transacciones de este merchant", no cruzando merchants, y de paso refuerza el aislamiento de seguridad entre tenants). Además, separar storage caliente (datos recientes, acceso frecuente) de frío (datos viejos, movidos a S3 con lifecycle policies), mismo patrón TTL que usa el ejemplo real de WhatsApp de mis fuentes.

**Bandwidth** usa `QPS × tamaño promedio de la respuesta`. Con QPS de lectura=28,950 y una respuesta promedio de 2 KB:

```
28,950 × 2 KB = 57,900 KB/s = 57.9 MB/s
57.9 MB/s × 8 (bytes a bits) = 463.2 Mbps
```

## Cómo derivar qué campos tiene un registro (sin adivinar)

Esto me costó entender: en una entrevista real, nadie te da los campos armados, se supone que vos los derivás. La técnica que aprendí para no adivinar al azar:

1. **Contar la historia del requisito.** Para cada acción funcional, preguntarme qué pasa antes, durante y después, y qué información hace falta recordar en cada momento.
2. **Checklist de categorías** que casi todo registro necesita: identidad (ID), pertenencia (de quién es esto), tiempo (cuándo pasó), estado (en qué etapa está), contenido específico (el porqué de este registro), y trazabilidad (quién/qué lo generó).
3. **Leer sistemas reales** (documentación pública de PSPs como Stripe) para ver cómo lo resolvieron otros, en vez de inventar de cero.

Y una tabla de tamaños de referencia para no adivinar bytes tampoco: UUID (como texto) ≈ 36 bytes, timestamp ≈ 8 bytes, booleano ≈ 1 byte, texto ≈ 2 bytes por carácter (regla de margen de seguridad, aunque ASCII puro es 1 byte/carácter).

## Segundo ejercicio completo: sistema de notificaciones

Practiqué toda la cadena (QPS → storage → bandwidth) de nuevo con un escenario distinto, esta vez separando explícitamente qué dato es de partida real del ejercicio y qué es un supuesto mío: el sistema de notificaciones del capstone genera 4,320,000 notificaciones/día (dato de partida), y yo propuse el tamaño de registro y el ratio lectura:escritura como supuestos.

Apliqué la técnica de "contar la historia" al requisito *"cada vez que el agente resuelve o actualiza un incidente, notificar al merchant afectado"*, y salieron estos campos: `notification_id`, `incident_id`, `merchant_id`, `trace_id`, `investigation_started_at`, `created_at`, `root_cause`, `confidence_level`, `review_status`.

En el camino hasta llegar a esa lista corregí dos errores reales de diseño (no de cuentas):
- Había mezclado campos de dos entidades distintas: `score_incidents_ids` (incidentes pasados similares) y `processor_id` describen la investigación interna del agente, no lo que se le manda al merchant. Van en la entidad de investigación, no en la notificación.
- `enabled` no tenía sentido en un registro de notificación (un evento que ya pasó no se "habilita/deshabilita"); era en realidad una preferencia de configuración del merchant, va en otra tabla.

## Storage internals: B-Tree vs LSM-Tree

Esto es sobre cómo un motor de base de datos organiza los datos en disco, y la elección depende directo del ratio lectura:escritura que ya venía calculando toda la semana.

**Analogía primero:** B-Tree es como una biblioteca con los libros ya ordenados en su lugar exacto, buscar (leer) es rápido, agregar un libro nuevo (escribir) es más lento porque hay que encontrarle el lugar exacto y a veces correr otros libros para hacerle espacio. LSM-Tree es como un escritorio donde apilás papeles nuevos arriba a medida que llegan (escribir es rapidísimo), y de vez en cuando ordenás las pilas en segundo plano; buscar algo (leer) es más lento porque hay que revisar pila por pila.

**B-Tree, la mecánica real:** datos en páginas de tamaño fijo (4 KB típico), árbol balanceado en disco. Leer sigue un solo camino de la raíz a la hoja, rápido. Escribir modifica la página exacta in-place, y si no entra, la divide (page split); usa un Write-Ahead Log (WAL) antes de tocar la página real, para no corromper datos si el sistema se cae a mitad de una escritura. Lo usan MySQL, PostgreSQL, Spanner.

**LSM-Tree, la mecánica real:** una Memtable en RAM más varios SSTables inmutables en disco. Escribir va al WAL y después directo a la Memtable, rapidísimo, nunca in-place. Cuando la Memtable se llena, se vuelca a disco como SSTable nuevo, y en segundo plano corre compactación fusionando SSTables viejos. Leer revisa primero la Memtable, después los SSTables del más nuevo al más viejo (puede implicar varios accesos a disco), usando Bloom filters para descartar rápido SSTables donde la clave seguro no está. Lo usan Cassandra, HBase, RocksDB.

**Aplicado a mi capstone:** para transacciones (579 QPS escritura vs 28,950 QPS lectura, lectura domina) elijo **B-Tree**. Para un log de auditoría (se escribe constantemente, casi nunca se relee, salvo una auditoría puntual) elijo **LSM-Tree**, el caso opuesto. El criterio en ambos casos es el mismo: qué domina, lectura o escritura, no el volumen total de datos.

Y la conclusión que más me gustó: no hace falta elegir un solo motor para todo el sistema. Esto se llama **polyglot persistence**, usar bases de datos distintas para partes distintas según su patrón de acceso: transacciones en PostgreSQL/RDS (B-Tree), log de auditoría en algo tipo Cassandra o DynamoDB (LSM-Tree).

## Fórmulas de la semana, todas juntas

- **QPS de escritura** = eventos totales en un período / segundos totales de ese período (un día = 86,400 segundos)
- **QPS de lectura** = QPS de escritura × ratio lectura:escritura
- **Storage** = cantidad total de registros × tamaño por registro (en bytes, sin dividir por segundos)
- **Bandwidth** = QPS × tamaño promedio de la respuesta (convertir bytes a bits ×8 para Mbps)
- **Atajo de redondeo:** un año ≈ 400 días (en vez de 365), para simplificar la aritmética mental
- **Test de decisión final:** "¿y entonces qué?", todo número debe llevar a una decisión de arquitectura concreta, no quedarse en el número solo

## En qué me confundí

- Clasifiqué mal el requisito de aislamiento entre tenants como funcional ("es lógica de negocio"), cuando es no funcional (seguridad). La razón "es lógica de negocio" es demasiado amplia para servir de criterio.
- Justificaba el requisito de "10,000 TPS en hora pico" en círculo, repitiendo el enunciado en vez de explicar por qué es no funcional.
- Pensé que el ratio de un ratio (ej. "50:2") tenía que reducirse siempre a "X:1"; en realidad ambas formas son válidas matemáticamente, solo que "X:1" es más cómoda para la fórmula que uso.
- Confundí el ratio (una proporción sin unidades) con un valor de QPS en sí mismo, como si el "1" del ratio fuera un QPS real.
- Calculé bien el número pero etiqueté mal la unidad: dije "1356 TB" cuando era **1356 GB** (que sí equivale a 1.36 TB, pero confundir GB con TB directo es un error de 1000x, mucho peor que una imprecisión de redondeo).
- Al elegir LSM-Tree para el log de auditoría, justifiqué "porque son muchísimos registros", pero el volumen no es el criterio, el ratio lectura:escritura sí lo es (las transacciones también tienen muchísimos registros y aun así eligen B-Tree).

## Qué sigue

Semana 5 completa: funcionales/no funcionales, estimación de capacidad (dos ejercicios), y storage internals. Sigue la Semana 6: Replicación (single-leader, multi-leader, leaderless).
