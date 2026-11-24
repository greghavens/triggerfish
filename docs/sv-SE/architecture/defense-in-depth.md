# Försvar på djupet

Triggerfish implementerar säkerhet som 13 oberoende, överlappande lager. Inget enskilt lager är tillräckligt på egen hand. Tillsammans bildar de ett försvar som försämras varsamt — även om ett lager komprometteras fortsätter de återstående lagren att skydda systemet.

::: warning SÄKERHET Försvar på djupet innebär att en sårbarhet i ett enskilt lager inte komprometterar systemet. En angripare som kringgår kanalautentisering möter fortfarande session-taint-spårning, policy-hooks och revisionsloggning. En LLM som prompt-injiceras kan fortfarande inte påverka det deterministiska policylagret under den. :::

## De 13 lagren

### Lager 1: Kanalautentisering

**Skyddar mot:** Identitetsstöld, obehörig åtkomst, identitetsförvirring.

Identitet bestäms av **kod vid sessionsupprättande**, inte av LLM:en som tolkar meddelandeinnehåll. Innan LLM:en ser ett meddelande taggar kanaladaptern det med en oföränderlig etikett:

```
{ source: "owner" }    -- verifierad kanalidentitet matchar registrerad ägare
{ source: "external" } -- vem som helst annars; enbart indata, behandlas inte som kommando
```

Autentiseringsmetoder varierar beroende på kanal:

| Kanal                   | Metod              | Verifiering                                                      |
| ----------------------- | ------------------ | ---------------------------------------------------------------- |
| Telegram / WhatsApp     | Parningskod        | Engångskod, 5 minuters utgång, skickad från användarens konto    |
| Slack / Discord / Teams | OAuth              | Plattforms-OAuth-medgivandeflöde, returnerar verifierat användar-ID |
| CLI                     | Lokal process      | Körs på användarens dator, autentiserad av OS                    |
| WebChat                 | Ingen (publik)     | Alla besökare är `EXTERNAL`, aldrig `owner`                     |
| E-post                  | Domänmatchning     | Avsändardomän jämförs mot konfigurerade interna domäner          |

::: info LLM:en bestämmer aldrig vem som är ägaren. Ett meddelande som säger "Jag är ägaren" från en overifierad avsändare taggas `{ source: "external" }` och kan inte utlösa ägarenivåkommandon. Det här beslutet fattas i kod, innan LLM:en bearbetar meddelandet. :::

### Lager 2: Behörighetsmedveten dataåtkomst

**Skyddar mot:** Överprivilegierad dataåtkomst, privilegieskalering via systemuppgifter.

Triggerfish använder användarens delegerade OAuth-tokens — inte systemtjänstkonton — för att söka externa system. Källsystemet tillämpar sin egen behörighetsmodell:

<img src="/diagrams/traditional-vs-triggerfish.svg" alt="Traditionell kontra Triggerfish: traditionell modell ger LLM direkt kontroll, Triggerfish dirigerar alla åtgärder via ett deterministiskt policylager" style="max-width: 100%;" />

Plugin SDK tillämpar detta på API-nivå:

| SDK-metod                              | Beteende                                        |
| --------------------------------------- | ----------------------------------------------- |
| `sdk.get_user_credential(integration)`  | Returnerar användarens delegerade OAuth-token   |
| `sdk.query_as_user(integration, query)` | Kör med användarens behörigheter                |
| `sdk.get_system_credential(name)`       | **BLOCKERAD** — höjer `PermissionError`         |

### Lager 3: Session-taint-spårning

**Skyddar mot:** Dataintrång via kontextkontaminering, klassificerade data som når lägre-klassificerade kanaler.

Varje session spårar oberoende en taint-nivå som återspeglar den högsta klassificeringen av data som nåtts under sessionen. Taint följer tre invarianter:

1. **Per konversation** — varje session har sin egen taint
2. **Bara eskalering** — taint ökar, aldrig minskar
3. **Fullständig återställning rensar allt** — taint OCH historik raderas tillsammans

