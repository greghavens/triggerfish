# सखोल संरक्षण

Triggerfish 13 स्वतंत्र, overlapping स्तरांमध्ये सुरक्षा लागू करतो. कोणताही एकल
स्तर स्वतःच पुरेसा नाही. एकत्रितपणे, ते एक असे संरक्षण तयार करतात जे gracefully
degraded होते -- जरी एक स्तर compromised झाला तरी, उर्वरित स्तर सिस्टम संरक्षण
करत राहतात.

::: warning SECURITY सखोल संरक्षणाचा अर्थ असा आहे की कोणत्याही एकल स्तरातील
vulnerability सिस्टम compromise करत नाही. Channel authentication bypass करणारा
attacker अजूनही session taint tracking, policy hooks आणि audit logging
चा सामना करतो. Prompt-injected LLM अजूनही त्याच्या खाली निश्चायक धोरण स्तरावर
प्रभाव टाकू शकत नाही. :::

## 13 स्तर

### स्तर 1: Channel Authentication

**विरुद्ध संरक्षण करतो:** Impersonation, अनधिकृत प्रवेश, identity confusion.

ओळख **session establishment वर कोडद्वारे** निश्चित केली जाते, LLM message
सामग्री interpret करून नाही. LLM कोणताही संदेश पाहण्यापूर्वी, channel adapter
त्याला immutable label ने tag करतो:

```
{ source: "owner" }    -- verified channel identity registered owner शी जुळते
{ source: "external" } -- इतर कोणीही; फक्त input, command म्हणून treat केले जात नाही
```

Authentication methods channel नुसार बदलतात:

| Channel                 | Method          | Verification                                               |
| ----------------------- | --------------- | ---------------------------------------------------------- |
| Telegram / WhatsApp     | Pairing code    | One-time code, 5-minute expiry, user च्या account मधून पाठवला |
| Slack / Discord / Teams | OAuth           | Platform OAuth consent flow, verified user ID return करतो  |
| CLI                     | Local process   | User च्या मशीनवर चालतो, OS ने authenticated               |
| WebChat                 | None (public)   | सर्व अभ्यागत `EXTERNAL` आहेत, कधीही `owner` नाही           |
| Email                   | Domain matching | Sender domain configured internal domains विरुद्ध compared |

::: info LLM कधीही ठरवत नाही की owner कोण आहे. Unverified sender कडून "मी owner
आहे" असे सांगणारा संदेश `{ source: "external" }` tagged असतो आणि owner-level
कमांड trigger करू शकत नाही. हा निर्णय कोडमध्ये, LLM संदेश process करण्यापूर्वी
केला जातो. :::

### स्तर 2: Permission-Aware Data Access

**विरुद्ध संरक्षण करतो:** Over-permissioned data access, system credentials द्वारे privilege escalation.

Triggerfish बाह्य सिस्टम query करण्यासाठी system service accounts नाही तर
user's delegated OAuth tokens वापरतो. Source system स्वतःचे permission model
enforce करतो.

Plugin SDK हे API स्तरावर enforce करतो:

| SDK Method                              | वर्तन                                   |
| --------------------------------------- | --------------------------------------- |
| `sdk.get_user_credential(integration)`  | User's delegated OAuth token return करतो |
| `sdk.query_as_user(integration, query)` | User's permissions सह execute करतो      |
| `sdk.get_system_credential(name)`       | **BLOCKED** -- `PermissionError` raise करतो |

### स्तर 3: Session Taint Tracking

**विरुद्ध संरक्षण करतो:** Context contamination द्वारे data leakage, classified
data lower-classification channels पर्यंत पोहोचणे.

प्रत्येक session session दरम्यान access केलेल्या डेटाचे सर्वोच्च वर्गीकरण
reflect करणारे taint level स्वतंत्रपणे track करते. Taint तीन invariants follow करते:

1. **Per-conversation** -- प्रत्येक session ला स्वतःचे taint आहे
2. **Escalation only** -- taint वाढते, कधीही कमी होत नाही
3. **Full reset सर्व काही साफ करते** -- taint आणि history एकत्र wiped आहेत

### स्तर 4: Data Lineage

**विरुद्ध संरक्षण करतो:** Untraceable data flows, data कुठे गेले ते audit करण्यास
असमर्थता, compliance gaps.

