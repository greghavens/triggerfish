---
title: Trust Center
description: Beveiligingscontroles, compliance-positie en architecturale transparantie voor Triggerfish.
---

# Trust Center

Triggerfish handhaaft beveiliging in deterministische code onder de LLM-laag — niet in prompts die het model mogelijk negeert. Elke beleidsbeslissing wordt genomen door code die niet kan worden beïnvloed door prompt-injectie, social engineering of modelwangedrag. Zie de volledige pagina [Beveiligingsgericht ontwerp](/nl-NL/security/) voor de diepgaande technische uitleg.

## Beveiligingscontroles

Deze controles zijn actief in de huidige release. Elk wordt afgedwongen in code, getest in CI en auditeerbaar in de open-source repository.

| Controle                          | Status                           | Beschrijving                                                                                                                                          |
| --------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sub-LLM beleidshandhaving         | <StatusBadge status="active" />  | Acht deterministische hooks onderscheppen elke actie voor en na LLM-verwerking. Het model kan beveiligingsbeslissingen niet omzeilen, wijzigen of beïnvloeden. |
| Gegevensclassificatiesysteem      | <StatusBadge status="active" />  | Vierniveauhiërarchie (PUBLIC, INTERNAL, CONFIDENTIAL, RESTRICTED) met verplichte no-write-down-handhaving.                                           |
| Sessie-taint-tracking             | <StatusBadge status="active" />  | Elke sessie houdt de hoogste classificatie bij van benaderde gegevens. Taint escaleert alleen, neemt nooit af.                                        |
| Onveranderlijke auditlogging      | <StatusBadge status="active" />  | Alle beleidsbeslissingen vastgelegd met volledige context. Auditlogging kan niet worden uitgeschakeld door een component van het systeem.              |
| Geheimenisolatie                  | <StatusBadge status="active" />  | Inloggegevens opgeslagen in OS-sleutelhanger of vault. Nooit in configuratiebestanden, opslag, logboeken of LLM-context.                              |
| Plugin-sandbox                    | <StatusBadge status="active" />  | [Plug-ins](../integrations/plugins) |
| Afhankelijkheidsscanning          | <StatusBadge status="active" />  | Geautomatiseerde kwetsbaarheidsscan via GitHub Dependabot. PR's worden automatisch geopend voor upstream-CVE's.                                       |
| Open-source codebase              | <StatusBadge status="active" />  | Volledige beveiligingsarchitectuur is Apache 2.0-gelicentieerd en publiekelijk auditeerbaar.                                                          |
| On-premises implementatie         | <StatusBadge status="active" />  | Draait volledig op uw infrastructuur. Geen cloudafhankelijkheid, geen telemetrie, geen externe gegevensverwerking.                                    |
| Versleuteling                     | <StatusBadge status="active" />  | TLS voor alle gegevens in transit. Versleuteling op OS-niveau in rust. Enterprise-vaultintegratie beschikbaar.                                        |
| Responsible Disclosure-programma  | <StatusBadge status="active" />  | Gedocumenteerd kwetsbaarheidsrapportageproces met gedefinieerde reactietijdlijnen. Zie [openbaarmakingsbeleid](/nl-NL/security/responsible-disclosure). |
| Geharde containerimage            | <StatusBadge status="planned" /> | Docker-images op Google Distroless-basis met bijna nul CVE's. Geautomatiseerde Trivy-scanning in CI.                                                  |

## Verdediging in diepte — 13 onafhankelijke lagen

Geen enkele laag is op zichzelf voldoende. Als één laag is gecompromitteerd, blijven de overige lagen het systeem beschermen.

| Laag | Naam                              | Handhaving                                            |
| ---- | --------------------------------- | ----------------------------------------------------- |
| 01   | Kanaalverificatie                 | Door code geverifieerde identiteit bij sessiegebouw   |
| 02   | Toestemmingsbewuste gegevenstoegang | Bronsysteemrechten, geen systeeminloggegevens        |
| 03   | Sessie-taint-tracking             | Automatisch, verplicht, alleen escalatie              |
| 04   | Gegevenslineage                   | Volledige provenanceketen voor elk gegevenselement    |
| 05   | Beleidshookhandhaving             | Deterministisch, niet-omzeilbaar, vastgelegd          |
| 06   | MCP Gateway                       | Per-tool-rechten, serverclassificatie                 |
| 07   | Plugin-sandbox                    | [Plug-ins](../integrations/plugins) |
| 08   | Geheimenisolatie                  | OS-sleutelhanger of vault, onder LLM-laag             |
| 09   | Bestandssysteem-toolsandbox       | Padgevangenis, padclassificatie, taint-bereik OS-I/O  |
| 10   | Agentidentiteit en delegatie      | Cryptografische delegatieketens                       |
| 11   | Auditlogging                      | Kan niet worden uitgeschakeld                         |
| 12   | SSRF-preventie                    | IP-denylist + DNS-oplossingscontroles                 |
| 13   | Geheugenclassificatiepoort        | Schrijven op eigen niveau, lezen alleen omlaag        |

Lees de volledige [Verdediging in diepte](/nl-NL/architecture/defense-in-depth)-architectuurdocumentatie.

## Waarom sub-LLM-handhaving van belang is

::: info De meeste AI-agentplatforms handhaven beveiliging via systeemprompts — instructies aan het LLM die zeggen "deel geen gevoelige gegevens." Prompt-injectieaanvallen kunnen deze instructies overschrijven.

Triggerfish hanteert een andere aanpak: het LLM heeft **nul autoriteit** over beveiligingsbeslissingen. Alle handhaving vindt plaats in deterministische code onder de LLM-laag. Er is geen pad van LLM-uitvoer naar beveiligingsconfiguratie. :::

## Compliance-roadmap

Triggerfish is pre-certificering. Onze beveiligingspositie is architecturaal en vandaag verifieerbaar in broncode. Formele certificeringen staan op de roadmap.

| Certificering                 | Status                           | Opmerkingen                                                              |
| ----------------------------- | -------------------------------- | ------------------------------------------------------------------------ |
| SOC 2 Type I                  | <StatusBadge status="planned" /> | Beveiligings- en vertrouwelijkheidsvereisten                             |
| SOC 2 Type II                 | <StatusBadge status="planned" /> | Aanhoudende controle-effectiviteit over observatieperiode                |
| HIPAA BAA                     | <StatusBadge status="planned" /> | Business associate agreement voor zorgklanten                            |
| ISO 27001                     | <StatusBadge status="planned" /> | Beheersysteem voor informatiebeveiliging                                 |
| Penetratietest door derde     | <StatusBadge status="planned" /> | Onafhankelijke beveiligingsbeoordeling                                   |
| GDPR-compliance               | <StatusBadge status="planned" /> | Self-hosted architectuur met configureerbare retentie en verwijdering    |

## Een noot over vertrouwen

::: tip De beveiligingskern is open source onder Apache 2.0. U kunt elke regel beleidshandhavingscode lezen, de testsuite uitvoeren en claims zelf verifiëren. Certificeringen staan op de roadmap. :::

## De broncode controleren

De volledige Triggerfish-codebase is beschikbaar op [github.com/greghavens/triggerfish](https://github.com/greghavens/triggerfish) — Apache 2.0-gelicentieerd.

## Kwetsbaarheidsrapportage

Als u een beveiligingskwetsbaarheid ontdekt, meld dit dan via ons [Responsible Disclosure-beleid](/nl-NL/security/responsible-disclosure). Open geen publieke GitHub-issues voor beveiligingskwetsbaarheden.
