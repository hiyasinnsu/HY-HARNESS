# DSH 差分導入 進捗トラッカー

- **計画**: [dsh-adoption-plan.md](dsh-adoption-plan.md)（203 人日、6 マイルストーン、24 WP）
- **更新**: 2026-11-05（**M0〜M6 完了 → v0.4.0**）

## マイルストーン

| MS | 状態 | 完了 WP | 残り |
| :-- | :--- | :--- | :--- |
| M0 ベースライン固定 | **完了** | WP-00, WP-01 | — |
| M1 安全と配備 | **完了（v0.2.0）** | WP-10, WP-11, WP-12 | — |
| M2 協調 | **完了** | WP-20, WP-21, WP-22, WP-23 | — |
| M3 ツールと実行 | **完了** | WP-30, WP-31, WP-32 | — |
| M4 プロバイダと構成 | **完了** | WP-40, WP-41, WP-42, WP-43 | — |
| M5 連携と成果物 | **完了** | WP-50, WP-51, WP-52, WP-53 | — |
| M6 磨き | **完了（v0.4.0）** | WP-60, WP-61, WP-62, WP-63 | — |

## 作業パッケージ

| WP | 状態 | 成果物 | 検証 |
| :-- | :--- | :--- | :--- |
| WP-00 ゴールデン回帰スイート | **完了** | `tests/regression/golden.test.mjs`（K1/K2/K6/K9/K13/K14 の 8 テスト）、`test:regression` | 28 件 PASS |
| WP-01 ADR・計測 | **完了** | `docs/adr/0002-dsh-adoption.md`、`scripts/bench-startup.mjs`、`docs/bench-baseline.md`（起動 204 ms / 1 ターン 515 ms / 7,137 chars） | `pnpm bench:startup` |
| WP-10 TLS / trusted host / public URL / フェンス | **完了** | `https` リスナー、`createHostFence`、`normalizePublicUrl`、`localUrl`、bootstrap `web`、CLI 4 フラグ、TLS フィクスチャ、統合 4 件 | 統合 4 件 PASS |
| WP-11 設定ダンプ・スキーマ | **完了** | `packages/core/src/config-schema.ts`、`hy config dump\|schema`、`docs/config.schema.json`、`check:config-schema`、単体 3 件 | 単体 3 件 PASS |
| WP-12 セッション単位サンドボックスモード | **完了** | `exec/command` と `patch/apply` の `sandboxMode`、デーモンの `effective_sandbox`（policy は narrow のみ、`low-integrity` はユーザーポリシーの escape、unconfined への拡大なし）、未 grant でも `grant_now` できるよう文脈保持、`sandbox/mode` ログ＋再プレイ、`POST /api/sessions/:id/sandbox`（confined 選択時に grant を実行）、GUI のモードチップとモーダル（ja/en/zh）、Rust 単体 4 件＋統合 1 件 | Rust 31 件・統合 1 件 PASS |
| WP-20 セッション形式 v2 | **完了** | `SESSION_FORMAT_VERSION = 2`、`session/format` ヘッダー（`SessionLog` がファイルごとに 1 回だけ書く）、`session-format.ts` の読み取り時移行（v1→v2 は加算的なので identity、未知の未来形式は best-effort）、`tests/fixtures/session-v1.jsonl`（ヘッダーなし＋途中で切れた最終行）、単体 4 件 | 単体 4 件 PASS |
| WP-21 ステアリング | **完了** | `SteerInbox`（`packages/core/src/steering.ts`）、`AgentOptions.steer` をエージェントの各ステップ先頭で drain（`user/steer` をその場でログ）、`Conversation.steer`/`takeUndeliveredSteers`、`POST /api/sessions/:id/steer`（busy でなければ 400＋`hint: turn`）、SSE `entry`（`steering: true`）、GUI の「今すぐ割り込む / ターン後に送る」トグルと割り込みカード（ja/en/zh）、`SpillCompaction` をステップ境界（assistant 区切り）でまとめるよう修正、モックの `steer:` エコー、単体 9 件＋結合 2 件 | 単体 296 件・結合 74 件・回帰 28 件 PASS |
| WP-22 継続サブエージェント | **完了** | `packages/hy-cli/src/agents.ts`（`SubagentRegistry`: `spawn`/`send`/`interrupt`/`close`/`list`、実行中 8 件上限、`replay` で再起動時に `running`→`interrupted`）、`delegate { background: true }` と plugin ツール `list_agents`/`send_message`/`interrupt_agent`、子は `Conversation`（`readOnly`・`delegate: false`・`checkpoints: false`）で履歴を保ちフォローアップ可、`/api/sessions/:id/agents`＋`/agents/:id/{message,interrupt,close}`、GUI のサブエージェントカード（状態・最終回答・追加指示・停止）、SSE `agent/state` と完了通知、単体 5 件＋結合 2 件 | 単体 301 件・結合 76 件・回帰 28 件 PASS |
| WP-23 todo/present | **完了** | `todo_write`（plugin ツール、全置換・`allowParallelInProgress`・`content`/`step` 両対応）、`present`（plugin ツール、ワークスペース内の通常ファイル最大 8 件、サイズ・行数・説明）、`deliverable/presented` ログ、`Conversation` 起動時の plan 復元（再起動後の `/plan` も維持）、GUI の成果物カード（Open / フォルダーで表示）と Diff タブの変更ファイル一覧、`POST /api/sessions/:id/reveal`、単体 4 件＋結合 2 件 | 単体 304 件・結合 78 件・回帰 28 件 PASS |
| WP-30 write/edit/read_image/working_directory | **完了** | `ToolRuntime.writeFile`（apply_patch 経由＝読み取り前編集・writeScope・sandbox を共有）、`editFile`（`old` の一意一致、失敗時は近い行を提示）、`readImage`（PNG/JPEG/WebP/GIF、8 MiB / 8192 px〈2026-11-08拡張〉、`role.vision` で可否判定、バイト列は tool 結果に混ぜずツール結果メッセージへ添付）、`workingDirectory`（`session/cwd` に永続化、`read_file`/`write_file` の相対解決と `shell` の既定 cwd に反映）、4 つの plugin ツール、Rust パッチの「新規ファイルは末尾改行あり」修正、単体 6 件＋結合 3 件 | 単体 310 件・結合 81 件・回帰 28 件 PASS |
| WP-31 永続シェル | **完了** | プロトコル `shell/open\|write\|read\|close`、`crates/hy-exec-server/src/shell.rs`（ReadLine ループ＋`__HY_DONE__<id>:<ok>:<code>` 番兵、stdout/stderr を 1 本のバッファへ、タイムアウトで破棄、Drop で全シェル終了）、`shell` ツールの `persistent`（`--persistent-shell` / `persistentShell.enabled`）、`exec/command` と同じポリシー評価と承認を write 前に実施、confined は `gap` を返して one-shot にフォールバック、単体 2 件（Rust）＋結合 1 件 | Rust 53 件・結合 83 件・回帰 28 件 PASS |
| WP-32 FTS 検索 | **完了** | `packages/core/src/session-index.ts`（`node:sqlite`、`tokenize='trigram'`、`files` のバイトオフセットで差分同期、`sessions` で cwd 絞り込み、`snippet()`、壊れた DB は自動再作成・再構築）、`hy index status\|rebuild`、`hy sessions --search` を FTS に切替（失敗時は従来の線形走査）、`GET /api/search?q=&limit=&cwd=`、plugin ツール `session_query`（`--session-query` / `sessionQuery.enabled`、同一 cwd、自分以外、上位 5 件）、単体 4 件＋結合 1 件 | 単体 314 件・結合 82 件・回帰 28 件 PASS |
| WP-40 Messages/Responses アダプタ | **完了** | `AnthropicProvider`（Messages API、`x-api-key`/`anthropic-version`、role 交互のマージ、画像ブロック、`tool_use`→toolCalls、`thinking`→reasoning、キャッシュ使用量）と `OpenAiResponsesProvider`（`/responses`、`input`/`instructions`、`function_call`→toolCalls、`input_tokens_details.cached_tokens`）、`ProviderKind` に `anthropic` と `openai-responses`、既定 role・API キー env・vision/native 判定・config schema、ローカル HTTP サーバによる契約テスト 4 件 | 単体 318 件・結合 83 件・回帰 28 件 PASS |
| WP-41 モデルカタログ/compat | **完了** | `packages/core/src/model-catalog.ts`（context / max output / pricing / capabilities / compat を持つカタログ、`findModel`・`tokenFieldFor`・`effortWithToolsFor`・`temperatureAllowedFor`・`catalogVision`）、llm.ts の compat 判定をカタログ由来に、`roleSupportsImages` もカタログ優先、`hy models list [--json]`、`hy models discover`（OpenAI `/v1/models`・Anthropic `/v1/models`・Ollama `/api/tags`）、`GET /api/models`（カタログ＋使用中のロール）、単体 7 件＋結合 1 件 | 単体 325 件・結合 84 件・回帰 28 件 PASS |
| WP-42 プロファイル/バンドル | **完了** | `packages/core/src/bundles.ts`（組み込み `core`/`ptc`/`minimal`/`audit`/`orchestrator`/`worker`、`resolveBundles` は積集合で絞るだけ、未知の名前はエラー）、`HarnessConfig.bundles`（名前・許可ツール・プロンプト・パネル・コマンド・ロール既定）、`--bundle`（repeatable）と `--profile` の `bundles` 併用、`ToolRuntime` の bundle 由来エラー文言、プロンプト節の追記、`hy config dump` に解決結果、bootstrap に `bundles`/`bundleCatalog`、単体 8 件＋結合 2 件 | 単体 333 件・結合 86 件・回帰 28 件 PASS |
| WP-43 API 契約 | **完了** | `packages/hy-cli/src/api-contract.ts`（77 ルートの method/path/request/response/errors、`pathMatches`・`matchContract`・`validateRequest`）、`scripts/gen-api-types.mjs` → `web/src/api.gen.ts`（`API_ROUTES`・`apiPath`・`findApiRoute`）、`pnpm gen:api`／`check:api`、`readBody` で全 POST/PUT の型検証（誤型は 400 `invalid request: …`）、クライアントは `apiPath` を使用、ドリフトテスト（web-server.ts のリテラルルートが未宣言なら失敗）＋契約テスト 5 件＋結合 2 件 | 単体 338 件・結合 88 件・回帰 28 件 PASS |
| WP-50 ACP | **完了** | `packages/hy-cli/src/acp.ts`（stdio NDJSON、ACP v1: `initialize`/`authenticate`/`session/new`/`session/load`/`session/prompt`/`session/cancel`/`session/close`、`session/update` に `agent_message_chunk`・`agent_thought_chunk`・`tool_call`/`tool_call_update`、`session/request_permission` はクライアント応答、無ければ `--yes`/full-auto/ポリシー既定）、`hy acp`、台本クライアントの結合テスト（1 ターン＋ツール通知＋キャンセル＋未知メソッド） | 単体 338 件・結合 89 件・回帰 28 件 PASS |
| WP-51 SDK/Python | **完了** | `packages/hy-cli/src/sdk-server.ts`（`hy serve --sdk`、JSON-RPC 2.0 NDJSON: `initialize`／`session.create|resume|prompt|cancel|close`／`shutdown`、通知 `session/event`・`session/status`、プロンプトは非 await でキャンセル可能）、`packages/sdk`（依存なしの TS クライアント `HarnessClient`／`runOnce`）、`python/hy_harness`（stdlib のみ、`Client`・`run()`・CLI）と `python/examples/run.py`、`pip install -e python` を venv で検証、結合 2 件（TS クライアントの prompt/イベント/キャンセル/再開、Python 例） | 結合 91 件・単体 338 件・回帰 28 件 PASS |
| WP-52 文書プレビュー | **完了** | `packages/hy-cli/src/documents.ts`（`previewDocument`・`resolvePreviewPath`・`findSoffice`（`HY_SOFFICE` 上書き可）・SHA-256 キャッシュ `<stateDir>/preview/<hash>.pdf`・`.cmd` シムは `cmd.exe /d /c` の argv 形式）、`GET /api/sessions/:id/document?path=`（`X-HY-Preview-Cached: hit|miss`、`DocumentError` → 400/404/415/422）、`document_preview` プラグインツール、GUI の成果物カードから `window.open`、`packages/hy-cli/prompts/office.md`、単体 4 件・結合 2 件 | 単体 338 件・結合 93 件・回帰 28 件 PASS、`check:api`（78 ルート）一致 |
| WP-53 デスクトップ更新 | **完了** | `packages/hy-cli/src/update-feed.ts`（Ed25519 署名フィード、`hy update check`・`fetch`・`keygen`・`sign`、`GET /api/update`・`POST /api/update/fetch`）、`update.ps1`／`update.mjs`（6 段階の進捗ログ、SHA-256 検証、不一致でロールバック exit 5）、デスクトップの `.sha256` サイドカーと `<stateDir>/update/download` の候補化、`packages/hy-cli/src/onboarding.ts`（`GET /api/onboarding`・`POST /api/onboarding/complete`、`<stateDir>/onboarding.json`）、GUI の 3 ステップウィザードと設定の更新セクション、`packages/core/src/version.ts`＋`pnpm check:version`、更新／オンボーディングの単体 10 件・結合 4 件 | 単体 352 件・結合 97 件・回帰 28 件 PASS、`check:api`（82 ルート）・`check:protocol`・`check:config-schema`・`check:version` 一致 |
| WP-60 磨き（タイトル・統計・fork・参照） | **完了** | `packages/hy-cli/src/session-title-gen.ts`（モデルが名前を提案、20 秒の期限とヒューリスティックのフォールバック、`POST /api/sessions/:id/title/generate`、`ui-state.json` の `generatedTitles`、手動名が優先）、`session-stats.ts`（step-start→step-end の LLM 時間、tool-start→結果のツール時間、最初の応答までの時間、ターンごとの `session/stats` スナップショット、`GET /api/sessions/:id/stats`、詳細パネルに計測セクション）、`session-fork.ts`（1 ランだけを新しい run へコピー、`SessionLog.importEvents`、`POST /api/sessions/:id/fork`、`session/fork` で来歴、`listRuns.forkedFrom`）、`session-reference.ts`（`@session:<id>` を境界付き untrusted 文脈として注入、`projectChat` 由来のダイジェスト、`stripPlanPrefix` が表示から除去）、`GET /api/references`（ファイルと過去チャット、`q=dir/` のドリルダウン）、GUI の `@` メニュー（Sessions/Files）・生成名ボタン・分岐・ターン一覧（アウトライン、ジャンプで点滅） | 単体 375 件・結合 101 件・回帰 28 件 PASS、`check:api`（86 ルート）一致 |
| WP-61 磨き（評価・外観・Open In） | **完了** | `packages/hy-cli/src/feedback.ts`（7 カテゴリ・任意メモ・`<stateDir>/feedback.jsonl`・`POST/GET /api/sessions/:id/feedback`、送信は一切しない）、`packages/hy-cli/src/secret-mask.ts` と web 側の同型モジュール（sk/GitHub/AWS/Slack/Google/Bearer/PEM/代入の 8 種、表示だけマスク、原本は保持、設定でオン/オフ）、`packages/hy-cli/src/open-in.ts`（VS Code・Cursor・Sublime・Notepad++・Explorer・Windows Terminal・PowerShell・Git Bash の検出、許可リストのみ起動、ローカル接続のみ、ワークスペース内のパスのみ、`GET/POST /api/open-in`）、`packages/hy-cli/web/src/shortcuts.ts`（正規化・競合検出・端末別保存・録音 UI、8 アクション）、テーマ `light|dark|system` と本文/コードフォント（`--font`/`--mono`、危険文字は除去）、ロケール辞書の実行時登録（`registerLocaleMessages`・`localeChoices`）、GUI の評価ボタン・`/feedback`・外観セクション・ショートカット編集・Open In セレクト | 単体 394 件（web 6 件含む）・結合 102 件・回帰 28 件 PASS、`check:api`（90 ルート）一致 |
| WP-62 オプトイン OTel | **完了** | `packages/hy-cli/src/telemetry.ts`（OTLP/JSON、`/v1/traces` へ POST、既定 off、ローカルエンドポイントのみ（`allowRemote` で明示可）、`sampleRatio`、キュー上限 500、失敗しても実行を妨げない、レスポンス本文を読み切ってソケットを残さない）、`web-server.ts` が step / tool / turn の span を記録してターン終了時に 1 回 flush、属性は run id・モデル・ツール名・成否・ミリ秒・件数のみ、`telemetry` 設定（`HY_OTEL_ENDPOINT` でも有効化）、結合テストで「既定 off では何も送らない」「span に内容が入らない」を固定 | 単体 401 件・結合 103 件・回帰 28 件 PASS、`check:config-schema` 一致 |
| WP-63 ドキュメント | **完了** | `README.ja.md`（日本語の入口）、`docs/troubleshooting.md`・`docs/migration.md`（英日併記、更新・オンボーディング・フィードバック・OTel まで）、`packages/{core,seams,hy-cli,desktop,sdk}/README.md`（役割・契約・テスト）、ルート README にドキュメント一覧と M2〜M6 の追加機能、i18n キー検査（`web/test/i18n-keys.test.mjs`: バンドル内の `tr('…')` がすべて英語辞書にあり、M5/M6 のキーが ja/zh に訳されている）、`hasTranslation` を追加 | 単体 404 件（web の i18n 3 件を含む）・結合 103 件・回帰 28 件 PASS |

