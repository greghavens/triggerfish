# Extensions

Activez une extension TypeScript dans la configuration utilisateur avec `enabled: true`. Par défaut, son import et son exécution ont lieu dans des workers Deno restreints. Ils peuvent lire le dossier de l’extension et se connecter uniquement aux hôtes et ports de `declaredEndpoints`. Ils ne peuvent ni écrire des fichiers, ni lire l’environnement du processus, ni lancer de sous-processus, ni utiliser la FFI ou des informations système restreintes. `trust: trusted` autorise l’import dans le processus Triggerfish. L’exécuteur s’y exécute si le manifeste déclare aussi `trusted`.

```yaml
plugins:
  weather:
    enabled: true
    trust: sandboxed
```

[Guide complet des extensions](/integrations/plugins)
