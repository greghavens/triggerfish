# インストールとデプロイ

Triggerfishshは、macOS、Linux、Windows、Dockerに1つのコマンドでインストールできます。
バイナリインストーラーはビルド済みリリースをダウンロードし、SHA256チェックサムを検証して、
セットアップウィザードを実行します。

## 1コマンドインストール

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

### バイナリインストーラーが行うこと

1. お使いの**プラットフォームとアーキテクチャを検出**します
2. GitHubリリースから最新のビルド済みバイナリを**ダウンロード**します
3. **SHA256チェックサムを検証**して整合性を確認します
4. バイナリを`/usr/local/bin`（または`~/.local/bin` / `%LOCALAPPDATA%\Triggerfish`）に**インストール**します
5. エージェント、LLMプロバイダー、チャンネルを設定するために**セットアップウィザード**（`triggerfish dive`）を**実行**します
6. エージェントが常に動作するように**バックグラウンドデーモンを起動**します

インストーラーが完了したら、完全に動作するエージェントが使用可能になります。追加の
手順は不要です。

### 特定バージョンのインストール

```bash
# Bash
curl -fsSL https://raw.githubusercontent.com/greghavens/triggerfish/master/scripts/install.sh | TRIGGERFISH_VERSION=v0.7.19 bash

# PowerShell
$env:TRIGGERFISH_VERSION = "v0.1.0"; irm .../scripts/install.ps1 | iex
```

## システム要件

| 要件           | 詳細                                                         |
| -------------- | ------------------------------------------------------------ |
| オペレーティングシステム | macOS、Linux、またはWindows                         |
| ディスクスペース | コンパイル済みバイナリに約100 MB                           |
| ネットワーク   | LLM API呼び出しに必要。すべての処理はローカルで実行          |

::: tip DockerなしURL、コンテナなし、クラウドアカウント不要です。Triggerfishshはお使いのマシンで
動作する単一バイナリです。Dockerは代替デプロイメント方法として利用可能です。 :::

## Docker

Dockerデプロイメントは、ネイティブバイナリと同じコマンド体験を提供する`triggerfish` CLI
ラッパーを提供します。すべてのデータは名前付きDockerボリュームに保存されます。

### クイックスタート

インストーラーはイメージを取得し、CLIラッパーをインストールして、セットアップウィザードを実行します：

```bash
curl -sSL https://raw.githubusercontent.com/greghavens/triggerfish/master/deploy/docker/install.sh | sh
```

またはローカルチェックアウトからインストーラーを実行します：

```bash
./deploy/docker/install.sh
```

インストーラーの処理内容：

1. コンテナランタイム（podmanまたはdocker）を検出します
2. `triggerfish` CLIラッパーを`~/.local/bin`（または`/usr/local/bin`）にインストールします
3. composeファイルを`~/.triggerfish/docker/`にコピーします
4. 最新イメージを取得します
5. ワンショットコンテナでセットアップウィザード（`triggerfish dive`）を実行します
6. サービスを起動します

### 日常使用

インストール後、`triggerfish`コマンドはネイティブバイナリと同様に動作します：

```bash
triggerfish chat              # インタラクティブチャットセッション
triggerfish config set-secret provider:anthropic:apiKey sk-ant-...
triggerfish patrol            # ヘルス診断
triggerfish logs              # コンテナログの表示
triggerfish status            # コンテナが実行中かチェック
triggerfish stop              # コンテナの停止
triggerfish start             # コンテナの起動
triggerfish update            # 最新イメージを取得して再起動
triggerfish dive              # セットアップウィザードの再実行
```

### ラッパーの仕組み

ラッパースクリプト（`deploy/docker/triggerfish`）はコマンドをルーティングします：

| コマンド         | 動作                                                      |
| --------------- | ---------------------------------------------------------- |
| `start`         | composeでコンテナを起動                                    |
| `stop`          | composeでコンテナを停止                                    |
| `run`           | フォアグラウンドで実行（Ctrl+Cで停止）                     |
| `status`        | コンテナの実行状態を表示                                   |
| `logs`          | コンテナログをストリーム                                   |
| `update`        | 最新イメージを取得して再起動                               |
| `dive`          | 実行中でない場合はワンショットコンテナ、実行中の場合はexec + 再起動 |
| その他すべて    | 実行中のコンテナに`exec`                                   |

ラッパーは`podman`と`docker`を自動検出します。`TRIGGERFISH_CONTAINER_RUNTIME=docker`で
上書きできます。

### Docker Compose

composeファイルはインストール後に`~/.triggerfish/docker/docker-compose.yml`にあります。
直接使用することもできます：

```bash
cd deploy/docker
docker compose up -d
```

### 環境変数

`.env.example`を`.env`としてcomposeファイルと同じ場所にコピーして、環境変数でAPIキーを設定します：

```bash
cp deploy/docker/.env.example ~/.triggerfish/docker/.env
# ~/.triggerfish/docker/.env を編集
```

### Dockerのシークレット

OSキーチェーンはコンテナ内では使用できないため、Triggerfishshはボリューム内の
`/data/secrets.json`にあるファイルバックドのシークレットストアを使用します。
CLIラッパーでシークレットを管理します：

