# Instalacion y despliegue

Triggerfish se instala con un solo comando en macOS, Linux, Windows y Docker.
Los instaladores binarios descargan una release precompilada, verifican su
checksum SHA256 e inician el asistente de configuracion.

## Instalacion con un comando

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

### Que hace el instalador binario

1. **Detecta su plataforma** y arquitectura
2. **Descarga** el ultimo binario precompilado desde GitHub Releases
3. **Verifica el checksum SHA256** para garantizar la integridad
4. **Instala** el binario en `/usr/local/bin` (o `~/.local/bin` /
   `%LOCALAPPDATA%\Triggerfish`)
5. **Ejecuta el asistente de configuracion** (`triggerfish dive`) para
   configurar su agente, proveedor LLM y canales
6. **Inicia el daemon en segundo plano** para que su agente este siempre
   ejecutandose

Tras finalizar el instalador, dispone de un agente completamente funcional. No
se requieren pasos adicionales.

### Instalar una version especifica

```bash
# Bash
curl -fsSL https://raw.githubusercontent.com/greghavens/triggerfish/master/scripts/install.sh | TRIGGERFISH_VERSION=v0.7.19 bash

# PowerShell
$env:TRIGGERFISH_VERSION = "v0.1.0"; irm .../scripts/install.ps1 | iex
```

## Requisitos del sistema

| Requisito         | Detalles                                                       |
| ----------------- | -------------------------------------------------------------- |
| Sistema operativo | macOS, Linux o Windows                                         |
| Espacio en disco  | Aproximadamente 100 MB para el binario compilado               |
| Red               | Necesaria para las llamadas a la API del LLM; todo el procesamiento se ejecuta localmente |

::: tip No se requiere Docker, ni contenedores, ni cuentas en la nube.
Triggerfish es un unico binario que se ejecuta en su ordenador. Docker esta
disponible como metodo de despliegue alternativo. :::

## Docker

El despliegue Docker proporciona un wrapper CLI `triggerfish` que ofrece la
misma experiencia de comandos que el binario nativo. Todos los datos residen en
un volumen Docker con nombre.

### Inicio rapido

El instalador descarga la imagen, instala el wrapper CLI e inicia el asistente
de configuracion:

```bash
curl -sSL https://raw.githubusercontent.com/greghavens/triggerfish/master/deploy/docker/install.sh | sh
```

O ejecute el instalador desde un checkout local:

```bash
./deploy/docker/install.sh
```

El instalador:

1. Detecta su runtime de contenedores (podman o docker)
2. Instala el wrapper CLI `triggerfish` en `~/.local/bin` (o
   `/usr/local/bin`)
3. Copia el fichero compose a `~/.triggerfish/docker/`
4. Descarga la ultima imagen
5. Ejecuta el asistente de configuracion (`triggerfish dive`) en un contenedor
   de un solo uso
6. Inicia el servicio

### Uso diario

Tras la instalacion, el comando `triggerfish` funciona igual que el binario
nativo:

```bash
triggerfish chat              # Sesion de chat interactiva
triggerfish config set-secret provider:anthropic:apiKey sk-ant-...
triggerfish patrol            # Diagnosticos de salud
triggerfish logs              # Ver registros del contenedor
triggerfish status            # Comprobar si el contenedor esta ejecutandose
triggerfish stop              # Detener el contenedor
triggerfish start             # Iniciar el contenedor
triggerfish update            # Descargar la ultima imagen y reiniciar
triggerfish dive              # Volver a ejecutar el asistente de configuracion
```

### Como funciona el wrapper

El script wrapper (`deploy/docker/triggerfish`) enruta los comandos:

| Comando         | Comportamiento                                                       |
| --------------- | -------------------------------------------------------------------- |
| `start`         | Iniciar contenedor via compose                                       |
| `stop`          | Detener contenedor via compose                                       |
| `run`           | Ejecutar en primer plano (Ctrl+C para detener)                       |
| `status`        | Mostrar estado de ejecucion del contenedor                           |
| `logs`          | Transmitir registros del contenedor                                  |
| `update`        | Descargar ultima imagen, reiniciar                                   |
| `dive`          | Contenedor de un solo uso si no esta ejecutandose; exec + reiniciar si esta ejecutandose |
| Todo lo demas   | `exec` dentro del contenedor en ejecucion                            |

El wrapper autodetecta `podman` vs `docker`. Puede forzarlo con
`TRIGGERFISH_CONTAINER_RUNTIME=docker`.

### Docker Compose

El fichero compose se encuentra en `~/.triggerfish/docker/docker-compose.yml`
tras la instalacion. Tambien puede utilizarlo directamente:

```bash
cd deploy/docker
docker compose up -d
```

### Variables de entorno

Copie `.env.example` a `.env` junto al fichero compose para establecer claves
API mediante variables de entorno:

```bash
cp deploy/docker/.env.example ~/.triggerfish/docker/.env
# Edite ~/.triggerfish/docker/.env
```

Las claves API se almacenan normalmente mediante `triggerfish config set-secret`
(persistidas en el volumen de datos), pero las variables de entorno funcionan
como alternativa.

### Secretos en Docker

Dado que el llavero del sistema operativo no esta disponible en contenedores,
Triggerfish utiliza un almacen de secretos respaldado por fichero en
`/data/secrets.json` dentro del volumen. Utilice el wrapper CLI para gestionar
los secretos:

