# HY-HARNESS（日本語）

Windows 10 を第一に考えた自動コーディングエージェントのハーネスです。TypeScript の
制御プレーン（`packages/*`）と Rust の実行デーモン（`crates/hy-exec-server`）が、
改行区切り JSON-RPC 2.0 で話します。デスクトップ GUI と `hy web` は同じ
サーバーと同じ UI を使います。

このファイルは日本語の入口です。詳細・設計・既知の制約は英語の
[README.md](README.md) と [docs/implementation_status.md](docs/implementation_status.md)
にあります。

## ビルドと起動

```powershell
cd F:\HY-HARNESS
cargo build -p hy-exec-server
pnpm build

# ローカルの Ollama（既定 qwen2.5:3b）、コマンドはワークスペース内に限定
node packages\hy-cli\dist\main.js run "README.md を読んで NOTES.md に要約を書いて" `
  --cwd C:\work\my-repo --provider ollama --model qwen2.5:3b `
  --sandbox workspace-write --yes

# オフラインの決定論的デモ
node packages\hy-cli\dist\main.js run "HY_DEMO.md を作って" --cwd C:\work\my-repo --mock --yes

# 検証ゲート付きのループ（claim_complete → 改ざん検査 → Gate 1 → Gate 2）
node packages\hy-cli\dist\main.js ralph "テストを通して" --verify-cmd "npm test" `
  --cwd C:\work\my-repo --provider ollama --model qwen2.5:3b --yes --trust --max-rounds 3