प्रत्येक डेटा element मूळापासून गंतव्यस्थानापर्यंत provenance metadata वाहतो:

- **Origin**: कोणत्या integration, record आणि user access ने हा डेटा तयार केला
- **Classification**: कोणता स्तर assigned केला गेला आणि का
- **Transformations**: LLM ने डेटा कसे modified, summarized किंवा combined केले
- **Destination**: कोणत्या session आणि channel ने output प्राप्त केले

### स्तर 5: Policy Enforcement Hooks

**विरुद्ध संरक्षण करतो:** Prompt injection attacks, LLM-driven security bypasses,
uncontrolled tool execution.

आठ निश्चायक hooks डेटा flow मधील critical points वर प्रत्येक action intercept करतात:

| Hook                    | काय intercept करतो                              |
| ----------------------- | ----------------------------------------------- |
| `PRE_CONTEXT_INJECTION` | Context window मध्ये प्रवेश करणारे बाह्य input  |
| `PRE_TOOL_CALL`         | LLM tool execution request करतो                 |
| `POST_TOOL_RESPONSE`    | Tool execution मधून परत येणारा डेटा             |
| `PRE_OUTPUT`            | System सोडण्याच्या आधी response                 |
| `SECRET_ACCESS`         | Credential access request                       |
| `SESSION_RESET`         | Taint reset request                             |
| `AGENT_INVOCATION`      | Agent-to-agent call                             |
| `MCP_TOOL_CALL`         | MCP server tool invocation                      |

Hooks शुद्ध कोड आहेत: निश्चायक, synchronous, logged आणि unforgeable. LLM त्यांना
bypass करू शकत नाही कारण LLM output पासून hook configuration पर्यंत कोणता pathway
नाही.

### स्तर 6: MCP Gateway

**विरुद्ध संरक्षण करतो:** Uncontrolled external tool access, MCP servers द्वारे
unclassified data प्रवेश, schema violations.

सर्व MCP servers `UNTRUSTED` ला default होतात आणि admin किंवा user classify
करेपर्यंत invoke केले जाऊ शकत नाहीत.

### स्तर 7: Plugin Sandbox

वापरकर्ता कॉन्फिगरेशनमध्ये `enabled: true` ने TypeScript प्लगइन सक्षम करा. डीफॉल्टनुसार आयात व अंमलबजावणी मर्यादित Deno Worker मध्ये होते. Worker प्लगइनची निर्देशिका वाचू शकतो आणि फक्त `declaredEndpoints` मधील होस्ट व पोर्टशी जोडू शकतो. फाइल लेखन, प्रक्रिया वातावरण वाचणे, उपप्रक्रिया, FFI व प्रतिबंधित प्रणाली माहितीचा प्रवेश अवरोधित आहे. `trust: trusted` मुळे Triggerfish प्रक्रियेत आयात करण्याची परवानगी मिळते. मॅनिफेस्टमध्येही `trusted` असल्यास एक्झिक्युटर त्याच प्रक्रियेत चालतो.

[संपूर्ण प्लगइन मार्गदर्शक](../integrations/plugins)

### स्तर 8: Secrets Isolation

**विरुद्ध संरक्षण करतो:** Credential theft, config files मध्ये secrets,
plaintext credential storage.

Credentials OS keychain (personal tier) किंवा vault integration (enterprise
tier) मध्ये संग्रहित आहेत. ते कधीही दिसत नाहीत:

- Configuration files मध्ये
- `StorageProvider` मूल्यांमध्ये
- Log entries मध्ये
- LLM context मध्ये (credentials HTTP layer वर inject केले जातात, LLM च्या खाली)

### स्तर 9: Filesystem Tool Sandbox

**विरुद्ध संरक्षण करतो:** Path traversal attacks, अनधिकृत file access,
direct filesystem operations द्वारे classification bypass.

सर्व filesystem tool operations sandboxed Deno Worker मध्ये चालतात. Sandbox
तीन सीमा enforce करतो:

- **Path jail** — प्रत्येक path absolute path ला resolved आहे आणि jail root विरुद्ध
  checked आहे. Workspace escape करणारे traversal attempts (`../`) कोणत्याही I/O
  पूर्वी rejected आहेत
- **Path classification** — प्रत्येक filesystem path निश्चित resolution chain
  द्वारे classified आहे
