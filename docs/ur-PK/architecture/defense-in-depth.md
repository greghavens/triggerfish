# Defense in Depth

Triggerfish سیکیورٹی کو 13 آزاد، overlapping پرتوں کے طور پر implement کرتا ہے۔ کوئی
بھی ایک پرت اکیلے کافی نہیں۔ مل کر، وہ ایک ایسا دفاع بناتے ہیں جو gracefully degrade
کرتا ہے — یہاں تک کہ اگر ایک پرت سمجھوتے میں آ جائے، تو باقی پرتیں سسٹم کی حفاظت
جاری رکھتی ہیں۔

::: warning سیکیورٹی Defense in depth کا مطلب ہے کہ کسی بھی ایک پرت میں کمزوری
سسٹم سے سمجھوتہ نہیں کرتی۔ کوئی حملہ آور جو channel authentication bypass کرتا ہے پھر
بھی session taint tracking، policy hooks، اور audit logging کا سامنا کرتا ہے۔ ایک LLM
جسے prompt-inject کیا گیا وہ اس کے نیچے یقینی policy پرت کو متاثر نہیں کر سکتا۔ :::

## 13 پرتیں

### پرت 1: Channel Authentication

**کیا بچاتی ہے:** نقالی، غیر مجاز رسائی، شناختی الجھن۔

شناخت **session establishment پر code** طے کرتا ہے، نہ کہ LLM پیغام کا مواد interpret
کرتا ہے۔ LLM کوئی پیغام دیکھنے سے پہلے، channel adapter اسے ایک ناقابل تبدیل label سے
tag کرتا ہے:

```
{ source: "owner" }    -- verified channel identity registered owner سے match
{ source: "external" } -- کوئی اور؛ صرف input، command نہیں سمجھا جاتا
```

Authentication methods channel کے مطابق مختلف ہوتے ہیں:

| Channel                 | طریقہ           | تصدیق                                                     |
| ----------------------- | --------------- | ---------------------------------------------------------- |
| Telegram / WhatsApp     | Pairing code    | One-time code، 5 منٹ کی میعاد، user کے account سے بھیجا  |
| Slack / Discord / Teams | OAuth           | Platform OAuth consent flow، verified user ID واپس        |
| CLI                     | Local process   | User کی مشین پر چل رہا، OS سے authenticated              |
| WebChat                 | کوئی نہیں (عوامی) | تمام زائرین `EXTERNAL`، کبھی `owner` نہیں              |
| Email                   | Domain matching | Sender domain configured internal domains سے موازنہ       |

::: info LLM کبھی فیصلہ نہیں کرتا کہ مالک کون ہے۔ ایک unverified sender کا "I am the
owner" کہنے والا پیغام `{ source: "external" }` tag ہوتا ہے اور owner-level commands
trigger نہیں کر سکتا۔ یہ فیصلہ code میں ہوتا ہے، LLM پیغام process کرنے سے پہلے۔ :::

### پرت 2: Permission-Aware Data Access

**کیا بچاتی ہے:** Over-permissioned ڈیٹا رسائی، system credentials کے ذریعے privilege
escalation۔

Triggerfish بیرونی systems کو query کرنے کے لیے system service accounts کی بجائے user
کے delegated OAuth tokens استعمال کرتا ہے۔ Source system اپنا permission model خود
نافذ کرتا ہے:

<img src="/diagrams/traditional-vs-triggerfish.svg" alt="Traditional vs Triggerfish: traditional model gives LLM direct control, Triggerfish routes all actions through a deterministic policy layer" style="max-width: 100%;" />

Plugin SDK یہ API سطح پر نافذ کرتا ہے:

| SDK Method                              | رویہ                                       |
| --------------------------------------- | ------------------------------------------- |
| `sdk.get_user_credential(integration)`  | User کا delegated OAuth token واپس کرتا ہے |
| `sdk.query_as_user(integration, query)` | User کی permissions کے ساتھ execute کرتا ہے |
| `sdk.get_system_credential(name)`       | **BLOCKED** — `PermissionError` raise کرتا ہے |

### پرت 3: Session Taint Tracking

**کیا بچاتی ہے:** Context contamination کے ذریعے ڈیٹا leakage، classified ڈیٹا کا
lower-classification channels تک پہنچنا۔

ہر session آزادانہ ایک taint level track کرتا ہے جو session کے دوران access کیے گئے
ڈیٹا کی سب سے زیادہ classification کی عکاسی کرتا ہے۔ Taint تین invariants پر عمل کرتا ہے:

