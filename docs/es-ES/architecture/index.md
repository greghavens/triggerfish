# Descripción general de la arquitectura

Triggerfish es una plataforma segura de agentes de IA multicanal con un único
invariante fundamental:

::: warning SEGURIDAD **La seguridad es determinista y sub-LLM.** Cada decisión
de seguridad la toma código puro que el LLM no puede eludir, anular ni
influenciar. El LLM tiene cero autoridad: solicita acciones; la capa de
políticas decide. :::

Esta página ofrece una visión general de cómo funciona Triggerfish. Cada
componente principal enlaza a una página dedicada con explicaciones detalladas.

## Arquitectura del sistema

<img src="/diagrams/system-architecture.svg" alt="Arquitectura del sistema: los canales fluyen a través del enrutador de canales hacia el Gateway, que coordina el gestor de sesiones, el motor de políticas y el bucle del agente" style="max-width: 100%;" />

### Flujo de datos

Cada mensaje sigue esta ruta a través del sistema:

<img src="/diagrams/data-flow-9-steps.svg" alt="Flujo de datos: pipeline de 9 pasos desde el mensaje entrante a través de los hooks de políticas hasta la entrega saliente" style="max-width: 100%;" />

En cada punto de aplicación, la decisión es determinista: la misma entrada
siempre produce el mismo resultado. No hay llamadas al LLM dentro de los hooks,
no hay aleatoriedad y no hay forma de que el LLM influya en el resultado.

## Componentes principales

### Sistema de clasificación

Los datos fluyen a través de cuatro niveles ordenados:
`RESTRICTED > CONFIDENTIAL > INTERNAL > PUBLIC`. La regla fundamental es la
**prohibición de escritura descendente** (no write-down): los datos solo pueden
fluir hacia un nivel de clasificación igual o superior. Una sesión
`CONFIDENTIAL` no puede enviar datos a un canal `PUBLIC`. Sin excepciones. Sin
anulación del LLM.

[Más información sobre el sistema de clasificación.](./classification)

### Motor de políticas y hooks

Ocho hooks de aplicación deterministas interceptan cada acción en puntos
críticos del flujo de datos. Los hooks son funciones puras: síncronas,
registradas e infalsificables. El motor de políticas admite reglas fijas (nunca
configurables), reglas ajustables por el administrador y cláusulas de escape
declarativas en YAML para empresas.

[Más información sobre el motor de políticas.](./policy-engine)

### Sesiones y taint

Cada conversación es una sesión con seguimiento de taint independiente. Cuando
una sesión accede a datos clasificados, su taint se eleva a ese nivel y nunca
puede disminuir dentro de la sesión. Un reinicio completo borra el taint Y el
historial de conversación. Cada elemento de datos lleva metadatos de procedencia
a través de un sistema de seguimiento de linaje.

[Más información sobre sesiones y taint.](./taint-and-sessions)

### Gateway

El Gateway es el plano de control central: un servicio local de larga ejecución
que gestiona sesiones, canales, herramientas, eventos y procesos de agentes a
través de un endpoint WebSocket JSON-RPC. Coordina el servicio de
notificaciones, el planificador cron, la ingesta de webhooks y el enrutamiento
de canales.

[Más información sobre el Gateway.](./gateway)

### Almacenamiento

Todos los datos con estado fluyen a través de una abstracción unificada
`StorageProvider`. Las claves con espacio de nombres (`sessions:`, `taint:`,
`lineage:`, `audit:`) mantienen las responsabilidades separadas mientras
permiten intercambiar backends sin tocar la lógica de negocio. El predeterminado
es SQLite WAL en `~/.triggerfish/data/triggerfish.db`.

[Más información sobre el almacenamiento.](./storage)

### Defensa en profundidad

La seguridad se distribuye en 13 mecanismos independientes, desde la
autenticación de canales y el acceso a datos con permisos, pasando por el taint
de sesión, hooks de políticas, sandboxing de plugins, sandboxing de herramientas
del sistema de archivos y registro de auditoría. Ninguna capa es suficiente por
sí sola; juntas forman una defensa que se degrada con elegancia incluso si una
capa se ve comprometida.

[Más información sobre la defensa en profundidad.](./defense-in-depth)

## Principios de diseño

| Principio                           | Significado                                                                                                                                        |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Aplicación determinista**         | Los hooks de políticas usan funciones puras. Sin llamadas al LLM, sin aleatoriedad. La misma entrada siempre produce la misma decisión.            |
| **Propagación de taint**            | Todos los datos llevan metadatos de clasificación. El taint de sesión solo puede escalar, nunca disminuir.                                         |
| **Sin escritura descendente**       | Los datos no pueden fluir a un nivel de clasificación inferior. Nunca.                                                                             |
| **Auditar todo**                    | Todas las decisiones de políticas se registran con contexto completo: marca temporal, tipo de hook, ID de sesión, entrada, resultado, reglas.       |
| **Los hooks son infalsificables**   | El LLM no puede eludir, modificar ni influenciar las decisiones de los hooks de políticas. Los hooks se ejecutan en código por debajo del LLM.     |
| **Aislamiento de sesiones**         | Cada sesión rastrea el taint de forma independiente. Las sesiones en segundo plano se inician con taint PUBLIC nuevo. Los workspaces están aislados.|
| **Abstracción de almacenamiento**   | Ningún módulo crea su propio almacenamiento. Toda la persistencia fluye a través de `StorageProvider`.                                             |

## Pila tecnológica

| Componente             | Tecnología                                                                       |
| ---------------------- | -------------------------------------------------------------------------------- |
| Entorno de ejecución   | Deno 2.x (TypeScript modo estricto)                                              |
| Pruebas                | Ejecutor de pruebas integrado de Deno                                            |
| Canales                | Baileys (WhatsApp), grammY (Telegram), Bolt (Slack), discord.js (Discord)        |
| Automatización web     | puppeteer-core (CDP)                                                             |
| Voz                    | Whisper (STT local), ElevenLabs/OpenAI (TTS)                                     |
| Almacenamiento         | SQLite WAL (predeterminado), backends empresariales (Postgres, S3)               |
| Secretos               | Llavero del SO (personal), integración con vault (empresa)                       |

::: info Triggerfish no requiere herramientas de compilación externas, ni Docker,
ni dependencia de la nube. Se ejecuta localmente, procesa datos localmente y
otorga al usuario soberanía total sobre sus datos. :::
