---
title: Responsible Disclosure Policy
description: How to report security vulnerabilities in Triggerfish.
---

# Responsible Disclosure Policy

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Report by email:

```
security@trigger.fish
```

Please include:

- Description and potential impact
- Steps to reproduce or proof of concept
- Affected versions or components
- Suggested remediation, if any

## Response Timeline

| Timeline | Action |
|----------|--------|
| 24 hours | Acknowledgment of receipt |
| 72 hours | Initial assessment and severity classification |
| 14 days | Fix developed and tested (critical/high severity) |
| 90 days | Coordinated disclosure window |

We ask that you do not disclose publicly before the 90-day window or before a fix is released, whichever comes first.

## Scope

### In scope

- Triggerfish core application ([github.com/greghavens/triggerfish](https://github.com/greghavens/triggerfish))
- Security policy enforcement bypasses (classification, taint tracking, no-write-down)
- Plugin sandbox escapes
- Authentication or authorization bypasses
- MCP Gateway security boundary violations
- Secrets leakage (credentials appearing in logs, context, or storage)
- Prompt injection attacks that successfully influence deterministic policy decisions
- Official Docker images and install scripts

### Out of scope

- LLM behavior that does not bypass the deterministic policy layer (the model saying something wrong is not a vulnerability if the policy layer correctly blocked the action)
- Third-party skills or plugins not maintained by Triggerfish
- Social engineering attacks against Triggerfish employees
- Denial-of-service attacks
- Automated scanner reports without demonstrated impact

## Safe Harbor

Security research conducted in accordance with this policy is authorized. We will not pursue legal action against researchers who report vulnerabilities in good faith. We ask that you make a good faith effort to avoid privacy violations, data destruction, and disruption of service.

## Recognition

We credit researchers who report valid vulnerabilities in our release notes and security advisories, unless you prefer to remain anonymous. We do not currently offer a paid bug bounty program but may introduce one in the future.

## PGP Key

If you need to encrypt your report, our PGP key for `security@trigger.fish` is published at [`https://trigger.fish/.well-known/security.txt`](https://trigger.fish/.well-known/security.txt) and on major keyservers.
