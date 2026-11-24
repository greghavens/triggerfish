---
title: 트러스트 센터
description: Triggerfish의 보안 통제, 컴플라이언스 현황, 아키텍처 투명성입니다.
---

# 트러스트 센터

Triggerfish는 모델이 무시할 수 있는 프롬프트가 아닌 -- LLM 계층 아래의 결정론적 코드에서 보안을 시행합니다. 모든 정책 결정은 프롬프트 인젝션, 사회 공학 또는 모델 오동작에 의해 영향을 받을 수 없는 코드로 이루어집니다. 심층 기술 설명은 [보안 우선 설계](/ko-KR/security/) 페이지를 참조하십시오.

## 보안 통제

이 통제는 현재 릴리스에서 활성화되어 있습니다. 각각은 코드로 시행되고 CI에서 테스트되며 오픈 소스 저장소에서 감사 가능합니다.

| 통제                       | 상태                             | 설명                                                                                                                                         |
| -------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Sub-LLM 정책 시행          | <StatusBadge status="active" />  | 8개의 결정론적 hook이 LLM 처리 전후에 모든 동작을 가로챕니다. 모델은 보안 결정을 우회, 수정 또는 영향을 미칠 수 없습니다.                      |
| 데이터 분류 시스템         | <StatusBadge status="active" />  | 4단계 계층 구조(PUBLIC, INTERNAL, CONFIDENTIAL, RESTRICTED)와 필수 no-write-down 시행입니다.                                                  |
| 세션 Taint 추적            | <StatusBadge status="active" />  | 모든 세션이 접근한 데이터의 최고 분류를 추적합니다. Taint는 상승만 가능하고 감소하지 않습니다.                                                 |
| 불변 감사 로깅             | <StatusBadge status="active" />  | 모든 정책 결정이 전체 컨텍스트와 함께 로깅됩니다. 감사 로깅은 시스템의 어떤 구성 요소도 비활성화할 수 없습니다.                                |
| 시크릿 격리                | <StatusBadge status="active" />  | 자격 증명은 OS 키체인 또는 vault에 저장됩니다. 구성 파일, 저장소, 로그 또는 LLM 컨텍스트에는 절대 없습니다.                                   |
| Plugin 샌드박싱            | <StatusBadge status="active" />  | [플러그인](../integrations/plugins) |
| 종속성 스캔                | <StatusBadge status="active" />  | GitHub Dependabot을 통한 자동 취약점 스캔입니다. 업스트림 CVE에 대해 자동으로 PR이 생성됩니다.                                                 |
| 오픈 소스 코드베이스       | <StatusBadge status="active" />  | 전체 보안 아키텍처가 Apache 2.0 라이선스이며 공개 감사 가능합니다.                                                                            |
| 온프레미스 배포            | <StatusBadge status="active" />  | 인프라에서 전적으로 실행됩니다. 클라우드 종속성 없음, 텔레메트리 없음, 외부 데이터 처리 없음.                                                  |
| 암호화                     | <StatusBadge status="active" />  | 전송 중 모든 데이터에 TLS. 저장 시 OS 수준 암호화. 엔터프라이즈 vault 연동 가능.                                                              |
| 책임 있는 공개 프로그램    | <StatusBadge status="active" />  | 정의된 대응 일정이 있는 문서화된 취약점 보고 프로세스입니다. [공개 정책](/ko-KR/security/responsible-disclosure)을 참조하십시오.                |
| 강화된 컨테이너 이미지     | <StatusBadge status="planned" /> | Google Distroless 기반의 거의 제로 CVE Docker 이미지입니다. CI에서 자동 Trivy 스캔.                                                           |

## 심층 방어 -- 13개 독립 계층

단일 계층만으로는 충분하지 않습니다. 한 계층이 손상되더라도 나머지 계층이 시스템을 계속 보호합니다.

