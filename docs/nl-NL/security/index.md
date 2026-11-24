# Beveiligingsgericht ontwerp

Triggerfish is gebouwd op één principe: **het LLM heeft nul autoriteit**. Het vraagt acties aan; de beleidslaag beslist. Elke beveiligingsbeslissing wordt genomen door deterministische code die de AI niet kan omzeilen, overschrijven of beïnvloeden.

Deze pagina legt uit waarom Triggerfish deze aanpak hanteert, hoe het verschilt van traditionele AI-agentplatforms en waar u details kunt vinden over elk onderdeel van het beveiligingsmodel.

## Waarom beveiliging onder het LLM moet zijn

Grote taalmodellen kunnen worden prompt-geïnjecteerd. Een zorgvuldig opgestelde invoer — afkomstig van een kwaadaardig extern bericht, een vergiftigd document of een gecompromitteerde toolreactie — kan een LLM ertoe brengen zijn instructies te negeren en acties te ondernemen die het niet mocht ondernemen. Dit is geen theoretisch risico. Het is een goed gedocumenteerd, onopgelost probleem in de AI-industrie.

Als uw beveiligingsmodel afhankelijk is van het LLM dat regels volgt, kan een enkele succesvolle injectie alle beveiliging omzeilen die u heeft gebouwd.

Triggerfish lost dit op door alle beveiligingshandhaving te verplaatsen naar een codelaag die **onder** het LLM zit. De AI ziet nooit beveiligingsbeslissingen. Het evalueert nooit of een actie moet worden toegestaan. Het vraagt eenvoudigweg acties aan, en de beleidshandhavingslaag — draaiend als pure, deterministische code — beslist of die acties doorgaan.

<img src="/diagrams/enforcement-layers.svg" alt="Handhavingslagen: LLM heeft nul autoriteit, beleidslaag neemt alle beslissingen deterministisch, alleen toegestane acties bereiken uitvoering" style="max-width: 100%;" />

::: warning BEVEILIGING De LLM-laag heeft geen mechanisme om de beleidshandhavingslaag te overschrijven, over te slaan of te beïnvloeden. Er is geen "parseer LLM-uitvoer op omzeilingsopdrachten"-logica. De scheiding is architecturaal, niet gedragsmatig. :::

## De kerninvariant

Elke ontwerpbeslissing in Triggerfish vloeit voort uit één invariant:

> **Dezelfde invoer levert altijd dezelfde beveiligingsbeslissing op. Geen willekeur, geen LLM-aanroepen, geen discretie.**

Dit betekent dat beveiligingsgedrag:

- **Auditeerbaar** is — u kunt elke beslissing opnieuw afspelen en hetzelfde resultaat krijgen
- **Testbaar** is — deterministische code kan worden gedekt door geautomatiseerde tests
- **Verifieerbaar** is — de beleidsengine is open source (Apache 2.0-licentie) en iedereen kan het inspecteren

## Beveiligingsprincipes

| Principe                | Wat het betekent                                                                                                                                                 | Detailpagina                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **Gegevensclassificatie** | Alle gegevens dragen een gevoeligheidsniveau (RESTRICTED, CONFIDENTIAL, INTERNAL, PUBLIC). Classificatie wordt toegewezen door code wanneer gegevens het systeem binnenkomen. | [Architectuur: Classificatie](/nl-NL/architecture/classification) |
| **Geen write-down**     | Gegevens kunnen alleen stromen naar kanalen en ontvangers op een gelijk of hoger classificatieniveau. CONFIDENTIAL-gegevens kunnen geen PUBLIC-kanaal bereiken. Geen uitzonderingen. | [No-write-down-regel](./no-write-down)                           |
| **Sessie-taint**        | Wanneer een sessie gegevens raadpleegt op een classificatieniveau, wordt de hele sessie besmet tot dat niveau. Taint kan alleen escaleren, nooit afnemen.         | [Architectuur: Taint](/nl-NL/architecture/taint-and-sessions)                |
| **Deterministische hooks** | Acht handhavingshooks worden uitgevoerd op kritieke punten in elke gegevensstroom. Elke hook is synchroon, vastgelegd en onvervalsbaar.                        | [Architectuur: Beleidsengine](/nl-NL/architecture/policy-engine)             |
| **Identiteit in code**  | Gebruikersidentiteit wordt bepaald door code bij sessiegebouw, niet door het LLM dat berichtinhoud interpreteert.                                                | [Identiteit en authenticatie](./identity)                                    |
| **Agentdelegatie**      | Agent-naar-agent-aanroepen worden beheerd door cryptografische certificaten, classificatieplafonds en dieptelimieten.                                            | [Agentdelegatie](./agent-delegation)                                         |
| **Geheimenisolatie**    | Inloggegevens worden opgeslagen in OS-sleutelhangers of vaults, nooit in configuratiebestanden. Plugins hebben geen toegang tot systeeminloggegevens.            | [Geheimenbeheer](./secrets)                                                  |
| **Alles auditen**       | Elke beleidsbeslissing wordt vastgelegd met volledige context: tijdstempel, hook-type, sessie-ID, invoer, resultaat en geëvalueerde regels.                      | [Audit en compliance](./audit-logging)                                       |

