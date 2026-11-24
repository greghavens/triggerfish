# Descripción general de la arquitectura

Triggerfish es una plataforma segura de agentes de IA multicanal con un único
invariante fundamental:

::: warning SEGURIDAD **La seguridad es determinística y está por debajo del LLM.** Cada
decisión de seguridad la toma código puro que el LLM no puede eludir, anular ni
influenciar. El LLM tiene cero autoridad — solicita acciones; la capa de
políticas decide. :::

Esta página ofrece una visión general de cómo funciona Triggerfish. Cada
componente principal enlaza a una página de detalle dedicada.

## Arquitectura del sistema

<img src="/diagrams/system-architecture.svg" alt="Arquitectura del sistema: los canales fluyen a través del Channel Router hacia el Gateway, que coordina el Session Manager, el Policy Engine y el Agent Loop" style="max-width: 100%;" />

### Flujo de datos

Cada mensaje sigue esta ruta a través del sistema:

<img src="/diagrams/data-flow-9-steps.svg" alt="Flujo de datos: pipeline de 9 pasos desde el mensaje entrante a través de hooks de políticas hasta la entrega de salida" style="max-width: 100%;" />

En cada punto de aplicación, la decisión es determinística — la misma entrada
siempre produce el mismo resultado. No hay llamadas al LLM dentro de los hooks,
no hay aleatoriedad ni forma de que el LLM influya en el resultado.

## Componentes principales

### Sistema de clasificación

Los datos fluyen a través de cuatro niveles ordenados:
`RESTRICTED > CONFIDENTIAL > INTERNAL > PUBLIC`. La regla fundamental es **no
write-down**: los datos solo pueden fluir a un nivel de clasificación igual o
superior. Una sesión `CONFIDENTIAL` no puede enviar datos a un canal `PUBLIC`.
Sin excepciones. Sin anulación por parte del LLM.

[Leer más sobre el sistema de clasificación.](/es-419/architecture/classification)

### Motor de políticas y hooks

Ocho hooks de aplicación determinística interceptan cada acción en puntos
críticos del flujo de datos. Los hooks son funciones puras: síncronas,
registradas e infalsificables. El motor de políticas soporta reglas fijas (nunca
configurables), reglas ajustables por administradores y válvulas de escape
declarativas en YAML para empresas.

[Leer más sobre el motor de políticas.](/es-419/architecture/policy-engine)

### Sesiones y taint

Cada conversación es una sesión con seguimiento de taint independiente. Cuando
una sesión accede a datos clasificados, su taint se escala a ese nivel y nunca
puede disminuir dentro de la sesión. Un reinicio completo elimina el taint Y el
historial de conversación. Cada elemento de datos lleva metadatos de procedencia
a través de un sistema de rastreo de linaje.

[Leer más sobre sesiones y taint.](/es-419/architecture/taint-and-sessions)

### Gateway

El Gateway es el plano de control central — un servicio local de larga ejecución
que gestiona sesiones, canales, herramientas, eventos y procesos de agentes a
través de un endpoint WebSocket JSON-RPC. Coordina el servicio de
notificaciones, el programador cron, la ingesta de webhooks y el enrutamiento de
canales.

[Leer más sobre el Gateway.](/es-419/architecture/gateway)

### Almacenamiento

Todos los datos con estado fluyen a través de una abstracción unificada
`StorageProvider`. Las claves con espacio de nombres (`sessions:`, `taint:`,
`lineage:`, `audit:`) mantienen las responsabilidades separadas al tiempo que
permiten intercambiar backends sin modificar la lógica de negocio. El valor
predeterminado es SQLite WAL en `~/.triggerfish/data/triggerfish.db`.

[Leer más sobre el almacenamiento.](/es-419/architecture/storage)

### Defensa en profundidad

La seguridad se implementa en capas a través de 13 mecanismos independientes,
desde la autenticación de canales y el acceso a datos con permisos, pasando por
el taint de sesión, hooks de políticas, sandboxing de plugins, sandboxing de herramientas del sistema de archivos,
hasta el registro de auditoría. Ninguna capa es suficiente por sí sola; juntas
forman una defensa que degrada de manera controlada incluso si una capa se ve
comprometida.

[Leer más sobre la defensa en profundidad.](/es-419/architecture/defense-in-depth)

## Principios de diseño

| Principio                          | Qué significa                                                                                                                      |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Aplicación determinística**      | Los hooks de políticas usan funciones puras. Sin llamadas al LLM, sin aleatoriedad. La misma entrada siempre produce la misma decisión. |
| **Propagación de taint**           | Todos los datos llevan metadatos de clasificación. El taint de sesión solo puede escalar, nunca disminuir.                         |
| **No write-down**                  | Los datos no pueden fluir a un nivel de clasificación inferior. Nunca.                                                             |
| **Auditar todo**                   | Todas las decisiones de políticas se registran con contexto completo: marca de tiempo, tipo de hook, ID de sesión, entrada, resultado, reglas evaluadas. |
| **Hooks infalsificables**          | El LLM no puede eludir, modificar ni influir en las decisiones de los hooks de políticas. Los hooks se ejecutan en código por debajo de la capa del LLM. |
| **Aislamiento de sesiones**        | Cada sesión rastrea el taint de forma independiente. Las sesiones en segundo plano inician con taint PUBLIC limpio. Los espacios de trabajo de los agentes están completamente aislados. |
| **Abstracción de almacenamiento**  | Ningún módulo crea su propio almacenamiento. Toda la persistencia fluye a través de `StorageProvider`.                             |

## Stack tecnológico

| Componente               | Tecnología                                                                |
| ------------------------ | ------------------------------------------------------------------------- |
| Runtime                  | Deno 2.x (TypeScript en modo estricto)                                    |
| Testing                  | Runner de tests integrado de Deno                                         |
| Canales                  | Baileys (WhatsApp), grammY (Telegram), Bolt (Slack), discord.js (Discord) |
| Automatización de browser | puppeteer-core (CDP)                                                     |
| Voz                      | Whisper (STT local), ElevenLabs/OpenAI (TTS)                              |
| Almacenamiento           | SQLite WAL (predeterminado), backends empresariales (Postgres, S3)        |
| Secretos                 | Llavero del SO (personal), integración con vault (empresarial)            |

::: info Triggerfish no requiere herramientas de compilación externas, ni Docker,
ni dependencia de la nube. Se ejecuta localmente, procesa los datos localmente y
le da al usuario soberanía total sobre sus datos. :::
