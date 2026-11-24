# Security-First Design

Binuo ang Triggerfish sa iisang premise: **walang authority ang LLM**. Humihiling ito ng actions; nagpapasya ang policy layer. Bawat security decision ay ginagawa ng deterministic code na hindi maaaring i-bypass, i-override, o impluwensyahan ng AI.

Ipinapaliwanag ng page na ito kung bakit ginagawa ng Triggerfish ang approach na ito, kung paano ito naiiba sa tradisyonal na AI agent platforms, at kung saan mahahanap ang mga detalye sa bawat component ng security model.

## Bakit Kailangang Nasa Ibaba ng LLM ang Security

Maaaring ma-prompt-inject ang mga large language model. Ang maingat na crafted input -- mula sa malicious external message, poisoned document, o compromised tool response -- ay maaaring maging dahilan na balewalain ng LLM ang instructions nito at gumawa ng actions na sinabihan itong huwag gawin. Hindi ito theoretical risk. Ito ay well-documented, unsolved problem sa AI industry.

Kung umaasa ang security model mo sa LLM na sumunod sa rules, ang isang matagumpay na injection ay maaaring mag-bypass ng bawat safeguard na binuo mo.

Nilulutas ng Triggerfish ito sa pamamagitan ng paglipat ng lahat ng security enforcement sa code layer na nasa **ibaba** ng LLM. Hindi nakikita ng AI ang security decisions. Hindi nito ine-evaluate kung dapat payagan ang action. Humihiling lang ito ng actions, at ang policy enforcement layer -- na tumatakbo bilang pure, deterministic code -- ang nagpapasya kung magpapatuloy ang mga actions na iyon.

<img src="/diagrams/enforcement-layers.svg" alt="Enforcement layers: walang authority ang LLM, deterministically ang policy layer ang gumagawa ng lahat ng decisions, ang allowed actions lang ang pumapasa sa execution" style="max-width: 100%;" />

::: warning SECURITY Walang mekanismo ang LLM layer para i-override, i-skip, o impluwensyahan ang policy enforcement layer. Walang "parse LLM output for bypass commands" logic. Architectural ang separation, hindi behavioral. :::

## Ang Core Invariant

Bawat design decision sa Triggerfish ay nagmumula sa isang invariant:

> **Palaging parehong security decision ang resulta ng parehong input. Walang randomness, walang LLM calls, walang discretion.**

Ibig sabihin nito ang security behavior ay:

- **Auditable** -- maaari mong i-replay ang anumang decision at makuha ang parehong resulta
- **Testable** -- maaaring saklawin ng automated tests ang deterministic code
- **Verifiable** -- open source ang policy engine (Apache 2.0 licensed) at maaaring i-inspect ng kahit sino

## Mga Security Principle

| Prinsipyo                | Ano ang Ibig Sabihin                                                                                                                                              | Detail Page                                                       |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **Data Classification** | Lahat ng data ay may sensitivity level (RESTRICTED, CONFIDENTIAL, INTERNAL, PUBLIC). Ina-assign ng code ang classification kapag pumasok ang data sa system.       | [Architecture: Classification](/fil-PH/architecture/classification) |
| **No Write-Down**       | Ang data ay maaari lang dumaloy sa channels at recipients na may pantay o mas mataas na classification level. Hindi maaaring ma-reach ng CONFIDENTIAL data ang PUBLIC channel. Walang exceptions. | [No Write-Down Rule](./no-write-down)                             |
| **Session Taint**       | Kapag nag-access ang session ng data sa isang classification level, nata-taint ang buong session sa level na iyon. Maaari lang mag-escalate ang taint, hindi bumaba. | [Architecture: Taint](/fil-PH/architecture/taint-and-sessions)    |
| **Deterministic Hooks** | Walong enforcement hooks ang tumatakbo sa critical points sa bawat data flow. Bawat hook ay synchronous, logged, at unforgeable.                                  | [Architecture: Policy Engine](/fil-PH/architecture/policy-engine) |
| **Identity in Code**    | Dine-determine ng code ang user identity sa session establishment, hindi ng LLM na nag-i-interpret ng message content.                                            | [Identity & Auth](./identity)                                     |
| **Agent Delegation**    | Ang agent-to-agent calls ay pinapamahalaan ng cryptographic certificates, classification ceilings, at depth limits.                                               | [Agent Delegation](./agent-delegation)                            |
| **Secrets Isolation**   | Ang credentials ay naka-store sa OS keychains o vaults, hindi kailanman sa config files. Hindi maaaring mag-access ng system credentials ang plugins.              | [Secrets Management](./secrets)                                   |
| **Audit Everything**    | Bawat policy decision ay nilo-log na may buong context: timestamp, hook type, session ID, input, result, at evaluated rules.                                      | [Audit & Compliance](./audit-logging)                             |

