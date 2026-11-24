# 설치 및 배포

Triggerfish는 macOS, Linux, Windows, Docker에서 단일 명령으로 설치됩니다. 바이너리 설치 프로그램은 사전 빌드된 릴리스를 다운로드하고, SHA256 체크섬을 검증하며, 설정 마법사를 실행합니다.

## 단일 명령 설치

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

### 바이너리 설치 프로그램의 동작

1. **플랫폼** 및 아키텍처를 감지합니다
2. GitHub Releases에서 최신 사전 빌드된 바이너리를 **다운로드**합니다
3. 무결성을 확인하기 위해 **SHA256 체크섬을 검증**합니다
4. `/usr/local/bin` (또는 `~/.local/bin` / `%LOCALAPPDATA%\Triggerfish`)에 바이너리를 **설치**합니다
5. **설정 마법사**(`triggerfish dive`)를 실행하여 에이전트, LLM 제공자, 채널을 구성합니다
6. **백그라운드 데몬을 시작**하여 에이전트가 항상 실행되도록 합니다

설치 프로그램이 완료되면 완전히 작동하는 에이전트를 갖게 됩니다. 추가 단계가 필요하지 않습니다.

### 특정 버전 설치

```bash
# Bash
curl -fsSL https://raw.githubusercontent.com/greghavens/triggerfish/master/scripts/install.sh | TRIGGERFISH_VERSION=v0.7.19 bash

# PowerShell
$env:TRIGGERFISH_VERSION = "v0.1.0"; irm .../scripts/install.ps1 | iex
```

## 시스템 요구 사항

| 요구 사항     | 세부 사항                                              |
| ------------- | ------------------------------------------------------ |
| 운영 체제     | macOS, Linux 또는 Windows                              |
| 디스크 공간   | 컴파일된 바이너리에 약 100 MB                          |
| 네트워크      | LLM API 호출에 필요; 모든 처리는 로컬에서 실행됩니다   |

::: tip Docker, 컨테이너, 클라우드 계정이 필요하지 않습니다. Triggerfish는 사용자의 머신에서 실행되는 단일 바이너리입니다. Docker는 대안적 배포 방법으로 사용할 수 있습니다. :::

## Docker

Docker 배포는 네이티브 바이너리와 동일한 명령 경험을 제공하는 `triggerfish` CLI 래퍼를 제공합니다. 모든 데이터는 명명된 Docker 볼륨에 저장됩니다.

### 빠른 시작

설치 프로그램이 이미지를 풀링하고, CLI 래퍼를 설치하며, 설정 마법사를 실행합니다:

```bash
curl -sSL https://raw.githubusercontent.com/greghavens/triggerfish/master/deploy/docker/install.sh | sh
```

또는 로컬 체크아웃에서 설치 프로그램을 실행합니다:

```bash
./deploy/docker/install.sh
```

설치 프로그램이 수행하는 작업:

1. 컨테이너 런타임(podman 또는 docker)을 감지합니다
2. `~/.local/bin` (또는 `/usr/local/bin`)에 `triggerfish` CLI 래퍼를 설치합니다
3. `~/.triggerfish/docker/`에 compose 파일을 복사합니다
4. 최신 이미지를 풀링합니다
5. 일회성 컨테이너에서 설정 마법사(`triggerfish dive`)를 실행합니다
6. 서비스를 시작합니다

### 일상적인 사용

설치 후 `triggerfish` 명령은 네이티브 바이너리와 동일하게 작동합니다:

```bash
triggerfish chat              # 대화형 채팅 세션
triggerfish config set-secret provider:anthropic:apiKey sk-ant-...
triggerfish patrol            # 상태 진단
triggerfish logs              # 컨테이너 로그 보기
triggerfish status            # 컨테이너 실행 여부 확인
triggerfish stop              # 컨테이너 중지
triggerfish start             # 컨테이너 시작
triggerfish update            # 최신 이미지 풀링 및 재시작
triggerfish dive              # 설정 마법사 재실행
```

### 래퍼 동작 방식

래퍼 스크립트(`deploy/docker/triggerfish`)는 명령을 라우팅합니다:

| 명령            | 동작                                                          |
| --------------- | ------------------------------------------------------------- |
| `start`         | compose를 통해 컨테이너 시작                                  |
| `stop`          | compose를 통해 컨테이너 중지                                  |
| `run`           | 포그라운드에서 실행 (Ctrl+C로 중지)                           |
| `status`        | 컨테이너 실행 상태 표시                                       |
| `logs`          | 컨테이너 로그 스트리밍                                        |
| `update`        | 최신 이미지 풀링, 재시작                                      |
| `dive`          | 실행 중이 아니면 일회성 컨테이너; 실행 중이면 exec + 재시작   |
| 기타 모든 명령  | 실행 중인 컨테이너에 `exec`                                   |

래퍼는 `podman`과 `docker`를 자동 감지합니다. `TRIGGERFISH_CONTAINER_RUNTIME=docker`로 재정의할 수 있습니다.

### Docker Compose

compose 파일은 설치 후 `~/.triggerfish/docker/docker-compose.yml`에 위치합니다. 직접 사용할 수도 있습니다:

```bash
cd deploy/docker
docker compose up -d
```

### 환경 변수

compose 파일과 함께 `.env.example`을 `.env`로 복사하여 환경 변수를 통해 API 키를 설정합니다:

```bash
cp deploy/docker/.env.example ~/.triggerfish/docker/.env
# ~/.triggerfish/docker/.env 편집
```

API 키는 일반적으로 `triggerfish config set-secret`을 통해 저장되지만(데이터 볼륨에 유지됨), 환경 변수도 대안으로 사용할 수 있습니다.

### Docker에서의 시크릿

