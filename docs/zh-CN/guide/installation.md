# 安装与部署

Triggerfish 可在 macOS、Linux、Windows 和 Docker 上通过一条命令完成安装。二进制安装程序会下载预构建的发行版、验证其 SHA256 校验和并运行设置向导。

## 一条命令安装

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

### 二进制安装程序的工作流程

1. **检测您的平台**和架构
2. **下载**来自 GitHub Releases 的最新预构建二进制文件
3. **验证 SHA256 校验和**以确保完整性
4. **安装**二进制文件到 `/usr/local/bin`（或 `~/.local/bin` / `%LOCALAPPDATA%\Triggerfish`）
5. **运行设置向导**（`triggerfish dive`）来配置您的智能体、LLM 提供商和渠道
6. **启动后台守护进程**使您的智能体始终运行

安装程序完成后，您就拥有了一个完全可用的智能体。无需其他步骤。

### 安装特定版本

```bash
# Bash
curl -fsSL https://raw.githubusercontent.com/greghavens/triggerfish/master/scripts/install.sh | TRIGGERFISH_VERSION=v0.7.19 bash

# PowerShell
$env:TRIGGERFISH_VERSION = "v0.1.0"; irm .../scripts/install.ps1 | iex
```

## 系统要求

| 要求 | 详情 |
| --- | --- |
| 操作系统 | macOS、Linux 或 Windows |
| 磁盘空间 | 编译后的二进制文件约 100 MB |
| 网络 | LLM API 调用需要；所有处理在本地运行 |

::: tip 无需 Docker、无需容器、无需云账户。Triggerfish 是一个在您机器上运行的单一二进制文件。Docker 可作为替代部署方式使用。 :::

## Docker

Docker 部署提供了一个 `triggerfish` CLI 包装器，为您提供与原生二进制文件相同的命令体验。所有数据存储在一个命名的 Docker 卷中。

### 快速开始

安装程序会拉取镜像、安装 CLI 包装器并运行设置向导：

```bash
curl -sSL https://raw.githubusercontent.com/greghavens/triggerfish/master/deploy/docker/install.sh | sh
```

或从本地检出运行安装程序：

```bash
./deploy/docker/install.sh
```

安装程序将：

1. 检测您的容器运行时（podman 或 docker）
2. 将 `triggerfish` CLI 包装器安装到 `~/.local/bin`（或 `/usr/local/bin`）
3. 将 compose 文件复制到 `~/.triggerfish/docker/`
4. 拉取最新镜像
5. 在一次性容器中运行设置向导（`triggerfish dive`）
6. 启动服务

### 日常使用

安装后，`triggerfish` 命令的工作方式与原生二进制文件相同：

```bash
triggerfish chat              # 交互式聊天会话
triggerfish config set-secret provider:anthropic:apiKey sk-ant-...
triggerfish patrol            # 健康诊断
triggerfish logs              # 查看容器日志
triggerfish status            # 检查容器是否正在运行
triggerfish stop              # 停止容器
triggerfish start             # 启动容器
triggerfish update            # 拉取最新镜像并重启
triggerfish dive              # 重新运行设置向导
```

### 包装器工作原理

包装器脚本（`deploy/docker/triggerfish`）路由命令：

| 命令 | 行为 |
| --- | --- |
| `start` | 通过 compose 启动容器 |
| `stop` | 通过 compose 停止容器 |
| `run` | 在前台运行（Ctrl+C 停止） |
| `status` | 显示容器运行状态 |
| `logs` | 流式输出容器日志 |
| `update` | 拉取最新镜像，重启 |
| `dive` | 未运行时使用一次性容器；运行时 exec + 重启 |
| 其他 | `exec` 进入运行中的容器 |

包装器自动检测 `podman` 与 `docker`。可通过 `TRIGGERFISH_CONTAINER_RUNTIME=docker` 覆盖。

### Docker Compose

安装后，compose 文件位于 `~/.triggerfish/docker/docker-compose.yml`。您也可以直接使用它：

```bash
cd deploy/docker
docker compose up -d
```

### 环境变量

将 `.env.example` 复制为 `.env` 并放在 compose 文件旁边，通过环境变量设置 API 密钥：

```bash
cp deploy/docker/.env.example ~/.triggerfish/docker/.env
# 编辑 ~/.triggerfish/docker/.env
```

API 密钥通常通过 `triggerfish config set-secret` 存储（持久化在数据卷中），但环境变量也可作为替代方式。

### Docker 中的密钥管理

由于容器中没有 OS 密钥链，Triggerfish 在卷内的 `/data/secrets.json` 使用基于文件的密钥存储。使用 CLI 包装器管理密钥：

