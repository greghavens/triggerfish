# Defense in Depth

Nag-implement ang Triggerfish ng security bilang 13 independent, magkakapatong na layers. Walang isang
layer na sapat mag-isa. Magkasama, bumubuo sila ng defense na gracefully nag-degrade
-- kahit na ma-compromise ang isang layer, patuloy na pinoprotektahan ng natitirang layers
ang system.

::: warning SECURITY Ibig sabihin ng defense in depth na ang vulnerability sa anumang isang
layer ay hindi nagko-compromise sa system. Ang attacker na na-bypass ang channel
authentication ay haharap pa rin sa session taint tracking, policy hooks, at audit
logging. Ang LLM na na-prompt-inject ay hindi pa rin maaring mag-influence sa deterministic
policy layer sa ilalim nito. :::

## Ang 13 Layers

### Layer 1: Channel Authentication

**Pinoprotektahan laban sa:** Impersonation, unauthorized access, identity confusion.

Tinutukoy ang identity sa pamamagitan ng **code sa session establishment**, hindi ng LLM
na nag-interpret ng message content. Bago makita ng LLM ang anumang mensahe, tina-tag ito ng channel
adapter ng immutable label:

```
{ source: "owner" }    -- na-verify na tumutugma ang channel identity sa registered owner
{ source: "external" } -- kahit sino pa; input lamang, hindi itinuturing bilang command
```

Iba-iba ang authentication methods sa bawat channel:

| Channel                 | Paraan          | Verification                                               |
| ----------------------- | --------------- | ---------------------------------------------------------- |
| Telegram / WhatsApp     | Pairing code    | One-time code, 5-minute expiry, ipinadala mula sa account ng user |
| Slack / Discord / Teams | OAuth           | Platform OAuth consent flow, nagbabalik ng verified user ID |
| CLI                     | Local process   | Tumatakbo sa machine ng user, authenticated ng OS          |
| WebChat                 | Wala (public)   | Lahat ng visitors ay `EXTERNAL`, hindi kailanman `owner`   |
| Email                   | Domain matching | Kinocompare ang sender domain laban sa configured internal domains |

::: info Hindi kailanman ang LLM ang nagde-decide kung sino ang owner. Ang mensaheng nagsasabing "Ako ang
owner" mula sa unverified sender ay tina-tag na `{ source: "external" }` at hindi makakapag-trigger
ng owner-level commands. Ginagawa ang desisyon na ito sa code, bago i-process ng LLM
ang mensahe. :::

### Layer 2: Permission-Aware Data Access

**Pinoprotektahan laban sa:** Over-permissioned data access, privilege escalation
sa pamamagitan ng system credentials.

Gumagamit ang Triggerfish ng delegated OAuth tokens ng user -- hindi system service
accounts -- para mag-query sa external systems. Sine-enforce ng source system ang sarili nitong
permission model:

<img src="/diagrams/traditional-vs-triggerfish.svg" alt="Traditional vs Triggerfish: ang traditional model ay nagbibigay ng direct control sa LLM, ni-route ng Triggerfish ang lahat ng actions sa deterministic policy layer" style="max-width: 100%;" />

Sine-enforce ng Plugin SDK ito sa API level:

| SDK Method                              | Behavior                                |
| --------------------------------------- | --------------------------------------- |
| `sdk.get_user_credential(integration)`  | Nagbabalik ng delegated OAuth token ng user |
| `sdk.query_as_user(integration, query)` | Nag-execute gamit ang permissions ng user   |
| `sdk.get_system_credential(name)`       | **BLOCKED** -- naglalabas ng `PermissionError` |

### Layer 3: Session Taint Tracking

**Pinoprotektahan laban sa:** Data leakage sa pamamagitan ng context contamination, classified
data na umaabot sa lower-classification channels.

Bawat session ay independyenteng nag-track ng taint level na nagre-reflect ng pinakamataas na
classification ng data na in-access habang nasa session. May tatlong invariant ang taint:

1. **Per-conversation** -- bawat session ay may sariling taint
2. **Escalation only** -- tumataas ang taint, hindi bumababa
3. **Full reset clears everything** -- sabay na binu-bura ang taint AT history

