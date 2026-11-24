# Defensa en profundidad

Triggerfish implementa la seguridad como 13 capas independientes y
superpuestas. Ninguna capa es suficiente por sí sola. Juntas, forman una defensa
que se degrada con elegancia: incluso si una capa se ve comprometida, las
restantes continúan protegiendo el sistema.

::: warning SEGURIDAD La defensa en profundidad significa que una vulnerabilidad
en cualquier capa individual no compromete el sistema. Un atacante que elude la
autenticación del canal aún se enfrenta al seguimiento de taint de sesión, los
hooks de políticas y el registro de auditoría. Un LLM que recibe una inyección
de prompt aún no puede influir en la capa de políticas determinista por debajo
de él. :::

## Las 13 capas

### Capa 1: Autenticación de canal

**Protege contra:** Suplantación de identidad, acceso no autorizado, confusión
de identidad.

La identidad se determina por **código en el establecimiento de la sesión**, no
por el LLM interpretando el contenido del mensaje. Antes de que el LLM vea
cualquier mensaje, el adaptador de canal lo etiqueta con una marca inmutable:

```
{ source: "owner" }    -- la identidad verificada del canal coincide con el propietario registrado
{ source: "external" } -- cualquier otro; solo entrada, no se trata como comando
```

Los métodos de autenticación varían según el canal:

| Canal                   | Método          | Verificación                                                     |
| ----------------------- | --------------- | ---------------------------------------------------------------- |
| Telegram / WhatsApp     | Código de emparejamiento | Código único, caducidad de 5 minutos, enviado desde la cuenta del usuario |
| Slack / Discord / Teams | OAuth           | Flujo de consentimiento OAuth de la plataforma, devuelve ID de usuario verificado |
| CLI                     | Proceso local   | Se ejecuta en el ordenador del usuario, autenticado por el SO     |
| WebChat                 | Ninguno (público) | Todos los visitantes son `EXTERNAL`, nunca `owner`               |
| Correo electrónico      | Coincidencia de dominio | Dominio del remitente comparado con los dominios internos configurados |

::: info El LLM nunca decide quién es el propietario. Un mensaje que diga "soy
el propietario" de un remitente no verificado se etiqueta como
`{ source: "external" }` y no puede activar comandos de nivel propietario. Esta
decisión se toma en código, antes de que el LLM procese el mensaje. :::

### Capa 2: Acceso a datos con permisos

**Protege contra:** Acceso a datos con permisos excesivos, escalada de
privilegios a través de credenciales del sistema.

Triggerfish utiliza los tokens OAuth delegados del usuario, no cuentas de
servicio del sistema, para consultar sistemas externos. El sistema de origen
aplica su propio modelo de permisos:

<img src="/diagrams/traditional-vs-triggerfish.svg" alt="Tradicional vs Triggerfish: el modelo tradicional da al LLM control directo, Triggerfish enruta todas las acciones a través de una capa de políticas determinista" style="max-width: 100%;" />

El SDK de plugins aplica esto a nivel de API:

| Método del SDK                          | Comportamiento                           |
| --------------------------------------- | ---------------------------------------- |
| `sdk.get_user_credential(integration)`  | Devuelve el token OAuth delegado del usuario |
| `sdk.query_as_user(integration, query)` | Ejecuta con los permisos del usuario     |
| `sdk.get_system_credential(name)`       | **BLOQUEADO** -- genera `PermissionError` |

### Capa 3: Seguimiento de taint de sesión

**Protege contra:** Filtración de datos por contaminación de contexto, datos
clasificados que llegan a canales de clasificación inferior.

Cada sesión rastrea de forma independiente un nivel de taint que refleja la
clasificación más alta de los datos accedidos durante la sesión. El taint sigue
tres invariantes:

1. **Por conversación** -- cada sesión tiene su propio taint
2. **Solo escalada** -- el taint aumenta, nunca disminuye
3. **El reinicio completo lo borra todo** -- el taint Y el historial se borran juntos

