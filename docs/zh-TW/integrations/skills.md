# Skills 平台

Skills 是 Triggerfish 的主要擴展機制。一個 skill 是一個包含 `SKILL.md` 檔案的資料夾——為代理提供新能力的指示和 metadata，不需要您撰寫外掛或建構自訂程式碼。

Skills 是代理學習做新事情的方式：檢查您的行事曆、準備早晨簡報、分類 GitHub issue、撰寫每週摘要。它們可以從市場安裝、手動撰寫或由代理自行編寫。

## 什麼是 Skill？

Skill 是一個在根目錄有 `SKILL.md` 檔案的資料夾。該檔案包含 YAML frontmatter（metadata）和 markdown 本文（給代理的指示）。選填的支援檔案——腳本、範本、設定——可以放在旁邊。

```
morning-briefing/
  SKILL.md
  briefing.ts        # 選填的支援程式碼
  template.md        # 選填的範本
```

`SKILL.md` frontmatter 宣告 skill 的功能、需求和安全約束：

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

### Frontmatter 欄位

| 欄位                                          | 必填 | 說明                                                           |
| --------------------------------------------- | :--: | -------------------------------------------------------------- |
| `name`                                        |  是  | 唯一的 skill 識別碼                                            |
| `description`                                 |  是  | 人類可讀的 skill 功能說明                                      |
| `version`                                     |  是  | 語意化版本                                                     |
| `category`                                    |  否  | 分組類別（productivity、development、communication 等）        |
| `tags`                                        |  否  | 可搜尋的標籤，用於探索                                        |
| `triggers`                                    |  否  | 自動呼叫規則（cron 排程、事件模式）                            |
| `metadata.triggerfish.classification_ceiling`  |  否  | 此 skill 可達到的最大汙染等級（預設：`PUBLIC`）                |
| `metadata.triggerfish.requires_tools`          |  否  | skill 依賴的工具（browser、exec 等）                           |
| `metadata.triggerfish.network_domains`         |  否  | skill 允許的網路端點                                           |

## Skill 類型

Triggerfish 支援三種類型的 skills，在名稱衝突時有明確的優先順序。

### 內建 Skills

隨 Triggerfish 一同提供，位於 `skills/bundled/` 目錄。由專案維護。始終可用。

Triggerfish 包含十個內建 skills，使代理從第一天起就能自給自足：

| Skill                     | 說明                                                                                                                                         |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **tdd**                   | Deno 2.x 的測試驅動開發方法論。紅-綠-重構循環、`Deno.test()` 模式、`@std/assert` 使用、Result 類型測試、測試輔助工具。                        |
| **mastering-typescript**  | Deno 和 Triggerfish 的 TypeScript 模式。嚴格模式、`Result<T, E>`、品牌類型、工廠函式、不可變介面、`mod.ts` barrel。                           |
| **skill-builder**         | 如何撰寫新 skills。SKILL.md 格式、frontmatter 欄位、分類上限、自我編寫工作流程、安全掃描。                                                    |
| **integration-builder**   | 如何建構 Triggerfish 整合。六種模式：頻道轉接器、LLM 提供者、MCP 伺服器、儲存提供者、exec 工具和外掛。                                        |
| **git-branch-management** | 開發用的 Git 分支工作流程。功能分支、原子提交、透過 `gh` CLI 建立 PR、PR 追蹤、透過 webhooks 的審查回饋迴圈、合併和清理。                     |
| **deep-research**         | 多步驟研究方法論。來源評估、平行搜尋、綜合和引用格式。                                                                                       |
| **pdf**                   | PDF 文件處理。文字提取、摘要和從 PDF 檔案中結構化資料提取。                                                                                   |
| **triggerfish**           | 關於 Triggerfish 內部的自我知識。架構、設定、疑難排解和開發模式。                                                                              |
| **triggers**              | 主動行為編寫。撰寫有效的 TRIGGER.md 檔案、監控模式和升級規則。                                                                                |

這些是引導 skills——代理使用它們來擴展自己。skill-builder 教代理如何建立新的 skills，integration-builder 教它如何建構新的轉接器和提供者。

請參閱[建構 Skills](/zh-TW/integrations/building-skills)了解建立您自己 skill 的實作指南。

### 受管理的 Skills

從 **The Reef**（社群 skill 市場）安裝。下載並儲存在 `~/.triggerfish/skills/`。

```bash
triggerfish skill install google-cal
triggerfish skill install github-triage
```

### 工作區 Skills

由使用者建立或由代理在 [exec 環境](./exec-environment)中撰寫。儲存在代理的工作區 `~/.triggerfish/workspace/<agent-id>/skills/`。

