---
title: 信任中心
description: Triggerfish 的安全控制、合規態勢和架構透明度。
---

# 信任中心

Triggerfish 在 LLM 層之下的確定性程式碼中執行安全——不是在模型可能忽略的提示中。每個策略決策都由無法被提示注入、社交工程或模型不當行為影響的程式碼做出。完整的深入技術解釋請參閱[安全優先設計](/zh-TW/security/)頁面。

## 安全控制

這些控制在目前版本中處於活躍狀態。每個都在程式碼中執行、在 CI 中測試，並且在開源倉庫中可稽核。

| 控制                         | 狀態                             | 描述                                                                                                                                        |
| ---------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| LLM 之下策略執行             | <StatusBadge status="active" />  | 八個確定性 hook 在 LLM 處理前後攔截每個操作。模型無法繞過、修改或影響安全決策。                                                              |
| 資料分類系統                 | <StatusBadge status="active" />  | 四等級階層（PUBLIC、INTERNAL、CONFIDENTIAL、RESTRICTED），具有強制性的禁止降級寫入執行。                                                     |
| 工作階段 Taint 追蹤          | <StatusBadge status="active" />  | 每個工作階段追蹤存取的最高資料分類。Taint 只能提升，永不降低。                                                                               |
| 不可變稽核日誌               | <StatusBadge status="active" />  | 所有策略決策以完整上下文記錄。稽核日誌無法被系統的任何元件停用。                                                                             |
| 密鑰隔離                     | <StatusBadge status="active" />  | 憑證儲存在作業系統金鑰鏈或保險庫中。永遠不在設定檔、儲存、日誌或 LLM 上下文中。                                                             |
| Plugin 沙箱                  | <StatusBadge status="active" />  | [外掛程式](../integrations/plugins) |
| 依賴掃描                     | <StatusBadge status="active" />  | 透過 GitHub Dependabot 自動漏洞掃描。上游 CVE 自動開啟 PR。                                                                                 |
| 開源程式碼庫                 | <StatusBadge status="active" />  | 完整安全架構以 Apache 2.0 授權並可公開稽核。                                                                                                |
| 本地部署                     | <StatusBadge status="active" />  | 完全在您的基礎設施上執行。無雲端依賴、無遙測、無外部資料處理。                                                                               |
| 加密                         | <StatusBadge status="active" />  | 所有傳輸中的資料使用 TLS。靜態使用作業系統級加密。企業保險庫整合可用。                                                                       |
| 負責任揭露計畫               | <StatusBadge status="active" />  | 記錄的漏洞報告流程，有定義的回應時程。參閱[揭露政策](/zh-TW/security/responsible-disclosure)。                                               |
| 強化容器映像                 | <StatusBadge status="planned" /> | 基於 Google Distroless 的 Docker 映像，接近零 CVE。CI 中自動 Trivy 掃描。                                                                   |

## 縱深防禦——13 個獨立層

沒有單一層單獨足夠。如果一層被攻破，其餘層繼續保護系統。

| 層   | 名稱                         | 執行                                              |
| ---- | ---------------------------- | ------------------------------------------------- |
| 01   | 通道驗證                     | 工作階段建立時程式碼驗證的身分                    |
| 02   | 權限感知的資料存取           | 來源系統權限，而非系統憑證                        |
| 03   | 工作階段 Taint 追蹤          | 自動的、強制的、僅提升                            |
| 04   | 資料血統                     | 每個資料元素的完整來源鏈                          |
| 05   | 策略執行 Hook                | 確定性的、不可繞過的、有記錄的                    |
| 06   | MCP Gateway                  | 每工具權限、伺服器分類                            |
| 07   | Plugin 沙箱                  | [外掛程式](../integrations/plugins) |
| 08   | 密鑰隔離                     | 作業系統金鑰鏈或保險庫，LLM 層之下               |
| 09   | 檔案系統工具沙箱             | 路徑監獄、路徑分類、taint 範圍的 I/O              |
| 10   | 代理身分與委派               | 加密委派鏈                                        |
| 11   | 稽核日誌                     | 無法停用                                          |
| 12   | SSRF 防護                    | IP 拒絕清單 + DNS 解析檢查                        |
| 13   | 記憶分類閘控                 | 以自己的等級寫入，只能向下讀取                    |

閱讀完整的[縱深防禦](/zh-TW/architecture/defense-in-depth)架構文件。

## 為什麼 LLM 之下執行很重要

::: info 大多數 AI 代理平台透過系統提示執行安全——告訴 LLM「不要分享敏感資料」的指示。提示注入攻擊可以覆寫這些指示。

Triggerfish 採取不同的方法：LLM 對安全決策**沒有任何權限**。所有執行都在 LLM 層之下的確定性程式碼中進行。從 LLM 輸出到安全配置沒有路徑。 :::

## 合規路線圖

Triggerfish 處於認證前階段。我們的安全態勢是架構性的，今天就可以在原始碼中驗證。正式認證在路線圖上。

| 認證                         | 狀態                             | 備註                                                              |
| ---------------------------- | -------------------------------- | ----------------------------------------------------------------- |
| SOC 2 Type I                 | <StatusBadge status="planned" /> | 安全 + 機密性信任服務標準                                         |
| SOC 2 Type II                | <StatusBadge status="planned" /> | 觀察期內持續的控制效能                                            |
| HIPAA BAA                    | <StatusBadge status="planned" /> | 醫療保健客戶的商業夥伴協議                                        |
| ISO 27001                    | <StatusBadge status="planned" /> | 資訊安全管理系統                                                  |
| 第三方滲透測試               | <StatusBadge status="planned" /> | 獨立安全評估                                                      |
| GDPR 合規                    | <StatusBadge status="planned" /> | 具有可配置保留和刪除的自託管架構                                  |

## 關於信任的說明

::: tip 安全核心在 Apache 2.0 下開源。您可以閱讀每一行策略執行程式碼、執行測試套件並自行驗證聲明。認證在路線圖上。 :::

## 稽核原始碼

完整的 Triggerfish 程式碼庫可在
[github.com/greghavens/triggerfish](https://github.com/greghavens/triggerfish) 取得——Apache 2.0 授權。

## 漏洞報告

如果您發現安全漏洞，請透過我們的[負責任揭露政策](/zh-TW/security/responsible-disclosure)報告。請勿為安全漏洞開啟公開的 GitHub issue。
