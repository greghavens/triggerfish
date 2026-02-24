---
title: Trust Center
description: Security controls, compliance posture, and architectural transparency for Triggerfish.
---

# Trust Center

Triggerfish enforces security in deterministic code below the LLM layer — not in prompts the model might ignore. Every policy decision is made by code that cannot be influenced by prompt injection, social engineering, or model misbehavior. See the full [Security-First Design](/security/) page for the deep technical explanation.

## Security Controls

These controls are active in the current release. Each is enforced in code, tested in CI, and auditable in the open-source repository.

| Control | Status | Description |
|---------|--------|-------------|
| Sub-LLM Policy Enforcement | <StatusBadge status="active" /> | Eight deterministic hooks intercept every action before and after LLM processing. The model cannot bypass, modify, or influence security decisions. |
| Data Classification System | <StatusBadge status="active" /> | Four-level hierarchy (PUBLIC, INTERNAL, CONFIDENTIAL, RESTRICTED) with mandatory no-write-down enforcement. |
| Session Taint Tracking | <StatusBadge status="active" /> | Every session tracks the highest classification of data accessed. Taint only escalates, never decreases. |
| Immutable Audit Logging | <StatusBadge status="active" /> | All policy decisions logged with full context. Audit logging cannot be disabled by any component of the system. |
| Secrets Isolation | <StatusBadge status="active" /> | Credentials stored in OS keychain or vault. Never in config files, storage, logs, or LLM context. |
| Plugin Sandboxing | <StatusBadge status="active" /> | Third-party plugins run in subprocess isolation. No undeclared network access, no data exfiltration. |
| Dependency Scanning | <StatusBadge status="active" /> | Automated vulnerability scanning via GitHub Dependabot. PRs opened automatically for upstream CVEs. |
| Open Source Codebase | <StatusBadge status="active" /> | Full security architecture is Apache 2.0 licensed and publicly auditable. |
| On-Premises Deployment | <StatusBadge status="active" /> | Runs entirely on your infrastructure. No cloud dependency, no telemetry, no external data processing. |
| Encryption | <StatusBadge status="active" /> | TLS for all data in transit. OS-level encryption at rest. Enterprise vault integration available. |
| Responsible Disclosure Program | <StatusBadge status="active" /> | Documented vulnerability reporting process with defined response timelines. See [disclosure policy](/security/responsible-disclosure). |
| Hardened Container Image | <StatusBadge status="planned" /> | Docker images on Google Distroless base with near-zero CVEs. Automated Trivy scanning in CI. |

## Defense in Depth — 12 Independent Layers

No single layer is sufficient alone. If one layer is compromised, the remaining layers continue to protect the system.

| Layer | Name | Enforcement |
|-------|------|-------------|
| 01 | Channel Authentication | Code-verified identity at session establishment |
| 02 | Permission-Aware Data Access | Source system permissions, not system credentials |
| 03 | Session Taint Tracking | Automatic, mandatory, escalation-only |
| 04 | Data Lineage | Full provenance chain for every data element |
| 05 | Policy Enforcement Hooks | Deterministic, non-bypassable, logged |
| 06 | MCP Gateway | Per-tool permissions, server classification |
| 07 | Plugin Sandbox | Subprocess isolation |
| 08 | Secrets Isolation | OS keychain or vault, below LLM layer |
| 09 | Agent Identity & Delegation | Cryptographic delegation chains |
| 10 | Audit Logging | Cannot be disabled |
| 11 | SSRF Prevention | IP denylist + DNS resolution checks |
| 12 | Memory Classification Gating | Write at own level, read down only |

Read the full [Defense in Depth](/architecture/defense-in-depth) architecture documentation.

## Why Sub-LLM Enforcement Matters

::: info
Most AI agent platforms enforce security through system prompts — instructions to the LLM saying "do not share sensitive data." Prompt injection attacks can override these instructions.

Triggerfish takes a different approach: the LLM has **zero authority** over security decisions. All enforcement happens in deterministic code below the LLM layer. There is no pathway from LLM output to security configuration.
:::

## Compliance Roadmap

Triggerfish is pre-certification. Our security posture is architectural and verifiable in source code today. Formal certifications are on the roadmap.

| Certification | Status | Notes |
|--------------|--------|-------|
| SOC 2 Type I | <StatusBadge status="planned" /> | Security + Confidentiality trust services criteria |
| SOC 2 Type II | <StatusBadge status="planned" /> | Sustained control effectiveness over observation period |
| HIPAA BAA | <StatusBadge status="planned" /> | Business associate agreement for healthcare customers |
| ISO 27001 | <StatusBadge status="planned" /> | Information security management system |
| Third-Party Penetration Test | <StatusBadge status="planned" /> | Independent security assessment |
| GDPR Compliance | <StatusBadge status="planned" /> | Self-hosted architecture with configurable retention and deletion |

## A Note on Trust

::: tip
We believe security trust should be earned through verifiable architecture, not purchased through certification alone. Our entire security core is open source under Apache 2.0 — you can read every line of policy enforcement code, run the test suite, and verify our claims yourself.

Certifications are on the roadmap, but even before they arrive, you have something most vendors will never offer: the ability to audit the code that protects your data.
:::

## Audit the Source

The full Triggerfish codebase is available at [github.com/greghavens/triggerfish](https://github.com/greghavens/triggerfish) — Apache 2.0 licensed.

## Vulnerability Reporting

If you discover a security vulnerability, please report it through our [Responsible Disclosure Policy](/security/responsible-disclosure). Do not open public GitHub issues for security vulnerabilities.
