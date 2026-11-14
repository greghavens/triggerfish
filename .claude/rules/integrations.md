---
paths:
  - src/integrations/**
  - tests/integrations/**
  - src/mcp/**
  - tests/mcp/**
  - src/plugin/**
  - tests/plugin/**
---

# Integrations, MCP & Plugins

External service integrations, MCP protocol, and plugin sandbox.

## Integrations (`src/integrations/`)

```
src/integrations/
├── google/      # [B1] Google Workspace
│   ├── mod.ts, tools_defs.ts, tools.ts, types.ts (root barrels)
│   ├── auth/      # OAuth2 auth, API client, auth/context types
│   ├── calendar/  # Calendar service, tool defs, executor, types
│   ├── drive/     # Drive service, tool defs, executor, types
│   ├── gmail/     # Gmail service, tool defs, executor, types
│   ├── sheets/    # Sheets service, tool defs, executor, types
│   └── tasks/     # Tasks service, tool defs, executor, types
├── github/      # GitHub
│   ├── mod.ts, auth.ts, types.ts, client.ts, client_http.ts, tools.ts, tools_defs.ts, tools_shared.ts (root)
│   ├── repos/     # Repository operations
│   ├── pulls/     # Pull request operations
│   ├── issues/    # Issue operations
│   └── actions/   # Workflow and code search operations
├── remote/      # Remote access tunnels — Tailscale, WireGuard, cloudflared
└── filesystem/  # Local filesystem MCP server
```

- Integration auth files import `SecretStore` from `../../core/secrets/keychain/keychain.ts`
- Never hardcode integration names in core code — use generic dispatch

## MCP (`src/mcp/`)

- `client/` — MCP protocol client
- `gateway/` — Policy-enforced MCP proxy
- `manager.ts` — MCP server manager, imports `SecretStore` for credential resolution

## Plugin (`src/plugin/`)

Dynamic plugins require explicit user trust and execute in-process. Untrusted
plugin execution is disabled; the legacy evaluation helpers are not a sandbox.
