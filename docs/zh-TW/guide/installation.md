# 安裝與部署

Triggerfish 只需一行指令即可安裝在 macOS、Linux、Windows 和 Docker 上。
二進位安裝程式會下載預建版本、驗證其 SHA256 校驗碼，並執行設定精靈。

## 一行指令安裝

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

### 二進位安裝程式的作用

1. **偵測您的平台**和架構
2. **下載**最新的預建二進位檔案，來自 GitHub Releases
3. **驗證 SHA256 校驗碼**以確保完整性
4. **安裝**二進位檔案到 `/usr/local/bin`（或 `~/.local/bin` /
   `%LOCALAPPDATA%\Triggerfish`）
5. **執行設定精靈**（`triggerfish dive`）來設定您的代理、LLM
   提供者和頻道
6. **啟動背景常駐程式**，讓您的代理始終運行

安裝程式完成後，您就擁有一個完全可用的代理。無需額外步驟。

### 安裝特定版本

```bash
# Bash
curl -fsSL https://raw.githubusercontent.com/greghavens/triggerfish/master/scripts/install.sh | TRIGGERFISH_VERSION=v0.7.19 bash

# PowerShell
$env:TRIGGERFISH_VERSION = "v0.1.0"; irm .../scripts/install.ps1 | iex
```

## 系統需求

| 需求         | 詳細資訊                                          |
| ------------ | ------------------------------------------------- |
| 作業系統     | macOS、Linux 或 Windows                           |
| 磁碟空間     | 編譯後的二進位檔案約 100 MB                       |
| 網路         | LLM API 呼叫需要網路；所有處理在本機執行          |

::: tip 不需要 Docker、不需要容器、不需要雲端帳號。Triggerfish 是
一個在您的機器上執行的單一二進位檔案。Docker 可作為替代部署方式。 :::

## Docker

Docker 部署提供一個 `triggerfish` CLI 包裝器，給您與原生二進位相同的
指令體驗。所有資料存放在具名 Docker 卷冊中。

### 快速開始

安裝程式會拉取映像檔、安裝 CLI 包裝器並執行設定精靈：

```bash
curl -sSL https://raw.githubusercontent.com/greghavens/triggerfish/master/deploy/docker/install.sh | sh
```

或從本地檢出執行安裝程式：

```bash
./deploy/docker/install.sh
```

安裝程式會：

1. 偵測您的容器執行環境（podman 或 docker）
2. 安裝 `triggerfish` CLI 包裝器到 `~/.local/bin`（或
   `/usr/local/bin`）
3. 複製 compose 檔案到 `~/.triggerfish/docker/`
4. 拉取最新映像檔
5. 執行設定精靈（`triggerfish dive`），在一次性容器中
6. 啟動服務

### 日常使用

安裝完成後，`triggerfish` 指令的運作方式與原生二進位相同：

```bash
triggerfish chat              # 互動式聊天工作階段
triggerfish config set-secret provider:anthropic:apiKey sk-ant-...
triggerfish patrol            # 健康診斷
triggerfish logs              # 查看容器日誌
triggerfish status            # 檢查容器是否執行中
triggerfish stop              # 停止容器
triggerfish start             # 啟動容器
triggerfish update            # 拉取最新映像檔並重新啟動
triggerfish dive              # 重新執行設定精靈
```

### 包裝器的運作方式

包裝器腳本（`deploy/docker/triggerfish`）路由指令：

| 指令            | 行為                                                         |
| --------------- | ------------------------------------------------------------ |
| `start`         | 透過 compose 啟動容器                                       |
| `stop`          | 透過 compose 停止容器                                       |
| `run`           | 在前台執行（Ctrl+C 停止）                                   |
| `status`        | 顯示容器執行狀態                                             |
| `logs`          | 串流容器日誌                                                 |
| `update`        | 拉取最新映像檔，重新啟動                                     |
| `dive`          | 未執行時使用一次性容器；執行中時使用 exec + 重新啟動         |
| 其他指令        | `exec` 進入執行中的容器                                      |

包裝器會自動偵測 `podman` 與 `docker`。透過
`TRIGGERFISH_CONTAINER_RUNTIME=docker` 覆寫。

### Docker Compose

compose 檔案在安裝後位於 `~/.triggerfish/docker/docker-compose.yml`。
您也可以直接使用它：

```bash
cd deploy/docker
docker compose up -d
```

### 環境變數

將 `.env.example` 複製為 `.env`，放在 compose 檔案旁邊，以透過環境變數設定
API 金鑰：

```bash
cp deploy/docker/.env.example ~/.triggerfish/docker/.env
# 編輯 ~/.triggerfish/docker/.env
```

API 金鑰通常透過 `triggerfish config set-secret` 儲存（持久化在資料卷冊中），
但環境變數可作為替代方案。

### Docker 中的機密

由於在容器中無法使用作業系統鑰匙圈，Triggerfish 使用卷冊內
`/data/secrets.json` 的檔案式機密儲存。使用 CLI 包裝器管理機密：

