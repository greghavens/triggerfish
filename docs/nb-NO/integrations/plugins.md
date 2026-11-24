# Programtillegg

Aktiver et TypeScript-tillegg i brukerkonfigurasjonen med `enabled: true`. Import og kjøring skjer som standard i Deno-arbeidere med begrensede tillatelser. De kan lese tilleggets katalog og bare koble til verter og porter i `declaredEndpoints`. Filskriving, prosessmiljø, underprosesser, FFI og beskyttet systeminformasjon er sperret. `trust: trusted` tillater import i Triggerfish-prosessen. Utføreren kjører der hvis manifestet også angir `trusted`.

```yaml
plugins:
  weather:
    enabled: true
    trust: sandboxed
```

[Fullstendig veiledning for programtillegg](/integrations/plugins)

## Verktøynavngiving

Verktøy prefikses automatisk for å forhindre konflikter:

- Plugin-verktøy `forecast` i plugin `weather` blir `plugin_weather_forecast`
- Executor dekoder prefikset (lengste-samsvar-først) og delegerer til riktig plugin med det opprinnelige verktøynavnet

## Klassifisering og taint

Plugin-verktøy følger de samme klassifiseringsreglene som alle andre verktøy:

- Manifestets `classification`-nivå registreres for alle verktøy med `plugin_<navn>_`-prefikset
- Session taint eskalerer når plugin-verktøy returnerer data på et høyere nivå
- Write-down-forebygging gjelder: en CONFIDENTIAL-plugin kan ikke ha sine data flyte til en PUBLIC-kanal
- All hook-håndhevelse (PRE_TOOL_CALL, POST_TOOL_RESPONSE) gjelder uendret

## The Reef: Plugin-markedsplass

Plugins kan publiseres til og installeres fra The Reef, den samme markedsplassen som brukes for ferdigheter.

### CLI-kommandoer

```bash
triggerfish plugin search "weather"     # Søk etter plugins
triggerfish plugin install weather      # Installer fra The Reef
triggerfish plugin update               # Sjekk for oppdateringer
triggerfish plugin publish ./min-plugin # Forbered for publisering
triggerfish plugin scan ./min-plugin    # Sikkerhetsskann
triggerfish plugin list                 # List installerte plugins
```

### Installer fra The Reef

Reef-installasjoner verifiseres med SHA-256-sjekksummer og sikkerhetsskannes før aktivering:

```
1. Hent catalog.json (bufret 1 time)
2. Finn siste versjon av pluginen
3. Last ned mod.ts
4. Verifiser SHA-256-sjekksummen mot katalogoppføring
5. Skriv til ~/.triggerfish/plugins/<navn>/mod.ts
6. Sikkerhetsskann — fjern hvis skanningen mislykkes
7. Registrer integritets-hash i .plugin-hash.json
```