Cuando el motor de políticas evalúa una salida, compara el taint de la sesión
con la clasificación efectiva del canal destino. Si el taint excede el destino,
la salida se bloquea.

### Capa 4: Linaje de datos

**Protege contra:** Flujos de datos imposibles de rastrear, incapacidad de
auditar a dónde fueron los datos, brechas de cumplimiento.

Cada elemento de datos lleva metadatos de procedencia desde el origen hasta el
destino:

- **Origen**: Qué integración, registro y acceso de usuario produjeron estos datos
- **Clasificación**: Qué nivel se asignó y por qué
- **Transformaciones**: Cómo el LLM modificó, resumió o combinó los datos
- **Destino**: Qué sesión y canal recibieron la salida

El linaje permite trazas hacia adelante ("¿a dónde fue este registro de
Salesforce?"), trazas hacia atrás ("¿qué fuentes contribuyeron a esta salida?")
y exportaciones completas de cumplimiento.

### Capa 5: Hooks de aplicación de políticas

**Protege contra:** Ataques de inyección de prompt, elusiones de seguridad
impulsadas por el LLM, ejecución de herramientas sin control.

Ocho hooks deterministas interceptan cada acción en puntos críticos del flujo de
datos:

| Hook                    | Qué intercepta                              |
| ----------------------- | ------------------------------------------- |
| `PRE_CONTEXT_INJECTION` | Entrada externa que entra en la ventana de contexto |
| `PRE_TOOL_CALL`         | LLM solicitando ejecución de herramienta    |
| `POST_TOOL_RESPONSE`    | Datos que regresan de la ejecución de herramienta |
| `PRE_OUTPUT`            | Respuesta a punto de salir del sistema      |
| `SECRET_ACCESS`         | Solicitud de acceso a credenciales          |
| `SESSION_RESET`         | Solicitud de reinicio de taint              |
| `AGENT_INVOCATION`      | Llamada de agente a agente                  |
| `MCP_TOOL_CALL`         | Invocación de herramienta de servidor MCP   |

Los hooks son código puro: deterministas, síncronos, registrados e
infalsificables. El LLM no puede eludirlos porque no hay camino desde la salida
del LLM hasta la configuración de los hooks. La capa de hooks no analiza la
salida del LLM en busca de comandos.

### Capa 6: MCP Gateway

**Protege contra:** Acceso a herramientas externas sin control, datos no
clasificados que entran a través de servidores MCP, violaciones de esquema.

Todos los servidores MCP se clasifican por defecto como `UNTRUSTED` y no se
pueden invocar hasta que un administrador o usuario los clasifique. El Gateway
aplica:

- Estado de autenticación y clasificación del servidor
- Permisos a nivel de herramienta (herramientas individuales se pueden bloquear
  incluso si el servidor está permitido)
- Validación de esquema de solicitud/respuesta
- Seguimiento de taint en todas las respuestas MCP
- Escaneo de patrones de inyección en parámetros

<img src="/diagrams/mcp-server-states.svg" alt="Estados del servidor MCP: UNTRUSTED (predeterminado), CLASSIFIED (revisado y permitido), BLOCKED (prohibido explícitamente)" style="max-width: 100%;" />

### Capa 7: Sandbox de plugins

Habilita un plugin de TypeScript en la configuración de usuario con `enabled: true`. Por defecto, la importación y la ejecución se realizan en workers restringidos de Deno. Pueden leer el directorio del plugin y conectarse únicamente a los hosts y puertos de `declaredEndpoints`. No pueden escribir ficheros, leer el entorno del proceso, iniciar subprocesos, usar FFI ni acceder a información restringida del sistema. `trust: trusted` permite importar el módulo en el proceso de Triggerfish. El ejecutor se ejecuta allí si el manifiesto también declara `trusted`.

[Guía completa de plugins](../integrations/plugins)

### Capa 8: Aislamiento de secretos

**Protege contra:** Robo de credenciales, secretos en archivos de configuración,
almacenamiento de credenciales en texto plano.

Las credenciales se almacenan en el llavero del SO (nivel personal) o
integración con vault (nivel empresarial). Nunca aparecen en:

- Archivos de configuración
- Valores de `StorageProvider`
- Entradas de registro
- Contexto del LLM (las credenciales se inyectan en la capa HTTP, por debajo del LLM)

El hook `SECRET_ACCESS` registra cada acceso a credenciales con el plugin
solicitante, el alcance de la credencial y la decisión.

### Capa 9: Sandbox de herramienta del sistema de archivos

**Protege contra:** Ataques de recorrido de ruta, acceso no autorizado a
archivos, elusión de clasificación mediante operaciones directas del sistema de
archivos.

Todas las operaciones de herramientas del sistema de archivos (lectura,
escritura, edición, listado, búsqueda) se ejecutan dentro de un Worker de Deno
con permisos a nivel de SO limitados al subdirectorio del workspace apropiado
para el taint de la sesión. El sandbox aplica tres límites:

- **Jaula de ruta** -- cada ruta se resuelve a una ruta absoluta y se comprueba
  contra la raíz de la jaula con coincidencia consciente de separadores. Los
  intentos de recorrido (`../`) que escapan del workspace se rechazan antes de
  que ocurra cualquier E/S
- **Clasificación de ruta** -- cada ruta del sistema de archivos se clasifica a
  través de una cadena de resolución fija: rutas protegidas codificadas
  (RESTRICTED), directorios de clasificación del workspace, mapeos de rutas
  configurados, luego clasificación predeterminada. El agente no puede acceder a
  rutas por encima de su taint de sesión
- **Permisos limitados por taint** -- los permisos de Deno del Worker del sandbox
  se establecen en el subdirectorio del workspace que coincide con el nivel de
  taint actual de la sesión. Cuando el taint escala, el Worker se reinicia con
  permisos ampliados. Los permisos solo se pueden ampliar, nunca reducir dentro
  de una sesión
- **Protección de escritura** -- los archivos críticos (`TRIGGER.md`,
  `triggerfish.yaml`, `SPINE.md`) están protegidos contra escritura en la capa
  de herramientas independientemente de los permisos del sandbox. Estos archivos
  solo se pueden modificar a través de herramientas de gestión dedicadas que
  aplican sus propias reglas de clasificación

### Capa 10: Identidad del agente

**Protege contra:** Escalada de privilegios a través de cadenas de agentes,
blanqueo de datos mediante delegación.

Cuando los agentes invocan a otros agentes, las cadenas de delegación
criptográficas previenen la escalada de privilegios:

- Cada agente tiene un certificado que especifica sus capacidades y techo de
  clasificación
- El receptor hereda `max(propio taint, taint del llamante)` -- el taint solo
  puede aumentar a través de cadenas
- Un llamante con taint que excede el techo del receptor es bloqueado
- Las invocaciones circulares se detectan y rechazan
- La profundidad de delegación está limitada y se aplica

<img src="/diagrams/data-laundering-defense.svg" alt="Defensa contra el blanqueo de datos: la ruta de ataque se bloquea en la verificación de techo y la herencia de taint previene la salida a canales de clasificación inferior" style="max-width: 100%;" />

### Capa 11: Registro de auditoría

**Protege contra:** Brechas indetectables, fallos de cumplimiento, incapacidad
de investigar incidentes.

Cada decisión relevante para la seguridad se registra con contexto completo:

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

Lo que se registra:

- Todas las solicitudes de acción (permitidas Y denegadas)
- Decisiones de clasificación
- Cambios de taint de sesión
- Eventos de autenticación de canal
- Evaluaciones de reglas de políticas
- Creación y actualización de registros de linaje
- Decisiones del MCP Gateway
- Invocaciones de agente a agente

::: info El registro de auditoría no se puede desactivar. Es una regla fija en
la jerarquía de políticas. Incluso un administrador de organización no puede
desactivar el registro para sus propias acciones. Los despliegues empresariales
pueden opcionalmente habilitar el registro completo del contenido (incluyendo el
contenido de mensajes bloqueados) para requisitos forenses. :::

### Capa 12: Prevención de SSRF

**Protege contra:** Falsificación de solicitud del lado del servidor,
reconocimiento de red interna, exfiltración de metadatos de la nube.

Todas las solicitudes HTTP salientes (desde `web_fetch`, `browser.navigate` y
acceso de red de plugins) resuelven DNS primero y comprueban la IP resuelta
contra una lista de denegación codificada de rangos privados y reservados. Esto
evita que un atacante engañe al agente para que acceda a servicios internos a
través de URL manipuladas.

- Los rangos privados (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`) siempre
  se bloquean
- Las direcciones de enlace local (`169.254.0.0/16`) y endpoints de metadatos de
  la nube se bloquean
- Loopback (`127.0.0.0/8`) se bloquea
- La lista de denegación está codificada y no es configurable -- no hay
  anulación de administrador
- La resolución DNS ocurre antes de la solicitud, previniendo ataques de DNS
  rebinding

### Capa 13: Control de clasificación de memoria

**Protege contra:** Filtración de datos entre sesiones a través de la memoria,
degradación de clasificación mediante escrituras en memoria, acceso no
autorizado a memorias clasificadas.

El sistema de memoria entre sesiones aplica la clasificación tanto en escritura
como en lectura:

- **Escrituras**: las entradas de memoria se fuerzan al nivel de taint de la
  sesión actual. El LLM no puede elegir una clasificación inferior para las
  memorias almacenadas.
- **Lecturas**: las consultas de memoria se filtran por `canFlowTo` -- una
  sesión solo puede leer memorias en o por debajo de su nivel de taint actual.

Esto evita que un agente almacene datos CONFIDENTIAL como PUBLIC en memoria y
luego los recupere en una sesión con menor taint para eludir la regla de
prohibición de escritura descendente.

## Jerarquía de confianza

El modelo de confianza define quién tiene autoridad sobre qué. Los niveles
superiores no pueden eludir las reglas de seguridad de niveles inferiores, pero
pueden configurar los parámetros ajustables dentro de esas reglas.

<img src="/diagrams/trust-hierarchy.svg" alt="Jerarquía de confianza: proveedor Triggerfish (cero acceso), administrador de organización (establece políticas), empleado (usa el agente dentro de los límites)" style="max-width: 100%;" />

::: tip **Nivel personal:** El usuario ES el administrador de la organización.
Soberanía total. Sin visibilidad de Triggerfish. El proveedor tiene cero acceso
a los datos del usuario por defecto y solo puede obtener acceso a través de una
concesión explícita, limitada en el tiempo y registrada por parte del
usuario. :::

## Cómo funcionan las capas juntas

Considere un ataque de inyección de prompt donde un mensaje malicioso intenta
exfiltrar datos:

| Paso | Capa                         | Acción                                                        |
| ---- | ---------------------------- | ------------------------------------------------------------- |
| 1    | Autenticación de canal       | Mensaje etiquetado `{ source: "external" }` -- no es propietario |
| 2    | PRE_CONTEXT_INJECTION        | Entrada escaneada en busca de patrones de inyección, clasificada |
| 3    | Taint de sesión              | Taint de sesión sin cambios (no se accedió a datos clasificados) |
| 4    | LLM procesa el mensaje       | El LLM puede ser manipulado para solicitar una llamada a herramienta |
| 5    | PRE_TOOL_CALL                | Verificación de permisos de herramienta contra reglas de fuente externa |
| 6    | POST_TOOL_RESPONSE           | Cualquier dato devuelto se clasifica, taint actualizado       |
| 7    | PRE_OUTPUT                   | Clasificación de salida vs. destino verificada                |
| 8    | Registro de auditoría        | Toda la secuencia registrada para revisión                    |

Incluso si el LLM está completamente comprometido en el paso 4 y solicita una
llamada a herramienta de exfiltración de datos, las capas restantes
(verificaciones de permisos, seguimiento de taint, clasificación de salida,
registro de auditoría) continúan aplicando las políticas. Ningún punto único de
fallo compromete el sistema.
