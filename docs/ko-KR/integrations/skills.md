# Skills 플랫폼

Skills는 Triggerfish의 주요 확장성 메커니즘입니다. 스킬은 `SKILL.md` 파일이 포함된 폴더입니다 -- 플러그인을 작성하거나 사용자 정의 코드를 빌드할 필요 없이 에이전트에 새로운 기능을 부여하는 지침과 메타데이터입니다.

스킬은 에이전트가 새로운 것을 배우는 방법입니다: 캘린더 확인, 아침 브리핑 준비, GitHub 이슈 분류, 주간 요약 작성. 마켓플레이스에서 설치하거나, 직접 작성하거나, 에이전트가 자체 저작할 수 있습니다.

## 스킬이란?

스킬은 루트에 `SKILL.md` 파일이 있는 폴더입니다. 이 파일에는 YAML 프론트매터(메타데이터)와 마크다운 본문(에이전트를 위한 지침)이 포함됩니다. 선택적인 지원 파일 -- 스크립트, 템플릿, 구성 -- 이 함께 있을 수 있습니다.

```
morning-briefing/
  SKILL.md
  briefing.ts        # 선택적 지원 코드
  template.md        # 선택적 템플릿
```

`SKILL.md` 프론트매터는 스킬이 수행하는 작업, 필요한 것 및 적용되는 보안 제약 조건을 선언합니다:

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

## 지침

트리거 시(매일 오전 7시) 또는 사용자가 호출할 때:

1. Google Calendar에서 오늘의 캘린더 이벤트를 가져옵니다
2. 지난 12시간의 읽지 않은 이메일을 요약합니다
3. 사용자 위치의 날씨 예보를 가져옵니다
4. 간결한 브리핑을 작성하여 구성된 채널로 전달합니다

캘린더, 이메일, 날씨 섹션으로 브리핑을 구성합니다.
스캔하기 쉽게 유지합니다 -- 문단이 아닌 글머리 기호를 사용합니다.
```

### 프론트매터 필드

| 필드                                          | 필수 | 설명                                                               |
| --------------------------------------------- | :--: | ------------------------------------------------------------------ |
| `name`                                        |  예  | 고유 스킬 식별자                                                   |
| `description`                                 |  예  | 스킬이 수행하는 작업에 대한 사람이 읽을 수 있는 설명               |
| `version`                                     |  예  | 시맨틱 버전                                                        |
| `category`                                    | 아니오 | 그룹화 카테고리 (productivity, development, communication 등)     |
| `tags`                                        | 아니오 | 검색 가능한 태그                                                   |
| `triggers`                                    | 아니오 | 자동 호출 규칙 (cron 일정, 이벤트 패턴)                           |
| `metadata.triggerfish.classification_ceiling`  | 아니오 | 이 스킬이 도달할 수 있는 최대 테인트 등급 (기본값: `PUBLIC`)      |
| `metadata.triggerfish.requires_tools`          | 아니오 | 스킬이 의존하는 도구 (browser, exec 등)                           |
| `metadata.triggerfish.network_domains`         | 아니오 | 스킬에 허용된 네트워크 엔드포인트                                 |

## 스킬 유형

Triggerfish는 세 가지 유형의 스킬을 지원하며, 이름이 충돌할 때 명확한 우선 순위를 가집니다.

### 번들 스킬

`skills/bundled/` 디렉토리에서 Triggerfish와 함께 제공됩니다. 프로젝트에서 유지 관리합니다. 항상 사용 가능합니다.

Triggerfish에는 에이전트가 첫날부터 자립할 수 있게 하는 10개의 번들 스킬이 포함됩니다:

| 스킬                      | 설명                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **tdd**                   | Deno 2.x용 테스트 주도 개발 방법론. 레드-그린-리팩터 주기, `Deno.test()` 패턴, `@std/assert` 사용법, Result 타입 테스트, 테스트 헬퍼.             |
| **mastering-typescript**  | Deno 및 Triggerfish용 TypeScript 패턴. 엄격 모드, `Result<T, E>`, 브랜드 타입, 팩토리 함수, 불변 인터페이스, `mod.ts` 배럴.                       |
| **skill-builder**         | 새로운 스킬 저작 방법. SKILL.md 형식, 프론트매터 필드, 분류 상한, 자체 저작 워크플로우, 보안 스캐닝.                                             |
| **integration-builder**   | Triggerfish 통합 구축 방법. 채널 어댑터, LLM 프로바이더, MCP 서버, 스토리지 프로바이더, 실행 도구, 플러그인의 6가지 패턴.                        |
| **git-branch-management** | 개발용 Git 브랜치 워크플로우. 피처 브랜치, 원자적 커밋, `gh` CLI를 통한 PR 생성, PR 추적, webhook을 통한 리뷰 피드백 루프, 병합 및 정리.        |
| **deep-research**         | 다단계 리서치 방법론. 소스 평가, 병렬 검색, 합성 및 인용 포맷.                                                                                  |
| **pdf**                   | PDF 문서 처리. PDF 파일에서 텍스트 추출, 요약 및 구조화된 데이터 추출.                                                                           |
| **triggerfish**           | Triggerfish 내부에 대한 자기 지식. 아키텍처, 구성, 문제 해결 및 개발 패턴.                                                                       |
| **triggers**              | 능동적 동작 저작. 효과적인 TRIGGER.md 파일 작성, 모니터링 패턴 및 에스컬레이션 규칙.                                                             |

이것은 부트스트랩 스킬입니다 -- 에이전트가 자신을 확장하는 데 사용합니다. skill-builder는 에이전트에게 새로운 스킬 생성 방법을 가르치고, integration-builder는 새로운 어댑터와 프로바이더 구축 방법을 가르칩니다.

자체 스킬 생성에 대한 실습 가이드는 [스킬 구축](/ko-KR/integrations/building-skills)을 참조하십시오.

### 관리형 스킬

**The Reef** (커뮤니티 스킬 마켓플레이스)에서 설치됩니다. `~/.triggerfish/skills/`에 다운로드 및 저장됩니다.

```bash
triggerfish skill install google-cal
triggerfish skill install github-triage
```

### 워크스페이스 스킬

사용자가 생성하거나 [실행 환경](./exec-environment)에서 에이전트가 저작합니다. 에이전트의 워크스페이스 `~/.triggerfish/workspace/<agent-id>/skills/`에 저장됩니다.

워크스페이스 스킬이 가장 높은 우선 순위를 가집니다. 번들 또는 관리형 스킬과 동일한 이름의 스킬을 생성하면 사용자 버전이 우선합니다.

```
우선 순위:  Workspace  >  Managed  >  Bundled
```

::: tip 이 우선 순위 순서는 번들 또는 마켓플레이스 스킬을 항상 자체 버전으로 재정의할 수 있음을 의미합니다. 사용자 정의는 업데이트에 의해 덮어쓰이지 않습니다. :::

## 에이전트 자체 저작

핵심 차별화 요소: 에이전트가 자체 스킬을 작성할 수 있습니다. 수행 방법을 모르는 작업을 요청받으면 에이전트는 [실행 환경](./exec-environment)을 사용하여 `SKILL.md`와 지원 코드를 생성한 다음 워크스페이스 스킬로 패키징할 수 있습니다.

### 자체 저작 흐름

```
1. 사용자: "매일 아침 Notion에서 새 작업을 확인해야 합니다"
2. 에이전트: ~/.triggerfish/workspace/<agent-id>/skills/notion-tasks/에 스킬 생성
          메타데이터와 지침이 포함된 SKILL.md 작성
          지원 코드 작성 (notion-tasks.ts)
          실행 환경에서 코드 테스트