## 設計メモ（WP-12）

- **モードの優先順位**: セッションの要求モードが既定。ポリシー規則は narrow できる。`low-integrity` はユーザーポリシー専用の escape として workspace-write を緩められる（Jest/Vitest の piped worker 用、ADR 0001 §7）。read-only は何によっても広がらず、`unconfined` へはポリシーでも広げられない。
- **grant のタイミング**: 既定 unconfined のセッションが confined モードへ切り替えるとき、その明示的操作を同意として `sandbox/grant` を実行する。失敗時は 409 で理由を返し、暗黙に unconfined で走らせない。
- **永続化**: `sandbox/mode` イベント（`{ mode }`）をセッションログに追記し、`resolveSandboxMode` が最後の値を再プレイする。書き込みは常に現行版。
- **patch の扱い**: read-only ではコントロールプレーンとデーモンの両方で拒否する（従来は patch が workspace-write トークンで書けていた）。

## 設計メモ（WP-21）

- **届くタイミング**: `steer` はエージェントの各ステップの先頭（モデル要求の直前）で drain され、`[the user sent this while you were working]` の印を付けて履歴へ入る。ログ（`user/steer`）もその時点で書くので、ログの順序＝モデルが見た順序になる。`rebuildHistory` は `user/steer` を同じ印で復元するため、再開したセッションの履歴はライブと一致する。
- **間に合わなかった場合**: 最後のステップ境界の後に届いた分は、ターン終了時に `late: true` としてログし、履歴へ畳み込んだうえで `steering message arrived after the last step (n); it will be answered in the next turn` を通知する。メッセージを失わないことを優先し、勝手に次のターンを始めない。
- **API**: 実行中でないセッションへの `POST /steer` は 400（`hint: "turn"`）。GUI はその応答を見て通常の `/turn` にフォールバックする。worker は 403。
- **UI**: 実行中の送信は既定でステア。作曲欄のチップで「ターン後に送る」に切り替えると従来の永続キューに入る。割り込みメッセージはトランスクリプト上で破線＋`steer` バッジで区別する。
- **安全**: ステアは通常のモデル要求に混ざるだけなので、承認・ポリシー・トークン予算・Compaction の扱いは通常メッセージと同じ。

