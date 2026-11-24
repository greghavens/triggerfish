# Submission Review Criteria

Reviewers use these criteria when evaluating skill and plugin submissions to
The Reef.

## Required Checks (Must Pass)

### 1. Field Completeness

**Skills** — All required frontmatter fields must be present and valid:

- `name`, `version`, `description`, `author`, `tags`, `category`,
  `classification_ceiling`
- Classification ceiling must be one of: `PUBLIC`, `INTERNAL`, `CONFIDENTIAL`,
  `RESTRICTED`

**Plugins** — All required metadata fields must be present and valid:

- `name`, `version`, `description`, `author`, `classification`, `trust`
- Classification must be one of: `PUBLIC`, `INTERNAL`, `CONFIDENTIAL`,
  `RESTRICTED`
- Trust must be one of: `sandboxed`, `trusted`

### 2. Security Scanner

The submission must pass the security scanner with no critical findings:

- No prompt injection patterns (identity override, instruction bypass, secret
  extraction)
- No obfuscation techniques (base64 decode calls, zero-width characters, shell
  encoding)
- Cumulative heuristic score below threshold

### 3. Correct Directory Structure

Skills:

```
skills/{name}/{version}/SKILL.md
```

Plugins:

```
plugins/{name}/{version}/mod.ts
plugins/{name}/{version}/metadata.json
```

- Name matches the `name` field in frontmatter/metadata
- Version directory matches the `version` field

## Quality Criteria (Reviewer Judgment)

### 4. Classification Appropriateness

- PUBLIC: Only accesses public data, no credentials needed
- INTERNAL: Accesses organization-internal data
- CONFIDENTIAL: Handles sensitive business data
- RESTRICTED: Handles highly sensitive / regulated data

The level should be the **minimum** needed. A weather skill should be PUBLIC. A
skill that reads private repos should be at least INTERNAL.

### 5. Trust Level Appropriateness (Plugins)

- `sandboxed`: The default. Restricted Deno Workers isolate import and execution
  when the user configuration grants sandboxed trust.
- `trusted`: User configuration permits host import. A trusted manifest also
  permits execution with daemon permissions.

### 6. Tool, Domain, and Endpoint Declarations

**Skills:**

- `requires_tools` should list ONLY the tools the skill actually uses
- `network_domains` should list ONLY the domains the skill accesses
- Empty arrays `[]` mean "no access needed" — prefer this over `null`
  (unrestricted)
- Undeclared (`null`) should be rare and well-justified

**Plugins:**

- `declaredEndpoints` should list all external endpoints the plugin calls
- Undeclared endpoints will be blocked by SSRF prevention

### 7. Content Quality

**Skills:**

- Clear, actionable instructions for the agent
- No ambiguous or contradictory directives
- Reasonable scope (not trying to do everything)
- Well-structured markdown

**Plugins:**

- Clean, readable TypeScript
- Exports `manifest`, `toolDefinitions`, and `createExecutor`
- No unnecessary permissions or host access

### 8. Naming

- Descriptive, unique name
- Lowercase with hyphens
- No generic names (`tool`, `helper`, `utility`)
- No Triggerfish-reserved names (`system`, `core`, `admin`)

## Rejection Reasons

- Critical security scanner finding
- Missing required fields
- Classification/trust level too low for declared capabilities
- Overly broad declarations without justification
- Duplicate functionality of an existing submission (suggest contributing to the
  existing one)
- Content that is harmful, misleading, or violates terms of service
