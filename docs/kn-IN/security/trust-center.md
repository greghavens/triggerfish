---
title: Trust Center
description: Triggerfish ಗಾಗಿ ಭದ್ರತಾ controls, compliance posture, ಮತ್ತು architectural transparency.
---

# Trust Center

Triggerfish ಭದ್ರತೆಯನ್ನು LLM layer ಕೆಳಗಿನ deterministic ಕೋಡ್‌ನಲ್ಲಿ ಜಾರಿಗೊಳಿಸುತ್ತದೆ -- model
ignore ಮಾಡಬಹುದಾದ prompts ನಲ್ಲಿ ಅಲ್ಲ. ಪ್ರತಿ policy ನಿರ್ಧಾರ prompt injection, social
engineering, ಅಥವಾ model misbehavior ನಿಂದ ಪ್ರಭಾವಿಸಲಾಗದ ಕೋಡ್‌ನಿಂದ ಮಾಡಲ್ಪಡುತ್ತದೆ. ಆಳವಾದ
ತಾಂತ್ರಿಕ ವಿವರಣೆಗಾಗಿ ಸಂಪೂರ್ಣ [ಭದ್ರತಾ-ಪ್ರಥಮ ವಿನ್ಯಾಸ](/kn-IN/security/) ಪುಟ ನೋಡಿ.

## ಭದ್ರತಾ Controls

ಈ controls ಪ್ರಸ್ತುತ release ನಲ್ಲಿ active. ಪ್ರತಿಯೊಂದು ಕೋಡ್‌ನಲ್ಲಿ ಜಾರಿಗೊಳ್ಳುತ್ತದೆ, CI ನಲ್ಲಿ
ಪರೀಕ್ಷಿಸಲ್ಪಡುತ್ತದೆ, ಮತ್ತು open-source repository ನಲ್ಲಿ auditable.

| Control                        | Status                           | ವಿವರಣೆ                                                                                                                                                |
| ------------------------------ | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sub-LLM Policy Enforcement     | <StatusBadge status="active" />  | ಎಂಟು deterministic hooks LLM processing ಮೊದಲು ಮತ್ತು ನಂತರ ಪ್ರತಿ ಕ್ರಿಯೆ ತಡೆಯುತ್ತವೆ. Model bypass, modify, ಅಥವಾ security decisions ಪ್ರಭಾವಿಸಲಾಗದು.     |
| Data Classification System     | <StatusBadge status="active" />  | Mandatory no-write-down enforcement ನೊಂದಿಗೆ ನಾಲ್ಕು-ಮಟ್ಟದ hierarchy (PUBLIC, INTERNAL, CONFIDENTIAL, RESTRICTED).                                      |
| Session Taint Tracking         | <StatusBadge status="active" />  | ಪ್ರತಿ session ಪ್ರವೇಶಿಸಿದ ಡೇಟಾದ ಅತ್ಯಧಿಕ classification ಟ್ರ್ಯಾಕ್ ಮಾಡುತ್ತದೆ. Taint ಮಾತ್ರ escalate ಮಾಡುತ್ತದೆ, ಎಂದಿಗೂ decrease ಮಾಡುವುದಿಲ್ಲ.               |
| Immutable Audit Logging        | <StatusBadge status="active" />  | ಎಲ್ಲ policy decisions ಸಂಪೂರ್ಣ context ನೊಂದಿಗೆ logged. Audit logging ವ್ಯವಸ್ಥೆಯ ಯಾವ component ನಿಂದಲೂ disable ಮಾಡಲಾಗದು.                                  |
| Secrets Isolation              | <StatusBadge status="active" />  | OS keychain ಅಥವಾ vault ನಲ್ಲಿ ಸಂಗ್ರಹಿಸಿದ Credentials. Config files, storage, logs, ಅಥವಾ LLM context ನಲ್ಲಿ ಎಂದಿಗೂ ಇಲ್ಲ.                               |
| Plugin Sandboxing              | <StatusBadge status="active" />  | [ಪ್ಲಗಿನ್‌ಗಳು](../integrations/plugins) |
| Dependency Scanning            | <StatusBadge status="active" />  | GitHub Dependabot ಮೂಲಕ ಸ್ವಯಂಚಾಲಿತ vulnerability scanning. Upstream CVEs ಗಾಗಿ PRs ಸ್ವಯಂಚಾಲಿತವಾಗಿ ತೆರೆಯಲ್ಪಡುತ್ತವೆ.                                      |
| Open Source Codebase           | <StatusBadge status="active" />  | ಸಂಪೂರ್ಣ ಭದ್ರತಾ architecture Apache 2.0 licensed ಮತ್ತು publicly auditable.                                                                              |
| On-Premises Deployment         | <StatusBadge status="active" />  | ಸಂಪೂರ್ಣ ನಿಮ್ಮ infrastructure ನಲ್ಲಿ ಚಲಿಸುತ್ತದೆ. Cloud dependency ಇಲ್ಲ, telemetry ಇಲ್ಲ, external data processing ಇಲ್ಲ.                                   |
| Encryption                     | <StatusBadge status="active" />  | Transit ನಲ್ಲಿ ಎಲ್ಲ ಡೇಟಾಗೆ TLS. OS-level rest ನಲ್ಲಿ encryption. Enterprise vault integration ಲಭ್ಯ.                                                      |
| Responsible Disclosure Program | <StatusBadge status="active" />  | ನಿರ್ಧರಿಸಿದ response timelines ನೊಂದಿಗೆ Documented vulnerability reporting process. [disclosure policy](/kn-IN/security/responsible-disclosure) ನೋಡಿ.    |
| Hardened Container Image       | <StatusBadge status="planned" /> | Near-zero CVEs ನೊಂದಿಗೆ Google Distroless base ನಲ್ಲಿ Docker images. CI ನಲ್ಲಿ ಸ್ವಯಂಚಾಲಿತ Trivy scanning.                                               |

