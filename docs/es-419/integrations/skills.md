# Plataforma de Skills

Los skills son el mecanismo principal de extensibilidad de Triggerfish. Un skill
es una carpeta que contiene un archivo `SKILL.md` -- instrucciones y metadatos
que le dan al agente nuevas capacidades sin necesidad de escribir un plugin o
construir código personalizado.

Los skills son la forma en que el agente aprende a hacer cosas nuevas: revisar
su calendario, preparar informes matutinos, hacer triaje de issues en GitHub,
redactar resúmenes semanales. Pueden instalarse desde un marketplace, escribirse
a mano o ser creados por el propio agente.

## ¿Qué es un Skill?

Un skill es una carpeta con un archivo `SKILL.md` en su raíz. El archivo
contiene frontmatter YAML (metadatos) y cuerpo en markdown (instrucciones para
el agente). Archivos de soporte opcionales -- scripts, plantillas, configuración
-- pueden estar junto a él.

```
morning-briefing/
  SKILL.md
  briefing.ts        # Código de soporte opcional
  template.md        # Plantilla opcional
```

El frontmatter de `SKILL.md` declara qué hace el skill, qué necesita y qué
restricciones de seguridad aplican:

```yaml
---
name: morning-briefing
description: Prepare a daily morning briefing with calendar, email, and weather
version: 1.0.0
category: productivity
tags:
  - calendar
  - email
  - daily
triggers:
  - cron: "0 7 * * *"
metadata:
  triggerfish:
    classification_ceiling: INTERNAL
    requires_tools:
      - browser
      - exec
    network_domains:
      - api.openweathermap.org
      - www.googleapis.com
---

## Instructions

When triggered (daily at 7 AM) or invoked by the user:

1. Fetch today's calendar events from Google Calendar
2. Summarize unread emails from the last 12 hours
3. Get the weather forecast for the user's location
4. Compile a concise briefing and deliver it to the configured channel

Format the briefing with sections for Calendar, Email, and Weather.
Keep it scannable -- bullet points, not paragraphs.
```

### Campos del Frontmatter

| Campo                                         | Requerido | Descripción                                                                 |
| --------------------------------------------- | :-------: | --------------------------------------------------------------------------- |
| `name`                                        |    Sí     | Identificador único del skill                                               |
| `description`                                 |    Sí     | Descripción legible de lo que hace el skill                                 |
| `version`                                     |    Sí     | Versión semántica                                                           |
| `category`                                    |    No     | Categoría de agrupación (productivity, development, communication, etc.)    |
| `tags`                                        |    No     | Etiquetas buscables para descubrimiento                                     |
| `triggers`                                    |    No     | Reglas de invocación automática (horarios cron, patrones de eventos)        |
| `metadata.triggerfish.classification_ceiling` |    No     | Nivel máximo de taint que este skill puede alcanzar (predeterminado: `PUBLIC`) |
| `metadata.triggerfish.requires_tools`         |    No     | Herramientas que el skill necesita (browser, exec, etc.)                    |
| `metadata.triggerfish.network_domains`        |    No     | Endpoints de red permitidos para el skill                                   |

## Tipos de Skills

Triggerfish soporta tres tipos de skills, con un orden de prioridad claro cuando
hay conflictos de nombres.

### Skills Incluidos

Se distribuyen con Triggerfish en el directorio `skills/bundled/`. Mantenidos
por el proyecto. Siempre disponibles.

Triggerfish incluye diez skills empaquetados que hacen al agente autosuficiente
desde el primer día:

| Skill                     | Descripción                                                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **tdd**                   | Metodología de Desarrollo Dirigido por Pruebas para Deno 2.x. Ciclo rojo-verde-refactor, patrones `Deno.test()`, uso de `@std/assert`, pruebas de tipo Result.    |
| **mastering-typescript**  | Patrones de TypeScript para Deno y Triggerfish. Modo estricto, `Result<T, E>`, tipos branding, funciones factory, interfaces inmutables, barrels `mod.ts`.         |
| **skill-builder**         | Cómo crear nuevos skills. Formato SKILL.md, campos de frontmatter, techos de clasificación, flujo de autoría, escaneo de seguridad.                               |
| **integration-builder**   | Cómo construir integraciones de Triggerfish. Los seis patrones: adaptadores de canal, proveedores LLM, servidores MCP, proveedores de almacenamiento, herramientas exec y plugins. |
| **git-branch-management** | Flujo de trabajo de ramas Git para desarrollo. Ramas de feature, commits atómicos, creación de PR vía `gh` CLI, seguimiento de PR, ciclo de retroalimentación de revisión vía webhooks. |
| **deep-research**         | Metodología de investigación de múltiples pasos. Evaluación de fuentes, búsquedas paralelas, síntesis y formato de citas.                                         |
| **pdf**                   | Procesamiento de documentos PDF. Extracción de texto, resumen y extracción de datos estructurados de archivos PDF.                                                 |
| **triggerfish**           | Autoconocimiento sobre los internos de Triggerfish. Arquitectura, configuración, solución de problemas y patrones de desarrollo.                                   |
| **triggers**              | Autoría de comportamiento proactivo. Escritura de archivos TRIGGER.md efectivos, patrones de monitoreo y reglas de escalación.                                     |

Estos son los skills de arranque -- el agente los usa para extenderse a sí
mismo. El skill-builder le enseña al agente cómo crear nuevos skills, y el
integration-builder le enseña cómo construir nuevos adaptadores y proveedores.

Consulten [Construir Skills](/es-419/integrations/building-skills) para una guía
práctica para crear los suyos.

### Skills Administrados

