# Forsvar i dybden

Triggerfish implementerer sikkerhet som 13 uavhengige, overlappende lag. Intet enkelt lag er tilstrekkelig alene. Sammen danner de et forsvar som degraderer elegrant — selv om ett lag kompromitteres, fortsetter de gjenværende lagene å beskytte systemet.

::: warning SIKKERHET Forsvar i dybden betyr at en sårbarhet i ett enkelt lag ikke kompromitterer systemet. En angriper som omgår kanalautentisering møter fortsatt session taint-sporing, policy-hooks og revisjonslogging. En LLM som er prompt-injisert kan fortsatt ikke påvirke det deterministiske policy-laget under seg. :::

## De 13 lagene

### Lag 1: Kanalautentisering

**Beskytter mot:** Identitetsforfalskning, uautorisert tilgang, identitetsforvirring.

Identitet bestemmes av **kode ved sesjonsetablering**, ikke av LLM-en som tolker meldingsinnhold. Før LLM-en ser noen melding, merker kanaladapteren den med et uforanderlig etikett:

```
{ source: "owner" }    -- verifisert kanalidentitet samsvarer med registrert eier
{ source: "external" } -- alle andre; kun inndata, behandles ikke som kommando
```

Autentiseringsmetoder varierer per kanal:

| Kanal                   | Metode          | Verifisering                                                       |
| ----------------------- | --------------- | ------------------------------------------------------------------ |
| Telegram / WhatsApp     | Paringskode     | Engangs kode, 5-minutters utløp, sendt fra brukerens konto         |
| Slack / Discord / Teams | OAuth           | Plattform OAuth-samtykkeflyt, returnerer verifisert bruker-ID      |
| CLI                     | Lokal prosess   | Kjører på brukerens maskin, autentisert av OS                      |
| WebChat                 | Ingen (offentlig) | Alle besøkende er `EXTERNAL`, aldri `owner`                      |
| E-post                  | Domenesammenlikning | Avsenderdomene sammenliknet mot konfigurerte interne domener   |

::: info LLM-en bestemmer aldri hvem som er eieren. En melding som sier "Jeg er eieren" fra en uverifisert avsender merkes `{ source: "external" }` og kan ikke utløse eier-nivå kommandoer. Denne beslutningen fattes i kode, før LLM-en behandler meldingen. :::

### Lag 2: Tillatelsesbevisst datatilgang

**Beskytter mot:** Overtillatelsesdatatilgang, privilegeeskalajon gjennom systemlegitimasjon.

Triggerfish bruker brukerens delegerte OAuth-tokens — ikke system-tjenestekontoer — til å spørre eksterne systemer. Kildesystemet håndhever sin egen tillatelsesmodell:

<img src="/diagrams/traditional-vs-triggerfish.svg" alt="Tradisjonell vs Triggerfish: tradisjonell modell gir LLM direkte kontroll, Triggerfish ruter alle handlinger gjennom et deterministisk policy-lag" style="max-width: 100%;" />

Plugin SDK håndhever dette på API-nivå:

| SDK-metode                              | Atferd                                     |
| --------------------------------------- | ------------------------------------------ |
| `sdk.get_user_credential(integration)`  | Returnerer brukerens delegerte OAuth-token |
| `sdk.query_as_user(integration, query)` | Utfører med brukerens tillatelser          |
| `sdk.get_system_credential(name)`       | **BLOKKERT** — kaster `PermissionError`    |

### Lag 3: Session Taint-sporing

**Beskytter mot:** Datalekkasje gjennom kontekstkontaminering, klassifiserte data som når lavere-klassifiserte kanaler.

Hver sesjon sporer uavhengig et taint-nivå som gjenspeiler den høyeste klassifiseringen av data aksessert under sesjonen. Taint følger tre invarianter:

