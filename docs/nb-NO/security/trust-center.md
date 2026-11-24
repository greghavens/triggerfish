---
title: Tillitssenter
description: Sikkerhetskontroller, samsvarsposisjon og arkitektonisk åpenhet for Triggerfish.
---

# Tillitssenter

Triggerfish håndhever sikkerhet i deterministisk kode under LLM-laget — ikke i prompter modellen kan ignorere. Hver policy-beslutning tas av kode som ikke kan påvirkes av prompt-injeksjon, sosial manipulasjon eller modellfeiladferd. Se den fullstendige [Sikkerhetsfokusert design](/nb-NO/security/)-siden for den dype tekniske forklaringen.

## Sikkerhetskontroller

Disse kontrollene er aktive i gjeldende utgivelse. Hver av dem håndheves i kode, testes i CI og er reviderbar i det åpne kildekodelageret.

| Kontroll                          | Status                           | Beskrivelse                                                                                                                                              |
| --------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sub-LLM Policy-håndhevelse        | <StatusBadge status="active" />  | Åtte deterministiske hooks intercepterer hver handling før og etter LLM-behandling. Modellen kan ikke omgå, endre eller påvirke sikkerhetsbeslutninger.  |
| Dataklassifiseringssystem         | <StatusBadge status="active" />  | Fire-nivås hierarki (PUBLIC, INTERNAL, CONFIDENTIAL, RESTRICTED) med obligatorisk no-write-down-håndhevelse.                                             |
| Session Taint-sporing             | <StatusBadge status="active" />  | Hver sesjon sporer den høyeste klassifiseringen av aksesserte data. Taint eskalerer bare, synker aldri.                                                  |
| Uforanderlig revisjonslogging     | <StatusBadge status="active" />  | Alle policy-beslutninger logges med full kontekst. Revisjonslogging kan ikke deaktiveres av noen komponent i systemet.                                   |
| Hemmelighetsisolasjon             | <StatusBadge status="active" />  | Legitimasjon lagres i OS-nøkkelring eller vault. Aldri i konfigurasjonsfiler, lagring, logger eller LLM-kontekst.                                        |
| Plugin-sandkasse                  | <StatusBadge status="active" />  | [Programtillegg](../integrations/plugins) |
| Avhengighetsskanning              | <StatusBadge status="active" />  | Automatisert sårbarhetsskanning via GitHub Dependabot. PR-er åpnes automatisk for oppstrøms CVE-er.                                                      |
| Åpen kildekodebase                | <StatusBadge status="active" />  | Full sikkerhetsarkitektur er Apache 2.0-lisensiert og offentlig reviderbar.                                                                               |
| Lokal distribusjon                | <StatusBadge status="active" />  | Kjøres helt på din infrastruktur. Ingen skyavhengighet, ingen telemetri, ingen ekstern databehandling.                                                   |
| Kryptering                        | <StatusBadge status="active" />  | TLS for alle data under overføring. OS-nivå kryptering i ro. Bedrifts vault-integrasjon tilgjengelig.                                                    |
| Program for ansvarlig avsløring   | <StatusBadge status="active" />  | Dokumentert prosess for sårbarhetrapportering med definerte svartidslinjer. Se [avsløringspolicy](/nb-NO/security/responsible-disclosure).                |
| Herdet containerimage             | <StatusBadge status="planned" /> | Docker-images på Google Distroless-base med nesten null CVE-er. Automatisert Trivy-skanning i CI.                                                        |

## Forsvar i dybden — 13 uavhengige lag

Intet enkelt lag er tilstrekkelig alene. Hvis ett lag er kompromittert, fortsetter de gjenværende lagene å beskytte systemet.

