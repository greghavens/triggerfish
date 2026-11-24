# Plug-ins

Schakel een TypeScript-plug-in in via `enabled: true` in de gebruikersconfiguratie. Import en uitvoering vinden standaard plaats in Deno-workers met beperkte rechten. Ze kunnen de plug-inmap lezen en alleen verbinding maken met hosts en poorten in `declaredEndpoints`. Schrijftoegang, de procesomgeving, subprocessen, FFI en afgeschermde systeeminformatie zijn geblokkeerd. `trust: trusted` staat import in het Triggerfish-proces toe. De executor draait daar als het manifest ook `trusted` opgeeft.

```yaml
plugins:
  weather:
    enabled: true
    trust: sandboxed
```

[Volledige plug-ingids](/integrations/plugins)
