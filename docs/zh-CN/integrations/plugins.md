# 插件

在用户配置中设置 `enabled: true` 可启用 TypeScript 插件。默认通过权限受限的 Deno Worker 导入和运行。Worker 可以读取插件目录，并且只能连接 `declaredEndpoints` 中列出的主机和端口。禁止写入文件、读取进程环境、启动子进程、使用 FFI 或访问受限系统信息。配置 `trust: trusted` 允许在 Triggerfish 进程中导入模块。如果清单也声明 `trusted`，执行器就在该进程中运行。

```yaml
plugins:
  weather:
    enabled: true
    trust: sandboxed
```

[完整插件指南](/integrations/plugins)
