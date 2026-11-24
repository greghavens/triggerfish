---
title: AI Agents Are Exfiltrating Your Private Data. Who's Stopping Them?
date: 2026-03-10
description: Most AI agent platforms enforce security by telling the model what
  not to do. The model can be talked out of it. Here's what the alternative
  looks like.
author: Greg Havens
tags:
  - ai
  - ai agents
  - security
  - open source
  - self-hosted
  - prompt injection
  - data exfiltration
  - agent security
  - openclaw
  - triggerfish
draft: false
---
![](/blog/images/gemini_generated_image_i7ytlui7ytlui7yt.jpg)

AI agents are useful because they can take action. That's the whole point. You give an agent access to your tools, and it can do things: send a message, update a record, search a file, run a query, push a commit. The demos are impressive. The actual deployments, if you look closely at the security model underneath them, are a different story.

The question nobody is asking loudly enough right now is simple. When an AI agent has write access to your database, your email, your calendar, your Salesforce instance, your GitHub repositories, what is stopping it from doing something it shouldn't? The honest answer, in most cases, is a sentence in the system prompt.

That's the situation we're in.

## The problem with telling the model to behave

When you deploy an AI agent today, the standard security practice is to write instructions into the system prompt. Tell the model what it's not allowed to do. Tell it which tools are off-limits. Tell it to ask before taking destructive actions. Some platforms let you configure these instructions through a UI rather than writing them manually, but the underlying mechanism is the same. You're giving the model a rulebook and trusting that it will follow along.

![](/blog/images/gemini_generated_image_jmypkqjmypkqjmyp.jpg)

This approach has a fundamental flaw. Language models don't execute rules. They predict tokens. The distinction matters because a sufficiently well-crafted prompt can shift what the model predicts, and therefore what it does. This is prompt injection. It's not a bug in any particular model. It's a property of how all of these systems work. If an attacker can get their text into the model's context, their instructions compete with yours. The model has no mechanism to identify which instructions came from the trusted system prompt and which came from a malicious document it was asked to summarize. It just sees tokens.

The OpenClaw project, which has grown to nearly 300,000 GitHub stars and is probably the most widely deployed open-source personal agent right now, has this problem in full view. Cisco's security team demonstrated data exfiltration through a third-party skill. The project's own maintainer said publicly that the software is "far too dangerous" for non-technical users. This is not a fringe concern. It's the acknowledged state of the most popular agent platform that exists.

And OpenClaw is not special in this regard. The same architecture, with minor variations, shows up across most of the agent platforms on the market. They vary in how sophisticated their system prompts are. They vary in how many guardrail instructions they include. What they have in common is that all of those instructions live inside the thing they're supposed to be guarding.

## What "outside the model" actually means

The architectural alternative is to move enforcement out of the model's context entirely. Instead of telling the model what it's not allowed to do and hoping it listens, you put a gate between the model and every action it can take. The model produces a request. The gate evaluates that request against a set of rules and decides whether it executes. The model's opinion about whether the action should be allowed is not part of that evaluation.

This sounds obvious when you say it out loud. It's how every other security-sensitive software system works. You don't secure a bank by telling the teller "please don't give money to people who don't have accounts." You put technical controls in place that make unauthorized withdrawals impossible regardless of what the teller is told. The teller's behavior might be influenced by a social engineering attack. The controls aren't, because they don't have a conversation.

In Triggerfish, the enforcement layer works through a set of hooks that run before and after every meaningful operation. Before a tool call executes, the hook checks whether that call is permitted given the current session state. Before output reaches a channel, the hook checks whether the data flowing out is classified at a level appropriate for that channel. Before external data enters the context, the hook classifies it and updates the session's taint level accordingly. These checks are in code. They don't read the conversation. They can't be convinced of anything.

## Session taint and why it matters

Data classification is a well-understood concept in security. Most platforms that claim to handle it assign a classification to a resource and check whether the requesting entity has permission to access it. That's useful as far as it goes. What it misses is what happens after access.

When an AI agent accesses a confidential document, that confidential data is now in its context. It can influence the agent's outputs and reasoning for the rest of the session. Even if the agent moves on to a different task, the confidential context is still there. If the agent then takes an action on a lower-classified channel, writing to a public Slack channel, sending an email to an external address, posting to a webhook, it can carry that confidential data along with it. This is data leakage, and access controls on the original resource did nothing to prevent it.

