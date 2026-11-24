# Diseño con seguridad como prioridad

Triggerfish se construye sobre una única premisa: **el LLM tiene cero autoridad**. Solicita acciones; la capa de políticas decide. Cada decisión de seguridad la toma código determinista que la IA no puede eludir, anular ni influenciar.

Esta página explica por qué Triggerfish adopta este enfoque, cómo difiere de las plataformas tradicionales de agentes de IA, y dónde encontrar detalles sobre cada componente del modelo de seguridad.

## Por qué la seguridad debe estar por debajo del LLM

Los modelos de lenguaje grandes pueden ser inyectados con prompts. Una entrada cuidadosamente elaborada -- ya sea de un mensaje externo malicioso, un documento envenenado o una respuesta de herramienta comprometida -- puede hacer que un LLM ignore sus instrucciones y realice acciones que se le dijo que no hiciera. Este no es un riesgo teórico. Es un problema bien documentado y sin resolver en la industria de la IA.

Si su modelo de seguridad depende de que el LLM siga reglas, una única inyección exitosa puede eludir todas las salvaguardas que haya construido.

Triggerfish resuelve esto moviendo toda la aplicación de seguridad a una capa de código que se sitúa **por debajo** del LLM. La IA nunca ve las decisiones de seguridad. Nunca evalúa si una acción debe permitirse. Simplemente solicita acciones, y la capa de aplicación de políticas -- ejecutándose como código puro y determinista -- decide si esas acciones proceden.

<img src="/diagrams/enforcement-layers.svg" alt="Capas de aplicación: el LLM tiene cero autoridad, la capa de políticas toma todas las decisiones de forma determinista, solo las acciones permitidas alcanzan la ejecución" style="max-width: 100%;" />

::: warning SEGURIDAD La capa del LLM no tiene mecanismo para anular, omitir o influenciar la capa de aplicación de políticas. No hay lógica de "analizar la salida del LLM en busca de comandos de elusión". La separación es arquitectónica, no de comportamiento. :::

## El invariante fundamental

Cada decisión de diseño en Triggerfish fluye de un invariante:

> **La misma entrada siempre produce la misma decisión de seguridad. Sin aleatoriedad, sin llamadas al LLM, sin discreción.**

Esto significa que el comportamiento de seguridad es:

- **Auditable** -- puede reproducir cualquier decisión y obtener el mismo resultado
- **Testeable** -- el código determinista puede cubrirse con pruebas automatizadas
- **Verificable** -- el motor de políticas es de código abierto (licencia Apache 2.0) y cualquiera puede inspeccionarlo

## Principios de seguridad

| Principio                     | Significado                                                                                                                                           | Página de detalle                                                    |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **Clasificación de datos**    | Todos los datos llevan un nivel de sensibilidad (RESTRICTED, CONFIDENTIAL, INTERNAL, PUBLIC). La clasificación la asigna el código cuando los datos entran al sistema. | [Arquitectura: Clasificación](/es-ES/architecture/classification) |
| **Sin escritura descendente** | Los datos solo pueden fluir a canales y destinatarios con nivel de clasificación igual o superior. Los datos CONFIDENTIAL no pueden llegar a un canal PUBLIC. Sin excepciones. | [Regla de escritura descendente](./no-write-down)                |
| **Taint de sesión**           | Cuando una sesión accede a datos con un nivel de clasificación, toda la sesión queda contaminada a ese nivel. El taint solo puede escalar, nunca disminuir. | [Arquitectura: Taint](/es-ES/architecture/taint-and-sessions)    |
| **Hooks deterministas**       | Ocho hooks de aplicación se ejecutan en puntos críticos de cada flujo de datos. Cada hook es síncrono, registrado e infalsificable.                   | [Arquitectura: Motor de políticas](/es-ES/architecture/policy-engine) |
| **Identidad en código**       | La identidad del usuario se determina por código en el establecimiento de sesión, no por el LLM interpretando el contenido del mensaje.               | [Identidad y autenticación](./identity)                              |
| **Delegación de agentes**     | Las llamadas de agente a agente están gobernadas por certificados criptográficos, techos de clasificación y límites de profundidad.                    | [Delegación de agentes](./agent-delegation)                          |
| **Aislamiento de secretos**   | Las credenciales se almacenan en llaveros del SO o vaults, nunca en archivos de configuración. Los plugins no pueden acceder a credenciales del sistema. | [Gestión de secretos](./secrets)                                     |
| **Auditar todo**              | Cada decisión de política se registra con contexto completo: marca temporal, tipo de hook, ID de sesión, entrada, resultado y reglas evaluadas.       | [Auditoría y cumplimiento](./audit-logging)                          |

