---
title: AI Agents ನಿಮ್ಮ Private Data Exfiltrate ಮಾಡುತ್ತಿವೆ. ಅವರನ್ನು ತಡೆಯುತ್ತಿರುವವರು ಯಾರು?
date: 2026-03-10
description: ಹೆಚ್ಚಿನ AI agent platforms model ಗೆ ಏನು ಮಾಡಬೇಡ ಎಂದು ಹೇಳುವ ಮೂಲಕ
  security enforce ಮಾಡುತ್ತವೆ. Model ಅನ್ನು ಅದರಿಂದ ಮಾತನಾಡಿ ಹೊರಗೆ ತರಬಹುದು. ಪರ್ಯಾಯ
  ಹೇಗೆ ಕಾಣುತ್ತದೆ ಎಂಬುದು ಇಲ್ಲಿದೆ.
author: Greg Havens
tags:
  - ai
  - ai agents
  - security
  - open source
  - self-hosted
  - prompt injection
  - data exfiltration
  - agent security
  - openclaw
  - triggerfish
draft: false
---
![](/blog/images/gemini_generated_image_i7ytlui7ytlui7yt.jpg)

AI agents ಉಪಯುಕ್ತವಾಗಿರುವ ಕಾರಣ ಅವು ಕ್ರಿಯೆ ತೆಗೆದುಕೊಳ್ಳಬಲ್ಲವು. ಅದೇ ಅವುಗಳ ಸಂಪೂರ್ಣ ಉದ್ದೇಶ. ಒಂದು agent ಗೆ ನಿಮ್ಮ tools ಗೆ access ನೀಡಿದರೆ, ಅದು ಕೆಲಸ ಮಾಡಬಹುದು: message ಕಳುಹಿಸು, record update ಮಾಡು, file search ಮಾಡು, query ಚಲಾಯಿಸು, commit push ಮಾಡು. Demos impressive. Security model ಅನ್ನು ನಿಕಟವಾಗಿ ನೋಡಿದರೆ actual deployments ಬೇರೆ ಕಥೆ.

ಈಗ ಯಾರೂ ಸಾಕಷ್ಟು ಜೋರಾಗಿ ಕೇಳದ ಪ್ರಶ್ನೆ ಸರಳ. AI agent ಗೆ ನಿಮ್ಮ database, email, calendar, Salesforce instance, GitHub repositories ಗೆ write access ಇದ್ದಾಗ, ಅದು ಮಾಡಬಾರದ ಏನನ್ನಾದರೂ ಮಾಡುವುದನ್ನು ತಡೆಯುತ್ತಿರುವುದು ಏನು? ಹೆಚ್ಚಿನ ಸಂದರ್ಭಗಳಲ್ಲಿ ಪ್ರಾಮಾಣಿಕ ಉತ್ತರ system prompt ನಲ್ಲಿರುವ ಒಂದು ವಾಕ್ಯ.

ನಾವು ಈ ಸ್ಥಿತಿಯಲ್ಲಿದ್ದೇವೆ.

## Model ಗೆ ವರ್ತಿಸಲು ಹೇಳುವ ಸಮಸ್ಯೆ

ಇಂದು AI agent deploy ಮಾಡಿದಾಗ, standard security practice ಎಂದರೆ system prompt ನಲ್ಲಿ instructions ಬರೆಯುವುದು. Model ಗೆ ಏನು ಮಾಡಲು ಅನುಮತಿ ಇಲ್ಲ ಎಂದು ಹೇಳಿ. ಯಾವ tools off-limits ಎಂದು ಹೇಳಿ. Destructive actions ತೆಗೆದುಕೊಳ್ಳುವ ಮೊದಲು ಕೇಳಲು ಹೇಳಿ. ಕೆಲವು platforms ಇವುಗಳನ್ನು manually ಬರೆಯುವ ಬದಲು UI ಮೂಲಕ configure ಮಾಡಲು ಅನುವು ಮಾಡುತ್ತವೆ, ಆದರೆ underlying mechanism ಅದೇ. ನೀವು model ಗೆ rulebook ನೀಡಿ ಅದು ಅನುಸರಿಸುತ್ತದೆ ಎಂದು ಭರವಸೆ ಇಡುತ್ತೀರಿ.

