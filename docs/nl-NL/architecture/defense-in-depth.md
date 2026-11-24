# Verdediging in diepte

Triggerfish implementeert beveiliging als 13 onafhankelijke, overlappende lagen. Geen enkele laag is op zichzelf voldoende. Samen vormen ze een verdediging die graceful degradeert — zelfs als een laag is gecompromitteerd, blijven de overige lagen het systeem beschermen.

::: warning BEVEILIGING Verdediging in diepte betekent dat een kwetsbaarheid in een enkele laag het systeem niet compromitteert. Een aanvaller die kanaalverificatie omzeilt, staat nog steeds voor sessie-taint-tracking, beleidshooks en auditregistratie. Een LLM dat prompt-geïnjecteerd is, kan nog steeds de deterministische beleidslaag eronder niet beïnvloeden. :::

## De 13 lagen

### Laag 1: Kanaalverificatie

**Beschermt tegen:** Imitatie, ongeautoriseerde toegang, identiteitsverwarring.

Identiteit wordt bepaald door **code bij sessiegebouw**, niet door het LLM dat berichtinhoud interpreteert. Voordat het LLM een bericht ziet, labelt de kanaaladapter het met een onveranderlijk label:

```
{ source: "owner" }    -- geverifieerde kanaalidentiteit komt overeen met geregistreerde eigenaar
{ source: "external" } -- iemand anders; alleen invoer, niet behandeld als opdracht
```

Verificatiemethoden variëren per kanaal:

| Kanaal                  | Methode           | Verificatie                                                      |
| ----------------------- | ----------------- | ---------------------------------------------------------------- |
| Telegram / WhatsApp     | Koppelcode        | Eenmalige code, 5 minuten geldig, verzonden vanuit account gebruiker |
| Slack / Discord / Teams | OAuth             | Platform-OAuth-toestemmingsstroom, retourneert geverifieerd gebruikers-ID |
| CLI                     | Lokaal proces     | Draait op de machine van de gebruiker, geverifieerd door OS      |
| WebChat                 | Geen (openbaar)   | Alle bezoekers zijn `EXTERNAL`, nooit `owner`                    |
| E-mail                  | Domeinmatching    | Afzenderdomein vergeleken met geconfigureerde interne domeinen   |

::: info Het LLM besluit nooit wie de eigenaar is. Een bericht dat zegt "ik ben de eigenaar" van een niet-geverifieerde afzender wordt getagd als `{ source: "external" }` en kan geen opdrachten op eigenaarsniveau activeren. Deze beslissing wordt genomen in code, voordat het LLM het bericht verwerkt. :::

### Laag 2: Machtigingsbewuste gegevenstoegang

**Beschermt tegen:** Te gemachtigde gegevenstoegang, privileges escaleren via systeeminloggegevens.

Triggerfish gebruikt de gedelegeerde OAuth-tokens van de gebruiker — geen systeem-service-accounts — om externe systemen te bevragen. Het bronsysteem handhaaft zijn eigen machtigingsmodel:

<img src="/diagrams/traditional-vs-triggerfish.svg" alt="Traditioneel vs Triggerfish: traditioneel model geeft LLM directe controle, Triggerfish routeert alle acties via een deterministische beleidslaag" style="max-width: 100%;" />

De Plugin SDK handhaaft dit op API-niveau:

| SDK-methode                             | Gedrag                                          |
| --------------------------------------- | ----------------------------------------------- |
| `sdk.get_user_credential(integration)`  | Retourneert gedelegeerde OAuth-token van gebruiker |
| `sdk.query_as_user(integration, query)` | Voert uit met machtigingen van gebruiker         |
| `sdk.get_system_credential(name)`       | **GEBLOKKEERD** — gooit `PermissionError`        |

### Laag 3: Sessie-taint-tracking

**Beschermt tegen:** Gegevenslekken via contextcontaminatie, geclassificeerde gegevens die lagere classificatiekanalen bereiken.

Elke sessie volgt onafhankelijk een taint-niveau dat de hoogste classificatie van gegevens weerspiegelt die tijdens de sessie zijn geraadpleegd. Taint volgt drie invarianten:

1. **Per gesprek** — elke sessie heeft zijn eigen taint
2. **Alleen escalatie** — taint neemt toe, nooit af
3. **Volledige reset wist alles** — taint EN geschiedenis worden samen gewist

