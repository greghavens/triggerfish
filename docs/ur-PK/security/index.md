# سیکیورٹی-اول ڈیزائن

Triggerfish ایک واحد بنیاد پر بنا ہے: **LLM کا صفر اختیار ہے**۔ یہ اقدامات کی درخواست
کرتا ہے؛ policy layer فیصلہ کرتی ہے۔ ہر سیکیورٹی فیصلہ یقینی کوڈ کرتا ہے جسے AI
bypass، override، یا متاثر نہیں کر سکتا۔

یہ صفحہ بیان کرتا ہے کہ Triggerfish یہ نقطہ نظر کیوں اختیار کرتا ہے، یہ روایتی AI
ایجنٹ پلیٹ فارمز سے کیسے مختلف ہے، اور سیکیورٹی ماڈل کے ہر component کی تفصیلات
کہاں ملیں گی۔

## سیکیورٹی LLM کی تہہ کے نیچے کیوں ہونی چاہیے

Large language models کو prompt-inject کیا جا سکتا ہے۔ ایک احتیاط سے تیار کردہ ان پٹ —
چاہے کسی malicious بیرونی پیغام سے، کسی poisoned دستاویز سے، یا کسی compromised tool
response سے — LLM کو اس کی ہدایات نظرانداز کرنے اور ایسے اقدامات کرنے پر مجبور کر
سکتا ہے جن سے اسے روکا گیا تھا۔ یہ نظریاتی خطرہ نہیں ہے۔ یہ AI industry میں ایک
اچھی طرح دستاویزی، حل نہ شدہ مسئلہ ہے۔

اگر آپ کا سیکیورٹی ماڈل LLM کے قواعد پر عمل کرنے پر منحصر ہو، تو ایک کامیاب injection
آپ کے بنائے ہر حفاظتی اقدام کو bypass کر سکتی ہے۔

Triggerfish اس کا حل یہ کر کے نکالتا ہے کہ تمام سیکیورٹی نافذ کاری کو ایک کوڈ پرت
میں منتقل کرتا ہے جو LLM کی **تہہ کے نیچے** ہے۔ AI کبھی سیکیورٹی فیصلے نہیں دیکھتا۔
یہ کبھی evaluate نہیں کرتا کہ آیا کوئی عمل اجازت یافتہ ہونا چاہیے۔ یہ صرف اقدامات
کی درخواست کرتا ہے، اور policy enforcement layer — خالص، یقینی کوڈ کے طور پر چلتی ہے
— فیصلہ کرتی ہے کہ آیا وہ اقدامات آگے بڑھتے ہیں۔

<img src="/diagrams/enforcement-layers.svg" alt="Enforcement layers: LLM has zero authority, policy layer makes all decisions deterministically, only allowed actions reach execution" style="max-width: 100%;" />

::: warning سیکیورٹی LLM پرت کے پاس policy enforcement layer کو override، skip، یا
متاثر کرنے کا کوئی طریقہ نہیں ہے۔ "LLM output کو bypass commands کے لیے parse کریں"
کی کوئی logic نہیں ہے۔ علیحدگی architectural ہے، behavioral نہیں۔ :::

## بنیادی Invariant

Triggerfish میں ہر design فیصلہ ایک invariant سے نکلتا ہے:

> **ایک ہی ان پٹ ہمیشہ ایک ہی سیکیورٹی فیصلہ دیتا ہے۔ کوئی بے ترتیبی نہیں، کوئی LLM
> calls نہیں، کوئی صوابدید نہیں۔**

اس کا مطلب ہے کہ سیکیورٹی رویہ:

- **قابل آڈٹ** ہے — آپ کوئی بھی فیصلہ replay کر سکتے ہیں اور ایک ہی نتیجہ پائیں گے
- **قابل جانچ** ہے — یقینی کوڈ خودکار tests سے cover ہو سکتا ہے
- **قابل تصدیق** ہے — policy engine اوپن سورس (Apache 2.0 licensed) ہے اور کوئی بھی
  اسے inspect کر سکتا ہے

## سیکیورٹی اصول

| اصول                     | اس کا مطلب                                                                                                                                              | تفصیل صفحہ                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **ڈیٹا Classification**   | تمام ڈیٹا حساسیت کی سطح لے جاتا ہے (RESTRICTED، CONFIDENTIAL، INTERNAL، PUBLIC)۔ Classification ڈیٹا کے سسٹم میں داخل ہونے پر کوڈ کے ذریعے تفویض۔   | [Architecture: Classification](/ur-PK/architecture/classification) |
| **No Write-Down**        | ڈیٹا صرف برابر یا اونچی classification والے channels اور recipients کی طرف بہہ سکتا ہے۔ CONFIDENTIAL ڈیٹا PUBLIC channel تک نہیں پہنچ سکتا۔ کوئی استثناء نہیں۔ | [No Write-Down قاعدہ](./no-write-down)            |
| **Session Taint**        | جب session ایک classification سطح پر ڈیٹا access کرتا ہے، تو پوری session اس سطح تک tainted ہو جاتی ہے۔ Taint صرف escalate ہو سکتا ہے، کبھی کم نہیں۔ | [Architecture: Taint](/ur-PK/architecture/taint-and-sessions) |
| **یقینی Hooks**          | آٹھ enforcement hooks ہر ڈیٹا بہاؤ میں اہم نقطوں پر چلتے ہیں۔ ہر hook synchronous، logged، اور unforgeable ہے۔                                       | [Architecture: Policy Engine](/ur-PK/architecture/policy-engine) |
| **کوڈ میں شناخت**        | User شناخت session establishment پر کوڈ طے کرتا ہے، نہ کہ LLM پیغام کا مواد interpret کرتا ہے۔                                                        | [Identity اور Auth](./identity)                               |
| **Agent Delegation**     | Agent-to-agent calls cryptographic certificates، classification ceilings، اور depth limits سے governed ہیں۔                                             | [Agent Delegation](./agent-delegation)                        |
| **Secrets Isolation**    | Credentials OS keychains یا vaults میں محفوظ ہوتے ہیں، config files میں کبھی نہیں۔ Plugins system credentials تک رسائی نہیں کر سکتے۔                  | [Secrets Management](./secrets)                               |
| **سب کچھ Audit کریں**   | ہر policy فیصلہ مکمل context کے ساتھ logged: timestamp، hook type، session ID، input، result، اور قواعد evaluated۔                                     | [Audit اور Compliance](./audit-logging)                       |

