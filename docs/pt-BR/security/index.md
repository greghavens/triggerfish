# Diseño con seguridad primero

Triggerfish está construido sobre una premisa única: **el LLM tiene cero
autoridad**. Solicita acciones; la capa de políticas decide. Cada decisión de
seguridad la toma código determinístico que la IA no puede eludir, anular ni
influenciar.

Esta página explica por qué Triggerfish adopta este enfoque, en qué se
diferencia de las plataformas tradicionales de agentes de IA, y dónde encontrar
detalles sobre cada componente del modelo de seguridad.

## Por qué la seguridad debe estar por debajo del LLM

Los modelos de lenguaje grandes pueden ser víctimas de prompt injection. Una
entrada cuidadosamente diseñada — ya sea de un mensaje externo malicioso, un
documento envenenado o una respuesta de herramienta comprometida — puede hacer
que un LLM ignore sus instrucciones y realice acciones que se le dijo que no
hiciera. Esto no es un riesgo teórico. Es un problema bien documentado y no
resuelto en la industria de la IA.

Si su modelo de seguridad depende de que el LLM siga las reglas, una única
inyección exitosa puede eludir todas las salvaguardas que ha construido.

Triggerfish resuelve esto moviendo toda la aplicación de seguridad a una capa de
código que se sitúa **por debajo** del LLM. La IA nunca ve las decisiones de
seguridad. Nunca evalúa si una acción debería permitirse. Simplemente solicita
acciones, y la capa de aplicación de políticas — ejecutándose como código puro
y determinístico — decide si esas acciones proceden.

<img src="/diagrams/enforcement-layers.svg" alt="Capas de aplicación: el LLM tiene cero autoridad, la capa de políticas toma todas las decisiones de forma determinística, solo las acciones permitidas llegan a la ejecución" style="max-width: 100%;" />

::: warning SEGURIDAD La capa del LLM no tiene mecanismo para anular, omitir ni
influir en la capa de aplicación de políticas. No hay lógica de "parsear salida
del LLM en busca de comandos de elusión". La separación es arquitectónica, no
conductual. :::

## El invariante central

Cada decisión de diseño en Triggerfish fluye de un invariante:

> **La misma entrada siempre produce la misma decisión de seguridad. Sin
> aleatoriedad, sin llamadas al LLM, sin discreción.**

Esto significa que el comportamiento de seguridad es:

- **Auditable** — se puede reproducir cualquier decisión y obtener el mismo resultado
- **Verificable con tests** — el código determinístico puede cubrirse con tests automatizados
- **Verificable** — el motor de políticas es de código abierto (licencia Apache 2.0) y
  cualquiera puede inspeccionarlo

## Principios de seguridad

| Principio                  | Qué significa                                                                                                                                                  | Página de detalle                                                        |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **Clasificación de datos** | Todos los datos llevan un nivel de sensibilidad (RESTRICTED, CONFIDENTIAL, INTERNAL, PUBLIC). La clasificación la asigna el código cuando los datos ingresan al sistema. | [Arquitectura: Clasificación](/pt-BR/architecture/classification)       |
| **No write-down**          | Los datos solo pueden fluir a canales y destinatarios con un nivel de clasificación igual o superior. Los datos CONFIDENTIAL no pueden llegar a un canal PUBLIC. Sin excepciones. | [Regla de no write-down](/pt-BR/security/no-write-down)                 |
| **Taint de sesión**        | Cuando una sesión accede a datos con un nivel de clasificación, toda la sesión se contamina a ese nivel. El taint solo puede escalar, nunca disminuir.          | [Arquitectura: Taint](/pt-BR/architecture/taint-and-sessions)           |
| **Hooks determinísticos**  | Ocho hooks de aplicación se ejecutan en puntos críticos de cada flujo de datos. Cada hook es síncrono, registrado e infalsificable.                            | [Arquitectura: Motor de políticas](/pt-BR/architecture/policy-engine)   |
| **Identidad en código**    | La identidad del usuario se determina por código al establecer la sesión, no por el LLM interpretando el contenido del mensaje.                                | [Identidad y autenticación](/pt-BR/security/identity)                   |
| **Delegación de agentes**  | Las llamadas de agente a agente se gobiernan por certificados criptográficos, topes de clasificación y límites de profundidad.                                 | [Delegación de agentes](/pt-BR/security/agent-delegation)               |
| **Aislamiento de secretos** | Las credenciales se almacenan en llaveros del SO o vaults, nunca en archivos de configuración. Los plugins no pueden acceder a credenciales del sistema.       | [Gestión de secretos](/pt-BR/security/secrets)                          |
| **Auditar todo**           | Cada decisión de política se registra con contexto completo: marca de tiempo, tipo de hook, ID de sesión, entrada, resultado y reglas evaluadas.               | [Auditoría y cumplimiento](/pt-BR/security/audit-logging)               |

