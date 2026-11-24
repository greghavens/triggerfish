# Plugins

Triggerfish plugins extend the agent with custom tools. A plugin is a TypeScript
module that exports a manifest, tool definitions, and an executor function. The
agent can build plugins itself, scan them for security issues, and load them at
runtime after the user explicitly enables the plugin in configuration.

## How Plugins Work

A plugin lives in a directory with a `mod.ts` entry point:

```
~/.triggerfish/plugins/my-plugin/
  mod.ts    # exports: manifest, toolDefinitions, createExecutor
```

When loaded, the plugin's tools become available to the agent as
`plugin_<name>_<toolName>`. Classification, taint, and policy hooks apply
exactly as they do to built-in tools -- plugins are just another tool source in
the dispatch chain.

## Writing a Plugin

A minimal plugin that queries a REST API:

```typescript
export const manifest = {
  name: "weather",
  version: "1.0.0",
  description: "Weather forecast lookups",
  classification: "PUBLIC" as const,
  trust: "sandboxed" as const,
  declaredEndpoints: ["https://api.weather.com"],
};

export const toolDefinitions = [
  {
    name: "forecast",
    description: "Get the weather forecast for a city.",
    parameters: {
      city: {
        type: "string",
        description: "City name",
        required: true,
      },
    },
  },
];

export const systemPrompt = "Use `forecast` to look up weather for any city.";

export function createExecutor(context) {
  return async (name, input) => {
    if (name !== "forecast") return null;
    const city = input.city;
    context.log.info("Fetching forecast", { city });
    const resp = await fetch(
      `https://api.weather.com/v1/forecast?city=${encodeURIComponent(city)}`,
    );
    return await resp.text();
  };
}
```

### Required Exports

| Export            | Type                                | Description                                       |
| ----------------- | ----------------------------------- | ------------------------------------------------- |
| `manifest`        | `PluginManifest`                    | Plugin identity, classification, trust, endpoints |
| `toolDefinitions` | `ToolDefinition[]`                  | Tools the plugin provides                         |
| `createExecutor`  | `(context) => (name, input) => ...` | Factory that returns the tool handler             |
| `systemPrompt`    | `string` (optional)                 | Injected into the agent system prompt             |

### Manifest Fields

| Field               | Type       | Description                                                         |
| ------------------- | ---------- | ------------------------------------------------------------------- |
| `name`              | `string`   | Must match directory name. Lowercase + hyphens only                 |
| `version`           | `string`   | Semantic version (e.g. `"1.0.0"`)                                   |
| `description`       | `string`   | Human-readable description                                          |
| `classification`    | `string`   | `"PUBLIC"`, `"INTERNAL"`, `"CONFIDENTIAL"`, or `"RESTRICTED"`       |
| `trust`             | `string`   | `"sandboxed"` or `"trusted"`                                   |
| `declaredEndpoints` | `string[]` | Allowed network hosts and ports for a sandboxed worker |

### The Executor Function

`createExecutor(context)` receives a `PluginContext` with:

- `pluginName` -- the plugin's name
- `getSessionTaint()` -- current session classification level
- `escalateTaint(level)` -- compatibility method. The gateway applies taint
  escalation using the registered tool classification.
- `log` -- structured logger scoped to the plugin (`debug`, `info`, `warn`,
  `error`)
- `config` -- plugin-specific config from `triggerfish.yaml`

The returned function takes `(name: string, input: Record<string, unknown>)` and
returns `string | null`. Return `null` for unrecognized tool names.

## Agent Build and Load Flow

The agent can write and scan plugin code. Activation requires the user to review
it, place it at `~/.triggerfish/plugins/<name>/mod.ts`, and explicitly configure
`enabled: true` for that name. Trust defaults to `sandboxed`. `config_manage` cannot grant
plugin execution permissions. An optional `plugin_install` path must match that
plugin's named directory.

The agent can then call `plugin_install({ name: "my-plugin" })` and use the
namespaced tools. `plugin_reload` rechecks the scan and execution grant.
`plugin_scan` inspects code without executing it; `plugin_list` lists active
plugins. Install, reload, and scan tools require RESTRICTED classification.

A scan is a heuristic check. It does not isolate code or prove a plugin safe.

## Security Scanning

Every plugin is scanned for dangerous patterns before loading. The scanner runs
at **startup** (for pre-configured plugins) and at **runtime** (on every
`plugin_install` and `plugin_reload`).

### What Gets Scanned

The scanner checks all `.ts` files in the plugin directory for:

| Category           | Examples                              | Severity |
| ------------------ | ------------------------------------- | -------- |
| Code execution     | `eval()`, `new Function()`, `atob`    | Critical |
| Prompt injection   | "ignore previous instructions"        | Critical |
| Subprocess access  | `Deno.command`, `Deno.run`            | Critical |
| Steganography      | Zero-width Unicode characters         | Critical |
| Network listeners  | `Deno.listen`, `Deno.serve`           | Critical |
| Environment access | `Deno.env.get()`                      | Moderate |
| Filesystem access  | `Deno.readTextFile`, `Deno.writeFile` | Moderate |
| Dynamic imports    | `import("https://...")`               | Moderate |
| Obfuscation        | ROT13 encoding, base64 manipulation   | Moderate |

### Scoring Model

Each pattern has a weight (1--3). A plugin is rejected if:

- Any **critical pattern** (weight >= 3) is detected, OR
- The **cumulative score** reaches the threshold (>= 4)

This means `eval()` alone causes rejection (weight 3, critical), while
`Deno.env` access (weight 2) only fails if combined with another moderate
pattern.

### Pre-Checking with `plugin_scan`

The agent should call `plugin_scan` before `plugin_install` to catch issues:

```
plugin_scan({ path: "/workspace/my-plugin" })
→ { "ok": true, "scannedFiles": ["mod.ts"] }

