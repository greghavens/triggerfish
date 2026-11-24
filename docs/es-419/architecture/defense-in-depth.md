# Defensa en profundidad

Triggerfish implementa la seguridad como 13 capas independientes y superpuestas.
Ninguna capa es suficiente por sí sola. Juntas, forman una defensa que degrada
de manera controlada — incluso si una capa se ve comprometida, las capas
restantes continúan protegiendo el sistema.

::: warning SEGURIDAD Defensa en profundidad significa que una vulnerabilidad en
cualquier capa individual no compromete el sistema. Un atacante que elude la
autenticación de canales todavía enfrenta el seguimiento de taint de sesión, los
hooks de políticas y el registro de auditoría. Un LLM que recibe prompt
injection aún no puede influir en la capa de políticas determinística por debajo
de él. :::

## Las 13 capas

### Capa 1: Autenticación de canales

**Protege contra:** Suplantación de identidad, acceso no autorizado, confusión de identidad.

La identidad se determina por **código al establecer la sesión**, no por el LLM
interpretando el contenido del mensaje. Antes de que el LLM vea cualquier
mensaje, el adaptador de canal lo etiqueta con una etiqueta inmutable:

```
{ source: "owner" }    -- la identidad verificada del canal coincide con el propietario registrado
{ source: "external" } -- cualquier otro; solo entrada, no se trata como comando
```

Los métodos de autenticación varían según el canal:

| Canal                   | Método          | Verificación                                                                 |
| ----------------------- | --------------- | ---------------------------------------------------------------------------- |
| Telegram / WhatsApp     | Código de enlace | Código de un solo uso, expira en 5 minutos, enviado desde la cuenta del usuario |
| Slack / Discord / Teams | OAuth           | Flujo de consentimiento OAuth de la plataforma, devuelve ID de usuario verificado |
| CLI                     | Proceso local   | Se ejecuta en la máquina del usuario, autenticado por el SO                  |
| WebChat                 | Ninguno (público) | Todos los visitantes son `EXTERNAL`, nunca `owner`                        |
| Correo electrónico      | Coincidencia de dominio | El dominio del remitente se compara contra dominios internos configurados |

::: info El LLM nunca decide quién es el propietario. Un mensaje que dice "Soy
el propietario" de un remitente no verificado se etiqueta `{ source: "external" }`
y no puede activar comandos de nivel propietario. Esta decisión se toma en
código, antes de que el LLM procese el mensaje. :::

### Capa 2: Acceso a datos con permisos

**Protege contra:** Acceso excesivo a datos, escalación de privilegios a través
de credenciales del sistema.

Triggerfish usa los tokens OAuth delegados del usuario — no cuentas de servicio
del sistema — para consultar sistemas externos. El sistema de origen aplica su
propio modelo de permisos:

<img src="/diagrams/traditional-vs-triggerfish.svg" alt="Tradicional vs Triggerfish: el modelo tradicional le da al LLM control directo, Triggerfish enruta todas las acciones a través de una capa de políticas determinística" style="max-width: 100%;" />

El SDK de plugins aplica esto a nivel de API:

| Método del SDK                          | Comportamiento                                    |
| --------------------------------------- | ------------------------------------------------- |
| `sdk.get_user_credential(integration)`  | Devuelve el token OAuth delegado del usuario      |
| `sdk.query_as_user(integration, query)` | Ejecuta con los permisos del usuario              |
| `sdk.get_system_credential(name)`       | **BLOQUEADO** — lanza `PermissionError`           |

### Capa 3: Seguimiento de taint de sesión

**Protege contra:** Filtración de datos por contaminación de contexto, datos
clasificados llegando a canales de menor clasificación.

Cada sesión rastrea de forma independiente un nivel de taint que refleja la mayor
clasificación de datos accedidos durante la sesión. El taint sigue tres
invariantes:

1. **Por conversación** — cada sesión tiene su propio taint
2. **Solo escalación** — el taint aumenta, nunca disminuye
3. **El reinicio completo limpia todo** — el taint Y el historial se borran juntos

Cuando el motor de políticas evalúa una salida, compara el taint de la sesión
contra la clasificación efectiva del canal de destino. Si el taint excede el
destino, la salida se bloquea.