![](/blog/images/robot-entry.jpg)

Taint tracking is the mechanism that closes this gap. In Triggerfish, every session has a taint level that starts at PUBLIC. The moment the agent touches data at a higher classification level, the session is tainted to that level. Taint only goes up. It never goes down within a session. So if you access a CONFIDENTIAL document and then try to send a message to a PUBLIC channel, the write-down check fires against the tainted session level. The action is blocked not because of anything the model said, but because the system knows what data is in play.

The model has no knowledge of this mechanism. It can't reference it, reason about it, or attempt to manipulate it. The taint level is a fact about the session that lives in the enforcement layer, not in the context.

## Third-party tools are an attack surface

One of the features that makes modern AI agents genuinely useful is their extensibility. You can add tools. You can install plugins. You can connect the agent to external services through the Model Context Protocol. Each integration you add expands what the agent can do. Each integration you add also expands the attack surface.

The threat model here is not hypothetical. If an agent can install third-party skills, and those skills are distributed by unknown parties, and the agent's security model relies entirely on the model respecting instructions in its context, then a malicious skill can exfiltrate data simply by getting itself installed. The skill is inside the trust boundary. The model has no way to distinguish between a legitimate skill and a malicious one if both are present in the context.

In Triggerfish, the MCP Gateway handles all external tool connections. Every MCP server must be classified before it can be invoked. UNTRUSTED servers are blocked by default. When a tool from an external server returns data, that response goes through the POST_TOOL_RESPONSE hook, which classifies the response and updates session taint accordingly. Enable a TypeScript plugin in user configuration with `enabled: true`. Restricted Deno Workers handle import and execution by default. A worker can read the plugin directory and connect to the hosts and ports listed in `declaredEndpoints`. It cannot write files, read the process environment, launch subprocesses, use FFI or access restricted system information. Setting `trust: trusted` in configuration permits host import. The executor runs in the host process if the manifest also declares `trusted`. [Full plugin guide](/integrations/plugins).

The point of all of this is that the security properties of the system don't depend on the plugins being trustworthy. They depend on the sandbox and the enforcement layer, which are not influenced by what the plugins contain.

## The audit problem

If something goes wrong with an AI agent deployment today, how would you know? Most platforms log the conversation. Some log tool calls. Very few log the security decisions made during a session in a way that lets you reconstruct exactly what data flowed where, at what classification level, and whether any policy was violated.

This matters more than it might seem, because the question of whether an AI agent is secure isn't just about preventing attacks in real time. It's about being able to demonstrate, after the fact, that the agent behaved within defined boundaries. For any organization that handles sensitive data, that audit trail is not optional. It's how you prove compliance, respond to incidents, and build trust with the people whose data you're handling.

![](/blog/images/glass.jpg)

Triggerfish maintains full data lineage on every operation. Every piece of data that enters the system carries provenance metadata: where it came from, what classification it was assigned, what transformations it passed through, what session it was bound to. You can trace any output back through the chain of operations that produced it. You can ask which sources contributed to a given response. You can export the complete chain of custody for a regulatory review. This is not a logging system in the traditional sense. It's a provenance system that's maintained as a first-class concern throughout the entire data flow.

## The actual question

The AI agent category is growing fast. The platforms are getting more capable. The use cases are getting more consequential. People are deploying agents with write access to production databases, customer records, financial systems, and internal communication platforms. The assumption underlying most of these deployments is that a well-written system prompt is sufficient security.

It isn't. A system prompt is text. Text can be overridden by other text. If your agent's security model is that the model will follow your instructions, you're relying on behavioral compliance from a system whose behavior is probabilistic and can be influenced by inputs you don't control.

The question worth asking of every agent platform you're considering is where the enforcement actually lives. If the answer is in the model's instructions, that's a meaningful risk that scales with the sensitivity of the data your agent can touch and the sophistication of the people who might try to manipulate it. If the answer is in a layer that runs independently of the model and cannot be reached by any prompt, that's a different situation.

The data in your systems is real. The question of who's stopping the agent from exfiltrating it deserves a real answer.