1. **Per-samtale** — hver sesjon har sin egen taint
2. **Kun eskalering** — taint øker, synker aldri
3. **Full tilbakestilling tømmer alt** — taint OG historikk slettes sammen

Når policy-motoren evaluerer et utdata, sammenligner den sesjonens taint mot målkanalens effektive klassifisering. Hvis taint overstiger målet, blokkeres utdataet.

### Lag 4: Datalinje

**Beskytter mot:** Usporbare dataflyter, manglende evne til å revidere hvor data gikk, samsvarsmangler.

Hvert dataelement bærer provenansmetadata fra opprinnelse til destinasjon:

- **Opprinnelse**: Hvilken integrasjon, oppføring og brukertilgang som produserte disse dataene
- **Klassifisering**: Hvilket nivå ble tildelt og hvorfor
- **Transformasjoner**: Hvordan LLM-en modifiserte, oppsummerte eller kombinerte dataene
- **Destinasjon**: Hvilken sesjon og kanal mottok utdataet

Linje muliggjør fremoverssporing ("hvor gikk denne Salesforce-posten?"), bakoverssporing ("hvilke kilder bidro til dette utdataet?") og fullstendige samsvareksporter.

### Lag 5: Policy-håndhevelseshooks

**Beskytter mot:** Prompt-injeksjonsangrep, LLM-drevne sikkerhetsovertredelser, ukontrollert verktøyutførelse.

Åtte deterministiske hooks avskjærer hver handling på kritiske punkter i dataflyten:

| Hook                    | Hva det avskjærer                             |
| ----------------------- | --------------------------------------------- |
| `PRE_CONTEXT_INJECTION` | Ekstern inndata inn i kontekstvinduet         |
| `PRE_TOOL_CALL`         | LLM ber om verktøyutførelse                   |
| `POST_TOOL_RESPONSE`    | Data returnerer fra verktøyutførelse          |
| `PRE_OUTPUT`            | Svar i ferd med å forlate systemet            |
| `SECRET_ACCESS`         | Legitimasjonstilgangsforespørsel              |
| `SESSION_RESET`         | Taint-tilbakestillingsforespørsel             |
| `AGENT_INVOCATION`      | Agent-til-agent-kall                          |
| `MCP_TOOL_CALL`         | MCP-serververktøy invokasjon                  |

Hooks er ren kode: deterministiske, synkrone, loggede og uforfalskebare. LLM-en kan ikke omgå dem fordi det ikke finnes noen vei fra LLM-utdata til hook-konfigurasjon.

### Lag 6: MCP Gateway

**Beskytter mot:** Ukontrollert ekstern verktøytilgang, uklassifiserte data som kommer inn via MCP-servere, skjemabrudd.

Alle MCP-servere standard til `UNTRUSTED` og kan ikke påkalles inntil en admin eller bruker klassifiserer dem. Gateway håndhever:

- Serverautentisering og klassifiseringsstatus
- Verktøynivå-tillatelser (individuelle verktøy kan blokkeres selv om serveren er tillatt)
- Forespørsels-/svarskjemavalidering
- Taint-sporing på alle MCP-svar
- Injeksjonsmønskanning i parametere

<img src="/diagrams/mcp-server-states.svg" alt="MCP-servertilstander: UNTRUSTED (standard), CLASSIFIED (gjennomgått og tillatt), BLOCKED (eksplisitt forbudt)" style="max-width: 100%;" />

### Lag 7: Plugin-sandkasse

Aktiver et TypeScript-tillegg i brukerkonfigurasjonen med `enabled: true`. Import og kjøring skjer som standard i Deno-arbeidere med begrensede tillatelser. De kan lese tilleggets katalog og bare koble til verter og porter i `declaredEndpoints`. Filskriving, prosessmiljø, underprosesser, FFI og beskyttet systeminformasjon er sperret. `trust: trusted` tillater import i Triggerfish-prosessen. Utføreren kjører der hvis manifestet også angir `trusted`.