## 設計メモ（WP-22）

- **同期委譲は不変**: `delegate` の既定（`background` なし）は従来どおり使い捨ての子で、履歴も残さない。`background: true` のときだけレジストリに載り、`agentId` を返す。
- **子の作り**: 子は `Conversation`（`readOnly` オプション＝読み取りツールのみ、`delegate: false` で深さ 1、`checkpoints: false` でワークスペースのチェックポイント所有者を親 1 つに保つ）。会話履歴は子の runId（`<parent>.subN`）のログから復元されるため、フォローアップも再起動後も同じ文脈で続く。
- **メッセージ**: 実行中の子への `send_message` は WP-21 のステアとして次のステップ境界に届く。idle/interrupted なら新しいターンを始める。
- **状態**: `agent/spawn` / `agent/message` / `agent/end` / `agent/interrupt` / `agent/close` を親のログに残す。中断されたターンは `agent/end { interrupted: true }` として記録し、再起動の replay でも `interrupted` を維持する（`agent/message` のまま落ちた場合は replay が `interrupted` に正規化）。
- **上限**: 同時実行 8。ツールは plugin ツールなので K9 の wire 14 ツールは不変。`delegate` に `background` を足したぶん、プロンプトのトークン予算（PTC 1,200）を守るため説明文を圧縮した（実測 1,169〜1,172）。

