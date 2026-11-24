# Plugins

Habilita un plugin de TypeScript en la configuración de usuario con `enabled: true`. Por defecto, la importación y la ejecución se realizan en workers restringidos de Deno. Pueden leer el directorio del plugin y conectarse únicamente a los hosts y puertos de `declaredEndpoints`. No pueden escribir ficheros, leer el entorno del proceso, iniciar subprocesos, usar FFI ni acceder a información restringida del sistema. `trust: trusted` permite importar el módulo en el proceso de Triggerfish. El ejecutor se ejecuta allí si el manifiesto también declara `trusted`.

```yaml
plugins:
  weather:
    enabled: true
    trust: sandboxed
```

[Guía completa de plugins](/integrations/plugins)