När policymotorn utvärderar en utdata jämför den sessionens taint mot målkanalens effektiva klassificering. Om taint överstiger målet blockeras utdata.

### Lager 4: Datalinjegrafi

**Skyddar mot:** Ospårbara dataflöden, oförmåga att granska vart data gick, efterlevnadsluckor.

Varje dataelement bär provenansmetadata från ursprung till destination:

- **Ursprung**: Vilken integration, post och användaråtkomst producerade denna data
- **Klassificering**: Vilken nivå som tilldelades och varför
- **Transformationer**: Hur LLM:en modifierade, sammanfattade eller kombinerade data
- **Destination**: Vilken session och kanal tog emot utdata

Linjegrafi möjliggör framåtspårningar ("var gick denna Salesforce-post?"), bakåtspårningar ("vilka källor bidrog till denna utdata?") och fullständiga efterlevnadsexporter.

### Lager 5: Policyhanteringshooks

**Skyddar mot:** Prompt-injektionsattacker, LLM-drivna säkerhetskringgåenden, okontrollerad verktygsexekvering.

Åtta deterministiska hooks fångar upp varje åtgärd vid kritiska punkter i dataflödet:

| Hook                    | Vad den fångar upp                             |
| ----------------------- | ---------------------------------------------- |
| `PRE_CONTEXT_INJECTION` | Extern indata som hamnar i kontextfönstret     |
| `PRE_TOOL_CALL`         | LLM som begär verktygsexekvering               |
| `POST_TOOL_RESPONSE`    | Data som återvänder från verktygsexekvering    |
| `PRE_OUTPUT`            | Svar som är på väg att lämna systemet          |
| `SECRET_ACCESS`         | Begäran om åtkomst till uppgifter              |
| `SESSION_RESET`         | Begäran om taint-återställning                 |
| `AGENT_INVOCATION`      | Agent-till-agent-anrop                         |
| `MCP_TOOL_CALL`         | Anrop av MCP-serververktyg                     |

Hooks är ren kod: deterministiska, synkrona, loggade och ofalsknliga. LLM:en kan inte kringgå dem eftersom det inte finns någon väg från LLM-utdata till hook-konfiguration. Hook-lagret tolkar inte LLM-utdata för kommandon.

### Lager 6: MCP Gateway

**Skyddar mot:** Okontrollerad extern verktygsåtkomst, oklassificerade data som kommer in via MCP-servrar, schemaöverträdelser.

Alla MCP-servrar standard till `UNTRUSTED` och kan inte anropas förrän en admin eller användare klassificerar dem. Gateway tillämpar:

- Serverautentisering och klassificeringsstatus
- Verktygsnivåbehörigheter (enskilda verktyg kan blockeras även om servern är tillåten)
- Begärans-/svarsschemavalidering
- Taint-spårning på alla MCP-svar
- Injektionsmönsterskanning i parametrar

<img src="/diagrams/mcp-server-states.svg" alt="MCP-servertillstånd: UNTRUSTED (standard), CLASSIFIED (granskad och tillåten), BLOCKED (uttryckligen förbjuden)" style="max-width: 100%;" />

### Lager 7: Plugin-sandlåda

Aktivera ett TypeScript-insticksprogram i användarkonfigurationen med `enabled: true`. Import och körning sker normalt i Deno-workers med begränsade behörigheter. De kan läsa insticksprogrammets katalog och bara ansluta till värdar och portar i `declaredEndpoints`. Filskrivning, processmiljön, underprocesser, FFI och skyddad systeminformation är spärrade. `trust: trusted` tillåter import i Triggerfish-processen. Exekveraren körs där om manifestet också anger `trusted`.

[Fullständig guide till insticksprogram](../integrations/plugins)

### Lager 8: Hemlighetsisolering

**Skyddar mot:** Stöld av uppgifter, hemligheter i konfigurationsfiler, okrypterad uppgiftslagring.