## 設計メモ（WP-23）

- **ツール名と K9**: `todo_write` と `present` は plugin ツール（`plugin: 'plan' | 'present'`）で、組み込み wire 14 ツールは変えない。`update_plan` も従来どおり動く（既存の Plan タブはそのまま）。
- **todo の永続化**: 実行時は `ToolRuntime` が plan を保持し、`Conversation.create` がログの最後の `update_plan`/`todo_write` 呼び出しから `restorePlan` する。`GET /plan` は `ensureConversation` 経由なので、再起動直後でも復元される。トランスクリプトの plan カードは `chat-projection` がログから再構築する。
- **成果物**: `present` は実在する通常ファイルだけを受け付け（ワークスペース外・ディレクトリ・9 件以上はエラー）、`deliverable/presented` にサイズと行数を残す。カードは `Open`（Files パネルのビューア）と `Show in folder`（サーバー側で `explorer /select`）を持つ。
- **注意**: `POST /reveal` はサーバーが動くユーザーのマシンでファイルマネージャーを開く。パスはワークスペース（または追加 root）内に限定する。

## 設計メモ（WP-30）

- **write_file / edit_file は apply_patch の上に載せる**: どちらも最終的に `apply_patch` を呼ぶので、読み取り前編集・writeScope・read-only サンドボックス・デーモンの検査がそのまま効く。`edit_file` は `old` が `count` 回（既定 1）現れることを要求し、失敗時は近い行を番号付きで返す。
- **read_image はテキストにしない**: base64 をツール結果に入れるとトークンが破綻するため、`read_image` はメタデータだけを返し、バイト列は `ToolRuntime.takeImages()` 経由で **ツール結果メッセージ** に添付する（assistant/user の交互性を壊さない）。画像非対応モデル（`role.vision` か provider/model の推定）では明示エラー。
- **working_directory**: 主ルート内のみ・ディレクトリのみ。`session/cwd` に記録し、`Conversation.create` が復元する。`read_file`/`write_file`/`edit_file` の相対パスと `shell` の既定 cwd に効く。unified diff のパスは従来どおりワークスペース相対。
- **副次修正（Rust）**: 新規ファイルを作るパッチは `final_newline: false` で始まっていたため、`write_file` で作ったファイルに末尾改行が付かなかった。新規作成時は `final_newline: true` とし、`\ No newline at end of file` があるときだけ付けない（テストも更新）。

## 設計メモ（WP-32）

