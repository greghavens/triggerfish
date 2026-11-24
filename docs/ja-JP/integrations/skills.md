# スキルプラットフォーム

スキルはTriggerfishの主要な拡張メカニズムです。スキルとは、プラグインを書いたりカスタムコードを
構築したりすることなく、エージェントに新しい能力を与える`SKILL.md`ファイルを含むフォルダです。

スキルはエージェントが新しいことを学ぶ方法です：カレンダーを確認する、毎朝のブリーフィングを
準備する、GitHubの課題をトリアージする、週次サマリーを作成する。マーケットプレイスからインストールし、
手書きし、またはエージェント自身が作成できます。

## スキルとは？

スキルはルートに`SKILL.md`ファイルを持つフォルダです。ファイルにはYAMLフロントマター（メタデータ）と
Markdown本文（エージェントへの指示）が含まれます。スクリプト、テンプレート、設定などの
オプションのサポートファイルがその隣に置けます。

```
morning-briefing/
  SKILL.md
  briefing.ts        # オプションのサポートコード
  template.md        # オプションのテンプレート
```

`SKILL.md`のフロントマターは、スキルが何をするか、何が必要か、どのセキュリティ制約が
適用されるかを宣言します：

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

### フロントマターフィールド

| フィールド                                            | 必須 | 説明                                                             |
| ----------------------------------------------------- | :--: | ---------------------------------------------------------------- |
| `name`                                                | はい | 一意のスキル識別子                                               |
| `description`                                         | はい | スキルが何をするかの人間が読める説明                             |
| `version`                                             | はい | セマンティックバージョン                                         |
| `category`                                            | いいえ | グループカテゴリ（productivity、development、communicationなど） |
| `tags`                                                | いいえ | 発見可能な検索タグ                                               |
| `triggers`                                            | いいえ | 自動実行ルール（cronスケジュール、イベントパターン）              |
| `metadata.triggerfish.classification_ceiling`         | いいえ | このスキルが到達できる最大Taintレベル（デフォルト：`PUBLIC`）    |
| `metadata.triggerfish.requires_tools`                 | いいえ | スキルが依存するツール（browser、execなど）                      |
| `metadata.triggerfish.network_domains`                | いいえ | スキルの許可されたネットワークエンドポイント                     |

## スキルの種類

Triggerfishは名前が衝突したときに明確な優先順位を持つ3種類のスキルをサポートします。

### バンドルスキル

`skills/bundled/`ディレクトリでTriggerfishに同梱されています。プロジェクトによってメンテナンスされます。
常に利用可能です。

Triggerfishには初日からエージェントを自立させる10個のバンドルスキルが含まれています：

| スキル                    | 説明                                                                                                                                                                       |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **tdd**                   | Deno 2.xのテスト駆動開発手法。レッド・グリーン・リファクタリングサイクル、`Deno.test()`パターン、`@std/assert`の使用、Resultタイプのテスト、テストヘルパー。               |
| **mastering-typescript**  | DenoとTriggerfishのTypeScriptパターン。厳格モード、`Result<T, E>`、ブランド型、ファクトリー関数、不変インターフェース、`mod.ts`バレル。                                    |
| **skill-builder**         | 新しいスキルの作成方法。SKILL.mdフォーマット、フロントマターフィールド、分類上限、自己作成ワークフロー、セキュリティスキャン。                                              |
| **integration-builder**   | Triggerfishインテグレーションの構築方法。すべての6パターン：チャンネルアダプター、LLMプロバイダー、MCPサーバー、ストレージプロバイダー、execツール、プラグイン。            |
| **git-branch-management** | 開発のためのGitブランチワークフロー。フィーチャーブランチ、アトミックコミット、`gh` CLI経由のPR作成、PR追跡、Webhook経由のレビューフィードバックループ、マージとクリーンアップ。 |
| **deep-research**         | マルチステップリサーチ手法。ソース評価、並列検索、合成、引用フォーマット。                                                                                                 |
| **pdf**                   | PDFドキュメント処理。テキスト抽出、要約、PDFファイルからの構造化データ抽出。                                                                                               |
| **triggerfish**           | Triggerfishの内部についての自己知識。アーキテクチャ、設定、トラブルシューティング、開発パターン。                                                                          |
| **triggers**              | プロアクティブな動作の作成。効果的なTRIGGER.mdファイルの書き方、モニタリングパターン、エスカレーションルール。                                                             |

これらはブートストラップスキルです — エージェントはそれらを使用して自己拡張します。
skill-builderはエージェントに新しいスキルの作成方法を教え、integration-builderは
新しいアダプターとプロバイダーの構築方法を教えます。

独自のスキルを作成するための実践的なガイドについては[スキルの構築](/ja-JP/integrations/building-skills)
を参照してください。

### 管理スキル

**The Reef**（コミュニティスキルマーケットプレイス）からインストールされます。
`~/.triggerfish/skills/`にダウンロードされて保存されます。

```bash
triggerfish skill install google-cal
triggerfish skill install github-triage
```

### ワークスペーススキル

ユーザーが作成するか、[exec環境](./exec-environment)でエージェントが作成します。
エージェントのワークスペース`~/.triggerfish/workspace/<agent-id>/skills/`に保存されます。