![](/blog/images/gemini_generated_image_jmypkqjmypkqjmyp.jpg)

ಈ approach ಗೆ ಮೂಲಭೂತ ದೋಷ ಇದೆ. Language models rules execute ಮಾಡುವುದಿಲ್ಲ. ಅವು tokens predict ಮಾಡುತ್ತವೆ. ಈ ವ್ಯತ್ಯಾಸ ಮುಖ್ಯ ಏಕೆಂದರೆ ಸಾಕಷ್ಟು ಚೆನ್ನಾಗಿ crafted prompt model predict ಮಾಡುವದನ್ನು, ಆದ್ದರಿಂದ ಅದು ಏನು ಮಾಡುತ್ತದೆ ಎಂಬುದನ್ನು shift ಮಾಡಬಹುದು. ಇದೇ prompt injection. ಇದು ಯಾವ particular model ನಲ್ಲೂ bug ಅಲ್ಲ. ಇವೆಲ್ಲ systems ಹೇಗೆ ಕಾರ್ಯ ನಿರ್ವಹಿಸುತ್ತವೆ ಎಂಬ property. Attacker ಒಬ್ಬ model ನ context ಗೆ ತಮ್ಮ text ಸೇರಿಸಲು ಸಾಧ್ಯವಾದರೆ, ಅವರ instructions ನಿಮ್ಮ instructions ನ ಜೊತೆ compete ಮಾಡುತ್ತವೆ. Trusted system prompt ನಿಂದ instructions ಬಂದವೋ ಅಥವಾ summarize ಮಾಡಲು ಕೇಳಿದ malicious document ನಿಂದ ಬಂದವೋ ಎಂಬುದನ್ನು identify ಮಾಡಲು model ಗೆ mechanism ಇಲ್ಲ. ಅದು ಕೇವಲ tokens ನೋಡುತ್ತದೆ.

OpenClaw project, ಸರಿಸುಮಾರು 300,000 GitHub stars ಗಳಿಸಿದ ಮತ್ತು ಈಗ ಅತ್ಯಂತ widely deployed open-source personal agent ಆಗಿ ಸಾಧ್ಯವಾಗಿರುವ, ಈ ಸಮಸ್ಯೆಯನ್ನು ಸ್ಪಷ್ಟವಾಗಿ ತೋರಿಸಿದೆ. Cisco ನ security team third-party skill ಮೂಲಕ data exfiltration demonstrate ಮಾಡಿತು. Project ನ ಸ್ವಂತ maintainer publicly ಆ software "non-technical users ಗೆ ತುಂಬ ಅಪಾಯಕಾರಿ" ಎಂದು ಹೇಳಿದ. ಇದು fringe concern ಅಲ್ಲ. ಇದು ಅಸ್ತಿತ್ವದಲ್ಲಿರುವ ಅತ್ಯಂತ popular agent platform ನ acknowledged state.

ಮತ್ತು OpenClaw ಇದರಲ್ಲಿ special ಅಲ್ಲ. ಇದೇ architecture, minor variations ಜೊತೆ, market ನಲ್ಲಿರುವ ಹೆಚ್ಚಿನ agent platforms ಎಲ್ಲದರಲ್ಲೂ ಕಾಣಿಸುತ್ತದೆ. ಅವು ಎಷ್ಟು sophisticated ಆದ system prompts ಹೊಂದಿವೆ ಎಂಬುದರಲ್ಲಿ ಭಿನ್ನ. ಎಷ್ಟು guardrail instructions ಒಳಗೊಂಡಿವೆ ಎಂಬುದರಲ್ಲಿ ಭಿನ್ನ. ಅವೆಲ್ಲ instructions ಅವು ರಕ್ಷಿಸಬೇಕಾದ ಸಂಗತಿಯ ಒಳಗೆ ಇವೆ ಎಂಬುದು ಸಾಮಾನ್ಯ.

