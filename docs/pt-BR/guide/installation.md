# Instalación y despliegue

Triggerfish se instala con un solo comando en macOS, Linux, Windows y Docker.
Los instaladores binarios descargan una versión pre-compilada, verifican su suma de verificación SHA256
y ejecutan el asistente de configuración.

## Instalación con un solo comando

::: code-group

```bash [macOS / Linux]
curl -sSL https://raw.githubusercontent.com/greghavens/triggerfish/master/scripts/install.sh | bash
```

```powershell [Windows]
irm https://raw.githubusercontent.com/greghavens/triggerfish/master/scripts/install.ps1 | iex
```

```bash [Docker]
curl -sSL https://raw.githubusercontent.com/greghavens/triggerfish/master/deploy/docker/install.sh | sh
```

:::

### Qué hace el instalador binario

1. **Detecta tu plataforma** y arquitectura
2. **Descarga** el último binario pre-compilado desde GitHub Releases
3. **Verifica la suma de verificación SHA256** para asegurar la integridad
4. **Instala** el binario en `/usr/local/bin` (o `~/.local/bin` /
   `%LOCALAPPDATA%\Triggerfish`)
5. **Ejecuta el asistente de configuración** (`triggerfish dive`) para configurar tu agente, proveedor
   de LLM y canales
6. **Inicia el daemon en segundo plano** para que tu agente esté siempre ejecutándose

Después de que el instalador termine, tienes un agente completamente funcional. No se requieren
pasos adicionales.

### Instalar una versión específica

```bash
# Bash
curl -fsSL https://raw.githubusercontent.com/greghavens/triggerfish/master/scripts/install.sh | TRIGGERFISH_VERSION=v0.7.19 bash

# PowerShell
$env:TRIGGERFISH_VERSION = "v0.1.0"; irm .../scripts/install.ps1 | iex
```

## Requisitos del sistema

| Requisito        | Detalles                                                 |
| ---------------- | -------------------------------------------------------- |
| Sistema operativo | macOS, Linux o Windows                                  |
| Espacio en disco | Aproximadamente 100 MB para el binario compilado         |
| Red              | Requerida para llamadas a la API del LLM; todo el procesamiento se ejecuta localmente |

::: tip No se requiere Docker, contenedores ni cuentas en la nube. Triggerfish es un
solo binario que se ejecuta en tu máquina. Docker está disponible como método alternativo
de despliegue. :::

## Docker

El despliegue con Docker provee un wrapper CLI de `triggerfish` que te da la
misma experiencia de comandos que el binario nativo. Todos los datos residen en un volumen
nombrado de Docker.

### Inicio rápido

El instalador descarga la imagen, instala el wrapper CLI y ejecuta el asistente de
configuración:

```bash
curl -sSL https://raw.githubusercontent.com/greghavens/triggerfish/master/deploy/docker/install.sh | sh
```

O ejecuta el instalador desde un checkout local:

```bash
./deploy/docker/install.sh
```

El instalador:

1. Detecta tu runtime de contenedores (podman o docker)
2. Instala el wrapper CLI de `triggerfish` en `~/.local/bin` (o
   `/usr/local/bin`)
3. Copia el archivo compose a `~/.triggerfish/docker/`
4. Descarga la última imagen
5. Ejecuta el asistente de configuración (`triggerfish dive`) en un contenedor efímero
6. Inicia el servicio

### Uso diario

Después de la instalación, el comando `triggerfish` funciona igual que el binario
nativo:

```bash
triggerfish chat              # Sesión de chat interactiva
triggerfish config set-secret provider:anthropic:apiKey sk-ant-...
triggerfish patrol            # Diagnóstico de salud
triggerfish logs              # Ver logs del contenedor
triggerfish status            # Verificar si el contenedor está ejecutándose
triggerfish stop              # Detener el contenedor
triggerfish start             # Iniciar el contenedor
triggerfish update            # Descargar última imagen y reiniciar
triggerfish dive              # Re-ejecutar asistente de configuración
```

### Cómo funciona el wrapper

El script wrapper (`deploy/docker/triggerfish`) enruta los comandos:

| Comando         | Comportamiento                                                |
| --------------- | ------------------------------------------------------------- |
| `start`         | Iniciar contenedor vía compose                                |
| `stop`          | Detener contenedor vía compose                                |
| `run`           | Ejecutar en primer plano (Ctrl+C para detener)                |
| `status`        | Mostrar estado del contenedor                                 |
| `logs`          | Transmitir logs del contenedor                                |
| `update`        | Descargar última imagen, reiniciar                            |
| `dive`          | Contenedor efímero si no está corriendo; exec + reinicio si está corriendo |
| Todo lo demás   | `exec` en el contenedor en ejecución                          |

El wrapper detecta automáticamente `podman` vs `docker`. Puedes forzar con
`TRIGGERFISH_CONTAINER_RUNTIME=docker`.

### Docker Compose

El archivo compose se encuentra en `~/.triggerfish/docker/docker-compose.yml` después de
la instalación. También puedes usarlo directamente:

```bash
cd deploy/docker
docker compose up -d
```

### Variables de entorno

Copia `.env.example` a `.env` junto al archivo compose para establecer API keys vía
variables de entorno:

```bash
cp deploy/docker/.env.example ~/.triggerfish/docker/.env
# Edita ~/.triggerfish/docker/.env
```

Las API keys típicamente se almacenan vía `triggerfish config set-secret` (persistidas en
el volumen de datos), pero las variables de entorno funcionan como alternativa.

