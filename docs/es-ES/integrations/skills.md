# Plataforma de Skills

Los skills son el mecanismo principal de extensibilidad de Triggerfish. Un skill
es una carpeta que contiene un fichero `SKILL.md` -- instrucciones y metadatos
que dan al agente nuevas capacidades sin necesidad de escribir un plugin ni
construir código personalizado.

Los skills son cómo el agente aprende a hacer cosas nuevas: consultar su
calendario, preparar informes matutinos, clasificar issues de GitHub, redactar
resúmenes semanales. Pueden instalarse desde un marketplace, escribirse a mano
o ser creados por el propio agente.

## ¿Qué es un skill?

Un skill es una carpeta con un fichero `SKILL.md` en su raíz. El fichero
contiene metadatos en formato YAML (frontmatter) y un cuerpo markdown
(instrucciones para el agente). Pueden existir ficheros opcionales de soporte --
scripts, plantillas, configuración -- junto a él.

```
morning-briefing/
  SKILL.md
  briefing.ts        # Código de soporte opcional
  template.md        # Plantilla opcional
```

El frontmatter del `SKILL.md` declara qué hace el skill, qué necesita y qué
restricciones de seguridad se aplican:

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

### Campos del frontmatter

| Campo                                         | Obligatorio | Descripción                                                                  |
| --------------------------------------------- | :---------: | ---------------------------------------------------------------------------- |
| `name`                                        |     Sí      | Identificador único del skill                                                |
| `description`                                 |     Sí      | Descripción legible de lo que hace el skill                                  |
| `version`                                     |     Sí      | Versión semántica                                                            |
| `category`                                    |     No      | Categoría de agrupación (productivity, development, communication, etc.)     |
| `tags`                                        |     No      | Etiquetas buscables para descubrimiento                                      |
| `triggers`                                    |     No      | Reglas de invocación automática (horarios cron, patrones de eventos)          |
| `metadata.triggerfish.classification_ceiling`  |     No      | Nivel máximo de contaminación que este skill puede alcanzar (por defecto: `PUBLIC`) |
| `metadata.triggerfish.requires_tools`          |     No      | Herramientas que el skill necesita (browser, exec, etc.)                     |
| `metadata.triggerfish.network_domains`         |     No      | Endpoints de red permitidos para el skill                                    |

## Tipos de skill

Triggerfish soporta tres tipos de skills, con un orden de prioridad claro cuando
los nombres entran en conflicto.

### Skills empaquetados

Se distribuyen con Triggerfish en el directorio `skills/bundled/`. Mantenidos por
el proyecto. Siempre disponibles.

Triggerfish incluye diez skills empaquetados que hacen al agente autosuficiente
desde el primer día:

| Skill                     | Descripción                                                                                                                                                          |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **tdd**                   | Metodología de desarrollo dirigido por pruebas para Deno 2.x. Ciclo rojo-verde-refactorizar, patrones `Deno.test()`, uso de `@std/assert`, pruebas de tipo Result.    |
| **mastering-typescript**  | Patrones TypeScript para Deno y Triggerfish. Modo estricto, `Result<T, E>`, tipos branded, funciones factoría, interfaces inmutables, barrels `mod.ts`.               |
| **skill-builder**         | Cómo crear nuevos skills. Formato SKILL.md, campos del frontmatter, techos de clasificación, flujo de autoría, escaneo de seguridad.                                 |
| **integration-builder**   | Cómo construir integraciones de Triggerfish. Los seis patrones: adaptadores de canal, proveedores LLM, servidores MCP, proveedores de almacenamiento, herramientas exec y plugins. |
| **git-branch-management** | Flujo de trabajo de ramas Git para desarrollo. Ramas de funcionalidad, commits atómicos, creación de PR vía `gh` CLI, seguimiento de PR, bucle de retroalimentación de revisión vía webhooks, merge y limpieza. |
| **deep-research**         | Metodología de investigación de varios pasos. Evaluación de fuentes, búsquedas paralelas, síntesis y formato de citas.                                               |
| **pdf**                   | Procesamiento de documentos PDF. Extracción de texto, resumen y extracción de datos estructurados de ficheros PDF.                                                    |
| **triggerfish**            | Autoconocimiento sobre los internos de Triggerfish. Arquitectura, configuración, solución de problemas y patrones de desarrollo.                                      |
| **triggers**              | Creación de comportamiento proactivo. Escritura efectiva de ficheros TRIGGER.md, patrones de monitorización y reglas de escalamiento.                                 |

Estos son los skills de arranque -- el agente los usa para extenderse a sí
mismo. El skill-builder enseña al agente cómo crear nuevos skills, y el
integration-builder le enseña cómo construir nuevos adaptadores y proveedores.

Consulte [Construir skills](/es-ES/integrations/building-skills) para una guía
práctica de creación de los suyos propios.

### Skills gestionados

Instalados desde **The Reef** (el marketplace comunitario de skills). Descargados
y almacenados en `~/.triggerfish/skills/`.

```bash
triggerfish skill install google-cal
triggerfish skill install github-triage
```

### Skills del espacio de trabajo

Creados por el usuario o creados por el agente en el
[entorno de ejecución](./exec-environment). Almacenados en el espacio de trabajo
del agente en `~/.triggerfish/workspace/<agent-id>/skills/`.