```bash
triggerfish config set-secret provider:anthropic:apiKey sk-ant-...
triggerfish config set-secret provider:brave:apiKey BSA...
```

### 資料持久化

容器將所有資料儲存在 `/data` 下：

| 路徑                        | 內容                                     |
| --------------------------- | ---------------------------------------- |
| `/data/triggerfish.yaml`    | 設定檔                                   |
| `/data/secrets.json`        | 檔案式機密儲存                           |
| `/data/data/triggerfish.db` | SQLite 資料庫（工作階段、定時任務、記憶） |
| `/data/workspace/`          | 代理工作區                               |
| `/data/skills/`             | 已安裝的技能                             |
| `/data/logs/`               | 日誌檔案                                 |
| `/data/SPINE.md`            | 代理身份                                 |

使用具名卷冊（`-v triggerfish-data:/data`）或繫結掛載以在容器重新啟動後持久化。

### 在本機建置 Docker 映像檔

```bash
make docker
# 或
docker build -f deploy/docker/Dockerfile -t triggerfish:local .
```

### 版本鎖定（Docker）

```bash
docker pull ghcr.io/greghavens/triggerfish:v0.1.0
```

## 從原始碼安裝

如果您偏好從原始碼建置或想要貢獻：

```bash
# 1. 安裝 Deno（如果您還沒有）
curl -fsSL https://deno.land/install.sh | sh

# 2. 複製儲存庫
git clone https://github.com/greghavens/triggerfish.git
cd triggerfish

# 3. 編譯
deno task compile

# 4. 執行設定精靈
./triggerfish dive

# 5.（選用）安裝為背景常駐程式
./triggerfish start
```

或者，使用存檔的從原始碼安裝腳本：

```bash
bash deploy/scripts/install-from-source.sh     # Linux / macOS
deploy/scripts/install-from-source.ps1          # Windows
```

::: info 從原始碼建置需要 Deno 2.x 和 git。`deno task compile`
指令會產生一個不依賴外部套件的獨立二進位檔案。 :::

## 跨平台二進位建置

從任何主機為所有平台建置二進位檔案：

```bash
make release
```

這會在 `dist/` 中產生所有 5 個二進位檔案加上校驗碼：

| 檔案                          | 平台                     |
| ----------------------------- | ------------------------ |
| `triggerfish-linux-x64`       | Linux x86_64             |
| `triggerfish-linux-arm64`     | Linux ARM64              |
| `triggerfish-macos-x64`       | macOS Intel              |
| `triggerfish-macos-arm64`     | macOS Apple Silicon      |
| `triggerfish-windows-x64.exe` | Windows x86_64           |
| `SHA256SUMS.txt`              | 所有二進位檔案的校驗碼   |

## 執行時目錄

執行 `triggerfish dive` 後，您的設定和資料位於
`~/.triggerfish/`：

```
~/.triggerfish/
├── triggerfish.yaml          # 主要設定檔
├── SPINE.md                  # 代理身份與使命（系統提示）
├── TRIGGER.md                # 主動行為觸發器
├── workspace/                # 代理程式碼工作區
├── skills/                   # 已安裝的技能
├── data/                     # SQLite 資料庫、工作階段狀態
└── logs/                     # 常駐程式和執行日誌
```

在 Docker 中，這會對應到容器內的 `/data/`。

## 常駐程式管理

安裝程式會將 Triggerfish 設定為作業系統原生背景服務：

| 平台    | 服務管理員                       |
| ------- | -------------------------------- |
| macOS   | launchd                         |
| Linux   | systemd                         |
| Windows | Windows Service / Task Scheduler |

安裝後，使用以下指令管理常駐程式：

```bash
triggerfish start     # 安裝並啟動常駐程式
triggerfish stop      # 停止常駐程式
triggerfish status    # 檢查常駐程式是否執行中
triggerfish logs      # 查看常駐程式日誌
```

## 發行流程

透過 GitHub Actions 自動化發行。建立新版本：

```bash
git tag v0.2.0
git push origin v0.2.0
```

這會觸發發行工作流程，建置所有 5 個平台二進位檔案、建立包含校驗碼的
GitHub Release，並將多架構 Docker 映像檔推送到 GHCR。
安裝腳本會自動下載最新版本。

## 更新

檢查並安裝更新：

```bash
triggerfish update
```

## 平台支援

| 平台        | 二進位 | Docker | 安裝腳本         |
| ----------- | ------ | ------ | ---------------- |
| Linux x64   | 是     | 是     | 是               |
| Linux arm64 | 是     | 是     | 是               |
| macOS x64   | 是     | —      | 是               |
| macOS arm64 | 是     | —      | 是               |
| Windows x64 | 是     | —      | 是（PowerShell） |

## 接下來

安裝 Triggerfish 後，前往[快速開始](./quickstart)指南來設定您的代理並開始聊天。
