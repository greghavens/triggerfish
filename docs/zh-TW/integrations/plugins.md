# 外掛程式

在使用者設定中以 `enabled: true` 啟用 TypeScript 外掛程式。預設由權限受限的 Deno Worker 匯入及執行。Worker 可以讀取外掛程式目錄，並且只能連線到 `declaredEndpoints` 列出的主機和連接埠。禁止寫入檔案、讀取程序環境、啟動子程序、使用 FFI 或存取受限的系統資訊。設定 `trust: trusted` 允許在 Triggerfish 程序中匯入模組；若資訊清單也宣告 `trusted`，執行器便在該程序中執行。

```yaml
plugins:
  weather:
    enabled: true
    trust: sandboxed
```

[完整外掛程式指南](/integrations/plugins)