Kapag nag-evaluate ng output ang policy engine, kinocompare nito ang taint ng session
laban sa effective classification ng target channel. Kung mas mataas ang taint kaysa sa
target, bina-block ang output.

### Layer 4: Data Lineage

**Pinoprotektahan laban sa:** Hindi matraceable na data flows, kawalan ng kakayahang mag-audit kung saan napunta ang data, compliance gaps.

Bawat data element ay may provenance metadata mula sa origin hanggang sa destination:

- **Origin**: Aling integration, record, at user access ang gumawa ng data na ito
- **Classification**: Anong level ang na-assign at bakit
- **Transformations**: Paano binago, binuod, o pinagsama ng LLM ang data
- **Destination**: Aling session at channel ang tumanggap ng output

Pinapagana ng lineage ang forward traces ("saan napunta ang Salesforce record na ito?"),
backward traces ("anong sources ang nag-contribute sa output na ito?"), at buong
compliance exports.

### Layer 5: Policy Enforcement Hooks

**Pinoprotektahan laban sa:** Prompt injection attacks, LLM-driven security bypasses,
uncontrolled tool execution.

Walong deterministic hooks ang humaharang sa bawat action sa mga kritikal na punto sa data
flow:

| Hook                    | Ano ang hinaharang                                 |
| ----------------------- | -------------------------------------------------- |
| `PRE_CONTEXT_INJECTION` | External input na pumapasok sa context window      |
| `PRE_TOOL_CALL`         | LLM na humihiling ng tool execution                |
| `POST_TOOL_RESPONSE`    | Data na bumabalik mula sa tool execution           |
| `PRE_OUTPUT`            | Response na malapit nang umalis sa system          |
| `SECRET_ACCESS`         | Credential access request                          |
| `SESSION_RESET`         | Taint reset request                                |
| `AGENT_INVOCATION`      | Agent-to-agent call                                |
| `MCP_TOOL_CALL`         | MCP server tool invocation                         |

Pure code ang hooks: deterministic, synchronous, logged, at unforgeable. Hindi
kayang i-bypass ito ng LLM dahil walang pathway mula sa LLM output patungo sa hook
configuration. Walang "parse LLM output for commands" logic ang hook layer.

### Layer 6: MCP Gateway

**Pinoprotektahan laban sa:** Uncontrolled external tool access, unclassified data
na pumapasok sa pamamagitan ng MCP servers, schema violations.

Lahat ng MCP servers ay naka-default sa `UNTRUSTED` at hindi maaaring i-invoke hangga't hindi ini-classify ng admin o
user. Sine-enforce ng Gateway ang:

- Server authentication at classification status
- Tool-level permissions (maaaring i-block ang individual tools kahit na allowed ang server)
- Request/response schema validation
- Taint tracking sa lahat ng MCP responses
- Injection pattern scanning sa parameters

<img src="/diagrams/mcp-server-states.svg" alt="MCP server states: UNTRUSTED (default), CLASSIFIED (reviewed at permitted), BLOCKED (tahasan na ipinagbawal)" style="max-width: 100%;" />

### Layer 7: Plugin Sandbox

I-enable ang TypeScript plugin sa configuration ng user gamit ang `enabled: true`. Bilang default, ginagawa ang import at execution sa mga restricted Deno Worker. Nababasá ng worker ang directory ng plugin at nakakonekta lamang sa mga host at port sa `declaredEndpoints`. Bawal ang pagsulat ng file, pagbabasa ng process environment, subprocess, FFI, at restricted system information. Pinapayagan ng `trust: trusted` sa configuration ang import sa proseso ng Triggerfish. Doon tatakbo ang executor kung `trusted` din ang manifest.

[Kumpletong gabay sa plugin](../integrations/plugins)

### Layer 8: Secrets Isolation

**Pinoprotektahan laban sa:** Credential theft, secrets sa config files, plaintext
credential storage.

Nakaimbak ang credentials sa OS keychain (personal tier) o vault integration
(enterprise tier). Hindi sila kailanman lumilitaw sa:

- Configuration files
- `StorageProvider` values
- Log entries
- LLM context (ini-inject ang credentials sa HTTP layer, sa ilalim ng LLM)