컨테이너에서는 OS 키체인을 사용할 수 없으므로, Triggerfish는 볼륨 내 `/data/secrets.json`에 파일 기반 시크릿 저장소를 사용합니다. CLI 래퍼를 사용하여 시크릿을 관리합니다:

```bash
triggerfish config set-secret provider:anthropic:apiKey sk-ant-...
triggerfish config set-secret provider:brave:apiKey BSA...
```

### 데이터 영속성

컨테이너는 모든 데이터를 `/data` 하위에 저장합니다:

| 경로                        | 내용                                      |
| --------------------------- | ----------------------------------------- |
| `/data/triggerfish.yaml`    | 구성                                      |
| `/data/secrets.json`        | 파일 기반 시크릿 저장소                   |
| `/data/data/triggerfish.db` | SQLite 데이터베이스 (세션, cron, 메모리)  |
| `/data/workspace/`          | 에이전트 워크스페이스                     |
| `/data/skills/`             | 설치된 스킬                               |
| `/data/logs/`               | 로그 파일                                 |
| `/data/SPINE.md`            | 에이전트 정체성                           |

명명된 볼륨(`-v triggerfish-data:/data`) 또는 바인드 마운트를 사용하여 컨테이너 재시작 간 데이터를 유지합니다.

### Docker 이미지 로컬 빌드

```bash
make docker
# 또는
docker build -f deploy/docker/Dockerfile -t triggerfish:local .
```

### 버전 고정 (Docker)

```bash
docker pull ghcr.io/greghavens/triggerfish:v0.1.0
```

## 소스에서 설치

소스에서 빌드하거나 기여하려는 경우:

```bash
# 1. Deno 설치 (없는 경우)
curl -fsSL https://deno.land/install.sh | sh

# 2. 리포지토리 클론
git clone https://github.com/greghavens/triggerfish.git
cd triggerfish

# 3. 컴파일
deno task compile

# 4. 설정 마법사 실행
./triggerfish dive

# 5. (선택 사항) 백그라운드 데몬으로 설치
./triggerfish start
```

또는 아카이브된 소스 설치 스크립트를 사용합니다:

```bash
bash deploy/scripts/install-from-source.sh     # Linux / macOS
deploy/scripts/install-from-source.ps1          # Windows
```

::: info 소스에서 빌드하려면 Deno 2.x와 git이 필요합니다. `deno task compile` 명령은 외부 의존성이 없는 독립 바이너리를 생성합니다. :::

## 크로스 플랫폼 바이너리 빌드

모든 호스트 머신에서 모든 플랫폼용 바이너리를 빌드하려면:

```bash
make release
```

이 명령은 `dist/`에 5개의 바이너리와 체크섬을 생성합니다:

| 파일                          | 플랫폼                     |
| ----------------------------- | -------------------------- |
| `triggerfish-linux-x64`       | Linux x86_64               |
| `triggerfish-linux-arm64`     | Linux ARM64                |
| `triggerfish-macos-x64`       | macOS Intel                |
| `triggerfish-macos-arm64`     | macOS Apple Silicon        |
| `triggerfish-windows-x64.exe` | Windows x86_64             |
| `SHA256SUMS.txt`              | 모든 바이너리의 체크섬     |

## 런타임 디렉터리

`triggerfish dive`를 실행한 후 구성과 데이터는 `~/.triggerfish/`에 저장됩니다:

```
~/.triggerfish/
├── triggerfish.yaml          # 주요 구성
├── SPINE.md                  # 에이전트 정체성 및 미션 (시스템 프롬프트)
├── TRIGGER.md                # 능동적 행동 트리거
├── workspace/                # 에이전트 코드 워크스페이스
├── skills/                   # 설치된 스킬
├── data/                     # SQLite 데이터베이스, 세션 상태
└── logs/                     # 데몬 및 실행 로그
```

Docker에서는 컨테이너 내부의 `/data/`에 매핑됩니다.

## 데몬 관리

설치 프로그램은 Triggerfish를 OS 네이티브 백그라운드 서비스로 설정합니다:

| 플랫폼  | 서비스 관리자                          |
| ------- | -------------------------------------- |
| macOS   | launchd                               |
| Linux   | systemd                               |
| Windows | Windows 서비스 / 작업 스케줄러         |

설치 후 데몬을 관리합니다:

```bash
triggerfish start     # 데몬 설치 및 시작
triggerfish stop      # 데몬 중지
triggerfish status    # 데몬 실행 여부 확인
triggerfish logs      # 데몬 로그 보기
```

## 릴리스 프로세스

릴리스는 GitHub Actions를 통해 자동화됩니다. 새 릴리스를 생성하려면:

```bash
git tag v0.2.0
git push origin v0.2.0
```

이 명령은 5개의 플랫폼 바이너리를 빌드하고, 체크섬이 포함된 GitHub 릴리스를 생성하며, 멀티 아키텍처 Docker 이미지를 GHCR에 푸시하는 릴리스 워크플로우를 트리거합니다. 설치 스크립트는 자동으로 최신 릴리스를 다운로드합니다.

## 업데이트

업데이트를 확인하고 설치하려면:

```bash
triggerfish update
```

## 플랫폼 지원

| 플랫폼      | 바이너리 | Docker | 설치 스크립트     |
| ----------- | -------- | ------ | ----------------- |
| Linux x64   | 예       | 예     | 예                |
| Linux arm64 | 예       | 예     | 예                |
| macOS x64   | 예       | —      | 예                |
| macOS arm64 | 예       | —      | 예                |
| Windows x64 | 예       | —      | 예 (PowerShell)   |

## 다음 단계

Triggerfish가 설치되면 [빠른 시작](./quickstart) 가이드로 이동하여 에이전트를 구성하고 채팅을 시작하십시오.
