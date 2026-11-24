# Architecture கண்ணோட்டம்

Triggerfish ஒரு பாதுகாப்பான, பல-சேனல் AI agent தளம் ஒரு முதன்மை invariant உடன்:

::: warning SECURITY **பாதுகாப்பு நிர்ணயவாதமானது மற்றும் sub-LLM ஆகும்.** ஒவ்வொரு பாதுகாப்பு முடிவும் தூய கோட்டால் செய்யப்படுகிறது, LLM க்கு bypass, override அல்லது தாக்கம் செய்ய முடியாது. LLM க்கு பூஜ்ய அதிகாரம் உள்ளது -- அது செயல்களை கோருகிறது; policy அடுக்கு முடிவு செய்கிறது. :::

இந்த பக்கம் Triggerfish எவ்வாறு செயல்படுகிறது என்பதன் பெரிய படத்தை வழங்குகிறது. ஒவ்வொரு முதன்மை கூறும் ஒரு தனி deep-dive பக்கத்தை இணைக்கிறது.

## கணினி Architecture

<img src="/diagrams/system-architecture.svg" alt="System architecture: channels flow through the Channel Router to the Gateway, which coordinates Session Manager, Policy Engine, and Agent Loop" style="max-width: 100%;" />

### தரவு ஓட்டம்

ஒவ்வொரு செய்தியும் கணினி வழியாக இந்த பாதையை பின்பற்றுகிறது:

<img src="/diagrams/data-flow-9-steps.svg" alt="Data flow: 9-step pipeline from inbound message through policy hooks to outbound delivery" style="max-width: 100%;" />

ஒவ்வொரு அமலாக்க புள்ளியிலும், முடிவு நிர்ணயவாதமானது -- ஒரே input எப்போதும் ஒரே முடிவை உருவாக்கும். hooks க்கு உள்ளே LLM அழைப்புகள் இல்லை, சீரற்றதன்மை இல்லை, மற்றும் LLM முடிவை தாக்க எந்த வழியும் இல்லை.

## முதன்மை கூறுகள்

### வகைப்படுத்தல் கணினி

தரவு நான்கு வரிசைப்படுத்தப்பட்ட நிலைகள் வழியாக ஓடுகிறது:
`RESTRICTED > CONFIDENTIAL > INTERNAL > PUBLIC`. முதன்மை விதி **no write-down**: தரவு சம அல்லது அதிக வகைப்படுத்தலுக்கு மட்டுமே ஓட முடியும். `CONFIDENTIAL` session `PUBLIC` சேனலுக்கு தரவை அனுப்ப முடியாது. விதிவிலக்கு இல்லை. LLM override இல்லை.

[வகைப்படுத்தல் கணினியைப் பற்றி மேலும் படிக்கவும்.](./classification)

### Policy Engine மற்றும் Hooks

எட்டு நிர்ணயவாத அமலாக்க hooks தரவு ஓட்டத்தில் முக்கியமான புள்ளிகளில் ஒவ்வொரு செயலையும் இடைமறிக்கின்றன. Hooks தூய functions: synchronous, logged மற்றும் unforgeable. policy engine நிலையான விதிகளை (ஒருபோதும் கட்டமைக்கக்கூடியதல்ல), admin-tunable விதிகளை மற்றும் enterprise க்கு declarative YAML escape hatches ஆதரிக்கிறது.

[Policy Engine பற்றி மேலும் படிக்கவும்.](./policy-engine)

### Sessions மற்றும் Taint

ஒவ்வொரு உரையாடலும் சுயாதீன taint கண்காணிப்புடன் ஒரு session. ஒரு session வகைப்படுத்தப்பட்ட தரவை அணுகும்போது, அதன் taint அந்த நிலைக்கு உயர்கிறது மற்றும் session க்குள் ஒருபோதும் குறையாது. முழு reset taint மற்றும் உரையாடல் வரலாற்றை அழிக்கிறது. ஒவ்வொரு தரவு உறுப்பும் lineage கண்காணிப்பு கணினி மூலம் provenance metadata சுமக்கிறது.

[Sessions மற்றும் Taint பற்றி மேலும் படிக்கவும்.](./taint-and-sessions)

### Gateway