| 계층 | 이름                       | 시행                                              |
| ---- | -------------------------- | ------------------------------------------------- |
| 01   | 채널 인증                  | 세션 수립 시 코드로 검증된 신원                    |
| 02   | 권한 인식 데이터 접근      | 시스템 자격 증명이 아닌 소스 시스템 권한           |
| 03   | 세션 Taint 추적            | 자동, 필수, 상승만 가능                            |
| 04   | 데이터 계보                | 모든 데이터 요소에 대한 완전한 출처 체인           |
| 05   | 정책 시행 Hook             | 결정론적, 우회 불가, 로깅됨                        |
| 06   | MCP Gateway                | 도구별 권한, 서버 분류                             |
| 07   | Plugin 샌드박스            | [플러그인](../integrations/plugins) |
| 08   | 시크릿 격리                | OS 키체인 또는 vault, LLM 계층 아래               |
| 09   | 파일시스템 도구 샌드박스   | 경로 제한, 경로 분류, taint 범위 I/O              |
| 10   | 에이전트 신원 및 위임      | 암호화 위임 체인                                   |
| 11   | 감사 로깅                  | 비활성화 불가                                      |
| 12   | SSRF 방지                  | IP 거부 목록 + DNS 확인 검사                       |
| 13   | 메모리 분류 게이팅         | 자체 수준에서 쓰기, 아래로만 읽기                  |

전체 [심층 방어](/ko-KR/architecture/defense-in-depth) 아키텍처 문서를 읽어보십시오.

## Sub-LLM 시행이 중요한 이유

::: info 대부분의 AI 에이전트 플랫폼은 시스템 프롬프트 -- "민감한 데이터를 공유하지 마십시오"라고 LLM에 지시하는 것 -- 를 통해 보안을 시행합니다. 프롬프트 인젝션 공격은 이러한 지시를 재정의할 수 있습니다.

Triggerfish는 다른 접근 방식을 취합니다: LLM은 보안 결정에 대해 **권한이 없습니다**. 모든 시행은 LLM 계층 아래의 결정론적 코드에서 발생합니다. LLM 출력에서 보안 구성으로의 경로가 없습니다. :::

## 컴플라이언스 로드맵

Triggerfish는 인증 전 단계입니다. 보안 현황은 아키텍처적이며 소스 코드에서 오늘 검증 가능합니다. 공식 인증은 로드맵에 있습니다.

| 인증                         | 상태                             | 비고                                                              |
| ---------------------------- | -------------------------------- | ----------------------------------------------------------------- |
| SOC 2 Type I                 | <StatusBadge status="planned" /> | 보안 + 기밀성 트러스트 서비스 기준                                |
| SOC 2 Type II                | <StatusBadge status="planned" /> | 관찰 기간 동안 지속적인 통제 효과                                 |
| HIPAA BAA                    | <StatusBadge status="planned" /> | 의료 고객을 위한 비즈니스 제휴 계약                               |
| ISO 27001                    | <StatusBadge status="planned" /> | 정보 보안 관리 시스템                                             |
| 타사 침투 테스트             | <StatusBadge status="planned" /> | 독립적인 보안 평가                                                |
| GDPR 준수                    | <StatusBadge status="planned" /> | 구성 가능한 보존 및 삭제를 갖춘 자체 호스팅 아키텍처              |

## 신뢰에 대한 참고

::: tip 보안 핵심은 Apache 2.0으로 오픈 소스입니다. 정책 시행 코드의 모든 줄을 읽고, 테스트 스위트를 실행하고, 주장을 직접 검증할 수 있습니다. 인증은 로드맵에 있습니다. :::

## 소스 감사

전체 Triggerfish 코드베이스는
[github.com/greghavens/triggerfish](https://github.com/greghavens/triggerfish)에서 사용 가능합니다 --
Apache 2.0 라이선스.

## 취약점 보고

보안 취약점을 발견한 경우 [책임 있는 공개 정책](/ko-KR/security/responsible-disclosure)을 통해 보고해 주십시오. 보안 취약점에 대해 공개 GitHub 이슈를 생성하지 마십시오.
