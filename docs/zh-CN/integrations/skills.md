# 技能平台

技能是 Triggerfish 的主要可扩展性机制。技能是一个包含 `SKILL.md` 文件的文件夹——指令和元数据赋予智能体新能力，而无需编写 plugin 或构建自定义代码。

技能是智能体学习做新事情的方式：检查日历、准备晨间简报、分类 GitHub 问题、起草每周摘要。它们可以从市场安装、手动编写，或由智能体自主创作。

## 什么是技能？

技能是一个根目录下有 `SKILL.md` 文件的文件夹。该文件包含 YAML 前置元数据（metadata）和 Markdown 正文（给智能体的指令）。可选的支持文件——脚本、模板、配置——可以与之一起存放。

```
morning-briefing/
  SKILL.md
  briefing.ts        # 可选的支持代码
  template.md        # 可选的模板
```

`SKILL.md` 前置元数据声明技能做什么、需要什么以及适用的安全约束：

```yaml
---
name: morning-briefing
description: Prepare a daily morning briefing with calendar, email, and weather
version: 1.0.0
category: productivity
tags:
  - calendar
  - email
  - daily
triggers:
  - cron: "0 7 * * *"
metadata:
  triggerfish:
    classification_ceiling: INTERNAL
    requires_tools:
      - browser
      - exec
    network_domains:
      - api.openweathermap.org
      - www.googleapis.com
---

## Instructions

When triggered (daily at 7 AM) or invoked by the user:

1. Fetch today's calendar events from Google Calendar
2. Summarize unread emails from the last 12 hours
3. Get the weather forecast for the user's location
4. Compile a concise briefing and deliver it to the configured channel

Format the briefing with sections for Calendar, Email, and Weather.
Keep it scannable -- bullet points, not paragraphs.
```

### 前置元数据字段

| 字段                                          | 必填 | 描述                                                         |
| --------------------------------------------- | :--: | ------------------------------------------------------------ |
| `name`                                        |  是  | 唯一技能标识符                                               |
| `description`                                 |  是  | 技能功能的可读描述                                           |
| `version`                                     |  是  | 语义版本号                                                   |
| `category`                                    |  否  | 分组类别（productivity、development、communication 等）      |
| `tags`                                        |  否  | 用于发现的可搜索标签                                         |
| `triggers`                                    |  否  | 自动调用规则（定时计划、事件模式）                           |
| `metadata.triggerfish.classification_ceiling`  |  否  | 此技能可达到的最大污染级别（默认：`PUBLIC`）                 |
| `metadata.triggerfish.requires_tools`          |  否  | 技能依赖的工具（browser、exec 等）                           |
| `metadata.triggerfish.network_domains`         |  否  | 技能允许的网络端点                                           |

## 技能类型

Triggerfish 支持三种类型的技能，当名称冲突时有明确的优先级顺序。

### 内置技能

随 Triggerfish 一起在 `skills/bundled/` 目录中发布。由项目维护。始终可用。

Triggerfish 包含十个内置技能，使智能体从第一天起就自给自足：

| 技能                      | 描述                                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **tdd**                   | Deno 2.x 的测试驱动开发方法。红-绿-重构循环，`Deno.test()` 模式，`@std/assert` 用法，Result 类型测试，测试辅助工具。                       |
| **mastering-typescript**  | Deno 和 Triggerfish 的 TypeScript 模式。严格模式，`Result<T, E>`，品牌类型，工厂函数，不可变接口，`mod.ts` 桶文件。                         |
| **skill-builder**         | 如何创作新技能。SKILL.md 格式，前置元数据字段，分级上限，自主创作工作流，安全扫描。                                                        |
| **integration-builder**   | 如何构建 Triggerfish 集成。所有六种模式：渠道适配器、LLM 提供者、MCP 服务器、存储提供者、执行工具和 plugin。                                |
| **git-branch-management** | 开发的 Git 分支工作流。功能分支，原子提交，通过 `gh` CLI 创建 PR，PR 追踪，通过 webhook 的审查反馈循环，合并和清理。                       |
| **deep-research**         | 多步骤研究方法。来源评估，并行搜索，综合和引用格式化。                                                                                     |
| **pdf**                   | PDF 文档处理。文本提取，摘要，从 PDF 文件中提取结构化数据。                                                                                |
| **triggerfish**           | 关于 Triggerfish 内部的自我知识。架构，配置，故障排除和开发模式。                                                                           |
| **triggers**              | 主动行为创作。编写有效的 TRIGGER.md 文件，监控模式和升级规则。                                                                             |

这些是引导技能——智能体使用它们来扩展自己。skill-builder 教智能体如何创建新技能，integration-builder 教它如何构建新的适配器和提供者。

