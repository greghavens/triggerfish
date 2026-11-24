---
title: 信任中心
description: Triggerfish 的安全控制、合规状态和架构透明度。
---

# 信任中心

Triggerfish 在 LLM 层之下的确定性代码中执行安全 —— 而非模型可能忽略的提示中。每个策略决策都由不能被提示注入、社会工程或模型不当行为影响的代码做出。完整的技术解释参见[安全优先设计](/zh-CN/security/)页面。

## 安全控制

这些控制在当前版本中活跃。每个都在代码中执行、在 CI 中测试，并在开源仓库中可审计。

| 控制 | 状态 | 描述 |
| ------------------------------ | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| LLM 之下的策略执行 | <StatusBadge status="active" /> | 八个确定性 hook 在 LLM 处理前后拦截每个操作。模型不能绕过、修改或影响安全决策。 |
| 数据分类系统 | <StatusBadge status="active" /> | 四级层次结构（PUBLIC、INTERNAL、CONFIDENTIAL、RESTRICTED），强制禁止降级写入。 |
| 会话 Taint 跟踪 | <StatusBadge status="active" /> | 每个会话跟踪访问的数据的最高分类。Taint 只升级，永不降低。 |
| 不可变审计日志 | <StatusBadge status="active" /> | 所有策略决策以完整上下文记录。审计日志不能被系统的任何组件禁用。 |
| 密钥隔离 | <StatusBadge status="active" /> | 凭证存储在操作系统钥匙串或保管库中。永远不在配置文件、存储、日志或 LLM 上下文中。 |
| Plugin 沙箱 | <StatusBadge status="active" /> | [插件](../integrations/plugins) |
| 依赖扫描 | <StatusBadge status="active" /> | 通过 GitHub Dependabot 自动漏洞扫描。上游 CVE 自动开设 PR。 |
| 开源代码库 | <StatusBadge status="active" /> | 完整安全架构为 Apache 2.0 许可，可公开审计。 |
| 本地部署 | <StatusBadge status="active" /> | 完全在你的基础设施上运行。无云依赖，无遥测，无外部数据处理。 |
| 加密 | <StatusBadge status="active" /> | 所有传输中数据使用 TLS。操作系统级静态加密。可用企业保管库集成。 |
| 负责任的披露计划 | <StatusBadge status="active" /> | 文档化的漏洞报告流程，有明确的响应时间表。参见[披露政策](/zh-CN/security/responsible-disclosure)。 |
| 加固容器镜像 | <StatusBadge status="planned" /> | 基于 Google Distroless 的 Docker 镜像，近零 CVE。CI 中自动 Trivy 扫描。 |

## 纵深防御 —— 13 个独立层

没有单独一层是够用的。如果一层被攻破，其余层继续保护系统。

| 层 | 名称 | 执行方式 |
| ----- | ---------------------------- | ------------------------------------------------- |
| 01 | 渠道认证 | 会话建立时代码验证的身份 |
| 02 | 权限感知的数据访问 | 源系统权限，而非系统凭证 |
| 03 | 会话 Taint 跟踪 | 自动的、强制的、仅升级的 |
| 04 | 数据溯源 | 每个数据元素的完整出处链 |
| 05 | 策略执行 Hook | 确定性的、不可绕过的、有日志记录的 |
| 06 | MCP Gateway | 按工具的权限、服务器分类 |
| 07 | Plugin 沙箱 | [插件](../integrations/plugins) |
| 08 | 密钥隔离 | 操作系统钥匙串或保管库，在 LLM 层之下 |
| 09 | 文件系统工具沙箱 | 路径限制、路径分类、taint 作用域 I/O |
| 10 | 智能体身份与委托 | 加密委托链 |
| 11 | 审计日志 | 不能被禁用 |
| 12 | SSRF 防护 | IP 拒绝列表 + DNS 解析检查 |
| 13 | 记忆分类门控 | 写入自身级别，只能向下读取 |

阅读完整的[纵深防御](/zh-CN/architecture/defense-in-depth)架构文档。

## 为什么 LLM 之下的执行很重要

::: info 大多数 AI 智能体平台通过系统提示执行安全 —— 告诉 LLM "不要分享敏感数据"的指令。提示注入攻击可以覆盖这些指令。

Triggerfish 采用不同的方法：LLM 对安全决策**零权限**。所有执行发生在 LLM 层之下的确定性代码中。从 LLM 输出到安全配置没有通路。 :::

## 合规路线图

Triggerfish 处于预认证阶段。我们的安全态势是架构性的，今天在源代码中可以验证。正式认证在路线图上。

| 认证 | 状态 | 备注 |
| ---------------------------- | -------------------------------- | ----------------------------------------------------------------- |
| SOC 2 Type I | <StatusBadge status="planned" /> | 安全 + 保密性信任服务标准 |
| SOC 2 Type II | <StatusBadge status="planned" /> | 观察期内持续控制有效性 |
| HIPAA BAA | <StatusBadge status="planned" /> | 医疗保健客户的业务伙伴协议 |
| ISO 27001 | <StatusBadge status="planned" /> | 信息安全管理系统 |
| 第三方渗透测试 | <StatusBadge status="planned" /> | 独立安全评估 |
| GDPR 合规 | <StatusBadge status="planned" /> | 自托管架构，可配置的保留和删除 |

## 关于信任的说明

::: tip 安全核心在 Apache 2.0 下开源。你可以阅读策略执行代码的每一行、运行测试套件并自行验证声明。认证在路线图上。 :::

## 审计源代码

完整的 Triggerfish 代码库可在
[github.com/greghavens/triggerfish](https://github.com/greghavens/triggerfish) 获取 —— Apache 2.0 许可。

## 漏洞报告

如果你发现安全漏洞，请通过我们的[负责任的披露政策](/zh-CN/security/responsible-disclosure)报告。不要为安全漏洞开设公开的 GitHub issue。