Wanneer de beleidsengine een uitvoer evalueert, vergelijkt het de taint van de sessie met de effectieve classificatie van het doelkanaal. Als de taint het doel overschrijdt, wordt de uitvoer geblokkeerd.

### Laag 4: Gegevenslineage

**Beschermt tegen:** Niet-traceerbare gegevensstromen, onvermogen om te auditen waar gegevens naartoe gingen, compliance-gaten.

Elk gegevenselement draagt provenancemetadata van oorsprong tot bestemming:

- **Oorsprong**: Welke integratie, record en gebruikerstoegang deze gegevens produceerde
- **Classificatie**: Welk niveau was toegewezen en waarom
- **Transformaties**: Hoe het LLM de gegevens wijzigde, samenvatte of combineerde
- **Bestemming**: Welke sessie en welk kanaal de uitvoer ontving

Lineage maakt voorwaartse traceringen ("waar is dit Salesforce-record naartoe gegaan?"), achterwaartse traceringen ("welke bronnen droegen bij aan deze uitvoer?") en volledige compliance-exports mogelijk.

### Laag 5: Beleidshookhandhaving

**Beschermt tegen:** Prompt-injectieaanvallen, LLM-gestuurde beveiligingsomzeilingen, ongecontroleerde tooluitvoering.

Acht deterministische hooks onderscheppen elke actie op kritieke punten in de gegevensstroom:

| Hook                    | Wat het onderschept                              |
| ----------------------- | ------------------------------------------------ |
| `PRE_CONTEXT_INJECTION` | Externe invoer die het contextvenster binnenkomt |
| `PRE_TOOL_CALL`         | LLM dat tooluitvoering vraagt                    |
| `POST_TOOL_RESPONSE`    | Gegevens die terugkeren van tooluitvoering       |
| `PRE_OUTPUT`            | Antwoord dat het systeem gaat verlaten           |
| `SECRET_ACCESS`         | Verzoek voor toegang tot inloggegevens           |
| `SESSION_RESET`         | Taint-resetverzoek                               |
| `AGENT_INVOCATION`      | Agent-naar-agent-aanroep                         |
| `MCP_TOOL_CALL`         | MCP-server-toolaanroep                           |

Hooks zijn pure code: deterministisch, synchroon, vastgelegd en onvervalsbaar. Het LLM kan ze niet omzeilen omdat er geen weg is van LLM-uitvoer naar hook-configuratie. De hooklaag parseert LLM-uitvoer niet op opdrachten.

### Laag 6: MCP Gateway

**Beschermt tegen:** Ongecontroleerde externe tooltoegang, niet-geclassificeerde gegevens die binnenkomen via MCP-servers, schemaschendingen.

Alle MCP-servers zijn standaard `UNTRUSTED` en kunnen niet worden aangeroepen totdat een beheerder of gebruiker ze classificeert. De Gateway handhaaft:

- Serververificatie en classificatiestatus
- Toolniveaumachtigingen (individuele tools kunnen worden geblokkeerd, zelfs als de server is toegestaan)
- Verzoek-/antwoordschemavalidatie
- Taint-tracking op alle MCP-antwoorden
- Scannen op injectiepatronen in parameters

<img src="/diagrams/mcp-server-states.svg" alt="MCP-serverstatussen: UNTRUSTED (standaard), CLASSIFIED (beoordeeld en toegestaan), BLOCKED (expliciet verboden)" style="max-width: 100%;" />

### Laag 7: Plugin-sandbox

Schakel een TypeScript-plug-in in via `enabled: true` in de gebruikersconfiguratie. Import en uitvoering vinden standaard plaats in Deno-workers met beperkte rechten. Ze kunnen de plug-inmap lezen en alleen verbinding maken met hosts en poorten in `declaredEndpoints`. Schrijftoegang, de procesomgeving, subprocessen, FFI en afgeschermde systeeminformatie zijn geblokkeerd. `trust: trusted` staat import in het Triggerfish-proces toe. De executor draait daar als het manifest ook `trusted` opgeeft.

[Volledige plug-ingids](../integrations/plugins)

### Laag 8: Geheimenisolatie

**Beschermt tegen:** Diefstal van inloggegevens, geheimen in configuratiebestanden, opslag van inloggegevens in platte tekst.