### Secrets en Docker

Como el keychain del sistema operativo no está disponible en contenedores, Triggerfish usa un
almacén de secrets respaldado por archivos en `/data/secrets.json` dentro del volumen. Usa el
wrapper CLI para administrar secrets:

```bash
triggerfish config set-secret provider:anthropic:apiKey sk-ant-...
triggerfish config set-secret provider:brave:apiKey BSA...
```

### Persistencia de datos

El contenedor almacena todos los datos bajo `/data`:

| Ruta                        | Contenido                                   |
| --------------------------- | ------------------------------------------- |
| `/data/triggerfish.yaml`    | Configuración                               |
| `/data/secrets.json`        | Almacén de secrets respaldado por archivo    |
| `/data/data/triggerfish.db` | Base de datos SQLite (sesiones, cron, memoria) |
| `/data/workspace/`          | Workspaces del agente                       |
| `/data/skills/`             | Skills instalados                           |
| `/data/logs/`               | Archivos de log                             |
| `/data/SPINE.md`            | Identidad del agente                        |

Usa un volumen nombrado (`-v triggerfish-data:/data`) o montaje bind para persistir entre
reinicios del contenedor.

### Compilar la imagen Docker localmente

```bash
make docker
# o
docker build -f deploy/docker/Dockerfile -t triggerfish:local .
```

### Fijar versión (Docker)

```bash
docker pull ghcr.io/greghavens/triggerfish:v0.1.0
```

## Instalar desde el código fuente

Si prefieres compilar desde el código fuente o quieres contribuir:

```bash
# 1. Instala Deno (si no lo tienes)
curl -fsSL https://deno.land/install.sh | sh

# 2. Clona el repositorio
git clone https://github.com/greghavens/triggerfish.git
cd triggerfish

# 3. Compila
deno task compile

# 4. Ejecuta el asistente de configuración
./triggerfish dive

# 5. (Opcional) Instala como daemon en segundo plano
./triggerfish start
```

Alternativamente, usa los scripts de instalación desde el código fuente archivados:

```bash
bash deploy/scripts/install-from-source.sh     # Linux / macOS
deploy/scripts/install-from-source.ps1          # Windows
```

::: info Compilar desde el código fuente requiere Deno 2.x y git. El comando `deno task compile`
produce un binario auto-contenido sin dependencias externas. :::

## Compilaciones binarias multiplataforma

Para compilar binarios para todas las plataformas desde cualquier máquina host:

```bash
make release
```

Esto produce los 5 binarios más las sumas de verificación en `dist/`:

| Archivo                       | Plataforma                |
| ----------------------------- | ------------------------- |
| `triggerfish-linux-x64`       | Linux x86_64              |
| `triggerfish-linux-arm64`     | Linux ARM64               |
| `triggerfish-macos-x64`       | macOS Intel               |
| `triggerfish-macos-arm64`     | macOS Apple Silicon       |
| `triggerfish-windows-x64.exe` | Windows x86_64            |
| `SHA256SUMS.txt`              | Sumas de verificación para todos los binarios |

## Directorio de ejecución

Después de ejecutar `triggerfish dive`, tu configuración y datos residen en
`~/.triggerfish/`:

```
~/.triggerfish/
├── triggerfish.yaml          # Configuración principal
├── SPINE.md                  # Identidad y misión del agente (prompt del sistema)
├── TRIGGER.md                # Triggers de comportamiento proactivo
├── workspace/                # Workspace de código del agente
├── skills/                   # Skills instalados
├── data/                     # Base de datos SQLite, estado de sesión
└── logs/                     # Logs del daemon y ejecución
```

En Docker, esto se mapea a `/data/` dentro del contenedor.

## Gestión del daemon

El instalador configura Triggerfish como un servicio nativo del sistema operativo en segundo plano:

| Plataforma | Gestor de servicios                |
| ---------- | ---------------------------------- |
| macOS      | launchd                            |
| Linux      | systemd                            |
| Windows    | Windows Service / Task Scheduler   |

Después de la instalación, administra el daemon con:

```bash
triggerfish start     # Instalar e iniciar el daemon
triggerfish stop      # Detener el daemon
triggerfish status    # Verificar si el daemon está ejecutándose
triggerfish logs      # Ver logs del daemon
```

## Proceso de lanzamiento

Los lanzamientos se automatizan vía GitHub Actions. Para crear un nuevo lanzamiento:

```bash
git tag v0.2.0
git push origin v0.2.0
```

Esto activa el workflow de lanzamiento que compila los 5 binarios de plataforma, crea
un GitHub Release con sumas de verificación y publica una imagen Docker multi-arquitectura en GHCR.
Los scripts de instalación descargan automáticamente el último lanzamiento.

## Actualización

Para buscar e instalar actualizaciones:

```bash
triggerfish update
```

## Soporte de plataformas

| Plataforma  | Binario | Docker | Script de instalación |
| ----------- | ------- | ------ | --------------------- |
| Linux x64   | sí      | sí     | sí                    |
| Linux arm64 | sí      | sí     | sí                    |
| macOS x64   | sí      | —      | sí                    |
| macOS arm64 | sí      | —      | sí                    |
| Windows x64 | sí      | —      | sí (PowerShell)       |

## Próximos pasos

Con Triggerfish instalado, dirígete a la guía de [Inicio rápido](./quickstart) para
configurar tu agente y empezar a chatear.
