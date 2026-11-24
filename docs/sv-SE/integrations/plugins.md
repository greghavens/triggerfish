# Insticksprogram

Aktivera ett TypeScript-insticksprogram i användarkonfigurationen med `enabled: true`. Import och körning sker normalt i Deno-workers med begränsade behörigheter. De kan läsa insticksprogrammets katalog och bara ansluta till värdar och portar i `declaredEndpoints`. Filskrivning, processmiljön, underprocesser, FFI och skyddad systeminformation är spärrade. `trust: trusted` tillåter import i Triggerfish-processen. Exekveraren körs där om manifestet också anger `trusted`.

```yaml
plugins:
  weather:
    enabled: true
    trust: sandboxed
```

[Fullständig guide till insticksprogram](/integrations/plugins)

## Verktygnamnrymd

Verktyg prefixas automatiskt för att förhindra kollisioner:

- Plugin-verktyg `forecast` i plugin `weather` blir `plugin_weather_forecast`
- Exekutören avkodar prefixet (längst-match-först) och delegerar till rätt plugin med det ursprungliga verktygsnamnet

## Klassificering och taint

Plugin-verktyg följer samma klassificeringsregler som alla andra verktyg:

- Manifestets `classification`-nivå registreras för alla verktyg med `plugin_<namn>_`-prefixet
- Sessions-taint eskalerar när pluginverktyg returnerar data på en högre nivå
- Nedskrivningsskydd gäller: ett CONFIDENTIAL-plugin kan inte ha sina data flöda till en PUBLIC-kanal
- All krokstillämpning (PRE_TOOL_CALL, POST_TOOL_RESPONSE) gäller oförändrat

## Revet: Plugin-marknadsplatsen

Plugins kan publiceras till och installeras från Revet, samma marknadsplats som används för kunskaper.

### CLI-kommandon

```bash
triggerfish plugin search "weather"     # Sök efter plugins
triggerfish plugin install weather      # Installera från Revet
triggerfish plugin update               # Kontrollera uppdateringar
triggerfish plugin publish ./mitt-plugin  # Förbered för publicering
triggerfish plugin scan ./mitt-plugin     # Säkerhetsskanning
triggerfish plugin list                 # Lista installerade plugins
```

### Installera från Revet

Revet-installationer verifieras med SHA-256-checksummor och säkerhetsskannas innan aktivering:

```
1. Hämta catalog.json (cachat 1 timme)
2. Hitta senaste versionen av pluginet
3. Ladda ner mod.ts
4. Verifiera SHA-256-checksumman matchar katalogposten
5. Skriv till ~/.triggerfish/plugins/<namn>/mod.ts
6. Säkerhetsskanning — ta bort om skanning misslyckas
7. Registrera integritetshash i .plugin-hash.json
```

### Publicering

Publiceringskommandot validerar pluginet (manifest, exporter, säkerhetsskanning), beräknar SHA-256-checksumman och genererar en katalogstruktur klar för inlämning till Revet-repositoriet.