## Traditionele AI-agenten versus Triggerfish

De meeste AI-agentplatforms vertrouwen op het LLM om veiligheid te handhaven. De systeemprompt zegt "deel geen gevoelige gegevens," en van de agent wordt verwacht dat het zich aan houdt. Deze aanpak heeft fundamentele zwakheden.

| Aspect                        | Traditionele AI-agent                  | Triggerfish                                                       |
| ----------------------------- | -------------------------------------- | ----------------------------------------------------------------- |
| **Beveiligingshandhaving**    | Systeempromptinstructies aan het LLM   | Deterministische code onder het LLM                               |
| **Verdediging tegen prompt-injectie** | Hopen dat het LLM weerstand biedt | LLM heeft sowieso geen autoriteit                              |
| **Gegevensstroombeheer**      | LLM beslist wat veilig is om te delen  | Classificatielabels + no-write-down-regel in code                 |
| **Identiteitsverificatie**    | LLM interpreteert "ik ben de beheerder" | Code controleert cryptografische kanaalidentiteit                |
| **Audittrail**                | LLM-gesprekslogboeken                  | Gestructureerde beleidsbeslissingslogboeken met volledige context |
| **Toegang tot inloggegevens** | Systeem-service-account voor alle gebruikers | Gedelegeerde gebruikersinloggegevens; bronpermissies overgenomen |
| **Testbaarheid**              | Vaag — afhankelijk van promptformulering | Deterministisch — dezelfde invoer, dezelfde beslissing, elke keer |
| **Open voor verificatie**     | Meestal eigendomsrechtelijk            | Apache 2.0-licentie, volledig auditeerbaar                        |

::: tip Triggerfish beweert niet dat LLMs onbetrouwbaar zijn. Het beweert dat LLMs de verkeerde laag zijn voor beveiligingshandhaving. Een goed geprompt LLM zal zijn instructies de meeste tijd volgen. Maar "de meeste tijd" is geen beveiligingsgarantie. Triggerfish biedt een garantie: de beleidslaag is code, en code doet wat hem is verteld, elke keer. :::

## Verdediging in diepte

Triggerfish implementeert dertien verdedigingslagen. Geen enkele laag is op zichzelf voldoende; samen vormen ze een beveiligingsgrens:

1. **Kanaalverificatie** — door code geverifieerde identiteit bij sessiegebouw
2. **Machtigingsbewuste gegevenstoegang** — bronpermissies, geen systeeminloggegevens
3. **Sessie-taint-tracking** — automatisch, verplicht, alleen escalatie
4. **Gegevenslineage** — volledige provenanceketen voor elk gegevenselement
5. **Beleidshookhandhaving** — deterministisch, niet-omzeilbaar, vastgelegd
6. **MCP Gateway** — beveiligde externe tooltoegang met per-tool-machtigingen
7. **[Plugin-sandbox](../integrations/plugins)**
8. **Geheimenisolatie** — OS-sleutelhanger of vault, nooit configuratiebestanden
9. **Bestandssysteem-toolsandbox** — padgevangenis, padclassificatie, taint-bereik OS-I/O-machtigingen
10. **Agent-identiteit** — cryptografische delegatieketens
11. **Auditregistratie** — alle beslissingen vastgelegd, geen uitzonderingen
12. **SSRF-preventie** — IP-denylist + DNS-oplossingscontroles op alle uitgaande HTTP
13. **Geheugenclassificatiepoort** — schrijven gedwongen naar sessie-taint, lezen gefilterd door `canFlowTo`

## Volgende stappen

| Pagina                                                              | Beschrijving                                                                                  |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| [Classificatiegids](/nl-NL/guide/classification-guide)              | Praktische gids voor het kiezen van het juiste niveau voor kanalen, MCP-servers en integraties |
| [No-write-down-regel](./no-write-down)                              | De fundamentele gegevensstroom-regel en hoe deze wordt gehandhaafd                            |
| [Identiteit en authenticatie](./identity)                           | Kanaalverificatie en verificatie van eigenaaridentiteit                                       |
| [Agentdelegatie](./agent-delegation)                                | Agent-naar-agent-identiteit, certificaten en delegatieketens                                  |
| [Geheimenbeheer](./secrets)                                         | Hoe Triggerfish inloggegevens beheert over niveaus                                            |
| [Audit en compliance](./audit-logging)                              | Audittrailstructuur, tracering en compliance-exports                                          |