## "Model ನ ಹೊರಗೆ" ಎಂಬುದರ ನಿಜ ಅರ್ಥ

Architectural alternative enforcement ಅನ್ನು model ನ context ನಿಂದ ಸಂಪೂರ್ಣ ಹೊರಗೆ ತೆಗೆಯುವುದು. Model ಗೆ ಏನು ಮಾಡಲು ಅನುಮತಿ ಇಲ್ಲ ಎಂದು ಹೇಳಿ ಅದು ಕೇಳುತ್ತದೆ ಎಂದು ಭರವಸೆ ಇಡುವ ಬದಲು, model ಮತ್ತು ಅದು ತೆಗೆದುಕೊಳ್ಳಬಹುದಾದ ಪ್ರತಿ action ನಡುವೆ ಒಂದು gate ಇಡುತ್ತೀರಿ. Model request produce ಮಾಡುತ್ತದೆ. Gate ಆ request ಅನ್ನು rules ಗಳ ವಿರುದ್ಧ evaluate ಮಾಡಿ execute ಆಗುತ್ತದೆಯೇ ಎಂದು decide ಮಾಡುತ್ತದೆ. Action ಅನುಮತಿಸಬೇಕು ಎಂಬ model ನ ಅಭಿಪ್ರಾಯ ಆ evaluation ನ ಭಾಗ ಅಲ್ಲ.

ಜೋರಾಗಿ ಹೇಳಿದರೆ ಇದು obvious ಎಂದು ತೋರುತ್ತದೆ. Security-sensitive software systems ಎಲ್ಲ ಹೀಗೆ ಕಾರ್ಯ ನಿರ್ವಹಿಸುತ್ತವೆ. ಬ್ಯಾಂಕ್ ಅನ್ನು "accounts ಇಲ್ಲದ ಜನರಿಗೆ ಹಣ ನೀಡಬೇಡ" ಎಂದು teller ಗೆ ಹೇಳುವ ಮೂಲಕ secure ಮಾಡುವುದಿಲ್ಲ. Teller ಏನು ಹೇಳಲಾಗಿದ್ದರೂ unauthorized withdrawals impossible ಮಾಡುವ technical controls ಹಾಕುತ್ತೀರಿ. Teller ನ behavior social engineering attack ಮೂಲಕ influence ಮಾಡಬಹುದು. Controls ಅಲ್ಲ, ಏಕೆಂದರೆ ಅವು conversation ಮಾಡಲ್ಲ.

Triggerfish ನಲ್ಲಿ, enforcement layer ಪ್ರತಿ meaningful operation ಮೊದಲು ಮತ್ತು ನಂತರ run ಮಾಡುವ hooks ನ set ಮೂಲಕ ಕಾರ್ಯ ನಿರ್ವಹಿಸುತ್ತದೆ. Tool call execute ಮಾಡುವ ಮೊದಲು, hook ಆ call ಪ್ರಸ್ತುತ session state ನಲ್ಲಿ permitted ಆಗಿದೆಯೇ ಎಂದು check ಮಾಡುತ್ತದೆ. Output channel ಗೆ ತಲುಪುವ ಮೊದಲು, hook ಹೊರ ಹರಿಯುವ data ಆ channel ಗೆ appropriate classification level ನಲ್ಲಿ ಇದೆಯೇ ಎಂದು check ಮಾಡುತ್ತದೆ. External data context ಗೆ ಪ್ರವೇಶಿಸುವ ಮೊದಲು, hook ಅದನ್ನು classify ಮಾಡಿ session ನ taint level update ಮಾಡುತ್ತದೆ. ಈ checks code ನಲ್ಲಿ ಇವೆ. ಅವು conversation ಓದುವುದಿಲ್ಲ. ಅವರನ್ನು ಯಾವುದರಿಂದಲೂ convince ಮಾಡಲಾಗುವುದಿಲ್ಲ.

## Session taint ಮತ್ತು ಅದು ಏಕೆ ಮುಖ್ಯ