3. 에이전트: 스킬을 PENDING_APPROVAL로 표시
4. 사용자: 알림 수신: "새 스킬 생성: notion-tasks. 검토 및 승인하시겠습니까?"
5. 사용자: 스킬 승인
6. 에이전트: 매일 실행을 위한 cron 작업에 스킬 연결
```

::: warning 보안 에이전트가 저작한 스킬은 활성화되기 전에 항상 소유자 승인이 필요합니다. 에이전트는 자체 스킬을 자체 승인할 수 없습니다. 이를 통해 에이전트가 사용자의 감독을 우회하는 기능을 생성하는 것을 방지합니다. :::

## The Reef <ComingSoon :inline="true" />

The Reef는 Triggerfish의 커뮤니티 스킬 마켓플레이스입니다 -- 스킬을 발견, 설치, 게시 및 공유할 수 있는 레지스트리입니다.

| 기능              | 설명                                                     |
| ----------------- | -------------------------------------------------------- |
| 검색 및 탐색      | 카테고리, 태그 또는 인기도로 스킬 찾기                   |
| 원 커맨드 설치    | `triggerfish skill install <name>`                       |
| 게시              | 커뮤니티와 스킬 공유                                     |
| 보안 스캐닝       | 목록 등록 전 악성 패턴에 대한 자동 스캐닝                |
| 버전 관리         | 업데이트 관리가 있는 스킬 버전 관리                      |
| 리뷰 및 평가      | 스킬 품질에 대한 커뮤니티 피드백                          |

## 스킬 보안 요약

- 스킬은 보안 요구 사항을 사전에 선언합니다 (분류 상한, 도구, 네트워크 도메인)
- 도구 접근은 정책에 의해 게이트됩니다 -- `requires_tools: [browser]`인 스킬은 정책에 의해 브라우저 접근이 차단되면 작동하지 않습니다
- 네트워크 도메인이 적용됩니다 -- 스킬은 선언하지 않은 엔드포인트에 접근할 수 없습니다
- 에이전트가 저작한 스킬은 명시적인 소유자/관리자 승인이 필요합니다
- 모든 스킬 호출은 정책 훅을 통과하며 완전히 감사됩니다
