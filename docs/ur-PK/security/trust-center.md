---
title: Trust Center
description: Triggerfish کے لیے سیکیورٹی کنٹرولز، compliance posture، اور architectural transparency۔
---

# Trust Center

Triggerfish سیکیورٹی LLM layer کے نیچے یقینی کوڈ میں نافذ کرتا ہے — ایسے prompts
میں نہیں جنہیں model نظرانداز کر سکے۔ ہر policy فیصلہ ایسے کوڈ کے ذریعے کیا جاتا
ہے جسے prompt injection، social engineering، یا model misbehavior متاثر نہیں کر سکتا۔
گہری تکنیکی وضاحت کے لیے مکمل [سیکیورٹی-اول ڈیزائن](/ur-PK/security/) صفحہ دیکھیں۔

## سیکیورٹی کنٹرولز

یہ کنٹرولز موجودہ release میں فعال ہیں۔ ہر ایک کوڈ میں نافذ، CI میں tested، اور
open-source repository میں auditable ہے۔

| کنٹرول                         | Status                           | تفصیل                                                                                                                                                                                    |
| ------------------------------ | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sub-LLM Policy Enforcement     | <StatusBadge status="active" />  | آٹھ یقینی hooks LLM processing سے پہلے اور بعد ہر عمل کو intercept کرتے ہیں۔ Model سیکیورٹی فیصلوں کو bypass، modify، یا متاثر نہیں کر سکتا۔                                          |
| Data Classification System     | <StatusBadge status="active" />  | چار سطحوں کا hierarchy (PUBLIC، INTERNAL، CONFIDENTIAL، RESTRICTED) لازمی no-write-down نافذ کاری کے ساتھ۔                                                                             |
| Session Taint Tracking         | <StatusBadge status="active" />  | ہر session access کیے گئے ڈیٹا کی سب سے اونچی classification track کرتا ہے۔ Taint صرف escalate ہوتا ہے، کبھی کم نہیں۔                                                                  |
| Immutable Audit Logging        | <StatusBadge status="active" />  | تمام policy فیصلے مکمل context کے ساتھ logged۔ Audit logging سسٹم کے کسی بھی component کے ذریعے غیر فعال نہیں کی جا سکتی۔                                                            |
| Secrets Isolation              | <StatusBadge status="active" />  | Credentials OS keychain یا vault میں محفوظ۔ Config files، storage، logs، یا LLM context میں کبھی نہیں۔                                                                                 |
| Plugin Sandboxing              | <StatusBadge status="active" />  | [پلگ ان](../integrations/plugins) |
| Dependency Scanning            | <StatusBadge status="active" />  | GitHub Dependabot کے ذریعے automated vulnerability scanning۔ Upstream CVEs کے لیے خود بخود PRs کھلتے ہیں۔                                                                             |
| Open Source Codebase           | <StatusBadge status="active" />  | مکمل سیکیورٹی architecture Apache 2.0 licensed اور publicly auditable ہے۔                                                                                                               |
| On-Premises Deployment         | <StatusBadge status="active" />  | مکمل طور پر آپ کے infrastructure پر چلتا ہے۔ کوئی cloud dependency نہیں، کوئی telemetry نہیں، کوئی external data processing نہیں۔                                                     |
| Encryption                     | <StatusBadge status="active" />  | Transit میں تمام ڈیٹا کے لیے TLS۔ Rest پر OS-level encryption۔ Enterprise vault integration دستیاب۔                                                                                    |
| Responsible Disclosure Program | <StatusBadge status="active" />  | Defined response timelines کے ساتھ documented vulnerability reporting process۔ [disclosure policy](/ur-PK/security/responsible-disclosure) دیکھیں۔                                     |
| Hardened Container Image       | <StatusBadge status="planned" /> | Google Distroless base کے ساتھ Docker images، تقریباً صفر CVEs۔ CI میں automated Trivy scanning۔                                                                                       |

## Defense in Depth — 13 آزاد پرتیں

کوئی ایک پرت اکیلے کافی نہیں۔ اگر ایک پرت compromised ہو، تو بقیہ پرتیں سسٹم کی
حفاظت جاری رکھتی ہیں۔