Data classification security ನಲ್ಲಿ ಚೆನ್ನಾಗಿ ಅರ್ಥ ಮಾಡಿಕೊಂಡ concept. Classification handle ಮಾಡುತ್ತೇವೆ ಎಂದು claim ಮಾಡುವ ಹೆಚ್ಚಿನ platforms resource ಗೆ classification assign ಮಾಡಿ requesting entity ಗೆ access ಮಾಡಲು permission ಇದೆಯೇ ಎಂದು check ಮಾಡುತ್ತವೆ. ಇದು ಹೋಗುವಷ್ಟು ಮಟ್ಟಿಗೆ useful. ಅದು miss ಮಾಡುವುದು ಏನೆಂದರೆ access ನಂತರ ಏನಾಗುತ್ತದೆ ಎಂಬುದು.

AI agent confidential document access ಮಾಡಿದಾಗ, ಆ confidential data ಈಗ ಅದರ context ನಲ್ಲಿ ಇದೆ. ಅದು session ನ ಉಳಿದ ಭಾಗ ಮುಳುಗಿ ಅದರ outputs ಮತ್ತು reasoning influence ಮಾಡಬಹುದು. Agent ಬೇರೆ task ಗೆ move on ಮಾಡಿದ್ದರೂ, confidential context ಇನ್ನೂ ಇದೆ. Agent ನಂತರ lower-classified channel ನಲ್ಲಿ action ತೆಗೆದುಕೊಂಡರೆ — public Slack channel ಗೆ ಬರೆಯುವುದು, external address ಗೆ email ಕಳುಹಿಸುವುದು, webhook ಗೆ post ಮಾಡುವುದು — ಆ confidential data ಜೊತೆ carry ಮಾಡಬಹುದು. ಇದು data leakage, ಮತ್ತು original resource ಮೇಲಿನ access controls ಅದನ್ನು ತಡೆಯಲಿಲ್ಲ.

![](/blog/images/robot-entry.jpg)

Taint tracking ಈ gap close ಮಾಡುವ mechanism. Triggerfish ನಲ್ಲಿ, ಪ್ರತಿ session PUBLIC ನಲ್ಲಿ ಪ್ರಾರಂಭ ಆಗುವ taint level ಹೊಂದಿದೆ. Agent higher classification level ನಲ್ಲಿ data touch ಮಾಡಿದ ಕ್ಷಣ, session ಆ level ಗೆ tainted ಆಗುತ್ತದೆ. Taint ಕೇವಲ ಮೇಲೆ ಹೋಗುತ್ತದೆ. Session ಒಳಗೆ ಎಂದಿಗೂ ಕೆಳಗೆ ಹೋಗುವುದಿಲ್ಲ. ಆದ್ದರಿಂದ CONFIDENTIAL document access ಮಾಡಿ ನಂತರ PUBLIC channel ಗೆ message ಕಳುಹಿಸಲು try ಮಾಡಿದರೆ, write-down check tainted session level ವಿರುದ್ಧ fire ಮಾಡುತ್ತದೆ. Model ಏನು ಹೇಳಿದ ಎಂಬ ಕಾರಣಕ್ಕಲ್ಲ — system ಯಾವ data in play ಇದೆ ಎಂಬುದು ತಿಳಿದಿರುವ ಕಾರಣ action block ಆಗುತ್ತದೆ.

ಈ mechanism ಬಗ್ಗೆ model ಗೆ ಯಾವ knowledge ಇಲ್ಲ. ಅದನ್ನು reference ಮಾಡಲು, reason about ಮಾಡಲು, ಅಥವಾ manipulate ಮಾಡಲು attempt ಮಾಡಲು ಸಾಧ್ಯವಿಲ್ಲ. Taint level ಎಂಬುದು enforcement layer ನಲ್ಲಿ ವಾಸಿಸುವ session ಬಗ್ಗೆ ಒಂದು fact, context ನಲ್ಲ.

## Third-party tools ಒಂದು attack surface