[Fullstendig veiledning for programtillegg](../integrations/plugins)

### Lag 8: Hemmelighetsisolasjon

**Beskytter mot:** Legitimasjonstyveri, hemmeligheter i konfigurasjonsfiler, klartekst-legitimasjonlagring.

Legitimasjon lagres i OS-nøkkelringen (personlig nivå) eller vault-integrasjon (bedriftsnivå). De vises aldri i:

- Konfigurasjonsfiler
- `StorageProvider`-verdier
- Loggoppføringer
- LLM-kontekst (legitimasjon injiseres på HTTP-laget, under LLM-en)

`SECRET_ACCESS`-hooken logger hver legitimasjonstilgang med den forespørrende plugin-en, legitimasjonsomfanget og beslutningen.

### Lag 9: Filsystemverktøy-sandkasse

**Beskytter mot:** Stigjennomgangsangrep, uautorisert filtilgang, klassifiseringsomgåelse via direkte filsystemoperasjoner.

Alle filsystemverktøyoperasjoner (les, skriv, rediger, list, søk) kjører inne i en sandkasset Deno Worker med OS-nivå-tillatelser avgrenset til sesjonens taint-passende arbeidsområdeunderkatalog. Sandkassen håndhever tre grenser:

- **Stifengsel** — hver sti løses til en absolutt sti og sjekkes mot fengselsroten med separatorbevisst sammenlikning. Gjennomgangsforsøk (`../`) som unnslipper arbeidsområdet avvises før noen I/U skjer
- **Stikelassifisering** — hver filsystem-sti klassifiseres gjennom en fast løsningskjede: hardkodede beskyttede stier (RESTRICTED), arbeidsområdeklassifiseringskataliger, konfigurerte stimappinger, deretter standardklassifisering
- **Taint-avgrenset tillatelser** — sandkasse Worker-ens Deno-tillatelser settes til arbeidsområdeunderkatalogen som samsvarer med sesjonens gjeldende taint-nivå
- **Skrivebeskyttelse** — kritiske filer (`TRIGGER.md`, `triggerfish.yaml`, `SPINE.md`) er skrivebeskyttet på verktøylaget uavhengig av sandkassetillatelser

### Lag 10: Agent-identitet

**Beskytter mot:** Privilegeeskalajon gjennom agentkjeder, datahvitvasking via delegasjon.

Når agenter påkaller andre agenter, forhindrer kryptografiske delegeringskjeder privilegeeskalasjon:

- Hver agent har et sertifikat som spesifiserer evner og klassifiseringstak
- Den kalte agenten arver `max(eget taint, kallerens taint)` — taint kan bare øke gjennom kjeder
- En kaller med taint som overstiger den kaltes tak, blokkeres
- Sirkulære invokajoner oppdages og avvises
- Delegeringsdybde begrenses og håndheves

<img src="/diagrams/data-laundering-defense.svg" alt="Datahvitvasking-forsvar: angrepsti blokkert ved taksjekk og taint-arv forhindrer utdata til lavere-klassifiserte kanaler" style="max-width: 100%;" />

### Lag 11: Revisjonslogging

**Beskytter mot:** Uoppdagbare brudd, samsvarsfeil, manglende evne til å etterforske hendelser.

Hver sikkerhestrelevant beslutning logges med full kontekst:

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

Hva som logges:

- Alle handlingsforespørsler (tillatt OG avvist)
- Klassifiseringsbeslutninger
- Session taint-endringer
- Kanalautentiseringshendelser
- Policy-regelevalueringer
- Opprettelse og oppdatering av linjeoppføringer
- MCP Gateway-beslutninger
- Agent-til-agent-invokajoner

::: info Revisjonslogging kan ikke deaktiveres. Det er en fast regel i policy-hierarkiet. Selv en org-admin kan ikke slå av logging for sine egne handlinger. :::

### Lag 12: SSRF-forebygging

