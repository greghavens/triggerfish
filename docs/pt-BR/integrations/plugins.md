# Plugins

Habilite um plugin TypeScript na configuração do usuário com `enabled: true`. Por padrão, a importação e a execução ocorrem em workers Deno com permissões restritas. Eles podem ler a pasta do plugin e se conectar apenas aos hosts e portas de `declaredEndpoints`. Escrita de arquivos, leitura do ambiente do processo, subprocessos, FFI e informações restritas do sistema são bloqueados. `trust: trusted` permite importar o módulo no processo do Triggerfish. O executor roda nesse processo se o manifesto também declarar `trusted`.

```yaml
plugins:
  weather:
    enabled: true
    trust: sandboxed
```

[Guia completo de plugins](/integrations/plugins)