Modern AI agents ಅನ್ನು genuinely useful ಮಾಡುವ features ಗಳಲ್ಲಿ ಒಂದು ಅವುಗಳ extensibility. Tools add ಮಾಡಬಹುದು. Plugins install ಮಾಡಬಹುದು. Model Context Protocol ಮೂಲಕ agent ಅನ್ನು external services ಗೆ connect ಮಾಡಬಹುದು. ಪ್ರತಿ integration add ಮಾಡಿದರೆ agent ಮಾಡಬಹುದಾದದ್ದನ್ನು ವಿಸ್ತರಿಸುತ್ತದೆ. ಪ್ರತಿ integration add ಮಾಡಿದರೆ attack surface ಕೂಡ ವಿಸ್ತರಿಸುತ್ತದೆ.

ಇಲ್ಲಿ threat model hypothetical ಅಲ್ಲ. Agent ಗೆ third-party skills install ಮಾಡಲು ಸಾಧ್ಯವಾದರೆ, ಮತ್ತು ಆ skills unknown parties ಮೂಲಕ distribute ಮಾಡಲಾಗಿದ್ದರೆ, ಮತ್ತು agent ನ security model ಸಂಪೂರ್ಣವಾಗಿ model ಅದರ context ನಲ್ಲಿ instructions respect ಮಾಡುತ್ತದೆ ಎಂಬ ಮೇಲೆ depend ಮಾಡುತ್ತದ್ದರೆ, malicious skill install ಮಾಡಿಸಿಕೊಳ್ಳುವ ಮೂಲಕ ಸರಳವಾಗಿ data exfiltrate ಮಾಡಬಹುದು. Skill trust boundary ಒಳಗೆ ಇದೆ. Legitimate skill ಮತ್ತು malicious skill ಎರಡೂ context ನಲ್ಲಿ ಇದ್ದರೆ model ಅವರ ನಡುವೆ ವ್ಯತ್ಯಾಸ ಮಾಡಲಾಗುವುದಿಲ್ಲ.

Triggerfish ನಲ್ಲಿ, MCP Gateway ಎಲ್ಲ external tool connections handle ಮಾಡುತ್ತದೆ. ಪ್ರತಿ MCP server invoke ಆಗುವ ಮೊದಲು classified ಮಾಡಬೇಕು. UNTRUSTED servers default ಆಗಿ block ಮಾಡಲಾಗುತ್ತದೆ. External server ನಿಂದ tool response ಬಂದಾಗ, ಆ response POST_TOOL_RESPONSE hook ಮೂಲಕ ಹೋಗುತ್ತದೆ, ಇದು response classify ಮಾಡಿ session taint update ಮಾಡುತ್ತದೆ. ಬಳಕೆದಾರ ಸಂರಚನೆಯಲ್ಲಿ `enabled: true` ಬಳಸಿ TypeScript ಪ್ಲಗಿನ್ ಸಕ್ರಿಯಗೊಳಿಸಿ. ಪೂರ್ವನಿಯೋಜಿತವಾಗಿ ಆಮದು ಮತ್ತು ಕಾರ್ಯಗತಗೊಳಿಸುವಿಕೆ ನಿರ್ಬಂಧಿತ Deno Worker‌ಗಳಲ್ಲಿ ನಡೆಯುತ್ತವೆ. Worker ಪ್ಲಗಿನ್ ಡೈರೆಕ್ಟರಿಯನ್ನು ಓದಬಹುದು ಮತ್ತು `declaredEndpoints` ನಲ್ಲಿರುವ ಹೋಸ್ಟ್ ಮತ್ತು ಪೋರ್ಟ್‌ಗಳಿಗೆ ಮಾತ್ರ ಸಂಪರ್ಕಿಸಬಹುದು. ಫೈಲ್ ಬರೆಯುವುದು, ಪ್ರಕ್ರಿಯೆಯ ಪರಿಸರ ಓದುವುದು, ಉಪಪ್ರಕ್ರಿಯೆಗಳು, FFI ಮತ್ತು ನಿರ್ಬಂಧಿತ ಸಿಸ್ಟಮ್ ಮಾಹಿತಿ ನಿಷೇಧಿತ. `trust: trusted` ಸಂರಚನೆ Triggerfish ಪ್ರಕ್ರಿಯೆಯಲ್ಲಿ ಆಮದನ್ನು ಅನುಮತಿಸುತ್ತದೆ. ಮ್ಯಾನಿಫೆಸ್ಟ್ ಸಹ `trusted` ಎಂದರೆ ಕಾರ್ಯಗತಗೊಳಿಸುವಿಕೆಯೂ ಅಲ್ಲಿಯೇ ನಡೆಯುತ್ತದೆ. [ಪೂರ್ಣ ಪ್ಲಗಿನ್ ಮಾರ್ಗದರ್ಶಿ](/kn-IN/integrations/plugins).

