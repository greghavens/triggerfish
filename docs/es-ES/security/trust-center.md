---
title: Centro de confianza
description: Controles de seguridad, postura de cumplimiento y transparencia arquitectónica de Triggerfish.
---

# Centro de confianza

Triggerfish aplica la seguridad en código determinista por debajo de la capa del LLM -- no en prompts que el modelo pueda ignorar. Cada decisión de política la toma código que no puede ser influenciado por inyección de prompts, ingeniería social ni mal comportamiento del modelo. Consulte la página completa de [Diseño con seguridad como prioridad](/es-ES/security/) para la explicación técnica detallada.

## Controles de seguridad

Estos controles están activos en la versión actual. Cada uno se aplica en código, se prueba en CI y es auditable en el repositorio de código abierto.

| Control                                   | Estado                           | Descripción                                                                                                                                         |
| ----------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Aplicación de políticas sub-LLM           | <StatusBadge status="active" />  | Ocho hooks deterministas interceptan cada acción antes y después del procesamiento del LLM. El modelo no puede eludir, modificar ni influir en las decisiones de seguridad. |
| Sistema de clasificación de datos         | <StatusBadge status="active" />  | Jerarquía de cuatro niveles (PUBLIC, INTERNAL, CONFIDENTIAL, RESTRICTED) con aplicación obligatoria de escritura descendente.                       |
| Seguimiento de taint de sesión            | <StatusBadge status="active" />  | Cada sesión rastrea la clasificación más alta de datos accedidos. El taint solo escala, nunca disminuye.                                            |
| Registro de auditoría inmutable           | <StatusBadge status="active" />  | Todas las decisiones de política se registran con contexto completo. El registro de auditoría no puede ser desactivado por ningún componente del sistema. |
| Aislamiento de secretos                   | <StatusBadge status="active" />  | Las credenciales se almacenan en el llavero del SO o vault. Nunca en archivos de configuración, almacenamiento, registros ni contexto del LLM.      |
| Sandboxing de plugins                     | <StatusBadge status="active" />  | [Plugins](../integrations/plugins) |
| Escaneo de dependencias                   | <StatusBadge status="active" />  | Escaneo automatizado de vulnerabilidades vía GitHub Dependabot. Se abren PRs automáticamente para CVEs upstream.                                    |
| Base de código abierto                    | <StatusBadge status="active" />  | La arquitectura de seguridad completa tiene licencia Apache 2.0 y es públicamente auditable.                                                        |
| Despliegue en infraestructura propia      | <StatusBadge status="active" />  | Se ejecuta íntegramente en su infraestructura. Sin dependencia de la nube, sin telemetría, sin procesamiento externo de datos.                      |
| Cifrado                                   | <StatusBadge status="active" />  | TLS para todos los datos en tránsito. Cifrado a nivel de SO en reposo. Integración con vault empresarial disponible.                                |
| Programa de divulgación responsable       | <StatusBadge status="active" />  | Proceso documentado de notificación de vulnerabilidades con plazos de respuesta definidos. Consulte la [política de divulgación](/es-ES/security/responsible-disclosure). |
| Imagen de contenedor endurecida           | <StatusBadge status="planned" /> | Imágenes Docker sobre base Google Distroless con CVEs cercanas a cero. Escaneo automatizado con Trivy en CI.                                       |

## Defensa en profundidad -- 13 capas independientes

Ninguna capa es suficiente por sí sola. Si una capa se ve comprometida, las capas restantes continúan protegiendo el sistema.

| Capa | Nombre                             | Aplicación                                          |
| ---- | ---------------------------------- | --------------------------------------------------- |
| 01   | Autenticación de canal             | Identidad verificada por código en el establecimiento de sesión |
| 02   | Acceso a datos con permisos        | Permisos del sistema de origen, no credenciales del sistema |
| 03   | Seguimiento de taint de sesión     | Automático, obligatorio, solo escalada              |
| 04   | Linaje de datos                    | Cadena de procedencia completa para cada elemento de datos |
| 05   | Hooks de aplicación de políticas   | Deterministas, no eludibles, registrados            |
| 06   | MCP Gateway                        | Permisos por herramienta, clasificación de servidor |
| 07   | Sandbox de plugins                 | [Plugins](../integrations/plugins) |
| 08   | Aislamiento de secretos            | Llavero del SO o vault, por debajo de la capa del LLM |
| 09   | Sandbox de herramienta del sistema de archivos | Jaula de ruta, clasificación de ruta, E/S limitadas por taint |
| 10   | Identidad y delegación de agentes  | Cadenas de delegación criptográficas                |
| 11   | Registro de auditoría              | No se puede desactivar                              |
| 12   | Prevención de SSRF                 | Lista de denegación de IP + verificaciones de resolución DNS |
| 13   | Control de clasificación de memoria | Escribir a nivel propio, leer solo hacia abajo     |

Lea la documentación completa de la arquitectura de [Defensa en profundidad](/es-ES/architecture/defense-in-depth).

## Por qué importa la aplicación sub-LLM

::: info La mayoría de las plataformas de agentes de IA aplican la seguridad mediante prompts del sistema -- instrucciones al LLM que dicen "no compartas datos sensibles". Los ataques de inyección de prompt pueden anular estas instrucciones.

Triggerfish adopta un enfoque diferente: el LLM tiene **cero autoridad** sobre las decisiones de seguridad. Toda la aplicación ocurre en código determinista por debajo de la capa del LLM. No hay camino desde la salida del LLM hasta la configuración de seguridad. :::

## Hoja de ruta de cumplimiento

Triggerfish está en fase pre-certificación. Nuestra postura de seguridad es arquitectónica y verificable en el código fuente hoy. Las certificaciones formales están en la hoja de ruta.

| Certificación                  | Estado                           | Notas                                                                   |
| ------------------------------ | -------------------------------- | ----------------------------------------------------------------------- |
| SOC 2 Tipo I                   | <StatusBadge status="planned" /> | Criterios de servicios de confianza de Seguridad + Confidencialidad     |
| SOC 2 Tipo II                  | <StatusBadge status="planned" /> | Eficacia sostenida de controles durante período de observación          |
| HIPAA BAA                      | <StatusBadge status="planned" /> | Acuerdo de asociado comercial para clientes del sector sanitario        |
| ISO 27001                      | <StatusBadge status="planned" /> | Sistema de gestión de seguridad de la información                       |
| Test de penetración de terceros | <StatusBadge status="planned" /> | Evaluación de seguridad independiente                                   |
| Cumplimiento RGPD              | <StatusBadge status="planned" /> | Arquitectura autoalojada con retención y eliminación configurables      |

## Una nota sobre la confianza

::: tip El núcleo de seguridad es de código abierto bajo Apache 2.0. Puede leer cada línea de código de aplicación de políticas, ejecutar la suite de pruebas y verificar las afirmaciones usted mismo. Las certificaciones están en la hoja de ruta. :::

## Auditar el código fuente

La base de código completa de Triggerfish está disponible en
[github.com/greghavens/triggerfish](https://github.com/greghavens/triggerfish) --
licencia Apache 2.0.

## Notificación de vulnerabilidades

Si descubre una vulnerabilidad de seguridad, por favor infórmela a través de nuestra
[Política de divulgación responsable](/es-ES/security/responsible-disclosure). No abra issues públicos en GitHub para vulnerabilidades de seguridad.
