---
title: Förtroendecentrum
description: Säkerhetskontroller, efterlevnadsposition och arkitektonisk transparens för Triggerfish.
---

# Förtroendecentrum

Triggerfish tillämpar säkerhet i deterministisk kod under LLM-lagret — inte i promptar som modellen kan ignorera. Varje policybeslut fattas av kod som inte kan påverkas av prompt-injektion, social manipulation eller modellfeluppträdande. Se den fullständiga [Säkerhetscentrerat design](/sv-SE/security/)-sidan för den djupgående tekniska förklaringen.

## Säkerhetskontroller

Dessa kontroller är aktiva i den aktuella versionen. Var och en tillämpas i kod, testas i CI och är granskningsbar i det öppna källkodsrepositoriet.

| Kontroll                        | Status                           | Beskrivning                                                                                                                                                    |
| ------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sub-LLM-policyhantering         | <StatusBadge status="active" />  | Åtta deterministiska hooks fångar upp varje åtgärd före och efter LLM-bearbetning. Modellen kan inte kringgå, ändra eller påverka säkerhetsbeslut.             |
| Dataklassificeringssystem       | <StatusBadge status="active" />  | Fyranivåhierarki (PUBLIC, INTERNAL, CONFIDENTIAL, RESTRICTED) med obligatorisk nedskrivningshantering.                                                         |
| Session-taint-spårning          | <StatusBadge status="active" />  | Varje session spårar den högsta klassificeringen av data som nåtts. Taint eskalerar bara, minskar aldrig.                                                       |
| Oföränderlig revisionsloggning  | <StatusBadge status="active" />  | Alla policybeslut loggas med fullständigt sammanhang. Revisionsloggning kan inte inaktiveras av någon komponent i systemet.                                     |
| Hemlighetsisolering             | <StatusBadge status="active" />  | Uppgifter lagrade i OS-nyckelring eller vault. Aldrig i konfigurationsfiler, lagring, loggar eller LLM-kontext.                                                |
| Plugin-sandlåda                 | <StatusBadge status="active" />  | [Insticksprogram](../integrations/plugins) |
| Beroendeskanning                | <StatusBadge status="active" />  | Automatiserad sårbarhetsskanning via GitHub Dependabot. PR:er öppnas automatiskt för uppströms CVE:er.                                                         |
| Öppen källkodsbas               | <StatusBadge status="active" />  | Full säkerhetsarkitektur är Apache 2.0-licensierad och offentligt granskningsbar.                                                                              |
| On-premises-driftsättning       | <StatusBadge status="active" />  | Körs helt på din infrastruktur. Inget molnberoende, ingen telemetri, ingen extern databearbetning.                                                              |
| Kryptering                      | <StatusBadge status="active" />  | TLS för all data i transit. OS-nivåkryptering i vila. Företagsvault-integration tillgänglig.                                                                   |
| Program för ansvarsfull avslöjande | <StatusBadge status="active" /> | Dokumenterad process för sårbarhetrapportering med definierade svarstidlinjer. Se [avslöjandepolicyn](/sv-SE/security/responsible-disclosure).              |
| Härdad container-bild           | <StatusBadge status="planned" /> | Docker-bilder på Google Distroless-bas med nära noll CVE:er. Automatiserad Trivy-skanning i CI.                                                                |

## Försvar på djupet — 13 oberoende lager

Inget enskilt lager är tillräckligt ensamt. Om ett lager komprometteras fortsätter de återstående lagren att skydda systemet.

| Lager | Namn                           | Tillämpning                                            |
| ----- | ------------------------------ | ------------------------------------------------------ |
| 01    | Kanalautentisering             | Kodverifierad identitet vid sessionsupprättande        |
| 02    | Behörighetsmedveten dataåtkomst | Källsystembehörigheter, inte systemuppgifter          |
| 03    | Session-taint-spårning         | Automatisk, obligatorisk, bara eskalering              |
| 04    | Datalinjegrafi                 | Fullständig provenanskedja för varje dataelement       |
| 05    | Policyhanteringshooks          | Deterministiska, icke-kringgångsbara, loggade          |
| 06    | MCP Gateway                    | Per-verktygsbehörigheter, serverklassificering         |
| 07    | Plugin-sandlåda                | [Insticksprogram](../integrations/plugins) |
| 08    | Hemlighetsisolering            | OS-nyckelring eller vault, under LLM-lagret            |
| 09    | Filsystemsverktygssandlåda     | Sökvägsinstängning, sökvägsklassificering, taint-avgränsad I/O |
| 10    | Agentidentitet och delegering  | Kryptografiska delegeringskedjor                       |
| 11    | Revisionsloggning              | Kan inte inaktiveras                                   |
| 12    | SSRF-förebyggande              | IP-nekalista + DNS-upplösningskontroller               |
| 13    | Minneklassificeringsgrindning  | Skriv på egen nivå, läs bara nedåt                     |

Läs den fullständiga [Försvar på djupet](/sv-SE/architecture/defense-in-depth)-arkitekturdokumentationen.

## Varför sub-LLM-hantering spelar roll

::: info De flesta AI-agentplattformar tillämpar säkerhet via systempromtar — instruktioner till LLM:en om att "inte dela känslig data." Prompt-injektionsattacker kan åsidosätta dessa instruktioner.

Triggerfish tar ett annat tillvägagångssätt: LLM:en har **noll auktoritet** över säkerhetsbeslut. All hantering sker i deterministisk kod under LLM-lagret. Det finns ingen väg från LLM-utdata till säkerhetskonfiguration. :::

## Efterlevnadsfärdplan

Triggerfish är pre-certifiering. Vår säkerhetsposition är arkitektonisk och verifierbar i källkod idag. Formella certifieringar finns på färdplanen.

| Certifiering                 | Status                           | Anteckningar                                                         |
| ---------------------------- | -------------------------------- | -------------------------------------------------------------------- |
| SOC 2 Type I                 | <StatusBadge status="planned" /> | Säkerhet + konfidentialitetsförtroendekriterer                       |
| SOC 2 Type II                | <StatusBadge status="planned" /> | Bibehållen kontrolleffektivitet under observationsperiod             |
| HIPAA BAA                    | <StatusBadge status="planned" /> | Affärspartnersavtal för hälsovårdskunder                            |
| ISO 27001                    | <StatusBadge status="planned" /> | Informationssäkerhetshanteringssystem                                |
| Penetrationstest av tredje part | <StatusBadge status="planned" /> | Oberoende säkerhetsbedömning                                      |
| GDPR-efterlevnad             | <StatusBadge status="planned" /> | Självhostad arkitektur med konfigurerbar kvarhållning och radering   |

## En not om förtroende

::: tip Säkerhetskärnan är öppen källkod under Apache 2.0. Du kan läsa varje rad av policyhanteringskod, köra testsviten och verifiera påståenden själv. Certifieringar finns på färdplanen. :::

## Granska källkoden

Den fullständiga Triggerfish-kodbasen finns på [github.com/greghavens/triggerfish](https://github.com/greghavens/triggerfish) — Apache 2.0-licensierad.

## Sårbarhetrapportering

Om du upptäcker en säkerhetssårbarhet, rapportera den via vår [Policy för ansvarsfull avslöjande](/sv-SE/security/responsible-disclosure). Öppna inte offentliga GitHub-ärenden för säkerhetssårbarheter.