Gateway மத்திய control plane -- sessions, channels, tools, events மற்றும் agent processes ஐ WebSocket JSON-RPC endpoint மூலம் நிர்வகிக்கும் நீண்ட நேரம் இயங்கும் உள்ளூர் service. இது notification service, cron scheduler, webhook ingestion மற்றும் channel routing ஐ ஒருங்கிணைக்கிறது.

[Gateway பற்றி மேலும் படிக்கவும்.](./gateway)

### Storage

அனைத்து stateful தரவும் ஒரு unified `StorageProvider` abstraction மூலம் ஓடுகிறது. Namespaced விசைகள் (`sessions:`, `taint:`, `lineage:`, `audit:`) business logic ஐ தொடாமல் backends மாற்றுவதை அனுமதிக்கும்போது கவலைகளை பிரிக்கின்றன. இயல்புநிலை `~/.triggerfish/data/triggerfish.db` இல் SQLite WAL ஆகும்.

[Storage பற்றி மேலும் படிக்கவும்.](./storage)

### ஆழமான பாதுகாப்பு

பாதுகாப்பு 13 சுயாதீன வழிமுறைகளில் அடுக்கிடப்பட்டுள்ளது, channel authentication மற்றும் permission-aware data access இலிருந்து session taint, policy hooks, plugin sandboxing, filesystem tool sandboxing மற்றும் audit logging வரை. எந்த ஒரு அடுக்கும் தனியாக போதுமானதல்ல; ஒன்றாக அவை ஒரு அடுக்கு சமரசம் ஆனாலும் gracefully குறையும் பாதுகாப்பை உருவாக்குகின்றன.

[ஆழமான பாதுகாப்பு பற்றி மேலும் படிக்கவும்.](./defense-in-depth)

## Design கொள்கைகள்

| கொள்கை                        | அர்த்தம்                                                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **நிர்ணயவாத அமலாக்கம்**       | Policy hooks தூய functions பயன்படுத்துகின்றன. LLM அழைப்புகள் இல்லை, சீரற்றதன்மை இல்லை. ஒரே input எப்போதும் ஒரே முடிவை உருவாக்கும். |
| **Taint பரவல்**                | அனைத்து தரவும் classification metadata சுமக்கிறது. Session taint மட்டுமே உயரலாம், குறையாது.                                   |
| **No write-down**              | தரவு குறைந்த வகைப்படுத்தல் நிலைக்கு ஒருபோதும் ஓட முடியாது.                                                                  |
| **எல்லாவற்றையும் audit செய்**  | அனைத்து policy முடிவுகளும் முழு சூழல் உடன் log ஆகும்: timestamp, hook type, session ID, input, result, விதிகள் மதிப்பீடு செய்யப்பட்டன. |
| **Hooks unforgeable**          | LLM policy hook முடிவுகளை bypass, modify அல்லது தாக்க முடியாது. Hooks LLM அடுக்கிற்கு கீழ் கோட்டில் இயங்குகின்றன.          |
| **Session தனிமைப்படுத்தல்**   | ஒவ்வொரு session சுயாதீனமாக taint கண்காணிக்கிறது. Background sessions புதிய PUBLIC taint உடன் உருவாக்கப்படுகின்றன. Agent workspaces முழுமையாக தனிமைப்படுத்தப்பட்டுள்ளன. |
| **Storage abstraction**        | எந்த module அதன் சொந்த storage உருவாக்குவதில்லை. அனைத்து persistence `StorageProvider` மூலம் ஓடுகிறது.                      |

## Technology Stack

| கூறு               | Technology                                                                |
| ------------------ | ------------------------------------------------------------------------- |
| Runtime            | Deno 2.x (TypeScript strict mode)                                         |
| Testing            | Deno built-in test runner                                                 |
| Channels           | Baileys (WhatsApp), grammY (Telegram), Bolt (Slack), discord.js (Discord) |
| Browser automation | puppeteer-core (CDP)                                                      |
| Voice              | Whisper (local STT), ElevenLabs/OpenAI (TTS)                              |
| Storage            | SQLite WAL (இயல்புநிலை), enterprise backends (Postgres, S3)              |
| Secrets            | OS keychain (personal), vault integration (enterprise)                    |

::: info Triggerfish வெளிப்புற build tools, Docker அல்லது cloud dependency தேவையில்லை. இது உள்ளூரில் இயங்குகிறது, தரவை உள்ளூரில் செயலாக்குகிறது, மற்றும் பயனருக்கு அவர்களின் தரவின் மீது முழு sovereignty வழங்குகிறது. :::