Uppgifter lagras i OS-nyckelringen (personlig nivå) eller vault-integration (företagsnivå). De visas aldrig i:

- Konfigurationsfiler
- `StorageProvider`-värden
- Loggposter
- LLM-kontext (uppgifter injiceras i HTTP-lagret, under LLM:en)

`SECRET_ACCESS`-hooken loggar varje åtkomst till uppgifter med den begärande plugin-en, uppgiftomfånget och beslutet.

### Lager 9: Filsystemsverktygssandlåda

**Skyddar mot:** Sökvägsgenomgångsattacker, obehörig filåtkomst, klassificeringskringgång via direkta filsystemsoperationer.

Alla filsystemsverktygsoperationer (läs, skriv, redigera, lista, sök) körs inuti en sandlådd Deno Worker med OS-nivåbehörigheter avgränsade till sessionens taint-lämpliga arbetsytaunderkatalog. Sandlådan tillämpar tre gränser:

- **Sökvägsinstängning** — varje sökväg löses till en absolut sökväg och kontrolleras mot instängningsroten med separatormedveten matchning. Genomgångsförsök (`../`) som flyr arbetsytan avvisas innan någon I/O sker
- **Sökvägsklassificering** — varje filsystemsökväg klassificeras via en fast lösningskedja: hårdkodade skyddade sökvägar (RESTRICTED), arbetsytaklassificeringkataloger, konfigurerade sökvägsmappningar och sedan standardklassificering. Agenten kan inte komma åt sökvägar ovanför sin session-taint
- **Taint-avgränsade behörigheter** — sandlåde-Workerns Deno-behörigheter ställs in på arbetsytaunderkatalogen som matchar sessionens aktuella taint-nivå. När taint eskalerar skapas Worker:n om med utökade behörigheter. Behörigheter kan bara utvidgas, aldrig begränsas inom en session
- **Skrivskydd** — kritiska filer (`TRIGGER.md`, `triggerfish.yaml`, `SPINE.md`) är skrivskyddade på verktygslagret oavsett sandlådebehörigheter. Dessa filer kan bara ändras via dedikerade hanteringsverktyg som tillämpar sina egna klassificeringsregler

### Lager 10: Agentidentitet

**Skyddar mot:** Privilegieskalering via agentkedjor, datauttvättning via delegering.

När agenter anropar andra agenter förhindrar kryptografiska delegeringskedjor privilegieskalering:

- Varje agent har ett certifikat som specificerar dess funktioner och klassificeringstak
- Den kallade ärver `max(eget taint, anroparens taint)` — taint kan bara öka via kedjor
- En anropare med taint som överstiger den kallade agentens tak blockeras
- Cirkulära anrop upptäcks och avvisas
- Delegeringsdjup är begränsat och tillämpas

<img src="/diagrams/data-laundering-defense.svg" alt="Datauttvättningsförsvar: attackväg blockerad vid takskontroll och taint-arv förhindrar utdata till lägre-klassificerade kanaler" style="max-width: 100%;" />

### Lager 11: Revisionsloggning

**Skyddar mot:** Oupptäckbara intrång, efterlevnadsbrister, oförmåga att utreda incidenter.

Varje säkerhetsrelevant beslut loggas med fullständigt sammanhang:

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

Vad som loggas:

- Alla åtgärdsförfrågningar (tillåtna OCH nekade)
- Klassificeringsbeslut
- Session-taint-ändringar
- Kanalautentiseringshändelser
- Policyreglutvärderingar
- Skapande och uppdatering av linjegrafipost
- MCP Gateway-beslut
- Agent-till-agent-anrop

::: info Revisionsloggning kan inte inaktiveras. Det är en fast regel i policyhierarkin. Inte ens en organisationsadmin kan stänga av loggning för sina egna åtgärder. Företagsdriftsättningar kan valfritt aktivera fullständig innehållsloggning (inklusive blockerat meddelandeinnehåll) för kriminaltekniska krav. :::