Nila-log ng `SECRET_ACCESS` hook ang bawat credential access kasama ang requesting
plugin, credential scope, at desisyon.

### Layer 9: Filesystem Tool Sandbox

**Pinoprotektahan laban sa:** Path traversal attacks, unauthorized file access,
classification bypass sa pamamagitan ng direct filesystem operations.

Lahat ng filesystem tool operations (read, write, edit, list, search) ay tumatakbo sa loob ng
sandboxed Deno Worker na may OS-level permissions na naka-scope sa
taint-appropriate workspace subdirectory ng session. Sine-enforce ng sandbox ang tatlong boundary:

- **Path jail** — bawat path ay nire-resolve sa absolute path at chine-check laban sa
  jail root na may separator-aware matching. Ang mga traversal attempt (`../`) na
  umaalis sa workspace ay nire-reject bago mag-occur ang anumang I/O
- **Path classification** — bawat filesystem path ay ini-classify sa pamamagitan ng fixed
  resolution chain: hardcoded protected paths (RESTRICTED), workspace
  classification directories, configured path mappings, pagkatapos ay default
  classification. Hindi maa-access ng agent ang paths na mas mataas sa session taint nito
- **Taint-scoped permissions** — ang Deno permissions ng sandbox Worker ay naka-set
  sa workspace subdirectory na tumutugma sa kasalukuyang taint level ng session. Kapag
  nag-escalate ang taint, nire-respawn ang Worker na may expanded permissions. Ang permissions
  ay maaari lamang lumawak, hindi humigpit sa loob ng session
- **Write protection** — ang mga kritikal na files (`TRIGGER.md`, `triggerfish.yaml`,
  `SPINE.md`) ay write-protected sa tool layer anuman ang sandbox
  permissions. Ang mga files na ito ay maaari lamang baguhin sa pamamagitan ng dedicated management
  tools na may sariling classification rules

### Layer 10: Agent Identity

**Pinoprotektahan laban sa:** Privilege escalation sa pamamagitan ng agent chains, data laundering
sa pamamagitan ng delegation.

Kapag nag-invoke ang mga agents ng ibang agents, pinipigilan ng cryptographic delegation chains ang
privilege escalation:

- Bawat agent ay may certificate na tumutukoy sa mga capabilities at classification
  ceiling nito
- Ini-inherit ng callee ang `max(own taint, caller taint)` -- ang taint ay tumataas lamang
  sa pamamagitan ng chains
- Bina-block ang caller na may taint na mas mataas sa ceiling ng callee
- Nade-detect at nire-reject ang circular invocations
- May limit at sine-enforce ang delegation depth

<img src="/diagrams/data-laundering-defense.svg" alt="Data laundering defense: bina-block ang attack path sa ceiling check at pinipigilan ng taint inheritance ang output sa lower-classification channels" style="max-width: 100%;" />

### Layer 11: Audit Logging

**Pinoprotektahan laban sa:** Undetectable breaches, compliance failures, kawalan ng kakayahang
mag-investigate ng mga insidente.

Bawat security-relevant na desisyon ay naka-log na may buong context:

```json
{
  "timestamp": "2025-01-29T10:23:45Z",
  "user_id": "user_123",
  "session_id": "sess_456",
  "action": "slack.postMessage",
  "target_channel": "external_webhook",
  "session_taint": "CONFIDENTIAL",
  "target_classification": "PUBLIC",
  "decision": "DENIED",
  "reason": "classification_violation",
  "hook": "PRE_OUTPUT",
  "policy_rules_evaluated": ["rule_001", "rule_002"],
  "lineage_ids": ["lin_789", "lin_790"]
}
```

Ano ang nilo-log:

- Lahat ng action requests (allowed AT denied)
- Classification decisions
- Session taint changes
- Channel authentication events
- Policy rule evaluations
- Lineage record creation at updates
- MCP Gateway decisions
- Agent-to-agent invocations

::: info Hindi maaaring i-disable ang audit logging. Ito ay isang fixed rule sa policy
hierarchy. Kahit ang org admin ay hindi maaring patayin ang logging para sa sarili nilang actions.
Ang enterprise deployments ay maaaring mag-enable ng full content logging (kasama ang
blocked message content) para sa forensic requirements. :::