- **インデックスは捨てられる**: JSONL ログが正で、`<stateDir>/index/session-fts.db` は作り直せる。ファイルごとの読み取りバイト位置と最終 seq を `files` に持ち、末尾が途中で切れた行は次回に回す（K2 の壊れた末尾と同じ扱い）。
- **日本語**: `tokenize='trigram'` なので部分一致でヒットする。2 文字以下のクエリだけは trigram が使えないため `LIKE` にフォールバックする。
- **何を索引するか**: `user/message`・`user/steer`・`assistant/message`（ツール呼び出しの JSON は除外）・`tool/result`（先頭 4,000 文字）。secret を含みうる `apiKey` などは元からログに無い。
- **壊れたとき**: 開けない DB は削除して作り直し、クエリ時の破損は既知のログから `rebuild` して空を返す（次の検索で復旧）。CLI は索引が使えなければ従来の線形走査に落ちる。
- **session_query**: 同じ cwd のセッションのみ、自分の run は除外、上位 5 件（最大 20）。既定は無効で `--session-query` か `sessionQuery.enabled` で有効化。

## 設計メモ（WP-31）

- **番兵でコマンド境界**: シェルは `[Console]::In.ReadLine()` のループで1行ずつ実行し、各コマンドの後に `__HY_DONE__<id>:<ok>:<code>` を出力する。制御側はその行までを出力として受け取り、`<code>` を終了コードにする（プロンプト文字列やプロンプトのエコーに依存しない）。
- **安全**: 永続シェルは起動時にコマンドを評価しないため、`shell/write` の前に制御側が `policy/evaluate` と同じ評価と承認を行う。read-only / confined では `shell/open` が `gap` を返し、通常の one-shot にフォールバックする（`gap:` が結果に付く）。
- **失敗時**: タイムアウト・EOF・デーモン終了でシェルを破棄する。次の呼び出しは新しいシェルを開くので、状態が不明なまま使い続けることはない。
- **出力**: `[Console]::OutputEncoding = UTF8` を起動時に設定し、stdout/stderr を同じバッファへ入れる。制御側で `cleanPowerShellOutput` により CLIXML と `\r` を落とす。

## 設計メモ（WP-40）

- **履歴は自前のまま**: ツール呼び出しはテキスト（`{"tool":...}`）と `TOOL RESULT (...)` のまま送る。ネイティブの `tool_use`/`tool_result` 往復には変換しないので、どのプロバイダでも同じセッションログ・同じ再開が使える。
- **Anthropic**: system は `system` フィールドへ、`messages` は role 交互（連続する同一 role はマージ＝ステアや画像添付で起きる）。`tool_use` は toolCalls、`thinking` は reasoning、`cache_read_input_tokens` はキャッシュヒットに写す。
- **OpenAI Responses**: `input`/`instructions` 形式、`output` の `message`→本文、`function_call`→toolCalls、`input_tokens_details.cached_tokens`→キャッシュヒット。
- **設定**: `--provider anthropic|openai-responses`、既定モデル・API キー env（`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`）を追加。`role.vision` の推定とネイティブツール既定も両プロバイダを可とした。

## 設計メモ（WP-41）

- **カタログは上書きしない**: role は従来どおり自分の `contextWindowTokens` / `maxOutputTokens` / `pricing` を持つ。カタログは「role が指定していない互換性フラグ」と「一覧表示」にだけ使う（既存のセッションを壊さない）。
- **compat の一元化**: `max_tokens` か `max_completion_tokens` か、effort と tools の併用可否、temperature 可否を `ModelCompat` に集約。未知のモデル名は従来の正規表現ヒューリスティックにフォールバックする。
- **一覧取得**: `hy models discover` はワーカーの provider に問い合わせる（OpenAI 互換 `/v1/models`、Anthropic `/v1/models`、Ollama `/api/tags`）。失敗は理由付きで終了コード 1。mock は一覧を持たない。
- **API**: `GET /api/models` はカタログと「今どのロールがどのモデルか」を返す。GUI のモデル選択は従来のプロファイルを使い続ける（カタログは表示用）。

## 設計メモ（WP-42）

- **絞るだけ**: `resolveBundles` は各バンドルの `allowTools` の積集合を返す。`core` は許可リストを持たない（＝ホストの設定が有効にしたツールをそのまま使う）ので、バンドルを指定しない既存セッションの挙動は変わらない。`minimal` は 3 ツール、`audit` は読み取り＋web、`worker` は書き込みありのコア、`orchestrator` は書き込みなし＋delegate。
- **後方互換**: `--profile` は従来どおりユーザー config のオーバーレイで、その中の `bundles` がそのまま効く。`--bundle` は追加で積む。
- **可視化**: `hy config dump` の `bundles` に names/tools/prompts/panels/commands、`/api/bootstrap` の `config.bundles` と `bundleCatalog` に一覧。
- **残し**: GUI のセッション作成時プリセット選択は未実装（bootstrap に一覧は出しているので、次の UI 作業で picker を足すだけ）。

## 設計メモ（WP-43）

- **単一の宣言**: `API_ROUTES` が唯一の正で、`web/src/api.gen.ts` は生成物。`pnpm check:api` がドリフトを検出し、テストが「`web-server.ts` のリテラルルートが宣言済みか」「宣言済みの固定ルートが実在するか」を双方向に検査する。
- **実行時検証**: ハンドラ先頭で `matchContract(method, pathname)` を 1 回だけ解決し、`readBody()` が型だけを検査する（必須項目の欠落は各ルートの従来メッセージに任せるので、既存の 400 文言は変わらない）。誤型は `400 {"error":"invalid request: <field> must be a ..."}`。
- **クライアント**: `api.ts` は `apiPath('/api/sessions/:id/title', { id })` のように生成ヘルパーを使う。SSE のイベント型はまだ手書き（`web/src/types.ts`）で、契約には SSE ルートの存在だけを宣言している。

## 設計メモ（WP-50）