```

GUI:

```powershell
pnpm desktop              # ビルドして Electron を起動
node packages\hy-cli\dist\main.js web --cwd C:\work\my-repo   # ブラウザで同じ UI
```

初回起動では 3 ステップの案内（ワークスペース → サンドボックス → モデル）が出ます。
選んだ内容は `<stateDir>\onboarding.json` に保存され、次回起動時に適用されます。
コマンドラインで `--sandbox` / `--model` を指定した場合はそちらが優先です。

## 主なコマンド

| コマンド | 内容 |
| :-- | :-- |
| `hy run "<依頼>"` | 1 ターン実行（`--json`、`--output-schema`、`--image`） |
| `hy chat` | 対話セッション（`/help` でコマンド一覧） |
| `hy resume <run-id>\|--last` | 実行の続き |
| `hy sessions [--search 語]` | このワークスペースの実行一覧 |
| `hy web [--tailscale] [--tls-cert/--tls-key]` | Web GUI |
| `hy ralph "<目的>" --verify-cmd "<cmd>"` | 検証ゲート付きループ |
| `hy undo <run-id>` / `hy checkpoint prune` | チェックポイントの巻き戻し・整理 |
| `hy sandbox status\|grant\|revoke` | サンドボックスの状態と ACL |
| `hy index status\|rebuild` | セッション全文検索（FTS5）の索引 |
| `hy models list\|discover` | モデルカタログとプロバイダの一覧 |
| `hy update check\|fetch` | Ed25519 署名付きリリースフィードの確認と取得 |
| `hy update keygen\|sign` | リリース鍵の生成と署名 |
| `hy acp` | ACP v1 サーバ（stdio、エディタ連携） |
| `hy serve --sdk` | JSON-RPC SDK サーバ（stdio、TS/Python クライアント用） |
| `hy config dump\|schema` | 解決済み設定（秘密は伏字）と JSON Schema |
| `hy secret set\|list\|remove` | API キーを DPAPI で保存（値は stdin から読む。`roles.*.apiKeySecret` で参照） |

作業モードは GUI の入力欄で「迅速」（既定）と「丁寧」を切り替えられます。迅速は必要な確認を行って早く提出し、丁寧は関連する詳細や失敗経路まで慎重に確認します。対話中は `/work-mode fast` または `/work-mode thorough`、開始時は `hy run` / `hy chat` に `--work-mode fast|thorough` を指定できます。変更は次のターンに反映され、セッション再開時にも復元されます。権限やモデルは変更されません。

## 自動更新

リリースは HTTPS の JSON フィード（`version` / `url` / `sha256` / `signature` /
`notes` / `mandatory`）で配布し、Ed25519 署名を検証します。`hy update keygen` で
鍵を作り、`hy update sign` で公開するエントリを作れます。取得した exe は
`<stateDir>\update\download` に `.sha256` と一緒に置かれ、デスクトップの
「更新を適用」で scheduled task が差し替えます。差し替えは 6 段階の進捗を
`C:\Users\Public\hy-harness-update\update.log` に書き、ハッシュが合わなければ
バックアップを戻して終了コード 5 を返します。**更新は自動では走りません。**

配布物の名前は **`HY-HARNESS.exe` 固定**です（`pnpm desktop:package` →
`release\HY-HARNESS.exe`）。自己更新は「動いている exe を同じパスで置き換える」
方式なので、名前が版ごとに変わると「名前は古いのに中身は新しい」という食い違いが
起きます。版はアプリ内（左上の `Desktop · vX.Y.Z`）、`GET /api/bootstrap`、フィードの
`version` で判断してください。ステージしたビルドは
`release\next\HY-HARNESS-next-<timestamp>.exe` に置かれます。

## GUI の機能（M6 まで）

- チャット: ストリーミング、ツールカード、承認と `ask_user`、ゴール、プランモード、
  実行中ステアリング、ターンキュー、画像添付、`@file` と `@session:<id>` 参照
- セッション: ピン留め・アーカイブ・改名・**名前の自動生成**・**分岐（fork）**・
  ターン一覧（ジャンプ）・**計測（ターン/ステップ、プロバイダ時間、ツール時間、
  最初の応答まで）**
- 協調: Orchestration A+（プランのみのオーケストレーター＋スコープ付きワーカー）、
  バックグラウンドのサブエージェント
- 成果物: 詳細パネル、PDF/画像/Office のプレビュー（LibreOffice がある場合）、
  「フォルダーで表示」、**Open In**（検出済みのエディタ／ターミナル）
- フィードバック: 回答の ✓/✗（7 カテゴリ・任意メモ）。`<stateDir>\feedback.jsonl`
  に保存するだけで、どこにも送信しません
- 外観: ライト／ダーク／**システム追従**、本文・コードのフォント、
  **キーボードショートカットの編集**（端末ごとに保存）、**API キーのマスク表示**
- 端末・ブラウザ・デスクトップ操作・スケジュール／Webhook・永続 PTY

## サンドボックスと既定値

既定は `workspace-write` です（2026-11-05 の CP-01 で変更）。書き込みと、`sandbox.denyRead`（または権限プロファイルの `denyRead`）に挙げたパスの読み取りを閉じ込め、`sandbox.readOnly`（またはプロファイルの `readOnly`）のサブディレクトリは読み取り専用にし、
`read-only` で読み取り専用、`low-integrity` はユーザーポリシー専用です。従来どおり
サンドボックスなしで動かすには `--unsafe-unconfined` を明示します。
ACL のないボリューム（exFAT など）では Codex と同じくボリューム全体が書き込み可能に
なり、その旨が起動時に表示されます。詳細は
[docs/enforcement-gaps.md](docs/enforcement-gaps.md)。

## オプトインの OTel

`config.json` の `telemetry`（または `HY_OTEL_ENDPOINT`）で有効にすると、ローカルの
OTLP コレクタへスパンを送ります。送るのは実行 ID・モデル名・ツール名・成否・
ミリ秒・件数だけで、**メッセージやツール入出力は含まれません**。既定は無効です。

## テスト

```powershell
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:regression
pnpm check:api; pnpm check:protocol; pnpm check:config-schema; pnpm check:version
```

## トラブルシュート・移行

- [docs/troubleshooting.md](docs/troubleshooting.md)（英語）
- [docs/migration.md](docs/migration.md)（英語）
- [docs/dsh-adoption-progress.md](docs/dsh-adoption-progress.md) — DSH 差分の導入状況
- [docs/codex-gap-analysis.md](docs/codex-gap-analysis.md) — OpenAI Codex との比較と不足 119 件
- [docs/codex-adoption-plan.md](docs/codex-adoption-plan.md) — Codex 差分の実装計画（44 WP・約 389 人日。ネットワークを除く今回の対象は約 363 人日）
- [docs/codex-adoption-progress.md](docs/codex-adoption-progress.md) — 実装の進捗（CP-01/06/23/24 完了）