## Agentes de IA tradicionales vs. Triggerfish

La mayoría de las plataformas de agentes de IA dependen del LLM para aplicar la
seguridad. El prompt del sistema dice "no compartas datos sensibles", y se
confía en que el agente cumpla. Este enfoque tiene debilidades fundamentales.

| Aspecto                                | Agente de IA tradicional                       | Triggerfish                                                              |
| -------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------ |
| **Aplicación de seguridad**            | Instrucciones del prompt del sistema al LLM    | Código determinístico por debajo del LLM                                 |
| **Defensa contra prompt injection**    | Esperar que el LLM resista                     | El LLM no tiene autoridad desde el inicio                                |
| **Control de flujo de datos**          | El LLM decide qué es seguro compartir          | Etiquetas de clasificación + regla de no write-down en código            |
| **Verificación de identidad**          | El LLM interpreta "Soy el administrador"       | El código verifica identidad criptográfica del canal                     |
| **Pista de auditoría**                 | Registros de conversación del LLM              | Registros estructurados de decisiones de políticas con contexto completo |
| **Acceso a credenciales**              | Cuenta de servicio del sistema para todos       | Credenciales delegadas del usuario; se heredan los permisos del sistema fuente |
| **Capacidad de testing**              | Difusa — depende de la redacción del prompt    | Determinística — misma entrada, misma decisión, siempre                   |
| **Abierto a verificación**            | Generalmente propietario                        | Licencia Apache 2.0, completamente auditable                             |

::: tip Triggerfish no afirma que los LLM sean poco confiables. Afirma que los
LLM son la capa equivocada para la aplicación de seguridad. Un LLM bien
configurado seguirá sus instrucciones la mayor parte del tiempo. Pero "la mayor
parte del tiempo" no es una garantía de seguridad. Triggerfish proporciona una
garantía: la capa de políticas es código, y el código hace lo que se le dice,
siempre. :::

## Defensa en profundidad

Triggerfish implementa trece capas de defensa. Ninguna capa es suficiente por sí
sola; juntas, forman un perímetro de seguridad:

1. **Autenticación de canales** — identidad verificada por código al establecer la sesión
2. **Acceso a datos con permisos** — permisos del sistema fuente, no credenciales
   del sistema
3. **Seguimiento de taint de sesión** — automático, obligatorio, solo escalación
4. **Linaje de datos** — cadena completa de procedencia para cada elemento de datos
5. **Hooks de aplicación de políticas** — determinísticos, no eludibles, registrados
6. **MCP Gateway** — acceso seguro a herramientas externas con permisos por herramienta
7. **[Sandbox de plugins](../integrations/plugins)**
8. **Aislamiento de secretos** — llavero del SO o vault, nunca archivos de configuración
9. **Sandbox de herramientas del sistema de archivos** — jaula de rutas, clasificación de rutas,
   permisos de E/S a nivel de SO limitados por taint
10. **Identidad de agente** — cadenas de delegación criptográficas
11. **Registro de auditoría** — todas las decisiones registradas, sin excepciones
12. **Prevención de SSRF** — lista de denegación de IPs + verificaciones de resolución DNS
    en todo HTTP saliente
13. **Control de clasificación de memoria** — escrituras forzadas al taint de sesión,
    lecturas filtradas por `canFlowTo`

## Próximos pasos

| Página                                                                 | Descripción                                                                                      |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [Guía de clasificación](/pt-BR/guide/classification-guide)            | Guía práctica para elegir el nivel correcto para canales, servidores MCP e integraciones          |
| [Regla de no write-down](/pt-BR/security/no-write-down)               | La regla fundamental de flujo de datos y cómo se aplica                                          |
| [Identidad y autenticación](/pt-BR/security/identity)                 | Autenticación de canales y verificación de identidad del propietario                             |
| [Delegación de agentes](/pt-BR/security/agent-delegation)             | Identidad de agente a agente, certificados y cadenas de delegación                               |
| [Gestión de secretos](/pt-BR/security/secrets)                        | Cómo Triggerfish maneja las credenciales en todos los niveles                                     |
| [Auditoría y cumplimiento](/pt-BR/security/audit-logging)             | Estructura de la pista de auditoría, rastreo y exportaciones de cumplimiento                     |