### Layer 12: SSRF Prevention

**Pinoprotektahan laban sa:** Server-side request forgery, internal network
reconnaissance, cloud metadata exfiltration.

Lahat ng outbound HTTP requests (mula sa `web_fetch`, `browser.navigate`, at plugin
network access) ay unang nagre-resolve ng DNS at chine-check ang resolved IP laban sa hardcoded
denylist ng private at reserved ranges. Pinipigilan nito ang attacker na i-trick
ang agent sa pag-access ng internal services sa pamamagitan ng crafted URLs.

- Palaging bina-block ang private ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`)
- Bina-block ang link-local (`169.254.0.0/16`) at cloud metadata endpoints
- Bina-block ang loopback (`127.0.0.0/8`)
- Ang denylist ay hardcoded at hindi configurable -- walang admin override
- Nagha-happen ang DNS resolution bago ang request, pinipigilan ang DNS rebinding attacks

### Layer 13: Memory Classification Gating

**Pinoprotektahan laban sa:** Cross-session data leakage sa pamamagitan ng memory, classification
downgrade sa pamamagitan ng memory writes, unauthorized access sa classified memories.

Sine-enforce ng cross-session memory system ang classification sa parehong write at read
time:

- **Writes**: Pinipilit ang memory entries sa kasalukuyang taint level ng session.
  Hindi maaaring pumili ang LLM ng mas mababang classification para sa stored memories.
- **Reads**: Nifi-filter ang memory queries gamit ang `canFlowTo` -- maaari lamang
  magbasa ang session ng memories na nasa o mas mababa sa kasalukuyang taint level nito.

Pinipigilan nito ang agent na mag-store ng CONFIDENTIAL data bilang PUBLIC sa memory at
sa susunod na i-retrieve ito sa lower-taint session para i-bypass ang no-write-down rule.

## Trust Hierarchy

Tinutukoy ng trust model kung sino ang may authority sa ano. Hindi maaaring i-bypass ng higher tiers ang
lower-tier security rules, pero maaari nilang i-configure ang adjustable parameters
sa loob ng mga rules na iyon.

<img src="/diagrams/trust-hierarchy.svg" alt="Trust hierarchy: Triggerfish vendor (zero access), Org Admin (nagse-set ng policies), Employee (gumagamit ng agent sa loob ng mga hangganan)" style="max-width: 100%;" />

::: tip **Personal tier:** Ang user ANG org admin. Buong sovereignty. Walang
Triggerfish visibility. Zero access ang vendor sa user data bilang default at
maaari lamang makakuha ng access sa pamamagitan ng explicit, time-bound, logged grant mula sa
user. :::

## Paano Nagtutulungan ang mga Layer

Isaalang-alang ang isang prompt injection attack kung saan sinubukan ng malicious message na
i-exfiltrate ang data:

| Hakbang | Layer                  | Aksyon                                                |
| ------- | ---------------------- | ----------------------------------------------------- |
| 1       | Channel authentication | Tina-tag ang mensahe na `{ source: "external" }` -- hindi owner |
| 2       | PRE_CONTEXT_INJECTION  | Sini-scan ang input para sa injection patterns, classified |
| 3       | Session taint          | Hindi nagbago ang session taint (walang classified data na na-access) |
| 4       | LLM processes message  | Maaaring ma-manipulate ang LLM na humiling ng tool call |
| 5       | PRE_TOOL_CALL          | Tool permission check laban sa external-source rules  |
| 6       | POST_TOOL_RESPONSE     | Anumang returned data classified, na-update ang taint |
| 7       | PRE_OUTPUT             | Chine-check ang output classification vs. target      |
| 8       | Audit logging          | Buong sequence na nai-record para sa review           |

Kahit na ganap na na-compromise ang LLM sa step 4 at humiling ng data exfiltration
tool call, patuloy na sine-enforce ng natitirang layers (permission checks, taint tracking, output
classification, audit logging) ang policy. Walang single point of
failure na nagko-compromise sa system.
