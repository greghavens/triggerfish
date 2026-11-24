# Plugin

Abilita il plugin TypeScript nella configurazione utente con `enabled: true`. Per impostazione predefinita, importazione ed esecuzione avvengono in worker Deno con permessi limitati. Possono leggere la directory del plugin e connettersi solo agli host e alle porte in `declaredEndpoints`. Scrittura, ambiente del processo, sottoprocessi, FFI e informazioni di sistema riservate sono bloccati. `trust: trusted` consente l’importazione nel processo Triggerfish. L’esecutore vi gira se anche il manifesto dichiara `trusted`.

```yaml
plugins:
  weather:
    enabled: true
    trust: sandboxed
```

[Guida completa ai plugin](/integrations/plugins)