plugin_scan({ path: "/workspace/bad-plugin" })
→ { "ok": false, "warnings": ["eval() detected in mod.ts:3"], "scannedFiles": ["mod.ts"] }
```

If the scan fails, the agent can fix the code and re-scan before attempting to
load.

## Trust Model

With `trust: sandboxed` in user configuration, or with `trust` omitted,
Triggerfish inspects and runs the plugin in permission-restricted Deno Workers.
The host does not import the plugin. A worker can read its plugin directory.
During execution it can connect only to network destinations allowed by
`declaredEndpoints`. An entry with an effective port limits access to that port.
A hostname without a port allows all ports on that host. Use a bare
`host:port` entry to preserve an explicit port, since URL parsing can drop a
scheme’s default port. URL paths are ignored. With an empty list, the worker
has no runtime network access. Module imports have their own
allowlist for supported public registries. Workers cannot write files, read the
process environment, spawn subprocesses, use FFI, or access restricted system
information. Values explicitly passed through `context.config` are accessible
to the plugin.

Setting `trust: trusted` in user configuration allows the module to be imported
in the Triggerfish process. If the manifest also declares `trusted`, its executor
runs in that process with daemon permissions, including network, filesystem,
and credentials. If the manifest declares `sandboxed`, the executor runs in a
worker, but the initial import has already run in the host. Leave configuration
at `sandboxed` to isolate both import and execution.

## Configuration

Configure each plugin directly in `triggerfish.yaml`:

```yaml
plugins:
  weather:
    enabled: true
    trust: sandboxed
    api_key: secret:weather-api-key
```

The plugin's manifest supplies its tool classification. Plugin-specific settings
are available through `context.config`.

## Tool Namespacing

Tools are automatically prefixed to prevent collisions:

- Plugin tool `forecast` in plugin `weather` becomes `plugin_weather_forecast`
- The executor decodes the prefix (longest-match-first) and delegates to the
  correct plugin with the original tool name

## Classification and Taint

Plugin tools follow the same classification rules as all other tools:

- The manifest's `classification` level is registered for all tools with the
  `plugin_<name>_` prefix
- Session taint escalates when plugin tools return data at a higher level
- Write-down prevention applies: a CONFIDENTIAL plugin cannot have its data flow
  to a PUBLIC channel
- All hook enforcement (PRE_TOOL_CALL, POST_TOOL_RESPONSE) applies unchanged

## The Reef: Plugin Marketplace

Plugins can be published to and installed from The Reef, the same marketplace
used for skills.

### CLI Commands

```bash
triggerfish plugin search "weather"     # Search for plugins
triggerfish plugin install weather      # Install from The Reef
triggerfish plugin update               # Check for updates
triggerfish plugin publish ./my-plugin  # Prepare for publishing
triggerfish plugin scan ./my-plugin     # Security scan
triggerfish plugin list                 # List installed plugins
```

### Install from The Reef

Reef installs are verified with SHA-256 checksums and security-scanned before
activation:

```
1. Fetch catalog.json (cached 1 hour)
2. Find latest version of the plugin
3. Download mod.ts
4. Verify SHA-256 checksum matches catalog entry
5. Write to ~/.triggerfish/plugins/<name>/mod.ts
6. Security scan -- remove if scan fails
7. Record integrity hash in .plugin-hash.json
```

### Publishing

The publish command validates the plugin (manifest, exports, security scan),
computes the SHA-256 checksum, and generates a directory structure ready for
submission to the Reef repository.

## Startup Loading

1. Find named plugin directories containing `mod.ts`.
2. Check that each name is explicitly enabled in user configuration.
3. Scan the permitted code before importing it.
4. Inspect and validate the manifest and exports in the worker by default. An
   explicit trusted configuration permits host import.
5. Create the executor and register its namespaced tools and classifications.

Runtime installation applies the same execution grant and scan requirements.
