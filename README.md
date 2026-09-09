# Company Ops Starter

会社ごとのNotionとLLMで、議事録からのタスク整理と社員稼働レポートを運用するための導入パッケージです。必要な機能だけ選択できます。社内の議事録・社員名・認証情報・元リポジトリの履歴は含みません。

## 導入

実行環境はmacOSまたはLinux、Node.js 24以上、Git、Bash、curl。議事録機能には[Hermes Agent](https://hermes-agent.nousresearch.com/docs/getting-started/installation/)を導入し、`hermes`をPATHに通してください。別会社には専用のOSユーザーまたはVPSを用意します。

1. このprivateリポジトリへのアクセス権を導入担当者へ付与します。
2. 導入先のNotionで[内部インテグレーション](https://www.notion.so/profile/integrations)を作り、読み取り・挿入・更新を許可します。専用の空の親ページを作り、そのページの「接続」からインテグレーションを追加してください。
3. 以下を実行します。

```bash
git clone https://github.com/fukushima-cyber/company-ops-starter.git
cd company-ops-starter
npm ci
npm run setup
npm run doctor
npm run verify:llm
npm run jobs
npm start
```

`setup`が会社名、会議名、担当者、Notion親ページ・トークン、利用機能を質問します。Notionの必要なDBを自動作成し、議事録用LLMはHermesのモデル選択画面で認証まで設定します。トークン入力は非表示です。APIキーの発行、Notionの共有許可、LLMサービスの契約は各社の管理者が行う必要があります。

`doctor`はNotionの列・選択肢・親ページと接続を確認します。`verify:llm`は短いテスト文を設定済みLLMへ送信します（少額のAPI利用料が発生する場合があります）。業務データは送らず、議事録用の診断ではMCP・プラグイン・ルール注入を無効化します。実際の議事録処理は最後の受入テストで確認します。

`jobs`は議事録の定期ジョブを登録します。`start`で初めて常駐実行が始まります。初期状態の配信先はlocalで、Slackなどへ送信しません。レポート機能は起動直後と各実行終了の30分後に未処理分を確認します。終了はCtrl+C。常駐化は[運用ガイド](docs/operations.md)を参照してください。

## LLMと機能

| 機能 | 接続設定 | 出力 |
| --- | --- | --- |
| 議事録 | Hermesの`model`選択画面。対応プロバイダー、OAuth、カスタム接続を各社で選択 | 議事録インボックス、社内タスク、次回MTG準備メモ |
| 稼働レポート | OpenAI互換のChat Completions API、またはAnthropic Messages API。URL・モデル・APIキーを指定 | Notionの社員稼働レポートとダッシュボード |

レポートのOpenAI互換接続は、`/chat/completions`とテキスト応答に対応する必要があります。全サービス・全モデルの互換性を保証するものではありません。APIキーを要求しないローカルサーバーでは非秘密の任意文字列をキー欄に設定してください。HTTPはlocalhostのみ許可します。レポートの集計日は現在JST固定で、議事録は会社のタイムゾーンを利用します。

稼働レポートを使う場合は、[ダッシュボード](https://log.bonkers.llc/)で**導入先専用の組織**を作り、組織IDと管理者用取り込みトークンを設定します。社員PCにはダッシュボードの案内に従って収集エージェントを入れます。このリポジトリにはダッシュボードのホスティング基盤と社員PCエージェントは同梱していません。自社ホストする場合は[mac-activity-report](https://github.com/fukushima-cyber/mac-activity-report)を別途デプロイし、そのURLを指定します。

社員のウィンドウタイトル等が選択したLLMとNotionへ送られます。導入前に収集対象・通知・同意・保管期間・送信先の契約条件を会社側で確認してください。

## 設定変更と引き継ぎ

- `instances/<会社ID>/company.json`: 会社・機能・Notion DB対応表。変更後は`npm run setup -- --config instances/<会社ID>/company.json`。
- `instances/<会社ID>/secrets.json`: 認証情報。Git対象外、ファイル権限600。暗号化保管ではないためOSとディスクも保護してください。
- `instances/<会社ID>/hermes/`: 会社専用のLLM認証・設定・ジョブ・実行履歴。LLM変更は`npm run llm -- --instance <会社ID>`。
- `instances/<会社ID>/workspace/`: 生成された業務手順。再設定で更新されます。共通手順を変更する場合は`templates/`を編集します。

コマンドは直前に設定した会社を使います。複数会社の検証では必ず`--instance`を付けてください。会社ごとのフォルダ分離はOSレベルのアクセス制御ではありません。異なる会社の本番運用を同じOSアカウントで行わないでください。

設定途中で失敗しても、同じ会社IDで再実行できます。作成済みDBのIDと親ページ内の専用DB名を確認して再利用し、同名DBが複数ある場合や別の親ページに属するDBは自動判断せず停止します。既存DBの型・選択肢が違う場合も勝手に書き換えません。会議名を追加した場合は、指摘されたNotionの選択肢を追加して再実行します。

無接続で配線だけ確認する場合は`npm run setup -- --config company.example.json --offline`。これはNotion作成やLLM認証を行いません。非対話の設定投入では`--config`を使い、`NOTION_TOKEN`、`INGEST_API_KEY`、`REPORT_LLM_API_KEY`は秘密情報管理から環境変数へ渡してください。議事録LLMの初回選択は対話式です。

## 受入テスト

まず専用のテスト用Notion親ページで実施してください。

1. 担当者・期限が明記された架空の議事録をインボックスに入れ、ステータスを「未処理」にします。本文にない担当・期日を補っていないか確認します。
2. `npm start`で定期実行し、タスクと準備メモが揃った後だけ「処理済み」になることを確認します。
3. 同じ議事録を再処理し、タスクが重複しないこと、人の修正・承認が保全されることを確認します。LLMが変わったら再評価してください。
4. レポート利用時は架空の社員ログ1日分をテスト組織へ登録し、`npm run report -- YYYY-MM-DD`でNotionとダッシュボードを確認します。

自動テストは`npm test`。Notionの作成・復旧・設定分離と、レポートの分析から保存までをローカルの模擬APIで検証します。議事録の実行主体はLLMなので、手順書だけで厳密なトランザクションや全モデルでの判断一致を保証する設計ではありません。本番業務の受入確認を省略しないでください。

自動タスク削除は`cleanupDays: 0`で無効です。この実行元からの社員生ログ削除も無効です。ダッシュボードなど別システム側の削除設定は別途確認してください。