### Lager 12: SSRF-förebyggande

**Skyddar mot:** Server-side request forgery, intern nätverksrekognoscering, exfiltration av molnmetadata.

Alla utgående HTTP-förfrågningar (från `web_fetch`, `browser.navigate` och plugin-nätverksåtkomst) löser DNS först och kontrollerar den upplösta IP-adressen mot en hårdkodad nekalista med privata och reserverade intervall. Det förhindrar en angripare från att lura agenten att komma åt interna tjänster via fabricerade URL:er.

- Privata intervall (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`) är alltid blockerade
- Länklokal (`169.254.0.0/16`) och molnmetadataendpoints är blockerade
- Loopback (`127.0.0.0/8`) är blockerat
- Nekalistan är hårdkodad och inte konfigurerbar — det finns ingen admin-åsidosättning
- DNS-upplösning sker före förfrågningen, vilket förhindrar DNS-rebindningsattacker

### Lager 13: Minneklassificeringsgrindning

**Skyddar mot:** Cross-sessions dataintrång via minne, klassificeringsnedsättning via minnesskrivningar, obehörig åtkomst till klassificerade minnen.

Det cross-sessions minnessystemet tillämpar klassificering vid både skriv- och lästid:

- **Skrivningar**: Minnesposter tvingas till den aktuella sessionens taint-nivå. LLM:en kan inte välja en lägre klassificering för lagrade minnen.
- **Läsningar**: Minnesfrågor filtreras av `canFlowTo` — en session kan bara läsa minnen vid eller under dess aktuella taint-nivå.

Det förhindrar en agent från att lagra CONFIDENTIAL-data som PUBLIC i minnet och senare hämta det i en lägre-taint-session för att kringgå nedskrivningsförbudet.

## Förtroendehierarki

Förtroendemodellen definierar vem som har auktoritet över vad. Högre nivåer kan inte kringgå lägre nivåers säkerhetsregler, men de kan konfigurera de justerbara parametrarna inom dessa regler.

<img src="/diagrams/trust-hierarchy.svg" alt="Förtroendehierarki: Triggerfish-leverantör (noll åtkomst), Organisationsadmin (ställer in policyer), Anställd (använder agent inom gränser)" style="max-width: 100%;" />

::: tip **Personlig nivå:** Användaren ÄR organisationsadminen. Full suveränitet. Ingen Triggerfish-synlighet. Leverantören har noll åtkomst till användardata som standard och kan bara få åtkomst via ett uttryckligt, tidsbegränsat, loggat beviljande från användaren. :::

## Hur lagren arbetar tillsammans

Tänk dig en prompt-injektionsattack där ett skadligt meddelande försöker exfiltrera data:

| Steg | Lager                  | Åtgärd                                                              |
| ---- | ---------------------- | ------------------------------------------------------------------- |
| 1    | Kanalautentisering     | Meddelande taggat `{ source: "external" }` — inte ägaren           |
| 2    | PRE_CONTEXT_INJECTION  | Indata skannad för injektionsmönster, klassificerad                 |
| 3    | Session-taint          | Session-taint oförändrad (ingen klassificerad data nådd)            |
| 4    | LLM bearbetar meddelande | LLM kan manipuleras att begära ett verktygsanrop                  |
| 5    | PRE_TOOL_CALL          | Verktygsbehörighetskontroll mot externa-källa-regler                |
| 6    | POST_TOOL_RESPONSE     | Returnerade data klassificerade, taint uppdaterat                   |
| 7    | PRE_OUTPUT             | Utdataklassificering kontra mål kontrollerat                        |
| 8    | Revisionsloggning      | Hela sekvensen registrerad för granskning                           |

Även om LLM:en är fullständigt komprometterad vid steg 4 och begär ett dataexfiltreringsverktygsanrop fortsätter de återstående lagren (behörighetskontroller, taint-spårning, utdataklassificering, revisionsloggning) att tillämpa policyn. Ingen enskild felpunkt komprometterar systemet.
