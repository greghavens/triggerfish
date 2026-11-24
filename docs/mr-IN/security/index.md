# Security-First Design

Triggerfish एका single premise वर built आहे: **LLM ला zero authority आहे**. तो
actions request करतो; policy layer निर्णय घेते. प्रत्येक security decision
deterministic code द्वारे घेतला जातो जो AI bypass करू शकत नाही, override करू
शकत नाही, किंवा influence करू शकत नाही.

हे page Triggerfish हा approach का घेतो, ते traditional AI agent platforms
पेक्षा कसे वेगळे आहे, आणि security model च्या प्रत्येक component वर details
कुठे सापडतात हे explain करते.

## Security LLM च्या खाली का असणे आवश्यक आहे

Large language models ला prompt inject केले जाऊ शकते. एक carefully crafted input --
malicious external message, poisoned document, किंवा compromised tool response मधून
असो -- LLM ला त्याच्या instructions ignore करायला आणि त्याला सांगितलेले नसलेले actions
घ्यायला cause करू शकते. हे theoretical risk नाही. हे AI industry मधील एक
well-documented, unsolved problem आहे.

तुमचे security model LLM rules follow करण्यावर अवलंबून असल्यास, एकच successful
injection तुम्ही built केलेले प्रत्येक safeguard bypass करू शकते.

Triggerfish हे LLM च्या **खाली** असलेल्या code layer ला सर्व security enforcement
move करून solve करते. AI security decisions कधीच पाहत नाही. तो actions allow करायचे
की नाही हे कधीच evaluate करत नाही. तो फक्त actions request करतो, आणि policy
enforcement layer -- pure, deterministic code म्हणून running -- ते actions proceed
करायचे की नाही हे decide करते.

<img src="/diagrams/enforcement-layers.svg" alt="Enforcement layers: LLM has zero authority, policy layer makes all decisions deterministically, only allowed actions reach execution" style="max-width: 100%;" />

::: warning SECURITY LLM layer ला policy enforcement layer override, skip, किंवा
influence करण्याचे कोणतेही mechanism नाही. कोणताही "parse LLM output for bypass commands"
logic नाही. Separation behavioral नाही, architectural आहे. :::

## Core Invariant

Triggerfish मधील प्रत्येक design decision एका invariant मधून flows:

> **Same input नेहमी same security decision produce करते. कोणतीही randomness नाही,
> LLM calls नाही, कोणताही discretion नाही.**

याचा अर्थ security behavior असे आहे:

- **Auditable** -- तुम्ही कोणतेही decision replay करू शकता आणि same result मिळवू शकता
- **Testable** -- deterministic code automated tests द्वारे covered केला जाऊ शकतो
- **Verifiable** -- policy engine open source (Apache 2.0 licensed) आहे आणि
  कोणीही ते inspect करू शकतो

## Security Principles

| Principle               | याचा अर्थ                                                                                                                                               | Detail Page                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **Data Classification** | सर्व data sensitivity level carry करतो (RESTRICTED, CONFIDENTIAL, INTERNAL, PUBLIC). Data system मध्ये enter झाल्यावर code द्वारे classification assign केली जाते. | [Architecture: Classification](/mr-IN/architecture/classification)         |
| **No Write-Down**       | Data फक्त equal किंवा higher classification level च्या channels आणि recipients ला flow करू शकते. CONFIDENTIAL data PUBLIC channel ला reach करू शकत नाही. कोणताही exceptions नाही. | [No Write-Down Rule](./no-write-down)                              |
| **Session Taint**       | जेव्हा session एखाद्या classification level वर data access करते, तेव्हा संपूर्ण session त्या level ला tainted होते. Taint फक्त escalate होऊ शकते, कधीच decrease नाही. | [Architecture: Taint](/mr-IN/architecture/taint-and-sessions)      |
| **Deterministic Hooks** | आठ enforcement hooks प्रत्येक data flow मधील critical points वर run होतात. प्रत्येक hook synchronous, logged, आणि unforgeable आहे.                       | [Architecture: Policy Engine](/mr-IN/architecture/policy-engine)           |
| **Identity in Code**    | User identity session establishment वर code द्वारे determined केली जाते, LLM message content interpret करून नाही.                                       | [Identity & Auth](./identity)                                              |
| **Agent Delegation**    | Agent-to-agent calls cryptographic certificates, classification ceilings, आणि depth limits द्वारे governed आहेत.                                         | [Agent Delegation](./agent-delegation)                                     |
| **Secrets Isolation**   | Credentials OS keychains किंवा vaults मध्ये stored आहेत, config files मध्ये नाही. Plugins system credentials access करू शकत नाहीत.                      | [Secrets Management](./secrets)                                            |
| **Audit Everything**    | प्रत्येक policy decision full context सह logged आहे: timestamp, hook type, session ID, input, result, आणि rules evaluated.                               | [Audit & Compliance](./audit-logging)                                      |