- **同時実行**: プロンプトは `await` せずにディスパッチし、`session/cancel` や許可応答を読み続ける。同一セッションで 2 本目のプロンプトは `a turn is already running` で拒否。
- **通知**: テキストプロトコルの JSON（`{"tool":...}` / `{"final":...}`）はそのまま流さず、プローズだけを `agent_message_chunk` にし、最終回答はターン終了時に 1 回送る（非ストリーミングのプロバイダでも編集側が本文を受け取れる）。ツールは `tool_call` → `tool_call_update`（completed/failed）。
- **承認**: `session/request_permission` を送り、クライアントが `allow` を返したときだけ許可。応答が無い/失敗時は拒否。`--yes` や full-auto のときはクライアントに聞かない（セッション既定に従う）。

## 設計メモ（WP-51）

- **プロトコル**: 1 行 1 メッセージの JSON-RPC 2.0。1 サーバは 1 ワークスペースに束縛（`session.create` に別 cwd を渡すとエラー）。プロンプトは await せずディスパッチし、`session/cancel` と `shutdown` を読み続ける。
- **通知**: `session/event`（CLI が表示するのと同じ AgentEvent）と `session/status`（busy/turns。成功時は応答より先に idle を送るので、クライアントが応答を待つだけで状態が揃う）。
- **TS クライアント**: `packages/sdk` は依存なし。`cli` が `.js` なら node で起動、それ以外は PATH の実行ファイル。
- **Python**: `subprocess` + 2 スレッド（stdout/stderr）。`prompt(..., on_event=...)` でイベントをコールバック。タイムアウトは `Timeout`、JSON-RPC エラーは `HarnessError`。
- **残し**: 画像入力と `session/request_permission` 相当は未実装（承認はサーバ側の既定に従う）。Python のストリーミングはイベントコールバックのみで、非同期 API は無い。

## 設計メモ（WP-52）

- **セッション束縛**: 計画では `/api/documents/preview?path=` だったが、パス解決の基準（ワークスペース／cwd）がセッションに属するので `GET /api/sessions/:id/document?path=` にした。相対パスはワークスペース基準、絶対パスも許可する（サンドボックスの外は 404 ではなく 415 で「プレビュー不可」）。
- **変換は任意**: `soffice`（`HY_SOFFICE` → PATH → `C:\Program Files\LibreOffice\program\soffice.*`）が見つかれば Office/ODF を PDF に変換し、無ければ 415 `no office converter`。元から PDF のものは変換しない（キャッシュも作らない）。
- **キャッシュ**: 入力の SHA-256 をキーに `<stateDir>/preview/<hash>.pdf` へ保存するので、同じ成果物を何度開いても変換は 1 回。ヒット時は `X-HY-Preview-Cached: hit`。
- **GUI**: 成果物カードの `preview-deliverable` は `window.open` で新しいタブに出す（PDF.js の同梱は見送り。ブラウザ内蔵ビューアで足りるため、依存を増やさない）。
- **プロンプト**: `prompts/office.md` は「成果物を作ったら `document_preview` で確認する」だけを書いた雛形で、ツール説明の予算（K9／PTC）には触れない。

## 設計メモ（WP-53）

- **署名の対象は JSON ではなく行**: `canonicalReleasePayload` が `hy-release/v1` / version / sha256 / url / channel / mandatory を改行で並べた文字列を作り、その Ed25519 署名を `signature`（base64）に入れる。JSON のキー順や空白に左右されない。チャネルは**エントリ自身の** `channel` だけを署名対象にし、フィード先頭の `channel` は「既定の絞り込み」にだけ使う（署名済みの内容を feed 側で書き換えられないため）。
- **フィード全体を拒否**: 1 件でも署名が合わないフィードは丸ごとエラー（`signature verification failed for …`）。部分署名のフィードを信頼しない。スキーマ・バージョン形式・重複バージョン・sha256 形式・size も同じ場所で検査する。
- **鍵**: `hy update keygen` が `<stateDir>/update/keys/update-key.pem`（PKCS#8、既存は上書きしない）と `update-public.pem` を作り、公開鍵を `<stateDir>/update/public-key.pem` にも置く。解決順は `--public-key` → `HY_UPDATE_PUBLIC_KEY` → `update.publicKey` → 上記の既定パス。指紋（SHA-256 の先頭 8 バイト）を表示して帯域外で照合できるようにした。
- **取得と検証**: `hy update fetch`／`POST /api/update/fetch` は HTTPS のみ（`--allow-insecure` はテスト用）。サイズ上限 512 MiB、`size` 宣言との一致、SHA-256 一致を確認してから最終名に rename し、`.sha256` サイドカーを書く。**同名 `.part` は失敗時に残さない**。
- **差し替えの検証**: デスクトップは候補（`<stateDir>/update/download` も含む）の隣の `.sha256` を読み、`expectedSha256` として `update.ps1`／`update.mjs` に渡す。スクリプトは 6 段階（待機→退避→コピー→検証→置換→起動）を `progress n/6` としてログに書き、コピー後にハッシュが違えばバックアップを戻して **exit 5**（コピー失敗は exit 4、退避失敗は exit 3）。--DryRun でも検証とロールバックは動くので、テストは実プロセスを起動しない。
- **オンボーディングは「提案」**: 3 ステップ（ワークスペース→サンドボックス→モデル）は `<stateDir>/onboarding.json` に保存し、次回起動時に `applyOnboardingDefaults` が worker ロールと sandbox 既定へ適用する。**明示フラグ（`--sandbox` / `--model` / `--provider` / `--mock`）が常に優先**。`low-integrity` はユーザーポリシーの持ち物なので選択肢に出さない（400 で拒否）。モデルはカタログにあれば context/max output も合わせ、無ければロールの既存上限を保つ。プロバイダを変えたときは、保存済み baseUrl を引き継がず（別ホストへ飛ばさない）API キー env も切り替える。
- **GUI**: 3 ステップは 1 枚のモーダル（`modal: 'onboarding'`）で、初回ブート時に `bootstrap.onboarding.complete === false` なら自動で開く。設定には「更新を確認／ダウンロード／更新を適用」を並べ、確認は明示操作のときだけ走る。

