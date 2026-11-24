---
title: Third-Party Portal Automation
description: How Triggerfish automates interactions with vendor portals, government sites, and payer systems without breaking when the UI changes.
---

# UI-Dependent Automation Against Third-Party Portals

Every enterprise has a list of portals that employees log into manually, every day, to do work that should be automated but isn't. Vendor portals for checking order status. Government sites for filing regulatory submissions. Insurance payer portals for verifying eligibility and checking claim status. State licensing boards for credential verification. Tax authority portals for compliance filings.

These portals don't have APIs. Or they have APIs that are undocumented, rate-limited, or restricted to "preferred partners" who pay for access. The data lives behind a login page, rendered in HTML, and the only way to get it out is to log in and navigate the UI.

Traditional automation uses browser scripts. Selenium, Playwright, or Puppeteer scripts that log in, navigate to the right page, find elements by CSS selector or XPath, extract the data, and log out. These scripts work until they don't. A portal redesign changes the CSS class names. A new CAPTCHA gets added to the login flow. The navigation menu moves from a sidebar to a hamburger menu. A cookie consent banner starts covering the submit button. The script breaks silently, and nobody notices until the downstream process that depends on the data starts producing errors.

State medical boards are a particularly brutal example. There are fifty of them, each with a different website, different layouts, different authentication methods, and different data formats. They redesign on their own schedules with no notice. A credential verification service that relies on scraping these sites might have five or ten of their fifty scripts broken at any given time, each requiring a developer to inspect the new layout and rewrite the selectors.

## How Triggerfish Solves This

Triggerfish's browser automation combines CDP-controlled Chromium with LLM-based visual navigation. The agent sees the page as rendered pixels and accessibility snapshots, not as a DOM tree. It identifies elements by what they look like and what they do, not by their CSS class names. When a portal redesigns, the agent adapts because login forms still look like login forms, navigation menus still look like navigation menus, and data tables still look like data tables.

### Visual Navigation Instead of Selector Scripts

The browser automation tools work through seven operations: navigate, snapshot, click, type, select, scroll, and wait. The agent navigates to a URL, takes a snapshot of the rendered page, reasons about what it sees, and decides what action to take. There is no `evaluate` tool that runs arbitrary JavaScript in the page context. This is a deliberate security decision. The agent interacts with the page the same way a human would, through the UI, and cannot execute code that could be exploited by a malicious page.

When the agent encounters a login form, it identifies the username field, the password field, and the submit button based on visual layout, placeholder text, labels, and page structure. It doesn't need to know that the username field has `id="auth-input-email"` or `class="login-form__email-field"`. When those identifiers change in a redesign, the agent doesn't notice because it never relied on them.

### Shared Domain Security

Browser navigation shares the same domain security configuration as web fetch operations. A single config block in `triggerfish.yaml` defines SSRF denylists, domain allowlists, domain denylists, and domain-to-classification mappings. When the agent navigates to a vendor portal classified at CONFIDENTIAL, the session taint escalates to CONFIDENTIAL automatically, and all subsequent actions in that workflow are subject to CONFIDENTIAL-level restrictions.

The SSRF denylist is hardcoded and non-overridable. Private IP ranges, link-local addresses, and cloud metadata endpoints are always blocked. DNS resolution is checked before the request, preventing DNS rebinding attacks. This matters because browser automation is the highest-risk attack surface in any agent system. A malicious page that tries to redirect the agent to an internal service gets blocked before the request leaves the system.

### Browser Profile Watermarking

Each agent maintains its own browser profile, which accumulates cookies, local storage, and session data as it interacts with portals over time. The profile carries a classification watermark that records the highest classification level at which it has been used. This watermark can only escalate, never decrease.

If an agent uses its browser profile to log into a CONFIDENTIAL vendor portal, the profile is watermarked at CONFIDENTIAL. A subsequent session running at PUBLIC classification cannot use that profile, preventing data leakage through cached credentials, cookies, or session tokens that might contain sensitive information. The profile isolation is per-agent, and watermark enforcement is automatic.

This solves a subtle but important problem in portal automation. Browser profiles accumulate state that reflects the data they've accessed. Without watermarking, a profile that logged into a sensitive portal could leak information through autocomplete suggestions, cached page data, or persistent cookies to a lower-classified session.

### Credential Management

Portal credentials use the configured secret backend and are resolved below the
LLM. Credentials entered into browser pages are exposed to the destination page,
so review the target site and workflow before granting access.

### Resilience to Common Portal Changes

Here's what happens when common portal changes occur:

**Login page redesign.** The agent takes a new snapshot, identifies the updated layout, and finds the form fields by visual context. Unless the portal switched to an entirely different authentication method (SAML, OAuth, hardware token), the login continues working without any configuration change.

**Navigation restructure.** The agent reads the page after login and navigates to the target section based on link text, menu labels, and page headings rather than URL patterns. If the vendor portal moved "Order Status" from the left sidebar to a top navigation dropdown, the agent finds it there.

**New cookie consent banner.** The agent sees the banner, identifies the accept/dismiss button, clicks it, and continues with the original task. This is handled by the LLM's general page understanding, not by a special-purpose cookie handler.

**Added CAPTCHA.** This is where the approach has honest limitations. Simple image CAPTCHAs might be solvable depending on the LLM's vision capabilities, but reCAPTCHA v3 and similar behavioral analysis systems can block automated browsers. The workflow routes these to a human intervention queue rather than failing silently.

**Multi-factor authentication prompts.** If the portal starts requiring MFA that wasn't previously needed, the agent detects the unexpected page, reports the situation through the notification system, and pauses the workflow until a human completes the MFA step. The workflow can be configured to wait for the MFA completion and then resume from where it left off.

### Batch Processing Across Multiple Portals

The workflow engine's `for` loop support means a single workflow can iterate across multiple portal targets. A credential verification service can define a workflow that checks licensure status across all fifty state medical boards in a single batch run. Each portal interaction runs as a separate sub-step with its own browser session, its own classification tracking, and its own error handling. If three of fifty portals fail, the workflow completes the other forty-seven and routes the three failures to a review queue with detailed error context.

## What This Looks Like in Practice

A credentialing organization verifies healthcare provider licenses across state medical boards as part of the provider enrollment process. Traditionally, verification assistants log into each board's website manually, search for the provider, screenshot the license status, and enter the data into the credentialing system. Each verification takes five to fifteen minutes, and the organization processes hundreds per week.

With Triggerfish, a workflow handles the full verification cycle. The workflow receives a batch of providers with their license numbers and target states. For each provider, the browser automation navigates to the relevant state board portal, logs in with stored credentials, searches for the provider, extracts the license status and expiration date, and stores the result. The extracted data gets classified at CONFIDENTIAL because it contains provider PII, and the write-down rules prevent it from being sent to any channel below that classification level.

When a state board redesigns their portal, the agent adapts on the next verification attempt. When a board adds a CAPTCHA that blocks automated access, the workflow flags that state for manual verification and continues processing the rest of the batch. The verification assistants shift from doing all verifications manually to handling only the exceptions that the automation can't resolve.