Inloggegevens worden opgeslagen in de OS-sleutelhanger (persoonlijk niveau) of vault-integratie (enterprise niveau). Ze verschijnen nooit in:

- Configuratiebestanden
- `StorageProvider`-waarden
- Logboekitems
- LLM-context (inloggegevens worden geïnjecteerd op de HTTP-laag, onder het LLM)

De `SECRET_ACCESS`-hook registreert elke toegang tot inloggegevens met de aanvragende plugin, het inloggegevensbereik en de beslissing.

### Laag 9: Bestandssysteem-toolsandbox

**Beschermt tegen:** Padtraversalaanvallen, ongeautoriseerde bestandstoegang, classificatieomzeiling via directe bestandssysteembewerkingen.

Alle bestandssysteem-toolbewerkingen (lezen, schrijven, bewerken, weergeven, zoeken) draaien in een sandbox'ed Deno Worker met OS-niveaumachtigingen begrensd tot de taint-geschikte werkruimtesubmap van de sessie. De sandbox handhaaft drie grenzen:

- **Padgevangenis** — elk pad wordt opgelost naar een absoluut pad en gecontroleerd op de gevangenisroot met scheidingsteken-bewuste matching. Traversaalpogingen (`../`) die de werkruimte verlaten, worden geweigerd voordat enige I/O plaatsvindt
- **Padclassificatie** — elk bestandssysteempad wordt geclassificeerd via een vaste oplossingsketen: hardgecodeerde beveiligde paden (RESTRICTED), werkruimteclassificatiemappen, geconfigureerde padtoewijzingen, dan standaardclassificatie. De agent heeft geen toegang tot paden boven zijn sessie-taint
- **Taint-bereik-machtigingen** — de Deno-machtigingen van de sandbox Worker worden ingesteld op de werkruimtesubmap die overeenkomt met het huidige taint-niveau van de sessie. Wanneer taint escaleert, wordt de Worker opnieuw gestart met uitgebreide machtigingen. Machtigingen kunnen alleen verbreden, nooit versmallen binnen een sessie
- **Schrijfbeveiliging** — kritieke bestanden (`TRIGGER.md`, `triggerfish.yaml`, `SPINE.md`) zijn schrijfbeveiligd op de toollaag ongeacht sandboxmachtigingen. Deze bestanden kunnen alleen worden gewijzigd via toegewijde beheerstools die hun eigen classificatieregels handhaven

### Laag 10: Agent-identiteit

**Beschermt tegen:** Privilegeescalatie via agentketens, gegevenswassen via delegatie.

Wanneer agents andere agents aanroepen, voorkomen cryptografische delegatieketens privilegeescalatie:

- Elke agent heeft een certificaat dat zijn mogelijkheden en classificatieplafond specificeert
- De callee erft `max(eigen taint, caller taint)` — taint kan alleen toenemen via ketens
- Een caller met taint die het plafond van de callee overschrijdt, wordt geblokkeerd
- Circulaire aanroepen worden gedetecteerd en geweigerd
- Delegatiediepte is beperkt en gehandhaafd

<img src="/diagrams/data-laundering-defense.svg" alt="Verdediging tegen gegevenswassen: aanvalspad geblokkeerd bij plafondcontrole en taint-overerving voorkomt uitvoer naar lagere classificatiekanalen" style="max-width: 100%;" />

### Laag 11: Auditregistratie

**Beschermt tegen:** Niet-detecteerbare inbreuken, compliance-fouten, onvermogen om incidenten te onderzoeken.

Elke beveiligingsrelevante beslissing wordt vastgelegd met volledige context:

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

Wat er wordt vastgelegd:

- Alle actieverzoeken (toegestane EN geweigerde)
- Classificatiebeslissingen
- Wijzigingen in sessie-taint
- Kanaalverificatiegebeurtenissen
- Beleidregevalueringen
- Aanmaken en bijwerken van lineagerecords
- MCP Gateway-beslissingen
- Agent-naar-agent-aanroepen

::: info Auditregistratie kan niet worden uitgeschakeld. Het is een vaste regel in de beleidshiërarchie. Zelfs een organisatiebeheerder kan de registratie van zijn eigen acties niet uitschakelen. Enterprise-implementaties kunnen optioneel volledige inhoudsregistratie inschakelen (inclusief geblokkeerde berichtinhoud) voor forensische vereisten. :::

### Laag 12: SSRF-preventie