## このラウンドで判明した副次的修正

- `packages/hy-cli/src/web-server.ts`: `GET /plan` が `session.conv?.plan() ?? 'no plan'` だったため、再起動直後（会話がまだ作られていない）は復元した todo が見えなかった。`ensureConversation(session)` 経由に変更。
- `packages/core/src/tool-registry.ts`: `delegate` に `background` を足したことで PTC プロンプトが 1,249 トークンになり、1,200 の予算を超えた。説明文の圧縮と `read_file` 出力宣言から `sha256` を落として 1,169〜1,172 に戻した（SDK スナップショットも更新）。
- `packages/core/src/llm.ts`: 既存 `HY_DEMO.md` があるワークスペースでの `--mock` 再実行が読み取り前編集の規則でループしていたため、`TOOL ERROR (apply_patch)` で完了する分岐を追加（前ラウンド）。
- `packages/core/src/llm.ts`（WP-21）: モックの分岐は「`get_goal` の単独 if」と「`SAY` から始まる else-if 連鎖」に分かれていた。新しい分岐を前者の else に足したため連鎖が途切れ、後続の else が `content` を上書きしていた（`HY_MOCK_DUMP` で判明）。ステアの分岐は本連鎖の先頭に置き直した。
- `crates/hy-exec-server/src/sandbox.rs`: 未 grant の workspace で `Sandbox::prepare(grant=false)` が文脈を捨てていたため、`grant_now()` で後から confined モードへ移行できなかった。文脈を保持して `unavailable_reason` だけ設定するように修正。
- `packages/hy-cli/web/src/app.ts`（WP-53 の作業中）: PowerShell 5.1 の `Get-Content -Raw`＋`Set-Content` でソースを書き戻すと、UTF-8 が CP932 として読まれて記号（`·` `…` `→`）が壊れる。今回は `release/next` の同梱コピーを記号辞書にして復元した。以後、ソースの書き換えは `edit`／`write` ツールのみを使う（本ラウンドの教訓）。

## 設計メモ（WP-60）

- **S8 生成タイトル**: モデルには「同じ言語で・6 語/24 文字以内・引用符や見出しなし・具体名」を指示し、`maxTokens: 48`・temperature 0・effort `none`（opencode）で呼ぶ。応答は `cleanGeneratedTitle` がフェンス・`Title:`・箇条書き・引用符・末尾の句点を落とし、60 文字/120 バイトに丸める。**20 秒の期限を `Promise.race` で強制**するので、abort を無視するプロバイダでも UI を待たせない。失敗・空・mock では「最初の文」をヒューリスティックに使う（`source: 'heuristic'` と `reason` を返す）。保存先は `ui-state.json` の `generatedTitles` で、手動名 `titles` が常に優先。GUI は名前ダイアログの「名前を生成」とパレットから起動し、保存すると手動名として固定される。
- **S6 統計（TTFT の代わり）**: プロバイダはトークン時刻を返さないため、DSH の TTFT/デコード時間は再現できない。代わりに **step-start→step-end のプロバイダ時間**、**tool-start→tool/result のツール時間**、**ターン開始→最初の step-end（最初の応答まで）**、ターン実時間、ツール別の回数・失敗・時間を測る。ターン終了時に `session/stats` を 1 件だけ書き、`statsFromEvents` は最新スナップショット＋それ以降の `tool/result` を数える。ライブ値と再起動後の値が一致することを結合テストで固定した。
- **S9 fork**: `planFork` は対象 run のイベントだけをコピーし（`.sub` のサブエージェントは含めない）、`SessionLog.importEvents` が新しい `seq`/`sessionId` を振りつつ**元のタイムスタンプを保つ**。`session/fork {from, upToSeq}` を追記して来歴を残し、`listRuns` が `forkedFrom` として返す。GUI は「分岐」で新チャットを開く。`upToSeq` は API にあるが、UI は末尾からのみ（途中への分岐は次の作業）。
- **S10/U13 参照**: `@session:<id>` は `projectChat` の user/assistant だけを材料にし（ツール出力やシステムプロンプトは含めない）、先頭 1 件＋末尾 5 件・各 600 文字に制限する。ブロックは**ユーザーの本文の後ろ**に置き、`[session reference …]` で始まり `[/session reference]` で終わる untrusted データとして明示。`stripPlanPrefix` がこのブロックを表示から消すので、チャットにはユーザーの言葉だけが残る。存在しない id は `missing=true` のブロックになり、推測しないようモデルに伝える。1 メッセージ最大 3 件。`GET /api/references` はファイルと過去チャットを 1 回で返し、名前一致 > 本文一致 > 新しさで並べ、`q=dir/` はフォルダの子を返す。GUI の `@` メニューは Sessions/Files の 2 セクションで、`@session:<id>` / `@path` の正規形を挿入する。
- **S7 ターン一覧**: すべてのエントリは既に読み込まれているので、アウトラインは「ユーザーターンのジャンプリスト」にした。ヘッダーの一覧ボタン／パレットで開き、行を選ぶと該当エントリへスクロールして点滅する。未ロードのターンという状態は今の実装には無い（ページングを入れるときに拡張する）。

## 設計メモ（WP-61）