```bash
triggerfish config set-secret provider:anthropic:apiKey sk-ant-...
triggerfish config set-secret provider:brave:apiKey BSA...
```

### Persistencia de datos

El contenedor almacena todos los datos bajo `/data`:

| Ruta                        | Contenido                                     |
| --------------------------- | --------------------------------------------- |
| `/data/triggerfish.yaml`    | Configuracion                                 |
| `/data/secrets.json`        | Almacen de secretos respaldado por fichero     |
| `/data/data/triggerfish.db` | Base de datos SQLite (sesiones, cron, memoria) |
| `/data/workspace/`          | Espacios de trabajo del agente                 |
| `/data/skills/`             | Skills instalados                              |
| `/data/logs/`               | Ficheros de registro                           |
| `/data/SPINE.md`            | Identidad del agente                           |

Utilice un volumen con nombre (`-v triggerfish-data:/data`) o un bind mount para
persistir los datos entre reinicios del contenedor.

### Compilar la imagen Docker localmente

```bash
make docker
# o
docker build -f deploy/docker/Dockerfile -t triggerfish:local .
```

### Fijacion de version (Docker)

```bash
docker pull ghcr.io/greghavens/triggerfish:v0.1.0
```

## Instalar desde el codigo fuente

Si prefiere compilar desde el codigo fuente o desea contribuir:

```bash
# 1. Instalar Deno (si no lo tiene)
curl -fsSL https://deno.land/install.sh | sh

# 2. Clonar el repositorio
git clone https://github.com/greghavens/triggerfish.git
cd triggerfish

# 3. Compilar
deno task compile

# 4. Ejecutar el asistente de configuracion
./triggerfish dive

# 5. (Opcional) Instalar como daemon en segundo plano
./triggerfish start
```

Alternativamente, utilice los scripts archivados de instalacion desde codigo
fuente:

```bash
bash deploy/scripts/install-from-source.sh     # Linux / macOS
deploy/scripts/install-from-source.ps1          # Windows
```

::: info Compilar desde el codigo fuente requiere Deno 2.x y git. El comando
`deno task compile` produce un binario autocontenido sin dependencias externas.
:::

## Compilaciones binarias multiplataforma

Para compilar binarios para todas las plataformas desde cualquier ordenador:

```bash
make release
```

Esto produce los 5 binarios mas los checksums en `dist/`:

| Fichero                       | Plataforma                 |
| ----------------------------- | -------------------------- |
| `triggerfish-linux-x64`       | Linux x86_64               |
| `triggerfish-linux-arm64`     | Linux ARM64                |
| `triggerfish-macos-x64`       | macOS Intel                |
| `triggerfish-macos-arm64`     | macOS Apple Silicon        |
| `triggerfish-windows-x64.exe` | Windows x86_64             |
| `SHA256SUMS.txt`              | Checksums de todos los binarios |

## Directorio de ejecucion

Tras ejecutar `triggerfish dive`, su configuracion y datos residen en
`~/.triggerfish/`:

```
~/.triggerfish/
├── triggerfish.yaml          # Configuracion principal
├── SPINE.md                  # Identidad y mision del agente (system prompt)
├── TRIGGER.md                # Triggers de comportamiento proactivo
├── workspace/                # Espacio de trabajo de codigo del agente
├── skills/                   # Skills instalados
├── data/                     # Base de datos SQLite, estado de sesiones
└── logs/                     # Registros del daemon y de ejecucion
```

En Docker, esto se mapea a `/data/` dentro del contenedor.

## Gestion del daemon

El instalador configura Triggerfish como un servicio nativo del sistema operativo
en segundo plano:

| Plataforma | Gestor de servicios                     |
| ---------- | --------------------------------------- |
| macOS      | launchd                                 |
| Linux      | systemd                                 |
| Windows    | Windows Service / Programador de tareas |

Tras la instalacion, gestione el daemon con:

```bash
triggerfish start     # Instalar e iniciar el daemon
triggerfish stop      # Detener el daemon
triggerfish status    # Comprobar si el daemon esta ejecutandose
triggerfish logs      # Ver registros del daemon
```

## Proceso de lanzamiento

Los lanzamientos se automatizan mediante GitHub Actions. Para crear un nuevo
lanzamiento:

```bash
git tag v0.2.0
git push origin v0.2.0
```

Esto desencadena el flujo de trabajo de lanzamiento que compila los 5 binarios
de plataforma, crea un GitHub Release con checksums y publica una imagen Docker
multi-arquitectura en GHCR. Los scripts de instalacion descargan
automaticamente el ultimo lanzamiento.

## Actualizaciones

Para comprobar e instalar actualizaciones:

```bash
triggerfish update
```

## Soporte de plataformas

| Plataforma  | Binario | Docker | Script de instalacion |
| ----------- | ------- | ------ | --------------------- |
| Linux x64   | si      | si     | si                    |
| Linux arm64 | si      | si     | si                    |
| macOS x64   | si      | —      | si                    |
| macOS arm64 | si      | —      | si                    |
| Windows x64 | si      | —      | si (PowerShell)       |

## Siguientes pasos

Con Triggerfish instalado, dirijase a la guia de [Inicio rapido](./quickstart)
para configurar su agente y empezar a chatear.
