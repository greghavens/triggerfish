# Creación de integraciones

Triggerfish está diseñado para ser extensible. Ya sea que desee conectar una
nueva fuente de datos, automatizar un flujo de trabajo, dar nuevas habilidades a
su agente o reaccionar a eventos externos, existe una vía de integración bien
definida -- y todas las vías respetan el mismo modelo de seguridad.

## Vías de integración

Triggerfish ofrece cinco formas distintas de ampliar la plataforma. Cada una
sirve a un propósito diferente, pero todas comparten las mismas garantías de
seguridad: aplicación de clasificación, seguimiento de contaminación, hooks de
política y registro de auditoría completo.

| Vía                                                | Propósito                                              | Ideal para                                                                             |
| -------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| [MCP Gateway](./mcp-gateway)                       | Conectar servidores de herramientas externos            | Comunicación estandarizada agente-herramienta mediante el Model Context Protocol       |
| [Plugin SDK](./plugins)                            | Ejecutar código personalizado en sandbox                | Operaciones CRUD en sistemas externos, transformaciones de datos complejas, flujos     |
| [Entorno de ejecución](./exec-environment)         | El agente escribe y ejecuta su propio código            | Crear integraciones, prototipar, probar e iterar en un bucle de retroalimentación      |
| [Skills](./skills)                                 | Dar al agente nuevas capacidades mediante instrucciones | Comportamientos reutilizables, marketplace comunitario, autoría del agente             |
| [Automatización del navegador](./browser)          | Controlar una instancia del navegador mediante CDP      | Investigación web, rellenar formularios, scraping, flujos de trabajo web automatizados |
| [Webhooks](./webhooks)                             | Recibir eventos entrantes de servicios externos         | Reacciones en tiempo real a correos, alertas, eventos CI/CD, cambios de calendario     |
| [GitHub](./github)                                 | Integración completa del flujo de trabajo de GitHub     | Bucles de revisión de PR, triaje de issues, gestión de ramas vía webhooks + exec + skills |
| [Google Workspace](./google-workspace)             | Conectar Gmail, Calendar, Tasks, Drive, Sheets          | Integración OAuth2 empaquetada con 14 herramientas para Google Workspace               |
| [Obsidian](./obsidian)                             | Leer, escribir y buscar notas del vault de Obsidian     | Acceso a notas con clasificación, mapeo de carpetas, wikilinks, notas diarias          |

## Modelo de seguridad

Cada integración -- independientemente de la vía -- opera bajo las mismas
restricciones de seguridad.

### Todo comienza como UNTRUSTED

Los nuevos servidores MCP, plugins, canales y fuentes de webhook tienen todos
por defecto el estado `UNTRUSTED`. No pueden intercambiar datos con el agente
hasta que son clasificados explícitamente por el propietario (nivel personal) o
el administrador (nivel empresarial).

```
UNTRUSTED  -->  CLASSIFIED  (tras revisión, se le asigna un nivel de clasificación)
UNTRUSTED  -->  BLOCKED     (prohibido explícitamente)
```

### La clasificación fluye a través

Cuando una integración devuelve datos, esos datos llevan un nivel de
clasificación. Acceder a datos clasificados escala la contaminación de la sesión
para que coincida. Una vez contaminada, la sesión no puede enviar salida a un
destino de clasificación inferior. Esta es la
[regla de no escritura descendente](/es-ES/security/no-write-down) -- es fija y
no se puede anular.

### Los hooks de política aplican en cada frontera

Todas las acciones de integración pasan por hooks de política deterministas:

| Hook                    | Cuándo se activa                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------- |
| `PRE_CONTEXT_INJECTION` | Los datos externos entran en el contexto del agente (webhooks, respuestas de plugins)  |
| `PRE_TOOL_CALL`         | El agente solicita una llamada a herramienta (MCP, exec, navegador)                    |
| `POST_TOOL_RESPONSE`    | La herramienta devuelve datos (clasificar respuesta, actualizar contaminación)          |
| `PRE_OUTPUT`            | La respuesta sale del sistema (comprobación final de clasificación)                     |

Estos hooks son funciones puras -- sin llamadas LLM, sin aleatoriedad, sin
evasión. La misma entrada siempre produce la misma decisión.

### Registro de auditoría

Cada acción de integración se registra: qué se llamó, quién lo llamó, cuál fue
la decisión de política y cómo cambió la contaminación de la sesión. Este
registro de auditoría es inmutable y está disponible para revisión de
cumplimiento.

::: warning SEGURIDAD El LLM no puede evadir, modificar ni influir en las
decisiones de los hooks de política. Los hooks se ejecutan en código por debajo
de la capa del LLM. La IA solicita acciones -- la capa de política decide. :::

## Elegir la vía correcta

Utilice esta guía de decisión para elegir la vía de integración que se ajuste a
su caso de uso:

- **Desea conectar un servidor de herramientas estándar** -- Use el
  [MCP Gateway](./mcp-gateway). Si una herramienta habla MCP, este es el camino.
- **Necesita ejecutar código personalizado contra una API externa** -- Use el
  [Plugin SDK](./plugins).
- **Quiere que el agente construya e itere sobre código** -- Use el
  [Entorno de ejecución](./exec-environment). El agente obtiene un espacio de
  trabajo con un bucle completo de escritura/ejecución/corrección.
- **Quiere enseñar al agente un nuevo comportamiento** -- Use
  [Skills](./skills). Escriba un `SKILL.md` con instrucciones, o deje que el
  agente cree el suyo propio.
- **Necesita automatizar interacciones web** -- Use
  [Automatización del navegador](./browser). Chromium controlado por CDP con
  aplicación de políticas de dominio.
- **Necesita reaccionar a eventos externos en tiempo real** -- Use
  [Webhooks](./webhooks). Eventos entrantes verificados, clasificados y
  enrutados al agente.

::: tip Estas vías no son mutuamente excluyentes. Un skill puede utilizar
automatización del navegador internamente. Un plugin puede activarse mediante un
webhook. Una integración creada por el agente en el entorno de ejecución puede
persistirse como un skill. Se componen de forma natural. :::