1. **فی گفتگو** — ہر session کا اپنا taint
2. **صرف escalation** — taint بڑھتا ہے، کبھی کم نہیں ہوتا
3. **مکمل reset سب صاف کرتا ہے** — taint اور history ایک ساتھ مٹائے جاتے ہیں

جب policy engine کوئی output evaluate کرتا ہے، تو یہ session کے taint کا target channel
کی effective classification سے موازنہ کرتا ہے۔ اگر taint target سے زیادہ ہو، تو output
blocked ہو جاتا ہے۔

### پرت 4: Data Lineage

**کیا بچاتی ہے:** Untraceable ڈیٹا flows، ڈیٹا کہاں گیا اس کا آڈٹ نہ کر پانا،
compliance gaps۔

ہر ڈیٹا عنصر origin سے منزل تک provenance metadata لے جاتا ہے:

- **Origin**: کون سے integration، record، اور user access نے یہ ڈیٹا بنایا
- **Classification**: کون سی سطح تفویض کی گئی اور کیوں
- **Transformations**: LLM نے ڈیٹا کو کیسے modify، summarize، یا combine کیا
- **Destination**: کس session اور channel نے output receive کیا

Lineage forward traces ("یہ Salesforce record کہاں گیا؟")، backward traces ("اس output
میں کون سے ذرائع نے حصہ ڈالا؟")، اور مکمل compliance exports کو ممکن بناتا ہے۔

### پرت 5: Policy Enforcement Hooks

**کیا بچاتی ہے:** Prompt injection attacks، LLM-driven سیکیورٹی bypasses، بے قابو tool
execution۔

آٹھ یقینی hooks ڈیٹا بہاؤ میں ہر اہم نقطے پر ہر عمل کو روکتے ہیں:

| Hook                    | کیا روکتا ہے                              |
| ----------------------- | ----------------------------------------- |
| `PRE_CONTEXT_INJECTION` | Context window میں داخل ہونے والا بیرونی input |
| `PRE_TOOL_CALL`         | LLM کی tool execution کی درخواست          |
| `POST_TOOL_RESPONSE`    | Tool execution سے واپس آنے والا ڈیٹا     |
| `PRE_OUTPUT`            | سسٹم چھوڑنے والی response                 |
| `SECRET_ACCESS`         | Credential access request                 |
| `SESSION_RESET`         | Taint reset request                       |
| `AGENT_INVOCATION`      | Agent-to-agent call                       |
| `MCP_TOOL_CALL`         | MCP server tool invocation                |

Hooks خالص کوڈ ہیں: یقینی، synchronous، logged، اور unforgeable۔ LLM انہیں bypass
نہیں کر سکتا کیونکہ LLM output سے hook configuration تک کوئی راستہ نہیں ہے۔ Hook layer
commands کے لیے LLM output parse نہیں کرتی۔

### پرت 6: MCP Gateway

**کیا بچاتی ہے:** بے قابو بیرونی tool رسائی، MCP servers کے ذریعے داخل ہونے والا
unclassified ڈیٹا، schema violations۔

تمام MCP servers ڈیفالٹ `UNTRUSTED` ہیں اور invoke نہیں ہو سکتے جب تک admin یا user
انہیں classify نہ کرے۔ Gateway نافذ کرتا ہے:

- Server authentication اور classification status
- Tool-level permissions (انفرادی tools کو block کیا جا سکتا ہے یہاں تک کہ server
  allowed ہو)
- Request/response schema validation
- تمام MCP responses پر taint tracking
- Parameters میں injection pattern scanning

<img src="/diagrams/mcp-server-states.svg" alt="MCP server states: UNTRUSTED (default), CLASSIFIED (reviewed and permitted), BLOCKED (explicitly prohibited)" style="max-width: 100%;" />

### پرت 7: Plugin Sandbox

صارف کی ترتیب میں `enabled: true` کے ذریعے TypeScript پلگ ان فعال کریں۔ پہلے سے طے شدہ حالت میں درآمد اور اجرا محدود Deno Workers میں ہوتے ہیں۔ Worker پلگ ان کی ڈائریکٹری پڑھ سکتا ہے اور صرف `declaredEndpoints` میں درج میزبانوں اور پورٹس سے جڑ سکتا ہے۔ فائل لکھنے، عمل کے ماحول کو پڑھنے، ذیلی عمل چلانے، FFI اور محدود نظامی معلومات تک رسائی مسدود ہے۔ `trust: trusted` سے Triggerfish کے عمل میں درآمد کی اجازت ملتی ہے۔ اگر مینی فیسٹ بھی `trusted` ہو تو ایکزیکیوٹر وہیں چلتا ہے۔

[پلگ ان کی مکمل رہنمائی](../integrations/plugins)

### پرت 8: Secrets Isolation

**کیا بچاتی ہے:** Credential چوری، config files میں secrets، plaintext credential storage۔

Credentials OS keychain (personal tier) یا vault integration (enterprise tier) میں محفوظ
ہوتے ہیں۔ یہ کبھی نہیں آتے:

- Configuration files میں
- `StorageProvider` قدروں میں
- Log entries میں
- LLM context میں (credentials HTTP پرت پر inject ہوتے ہیں، LLM کے نیچے)

`SECRET_ACCESS` hook ہر credential رسائی کو requesting plugin، credential scope، اور
فیصلے کے ساتھ log کرتا ہے۔

### پرت 9: Filesystem Tool Sandbox

**کیا بچاتی ہے:** Path traversal attacks، غیر مجاز file رسائی، براہ راست filesystem
operations کے ذریعے classification bypass۔

تمام filesystem tool operations (read، write، edit، list، search) ایک sandboxed Deno
Worker کے اندر چلتے ہیں جس کی OS-level permissions session کی taint-appropriate workspace
subdirectory تک scoped ہیں۔ Sandbox تین حدود نافذ کرتا ہے:

- **Path jail** — ہر path ایک absolute path میں resolve ہوتا ہے اور separator-aware matching
  کے ساتھ jail root کے خلاف چیک ہوتا ہے۔ Workspace escape کرنے کی `../` کوشش کوئی I/O
  ہونے سے پہلے رد ہو جاتی ہے
- **Path classification** — ہر filesystem path کو ایک مقررہ resolution chain کے ذریعے
  classify کیا جاتا ہے: hardcoded protected paths (RESTRICTED)، workspace classification
  directories، configured path mappings، پھر ڈیفالٹ classification۔ ایجنٹ اپنے session
  taint سے اوپر paths access نہیں کر سکتا
- **Taint-scoped permissions** — sandbox Worker کی Deno permissions session کے موجودہ
  taint level سے match ہونے والی workspace subdirectory کو سیٹ ہیں۔ جب taint escalate
  ہو، Worker کو expanded permissions کے ساتھ respawn کیا جاتا ہے۔ Permissions صرف
  wide ہو سکتی ہیں، session میں narrow کبھی نہیں
- **Write protection** — اہم فائلیں (`TRIGGER.md`، `triggerfish.yaml`، `SPINE.md`) tool
  layer پر sandbox permissions سے قطع نظر write-protected ہیں۔ یہ فائلیں صرف dedicated
  management tools کے ذریعے modify ہو سکتی ہیں جو اپنے classification قواعد نافذ کرتی ہیں

### پرت 10: Agent Identity

**کیا بچاتی ہے:** Agent chains کے ذریعے privilege escalation، delegation کے ذریعے ڈیٹا
laundering۔

جب agents دوسرے agents کو invoke کرتے ہیں، cryptographic delegation chains privilege
escalation روکتی ہیں:

- ہر agent کے پاس اس کی صلاحیتوں اور classification ceiling کو specify کرنے والا ایک
  certificate ہے
- Callee `max(own taint, caller taint)` وراثت میں پاتا ہے — chains کے ذریعے taint
  صرف بڑھ سکتا ہے
- Callee کی ceiling سے زیادہ taint والا caller blocked ہے
- Circular invocations تلاش اور رد کی جاتی ہیں
- Delegation کی گہرائی محدود اور نافذ ہے

<img src="/diagrams/data-laundering-defense.svg" alt="Data laundering defense: attack path blocked at ceiling check and taint inheritance prevents output to lower-classification channels" style="max-width: 100%;" />

### پرت 11: Audit Logging

**کیا بچاتی ہے:** Undetectable breaches، compliance failures، incidents کی تفتیش نہ
کر پانا۔

ہر سیکیورٹی سے متعلقہ فیصلہ مکمل context کے ساتھ logged ہوتا ہے:

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

کیا log ہوتا ہے:

- تمام action requests (اجازت یافتہ اور رد شدہ دونوں)
- Classification فیصلے
- Session taint تبدیلیاں
- Channel authentication events
- Policy rule evaluations
- Lineage record creation اور updates
- MCP Gateway فیصلے
- Agent-to-agent invocations

::: info Audit logging کو disable نہیں کیا جا سکتا۔ یہ policy hierarchy میں ایک مقررہ
قاعدہ ہے۔ یہاں تک کہ ایک org admin اپنے اقدامات کے لیے logging بند نہیں کر سکتا۔
Enterprise deployments اختیاری طور پر forensic requirements کے لیے مکمل content logging
(blocked message content سمیت) فعال کر سکتے ہیں۔ :::

### پرت 12: SSRF Prevention

**کیا بچاتی ہے:** Server-side request forgery، اندرونی network reconnaissance، cloud
metadata exfiltration۔

تمام outbound HTTP requests (`web_fetch`، `browser.navigate`، اور plugin network access
سے) پہلے DNS resolve کرتے ہیں اور resolved IP کو private اور reserved ranges کی hardcoded
denylist کے خلاف چیک کرتے ہیں۔ یہ حملہ آور کو crafted URLs کے ذریعے ایجنٹ کو اندرونی
services تک رسائی کروانے سے روکتا ہے۔

- Private ranges (`10.0.0.0/8`، `172.16.0.0/12`، `192.168.0.0/16`) ہمیشہ blocked
- Link-local (`169.254.0.0/16`) اور cloud metadata endpoints blocked
- Loopback (`127.0.0.0/8`) blocked
- Denylist hardcoded اور قابل ترتیب نہیں — کوئی admin override نہیں
- Request سے پہلے DNS resolution ہوتا ہے، DNS rebinding attacks روکتا ہے

### پرت 13: Memory Classification Gating

**کیا بچاتی ہے:** Memory کے ذریعے cross-session ڈیٹا leakage، memory writes کے ذریعے
classification downgrade، classified memories تک غیر مجاز رسائی۔

Cross-session memory سسٹم write اور read دونوں وقت classification نافذ کرتا ہے:

- **Writes**: Memory entries موجودہ session کے taint level کو مجبور ہوتے ہیں۔ LLM stored
  memories کے لیے کم classification نہیں منتخب کر سکتا۔
- **Reads**: Memory queries `canFlowTo` سے filter ہوتی ہیں — ایک session صرف اپنے موجودہ
  taint level پر یا اس سے نیچے کی memories پڑھ سکتا ہے۔

یہ ایجنٹ کو CONFIDENTIAL ڈیٹا کو memory میں PUBLIC کے طور پر store کرنے اور بعد میں
no-write-down قاعدے کو bypass کرنے کے لیے lower-taint session میں اسے retrieve کرنے سے
روکتا ہے۔

## Trust Hierarchy

Trust model طے کرتا ہے کہ کس کا کیا اختیار ہے۔ اونچے tiers lower-tier سیکیورٹی قواعد
کو bypass نہیں کر سکتے، لیکن وہ ان قواعد کے اندر adjustable parameters configure کر
سکتے ہیں۔

<img src="/diagrams/trust-hierarchy.svg" alt="Trust hierarchy: Triggerfish vendor (zero access), Org Admin (sets policies), Employee (uses agent within boundaries)" style="max-width: 100%;" />

::: tip **Personal tier:** User خود org admin ہے۔ مکمل sovereignty۔ Triggerfish کی کوئی
visibility نہیں۔ Vendor کا ڈیفالٹ طور پر user ڈیٹا تک صفر رسائی ہے اور صرف user کی
واضح، وقت محدود، logged grant کے ذریعے رسائی حاصل کر سکتا ہے۔ :::

## پرتیں مل کر کیسے کام کرتی ہیں

ایک prompt injection attack پر غور کریں جہاں ایک malicious پیغام ڈیٹا exfiltrate کرنے
کی کوشش کرتا ہے:

| قدم | پرت                    | عمل                                                          |
| --- | ---------------------- | ------------------------------------------------------------ |
| 1   | Channel authentication | پیغام `{ source: "external" }` tag — مالک نہیں              |
| 2   | PRE_CONTEXT_INJECTION  | Input کو injection patterns کے لیے scan، classified         |
| 3   | Session taint          | Session taint unchanged (کوئی classified ڈیٹا access نہیں)  |
| 4   | LLM پیغام process کرتا | LLM کو tool call کی درخواست کرنے پر manipulate کیا جا سکتا  |
| 5   | PRE_TOOL_CALL          | External-source قواعد کے خلاف tool permission check         |
| 6   | POST_TOOL_RESPONSE     | واپس آنے والا ڈیٹا classified، taint updated                 |
| 7   | PRE_OUTPUT             | Output classification بمقابلہ target checked                 |
| 8   | Audit logging          | پوری sequence review کے لیے recorded                         |

یہاں تک کہ اگر LLM مرحلہ 4 پر مکمل compromised ہو اور data exfiltration tool call کی
درخواست کرے، باقی پرتیں (permission checks، taint tracking، output classification، audit
logging) پالیسی نافذ کرتی رہتی ہیں۔ ناکامی کا کوئی ایک نقطہ سسٹم سے سمجھوتہ نہیں کرتا۔
