# Plugins

Aktiviere ein TypeScript-Plugin in der Benutzerkonfiguration mit `enabled: true`. Standardmäßig erfolgen Import und Ausführung in eingeschränkten Deno-Workern. Sie dürfen das Plugin-Verzeichnis lesen und nur die in `declaredEndpoints` angegebenen Hosts und Ports kontaktieren. Schreibzugriff, Prozessumgebung, Unterprozesse, FFI und geschützte Systeminformationen sind gesperrt. `trust: trusted` in der Konfiguration erlaubt den Import im Triggerfish-Prozess. Der Executor läuft dort, wenn auch das Manifest `trusted` angibt.

```yaml
plugins:
  weather:
    enabled: true
    trust: sandboxed
```

[Vollständiger Plugin-Leitfaden](/integrations/plugins)
