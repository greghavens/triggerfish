---
title: நம்பிக்கை மையம்
description: Triggerfish க்கான பாதுகாப்பு கட்டுப்பாடுகள், compliance நிலை மற்றும் architectural வெளிப்படைத்தன்மை.
---

# நம்பிக்கை மையம்

Triggerfish LLM அடுக்கிற்கு கீழ் நிர்ணயவாத code இல் பாதுகாப்பை அமல்படுத்துகிறது -- மாதிரி ignore செய்யக்கூடிய prompts இல் அல்ல. ஒவ்வொரு policy முடிவும் prompt injection, social engineering அல்லது model misbehavior ஆல் தாக்க முடியாத code மூலம் எடுக்கப்படுகிறது. விரிவான தொழில்நுட்ப விளக்கத்திற்கு முழு [பாதுகாப்பு-முதல் Design](/ta-IN/security/) பக்கம் பாருங்கள்.

## பாதுகாப்பு கட்டுப்பாடுகள்

இந்த கட்டுப்பாடுகள் தற்போதைய release இல் active. ஒவ்வொன்றும் code இல் அமல்படுத்தப்பட்டது, CI இல் சோதிக்கப்பட்டது மற்றும் open-source repository இல் auditable.

| கட்டுப்பாடு                    | நிலை                             | விளக்கம்                                                                                                                       |
| ------------------------------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Sub-LLM Policy Enforcement     | <StatusBadge status="active" />  | எட்டு நிர்ணயவாத hooks LLM processing க்கு முன்னும் பின்னும் ஒவ்வொரு செயலையும் இடைமறிக்கின்றன.                              |
| Data வகைப்படுத்தல் கணினி       | <StatusBadge status="active" />  | நான்கு-நிலை hierarchy (PUBLIC, INTERNAL, CONFIDENTIAL, RESTRICTED) mandatory no-write-down அமலாக்கத்துடன்.                   |
| Session Taint கண்காணிப்பு      | <StatusBadge status="active" />  | ஒவ்வொரு session அணுகப்பட்ட data இன் உயர்ந்த வகைப்படுத்தலை கண்காணிக்கிறது. Taint மட்டுமே உயர்கிறது.                       |
| Immutable Audit Logging        | <StatusBadge status="active" />  | அனைத்து policy முடிவுகளும் முழு சூழலுடன் log ஆகும். Audit logging கணினியின் எந்த கூறாலும் முடக்க முடியாது.               |
| Secrets தனிமைப்படுத்தல்        | <StatusBadge status="active" />  | OS keychain அல்லது vault இல் Credentials சேமிக்கப்படுகின்றன. Config கோப்புகள், storage, logs அல்லது LLM context இல் ஒருபோதும் இல்லை. |
| Plugin Sandboxing              | <StatusBadge status="active" />  | [செருகுநிரல்கள்](../integrations/plugins) |
| Dependency Scanning            | <StatusBadge status="active" />  | GitHub Dependabot மூலம் automated vulnerability scanning. Upstream CVEs க்கு PRs தானாக திறக்கப்படுகின்றன.                  |
| Open Source Codebase           | <StatusBadge status="active" />  | முழு பாதுகாப்பு architecture Apache 2.0 licensed மற்றும் publicly auditable.                                                 |
| On-Premises Deployment         | <StatusBadge status="active" />  | முழுமையாக உங்கள் infrastructure இல் இயங்குகிறது. Cloud dependency இல்லை, telemetry இல்லை, வெளிப்புற data processing இல்லை. |
| Encryption                     | <StatusBadge status="active" />  | Transit இல் உள்ள தரவனைத்திற்கும் TLS. OS-level encryption at rest. Enterprise vault integration கிடைக்கும்.                |
| Responsible Disclosure Program | <StatusBadge status="active" />  | வரையறுக்கப்பட்ட response timelines உடன் ஆவணப்படுத்தப்பட்ட vulnerability reporting process. [disclosure policy](/ta-IN/security/responsible-disclosure) பாருங்கள். |
| Hardened Container Image       | <StatusBadge status="planned" /> | near-zero CVEs உடன் Google Distroless base மீது Docker images. CI இல் automated Trivy scanning.                               |

## ஆழமான பாதுகாப்பு — 13 சுயாதீன அடுக்குகள்

ஒரு அடுக்கும் தனியாக போதுமானதல்ல. ஒரு அடுக்கு சமரசம் ஆனால், மீதமுள்ள அடுக்குகள் கணினியை பாதுகாக்கத் தொடர்கின்றன.

| அடுக்கு | பெயர்                         | அமலாக்கம்                                         |
| ------- | ----------------------------- | -------------------------------------------------- |
| 01      | Channel Authentication        | Session establishment போது Code-verified அடையாளம் |
| 02      | Permission-Aware Data Access  | Source கணினி permissions, கணினி credentials அல்ல |
| 03      | Session Taint கண்காணிப்பு    | தானாக, mandatory, escalation-only                 |
| 04      | Data Lineage                  | ஒவ்வொரு data உறுப்பிற்கும் முழு provenance chain  |
| 05      | Policy Enforcement Hooks      | நிர்ணயவாதம், non-bypassable, logged               |
| 06      | MCP Gateway                   | Per-tool permissions, server classification        |
| 07      | Plugin Sandbox                | [செருகுநிரல்கள்](../integrations/plugins) |
| 08      | Secrets தனிமைப்படுத்தல்       | OS keychain அல்லது vault, LLM அடுக்கிற்கு கீழ்   |
| 09      | Filesystem Tool Sandbox       | Path jail, path classification, taint-scoped I/O   |
| 10      | Agent Identity & Delegation   | Cryptographic delegation chains                    |
| 11      | Audit Logging                 | அனைத்து முடிவுகளும் பதிவு, விதிவிலக்கு இல்லை    |
| 12      | SSRF தடுப்பு                  | IP denylist + DNS resolution checks                |
| 13      | Memory வகைப்படுத்தல் Gating   | Writes session taint க்கு கட்டாயப்படுத்தப்படுகின்றன |