Instalados desde **The Reef** (el marketplace comunitario de skills).
Descargados y almacenados en `~/.triggerfish/skills/`.

```bash
triggerfish skill install google-cal
triggerfish skill install github-triage
```

### Skills del Workspace

Creados por el usuario o por el agente en el
[entorno de ejecución](./exec-environment). Almacenados en el workspace del
agente en `~/.triggerfish/workspace/<agent-id>/skills/`.

Los skills del workspace tienen la prioridad más alta. Si crean un skill con el
mismo nombre que un skill incluido o administrado, su versión tiene precedencia.

```
Prioridad:  Workspace  >  Administrado  >  Incluido
```

::: tip Este orden de prioridad significa que siempre pueden anular un skill
incluido o del marketplace con su propia versión. Sus personalizaciones nunca
son sobrescritas por actualizaciones. :::

## Descubrimiento y Carga de Skills

Cuando el agente inicia o cuando los skills cambian, Triggerfish ejecuta un
proceso de descubrimiento de skills:

1. **Escáner** -- Encuentra todos los skills instalados en los directorios de
   incluidos, administrados y workspace
2. **Cargador** -- Lee el frontmatter de SKILL.md y valida los metadatos
3. **Resolutor** -- Resuelve conflictos de nombres usando el orden de prioridad
4. **Registro** -- Hace los skills disponibles para el agente con sus
   capacidades y restricciones declaradas

Los skills con `triggers` en su frontmatter se conectan automáticamente al
programador. Los skills con `requires_tools` se verifican contra las herramientas
disponibles del agente -- si una herramienta requerida no está disponible, el
skill se marca pero no se bloquea.

## Autoría por el Agente

Un diferenciador clave: el agente puede escribir sus propios skills. Cuando se
le pide hacer algo que no sabe cómo hacer, el agente puede usar el
[entorno de ejecución](./exec-environment) para crear un `SKILL.md` y código de
soporte, luego empaquetarlo como un skill del workspace.

### Flujo de Autoría

```
1. Ustedes:  "Necesito que revises mi Notion buscando nuevas tareas cada mañana"
2. Agente:   Crea skill en ~/.triggerfish/workspace/<agent-id>/skills/notion-tasks/
             Escribe SKILL.md con metadatos e instrucciones
             Escribe código de soporte (notion-tasks.ts)
             Prueba el código en el entorno de ejecución
3. Agente:   Marca el skill como PENDING_APPROVAL
4. Ustedes:  Reciben notificación: "Nuevo skill creado: notion-tasks. ¿Revisar y aprobar?"
5. Ustedes:  Aprueban el skill
6. Agente:   Conecta el skill a un cron job para ejecución diaria
```

::: warning SEGURIDAD Los skills creados por el agente siempre requieren
aprobación del propietario antes de activarse. El agente no puede auto-aprobar
sus propios skills. Esto evita que el agente cree capacidades que evadan su
supervisión. :::

### Controles Empresariales

En despliegues empresariales, se aplican controles adicionales a los skills
creados por el agente:

- Los skills creados por el agente siempre requieren aprobación del propietario
  o administrador
- Los skills no pueden declarar un techo de clasificación superior a la
  autorización del usuario
- Las declaraciones de endpoints de red se auditan
- Todos los skills creados por el agente se registran para revisión de
  cumplimiento

## The Reef <ComingSoon :inline="true" />

The Reef es el marketplace comunitario de skills de Triggerfish -- un registro
donde pueden descubrir, instalar, publicar y compartir skills.

| Característica         | Descripción                                              |
| ---------------------- | -------------------------------------------------------- |
| Buscar y explorar      | Encuentren skills por categoría, etiqueta o popularidad  |
| Instalación con un comando | `triggerfish skill install <nombre>`                 |
| Publicar               | Compartan sus skills con la comunidad                    |
| Escaneo de seguridad   | Escaneo automatizado de patrones maliciosos antes de listar |
| Versionado             | Los skills se versionan con gestión de actualizaciones   |
| Reseñas y calificaciones | Retroalimentación comunitaria sobre calidad de skills  |

### Comandos CLI

```bash
# Buscar skills
triggerfish skill search "calendar"

# Instalar un skill desde The Reef
triggerfish skill install google-cal

# Listar skills instalados
triggerfish skill list

# Actualizar todos los skills administrados
triggerfish skill update --all

# Publicar un skill en The Reef
triggerfish skill publish

# Eliminar un skill
triggerfish skill remove google-cal
```

### Seguridad

Los skills instalados desde The Reef pasan por el mismo ciclo de vida que
cualquier otra integración:

1. Descargados al directorio de skills administrados
2. Escaneados en busca de patrones maliciosos (inyección de código, acceso de
   red no autorizado, etc.)
3. Entran en estado `UNTRUSTED` hasta que los clasifiquen
4. Clasificados y activados por el propietario o administrador

::: info The Reef escanea todos los skills publicados en busca de patrones
maliciosos conocidos antes de listarlos. Sin embargo, aún deben revisar los
skills antes de clasificarlos, especialmente skills que declaran acceso de red
o requieren herramientas poderosas como `exec` o `browser`. :::

## Resumen de Seguridad de Skills

- Los skills declaran sus requisitos de seguridad por adelantado (techo de
  clasificación, herramientas, dominios de red)
- El acceso a herramientas está controlado por política -- un skill que
  `requires_tools: [browser]` no funcionará si el acceso al navegador está
  bloqueado por política
- Los dominios de red se aplican -- un skill no puede acceder a endpoints que
  no declaró
- Los skills creados por el agente requieren aprobación explícita del
  propietario/administrador
- Todas las invocaciones de skills pasan por hooks de política y son
  completamente auditadas
