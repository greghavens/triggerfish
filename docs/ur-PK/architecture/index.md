# Architecture کا جائزہ

Triggerfish ایک محفوظ، کثیر چینل AI ایجنٹ پلیٹ فارم ہے جس کا ایک مرکزی اصول ہے:

::: warning سیکیورٹی **سیکیورٹی یقینی اور sub-LLM ہے۔** ہر سیکیورٹی فیصلہ خالص کوڈ
کرتا ہے جسے LLM bypass، override، یا متاثر نہیں کر سکتا۔ LLM کا صفر اختیار ہے —
یہ اقدامات کی درخواست کرتا ہے؛ پالیسی پرت فیصلہ کرتی ہے۔ :::

یہ صفحہ Triggerfish کے کام کرنے کی بڑی تصویر فراہم کرتا ہے۔ ہر بڑا component ایک
dedicated گہری نظر والے صفحے سے جڑا ہے۔

## سسٹم Architecture

<img src="/diagrams/system-architecture.svg" alt="System architecture: channels flow through the Channel Router to the Gateway, which coordinates Session Manager, Policy Engine, and Agent Loop" style="max-width: 100%;" />

### ڈیٹا کا بہاؤ

ہر پیغام سسٹم سے اس راستے پر چلتا ہے:

<img src="/diagrams/data-flow-9-steps.svg" alt="Data flow: 9-step pipeline from inbound message through policy hooks to outbound delivery" style="max-width: 100%;" />

ہر نافذ کاری نقطے پر، فیصلہ یقینی ہوتا ہے — ایک ہی ان پٹ ہمیشہ ایک ہی نتیجہ دیتا ہے۔
hooks کے اندر کوئی LLM calls نہیں، کوئی بے ترتیبی نہیں، اور LLM کے لیے نتیجے کو
متاثر کرنے کا کوئی راستہ نہیں۔

## بڑے Components

### Classification سسٹم

ڈیٹا چار ترتیب دی گئی سطحوں سے بہتا ہے:
`RESTRICTED > CONFIDENTIAL > INTERNAL > PUBLIC`۔ بنیادی قاعدہ ہے **no
write-down**: ڈیٹا صرف برابر یا اونچی classification کی طرف بہہ سکتا ہے۔ ایک
`CONFIDENTIAL` session `PUBLIC` چینل کو ڈیٹا نہیں بھیج سکتا۔ کوئی استثناء نہیں۔ کوئی
LLM override نہیں۔

[Classification سسٹم کے بارے میں مزید پڑھیں۔](./classification)

### Policy Engine اور Hooks

آٹھ یقینی نافذ کاری hooks ڈیٹا بہاؤ میں ہر اہم نقطے پر ہر عمل کو روکتے ہیں۔ Hooks
خالص functions ہیں: synchronous، logged، اور unforgeable۔ Policy engine مقررہ قواعد
(کبھی قابل ترتیب نہیں)، admin-tunable قواعد، اور enterprise کے لیے declarative YAML escape
hatches کی حمایت کرتا ہے۔

[Policy Engine کے بارے میں مزید پڑھیں۔](./policy-engine)

### Sessions اور Taint

ہر گفتگو ایک session ہے جس میں آزاد taint ٹریکنگ ہوتی ہے۔ جب کوئی session classified
ڈیٹا access کرتا ہے، تو اس کا taint اس سطح تک escalate ہوتا ہے اور session میں کبھی
کم نہیں ہو سکتا۔ مکمل reset taint اور conversation history دونوں صاف کرتا ہے۔ ہر ڈیٹا
عنصر ایک lineage ٹریکنگ سسٹم کے ذریعے provenance metadata لے جاتا ہے۔

[Sessions اور Taint کے بارے میں مزید پڑھیں۔](./taint-and-sessions)

### Gateway

Gateway مرکزی control plane ہے — ایک طویل مدتی مقامی سروس جو WebSocket JSON-RPC
endpoint کے ذریعے sessions، channels، tools، events، اور agent processes کا انتظام
کرتی ہے۔ یہ notification service، cron scheduler، webhook ingestion، اور channel routing
کو coordinate کرتی ہے۔

