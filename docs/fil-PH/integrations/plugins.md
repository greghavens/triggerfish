# Mga plugin

I-enable ang TypeScript plugin sa configuration ng user gamit ang `enabled: true`. Bilang default, ginagawa ang import at execution sa mga restricted Deno Worker. Nababasá ng worker ang directory ng plugin at nakakonekta lamang sa mga host at port sa `declaredEndpoints`. Bawal ang pagsulat ng file, pagbabasa ng process environment, subprocess, FFI, at restricted system information. Pinapayagan ng `trust: trusted` sa configuration ang import sa proseso ng Triggerfish. Doon tatakbo ang executor kung `trusted` din ang manifest.

```yaml
plugins:
  weather:
    enabled: true
    trust: sandboxed
```

[Kumpletong gabay sa plugin](/integrations/plugins)
