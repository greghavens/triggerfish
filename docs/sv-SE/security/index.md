# Säkerhetscentrerat design

Triggerfish är byggt på en enda premiss: **LLM:en har noll auktoritet**. Den föreslår åtgärder; policylagret beslutar. Varje säkerhetsbeslut fattas av deterministisk kod som AI:n inte kan kringgå, åsidosätta eller påverka.

Den här sidan förklarar varför Triggerfish tar detta tillvägagångssätt, hur det skiljer sig från traditionella AI-agentplattformar och var du hittar detaljer om varje komponent i säkerhetsmodellen.

## Varför säkerhet måste ligga under LLM-lagret

Stora språkmodeller kan prompt-injiceras. En noggrant utformad indata — oavsett om det är från ett skadligt externt meddelande, ett förgiftat dokument eller ett komprometterat verktygssvar — kan få en LLM att ignorera sina instruktioner och utföra åtgärder den tillsagts att inte göra. Det här är inte en teoretisk risk. Det är ett välдокументerat, olöst problem i AI-branschen.

Om din säkerhetsmodell är beroende av att LLM:en följer regler kan en enda lyckad injektion kringgå varje skyddsåtgärd du har byggt.

Triggerfish löser detta genom att flytta all säkerhetshantering till ett kodlager som sitter **under** LLM:en. AI:n ser aldrig säkerhetsbeslut. Den utvärderar aldrig om en åtgärd ska vara tillåten. Den begär helt enkelt åtgärder, och policyhanteringslagret — som körs som ren, deterministisk kod — avgör om dessa åtgärder fortsätter.

<img src="/diagrams/enforcement-layers.svg" alt="Hanteringslager: LLM har noll auktoritet, policylagret fattar alla beslut deterministiskt, bara tillåtna åtgärder når exekvering" style="max-width: 100%;" />

::: warning SÄKERHET LLM-lagret har ingen mekanism för att åsidosätta, hoppa över eller påverka policyhanteringslagret. Det finns ingen "tolka LLM-utdata för kringgångskommandon"-logik. Separationen är arkitektonisk, inte beteendemässig. :::

## Kärnprincipen

Varje designbeslut i Triggerfish flödar från en invariant:

> **Samma indata ger alltid samma säkerhetsbeslut. Ingen slumpmässighet, inga LLM-anrop, inget gottfinnande.**

Det innebär att säkerhetsbeteendet är:

- **Granskningsbart** — du kan återskapa vilket beslut som helst och få samma resultat
- **Testbart** — deterministisk kod kan täckas av automatiserade tester
- **Verifierbart** — policymotorn är öppen källkod (Apache 2.0-licensierad) och vem som helst kan inspektera den

## Säkerhetsprinciper

| Princip                  | Vad det innebär                                                                                                                                                | Detaljsida                                                            |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **Dataklassificering**   | All data bär en känslighetsnivå (RESTRICTED, CONFIDENTIAL, INTERNAL, PUBLIC). Klassificering tilldelas av kod när data går in i systemet.                     | [Arkitektur: Klassificering](/sv-SE/architecture/classification)      |
| **Inget nedskrivningsförbud** | Data kan bara flöda till kanaler och mottagare vid lika eller högre klassificeringsnivå. CONFIDENTIAL-data kan inte nå en PUBLIC-kanal. Inga undantag.   | [Nedskrivningsregeln](./no-write-down)                                |
| **Session-taint**        | När en session kommer åt data vid en klassificeringsnivå taintas hela sessionen till den nivån. Taint kan bara eskalera, aldrig minska.                       | [Arkitektur: Taint](/sv-SE/architecture/taint-and-sessions)           |
| **Deterministiska hooks** | Åtta hanteringshooks körs vid kritiska punkter i varje dataflöde. Varje hook är synkron, loggad och ofalsknlig.                                               | [Arkitektur: Policymotor](/sv-SE/architecture/policy-engine)          |
| **Identitet i kod**      | Användaridentitet bestäms av kod vid sessionsupprättande, inte av LLM:en som tolkar meddelandeinnehåll.                                                       | [Identitet och autentisering](./identity)                             |
| **Agentdelegering**      | Agent-till-agent-anrop styrs av kryptografiska certifikat, klassificeringstak och djupgränser.                                                                | [Agentdelegering](./agent-delegation)                                 |
| **Hemlighetsisolering**  | Uppgifter lagras i OS-nyckelringar eller vaults, aldrig i konfigurationsfiler. Plugins kan inte komma åt systemuppgifter.                                     | [Hemlighethantering](./secrets)                                       |
| **Granska allt**         | Varje policybeslut loggas med fullständigt sammanhang: tidsstämpel, hooktyp, sessions-ID, indata, resultat och utvärderade regler.                             | [Revision och efterlevnad](./audit-logging)                           |

