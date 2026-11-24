# Construir Integraciones

Triggerfish está diseñado para ser extendido. Ya sea que quieran conectar una
nueva fuente de datos, automatizar un flujo de trabajo, darle a su agente nuevas
habilidades o reaccionar a eventos externos, existe una vía de integración bien
definida -- y cada vía respeta el mismo modelo de seguridad.

## Vías de Integración

Triggerfish ofrece cinco formas distintas de extender la plataforma. Cada una
sirve un propósito diferente, pero todas comparten las mismas garantías de
seguridad: aplicación de clasificación, seguimiento de taint, hooks de política
y registro de auditoría completo.

| Vía                                                 | Propósito                                            | Ideal Para                                                                       |
| --------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------- |
| [MCP Gateway](./mcp-gateway)                        | Conectar servidores de herramientas externos          | Comunicación estandarizada agente-herramienta vía Model Context Protocol         |
| [Plugin SDK](./plugins)                             | Ejecutar código personalizado en sandbox              | Operaciones CRUD en sistemas externos, transformaciones de datos complejas       |
| [Entorno de Ejecución](./exec-environment)          | El agente escribe y ejecuta su propio código          | Construir integraciones, prototipar, probar e iterar en un ciclo de retroalimentación |
| [Skills](./skills)                                  | Dar al agente nuevas capacidades vía instrucciones    | Comportamientos reutilizables, marketplace comunitario, autoría del agente       |
| [Automatización de Navegador](./browser)            | Controlar una instancia de navegador vía CDP          | Investigación web, llenado de formularios, scraping, flujos web automatizados    |
| [Webhooks](./webhooks)                              | Recibir eventos entrantes de servicios externos       | Reacciones en tiempo real a correos, alertas, eventos CI/CD, cambios de calendario |
| [GitHub](./github)                                  | Integración completa de flujo de trabajo GitHub       | Ciclos de revisión de PR, triaje de issues, gestión de ramas vía webhooks + exec + skills |
| [Google Workspace](./google-workspace)              | Conectar Gmail, Calendar, Tasks, Drive, Sheets        | Integración OAuth2 empaquetada con 14 herramientas para Google Workspace         |
| [Obsidian](./obsidian)                              | Leer, escribir y buscar notas de bóvedas de Obsidian  | Acceso a notas con control de clasificación, mapeo de carpetas, wikilinks, notas diarias |

## Modelo de Seguridad

Cada integración -- sin importar la vía -- opera bajo las mismas restricciones
de seguridad.

### Todo Comienza como UNTRUSTED

Los nuevos servidores MCP, plugins, canales y fuentes de webhook tienen estado
`UNTRUSTED` por defecto. No pueden intercambiar datos con el agente hasta que
sean explícitamente clasificados por el propietario (nivel personal) o
administrador (nivel empresarial).

```
UNTRUSTED  -->  CLASSIFIED  (después de revisión, se asigna un nivel de clasificación)
UNTRUSTED  -->  BLOCKED     (prohibido explícitamente)
```

### La Clasificación Fluye

Cuando una integración devuelve datos, esos datos llevan un nivel de
clasificación. Acceder a datos clasificados escala el taint de la sesión para
que coincida. Una vez marcada, la sesión no puede enviar salida a un destino de
clasificación inferior. Esta es la
[regla de No Escritura Descendente](/es-419/security/no-write-down) -- es fija
y no puede ser anulada.

### Los Hooks de Política se Aplican en Cada Límite

Todas las acciones de integración pasan por hooks de política determinísticos:

| Hook                    | Cuándo se Dispara                                                             |
| ----------------------- | ----------------------------------------------------------------------------- |
| `PRE_CONTEXT_INJECTION` | Datos externos entran al contexto del agente (webhooks, respuestas de plugin) |
| `PRE_TOOL_CALL`         | El agente solicita una llamada a herramienta (MCP, exec, navegador)           |
| `POST_TOOL_RESPONSE`    | La herramienta devuelve datos (clasificar respuesta, actualizar taint)        |
| `PRE_OUTPUT`            | La respuesta sale del sistema (verificación final de clasificación)           |

Estos hooks son funciones puras -- sin llamadas al LLM, sin aleatoriedad, sin
evasión. La misma entrada siempre produce la misma decisión.

### Registro de Auditoría

Cada acción de integración se registra: qué se llamó, quién lo llamó, cuál fue
la decisión de política y cómo cambió el taint de la sesión. Este registro de
auditoría es inmutable y está disponible para revisión de cumplimiento.

::: warning SEGURIDAD El LLM no puede evadir, modificar ni influir en las
decisiones de los hooks de política. Los hooks se ejecutan en código por debajo
de la capa del LLM. La IA solicita acciones -- la capa de políticas decide. :::

## Elegir la Vía Correcta

Usen esta guía de decisión para elegir la vía de integración que se ajuste a su
caso de uso:

- **Quieren conectar un servidor de herramientas estándar** -- Usen el
  [MCP Gateway](./mcp-gateway). Si una herramienta habla MCP, esta es la vía.
- **Necesitan ejecutar código personalizado contra una API externa** -- Usen el
  [Plugin SDK](./plugins).
- **Quieren que el agente construya e itere sobre código** -- Usen el
  [Entorno de Ejecución](./exec-environment). El agente obtiene un espacio de
  trabajo con un ciclo completo de escribir/ejecutar/corregir.
- **Quieren enseñarle un nuevo comportamiento al agente** -- Usen
  [Skills](./skills). Escriban un `SKILL.md` con instrucciones, o dejen que el
  agente cree el suyo.
- **Necesitan automatizar interacciones web** -- Usen
  [Automatización de Navegador](./browser). Chromium controlado por CDP con
  aplicación de políticas de dominio.
- **Necesitan reaccionar a eventos externos en tiempo real** -- Usen
  [Webhooks](./webhooks). Eventos entrantes verificados, clasificados y
  enrutados al agente.

::: tip Estas vías no son mutuamente excluyentes. Un skill puede usar
automatización de navegador internamente. Un plugin puede ser activado por un
webhook. Una integración creada por el agente en el entorno de ejecución puede
persistirse como un skill. Se componen naturalmente. :::