## Agentes de IA tradicionales vs. Triggerfish

La mayoría de las plataformas de agentes de IA dependen del LLM para aplicar la seguridad. El prompt del sistema dice "no compartas datos sensibles" y se confía en que el agente cumplirá. Este enfoque tiene debilidades fundamentales.

| Aspecto                              | Agente de IA tradicional                 | Triggerfish                                                        |
| ------------------------------------ | ---------------------------------------- | ------------------------------------------------------------------ |
| **Aplicación de seguridad**          | Instrucciones del prompt del sistema al LLM | Código determinista por debajo del LLM                           |
| **Defensa contra inyección de prompt** | Esperar que el LLM resista              | El LLM no tiene autoridad para empezar                            |
| **Control de flujo de datos**        | El LLM decide qué es seguro compartir   | Etiquetas de clasificación + regla de escritura descendente en código |
| **Verificación de identidad**        | El LLM interpreta "soy el administrador" | El código verifica identidad criptográfica del canal              |
| **Pista de auditoría**               | Registros de conversación del LLM        | Registros estructurados de decisiones de políticas con contexto completo |
| **Acceso a credenciales**            | Cuenta de servicio del sistema para todos | Credenciales delegadas del usuario; permisos del sistema de origen heredados |
| **Testeabilidad**                    | Difusa -- depende de la redacción del prompt | Determinista -- misma entrada, misma decisión, siempre          |
| **Abierto para verificación**        | Normalmente propietario                  | Licencia Apache 2.0, totalmente auditable                         |

::: tip Triggerfish no afirma que los LLM sean poco fiables. Afirma que los LLM son la capa equivocada para la aplicación de seguridad. Un LLM bien configurado seguirá sus instrucciones la mayor parte del tiempo. Pero "la mayor parte del tiempo" no es una garantía de seguridad. Triggerfish proporciona una garantía: la capa de políticas es código, y el código hace lo que se le dice, siempre. :::

## Defensa en profundidad

Triggerfish implementa trece capas de defensa. Ninguna capa es suficiente por sí sola; juntas, forman un perímetro de seguridad:

1. **Autenticación de canal** -- identidad verificada por código en el establecimiento de sesión
2. **Acceso a datos con permisos** -- permisos del sistema de origen, no credenciales del sistema
3. **Seguimiento de taint de sesión** -- automático, obligatorio, solo escalada
4. **Linaje de datos** -- cadena de procedencia completa para cada elemento de datos
5. **Hooks de aplicación de políticas** -- deterministas, no eludibles, registrados
6. **MCP Gateway** -- acceso seguro a herramientas externas con permisos por herramienta
7. **[Sandbox de plugins](../integrations/plugins)**
8. **Aislamiento de secretos** -- llavero del SO o vault, nunca archivos de configuración
9. **Sandbox de herramienta del sistema de archivos** -- jaula de ruta, clasificación de ruta, permisos de E/S limitados por taint a nivel de SO
10. **Identidad del agente** -- cadenas de delegación criptográficas
11. **Registro de auditoría** -- todas las decisiones registradas, sin excepciones
12. **Prevención de SSRF** -- lista de denegación de IP + verificaciones de resolución DNS en todo HTTP saliente
13. **Control de clasificación de memoria** -- escrituras forzadas al nivel de taint de sesión, lecturas filtradas por `canFlowTo`

## Siguientes pasos

| Página                                                      | Descripción                                                                            |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| [Guía de clasificación](/es-ES/guide/classification-guide)  | Guía práctica para elegir el nivel adecuado para canales, servidores MCP e integraciones |
| [Regla de escritura descendente](./no-write-down)           | La regla fundamental del flujo de datos y cómo se aplica                               |
| [Identidad y autenticación](./identity)                     | Autenticación de canal y verificación de identidad del propietario                     |
| [Delegación de agentes](./agent-delegation)                 | Identidad de agente a agente, certificados y cadenas de delegación                     |
| [Gestión de secretos](./secrets)                            | Cómo Triggerfish gestiona credenciales en los distintos niveles                         |
| [Auditoría y cumplimiento](./audit-logging)                 | Estructura de la pista de auditoría, trazado y exportaciones de cumplimiento           |