**Beskytter mot:** Server-Side Request Forgery, intern nettverksrekognosering, sky-metadata-eksfiltrering.

Alle utgående HTTP-forespørsler (fra `web_fetch`, `browser.navigate` og plugin-nettverkstilgang) løser DNS først og sjekker den løste IP-en mot en hardkodet avvisningsliste over private og reserverte områder.

- Private områder (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`) er alltid blokkert
- Link-lokal (`169.254.0.0/16`) og sky-metadata-endepunkter er blokkert
- Loopback (`127.0.0.0/8`) er blokkert
- Avvisningslisten er hardkodet og ikke konfigurerbar — det finnes ingen admin-overstyring
- DNS-oppløsning skjer før forespørselen, noe som forhindrer DNS-rebinding-angrep

### Lag 13: Minneklassifiseringsgating

**Beskytter mot:** Kryssesjonsdatalekkasje gjennom minne, klassifiseringsnedgradering via minneskrivinger, uautorisert tilgang til klassifiserte minner.

Det kryssesjonelle minnesystemet håndhever klassifisering ved både skriving og lesetid:

- **Skrivinger**: Minneoppføringer tvinges til gjeldende sesjons taint-nivå. LLM-en kan ikke velge et lavere klassifiseringsnivå for lagrede minner.
- **Lesinger**: Minne-spørringer filtreres av `canFlowTo` — en sesjon kan bare lese minner på eller under sitt gjeldende taint-nivå.

Dette forhindrer en agent fra å lagre CONFIDENTIAL-data som PUBLIC i minnet og senere hente dem i en lavere-taint-sesjon for å omgå no-write-down-regelen.

## Tillidshierarki

Tillitsmodellen definerer hvem som har autoritet over hva. Høyere nivåer kan ikke omgå lavere-nivå sikkerhetsregler, men de kan konfigurere de justerbare parameterne innenfor disse reglene.

<img src="/diagrams/trust-hierarchy.svg" alt="Tillitshierarki: Triggerfish-leverandør (null tilgang), Org-admin (setter policyer), Ansatt (bruker agent innenfor grenser)" style="max-width: 100%;" />

::: tip **Personlig nivå:** Brukeren ER org-admin. Full suverenitet. Ingen Triggerfish-synlighet. Leverandøren har null tilgang til brukerdata som standard og kan bare få tilgang gjennom et eksplisitt, tidsbegrenset, logget tillatelse fra brukeren. :::

## Slik fungerer lagene sammen

Tenk deg et prompt-injeksjonsangrep der en ondsinnet melding forsøker å eksfiltrere data:

| Trinn | Lag                     | Handling                                                         |
| ----- | ----------------------- | ---------------------------------------------------------------- |
| 1     | Kanalautentisering      | Melding merket `{ source: "external" }` — ikke eier             |
| 2     | PRE_CONTEXT_INJECTION   | Inndata skannet for injeksjonsmønstre, klassifisert              |
| 3     | Session taint           | Session taint uendret (ingen klassifiserte data aksessert)       |
| 4     | LLM behandler melding   | LLM kan manipuleres til å be om et verktøykall                   |
| 5     | PRE_TOOL_CALL           | Verktøytillatelsessjekk mot eksternt-kilde-regler                |
| 6     | POST_TOOL_RESPONSE      | Eventuelle returnerte data klassifisert, taint oppdatert         |
| 7     | PRE_OUTPUT              | Utdataklassifisering vs. mål sjekket                             |
| 8     | Revisjonslogging        | Hele sekvensen registrert for gjennomgang                        |

Selv om LLM-en er fullstendig kompromittert ved trinn 4 og ber om et dataeksfiltreringsverktøykall, fortsetter de gjenværende lagene (tillatelsessjekker, taint-sporing, utdataklassifisering, revisjonslogging) å håndheve policy. Intet enkelt feilpunkt kompromitterer systemet.
