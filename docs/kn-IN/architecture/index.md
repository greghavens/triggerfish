# ಆರ್ಕಿಟೆಕ್ಚರ್ ಅವಲೋಕನ

Triggerfish ಒಂದು ಸುರಕ್ಷಿತ, ಬಹು-ಚಾನೆಲ್ AI ಏಜೆಂಟ್ ಪ್ಲ್ಯಾಟ್‌ಫಾರ್ಮ್ ಆಗಿದ್ದು ಒಂದು ಮುಖ್ಯ
ಅಚಲ ತತ್ವ ಹೊಂದಿದೆ:

::: warning SECURITY **ಭದ್ರತೆ ನಿರ್ಧಾರಾತ್ಮಕ ಮತ್ತು sub-LLM.** ಪ್ರತಿ ಭದ್ರತಾ ನಿರ್ಧಾರ
LLM ಬೈಪಾಸ್ ಮಾಡಲು, ಅತಿಕ್ರಮಿಸಲು ಅಥವಾ ಪ್ರಭಾವಿಸಲು ಸಾಧ್ಯವಿಲ್ಲದ ಶುದ್ಧ ಕೋಡ್‌ನಿಂದ ಮಾಡಲ್ಪಡುತ್ತದೆ.
LLM ಗೆ ಶೂನ್ಯ ಅಧಿಕಾರ -- ಅದು ಕ್ರಿಯೆಗಳನ್ನು ವಿನಂತಿಸುತ್ತದೆ; ನೀತಿ ಪದರ ನಿರ್ಧರಿಸುತ್ತದೆ. :::

ಈ ಪುಟ Triggerfish ಹೇಗೆ ಕೆಲಸ ಮಾಡುತ್ತದೆ ಎಂಬ ದೊಡ್ಡ ಚಿತ್ರ ಒದಗಿಸುತ್ತದೆ. ಪ್ರತಿ ಮುಖ್ಯ
ಘಟಕ ಮೀಸಲಾದ ಆಳ-ಅಧ್ಯಯನ ಪುಟಕ್ಕೆ ಲಿಂಕ್ ಮಾಡುತ್ತದೆ.

## ಸಿಸ್ಟಂ ಆರ್ಕಿಟೆಕ್ಚರ್

<img src="/diagrams/system-architecture.svg" alt="System architecture: channels flow through the Channel Router to the Gateway, which coordinates Session Manager, Policy Engine, and Agent Loop" style="max-width: 100%;" />

### ಡೇಟಾ ಹರಿವು

ಪ್ರತಿ ಸಂದೇಶ ಸಿಸ್ಟಂ ಮೂಲಕ ಈ ಮಾರ್ಗ ಅನುಸರಿಸುತ್ತದೆ:

<img src="/diagrams/data-flow-9-steps.svg" alt="Data flow: 9-step pipeline from inbound message through policy hooks to outbound delivery" style="max-width: 100%;" />

ಪ್ರತಿ ಜಾರಿ ಬಿಂದುವಿನಲ್ಲಿ, ನಿರ್ಧಾರ ನಿರ್ಧಾರಾತ್ಮಕ -- ಒಂದೇ ಇನ್‌ಪುಟ್ ಯಾವಾಗಲೂ ಒಂದೇ
ಫಲಿತಾಂಶ ನೀಡುತ್ತದೆ.

## ಮುಖ್ಯ ಘಟಕಗಳು

### ವರ್ಗೀಕರಣ ಸಿಸ್ಟಂ

ಡೇಟಾ ನಾಲ್ಕು ಕ್ರಮಬದ್ಧ ಮಟ್ಟಗಳ ಮೂಲಕ ಹರಿಯುತ್ತದೆ:
`RESTRICTED > CONFIDENTIAL > INTERNAL > PUBLIC`. ಮುಖ್ಯ ನಿಯಮ **no write-down**:
ಡೇಟಾ ಕೇವಲ ಸಮಾನ ಅಥವಾ ಹೆಚ್ಚಿನ ವರ್ಗೀಕರಣಕ್ಕೆ ಹರಿಯಬಹುದು.

