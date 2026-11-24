# Contributing to The Reef

The Reef is the skill and plugin marketplace for Triggerfish agents. Submissions
are made as pull requests and validated by CI before merge.

## Submitting a Skill

### 1. Prepare Your Skill

Create a `SKILL.md` file with YAML frontmatter:

```yaml
---
name: my-skill
version: 1.0.0
description: >
  One-line description of what the skill does.
author: your-github-username
tags:
  - relevant
  - tags
category: utilities
classification_ceiling: PUBLIC
requires_tools:
  - web_fetch
network_domains:
  - api.example.com
---

# My Skill

Instructions for the agent go here...
```

### 2. Validate Locally

```bash
triggerfish skill publish path/to/SKILL.md
```

This runs the security scanner and validates all required fields.

### 3. Submit a Pull Request

Create the following directory structure in your fork:

```
skills/
  my-skill/
    1.0.0/
      SKILL.md
```

Open a PR against the `main` branch of `greghavens/reef-registry`.

### 4. CI Validation

The PR pipeline will automatically:

- Parse your SKILL.md frontmatter
- Validate all required fields
- Run the security scanner
- Post results as a PR comment

### 5. Review and Merge

A maintainer will review your skill against the criteria in REVIEW.md. After
merge, the index rebuilds automatically and your skill becomes available via
`triggerfish skill install my-skill`.

## Submitting a Plugin

### 1. Prepare Your Plugin

A plugin submission requires two files:

**`mod.ts`** — The plugin entry point. Must export `manifest`,
`toolDefinitions`, and `createExecutor`.

**`metadata.json`** — Plugin metadata:

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "What the plugin does",
  "author": "your-github-username",
  "classification": "INTERNAL",
  "trust": "sandboxed",
  "tags": ["integration", "api"],
  "declaredEndpoints": ["https://api.example.com"]
}
```

### 2. Validate Locally

```bash
triggerfish plugin publish path/to/plugin-dir
```

This validates the manifest, runs the security scanner, and generates the
submission directory structure.

### 3. Submit a Pull Request

Create the following directory structure in your fork:

```
plugins/
  my-plugin/
    1.0.0/
      mod.ts
      metadata.json
```

Open a PR against the `main` branch of `greghavens/reef-registry`.

### 4. CI Validation

The PR pipeline will automatically:

- Verify mod.ts and metadata.json are present
- Validate all required metadata fields
- Check classification and trust levels
- Run the security scanner
- Post results as a PR comment

### 5. Review and Merge

After review and merge, the plugin index rebuilds automatically and your plugin
becomes available via `triggerfish plugin install my-plugin`.

## Required Skill Frontmatter Fields

| Field                    | Type     | Description                                           |
| ------------------------ | -------- | ----------------------------------------------------- |
| `name`                   | string   | Unique skill identifier (lowercase, hyphens)          |
| `version`                | string   | Semver version (e.g., `1.0.0`)                        |
| `description`            | string   | Brief description                                     |
| `author`                 | string   | Your GitHub username                                  |
| `tags`                   | string[] | Searchable tags                                       |
| `category`               | string   | Skill category                                        |
| `classification_ceiling` | string   | `PUBLIC`, `INTERNAL`, `CONFIDENTIAL`, or `RESTRICTED` |

### Optional Skill Fields

| Field             | Type     | Description                                      |
| ----------------- | -------- | ------------------------------------------------ |
| `requires_tools`  | string[] | Tools the skill needs (null = unrestricted)      |
| `network_domains` | string[] | Domains the skill accesses (null = unrestricted) |

## Required Plugin Metadata Fields

| Field              | Type     | Description                                           |
| ------------------ | -------- | ----------------------------------------------------- |
| `name`             | string   | Unique plugin identifier (lowercase, hyphens)         |
| `version`          | string   | Semver version (e.g., `1.0.0`)                        |
| `description`      | string   | Brief description                                     |
| `author`           | string   | Your GitHub username                                  |
| `classification`   | string   | `PUBLIC`, `INTERNAL`, `CONFIDENTIAL`, or `RESTRICTED` |
| `trust`            | string   | `sandboxed` or `trusted`             |

### Optional Plugin Fields

| Field                | Type     | Description                                       |
| -------------------- | -------- | ------------------------------------------------- |
| `tags`               | string[] | Searchable tags                                   |
| `declaredEndpoints`  | string[] | External endpoints the plugin accesses            |

## Naming Conventions

- Names: lowercase with hyphens (`deep-research`, not `DeepResearch`)
- Version directories match the `version` field in frontmatter/metadata
- One SKILL.md per skill version directory
- One mod.ts + metadata.json per plugin version directory

## Publishing Updates

To publish a new version:

1. Create a new version directory (e.g., `skills/my-skill/1.1.0/` or
   `plugins/my-plugin/1.1.0/`)
2. Update the version field
3. Submit a PR

The catalog includes all versions; clients fetch the latest by default.