工作區 skills 擁有最高優先權。如果您建立的 skill 與內建或受管理的 skill 同名，您的版本優先。

```
優先順序：  工作區  >  受管理  >  內建
```

::: tip 此優先順序意味著您可以隨時覆蓋內建或市場的 skill。您的自訂永遠不會被更新覆蓋。 :::

## Skill 探索和載入

當代理啟動或 skills 變更時，Triggerfish 執行 skill 探索流程：

1. **掃描器**——在內建、受管理和工作區目錄中尋找所有已安裝的 skills
2. **載入器**——讀取 SKILL.md frontmatter 並驗證 metadata
3. **解析器**——使用優先順序解析命名衝突
4. **註冊**——使 skills 及其宣告的能力和約束可供代理使用

frontmatter 中有 `triggers` 的 Skills 會自動連接到排程器。有 `requires_tools` 的 Skills 會根據代理可用的工具進行檢查——如果所需工具不可用，skill 會被標記但不會被封鎖。

## 代理自我編寫

一個關鍵差異化因素：代理可以撰寫自己的 skills。當被要求做某些它不知道如何做的事情時，代理可以使用 [exec 環境](./exec-environment)建立 `SKILL.md` 和支援程式碼，然後將其打包為工作區 skill。

### 自我編寫流程

```
1. 您：   「我需要你每天早上檢查我的 Notion 是否有新任務」
2. 代理： 在 ~/.triggerfish/workspace/<agent-id>/skills/notion-tasks/ 建立 skill
          撰寫帶有 metadata 和指示的 SKILL.md
          撰寫支援程式碼（notion-tasks.ts）
          在 exec 環境中測試程式碼
3. 代理： 將 skill 標記為 PENDING_APPROVAL
4. 您：   收到通知：「新 skill 已建立：notion-tasks。審查並核准？」
5. 您：   核准 skill
6. 代理： 將 skill 連接到每日執行的 cron 任務
```

::: warning 安全 代理撰寫的 skills 始終需要擁有者核准才能啟用。代理無法自行核准自己的 skills。這防止代理建立繞過您監督的能力。 :::

### 企業控制

在企業部署中，自行撰寫的 skills 有額外控制：

- 代理撰寫的 skills 始終需要擁有者或管理員核准
- Skills 無法宣告超過使用者許可等級的分類上限
- 網路端點宣告會被稽核
- 所有自行撰寫的 skills 都記錄供合規審查

## The Reef <ComingSoon :inline="true" />

The Reef 是 Triggerfish 的社群 skill 市場——一個讓您探索、安裝、發布和分享 skills 的登錄庫。

| 功能            | 說明                                                 |
| --------------- | ---------------------------------------------------- |
| 搜尋和瀏覽      | 按類別、標籤或熱門度尋找 skills                      |
| 一鍵安裝        | `triggerfish skill install <name>`                   |
| 發布            | 與社群分享您的 skills                                |
| 安全掃描        | 在上架前自動掃描惡意模式                             |
| 版本管理        | Skills 有版本控制和更新管理                          |
| 評價和評分      | 社群對 skill 品質的回饋                              |

### CLI 指令

```bash
# 搜尋 skills
triggerfish skill search "calendar"

# 從 The Reef 安裝 skill
triggerfish skill install google-cal

# 列出已安裝的 skills
triggerfish skill list

# 更新所有受管理的 skills
triggerfish skill update --all

# 發布 skill 到 The Reef
triggerfish skill publish

# 移除 skill
triggerfish skill remove google-cal
```

### 安全

從 The Reef 安裝的 Skills 經歷與任何其他整合相同的生命週期：

1. 下載到受管理的 skills 目錄
2. 掃描惡意模式（程式碼注入、未授權的網路存取等）
3. 以 `UNTRUSTED` 狀態進入，直到您為其分類
4. 由擁有者或管理員分類並啟用

::: info The Reef 在所有已發布的 skills 上架前掃描已知的惡意模式。但是，您仍應在分類前審查 skills，特別是宣告網路存取或需要強大工具（如 `exec` 或 `browser`）的 skills。 :::

## Skill 安全摘要

- Skills 預先宣告其安全需求（分類上限、工具、網路域名）
- 工具存取受策略管控——`requires_tools: [browser]` 的 skill 在瀏覽器存取被策略封鎖時無法運作
- 網路域名被執行——skill 無法存取未宣告的端點
- 代理撰寫的 skills 需要明確的擁有者/管理員核准
- 所有 skill 呼叫都通過策略鉤子並被完整稽核