[ವರ್ಗೀಕರಣ ಸಿಸ್ಟಂ ಬಗ್ಗೆ ಇನ್ನಷ್ಟು ಓದಿ.](./classification)

### ನೀತಿ ಎಂಜಿನ್ ಮತ್ತು Hooks

ಎಂಟು ನಿರ್ಧಾರಾತ್ಮಕ ಜಾರಿ hooks ಡೇಟಾ ಹರಿವಿನ ಮುಖ್ಯ ಬಿಂದುಗಳಲ್ಲಿ ಪ್ರತಿ ಕ್ರಿಯೆ
ತಡೆಯುತ್ತವೆ. Hooks ಶುದ್ಧ ಕಾರ್ಯಗಳು: ಸಮಕಾಲೀನ, ದಾಖಲಿಸಲ್ಪಟ್ಟ ಮತ್ತು ಅಭೇದ್ಯ.

[ನೀತಿ ಎಂಜಿನ್ ಬಗ್ಗೆ ಇನ್ನಷ್ಟು ಓದಿ.](./policy-engine)

### Sessions ಮತ್ತು Taint

ಪ್ರತಿ ಸಂಭಾಷಣೆ ಸ್ವತಂತ್ರ taint ಟ್ರ್ಯಾಕಿಂಗ್‌ನೊಂದಿಗೆ ಒಂದು session. Session ವರ್ಗೀಕೃತ ಡೇಟಾ
ಪ್ರವೇಶಿಸಿದಾಗ, ಅದರ taint ಆ ಮಟ್ಟಕ್ಕೆ ಏರುತ್ತದೆ ಮತ್ತು session ಒಳಗೆ ಎಂದಿಗೂ ಇಳಿಯಲಾಗುವುದಿಲ್ಲ.

[Sessions ಮತ್ತು Taint ಬಗ್ಗೆ ಇನ್ನಷ್ಟು ಓದಿ.](./taint-and-sessions)

### Gateway

Gateway ಕೇಂದ್ರ ನಿಯಂತ್ರಣ ಸಮತಲ -- WebSocket JSON-RPC endpoint ಮೂಲಕ sessions,
channels, tools, events ಮತ್ತು agent processes ನಿರ್ವಹಿಸುವ ದೀರ್ಘ-ಚಾಲನೆಯ ಸ್ಥಳೀಯ ಸೇವೆ.

[Gateway ಬಗ್ಗೆ ಇನ್ನಷ್ಟು ಓದಿ.](./gateway)

### Storage

ಎಲ್ಲ ಸ್ಥಿತಿಪ್ರಧಾನ ಡೇಟಾ ಏಕೀಕೃತ `StorageProvider` ಅಮೂರ್ತತೆ ಮೂಲಕ ಹರಿಯುತ್ತದೆ.
ಡಿಫಾಲ್ಟ್ `~/.triggerfish/data/triggerfish.db` ನಲ್ಲಿ SQLite WAL.

[Storage ಬಗ್ಗೆ ಇನ್ನಷ್ಟು ಓದಿ.](./storage)

### ಆಳ-ರಕ್ಷಣೆ

ಭದ್ರತೆ ಚಾನೆಲ್ ದೃಢೀಕರಣ, ಅನುಮತಿ-ಅರಿವಿನ ಡೇಟಾ ಪ್ರವೇಶ, session taint, ನೀತಿ hooks,
plugin sandboxing, filesystem tool sandboxing ಮತ್ತು audit logging ಸೇರಿದಂತೆ 13 ಸ್ವತಂತ್ರ
ಕಾರ್ಯವಿಧಾನಗಳಾದ್ಯಂತ ಪದರಗಳಲ್ಲಿ ಅಳವಡಿಸಲಾಗಿದೆ.

