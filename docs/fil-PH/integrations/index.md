# Pagbuo ng mga Integration

Dinisenyo ang Triggerfish para ma-extend. Kung gusto mong mag-connect ng bagong
data source, mag-automate ng workflow, bigyan ang iyong agent ng bagong skills,
o mag-react sa external events, may malinaw na integration pathway -- at bawat
pathway ay sumusunod sa parehong security model.

## Mga Integration Pathway

Nag-ooffer ang Triggerfish ng limang natatanging paraan para i-extend ang
platform. Bawat isa ay may iba't ibang layunin, pero lahat ay may parehong
security guarantees: classification enforcement, taint tracking, policy hooks,
at full audit logging.

| Pathway                                              | Layunin                                               | Pinakamainam Para Sa                                                           |
| ---------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------ |
| [MCP Gateway](./mcp-gateway)                         | Mag-connect ng external tool servers                   | Standardized agent-to-tool communication via Model Context Protocol            |
| [Plugin SDK](./plugins)                              | Mag-run ng sandboxed custom code                       | CRUD operations sa external systems, complex data transformations, workflows   |
| [Exec Environment](./exec-environment)               | Ang agent ang nagsusulat at nagru-run ng sariling code | Pagbuo ng integrations, prototyping, testing, at pag-iterate sa feedback loop  |
| [Skills](./skills)                                   | Bigyan ang agent ng bagong capabilities via instructions | Reusable behaviors, community marketplace, agent self-authoring               |
| [Browser Automation](./browser)                      | Kontrolin ang browser instance via CDP                 | Web research, form filling, scraping, automated web workflows                  |
| [Webhooks](./webhooks)                               | Tumanggap ng inbound events mula sa external services  | Real-time reactions sa emails, alerts, CI/CD events, calendar changes          |
| [GitHub](./github)                                   | Full GitHub workflow integration                       | PR review loops, issue triage, branch management via webhooks + exec + skills  |
| [Google Workspace](./google-workspace)               | I-connect ang Gmail, Calendar, Tasks, Drive, Sheets    | Bundled OAuth2 integration na may 14 tools para sa Google Workspace            |
| [Obsidian](./obsidian)                               | Magbasa, magsulat, at maghanap ng Obsidian vault notes | Classification-gated note access na may folder mappings, wikilinks, daily notes |

## Security Model

Bawat integration -- anuman ang pathway -- ay gumagana sa ilalim ng parehong
security constraints.

### Lahat ay Nagsisimula bilang UNTRUSTED

Ang mga bagong MCP servers, plugins, channels, at webhook sources ay
naka-default sa `UNTRUSTED` state. Hindi sila pwedeng mag-exchange ng data sa
agent hanggang hindi sila explicitly na-classify ng owner (personal tier) o
admin (enterprise tier).

```
UNTRUSTED  -->  CLASSIFIED  (pagkatapos ng review, may assigned classification level)
UNTRUSTED  -->  BLOCKED     (explicitly na pinagbawal)
```

### Dumadaan ang Classification

Kapag nag-return ng data ang isang integration, dala ng data na iyon ang
classification level. Ang pag-access ng classified data ay nag-eescalate ng
session taint para pumantay. Kapag na-taint na, hindi na pwedeng mag-output ang
session sa mas mababang-classification na destination. Ito ang
[No Write-Down rule](/security/no-write-down) -- fixed ito at hindi ma-override.

### Ine-enforce ng Policy Hooks sa Bawat Boundary

Lahat ng integration actions ay dumadaan sa deterministic policy hooks:

| Hook                    | Kailan Ito Nag-fire                                                   |
| ----------------------- | --------------------------------------------------------------------- |
| `PRE_CONTEXT_INJECTION` | Pumapasok ang external data sa agent context (webhooks, plugin responses) |
| `PRE_TOOL_CALL`         | Nagre-request ang agent ng tool call (MCP, exec, browser)             |
| `POST_TOOL_RESPONSE`    | Nag-return ng data ang tool (classify response, update taint)         |
| `PRE_OUTPUT`            | Umaalis ang response sa system (final classification check)           |

Ang mga hooks na ito ay pure functions -- walang LLM calls, walang randomness,
walang bypass. Parehong input palagi ang parehong decision.

### Audit Trail

Bawat integration action ay nilo-log: kung ano ang tinawag, sino ang tumawag,
kung ano ang policy decision, at paano nagbago ang session taint. Ang audit
trail na ito ay immutable at available para sa compliance review.

::: warning SECURITY Hindi ma-bypass, ma-modify, o ma-influence ng LLM ang
policy hook decisions. Nare-run ang hooks sa code sa ilalim ng LLM layer. Ang
AI ang nagre-request ng actions -- ang policy layer ang nagde-decide. :::

## Pagpili ng Tamang Pathway

Gamitin ang decision guide na ito para pumili ng integration pathway na
akma sa iyong use case:

- **Gusto mong mag-connect ng standard tool server** -- Gamitin ang
  [MCP Gateway](./mcp-gateway). Kung nagsasalita ng MCP ang isang tool, ito ang
  daan.
- **Kailangan mong mag-run ng custom code laban sa external API** -- Gamitin
  [Kumpletong gabay sa plugin](./plugins).
- **Gusto mong bumuo at mag-iterate ng code ang agent** -- Gamitin ang
  [Exec Environment](./exec-environment). Nakakuha ang agent ng workspace na may
  full write/run/fix loop.
- **Gusto mong turuan ang agent ng bagong behavior** -- Gamitin ang
  [Skills](./skills). Magsulat ng `SKILL.md` na may instructions, o hayaan ang
  agent na magsulat ng sarili niya.
- **Kailangan mong i-automate ang web interactions** -- Gamitin ang
  [Browser Automation](./browser). CDP-controlled Chromium na may domain policy
  enforcement.
- **Kailangan mong mag-react sa external events sa real time** -- Gamitin ang
  [Webhooks](./webhooks). Ang mga inbound events ay verified, classified, at
  niru-route sa agent.

::: tip Ang mga pathways na ito ay hindi mutually exclusive. Pwedeng gumamit ng
browser automation ang isang skill internally. Pwedeng ma-trigger ng webhook ang
isang plugin. Ang isang agent-authored integration sa exec environment ay pwedeng
i-persist bilang skill. Natural silang nagko-compose. :::