**Beschermt tegen:** Server-side request forgery, intern netwerk verkenning, cloud-metadata-exfiltratie.

Alle uitgaande HTTP-verzoeken (van `web_fetch`, `browser.navigate` en plugin-netwerktoegang) lossen DNS eerst op en controleren het opgeloste IP-adres op een hardgecodeerde denylist van privé- en gereserveerde bereiken. Dit voorkomt dat een aanvaller de agent trikt om interne services te raadplegen via vervaardigde URL's.

- Privébereiken (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`) zijn altijd geblokkeerd
- Link-local (`169.254.0.0/16`) en cloud-metadata-eindpunten zijn geblokkeerd
- Loopback (`127.0.0.0/8`) is geblokkeerd
- De denylist is hardgecodeerd en niet configureerbaar — er is geen beheerdersoverschrijving
- DNS-oplossing vindt plaats voor het verzoek, waardoor DNS-herbindingsaanvallen worden voorkomen

### Laag 13: Geheugenclassificatiepoort

**Beschermt tegen:** Cross-sessie-gegevenslekken via geheugen, classificatiedowngrade via geheugen-schrijven, ongeautoriseerde toegang tot geclassificeerde herinneringen.

Het cross-sessieheugen-systeem handhaaft classificatie bij zowel schrijf- als leestijd:

- **Schrijven**: Geheugenitems worden gedwongen op het taint-niveau van de huidige sessie. Het LLM kan geen lagere classificatie kiezen voor opgeslagen herinneringen.
- **Lezen**: Geheugenquery's worden gefilterd door `canFlowTo` — een sessie kan alleen herinneringen lezen op of onder zijn huidige taint-niveau.

Dit voorkomt dat een agent CONFIDENTIAL-gegevens als PUBLIC opslaat in het geheugen en ze later ophaalt in een lagere taint-sessie om de no-write-down-regel te omzeilen.

## Vertrouwenshiërarchie

Het vertrouwensmodel definieert wie autoriteit heeft over wat. Hogere lagen kunnen beveiligingsregels van lagere lagen niet omzeilen, maar ze kunnen de aanpasbare parameters binnen die regels configureren.

<img src="/diagrams/trust-hierarchy.svg" alt="Vertrouwenshiërarchie: Triggerfish-leverancier (nul toegang), Org-beheerder (stelt beleidsregels in), Medewerker (gebruikt agent binnen grenzen)" style="max-width: 100%;" />

::: tip **Persoonlijk niveau:** De gebruiker IS de org-beheerder. Volledige soevereiniteit. Geen Triggerfish-zichtbaarheid. De leverancier heeft standaard nul toegang tot gebruikersgegevens en kan alleen toegang krijgen via een expliciete, tijdgebonden, vastgelegde toestemming van de gebruiker. :::

## Hoe de lagen samenwerken

Overweeg een prompt-injectieaanval waarbij een kwaadaardig bericht probeert gegevens te exfiltreren:

| Stap | Laag                   | Actie                                                             |
| ---- | ---------------------- | ----------------------------------------------------------------- |
| 1    | Kanaalverificatie      | Bericht getagd als `{ source: "external" }` — niet eigenaar      |
| 2    | PRE_CONTEXT_INJECTION  | Invoer gescand op injectiepatronen, geclassificeerd              |
| 3    | Sessie-taint           | Sessie-taint ongewijzigd (geen geclassificeerde gegevens geraadpleegd) |
| 4    | LLM verwerkt bericht   | LLM kan worden gemanipuleerd om een toolaanroep te vragen        |
| 5    | PRE_TOOL_CALL          | Toolmachtigingscontrole op basis van regels voor externe bronnen  |
| 6    | POST_TOOL_RESPONSE     | Geretourneerde gegevens geclassificeerd, taint bijgewerkt         |
| 7    | PRE_OUTPUT             | Uitvoerclassificatie vs. doel gecontroleerd                       |
| 8    | Auditregistratie       | Volledige reeks vastgelegd voor beoordeling                       |

Zelfs als het LLM volledig is gecompromitteerd bij stap 4 en een gegevensexfiltratietoolaanroep vraagt, blijven de overige lagen (machtigingscontroles, taint-tracking, uitvoerclassificatie, auditregistratie) beleid handhaven. Geen enkel storingsmoment compromitteert het systeem.