## Traditional AI Agents vs. Triggerfish

बहुतेक AI agent platforms safety enforce करण्यासाठी LLM वर rely करतात. System
prompt म्हणतो "sensitive data share करू नका," आणि agent ला comply करण्यासाठी
trust केले जाते. या approach ला fundamental weaknesses आहेत.

| Aspect                       | Traditional AI Agent                   | Triggerfish                                                       |
| ---------------------------- | -------------------------------------- | ----------------------------------------------------------------- |
| **Security enforcement**     | LLM ला system prompt instructions      | LLM च्या खाली Deterministic code                                   |
| **Prompt injection defense** | LLM resist करेल अशी आशा               | LLM ला authority च नाही                                           |
| **Data flow control**        | LLM decide करतो काय share करणे safe आहे | Code मध्ये Classification labels + no-write-down rule             |
| **Identity verification**    | LLM "I am the admin" interpret करतो    | Code cryptographic channel identity check करतो                    |
| **Audit trail**              | LLM conversation logs                  | Full context सह Structured policy decision logs                   |
| **Credential access**        | सर्व users साठी System service account | Delegated user credentials; source system permissions inherited   |
| **Testability**              | Fuzzy -- prompt wording वर अवलंबून     | Deterministic -- same input, same decision, every time            |
| **Open for verification**    | साधारणतः proprietary                  | Apache 2.0 licensed, fully auditable                              |

::: tip Triggerfish असे claim करत नाही की LLMs अविश्वसनीय आहेत. ते claim करते की
LLMs security enforcement साठी wrong layer आहे. एक well-prompted LLM बहुतेक वेळा
त्याच्या instructions follow करेल. पण "बहुतेक वेळा" security guarantee नाही.
Triggerfish एक guarantee provide करते: policy layer code आहे, आणि code त्याला सांगितलेले
करतो, प्रत्येक वेळी. :::

## Defense in Depth

Triggerfish thirteen layers of defense implement करते. कोणताही एक layer स्वतःहून
पुरेसा नाही; एकत्र, ते एक security boundary form करतात:

1. **Channel authentication** -- session establishment वर code-verified identity
2. **Permission-aware data access** -- source system permissions, system credentials नाही
3. **Session taint tracking** -- automatic, mandatory, escalation-only
4. **Data lineage** -- प्रत्येक data element साठी full provenance chain
5. **Policy enforcement hooks** -- deterministic, non-bypassable, logged
6. **MCP Gateway** -- per-tool permissions सह secure external tool access
7. **[Plugin sandbox](../integrations/plugins)**
8. **Secrets isolation** -- OS keychain किंवा vault, config files नाही
9. **Filesystem tool sandbox** -- path jail, path classification, taint-scoped OS-level I/O permissions
10. **Agent identity** -- cryptographic delegation chains
11. **Audit logging** -- सर्व decisions recorded, कोणताही exceptions नाही
12. **SSRF prevention** -- सर्व outbound HTTP वर IP denylist + DNS resolution checks
13. **Memory classification gating** -- writes session taint ला forced, reads `canFlowTo` द्वारे filtered

## Next Steps

| Page                                                          | वर्णन                                                                                   |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| [Classification Guide](/mr-IN/guide/classification-guide)      | Channels, MCP servers, आणि integrations साठी योग्य level निवडण्याचे practical guide    |
| [No Write-Down Rule](./no-write-down)                         | Fundamental data flow rule आणि ते कसे enforced आहे                                     |
| [Identity & Auth](./identity)                                 | Channel authentication आणि owner identity verification                                  |
| [Agent Delegation](./agent-delegation)                        | Agent-to-agent identity, certificates, आणि delegation chains                            |
| [Secrets Management](./secrets)                               | Triggerfish tiers across credentials कसे handle करतो                                   |
| [Audit & Compliance](./audit-logging)                         | Audit trail structure, tracing, आणि compliance exports                                  |