- **D8 シークレットマスク**: 表示だけを変える。ログ・モデルに渡る本文・コピー機能は原文のまま（「原本は保持」）。`secret-mask.ts` は sk / GitHub / AWS / Slack / Google / Bearer / PEM / `key=value` 代入の 8 種を検出し、代入を最初に処理してパラメータ名を残す（`OPENAI_API_KEY=••••`）。既定は先頭 6 文字＋伏字、`replacement` を渡すとその文字列。クライアントは同じ実装を `web/src/secret-mask.ts` に持ち、**同一コーパスでサーバ版と出力一致をテスト**して乖離を防ぐ。設定「API キーを隠す」は既定オン、オフは `localStorage` のみ。
- **U4 メッセージ評価**: 送信は一切しない。`<stateDir>/feedback.jsonl` に 1 行 1 評価で追記し、`POST /api/sessions/:id/feedback` が検証して保存、`GET` が要約（up/down）と履歴を返す。カテゴリは 7 種、メモは制御文字を潰して 600 文字まで。壊れた行は読み飛ばす。GUI は回答の ✓/✗ と `/feedback [メモ]` から。**ファイルがすべて**であることを UI にも明記した。
- **U8 ショートカット**: `Ctrl+K` のような表記に正規化し、修飾キーのない裸キーは Escape と F1〜F12 以外を拒否する（タイピング中に発火させないため）。既定 8 アクション、`localStorage` に端末別保存、重複は `shortcutConflicts` で警告（自動解決しない）。編集モーダルは入力欄をクリックして次のコードを録音し、1 件ずつ／全部を既定へ戻せる。グローバル handler は入力中でも修飾キー付きだけ発火する。
- **U9 テーマ/フォント**: `light` / `dark` / `system` の 3 択。system は `matchMedia('(prefers-color-scheme: dark)')` を購読して起動中も追従する。本文とコードのフォントはユーザー入力の CSS スタックを英数字・空白・カンマ・引用符・ハイフンだけに絞って `--font` / `--mono` に入れる（空ならスタイルシート既定）。すべて `localStorage`。
- **U10 ロケール辞書**: `registerLocaleMessages(locale, messages, label)` で実行時に辞書を足せる。未知のロケールは英語、未知のキーはキー名をそのまま返す（空文字にしない）。設定の言語セレクトは `localeChoices()` で組み込み＋登録済みを並べる。ロケール型は `string` に広げ、`translate()` がフォールバックを所有する。
- **U11 Open In**: 検出は実行ファイルの存在で行い、**検出済みの id だけ**を `openInArgv` が受け付ける（任意コマンド実行の経路にしない）。起動は `isLocalAddress(req.socket.remoteAddress)` のときだけ（別マシンから開かせない＝SSH 時は非表示と同じ判断）。パスは `safeWorkspacePath` でワークスペース内に閉じ込め、フォルダ系はファイルの親を開き、PowerShell は `-NoExit -Command Set-Location -LiteralPath '…'`（クォートは二重化）で渡す。GUI は詳細パネルのセレクトから。

## 設計メモ（WP-62）

- **既定 off・明示 opt-in**: `telemetry.enabled` か `HY_OTEL_ENDPOINT` を渡したときだけ動く。`resolveTelemetryConfig` は壊れた設定を例外にし、呼び出し側（web server）がログに残して**無効のまま**起動する（計測のために起動できない、を避ける）。
- **ローカル限定**: エンドポイントは `127.0.0.1` / `localhost` / `::1` のみ。`allowRemote: true` を明示しない限り別ホストは拒否する（内容は送らないが、識別子とタイミングは送るため）。
- **内容を構造的に持たない**: span の属性は run id・kind・モデル名・ツール名・成否・ミリ秒・件数だけ。`SpanRecord` に本文を入れる欄が無く、呼び出し側もメッセージやツール引数を渡さない。結合テストは「README.md も “Web Fixture” も payload に現れない」ことを固定する。
- **失敗しても邪魔しない**: flush はターン終了時に 1 回だけ fire-and-forget。コレクタが落ちていれば 0 を返して捨て、キューは 500 件で古いものから落とす。**レスポンス本文を読み切る**（undici のソケットが残るため。テスト中のプロセス終了で判明した）。
- **TTFT ではなく実測**: span の `hy.first_response_ms` は WP-60 の「最初の step-end まで」。プロバイダがトークン時刻を返さないので、TTFT という名前は使わない。

## 設計メモ（WP-63）

- **英語を正、日本語を入口に**: ルートの `README.md` は英語のまま詳細を保ち、`README.ja.md` を日本語の入口として追加した（ビルド・起動・コマンド表・M6 までの機能・既定値・テスト）。両方から `docs/` へリンクする。
- **症状から引く**: `docs/troubleshooting.md` は「起動しない」「モデルが答えない」「サンドボックスが拒否する」「更新が失敗する」など症状ごとに 1 つの確認手段を示す。英語の後に日本語の同じ構成を置いた（別ファイルに分けると片方だけ古くなるため）。
- **移行は書き換えない**: `docs/migration.md` は 0.1.x → 0.2.0 のセッション形式 v2（読み取り時にメモリ上で移行、ファイルは触らない）、バンドル/プロファイル、API 契約、新しい `update`/`telemetry` 設定、更新フィードの導入手順、DSH プロトタイプから持ち運べるもの（AGENTS.md・ポリシー・ユーザー設定）をまとめた。
- **パッケージ README**: 5 パッケージに「役割・主なモジュール・契約・テスト」を書いた。ソースの一覧を写すのではなく、変更時に一緒に直すべき契約（プロトコル生成、ツールスキーマ、API 契約、設定スキーマ）を明示する。
- **i18n の検査**: `hasTranslation` を足し、ビルド済みバンドルから `tr('…')` / `translate(_, '…')` を抽出して英語辞書の有無をテストする。英語の値がキーと同じ（`lines: 'lines'`）ことがあるため、値の比較ではなく辞書の所有で判定する。M5/M6 で足したキーは ja/zh が英語のままになっていないことも固定した。

## 次の一手

1. **M0〜M6 完了**。残作業は運用側のみ: 実機での `pnpm desktop:package` と署名、外部プロバイダでの実走（この環境の DeepSeek キーは残高不足）。
2. 2026-11-05: 引き継ぎ書（[handover-2026-11-06.md](handover-2026-11-06.md)）の 3-1〜3-5 に対応済み（版番号の一本化、サイドバーの相対時刻、メッセージの絶対時刻、文書テストの環境ガード、テストの一本化）。記録は同書 §8 と [project.md](../project.md) §5.31。
3. 任意の追加: GUI からのロケール辞書読み込み、fork の途中分岐（`upToSeq` は API に実装済み）、PDF.js の同梱。