| پرت | نام                          | نافذ کاری                                                          |
| --- | ---------------------------- | ------------------------------------------------------------------ |
| 01  | Channel Authentication       | Session establishment پر code-verified شناخت                       |
| 02  | Permission-Aware Data Access | Source system permissions، system credentials نہیں                 |
| 03  | Session Taint Tracking       | خودکار، لازمی، صرف escalation                                      |
| 04  | Data Lineage                 | ہر ڈیٹا element کے لیے مکمل provenance chain                       |
| 05  | Policy Enforcement Hooks     | یقینی، non-bypassable، logged                                      |
| 06  | MCP Gateway                  | Per-tool permissions، server classification                        |
| 07  | Plugin Sandbox               | [پلگ ان](../integrations/plugins) |
| 08  | Secrets Isolation            | OS keychain یا vault، LLM layer کے نیچے                            |
| 09  | Filesystem Tool Sandbox      | Path jail، path classification، taint-scoped I/O                  |
| 10  | Agent Identity & Delegation  | Cryptographic delegation chains                                    |
| 11  | Audit Logging                | غیر فعال نہیں کی جا سکتی                                           |
| 12  | SSRF Prevention              | IP denylist + DNS resolution checks                                |
| 13  | Memory Classification Gating | اپنی سطح پر لکھیں، صرف نیچے پڑھیں                                 |

مکمل [Defense in Depth](/ur-PK/architecture/defense-in-depth) architecture documentation
پڑھیں۔

## Sub-LLM Enforcement کیوں اہم ہے

::: info زیادہ تر AI agent platforms سیکیورٹی system prompts کے ذریعے نافذ کرتے ہیں
— LLM کو ہدایات کہ "حساس ڈیٹا share نہ کریں۔" Prompt injection attacks یہ ہدایات
override کر سکتے ہیں۔

Triggerfish ایک مختلف نقطہ نظر اختیار کرتا ہے: LLM کا سیکیورٹی فیصلوں پر **صفر
اختیار** ہے۔ تمام نافذ کاری LLM layer کے نیچے یقینی کوڈ میں ہوتی ہے۔ LLM output سے
سیکیورٹی configuration تک کوئی راستہ نہیں ہے۔ :::

## Compliance Roadmap

Triggerfish pre-certification ہے۔ ہماری سیکیورٹی posture architectural اور آج source
code میں قابل تصدیق ہے۔ رسمی certifications roadmap پر ہیں۔

| Certification                | Status                           | نوٹس                                                                       |
| ---------------------------- | -------------------------------- | -------------------------------------------------------------------------- |
| SOC 2 Type I                 | <StatusBadge status="planned" /> | Security + Confidentiality trust services criteria                         |
| SOC 2 Type II                | <StatusBadge status="planned" /> | Observation period میں sustained control effectiveness                     |
| HIPAA BAA                    | <StatusBadge status="planned" /> | Healthcare customers کے لیے business associate agreement                   |
| ISO 27001                    | <StatusBadge status="planned" /> | Information security management system                                     |
| Third-Party Penetration Test | <StatusBadge status="planned" /> | آزاد سیکیورٹی assessment                                                   |
| GDPR Compliance              | <StatusBadge status="planned" /> | Configurable retention اور deletion کے ساتھ self-hosted architecture       |

## اعتماد پر ایک نوٹ

::: tip سیکیورٹی core Apache 2.0 کے تحت open source ہے۔ آپ policy enforcement code
کی ہر لائن پڑھ سکتے ہیں، test suite چلا سکتے ہیں، اور دعوے خود verify کر سکتے ہیں۔
Certifications roadmap پر ہیں۔ :::

## Source Audit کریں

مکمل Triggerfish codebase
[github.com/greghavens/triggerfish](https://github.com/greghavens/triggerfish) پر
دستیاب ہے — Apache 2.0 licensed۔

## Vulnerability رپورٹ کرنا

اگر آپ کو سیکیورٹی vulnerability ملے، تو براہ کرم اسے ہماری
[Responsible Disclosure Policy](/ur-PK/security/responsible-disclosure) کے ذریعے
رپورٹ کریں۔ سیکیورٹی vulnerabilities کے لیے public GitHub issues مت کھولیں۔