## Traditionella AI-agenter kontra Triggerfish

De flesta AI-agentplattformar förlitar sig på LLM:en för att tillämpa säkerhet. Systempromten säger "dela inte känslig data", och agenten litas på att följa det. Den här metoden har grundläggande svagheter.

| Aspekt                        | Traditionell AI-agent                    | Triggerfish                                                              |
| ----------------------------- | ---------------------------------------- | ------------------------------------------------------------------------ |
| **Säkerhetshantering**        | Systempromtinstruktioner till LLM:en     | Deterministisk kod under LLM:en                                          |
| **Prompt-injektionsförsvar**  | Hoppas att LLM:en motstår               | LLM:en har ingen auktoritet från början                                  |
| **Dataflödeskontroll**        | LLM:en avgör vad som är säkert att dela | Klassificeringsetiketter + nedskrivningsregel i kod                      |
| **Identitetsverifiering**     | LLM:en tolkar "Jag är adminen"          | Kod kontrollerar kryptografisk kanalidentitet                            |
| **Revisionsspår**             | LLM-konversationsloggar                 | Strukturerade policybesluts-loggar med fullständigt sammanhang           |
| **Åtkomst till uppgifter**    | Systemtjänstkonto för alla användare    | Delegerade användaruppgifter; källsystembehörigheter ärvs               |
| **Testbarhet**                | Suddig — beror på promtformulering      | Deterministisk — samma indata, samma beslut, varje gång                 |
| **Öppen för verifiering**     | Vanligtvis proprietär                   | Apache 2.0-licensierad, fullt granskningsbar                             |

::: tip Triggerfish hävdar inte att LLM:er är opålitliga. Det hävdar att LLM:er är fel lager för säkerhetshantering. En välpromptad LLM följer sina instruktioner större delen av tiden. Men "större delen av tiden" är inte en säkerhetsgaranti. Triggerfish ger en garanti: policylagret är kod, och kod gör vad den tillsägs, varje gång. :::

## Försvar på djupet

Triggerfish implementerar tretton försvarsslager. Inget enskilt lager är tillräckligt på egen hand; tillsammans bildar de en säkerhetsgräns:

1. **Kanalautentisering** — kodverifierad identitet vid sessionsupprättande
2. **Behörighetsmedveten dataåtkomst** — källsystembehörigheter, inte systemuppgifter
3. **Session-taint-spårning** — automatisk, obligatorisk, bara eskalering
4. **Datalinjegrafi** — fullständig provenanskedja för varje dataelement
5. **Policyhanteringshooks** — deterministiska, icke-kringgångsbara, loggade
6. **MCP Gateway** — säker extern verktygsåtkomst med per-verktygsbehörigheter
7. **[Plugin-sandlåda](../integrations/plugins)**
8. **Hemlighetsisolering** — OS-nyckelring eller vault, aldrig konfigurationsfiler
9. **Filsystemsverktygssandlåda** — sökvägsinstängning, sökvägsklassificering, taint-avgränsade OS-nivå I/O-behörigheter
10. **Agentidentitet** — kryptografiska delegeringskedjor
11. **Revisionsloggning** — alla beslut registrerade, inga undantag
12. **SSRF-förebyggande** — IP-nekalista + DNS-upplösningskontroller på all utgående HTTP
13. **Minneklassificeringsgrindning** — skrivningar tvingade till session-taint, läsningar filtrerade av `canFlowTo`

## Nästa steg

| Sida                                                                | Beskrivning                                                                                   |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| [Klassificeringsguide](/sv-SE/guide/classification-guide)           | Praktisk guide för att välja rätt nivå för kanaler, MCP-servrar och integrationer            |
| [Nedskrivningsregeln](./no-write-down)                              | Den grundläggande dataflödesregeln och hur den tillämpas                                      |
| [Identitet och autentisering](./identity)                           | Kanalautentisering och ägaridentitetsverifiering                                              |
| [Agentdelegering](./agent-delegation)                               | Agent-till-agent-identitet, certifikat och delegeringskedjor                                  |
| [Hemlighethantering](./secrets)                                     | Hur Triggerfish hanterar uppgifter på olika nivåer                                            |
| [Revision och efterlevnad](./audit-logging)                         | Revisionsspårstruktur, spårning och efterlevnadsexporter                                      |
