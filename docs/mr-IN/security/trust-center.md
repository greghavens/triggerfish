---
title: Trust Center
description: Triggerfish साठी security controls, compliance posture, आणि architectural transparency.
---

# Trust Center

Triggerfish LLM layer च्या खाली deterministic code मध्ये security enforce करतो --
model ignore करू शकणाऱ्या prompts मध्ये नाही. प्रत्येक policy decision code द्वारे
घेतला जातो जो prompt injection, social engineering, किंवा model misbehavior द्वारे
influence केला जाऊ शकत नाही. Deep technical explanation साठी full [Security-First
Design](/mr-IN/security/) page पहा.

## Security Controls

हे controls current release मध्ये active आहेत. प्रत्येक code मध्ये enforced, CI
मध्ये tested, आणि open-source repository मध्ये auditable आहे.

| Control                        | Status                           | वर्णन                                                                                                                                                       |
| ------------------------------ | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sub-LLM Policy Enforcement     | <StatusBadge status="active" />  | आठ deterministic hooks प्रत्येक action ला LLM processing आधी आणि नंतर intercept करतात. Model security decisions bypass, modify, किंवा influence करू शकत नाही. |
| Data Classification System     | <StatusBadge status="active" />  | Mandatory no-write-down enforcement सह Four-level hierarchy (PUBLIC, INTERNAL, CONFIDENTIAL, RESTRICTED).                                                    |
| Session Taint Tracking         | <StatusBadge status="active" />  | प्रत्येक session accessed data चे highest classification track करतो. Taint फक्त escalate होतो, कधीच decrease नाही.                                          |
| Immutable Audit Logging        | <StatusBadge status="active" />  | सर्व policy decisions full context सह logged. Audit logging system च्या कोणत्याही component द्वारे disable केले जाऊ शकत नाही.                               |
| Secrets Isolation              | <StatusBadge status="active" />  | Credentials OS keychain किंवा vault मध्ये stored. Config files, storage, logs, किंवा LLM context मध्ये कधीच नाही.                                           |
| Plugin Sandboxing              | <StatusBadge status="active" />  | [प्लगइन](../integrations/plugins) |
| Dependency Scanning            | <StatusBadge status="active" />  | GitHub Dependabot द्वारे Automated vulnerability scanning. Upstream CVEs साठी PRs automatically उघडले जातात.                                                |
| Open Source Codebase           | <StatusBadge status="active" />  | Full security architecture Apache 2.0 licensed आणि publicly auditable आहे.                                                                                   |
| On-Premises Deployment         | <StatusBadge status="active" />  | पूर्णपणे तुमच्या infrastructure वर runs. कोणतेही cloud dependency नाही, telemetry नाही, external data processing नाही.                                       |
| Encryption                     | <StatusBadge status="active" />  | सर्व data in transit साठी TLS. OS-level encryption at rest. Enterprise vault integration available.                                                          |
| Responsible Disclosure Program | <StatusBadge status="active" />  | Defined response timelines सह Documented vulnerability reporting process. [disclosure policy](/mr-IN/security/responsible-disclosure) पहा.                    |
| Hardened Container Image       | <StatusBadge status="planned" /> | Near-zero CVEs सह Google Distroless base वर Docker images. CI मध्ये Automated Trivy scanning.                                                               |

## Defense in Depth -- 13 Independent Layers

कोणताही एक layer एकटा पुरेसा नाही. एक layer compromised झाल्यास, remaining layers
system protect करत राहतात.

| Layer | Name                         | Enforcement                                       |
| ----- | ---------------------------- | ------------------------------------------------- |
| 01    | Channel Authentication       | Session establishment वर Code-verified identity   |
| 02    | Permission-Aware Data Access | Source system permissions, system credentials नाही |
| 03    | Session Taint Tracking       | Automatic, mandatory, escalation-only             |
| 04    | Data Lineage                 | प्रत्येक data element साठी Full provenance chain   |
| 05    | Policy Enforcement Hooks     | Deterministic, non-bypassable, logged             |
| 06    | MCP Gateway                  | Per-tool permissions, server classification       |
| 07    | Plugin Sandbox               | [प्लगइन](../integrations/plugins) |
| 08    | Secrets Isolation            | OS keychain किंवा vault, LLM layer च्या खाली     |
| 09    | Filesystem Tool Sandbox      | Path jail, path classification, taint-scoped I/O  |
| 10    | Agent Identity & Delegation  | Cryptographic delegation chains                   |
| 11    | Audit Logging                | Disable केले जाऊ शकत नाही                        |
| 12    | SSRF Prevention              | IP denylist + DNS resolution checks               |
| 13    | Memory Classification Gating | स्वतःच्या level वर write करा, खाली read करा      |

Full [Defense in Depth](/mr-IN/architecture/defense-in-depth) architecture
documentation वाचा.

## Sub-LLM Enforcement का महत्त्वाचे आहे

::: info बहुतेक AI agent platforms system prompts द्वारे security enforce करतात --
LLM ला "sensitive data share करू नका" असे instructions. Prompt injection attacks या
instructions override करू शकतात.

Triggerfish एक different approach घेतो: LLM ला security decisions वर **zero authority**
आहे. सर्व enforcement LLM layer च्या खाली deterministic code मध्ये होते. LLM output
पासून security configuration पर्यंत कोणतेही pathway नाही. :::

## Compliance Roadmap

Triggerfish pre-certification आहे. आमचे security posture architectural आहे आणि
source code मध्ये आज verifiable आहे. Formal certifications roadmap वर आहेत.

| Certification                | Status                           | Notes                                                                 |
| ---------------------------- | -------------------------------- | --------------------------------------------------------------------- |
| SOC 2 Type I                 | <StatusBadge status="planned" /> | Security + Confidentiality trust services criteria                    |
| SOC 2 Type II                | <StatusBadge status="planned" /> | Observation period मध्ये Sustained control effectiveness              |
| HIPAA BAA                    | <StatusBadge status="planned" /> | Healthcare customers साठी Business associate agreement                |
| ISO 27001                    | <StatusBadge status="planned" /> | Information security management system                                |
| Third-Party Penetration Test | <StatusBadge status="planned" /> | Independent security assessment                                       |
| GDPR Compliance              | <StatusBadge status="planned" /> | Configurable retention आणि deletion सह Self-hosted architecture       |

## Trust वर एक नोट

::: tip Security core Apache 2.0 खाली open source आहे. तुम्ही policy enforcement
code ची प्रत्येक ओळ वाचू शकता, test suite run करू शकता, आणि claims स्वतः verify
करू शकता. Certifications roadmap वर आहेत. :::

## Source Audit करा

Full Triggerfish codebase
[github.com/greghavens/triggerfish](https://github.com/greghavens/triggerfish) वर
available आहे -- Apache 2.0 licensed.

## Vulnerability Reporting

तुम्हाला security vulnerability सापडल्यास, कृपया आमच्या [Responsible Disclosure
Policy](/mr-IN/security/responsible-disclosure) द्वारे report करा. Security
vulnerabilities साठी public GitHub issues उघडू नका.
