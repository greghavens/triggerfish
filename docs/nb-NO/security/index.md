# Sikkerhetsfokusert design

Triggerfish er bygget på ett premiss: **LLM-en har null autoritet**. Den ber om handlinger; policy-laget bestemmer. Hver sikkerhetsbeslutning fattes av deterministisk kode som KI-en ikke kan omgå, overstyre eller påvirke.

Denne siden forklarer hvorfor Triggerfish tar denne tilnærmingen, hvordan den skiller seg fra tradisjonelle AI-agentplattformer og hvor du finner detaljer om hver komponent i sikkerhetsmodellen.

## Hvorfor sikkerhet må være under LLM-en

Store språkmodeller kan prompt-injiseres. En nøye utformet inndata — enten fra en ondsinnet ekstern melding, et forgiftet dokument eller et kompromittert verktøysvar — kan få en LLM til å ignorere instruksjonene sine og ta handlinger den ble bedt om å ikke ta. Dette er ikke en teoretisk risiko. Det er et veldokumentert, uløst problem i KI-bransjen.

Hvis sikkerhetsmodellen din avhenger av at LLM-en følger regler, kan en enkelt vellykket injeksjon omgå alle sikkerhetstiltakene du har bygget.

Triggerfish løser dette ved å flytte all sikkerhetshåndhevelse til et kodelag som sitter **under** LLM-en. KI-en ser aldri sikkerhetsbeslutninger. Den evaluerer aldri om en handling skal tillates. Den ber ganske enkelt om handlinger, og policy-håndhevelseslaget — som kjører som ren, deterministisk kode — bestemmer om disse handlingene fortsetter.

<img src="/diagrams/enforcement-layers.svg" alt="Håndhevelseslag: LLM har null autoritet, policy-lag tar alle beslutninger deterministisk, bare tillatte handlinger når utførelse" style="max-width: 100%;" />

::: warning SIKKERHET LLM-laget har ingen mekanisme for å overstyre, hoppe over eller påvirke policy-håndhevelseslaget. Det er ingen "parse LLM-utdata for omgåelseskommandoer"-logikk. Separasjonen er arkitektonisk, ikke atferdsmessig. :::

## Kjerneinvarianten

Alle designbeslutninger i Triggerfish flyter fra én invariant:

> **Samme inndata gir alltid samme sikkerhetsbeslutning. Ingen tilfeldighet, ingen LLM-kall, ingen skjønn.**

Dette betyr at sikkerhetsatferd er:

- **Reviderbar** — du kan spille av en hvilken som helst beslutning og få det samme resultatet
- **Testbar** — deterministisk kode kan dekkes av automatiserte tester
- **Verifiserbar** — policy-motoren er åpen kildekode (Apache 2.0 lisensiert) og alle kan inspisere den

## Sikkerhetsprinsipper

| Prinsipp                | Hva det betyr                                                                                                                               | Detaljside                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **Dataklassifisering**  | All data bærer et sensitivitetsnivå (RESTRICTED, CONFIDENTIAL, INTERNAL, PUBLIC). Klassifisering tildeles av kode når data kommer inn.      | [Arkitektur: Klassifisering](/nb-NO/architecture/classification)  |
| **No Write-Down**       | Data kan bare flyte til kanaler og mottakere på et likt eller høyere klassifiseringsnivå. CONFIDENTIAL-data kan ikke nå en PUBLIC-kanal.   | [No-Write-Down-regelen](./no-write-down)                          |
| **Session Taint**       | Når en sesjon aksesserer data på et klassifiseringsnivå, tainttes hele sesjonen til det nivået. Taint kan bare eskalere, aldri synke.       | [Arkitektur: Taint](/nb-NO/architecture/taint-and-sessions)       |
| **Deterministiske hooks** | Åtte håndhevingshooks kjører på kritiske punkter i hver dataflyt. Hver hook er synkron, logget og uforfalskerbar.                         | [Arkitektur: Policy-motor](/nb-NO/architecture/policy-engine)     |
| **Identitet i kode**    | Brukeridentitet bestemmes av kode ved sesjonsetablering, ikke av LLM-en som tolker meldingsinnhold.                                         | [Identitet og autentisering](./identity)                          |
| **Agentdelegasjon**     | Agent-til-agent-kall styres av kryptografiske sertifikater, klassifiseringstak og dybdegrenser.                                            | [Agentdelegasjon](./agent-delegation)                             |
| **Hemmelighetsisolasjon** | Legitimasjon lagres i OS-nøkkelringer eller vaults, aldri i konfigurasjonsfiler. Plugins kan ikke få tilgang til systemlegitimasjon.      | [Hemmelighetshåndtering](./secrets)                               |
| **Revider alt**         | Alle policy-beslutninger logges med full kontekst: tidsstempel, hook-type, sesjons-ID, inndata, resultat og evaluerte regler.              | [Revisjon og samsvar](./audit-logging)                            |