Los skills del espacio de trabajo tienen la prioridad más alta. Si crea un skill
con el mismo nombre que un skill empaquetado o gestionado, su versión tiene
precedencia.

```
Prioridad:  Espacio de trabajo  >  Gestionado  >  Empaquetado
```

::: tip Este orden de prioridad significa que siempre puede anular un skill
empaquetado o del marketplace con su propia versión. Sus personalizaciones nunca
se sobrescriben con actualizaciones. :::

## Descubrimiento y carga de skills

Cuando el agente se inicia o cuando los skills cambian, Triggerfish ejecuta un
proceso de descubrimiento de skills:

1. **Escáner** -- Encuentra todos los skills instalados en los directorios
   empaquetados, gestionados y del espacio de trabajo
2. **Cargador** -- Lee el frontmatter de SKILL.md y valida los metadatos
3. **Resolvedor** -- Resuelve conflictos de nombres usando el orden de prioridad
4. **Registro** -- Hace los skills disponibles para el agente con sus
   capacidades y restricciones declaradas

Los skills con `triggers` en su frontmatter se conectan automáticamente al
planificador. Los skills con `requires_tools` se comprueban contra las
herramientas disponibles del agente -- si una herramienta necesaria no está
disponible, el skill se marca pero no se bloquea.

## Autoría del agente

Un diferenciador clave: el agente puede escribir sus propios skills. Cuando se
le pide hacer algo que no sabe cómo hacer, el agente puede usar el
[entorno de ejecución](./exec-environment) para crear un `SKILL.md` y código de
soporte, luego empaquetarlo como un skill del espacio de trabajo.

### Flujo de autoría

```
1. Usted: "Necesito que compruebes mi Notion en busca de nuevas tareas cada mañana"
2. Agente: Crea el skill en ~/.triggerfish/workspace/<agent-id>/skills/notion-tasks/
          Escribe SKILL.md con metadatos e instrucciones
          Escribe código de soporte (notion-tasks.ts)
          Prueba el código en el entorno de ejecución
3. Agente: Marca el skill como PENDING_APPROVAL
4. Usted: Recibe una notificación: "Nuevo skill creado: notion-tasks. ¿Revisar y aprobar?"
5. Usted: Aprueba el skill
6. Agente: Conecta el skill a un cron job para ejecución diaria
```

::: warning SEGURIDAD Los skills creados por el agente siempre requieren
aprobación del propietario antes de activarse. El agente no puede autoaprobar
sus propios skills. Esto evita que el agente cree capacidades que eviten su
supervisión. :::

### Controles empresariales

En despliegues empresariales, se aplican controles adicionales a los skills
autocreados:

- Los skills creados por el agente siempre requieren aprobación del propietario
  o administrador
- Los skills no pueden declarar un techo de clasificación superior a la
  autorización del usuario
- Las declaraciones de endpoints de red se auditan
- Todos los skills autocreados se registran para revisión de cumplimiento

## The Reef <ComingSoon :inline="true" />

The Reef es el marketplace comunitario de skills de Triggerfish -- un registro
donde puede descubrir, instalar, publicar y compartir skills.

| Funcionalidad               | Descripción                                                    |
| --------------------------- | -------------------------------------------------------------- |
| Buscar y explorar           | Encontrar skills por categoría, etiqueta o popularidad         |
| Instalación con un comando  | `triggerfish skill install <nombre>`                           |
| Publicar                    | Compartir sus skills con la comunidad                          |
| Escaneo de seguridad        | Escaneo automático de patrones maliciosos antes de listar      |
| Versionado                  | Los skills se versionan con gestión de actualizaciones         |
| Reseñas y valoraciones      | Retroalimentación de la comunidad sobre la calidad del skill   |

### Comandos CLI

```bash
# Buscar skills
triggerfish skill search "calendar"

# Instalar un skill desde The Reef
triggerfish skill install google-cal

# Listar skills instalados
triggerfish skill list

# Actualizar todos los skills gestionados
triggerfish skill update --all

# Publicar un skill en The Reef
triggerfish skill publish

# Eliminar un skill
triggerfish skill remove google-cal
```

### Seguridad

Los skills instalados desde The Reef pasan por el mismo ciclo de vida que
cualquier otra integración:

1. Descargados al directorio de skills gestionados
2. Escaneados en busca de patrones maliciosos (inyección de código, acceso no
   autorizado a red, etc.)
3. Entran en estado `UNTRUSTED` hasta que usted los clasifique
4. Clasificados y activados por el propietario o administrador

::: info The Reef escanea todos los skills publicados en busca de patrones
maliciosos conocidos antes de listarlos. Sin embargo, debería revisar los skills
antes de clasificarlos, especialmente los que declaran acceso a red o requieren
herramientas potentes como `exec` o `browser`. :::

## Resumen de seguridad de skills

- Los skills declaran sus requisitos de seguridad por adelantado (techo de
  clasificación, herramientas, dominios de red)
- El acceso a herramientas está controlado por política -- un skill que
  `requires_tools: [browser]` no funcionará si el acceso al navegador está
  bloqueado por política
- Los dominios de red se aplican -- un skill no puede acceder a endpoints que no
  haya declarado
- Los skills creados por el agente requieren aprobación explícita del
  propietario/administrador
- Todas las invocaciones de skills pasan por hooks de política y se auditan
  completamente