[ಆಳ-ರಕ್ಷಣೆ ಬಗ್ಗೆ ಇನ್ನಷ್ಟು ಓದಿ.](./defense-in-depth)

## ವಿನ್ಯಾಸ ತತ್ವಗಳು

| ತತ್ವ                          | ಅರ್ಥ                                                                                                                          |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **ನಿರ್ಧಾರಾತ್ಮಕ ಜಾರಿ**         | ನೀತಿ hooks ಶುದ್ಧ ಕಾರ್ಯಗಳನ್ನು ಬಳಸುತ್ತವೆ. LLM ಕರೆಗಳಿಲ್ಲ, ಯಾದೃಚ್ಛಿಕತೆಯಿಲ್ಲ. ಒಂದೇ ಇನ್‌ಪುಟ್ ಯಾವಾಗಲೂ ಒಂದೇ ನಿರ್ಧಾರ.                   |
| **Taint ಪ್ರಸರಣ**              | ಎಲ್ಲ ಡೇಟಾ ವರ್ಗೀಕರಣ ಮೆಟಾಡೇಟಾ ಹೊಂದಿರುತ್ತದೆ. Session taint ಕೇವಲ ಏರಬಹುದು, ಎಂದಿಗೂ ಇಳಿಯಲಾಗದು.                                   |
| **No write-down**             | ಡೇಟಾ ಕಡಿಮೆ ವರ್ಗೀಕರಣ ಮಟ್ಟಕ್ಕೆ ಹರಿಯಲಾಗದು. ಎಂದಿಗೂ ಅಲ್ಲ.                                                                      |
| **ಎಲ್ಲವನ್ನೂ ಆಡಿಟ್ ಮಾಡಿ**      | ಎಲ್ಲ ನೀತಿ ನಿರ್ಧಾರಗಳನ್ನು ಸಂಪೂರ್ಣ ಸಂದರ್ಭದೊಂದಿಗೆ ದಾಖಲಿಸಲಾಗಿದೆ.                                                                 |
| **Hooks ಅಭೇದ್ಯ**              | LLM ನೀತಿ hook ನಿರ್ಧಾರಗಳನ್ನು ಬೈಪಾಸ್ ಮಾಡಲು, ಮಾರ್ಪಡಿಸಲು ಅಥವಾ ಪ್ರಭಾವಿಸಲು ಸಾಧ್ಯವಿಲ್ಲ. Hooks LLM ಪದರದ ಕೆಳಗಿನ ಕೋಡ್‌ನಲ್ಲಿ ಚಲಿಸುತ್ತವೆ. |
| **Session ಪ್ರತ್ಯೇಕತೆ**        | ಪ್ರತಿ session ಸ್ವತಂತ್ರವಾಗಿ taint ಟ್ರ್ಯಾಕ್ ಮಾಡುತ್ತದೆ. ಹಿನ್ನೆಲೆ sessions ತಾಜಾ PUBLIC taint ನೊಂದಿಗೆ ಉತ್ಪಾದಿಸುತ್ತವೆ.            |

## ತಂತ್ರಜ್ಞಾನ ಸ್ಟ್ಯಾಕ್

| ಘಟಕ                  | ತಂತ್ರಜ್ಞಾನ                                                                      |
| -------------------- | ------------------------------------------------------------------------------- |
| Runtime              | Deno 2.x (TypeScript strict mode)                                               |
| Testing              | Deno built-in test runner                                                       |
| Channels             | Baileys (WhatsApp), grammY (Telegram), Bolt (Slack), discord.js (Discord)       |
| Browser automation   | puppeteer-core (CDP)                                                            |
| Voice                | Whisper (local STT), ElevenLabs/OpenAI (TTS)                                    |
| Storage              | SQLite WAL (default), enterprise backends (Postgres, S3)                        |
| Secrets              | OS keychain (personal), vault integration (enterprise)                          |