## Defense in Depth -- 13 ಸ್ವತಂತ್ರ Layers

ಒಂದೇ layer ಸಾಕಾಗುವುದಿಲ್ಲ. ಒಂದು layer compromise ಆದರೆ, ಉಳಿದ layers ವ್ಯವಸ್ಥೆಯನ್ನು ರಕ್ಷಿಸುತ್ತಿರುತ್ತವೆ.

| Layer | ಹೆಸರು                         | Enforcement                                          |
| ----- | ------------------------------ | ---------------------------------------------------- |
| 01    | Channel Authentication         | Session ಸ್ಥಾಪನೆಯಲ್ಲಿ ಕೋಡ್-ಪರಿಶೀಲಿತ identity         |
| 02    | Permission-Aware Data Access   | Source system permissions, system credentials ಅಲ್ಲ  |
| 03    | Session Taint Tracking         | ಸ್ವಯಂಚಾಲಿತ, mandatory, escalation-only               |
| 04    | Data Lineage                   | ಪ್ರತಿ ಡೇಟಾ element ಗಾಗಿ ಸಂಪೂರ್ಣ provenance chain     |
| 05    | Policy Enforcement Hooks       | Deterministic, non-bypassable, logged                |
| 06    | MCP Gateway                    | Per-tool permissions, server classification          |
| 07    | Plugin Sandbox                 | [ಪ್ಲಗಿನ್‌ಗಳು](../integrations/plugins) |
| 08    | Secrets Isolation              | OS keychain ಅಥವಾ vault, LLM layer ಕೆಳಗೆ             |
| 09    | Filesystem Tool Sandbox        | Path jail, path classification, taint-scoped I/O     |
| 10    | Agent Identity & Delegation    | Cryptographic delegation chains                      |
| 11    | Audit Logging                  | Disable ಮಾಡಲಾಗದು                                    |
| 12    | SSRF Prevention                | IP denylist + DNS resolution checks                  |
| 13    | Memory Classification Gating   | ಸ್ವಂತ ಮಟ್ಟದಲ್ಲಿ ಬರೆಯಿರಿ, ಕೆಳಗೆ ಮಾತ್ರ ಓದಿರಿ          |