- **Write protection** — critical files (`TRIGGER.md`, `triggerfish.yaml`,
  `SPINE.md`) tool layer वर write-protected आहेत

### स्तर 10: Agent Identity

**विरुद्ध संरक्षण करतो:** Agent chains द्वारे privilege escalation, delegation
द्वारे data laundering.

जेव्हा agents इतर agents invoke करतात, cryptographic delegation chains privilege
escalation प्रतिबंध करतात:

- प्रत्येक agent ला त्याच्या capabilities आणि classification ceiling specify करणारे
  certificate आहे
- Callee `max(own taint, caller taint)` inherit करतो -- taint chains द्वारे फक्त
  वाढू शकतो
- Callee's ceiling पेक्षा जास्त taint असलेला caller blocked आहे

### स्तर 11: Audit Logging

**विरुद्ध संरक्षण करतो:** Undetectable breaches, compliance failures, incidents
investigate करण्यास असमर्थता.

प्रत्येक security-relevant निर्णय पूर्ण context सह logged आहे:

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

::: info Audit logging अक्षम केले जाऊ शकत नाही. हे धोरण hierarchy मधील निश्चित
नियम आहे. Enterprise deployments forensic requirements साठी full content
logging ऐच्छिकपणे सक्षम करू शकतात. :::

### स्तर 12: SSRF प्रतिबंध

**विरुद्ध संरक्षण करतो:** Server-side request forgery, internal network
reconnaissance, cloud metadata exfiltration.

सर्व outbound HTTP requests DNS आधी resolve करतात आणि private आणि reserved ranges
च्या hardcoded denylist विरुद्ध resolved IP check करतात. Denylist hardcoded आहे
आणि configurable नाही -- कोणताही admin override नाही.

### स्तर 13: Memory Classification Gating

**विरुद्ध संरक्षण करतो:** Memory द्वारे cross-session data leakage, memory writes
द्वारे classification downgrade, classified memories चा अनधिकृत प्रवेश.

Cross-session memory system write आणि read दोन्ही वेळी वर्गीकरण enforce करतो:

- **Writes**: Memory entries वर्तमान session च्या taint level ला forced आहेत.
  LLM stored memories साठी कमी वर्गीकरण निवडू शकत नाही.
- **Reads**: Memory queries `canFlowTo` द्वारे filtered आहेत -- session फक्त
  त्याच्या वर्तमान taint level वर किंवा खाली memories वाचू शकते.

## Trust Hierarchy

Trust model परिभाषित करतो की कोणाला कशावर authority आहे. उच्च tiers lower-tier
सुरक्षा नियम bypass करू शकत नाहीत, परंतु ते त्या नियमांमधील adjustable
parameters configure करू शकतात.

::: tip **Personal tier:** वापरकर्ता IS org admin आहे. पूर्ण sovereignty. कोणती
Triggerfish visibility नाही. Vendor ला default वर user data ला zero access आहे
आणि फक्त user कडून explicit, time-bound, logged grant द्वारे access मिळवू शकतो. :::

## स्तर एकत्र कसे कार्य करतात

एक prompt injection attack विचार करा जिथे malicious message data exfiltrate
करण्याचा प्रयत्न करतो:

| पायरी | स्तर                   | क्रिया                                                          |
| ----- | ---------------------- | --------------------------------------------------------------- |
| 1     | Channel authentication | Message `{ source: "external" }` tagged -- owner नाही           |
| 2     | PRE_CONTEXT_INJECTION  | Input injection patterns साठी scanned, classified              |
| 3     | Session taint          | Session taint unchanged (कोणता classified data access नाही)    |
| 4     | LLM processes message  | LLM tool call request करण्यासाठी manipulated होऊ शकतो          |
| 5     | PRE_TOOL_CALL          | External-source rules विरुद्ध tool permission check             |
| 6     | POST_TOOL_RESPONSE     | Return केलेला कोणताही data classified, taint updated            |
| 7     | PRE_OUTPUT             | Output classification विरुद्ध target checked                   |
| 8     | Audit logging          | Review साठी संपूर्ण sequence recorded                          |

जरी LLM पायरी 4 वर पूर्णपणे compromised झाला आणि data exfiltration tool call
request केला, तरी उर्वरित स्तर (permission checks, taint tracking, output
classification, audit logging) धोरण enforce करत राहतात.