ಇದರ ಉದ್ದೇಶ ಏನೆಂದರೆ system ನ security properties plugins trustworthy ಆಗಿವೆ ಎಂಬ ಮೇಲೆ depend ಮಾಡುವುದಿಲ್ಲ. ಅವು sandbox ಮತ್ತು enforcement layer ಮೇಲೆ depend ಮಾಡುತ್ತವೆ, ಇದು plugins ಒಳಗೊಂಡಿರುವದರಿಂದ influence ಆಗುವುದಿಲ್ಲ.

## Audit ಸಮಸ್ಯೆ

ಇಂದು AI agent deployment ಜೊತೆ ಏನಾದರೂ ತಪ್ಪಾದರೆ ಹೇಗೆ ತಿಳಿಯುತ್ತೀರಿ? ಹೆಚ್ಚಿನ platforms conversation log ಮಾಡುತ್ತವೆ. ಕೆಲವು tool calls log ಮಾಡುತ್ತವೆ. Session ಸಮಯದಲ್ಲಿ ಮಾಡಿದ security decisions ಅನ್ನು ಯಾವ data ಎಲ್ಲಿ ಹರಿಯಿತು, ಯಾವ classification level ನಲ್ಲಿ, ಮತ್ತು ಯಾವ policy ಉಲ್ಲಂಘನೆ ಆಯಿತೇ ಎಂದು reconstruct ಮಾಡಲು ಸಾಧ್ಯವಾಗುವ ರೀತಿಯಲ್ಲಿ log ಮಾಡುವ ಕೆಲವೇ ಕೆಲವು ಇವೆ.

ಇದು ತೋರುವುದಕ್ಕಿಂತ ಹೆಚ್ಚು ಮಹತ್ವದ್ದು, ಏಕೆಂದರೆ AI agent secure ಆಗಿದೆಯೇ ಎಂಬ ಪ್ರಶ್ನೆ ಕೇವಲ real time ನಲ್ಲಿ attacks ತಡೆಯುವುದರ ಬಗ್ಗೆ ಅಲ್ಲ. Agent defined boundaries ಒಳಗೆ behave ಮಾಡಿದ್ದಾನೆ ಎಂಬುದನ್ನು after the fact demonstrate ಮಾಡಲು ಸಾಧ್ಯವಾಗುವ ಬಗ್ಗೆ ಕೂಡ. Sensitive data handle ಮಾಡುವ ಯಾವ organization ಗೆ, ಆ audit trail optional ಅಲ್ಲ. Compliance prove ಮಾಡಲು, incidents respond ಮಾಡಲು, ಮತ್ತು ನಿಮ್ಮ data handle ಮಾಡಲಾಗುತ್ತಿರುವ ಜನರ ವಿಶ್ವಾಸ build ಮಾಡಲು ಅದು ಹೇಗೆ.

![](/blog/images/glass.jpg)