## روایتی AI Agents بمقابلہ Triggerfish

زیادہ تر AI ایجنٹ پلیٹ فارمز سیکیورٹی نافذ کرنے کے لیے LLM پر انحصار کرتے ہیں۔ System
prompt کہتا ہے "حساس ڈیٹا شیئر نہ کریں،" اور ایجنٹ پر اعتماد کیا جاتا ہے کہ عمل کرے۔
اس نقطہ نظر میں بنیادی کمزوریاں ہیں۔

| پہلو                          | روایتی AI Agent                        | Triggerfish                                                        |
| ----------------------------- | -------------------------------------- | ------------------------------------------------------------------ |
| **سیکیورٹی نافذ کاری**        | LLM کو system prompt ہدایات            | LLM کی تہہ کے نیچے یقینی کوڈ                                     |
| **Prompt injection دفاع**     | امید کریں کہ LLM مزاحمت کرے           | LLM کو شروع سے کوئی اختیار نہیں                                   |
| **ڈیٹا بہاؤ کنٹرول**          | LLM فیصلہ کرتا ہے کیا محفوظ شیئر کریں | Classification labels + no-write-down قاعدہ کوڈ میں               |
| **شناخت تصدیق**               | LLM "I am the admin" interpret کرتا    | کوڈ cryptographic channel identity چیک کرتا                       |
| **Audit trail**                | LLM conversation logs                  | Full context کے ساتھ structured policy decision logs              |
| **Credential رسائی**          | تمام users کے لیے system service account | Delegated user credentials؛ source system permissions وراثت میں  |
| **قابل جانچ**                  | Fuzzy — prompt wording پر منحصر       | Deterministic — ایک ہی input، ایک ہی فیصلہ، ہر بار               |
| **تصدیق کے لیے کھلا**         | عموماً proprietary                     | Apache 2.0 licensed، مکمل auditable                               |

::: tip Triggerfish یہ دعویٰ نہیں کرتا کہ LLMs غیر قابل اعتماد ہیں۔ یہ دعویٰ کرتا
ہے کہ LLMs سیکیورٹی نافذ کاری کے لیے غلط پرت ہیں۔ ایک اچھی طرح prompted LLM زیادہ تر
وقت اپنی ہدایات پر عمل کرے گا۔ لیکن "زیادہ تر وقت" سیکیورٹی ضمانت نہیں ہے۔ Triggerfish
ایک ضمانت فراہم کرتا ہے: policy layer کوڈ ہے، اور کوڈ جو کہا جائے وہی کرتا ہے، ہر بار۔ :::

## Defense in Depth

Triggerfish دفاع کی تیرہ پرتیں implement کرتا ہے۔ کوئی ایک پرت اکیلے کافی نہیں؛ مل
کر، وہ ایک سیکیورٹی حد بناتی ہیں:

1. **Channel authentication** — session establishment پر code-verified شناخت
2. **Permission-aware data access** — source system permissions، system credentials نہیں
3. **Session taint tracking** — خودکار، لازمی، صرف escalation
4. **Data lineage** — ہر ڈیٹا عنصر کے لیے مکمل provenance chain
5. **Policy enforcement hooks** — یقینی، non-bypassable، logged
6. **MCP Gateway** — per-tool permissions کے ساتھ محفوظ بیرونی tool رسائی
7. **[Plugin sandbox](../integrations/plugins)**
8. **Secrets isolation** — OS keychain یا vault، config files میں کبھی نہیں
9. **Filesystem tool sandbox** — path jail، path classification، taint-scoped OS-level I/O permissions
10. **Agent identity** — cryptographic delegation chains
11. **Audit logging** — تمام فیصلے recorded، کوئی استثناء نہیں
12. **SSRF prevention** — تمام outbound HTTP پر IP denylist + DNS resolution checks
13. **Memory classification gating** — writes session taint کو مجبور، reads `canFlowTo` سے filter

## اگلے اقدامات

| صفحہ                                                          | وضاحت                                                                          |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| [Classification گائیڈ](/ur-PK/guide/classification-guide)    | Channels، MCP servers، اور integrations کے لیے صحیح سطح منتخب کرنے کی عملی گائیڈ |
| [No Write-Down قاعدہ](./no-write-down)                        | بنیادی ڈیٹا بہاؤ قاعدہ اور اسے کیسے نافذ کیا جاتا ہے                          |
| [Identity اور Auth](./identity)                               | Channel authentication اور مالک کی شناخت تصدیق                                 |
| [Agent Delegation](./agent-delegation)                        | Agent-to-agent شناخت، certificates، اور delegation chains                       |
| [Secrets Management](./secrets)                               | Triggerfish تمام tiers میں credentials کیسے handle کرتا ہے                     |
| [Audit اور Compliance](./audit-logging)                       | Audit trail ساخت، tracing، اور compliance exports                              |