```bash
triggerfish config set-secret provider:anthropic:apiKey sk-ant-...
triggerfish config set-secret provider:brave:apiKey BSA...
```

### 数据持久化

容器将所有数据存储在 `/data` 下：

| 路径 | 内容 |
| --- | --- |
| `/data/triggerfish.yaml` | 配置 |
| `/data/secrets.json` | 基于文件的密钥存储 |
| `/data/data/triggerfish.db` | SQLite 数据库（会话、cron、记忆） |
| `/data/workspace/` | 智能体工作空间 |
| `/data/skills/` | 已安装的技能 |
| `/data/logs/` | 日志文件 |
| `/data/SPINE.md` | 智能体身份 |

使用命名卷（`-v triggerfish-data:/data`）或绑定挂载以在容器重启后持久化。

### 本地构建 Docker 镜像

```bash
make docker
# 或
docker build -f deploy/docker/Dockerfile -t triggerfish:local .
```

### 版本固定（Docker）

```bash
docker pull ghcr.io/greghavens/triggerfish:v0.1.0
```

## 从源码安装

如果您更喜欢从源码构建或希望贡献代码：

```bash
# 1. 安装 Deno（如果您还没有）
curl -fsSL https://deno.land/install.sh | sh

# 2. 克隆仓库
git clone https://github.com/greghavens/triggerfish.git
cd triggerfish

# 3. 编译
deno task compile

# 4. 运行设置向导
./triggerfish dive

# 5. （可选）作为后台守护进程安装
./triggerfish start
```

或者，使用存档的从源码安装脚本：

```bash
bash deploy/scripts/install-from-source.sh     # Linux / macOS
deploy/scripts/install-from-source.ps1          # Windows
```

::: info 从源码构建需要 Deno 2.x 和 git。`deno task compile` 命令生成一个没有外部依赖的独立二进制文件。 :::

## 跨平台二进制构建

从任何主机机器构建所有平台的二进制文件：

```bash
make release
```

这会在 `dist/` 中生成所有 5 个二进制文件及校验和：

| 文件 | 平台 |
| --- | --- |
| `triggerfish-linux-x64` | Linux x86_64 |
| `triggerfish-linux-arm64` | Linux ARM64 |
| `triggerfish-macos-x64` | macOS Intel |
| `triggerfish-macos-arm64` | macOS Apple Silicon |
| `triggerfish-windows-x64.exe` | Windows x86_64 |
| `SHA256SUMS.txt` | 所有二进制文件的校验和 |

## 运行时目录

运行 `triggerfish dive` 后，您的配置和数据位于 `~/.triggerfish/`：

```
~/.triggerfish/
├── triggerfish.yaml          # 主配置
├── SPINE.md                  # 智能体身份和使命（系统提示）
├── TRIGGER.md                # 主动行为触发器
├── workspace/                # 智能体代码工作空间
├── skills/                   # 已安装的技能
├── data/                     # SQLite 数据库、会话状态
└── logs/                     # 守护进程和执行日志
```

在 Docker 中，这映射到容器内的 `/data/`。

## 守护进程管理

安装程序将 Triggerfish 设置为操作系统原生后台服务：

| 平台 | 服务管理器 |
| --- | --- |
| macOS | launchd |
| Linux | systemd |
| Windows | Windows Service / Task Scheduler |

安装后，使用以下命令管理守护进程：

```bash
triggerfish start     # 安装并启动守护进程
triggerfish stop      # 停止守护进程
triggerfish status    # 检查守护进程是否正在运行
triggerfish logs      # 查看守护进程日志
```

## 发布流程

发布通过 GitHub Actions 自动化。要创建新版本：

```bash
git tag v0.2.0
git push origin v0.2.0
```

这会触发发布工作流，构建所有 5 个平台二进制文件、创建带有校验和的 GitHub Release，并将多架构 Docker 镜像推送到 GHCR。安装脚本会自动下载最新版本。

## 更新

检查并安装更新：

```bash
triggerfish update
```

## 平台支持

| 平台 | 二进制 | Docker | 安装脚本 |
| --- | --- | --- | --- |
| Linux x64 | 是 | 是 | 是 |
| Linux arm64 | 是 | 是 | 是 |
| macOS x64 | 是 | — | 是 |
| macOS arm64 | 是 | — | 是 |
| Windows x64 | 是 | — | 是 (PowerShell) |

## 后续步骤

安装 Triggerfish 后，请前往[快速开始](./quickstart)指南来配置您的智能体并开始聊天。