```bash
triggerfish config set-secret provider:anthropic:apiKey sk-ant-...
triggerfish config set-secret provider:brave:apiKey BSA...
```

### データの永続性

コンテナはすべてのデータを`/data`に保存します：

| パス                        | 内容                                     |
| --------------------------- | ---------------------------------------- |
| `/data/triggerfish.yaml`    | 設定                                     |
| `/data/secrets.json`        | ファイルバックドのシークレットストア      |
| `/data/data/triggerfish.db` | SQLiteデータベース（セッション、cron、メモリ） |
| `/data/workspace/`          | エージェントワークスペース               |
| `/data/skills/`             | インストール済みskill                    |
| `/data/logs/`               | ログファイル                             |
| `/data/SPINE.md`            | エージェントアイデンティティ             |

コンテナの再起動後も永続的に保存するには、名前付きボリューム（`-v triggerfish-data:/data`）
またはバインドマウントを使用してください。

### Dockerイメージのローカルビルド

```bash
make docker
# または
docker build -f deploy/docker/Dockerfile -t triggerfish:local .
```

### バージョンの固定（Docker）

```bash
docker pull ghcr.io/greghavens/triggerfish:v0.1.0
```

## ソースからインストール

ソースからビルドするか、コントリビューションする場合：

```bash
# 1. Denoのインストール（まだインストールしていない場合）
curl -fsSL https://deno.land/install.sh | sh

# 2. リポジトリのクローン
git clone https://github.com/greghavens/triggerfish.git
cd triggerfish

# 3. コンパイル
deno task compile

# 4. セットアップウィザードの実行
./triggerfish dive

# 5. （オプション）バックグラウンドデーモンとしてインストール
./triggerfish start
```

または、アーカイブされたソースからのインストールスクリプトを使用します：

```bash
bash deploy/scripts/install-from-source.sh     # Linux / macOS
deploy/scripts/install-from-source.ps1          # Windows
```

::: info ソースからのビルドにはDeno 2.xとgitが必要です。`deno task compile`コマンドは
外部依存関係のない自己完結型バイナリを生成します。 :::

## クロスプラットフォームバイナリビルド

任意のホストマシンからすべてのプラットフォーム向けバイナリをビルドするには：

```bash
make release
```

これにより、`dist/`に5つのバイナリとチェックサムが生成されます：

| ファイル                        | プラットフォーム           |
| ------------------------------ | -------------------------- |
| `triggerfish-linux-x64`       | Linux x86_64               |
| `triggerfish-linux-arm64`     | Linux ARM64                |
| `triggerfish-macos-x64`       | macOS Intel                |
| `triggerfish-macos-arm64`     | macOS Apple Silicon        |
| `triggerfish-windows-x64.exe` | Windows x86_64             |
| `SHA256SUMS.txt`              | 全バイナリのチェックサム   |

## ランタイムディレクトリ

`triggerfish dive`を実行した後、設定とデータは`~/.triggerfish/`にあります：

```
~/.triggerfish/
├── triggerfish.yaml          # メイン設定
├── SPINE.md                  # エージェントアイデンティティとミッション（システムプロンプト）
├── TRIGGER.md                # プロアクティブ動作トリガー
├── workspace/                # エージェントコードワークスペース
├── skills/                   # インストール済みskill
├── data/                     # SQLiteデータベース、セッション状態
└── logs/                     # デーモンと実行ログ
```

Dockerでは、これはコンテナ内の`/data/`にマッピングされます。

## デーモン管理

インストーラーはTriggerfishshをOS ネイティブのバックグラウンドサービスとして設定します：

| プラットフォーム | サービスマネージャー                     |
| --------------- | ---------------------------------------- |
| macOS           | launchd                                  |
| Linux           | systemd                                  |
| Windows         | Windows Service / Task Scheduler         |

インストール後、以下でデーモンを管理します：

```bash
triggerfish start     # デーモンのインストールと起動
triggerfish stop      # デーモンの停止
triggerfish status    # デーモンの実行状態確認
triggerfish logs      # デーモンログの表示
```

## リリースプロセス

リリースはGitHub Actionsで自動化されています。新しいリリースを作成するには：

```bash
git tag v0.2.0
git push origin v0.2.0
```

これにより、5つのプラットフォームバイナリをビルドし、チェックサム付きのGitHubリリースを
作成し、マルチアーキテクチャDockerイメージをGHCRにプッシュするリリースワークフローが
トリガーされます。インストールスクリプトは自動的に最新リリースをダウンロードします。

## アップデート

アップデートを確認してインストールするには：

```bash
triggerfish update
```

## プラットフォームサポート

| プラットフォーム | バイナリ | Docker | インストールスクリプト   |
| --------------- | -------- | ------ | ------------------------ |
| Linux x64       | あり     | あり   | あり                     |
| Linux arm64     | あり     | あり   | あり                     |
| macOS x64       | あり     | —      | あり                     |
| macOS arm64     | あり     | —      | あり                     |
| Windows x64     | あり     | —      | あり（PowerShell）       |

## 次のステップ

Triggerfishshのインストールが完了したら、[クイックスタート](./quickstart)ガイドに進んで
エージェントを設定してチャットを開始してください。