ಸಂಪೂರ್ಣ [Defense in Depth](/kn-IN/architecture/defense-in-depth) architecture documentation
ಓದಿ.

## Sub-LLM Enforcement ಏಕೆ ಮುಖ್ಯ

::: info ಹೆಚ್ಚಿನ AI agent platforms ಭದ್ರತೆಯನ್ನು system prompts ಮೂಲಕ ಜಾರಿಗೊಳಿಸುತ್ತವೆ --
LLM ಗೆ "sensitive data ಹಂಚಬೇಡ" ಎಂಬ ಸೂಚನೆಗಳು. Prompt injection attacks ಈ ಸೂಚನೆಗಳನ್ನು
override ಮಾಡಬಹುದು.

Triggerfish ಭಿನ್ನ ವಿಧಾನ ತೆಗೆದುಕೊಳ್ಳುತ್ತದೆ: LLM ಗೆ ಭದ್ರತಾ ನಿರ್ಧಾರಗಳ ಮೇಲೆ **ಶೂನ್ಯ ಅಧಿಕಾರ**
ಇದೆ. ಎಲ್ಲ enforcement LLM layer ಕೆಳಗಿನ deterministic ಕೋಡ್‌ನಲ್ಲಿ ಆಗುತ್ತದೆ. LLM output
ನಿಂದ security configuration ಗೆ ಯಾವ pathway ಇಲ್ಲ. :::

## Compliance Roadmap

Triggerfish pre-certification. ನಮ್ಮ ಭದ್ರತಾ posture architectural ಮತ್ತು ಇಂದು source code
ನಲ್ಲಿ verifiable. Formal certifications roadmap ನಲ್ಲಿ ಇವೆ.

| Certification                | Status                           | ಟಿಪ್ಪಣಿಗಳು                                                                    |
| ---------------------------- | -------------------------------- | ----------------------------------------------------------------------------- |
| SOC 2 Type I                 | <StatusBadge status="planned" /> | Security + Confidentiality trust services criteria                            |
| SOC 2 Type II                | <StatusBadge status="planned" /> | Observation period ಅಡ್ಡಲಾಗಿ sustained control effectiveness                   |
| HIPAA BAA                    | <StatusBadge status="planned" /> | Healthcare customers ಗಾಗಿ business associate agreement                        |
| ISO 27001                    | <StatusBadge status="planned" /> | Information security management system                                        |
| Third-Party Penetration Test | <StatusBadge status="planned" /> | ಸ್ವತಂತ್ರ ಭದ್ರತಾ ಮೌಲ್ಯಮಾಪನ                                                     |
| GDPR Compliance              | <StatusBadge status="planned" /> | Configurable retention ಮತ್ತು deletion ನೊಂದಿಗೆ self-hosted architecture         |

## Trust ಕುರಿತು ಒಂದು ಟಿಪ್ಪಣಿ

::: tip ಭದ್ರತಾ core Apache 2.0 ಅಡಿ open source. ನೀವು ಪ್ರತಿ policy enforcement code ಸಾಲು
ಓದಬಹುದು, test suite ರನ್ ಮಾಡಬಹುದು, ಮತ್ತು ಸ್ವತಃ claims ಪರಿಶೀಲಿಸಬಹುದು. Certifications
roadmap ನಲ್ಲಿ ಇವೆ. :::

## Source Audit ಮಾಡಿ

ಸಂಪೂರ್ಣ Triggerfish codebase
[github.com/greghavens/triggerfish](https://github.com/greghavens/triggerfish) ನಲ್ಲಿ
ಲಭ್ಯ -- Apache 2.0 licensed.

## Vulnerability Reporting

ಭದ್ರತಾ vulnerability ಕಂಡುಬಂದರೆ, ದಯವಿಟ್ಟು ನಮ್ಮ
[Responsible Disclosure Policy](/kn-IN/security/responsible-disclosure) ಮೂಲಕ ವರದಿ ಮಾಡಿ.
ಭದ್ರತಾ vulnerabilities ಗಾಗಿ public GitHub issues ತೆರೆಯಬೇಡಿ.