### Capa 4: Linaje de datos

**Protege contra:** Flujos de datos imposibles de rastrear, incapacidad de
auditar hacia dónde fueron los datos, brechas de cumplimiento.

Cada elemento de datos lleva metadatos de procedencia desde el origen hasta el
destino:

- **Origen**: Qué integración, registro y acceso de usuario produjo estos datos
- **Clasificación**: Qué nivel se asignó y por qué
- **Transformaciones**: Cómo el LLM modificó, resumió o combinó los datos
- **Destino**: Qué sesión y canal recibió la salida

El linaje permite rastreos hacia adelante ("¿a dónde fue este registro de
Salesforce?"), rastreos hacia atrás ("¿qué fuentes contribuyeron a esta
salida?") y exportaciones completas de cumplimiento.

### Capa 5: Hooks de aplicación de políticas

**Protege contra:** Ataques de prompt injection, elusión de seguridad dirigida
por el LLM, ejecución descontrolada de herramientas.

Ocho hooks determinísticos interceptan cada acción en puntos críticos del flujo
de datos:

| Hook                    | Qué intercepta                                     |
| ----------------------- | --------------------------------------------------- |
| `PRE_CONTEXT_INJECTION` | Entrada externa ingresando a la ventana de contexto |
| `PRE_TOOL_CALL`         | LLM solicitando ejecución de herramienta            |
| `POST_TOOL_RESPONSE`    | Datos retornando de la ejecución de herramienta     |
| `PRE_OUTPUT`            | Respuesta a punto de salir del sistema              |
| `SECRET_ACCESS`         | Solicitud de acceso a credenciales                  |
| `SESSION_RESET`         | Solicitud de reinicio de taint                      |
| `AGENT_INVOCATION`      | Llamada de agente a agente                          |
| `MCP_TOOL_CALL`         | Invocación de herramienta de servidor MCP           |

Los hooks son código puro: determinísticos, síncronos, registrados e
infalsificables. El LLM no puede eludirlos porque no hay ruta desde la salida
del LLM a la configuración de hooks. La capa de hooks no parsea la salida del
LLM en busca de comandos.

### Capa 6: MCP Gateway

**Protege contra:** Acceso descontrolado a herramientas externas, datos sin
clasificar entrando a través de servidores MCP, violaciones de esquema.

Todos los servidores MCP tienen como predeterminado `UNTRUSTED` y no pueden ser
invocados hasta que un administrador o usuario los clasifique. El Gateway aplica:

- Autenticación del servidor y estado de clasificación
- Permisos a nivel de herramienta (herramientas individuales pueden bloquearse
  aunque el servidor esté permitido)
- Validación de esquema de solicitud/respuesta
- Seguimiento de taint en todas las respuestas MCP
- Escaneo de patrones de inyección en parámetros

<img src="/diagrams/mcp-server-states.svg" alt="Estados del servidor MCP: UNTRUSTED (predeterminado), CLASSIFIED (revisado y permitido), BLOCKED (explícitamente prohibido)" style="max-width: 100%;" />

### Capa 7: Sandbox de plugins

Habilita un plugin de TypeScript en la configuración del usuario con `enabled: true`. Por defecto, la importación y la ejecución ocurren en workers restringidos de Deno. Pueden leer el directorio del plugin y conectarse únicamente a los hosts y puertos de `declaredEndpoints`. No pueden escribir archivos, leer el entorno del proceso, iniciar subprocesos, usar FFI ni acceder a información restringida del sistema. Configurar `trust: trusted` permite importar el módulo en el proceso de Triggerfish. El ejecutor se ejecuta allí si el manifiesto también declara `trusted`.

[Guía completa de plugins](../integrations/plugins)

### Capa 8: Aislamiento de secretos

**Protege contra:** Robo de credenciales, secretos en archivos de configuración,
almacenamiento de credenciales en texto plano.

Las credenciales se almacenan en el llavero del SO (nivel personal) o
integración con vault (nivel empresarial). Nunca aparecen en:

- Archivos de configuración
- Valores del `StorageProvider`
- Entradas de registro
- Contexto del LLM (las credenciales se inyectan en la capa HTTP, por debajo del
  LLM)

El hook `SECRET_ACCESS` registra cada acceso a credenciales con el plugin
solicitante, el alcance de la credencial y la decisión.

### Capa 9: Sandbox de herramientas del sistema de archivos

**Protege contra:** Ataques de path traversal, acceso no autorizado a archivos,
elusión de clasificación vía operaciones directas del sistema de archivos.

Todas las operaciones de herramientas del sistema de archivos (leer, escribir,
editar, listar, buscar) se ejecutan dentro de un Worker de Deno en sandbox con
permisos a nivel de SO limitados al subdirectorio del espacio de trabajo
apropiado para el taint de la sesión. El sandbox aplica tres límites:

- **Jaula de rutas** — cada ruta se resuelve a una ruta absoluta y se verifica
  contra la raíz de la jaula con coincidencia consciente del separador. Los
  intentos de traversal (`../`) que escapan del espacio de trabajo se rechazan
  antes de que ocurra cualquier E/S
- **Clasificación de rutas** — cada ruta del sistema de archivos se clasifica a
  través de una cadena de resolución fija: rutas protegidas codificadas
  (RESTRICTED), directorios de clasificación del espacio de trabajo, mapeos de
  rutas configurados, luego clasificación predeterminada. El agente no puede
  acceder a rutas por encima de su taint de sesión
- **Permisos limitados por taint** — los permisos de Deno del Worker del sandbox
  se establecen al subdirectorio del espacio de trabajo que corresponde al nivel
  de taint actual de la sesión. Cuando el taint escala, el Worker se reinicia
  con permisos expandidos. Los permisos solo pueden ampliarse, nunca reducirse
  dentro de una sesión
- **Protección contra escritura** — archivos críticos (`TRIGGER.md`,
  `triggerfish.yaml`, `SPINE.md`) están protegidos contra escritura en la capa
  de herramientas independientemente de los permisos del sandbox. Estos archivos
  solo pueden modificarse a través de herramientas de gestión dedicadas que
  aplican sus propias reglas de clasificación

### Capa 10: Identidad de agente

**Protege contra:** Escalación de privilegios a través de cadenas de agentes,
lavado de datos vía delegación.

Cuando los agentes invocan a otros agentes, las cadenas de delegación
criptográficas previenen la escalación de privilegios:

- Cada agente tiene un certificado que especifica sus capacidades y tope de
  clasificación
- El agente llamado hereda `max(propio taint, taint del llamador)` — el taint
  solo puede aumentar a través de las cadenas
- Un llamador con taint que excede el tope del agente llamado es bloqueado
- Las invocaciones circulares se detectan y rechazan
- La profundidad de delegación es limitada y se aplica

<img src="/diagrams/data-laundering-defense.svg" alt="Defensa contra lavado de datos: la ruta de ataque se bloquea en la verificación de tope y la herencia de taint previene la salida a canales de menor clasificación" style="max-width: 100%;" />

### Capa 11: Registro de auditoría

**Protege contra:** Brechas indetectables, fallos de cumplimiento, incapacidad
de investigar incidentes.

Cada decisión relevante de seguridad se registra con contexto completo:

```json
{
  "timestamp": "2025-01-29T10:23:45Z",
  "user_id": "user_123",
  "session_id": "sess_456",
  "action": "slack.postMessage",
  "target_channel": "external_webhook",
  "session_taint": "CONFIDENTIAL",
  "target_classification": "PUBLIC",
  "decision": "DENIED",
  "reason": "classification_violation",
  "hook": "PRE_OUTPUT",
  "policy_rules_evaluated": ["rule_001", "rule_002"],
  "lineage_ids": ["lin_789", "lin_790"]
}
```

Qué se registra:

- Todas las solicitudes de acción (permitidas Y denegadas)
- Decisiones de clasificación
- Cambios en el taint de sesión
- Eventos de autenticación de canales
- Evaluaciones de reglas de políticas
- Creación y actualización de registros de linaje
- Decisiones del MCP Gateway
- Invocaciones de agente a agente

::: info El registro de auditoría no puede deshabilitarse. Es una regla fija en
la jerarquía de políticas. Incluso un administrador de organización no puede
desactivar el registro para sus propias acciones. Los despliegues empresariales
pueden opcionalmente habilitar el registro completo de contenido (incluyendo el
contenido de mensajes bloqueados) para requisitos forenses. :::

### Capa 12: Prevención de SSRF

**Protege contra:** Server-side request forgery, reconocimiento de red interna,
exfiltración de metadatos de nube.

Todas las solicitudes HTTP salientes (desde `web_fetch`, `browser.navigate` y
acceso de red de plugins) resuelven DNS primero y verifican la IP resuelta
contra una lista de denegación codificada de rangos privados y reservados. Esto
previene que un atacante engañe al agente para que acceda a servicios internos
vía URLs manipuladas.

- Los rangos privados (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`) siempre
  se bloquean
- Los endpoints link-local (`169.254.0.0/16`) y de metadatos de nube se bloquean
- Loopback (`127.0.0.0/8`) se bloquea
- La lista de denegación está codificada y no es configurable — no hay
  anulación de administrador
- La resolución DNS ocurre antes de la solicitud, previniendo ataques de DNS
  rebinding

### Capa 13: Control de clasificación de memoria

**Protege contra:** Filtración de datos entre sesiones a través de la memoria,
degradación de clasificación vía escrituras en memoria, acceso no autorizado a
memorias clasificadas.

El sistema de memoria entre sesiones aplica clasificación tanto en escritura como
en lectura:

- **Escrituras**: Las entradas de memoria se fuerzan al nivel de taint de la
  sesión actual. El LLM no puede elegir una clasificación inferior para las
  memorias almacenadas.
- **Lecturas**: Las consultas de memoria se filtran por `canFlowTo` — una sesión
  solo puede leer memorias en o por debajo de su nivel de taint actual.

Esto previene que un agente almacene datos CONFIDENTIAL como PUBLIC en memoria y
luego los recupere en una sesión con menor taint para eludir la regla de no
write-down.

## Jerarquía de confianza

El modelo de confianza define quién tiene autoridad sobre qué. Los niveles
superiores no pueden eludir las reglas de seguridad de niveles inferiores, pero
pueden configurar los parámetros ajustables dentro de esas reglas.

<img src="/diagrams/trust-hierarchy.svg" alt="Jerarquía de confianza: proveedor Triggerfish (cero acceso), Administrador de la organización (establece políticas), Empleado (usa el agente dentro de los límites)" style="max-width: 100%;" />

::: tip **Nivel personal:** El usuario ES el administrador de la organización.
Soberanía total. Sin visibilidad de Triggerfish. El proveedor tiene cero acceso
a los datos del usuario por defecto y solo puede obtener acceso a través de una
concesión explícita, acotada en el tiempo y registrada por parte del usuario. :::

## Cómo las capas trabajan juntas

Considere un ataque de prompt injection donde un mensaje malicioso intenta
exfiltrar datos:

| Paso | Capa                          | Acción                                                          |
| ---- | ----------------------------- | --------------------------------------------------------------- |
| 1    | Autenticación de canal        | Mensaje etiquetado `{ source: "external" }` — no es propietario |
| 2    | PRE_CONTEXT_INJECTION         | Entrada escaneada por patrones de inyección, clasificada        |
| 3    | Taint de sesión               | Taint de sesión sin cambios (no se accedieron datos clasificados) |
| 4    | LLM procesa el mensaje        | El LLM puede ser manipulado para solicitar una llamada a herramienta |
| 5    | PRE_TOOL_CALL                 | Verificación de permisos de herramienta contra reglas de fuente externa |
| 6    | POST_TOOL_RESPONSE            | Cualquier dato devuelto se clasifica, taint actualizado         |
| 7    | PRE_OUTPUT                    | Clasificación de salida vs. destino verificada                  |
| 8    | Registro de auditoría         | Toda la secuencia registrada para revisión                      |

Incluso si el LLM está completamente comprometido en el paso 4 y solicita una
llamada a herramienta de exfiltración de datos, las capas restantes (verificaciones
de permisos, seguimiento de taint, clasificación de salida, registro de
auditoría) continúan aplicando las políticas. Ningún punto único de fallo
compromete el sistema.
