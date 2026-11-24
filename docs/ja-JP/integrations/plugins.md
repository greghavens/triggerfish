# プラグイン

TypeScript プラグインはユーザー設定で `enabled: true` を指定して有効にします。既定では、権限を制限した Deno Worker でインポートと実行を行います。Worker はプラグインのディレクトリを読めますが、接続先は `declaredEndpoints` のホストとポートに限られます。書き込み、プロセスの環境変数の読み取り、サブプロセスの起動、FFI、制限されたシステム情報へのアクセスは禁止されています。設定が `trust: trusted` の場合は Triggerfish プロセスでインポートされ、マニフェストも `trusted` の場合は実行も同じプロセス内で行われます。

```yaml
plugins:
  weather:
    enabled: true
    trust: sandboxed
```

[プラグインの詳細ガイド](/integrations/plugins)