[Gateway کے بارے میں مزید پڑھیں۔](./gateway)

### Storage

تمام stateful ڈیٹا ایک unified `StorageProvider` abstraction سے بہتا ہے۔
Namespaced keys (`sessions:`، `taint:`، `lineage:`، `audit:`) concerns کو الگ رکھتے ہیں
جبکہ backends کو business logic کو چھوئے بغیر swap کرنے کی اجازت دیتے ہیں۔ ڈیفالٹ
`~/.triggerfish/data/triggerfish.db` پر SQLite WAL ہے۔

[Storage کے بارے میں مزید پڑھیں۔](./storage)

### Defense in Depth

سیکیورٹی 13 آزاد mechanisms میں layered ہے، channel authentication اور permission-aware
data access سے لے کر session taint، policy hooks، plugin sandboxing، filesystem tool
sandboxing، اور audit logging تک۔ کوئی ایک پرت اکیلے کافی نہیں؛ مل کر وہ ایسا دفاع
بناتے ہیں جو gracefully degrade کرتا ہے یہاں تک کہ ایک پرت سمجھوتے میں آ جائے۔

[Defense in Depth کے بارے میں مزید پڑھیں۔](./defense-in-depth)

## ڈیزائن اصول

| اصول                          | اس کا مطلب                                                                                                                        |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **یقینی نافذ کاری**           | Policy hooks خالص functions استعمال کرتے ہیں۔ کوئی LLM calls نہیں، کوئی بے ترتیبی نہیں۔ ایک ہی ان پٹ ہمیشہ ایک ہی فیصلہ۔    |
| **Taint propagation**         | تمام ڈیٹا classification metadata لے جاتا ہے۔ Session taint صرف escalate ہو سکتا ہے، کبھی کم نہیں۔                              |
| **No write-down**             | ڈیٹا کم classification سطح کی طرف نہیں بہہ سکتا۔ کبھی نہیں۔                                                                    |
| **سب کچھ audit کریں**         | تمام policy فیصلے مکمل context کے ساتھ logged: timestamp، hook type، session ID، input، result، قواعد evaluate کیے گئے۔         |
| **Hooks unforgeable ہیں**     | LLM policy hook فیصلوں کو bypass، modify، یا متاثر نہیں کر سکتا۔ Hooks LLM کی پرت کے نیچے کوڈ میں چلتے ہیں۔                  |
| **Session isolation**         | ہر session آزادانہ taint track کرتا ہے۔ بیک گراؤنڈ sessions تازہ PUBLIC taint کے ساتھ spawn ہوتے ہیں۔ Agent workspaces مکمل الگ ہیں۔ |
| **Storage abstraction**       | کوئی module اپنا storage نہیں بناتا۔ تمام persistence `StorageProvider` سے بہتا ہے۔                                              |

## Technology Stack

| Component          | Technology                                                                |
| ------------------ | ------------------------------------------------------------------------- |
| Runtime            | Deno 2.x (TypeScript strict mode)                                         |
| Testing            | Deno built-in test runner                                                 |
| Channels           | Baileys (WhatsApp), grammY (Telegram), Bolt (Slack), discord.js (Discord) |
| Browser automation | puppeteer-core (CDP)                                                      |
| Voice              | Whisper (local STT), ElevenLabs/OpenAI (TTS)                              |
| Storage            | SQLite WAL (default), enterprise backends (Postgres, S3)                  |
| Secrets            | OS keychain (personal), vault integration (enterprise)                    |

::: info Triggerfish کو کوئی بیرونی build tools، کوئی Docker، اور کوئی cloud
dependency کی ضرورت نہیں۔ یہ مقامی طور پر چلتا ہے، ڈیٹا مقامی طور پر process کرتا ہے،
اور صارف کو اپنے ڈیٹا پر مکمل sovereignty دیتا ہے۔ :::