ワークスペーススキルは最高の優先度を持ちます。バンドルまたは管理スキルと同じ名前のスキルを
作成すると、あなたのバージョンが優先されます。

```
優先度：  ワークスペース  >  管理  >  バンドル
```

::: tip この優先順序により、バンドルまたはマーケットプレイスのスキルを常に自分のバージョンで
オーバーライドできます。カスタマイズはアップデートによって上書きされることはありません。 :::

## スキルの発見とロード

エージェントが起動したときやスキルが変更されたとき、Triggerfishはスキル発見プロセスを実行します：

1. **スキャナー** — バンドル、管理、ワークスペースのディレクトリをまたいで
   インストール済みのすべてのスキルを見つける
2. **ローダー** — SKILL.mdのフロントマターを読み取り、メタデータを検証する
3. **リゾルバー** — 優先順序を使用して名前の衝突を解決する
4. **登録** — 宣言された能力と制約とともにエージェントがスキルを利用可能にする

フロントマターに`triggers`があるスキルは自動的にスケジューラーに組み込まれます。
`requires_tools`があるスキルはエージェントの利用可能なツールに対してチェックされます —
必要なツールが利用できない場合、スキルにはフラグが立ちますがブロックはされません。

## エージェントによる自己作成

重要な差別化要因：エージェントは自身のスキルを書くことができます。知らないことをするように
求められたとき、エージェントは[exec環境](./exec-environment)を使用して`SKILL.md`と
サポートコードを作成し、ワークスペーススキルとしてパッケージ化できます。

### 自己作成フロー

```
1. あなた:  「毎朝Notionで新しいタスクを確認してほしい」
2. エージェント: ~/.triggerfish/workspace/<agent-id>/skills/notion-tasks/にスキルを作成
             SKILL.mdにメタデータと指示を書く
             サポートコード（notion-tasks.ts）を書く
             exec環境でコードをテスト
3. エージェント: スキルをPENDING_APPROVALとしてマーク
4. あなた:  通知を受け取る：「新しいスキルが作成されました：notion-tasks。レビューして承認しますか？」
5. あなた:  スキルを承認する
6. エージェント: スキルを毎日実行のcronジョブに組み込む
```

::: warning SECURITY エージェントが作成したスキルはアクティブになる前に必ずオーナーの承認が
必要です。エージェントは自分のスキルを自己承認できません。これにより、エージェントが
あなたの監視をバイパスする能力を作成するのを防ぎます。 :::

### エンタープライズコントロール

エンタープライズデプロイメントでは、自己作成スキルに追加のコントロールが適用されます：

- エージェントが作成したスキルは常にオーナーまたは管理者の承認が必要
- スキルはユーザーのクリアランスを超える分類上限を宣言できない
- ネットワークエンドポイントの宣言は監査される
- すべての自己作成スキルはコンプライアンスレビューのためにログ記録される

## The Reef <ComingSoon :inline="true" />

The ReefはTriggerfishのコミュニティスキルマーケットプレイスです — スキルを発見し、インストールし、
公開し、共有できるレジストリです。

| 機能                | 説明                                                     |
| ------------------- | -------------------------------------------------------- |
| 検索と閲覧          | カテゴリ、タグ、または人気でスキルを見つける             |
| ワンコマンドインストール | `triggerfish skill install <name>`                   |
| 公開                | スキルをコミュニティと共有する                           |
| セキュリティスキャン | リスト掲載前の悪意あるパターンの自動スキャン             |
| バージョン管理      | スキルはアップデート管理でバージョン管理される           |
| レビューと評価      | スキルの品質に関するコミュニティフィードバック           |

### CLIコマンド

```bash
# スキルを検索
triggerfish skill search "calendar"

# The Reefからスキルをインストール
triggerfish skill install google-cal

# インストール済みスキルをリスト表示
triggerfish skill list

# すべての管理スキルをアップデート
triggerfish skill update --all

# スキルをThe Reefに公開
triggerfish skill publish

# スキルを削除
triggerfish skill remove google-cal
```

### セキュリティ

The Reefからインストールされたスキルは他のインテグレーションと同じライフサイクルを経ます：

1. 管理スキルディレクトリにダウンロードされる
2. 悪意あるパターンをスキャンされる（コードインジェクション、無許可のネットワークアクセスなど）
3. 分類するまで`UNTRUSTED`状態に入る
4. オーナーまたは管理者によって分類されアクティブ化される

::: info The Reefはリスト掲載前に公開されたすべてのスキルに対して既知の悪意あるパターンをスキャンします。
ただし、特に`exec`や`browser`などの強力なツールが必要であったりネットワークアクセスを宣言している
スキルについては、分類前にレビューしてください。 :::

## スキルのセキュリティサマリー

- スキルはセキュリティ要件を事前に宣言する（分類上限、ツール、ネットワークドメイン）
- ツールアクセスはポリシーによってゲートされる — `requires_tools: [browser]`のスキルは
  ポリシーによってブラウザアクセスがブロックされている場合は動作しない
- ネットワークドメインが強制される — スキルは宣言していないエンドポイントにアクセスできない
- エージェントが作成したスキルは明示的なオーナー/管理者の承認が必要
- すべてのスキル呼び出しはポリシーフックを通過し完全に監査される