有关创建自己技能的实操指南，请参阅[构建技能](/zh-CN/integrations/building-skills)。

### 托管技能

从 **The Reef**（社区技能市场）安装。下载并存储在 `~/.triggerfish/skills/` 中。

```bash
triggerfish skill install google-cal
triggerfish skill install github-triage
```

### 工作区技能

由用户创建或由智能体在[执行环境](./exec-environment)中创作。存储在智能体工作区的 `~/.triggerfish/workspace/<agent-id>/skills/` 中。

工作区技能具有最高优先级。如果您创建与内置或托管技能同名的技能，您的版本优先。

```
优先级：工作区  >  托管  >  内置
```

::: tip 此优先级顺序意味着您始终可以用自己的版本覆盖内置或市场技能。您的自定义设置永远不会被更新覆盖。 :::

## 技能发现和加载

当智能体启动或技能发生变化时，Triggerfish 运行技能发现流程：

1. **扫描器**——在内置、托管和工作区目录中查找所有已安装的技能
2. **加载器**——读取 SKILL.md 前置元数据并验证元数据
3. **解析器**——使用优先级顺序解决命名冲突
4. **注册**——使技能及其声明的能力和约束对智能体可用

前置元数据中带有 `triggers` 的技能会自动接入调度器。带有 `requires_tools` 的技能会根据智能体的可用工具进行检查——如果所需工具不可用，技能会被标记但不会被阻止。

## 智能体自主创作

一个关键差异化因素：智能体可以编写自己的技能。当被要求做它不知道如何做的事情时，智能体可以使用[执行环境](./exec-environment)创建 `SKILL.md` 和支持代码，然后将其打包为工作区技能。

### 自主创作流程

```
1. 您：   "我需要你每天早上检查我的 Notion 中的新任务"
2. 智能体：在 ~/.triggerfish/workspace/<agent-id>/skills/notion-tasks/ 创建技能
          编写带有元数据和指令的 SKILL.md
          编写支持代码（notion-tasks.ts）
          在执行环境中测试代码
3. 智能体：将技能标记为 PENDING_APPROVAL
4. 您：   收到通知："已创建新技能：notion-tasks。审核并批准？"
5. 您：   批准技能
6. 智能体：将技能连接到每日执行的定时任务
```

::: warning 安全 智能体创作的技能在激活前始终需要所有者批准。智能体不能自行批准自己的技能。这防止智能体创建绕过您监督的能力。 :::

### 企业控制

在企业部署中，对自主创作的技能有额外的控制：

- 智能体创作的技能始终需要所有者或管理员批准
- 技能不能声明高于用户许可级别的分级上限
- 网络端点声明会被审计
- 所有自主创作的技能都记录用于合规审查

## The Reef <ComingSoon :inline="true" />

The Reef 是 Triggerfish 的社区技能市场——一个您可以发现、安装、发布和分享技能的注册表。

| 功能             | 描述                                            |
| ---------------- | ----------------------------------------------- |
| 搜索和浏览       | 按类别、标签或热门度查找技能                    |
| 一键安装         | `triggerfish skill install <name>`              |
| 发布             | 与社区分享您的技能                              |
| 安全扫描         | 在列出前自动扫描恶意模式                        |
| 版本管理         | 技能有版本化和更新管理                          |
| 评论和评分       | 社区对技能质量的反馈                            |

### CLI 命令

```bash
# 搜索技能
triggerfish skill search "calendar"

# 从 The Reef 安装技能
triggerfish skill install google-cal

# 列出已安装的技能
triggerfish skill list

# 更新所有托管技能
triggerfish skill update --all

# 发布技能到 The Reef
triggerfish skill publish

# 移除技能
triggerfish skill remove google-cal
```

### 安全

从 The Reef 安装的技能与任何其他集成一样经历相同的生命周期：

1. 下载到托管技能目录
2. 扫描恶意模式（代码注入、未授权的网络访问等）
3. 进入 `UNTRUSTED` 状态直到您对其分级
4. 由所有者或管理员分级和激活

::: info The Reef 在所有已发布的技能列出前扫描已知的恶意模式。但您仍应在分级前审核技能，特别是声明网络访问或需要 `exec` 或 `browser` 等强大工具的技能。 :::

## 技能安全摘要

- 技能预先声明其安全需求（分级上限、工具、网络域）
- 工具访问受策略门控——`requires_tools: [browser]` 的技能如果浏览器访问被策略阻止则不会工作
- 网络域被执行——技能不能访问它未声明的端点
- 智能体创作的技能需要明确的所有者/管理员批准
- 所有技能调用通过策略钩子并被完整审计