## Tradisjonelle AI-agenter vs. Triggerfish

De fleste AI-agentplattformer stoler på LLM-en for å håndheve sikkerhet. Systemprompten sier "ikke del sensitive data," og agenten stoler på å følge dette. Denne tilnærmingen har grunnleggende svakheter.

| Aspekt                        | Tradisjonell AI-agent                        | Triggerfish                                                          |
| ----------------------------- | -------------------------------------------- | -------------------------------------------------------------------- |
| **Sikkerhetshåndhevelse**     | Systempromptinstruksjoner til LLM-en         | Deterministisk kode under LLM-en                                     |
| **Prompt-injeksjonsforsvar**  | Håp om at LLM-en motstår                     | LLM-en har ingen autoritet til å begynne med                         |
| **Dataflytkontroll**          | LLM bestemmer hva som er trygt å dele        | Klassifiseringsetiketter + no-write-down-regel i kode                |
| **Identitetsverifisering**    | LLM tolker "Jeg er admin"                    | Kode sjekker kryptografisk kanalidentitet                            |
| **Revisjonslogg**             | LLM samtalelogger                            | Strukturerte policy-beslutningslogger med full kontekst              |
| **Legitimasjonstilgang**      | System-tjenestekonto for alle brukere        | Delegert brukerlegitimasjon; kildesystemtillatelser arves            |
| **Testbarhet**                | Uklar — avhenger av promptformulering        | Deterministisk — samme inndata, samme beslutning, hver gang          |
| **Åpen for verifisering**     | Vanligvis proprietær                         | Apache 2.0 lisensiert, fullt reviderbar                              |

::: tip Triggerfish hevder ikke at LLM-er er upålitelige. Det hevder at LLM-er er feil lag for sikkerhetshåndhevelse. En godt promptet LLM følger instruksjonene sine det meste av tiden. Men "det meste av tiden" er ikke en sikkerhetsgaranti. Triggerfish gir en garanti: policy-laget er kode, og kode gjør det den blir bedt om, hver gang. :::

## Forsvar i dybden

Triggerfish implementerer tretten lag med forsvar. Intet enkelt lag er tilstrekkelig alene; sammen danner de en sikkerhetsgrense:

1. **Kanalautentisering** — kodevelifisert identitet ved sesjonsetablering
2. **Tillatelsesbevisst datatilgang** — kildesystemtillatelser, ikke systemlegitimasjon
3. **Session taint-sporing** — automatisk, obligatorisk, kun eskalering
4. **Datalinje** — fullstendig provenanskjede for hvert dataelement
5. **Policy-håndhevelseshooks** — deterministiske, ikke-omgåelige, loggede
6. **MCP Gateway** — sikker ekstern verktøytilgang med per-verktøy-tillatelser
7. **[Plugin-sandkasse](../integrations/plugins)**
8. **Hemmelighetsisolasjon** — OS-nøkkelring eller vault, aldri konfigurasjonsfiler
9. **Filsystemverktøy-sandkasse** — stifengsel, stikelassifisering, taint-avgrenset OS-nivå I/U-tillatelser
10. **Agent-identitet** — kryptografiske delegeringskjeder
11. **Revisjonslogging** — alle beslutninger registrert, ingen unntak
12. **SSRF-forebygging** — IP-avvisningsliste + DNS-oppløsningssjekker på all utgående HTTP
13. **Minneklassifiseringsgating** — skrivinger tvunget til session taint, lesinger filtrert av `canFlowTo`

## Neste steg

| Side                                                             | Beskrivelse                                                                               |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [Klassifiseringsveiledning](/nb-NO/guide/classification-guide)   | Praktisk guide til å velge riktig nivå for kanaler, MCP-servere og integrasjoner         |
| [No-Write-Down-regelen](./no-write-down)                         | Den grunnleggende dataflytregel og hvordan den håndheves                                  |
| [Identitet og autentisering](./identity)                         | Kanalautentisering og verifisering av eieridentitet                                      |
| [Agentdelegasjon](./agent-delegation)                            | Agent-til-agent-identitet, sertifikater og delegeringskjeder                             |
| [Hemmelighetshåndtering](./secrets)                              | Hvordan Triggerfish håndterer legitimasjon på tvers av nivåer                            |
| [Revisjon og samsvar](./audit-logging)                           | Revisjonsloggstruktur, sporing og samsvareksporter                                       |