| Lag | Navn                              | Håndhevelse                                             |
| --- | --------------------------------- | ------------------------------------------------------- |
| 01  | Kanalautentisering                | Kodeverifisert identitet ved sesjonsetablering          |
| 02  | Tillatelsesbevisst datatilgang    | Kildesystemtillatelser, ikke systemlegitimasjon         |
| 03  | Session Taint-sporing             | Automatisk, obligatorisk, kun eskalering                |
| 04  | Datalinje                         | Fullstendig provenansrekke for hvert dataelement        |
| 05  | Policy-håndhevelseshooks          | Deterministisk, ikke-omgåelig, logget                   |
| 06  | MCP Gateway                       | Per-verktøy-tillatelser, serverkslassifisering          |
| 07  | Plugin-sandkasse                  | [Programtillegg](../integrations/plugins) |
| 08  | Hemmelighetsisolasjon             | OS-nøkkelring eller vault, under LLM-laget              |
| 09  | Filsystemverktøy-sandkasse        | Stifengsel, stikelassifisering, taint-avgrenset I/U     |
| 10  | Agentidentitet og delegasjon      | Kryptografiske delegeringskjeder                        |
| 11  | Revisjonslogging                  | Kan ikke deaktiveres                                    |
| 12  | SSRF-forebygging                  | IP-avvisningsliste + DNS-oppløsningssjekker             |
| 13  | Minneklassifiseringsgating        | Skriv på eget nivå, les ned bare                        |

Les den fullstendige [Forsvar i dybden](/nb-NO/architecture/defense-in-depth)-arkitekturdokumentasjonen.

## Hvorfor sub-LLM-håndhevelse er viktig

::: info De fleste KI-agentplattformer håndhever sikkerhet gjennom systempromter — instruksjoner til LLM-en om å «ikke dele sensitive data». Prompt-injeksjonsangrep kan overstyre disse instruksjonene.

Triggerfish tar en annen tilnærming: LLM-en har **null autoritet** over sikkerhetsbeslutninger. All håndhevelse skjer i deterministisk kode under LLM-laget. Det finnes ingen vei fra LLM-utdata til sikkerhetskonfigurasjon. :::

## Samsvarsveiplan

Triggerfish er pre-sertifisering. Vår sikkerhetsposisjon er arkitektonisk og verifiserbar i kildekoden i dag. Formelle sertifiseringer er på planen.

| Sertifisering                    | Status                           | Merknader                                                              |
| -------------------------------- | -------------------------------- | ---------------------------------------------------------------------- |
| SOC 2 Type I                     | <StatusBadge status="planned" /> | Sikkerhet + konfidensialitet tillitstjenestekriteria                   |
| SOC 2 Type II                    | <StatusBadge status="planned" /> | Vedvarende kontrolleffektivitet over observasjonsperioden              |
| HIPAA BAA                        | <StatusBadge status="planned" /> | Forretningsforbindelsesavtale for helsekundere                         |
| ISO 27001                        | <StatusBadge status="planned" /> | Styringssystem for informasjonssikkerhet                               |
| Tredjeparts penetrasjonstest     | <StatusBadge status="planned" /> | Uavhengig sikkerhetsvurdering                                          |
| GDPR-samsvar                     | <StatusBadge status="planned" /> | Selvhostet arkitektur med konfigurerbar oppbevaring og sletting         |

## En note om tillit

::: tip Sikkerhetskjernen er åpen kildekode under Apache 2.0. Du kan lese hver linje med policy-håndhevelseskode, kjøre testpakken og verifisere påstander selv. Sertifiseringer er på planen. :::

## Revider kildekoden

Den fullstendige Triggerfish-kodebasen er tilgjengelig på
[github.com/greghavens/triggerfish](https://github.com/greghavens/triggerfish) —
Apache 2.0-lisensiert.

## Sårbarheterapportering

Hvis du oppdager en sikkerhetssårbarhet, vennligst rapporter den gjennom vår
[Policy for ansvarlig avsløring](/nb-NO/security/responsible-disclosure). Ikke åpne offentlige GitHub-problemer for sikkerhetssårbarheter.
