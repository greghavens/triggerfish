---
title: Trust Center
description: Mga security controls, compliance posture, at architectural transparency para sa Triggerfish.
---

# Trust Center

Ine-enforce ng Triggerfish ang security sa deterministic code sa ilalim ng LLM layer -- hindi sa prompts na maaaring balewalain ng model. Bawat policy decision ay ginagawa ng code na hindi maaaring impluwensyahan ng prompt injection, social engineering, o model misbehavior. Tingnan ang buong [Security-First Design](/fil-PH/security/) page para sa detalyadong teknikal na paliwanag.

## Mga Security Control

Aktibo ang mga controls na ito sa kasalukuyang release. Bawat isa ay ine-enforce sa code, tine-test sa CI, at maaaring i-audit sa open-source repository.

| Control                        | Status                           | Paglalarawan                                                                                                                                         |
| ------------------------------ | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sub-LLM Policy Enforcement     | <StatusBadge status="active" />  | Walong deterministic hooks ang nagha-harang sa bawat action bago at pagkatapos ng LLM processing. Hindi maaaring i-bypass, i-modify, o impluwensyahan ng model ang security decisions. |
| Data Classification System     | <StatusBadge status="active" />  | Apat na antas na hierarchy (PUBLIC, INTERNAL, CONFIDENTIAL, RESTRICTED) na may mandatory no-write-down enforcement.                                         |
| Session Taint Tracking         | <StatusBadge status="active" />  | Bawat session ay tina-track ang pinakamataas na classification ng data na na-access. Pataas lang ang taint, hindi bumababa.                                            |
| Immutable Audit Logging        | <StatusBadge status="active" />  | Lahat ng policy decisions ay nilo-log na may buong context. Hindi maaaring i-disable ang audit logging ng anumang component ng system.                                     |
| Secrets Isolation              | <StatusBadge status="active" />  | Mga credentials ay naka-store sa OS keychain o vault. Hindi kailanman sa config files, storage, logs, o LLM context.                                                   |
| Plugin Sandboxing              | <StatusBadge status="active" />  | [Mga plugin](../integrations/plugins) |
| Dependency Scanning            | <StatusBadge status="active" />  | Automated vulnerability scanning sa pamamagitan ng GitHub Dependabot. Awtomatikong nagbubukas ng PRs para sa upstream CVEs.                                                 |
| Open Source Codebase           | <StatusBadge status="active" />  | Ang buong security architecture ay Apache 2.0 licensed at publicly auditable.                                                                           |
| On-Premises Deployment         | <StatusBadge status="active" />  | Tumatakbo nang buo sa iyong infrastructure. Walang cloud dependency, walang telemetry, walang external data processing.                                               |
| Encryption                     | <StatusBadge status="active" />  | TLS para sa lahat ng data in transit. OS-level encryption at rest. Available ang enterprise vault integration.                                                   |
| Responsible Disclosure Program | <StatusBadge status="active" />  | Dokumentadong vulnerability reporting process na may defined response timelines. Tingnan ang [disclosure policy](/fil-PH/security/responsible-disclosure).              |
| Hardened Container Image       | <StatusBadge status="planned" /> | Docker images sa Google Distroless base na may halos zero CVEs. Automated Trivy scanning sa CI.                                                        |

## Defense in Depth -- 13 Independent Layers

Walang iisang layer na sapat sa sarili nito. Kung nakompromiso ang isang layer, patuloy na pinoprotektahan ng natitirang mga layers ang system.

| Layer | Pangalan                       | Enforcement                                       |
| ----- | ------------------------------ | ------------------------------------------------- |
| 01    | Channel Authentication         | Code-verified identity sa session establishment   |
| 02    | Permission-Aware Data Access   | Source system permissions, hindi system credentials |
| 03    | Session Taint Tracking         | Automatic, mandatory, escalation-only             |
| 04    | Data Lineage                   | Buong provenance chain para sa bawat data element |
| 05    | Policy Enforcement Hooks       | Deterministic, non-bypassable, logged             |
| 06    | MCP Gateway                    | Per-tool permissions, server classification       |
| 07    | Plugin Sandbox                 | [Mga plugin](../integrations/plugins) |
| 08    | Secrets Isolation              | OS keychain o vault, sa ilalim ng LLM layer       |
| 09    | Filesystem Tool Sandbox        | Path jail, path classification, taint-scoped I/O  |
| 10    | Agent Identity & Delegation    | Cryptographic delegation chains                   |
| 11    | Audit Logging                  | Hindi maaaring i-disable                          |
| 12    | SSRF Prevention                | IP denylist + DNS resolution checks               |
| 13    | Memory Classification Gating   | Write sa sariling level, read pababa lang          |

Basahin ang buong [Defense in Depth](/fil-PH/architecture/defense-in-depth) architecture documentation.

## Bakit Mahalaga ang Sub-LLM Enforcement

::: info Karamihan sa AI agent platforms ay nag-e-enforce ng security sa pamamagitan ng system prompts -- mga instruction sa LLM na nagsasabing "huwag magbahagi ng sensitive data." Maaaring i-override ng prompt injection attacks ang mga instructions na ito.

Ibang approach ang ginagamit ng Triggerfish: ang LLM ay may **zero authority** sa security decisions. Lahat ng enforcement ay nangyayari sa deterministic code sa ilalim ng LLM layer. Walang pathway mula sa LLM output papunta sa security configuration. :::

## Compliance Roadmap

Pre-certification ang Triggerfish. Ang aming security posture ay architectural at mave-verify sa source code ngayon. Ang formal certifications ay nasa roadmap.

| Certification                | Status                           | Mga Tala                                                          |
| ---------------------------- | -------------------------------- | ----------------------------------------------------------------- |
| SOC 2 Type I                 | <StatusBadge status="planned" /> | Security + Confidentiality trust services criteria                |
| SOC 2 Type II                | <StatusBadge status="planned" /> | Sustained control effectiveness sa observation period             |
| HIPAA BAA                    | <StatusBadge status="planned" /> | Business associate agreement para sa healthcare customers         |
| ISO 27001                    | <StatusBadge status="planned" /> | Information security management system                            |
| Third-Party Penetration Test | <StatusBadge status="planned" /> | Independent security assessment                                   |
| GDPR Compliance              | <StatusBadge status="planned" /> | Self-hosted architecture na may configurable retention at deletion |

## Tungkol sa Trust

::: tip Ang security core ay open source sa ilalim ng Apache 2.0. Maaari mong basahin ang bawat linya ng policy enforcement code, patakbuhin ang test suite, at i-verify ang mga claims mo mismo. Ang certifications ay nasa roadmap. :::

## I-audit ang Source

Ang buong Triggerfish codebase ay available sa [github.com/greghavens/triggerfish](https://github.com/greghavens/triggerfish) -- Apache 2.0 licensed.

## Pag-report ng Vulnerability

Kung nakadiskubre ka ng security vulnerability, mangyaring i-report ito sa pamamagitan ng aming [Patakaran sa Responsible Disclosure](/fil-PH/security/responsible-disclosure). Huwag magbukas ng public GitHub issues para sa security vulnerabilities.