Triggerfish ಪ್ರತಿ operation ಮೇಲೆ full data lineage ಕಾಯ್ದುಕೊಳ್ಳುತ್ತದೆ. System ಗೆ ಪ್ರವೇಶಿಸುವ ಪ್ರತಿ piece of data provenance metadata ಒಯ್ಯುತ್ತದೆ: ಅದು ಎಲ್ಲಿಂದ ಬಂತು, ಯಾವ classification assign ಮಾಡಲಾಗಿತ್ತು, ಅದು ಯಾವ transformations ಮೂಲಕ ಹಾದು ಹೋಯಿತು, ಯಾವ session ಗೆ bound ಮಾಡಲಾಗಿತ್ತು. ಯಾವ output ನ್ನು ಅದನ್ನು produce ಮಾಡಿದ operations ನ chain ಮೂಲಕ ಹಿಂದಕ್ಕೆ trace ಮಾಡಬಹುದು. ಯಾವ sources ಒಂದು given response ಗೆ contribute ಮಾಡಿದವು ಎಂದು ಕೇಳಬಹುದು. Regulatory review ಗಾಗಿ complete chain of custody export ಮಾಡಬಹುದು. ಇದು traditional sense ನಲ್ಲಿ logging system ಅಲ್ಲ. ಇದು ಸಂಪೂರ್ಣ data flow ಉದ್ದಕ್ಕೂ first-class concern ಆಗಿ ಕಾಯ್ದುಕೊಳ್ಳಲಾಗುವ provenance system.

## ನಿಜ ಪ್ರಶ್ನೆ

AI agent category ವೇಗವಾಗಿ ಬೆಳೆಯುತ್ತಿದೆ. Platforms ಹೆಚ್ಚು capable ಆಗುತ್ತಿವೆ. Use cases ಹೆಚ್ಚು consequential ಆಗುತ್ತಿವೆ. Production databases, customer records, financial systems, ಮತ್ತು internal communication platforms ಗೆ write access ಇರುವ agents deploy ಮಾಡಲಾಗುತ್ತಿದೆ. ಈ deployments ಗಳ ಆಧಾರಭೂತ assumption ಎಂದರೆ ಚೆನ್ನಾಗಿ ಬರೆದ system prompt ಸಾಕಷ್ಟು security ಆಗಿದೆ.

ಅಲ್ಲ. System prompt text. Text ಅನ್ನು ಇತರ text ಮೂಲಕ override ಮಾಡಬಹುದು. Agent ನ security model ಎಂದರೆ model ನಿಮ್ಮ instructions ಅನುಸರಿಸುತ್ತದೆ ಎಂಬ ಭರವಸೆ ಇದ್ದರೆ, ನೀವು control ಮಾಡದ inputs ನಿಂದ influence ಆಗಬಹುದಾದ probabilistic behavior ಹೊಂದಿದ system ನಿಂದ behavioral compliance ಮೇಲೆ rely ಮಾಡುತ್ತಿದ್ದೀರಿ.

ಪ್ರತಿ agent platform ಬಗ್ಗೆ ಕೇಳಲು ಯೋಗ್ಯ ಪ್ರಶ್ನೆ enforcement ನಿಜವಾಗಿ ಎಲ್ಲಿ ಇದೆ ಎಂಬುದು. ಉತ್ತರ model ನ instructions ನಲ್ಲಿ ಇದ್ದರೆ, ಅದು agent touch ಮಾಡಬಹುದಾದ data ನ sensitivity ಮತ್ತು ಅದನ್ನು manipulate ಮಾಡಲು try ಮಾಡಬಹುದಾದ ಜನರ sophistication ಜೊತೆ ಸ್ಕೇಲ್ ಆಗುವ meaningful risk. ಉತ್ತರ model ನಿಂದ independently run ಆಗಿ ಯಾವ prompt ಮೂಲಕ reach ಮಾಡಲಾಗದ layer ನಲ್ಲಿ ಇದ್ದರೆ, ಅದು ಬೇರೆ situation.

ನಿಮ್ಮ systems ನಲ್ಲಿರುವ data real. Agent ಅದನ್ನು exfiltrate ಮಾಡದಂತೆ ತಡೆಯುತ್ತಿರುವವರು ಯಾರು ಎಂಬ ಪ್ರಶ್ನೆ real ಉತ್ತರಕ್ಕೆ ಅರ್ಹ.