## Tradisyonal na AI Agents vs. Triggerfish

Karamihan ng AI agent platforms ay umaasa sa LLM para i-enforce ang safety. Sinasabi ng system prompt na "do not share sensitive data," at pinagkakatiwalaan ang agent na sumunod. May fundamental weaknesses ang approach na ito.

| Aspeto                        | Tradisyonal na AI Agent                   | Triggerfish                                                        |
| ----------------------------- | ----------------------------------------- | ------------------------------------------------------------------ |
| **Security enforcement**      | System prompt instructions sa LLM         | Deterministic code sa ibaba ng LLM                                 |
| **Prompt injection defense**  | Umaasa na lalabanan ng LLM               | Walang authority ang LLM sa simula pa                              |
| **Data flow control**         | Ang LLM ang nagpapasya kung ano ang safe i-share | Classification labels + no-write-down rule sa code              |
| **Identity verification**     | Ini-interpret ng LLM ang "I am the admin" | Tine-check ng code ang cryptographic channel identity              |
| **Audit trail**               | LLM conversation logs                     | Structured policy decision logs na may buong context               |
| **Credential access**         | System service account para sa lahat ng users | Delegated user credentials; inherited ang source system permissions |
| **Testability**               | Malabo -- depende sa prompt wording       | Deterministic -- parehong input, parehong decision, palagi          |
| **Open for verification**     | Karaniwang proprietary                    | Apache 2.0 licensed, buong auditable                               |

::: tip Hindi sinasabi ng Triggerfish na unreliable ang LLMs. Sinasabi nitong maling layer ang LLMs para sa security enforcement. Susundin ng well-prompted LLM ang instructions nito karamihan ng oras. Pero ang "karamihan ng oras" ay hindi security guarantee. Nagbibigay ang Triggerfish ng guarantee: code ang policy layer, at ginagawa ng code ang sinasabi nito, palagi. :::

## Defense in Depth

Nag-i-implement ang Triggerfish ng labintatlong layers ng defense. Walang iisang layer na sapat sa sarili nito; magkakasama, bumubuo sila ng security boundary:

1. **Channel authentication** -- code-verified identity sa session establishment
2. **Permission-aware data access** -- source system permissions, hindi system credentials
3. **Session taint tracking** -- automatic, mandatory, escalation-only
4. **Data lineage** -- buong provenance chain para sa bawat data element
5. **Policy enforcement hooks** -- deterministic, non-bypassable, logged
6. **MCP Gateway** -- secure external tool access na may per-tool permissions
7. **[Plugin sandbox](../integrations/plugins)**
8. **Secrets isolation** -- OS keychain o vault, hindi kailanman config files
9. **Filesystem tool sandbox** -- path jail, path classification, taint-scoped OS-level I/O permissions
10. **Agent identity** -- cryptographic delegation chains
11. **Audit logging** -- lahat ng decisions nire-record, walang exceptions
12. **SSRF prevention** -- IP denylist + DNS resolution checks sa lahat ng outbound HTTP
13. **Memory classification gating** -- writes forced sa session taint, reads filtered ng `canFlowTo`

## Mga Susunod na Hakbang

| Pahina                                                          | Paglalarawan                                                                              |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [Classification Guide](/fil-PH/guide/classification-guide)      | Praktikal na guide sa pagpili ng tamang level para sa channels, MCP servers, at integrations |
| [No Write-Down Rule](./no-write-down)                           | Ang fundamental data flow rule at kung paano ito ine-enforce                              |
| [Identity & Auth](./identity)                                   | Channel authentication at owner identity verification                                     |
| [Agent Delegation](./agent-delegation)                          | Agent-to-agent identity, certificates, at delegation chains                               |
| [Secrets Management](./secrets)                                 | Kung paano hina-handle ng Triggerfish ang credentials sa bawat tier                       |
| [Audit & Compliance](./audit-logging)                           | Audit trail structure, tracing, at compliance exports                                     |
