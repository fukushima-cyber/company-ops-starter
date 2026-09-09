# 運用

## 常駐化

`npm start -- --instance <会社ID>`はフォアグラウンドで起動します。ターミナルを閉じると止まるため、Linuxでは専用OSユーザーのsystemdサービスとして管理してください。次は設定例であり、自動インストールは行いません。Nodeとリポジトリのパスは導入先の絶対パスに置き換えます。

```ini
[Unit]
Description=Company Ops
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/company-ops-starter
ExecStart=/usr/bin/node /opt/company-ops-starter/src/cli.mjs start --instance example-company
Environment=PATH=/usr/local/bin:/usr/bin:/bin
UMask=0077
Restart=on-failure
RestartSec=60
KillMode=control-group
TimeoutStopSec=45

[Install]
WantedBy=default.target
```

ユーザーサービスは`~/.config/systemd/user/company-ops.service`に置き、`systemctl --user daemon-reload`と`systemctl --user enable --now company-ops`で有効化します。ログアウト後も動かすにはOS管理者にlinger設定を依頼してください。`hermes`とNodeの場所は`command -v hermes`、`command -v node`で確認し、PATHも合わせます。macOSではlaunchd等のサービス管理が別途必要です。

停止・障害は`systemctl --user status company-ops`、ログは`journalctl --user -u company-ops`。外部通知は初期状態で無効なので、サービス停止・認証切れ・LLMエラーの通知は導入先の監視基盤に接続してください。黙って動き続けることを保証するものではありません。

## ロック復旧

セットアップ、ジョブ登録、レポート実行は会社単位のロックを使用します。正常終了と通常の例外では解除します。SIGKILL・停電ではロックが残ることがあります。

`instances/<会社ID>/{setup,jobs,report}.lock/owner.json`のPIDと時刻を確認し、同じ会社のサービスと関連するHermes・Bash・Nodeプロセスが**すべて停止したことを確認してから**該当ロックディレクトリを削除します。PIDの不在だけでは子プロセス停止の証明になりません。ロックを定期的に自動削除しないでください。

## 更新・バックアップ

サービス停止後に`git pull --ff-only`、`npm ci`、`npm test`を実行し、設定ファイルを使って`setup`、`doctor`を再実行します。通常、Notionの既存データは消しません。会社を切り替える目的で既存会社の親ページを変更せず、新しい会社IDを作ります。

`instances/`には認証・ジョブ・状態が含まれます。アクセス制限付きの暗号化バックアップを取り、他社へ渡すGitHubに含めないでください。稼働中のディレクトリを別の場所へ移すと絶対パスの再設定が必要です。移動前に停止し、移動後にsetupを実行してください。既存cronジョブのworkdirはHermes側でも確認・更新します。

レポート実装はmac-activity-reportの信頼性改善版を、このリポジトリへ必要ファイルのみ同梱しています。更新時は`report/`の差分とテストを照合します。元リポジトリの`.env`・履歴・インストール用の個人設定をコピーしません。

Notion MCPは`@notionhq/notion-mcp-server@2.5.1`を固定しています。トークン認証で無人運用するための構成です。上流はリモートMCPを優先しているため、依存更新時は接続とデータソース操作を再検証してください。
