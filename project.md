# HY-HARNESS プロジェクト管理ファイル (project.md)

## 1. プロジェクト概要
OpenAI Codex（`openai/codex`）と DeepSeek Harness（`deepseek-ai/deepseek-harness`）のそれぞれのアーキテクチャ・仕様・長所・短所を `deep_research` スキルを用いて徹底調査し、両者の長所を融合して既存のコーディングエージェントの限界を克服した「最強の自律型エージェントハーネス（HY-HARNESS）」の設計および実装計画の草案を作成する。

## 2. 成功条件と維持すべき条件
### 成功条件 (Success Criteria)
1. `deep_research` の厳格なプロトコル（0周目言語圏別サブエージェント探索 → 1周目以降の一次ソース取得 `fetch.py` → 行番号付きの主張裏付け → `extracts.json` & `report.py` による機械照合済み `report.html` 生成 → 7大不具合防止基準を満たす統合長大レポート `report.md` 作成）を完遂すること。
2. `openai/codex` および `deepseek-ai/deepseek-harness` の実際の公開リポジトリ・公式ドキュメント・関連技術記事から、構造・仕様・長所・短所を一次ソースの行番号根拠付きで解明すること。
3. 両者の長所を融合し、短所・既存エージェントの限界を克服する `HY-HARNESS` のアーキテクチャ設計と実装計画書（`docs/designs/hy-harness-implementation-plan.md`）および EGM ブレインストーム成果物（`concepts_brief.md`）を作成・推敲すること。

### 維持すべき条件・制約 (Constraints to Maintain)
1. 推測やハルシネーションを排除し、手元に落とした一次ソースで確認が取れた事実のみを確定情報として扱うこと（未確認事項は明確に区別する）。
2. サブエージェント起動時は必ず `Model: 'flash'` を明示指定すること。
3. 本フェーズでは調査と実装計画の策定・推敲までを行い、ユーザーの承認を得る前に独断でハーネス本体のコード実装を開始しないこと（EGM ルールおよびプロジェクト管理ルールに準拠）。

## 3. タスク一覧と進行状況
- [x] `project.md` の作成と成功条件・維持条件の定義
- [x] `deep_research` 置き場（`C:\Users\川野創太\research\hy-harness\`）の初期化（`map.md`, `log.md`, `sources/`）
- [x] 0周目：日本語圏担当・英語圏担当の2本の検索役サブエージェント（`Model: 'flash'`）を並行起動し、地図作りを実施
- [x] 1周目：`openai/codex` と `deepseek-ai/deepseek-harness`（および `dsh-superagent-prototype`）の公式リポジトリ（README、アーキテクチャ文書、主要ソースファイル、ADR ノート）および基礎理論論文（`arXiv:2608.25512`, `arXiv:2607.28802`, `arXiv:2405.15793`, MartinFowler.com, Anthropic Blog）を `fetch.py` で `sources/` に取得し、後ろへ・横へたどる
- [x] 証拠保全：`extracts.json` の作成と `report.py` による機械照合・`report.html` 生成（全29件の抜き書きが原文と完全一致することを検証済み）
- [x] 総合報告：`C:\Users\川野創太\research\hy-harness\report.md`（統合長大レポート）の作成
- [x] 実装計画草案の作成：調査結果に基づき、`g:\マイドライブ\HY-HARNESS\docs\designs\hy-harness-implementation-plan.md` (v1.0) を作成
- [x] `/egm-brainstorm` による設計案のストレステストと推敲：ユーザーとの対話で5つの基本方針（Windows 10 ネイティブ第一主義、TS×Rust ハイブリッド、DeepSeek/Gemini/OpenAI互換のロール別モデル指定、トークン節約型 Tiered PTC、Git Ref チェックポイント、自律更新・上限付き Rationale Ledger）を確定し、`egm-synthesizer`（`8525f297-83a5-4fdd-a0cd-9035e892abd2`、`Model: 'flash'`）経由で6つの Goldfish レンズによるレビューを実施、`concepts_brief.md` および `docs/designs/hy-harness-implementation-plan.md` (v2.0) に反映完了
- [x] `/egm-draft` に準拠した完全な正式設計書 `g:\マイドライブ\HY-HARNESS\design_draft.md` の完成（Overview, The Problem, Goals, Non-Goals, Open Questions, Critical User Journeys, Technical Plan, Alternatives Considered, Non-Functional Requirements, Additional Resources, Future Improvements, 全21ファイルの Detailed Implementation Plan & Verification Plan を完遂）
- [x] `/egm-review design_draft.md`（Uninterrupted Full Flow: Stage 5〜Stage 9 全9サブエージェント、`Model: 'flash'`）の完遂と、5つのステージ別レポートおよび統合レビューレポート `consolidated_review_report.md`（🔴 Blocker 7件、🟡 Major 11件、🟢 Nit 6件、全67件のトレーサビリティマトリクス付き）の出力完了
- [x] `/egm-resolve` による全24項目（🔴 Blocker 7件、🟡 Major 11件、🟢 Nit 6件）の `design_draft.md` への一括反映（`auto accept`）と `goldfish_review_report.md` の `Status: resolved` 更新完了
- [x] 作業場所を `F:\HY-HARNESS` に移した（2026-11-02、ユーザー指示）。Google ドライブ（`G:\マイドライブ\HY-HARNESS`）には完成物だけをアップロードする
- [x] Rev 3 推敲: `design_draft_rev3.md` と `refinement_notes.md` を作成。サンドボックスのモデル、チェックポイントの手順、完了判定、信頼モデルを改訂し、Status を Draft に戻した
- [x] Rev 3 の一次ソース裏取り: `verification/`（ソース 50 件以上、抜き書き 95 件を機械照合で全件一致、Git の実験と FS の実測）。訂正 4 件（トークン推定、Git ≥ 2.41、FILE_PERSISTENT_ACLS、cordis は RC）を反映
- [x] OQ-1〜OQ-5 を決定（2026-11-02、ユーザーが推奨案をすべて採用）: pwsh 7 を既定のシェルにする、unconfined はユーザーポリシーと CLI の `--verify-cmd` だけ（Guardian は不可）、信頼していないリポジトリの無人実行は既定で拒否（`--unattended-ok` で許可）、完了は `claimComplete` のみ、Ledger は上限で拒否する
- [x] Rev 3 をユーザーが承認（2026-11-02）。設計書の Status を Approved にした
- [x] 日本語版の実装計画を v3.0（Rev 3 対応）に更新: `docs/designs/hy-harness-implementation-plan.md`
- [x] 開発環境の導入: Rust 1.99.1、pnpm 10.34.9。Node 26.13.0 と pwsh 7.6.9 はドキュメントの場所（`%LOCALAPPDATA%\hy-harness\tools\`）に現在は存在せず、PATH の Node 24.19.0 と Windows PowerShell 5.1 で動作を確認（2026-11-02 追記）
- [x] Phase 0: Cargo / TS ワークスペース、`hy-protocol`、TS 型の生成と差分検査
- [x] Phase 2 の一部: Starlark 実行ポリシー `hy-execpolicy`（テスト 8 件成功）
- [x] **停止解除・MVP 実装**（2026-11-02）: 実行デーモン `hy-exec-server`（RPC、ポリシー強制、ジョブ、パッチ、チェックポイント）、TypeScript コントロールプレーン、CLI の `hy run` / `hy ralph` / `hy undo` / `hy sandbox status` / `hy policy-test` を実装。`--mock` の E2E と Ollama `qwen2.5:3b` での実走、Rust 24 テスト、結合テスト 4 件が成功。詳細は `docs/implementation_status.md`
  - Phase 2（実行デーモン中核）: 完了
  - Phase 3（`hy run` の縦の一本）: 完了
  - Phase 5（PTC）: 一部（`run_code` は動作。ワーカーはコントロールプレーンが spawn し、OS サンドボックスなし）
  - Phase 7（チェックポイント / Ralph）: 一部（`checkpoint/*`、`hy ralph` の Gate 1、`hy undo`。Gate 2 は `--grader` で任意）
- [x] **Phase 1（Windows サンドボックスの実現性スパイク）**（2026-11-02）: `spikes/win-sandbox/` で S-1〜S-6 を NTFS（C:）上で実測。**Go**（`workspace-write` で `cargo build`/`test`、`tsc`、`npm test`、Windows PowerShell 5.1 が動作）。結果と設計変更案 A〜F は ADR [`docs/adr/0001-windows-sandbox.md`](docs/adr/0001-windows-sandbox.md)
- [x] ADR 0001 の設計変更案 A〜F をユーザーが承認（2026-11-02）。設計書を Rev 3.1、日本語の実装計画を v3.1 に更新し、ADR を Accepted にした
- [x] **Phase 4（サンドボックスの統合と Guardian）**（2026-11-02）: `hy-sandbox-windows`（`read-only` / `workspace-write` / `low-integrity` のトークン、付与と SID で走査する取り消し、confined の起動、偽装、ボリュームと上位ディレクトリの検査、`.git` の検査）、`hy-exec-server` への接続（confined の `exec/command`、偽装パッチ、git の前の検査と追加フラグ、`sandbox/grant|revoke`）、Guardian（`packages/seams`）、CLI の `--sandbox` / `--guardian` / `hy sandbox grant|revoke`。Rust 30、単体 8、結合 12 件が成功。Ollama `qwen2.5:3b` で `--sandbox workspace-write` の実走に成功。サンドボックスは opt-in（既定は `unconfined`）
- [x] サンドボックスは opt-in のままにする（2026-11-02、ユーザーが決定）。既定は `unconfined`、`--sandbox workspace-write` で有効にする
- [x] **OQ-2 の確定**（2026-11-02）: ユーザーの許可を得て Jest 30.5.2 / Vitest 5.0.5 を `%USERPROFILE%\hy-oq2-fixture` に導入し、`hy-exec-server` 経由で実測（`spikes/win-sandbox/oq2_measure.mjs`、`results/oq2.json`）。既定の起動はどちらも `workspace-write` で `spawn EPERM`、スレッドの設定（Jest `--runInBand` / `--workerThreads`、Vitest `--pool=threads` / `vmThreads`）は `workspace-write` で動き、`low-integrity` ではすべて動く。終了後に revoke（7,199 件を復元）してフィクスチャを削除
- [x] **Phase 5: PTC ワーカーの AppContainer 化（案 F）**（2026-11-02）: `hy-exec-server` の `ptc/run` が、能力なしの AppContainer と単一プロセスの Job Object でワーカーを起動し、`toolCall` をクライアントへの `ptc/toolCall` として中継する。`ToolRuntime` はサブ呼び出しを読み書きロックで制御。Rust 30、単体 8、結合 17 件が成功
- [x] **Phase 5 の残り**（2026-11-02）: ツールの登録表（JSON Schema → 引数の検査、プロンプトのシグネチャ、`jsonSchemaToTs` による `.d.ts`）、`tools.search.{glob,grep}`、`tools.jobs.*`、`.d.ts` のスナップショットと型検査のテスト、トークン量の実測テスト（直接呼べる 4 ツール 216、SDK 込みで 905 トークン、上限 1,200）。単体 14、結合 21 件が成功
- [x] **Phase 6: Spill、Compaction、Rationale Ledger**（2026-11-02）: Ledger（固定の制約 + `tools.rationale.*` のメモ、12 件・1,500 トークンの上限で拒否、ランごとに `seq` 順で畳み込み）、Spill（32 KiB 超を退避し `spill://` で読み戻し）、Compaction（75 % で Tier 1 の参照化、Tier 2 の要約。組を保ち、制約とメモは毎回そのまま再描画）、`--rule`、`compactor` ロール、`hy ralph` のラウンドごとの子セッション。単体 21、結合 22 件が成功。トークン量 989（上限 1,200）
- [x] **Phase 7: verifier-ralph**（2026-11-02）: 状態機械（`packages/seams/src/verifier-ralph.ts`）、Budget4D（全ロール計上）、`claim_complete`（OQ-4。ralph でだけ直接呼べるツールにもした）、改ざん検査、Gate 1（複数の `--verify-cmd`）、Gate 2（既定で実行、入力は untrusted として囲う）、失敗の要約、中断・タイムアウト・予算切れでのロールバック、`HeadMoved`、OQ-3（未信頼は `--unattended-ok` が必要）、Ctrl-C、`hy checkpoint prune`。単体 26、結合 29 件が成功。Ollama `qwen2.5:3b` で `claim_complete` → Gate 1 → Gate 2 の成功を確認
- [x] **Phase 8: 仕上げとベンチマーク**（2026-11-02）: 共通の再試行（429 / 5xx）、Gemini アダプタ（Interactions API、一次ソースどおり）、アダプタの契約テスト（Ollama は実記録）、`pnpm bench:checkpoint`、ラン単位の stat キャッシュ、`docs/enforcement-gaps.md`、`pnpm typecheck` の修正、TypeScript のカバレッジ（行 98.9 %・分岐 90.6 %）。検証計画: ビルド警告 0、clippy・typecheck・プロトコル差分 OK、Rust 31・単体 36・結合 29 件成功
- [x] ロールバックを object を書かない方式に変更（2026-11-02）: 827 → 約 265 ms で目標の 500 ms 未満を達成
- [x] チェックポイント作成の性能目標を 750 ms 未満に改訂（2026-11-03。ロールバックは 500 ms 未満のまま）: `pnpm bench:checkpoint` が PASS（作成 約 625 ms、ロールバック 約 263 ms）
- [x] **Codex / DSH 機能パリティの追加実装**（2026-11-03）: `RepeatToolReminderGuard`、`hy chat` / `hy resume` / `hy sessions` / `hy review` / `hy mcp-server`、`SKILL.md` カタログ、MCP クライアント、フック（`preToolUse` / `postToolUse` / `turnEnd` / `notify`）、`web_fetch` / `web_search`、LSP、ユーザープラグイン（`plugins.ts`）、ワークスペースメモリ（`memory.ts`）、`AGENTS.md` 階層探索、プロファイル、`--full-auto`、ネイティブ関数呼び出し、`docs/feature-parity.md`。単体 56 件成功
- [x] **未完了項目の完遂フェーズ（2026-11-03）**:
  - **成功条件**: 設計書 Rev 3.1・`docs/implementation_status.md`・`docs/enforcement-gaps.md` で未実装・未検証とされていた全項目（①50 MB 超の未追跡ファイル除外 `unprotected`、②`$/cancelRequest` と `AbortSignal` による in-flight ツール呼び出し中断、③`cordis` サービスラッパー `packages/core/src/cordis.ts`、④Rust カバレッジ測定と純粋ロジック ≥ 85 % 達成、⑤OQ-2 の `esbuild` / `npm install` 実測、⑥実モデル Ollama `qwen2.5:3b` での長時間 Compaction・Guardian・Grader 評価、⑦CI ワークフロー `.github/workflows/ci.yml` とトークン権限分岐単体テスト、⑧全ドキュメント更新と `G:\マイドライブ\HY-HARNESS` 同期）を実装・検証し、物理的制約（API キー不在・別 OS アカウント未ログイン）のみを未実施として明確に区別して記録すること。
  - **維持すべき条件**: 既存の全 Rust テスト・TS 単体テスト・結合テストがすべて PASS し、ビルド・clippy・typecheck・プロトコル差分検査が警告 0 で通り、`pnpm bench:checkpoint`（作成 < 750 ms、ロールバック < 500 ms）とツールトークン上限（≤ 1,200）を維持すること。
  - [x] T1: 50 MB 超の未追跡ファイル除外（`checkpoint.maxUntrackedFileBytes`、`unprotected`）の実装とテスト（`checkpoint.rs` / `server.rs`、単体テスト 5 件 PASS）
  - [x] T2: `$/cancelRequest` と `AbortSignal` による実行中ツール呼び出し・RPC の中断実装とテスト（`server.rs` / `ptc.rs` / `exec-rpc.ts` / `tools.ts` / `budget.ts` / `main.ts`、`verifier-ralph.test.mjs` で 30 秒コマンドが 500 ms タイムアウトで即座に終了することを確認）
  - [x] T3: `cordis` ラッパー（`packages/core/src/cordis.ts`）の実装とテスト（`cordis.test.ts` 2 件 PASS、CLI に接続済み）
  - [x] T4: Rust カバレッジ測定（`llvm-cov`）スクリプト作成と純粋ロジック ≥ 85 % 検証（`scripts/coverage-rust.mjs`、純粋ロジック合算 行 89.2 %・領域 88.6 % を達成）
  - [x] T5: OQ-2 の残り（`esbuild` と `npm install`）のサンドボックス実測と ADR 0001 更新（`spikes/win-sandbox/oq2_esbuild_npm.mjs`、`results/oq2-esbuild-npm.json`、終了後 revoke・削除済み）
  - [x] T6: 実モデル（Ollama `qwen2.5:3b`）による Compaction・Guardian・Grader の実走評価テスト（`scripts/eval-ollama.mjs`、`results/ollama-live-eval.json`、全項目 PASS）
  - [x] T7: CI ワークフロー（`.github/workflows/ci.yml`）作成とトークン権限分岐単体テスト追加（`token.rs` の標準ユーザー / UAC 管理者両分岐テスト PASS）
  - [x] T8: 全ドキュメント更新および `G:\マイドライブ\HY-HARNESS` への完全同期
- [x] **Desktop GUI（DSH 準拠・承認済みスコープ、2026-11-03）**:
  - **成功条件**: DSH の Web UI / Desktop を原型に、Electron デスクトップアプリと `hy web` を追加する。3 カラム（セッション / 会話 / 右パネル）、チャット、ツールカード、承認 / 質問、ゴール、プランモード、モデル切替、画像添付、`@file`、Files / Diff / Plan / Details / Trace / Browser / Terminal / Desktop、ジョブ、サブエージェント、MCP / プラグイン / メモリ、設定、プラグイン再読み込み、ピン留め / アーカイブ、English / 日本語 / 中文、Verifier loop、スケジュール / Webhook、永続PTY、Tailscale 経由のスマホアクセスを提供する。§8 の5項目は同日のユーザー承認により対象外とし、これを承認済みスコープの完成条件とする。`pnpm desktop` で起動し、`pnpm desktop:screenshot` で画面を検証できること。さらに `pnpm desktop:package` で `release\HY-HARNESS-0.1.0-portable.exe` を生成し、Node / pnpm なしで起動できること。
  - **実装**: `packages/desktop`（Electron メインプロセス、preload、メニュー、ネイティブワークスペース選択 / 最近の一覧 / プラグインファイル選択）、`packages/hy-cli/src/web-server.ts`（ローカル HTTP + SSE + 認証、`ui-state.json`、プラグインカタログ / 再読み込み、ターミナル、自動化 MCP 直接呼び出し、PWA 配信）、`packages/hy-cli/src/main.ts`（`web --tailscale`）、`packages/hy-cli/src/pty.ts`（永続PTY）、`packages/hy-cli/src/chat-projection.ts`（ログ投影）、`packages/hy-cli/src/session-app.ts`（CLI と GUI の共有セッション処理、プラグイン / MCP の構成キーによる再読み込み）、`packages/hy-cli/web`（UI 本体、`i18n.ts`、`manifest.webmanifest`、xterm.js vendor）。
  - **検証**: `pnpm build`、`pnpm typecheck`、`pnpm test` 70 件、`pnpm test:integration` 49 件（うち `web-ui.test.mjs` 8 件、`automation-mcp.test.mjs` 1 件）、`pnpm desktop:screenshot` が成功。Electron 実機のスクリーンショットを `screenshots/desktop.png` に保存。日本語 UI・白色 / 桜色テーマ・ピン留め・Browser / Terminal / Desktop・永続PTY・プラグイン読み込み・スケジュール / Webhook・Playwright MCP / agent-desktop MCP を実機 / ブラウザで確認。`pnpm desktop:package` で `release\HY-HARNESS-0.1.0-portable.exe` を生成し、パッケージ版で `PACKAGED_PTY_OK` と Chrome の `PACKAGED_BROWSER_OK` を確認。Tailscale URL は実機で `302 → Cookie`、`/api/bootstrap` が 401 / 200、マニフェストが `application/manifest+json` で配信されることを確認。GUI から Navigate → Snapshot → Type → Click → Snapshot で `Clicked sakura`、Desktop の Apps で `ok: true`、PTY で `CWD=C:\Windows` を確認。390 px 幅で本文 390 px・入力欄 366 px、サイドバー / 右パネル / PTY の開閉と 358 px 幅を確認。
  - **2026-11-03 追記（UI 仕上げ）**: 設定のサンドボックス注意を日本語の小さな枠なし注記にし、自動化の再起動注意は変更時だけ表示。承認モードの sandbox 説明を現在値に追従。モデル追加 / 削除で編集中の設定を保持。チャット完全削除、回答コピー（Electron ネイティブクリップボード + フォールバック）、Effort と thinking 表示を追加。Compactor は初回使用時まで遅延初期化し、未使用ロールのキー不足でチャットが止まらないようにした。DeepSeek 実 API で Effort `high` / `reasoning_content` / トークン表示を確認。exFAT/FAT32 でも Codex 互換の `workspace-write` を許可し、GUI の sandbox 警告を非表示にした。存在しない前回ワークスペースは起動時に無視し、画面外の保存ウィンドウ位置も補正する。Orchestration A+ を実装。最新 exe を G: に同期し、SHA-256 を照合済み。
  - **セキュリティ**: 既定はループバック限定、`--tailscale` は Tailscale IPv4 のみにバインド（Funnel なし）、ランダムトークン → HttpOnly `SameSite=Strict` Cookie、CSP、Electron `contextIsolation` / `sandbox` / `nodeIntegration: false`、権限要求拒否、パス検査、本文 32 MiB 上限。Browser は sandbox iframe、単発 Terminal はユーザー承認 + ポリシー `deny` 維持、永続PTY はユーザー権限のローカルシェルでモデル非公開・UI に警告表示、プラグインはユーザー設定のモジュールのみ。GUI の MCP 直接呼び出しは Playwright / agent-desktop に限定。
  - **DSH との差分**: プラグインマーケット / Creator mode、SSH 先での実行、クラウド、マルチユーザー / パブリック公開、IDE 拡張は 2026-11-03 にユーザー承認済みの対象外（[docs/designs/desktop-gui.md](docs/designs/desktop-gui.md) §8）。Browser / Desktop 自動操作、スケジュール / Webhook、永続PTY、個人 tailnet 内のスマホアクセスは実装済み。
- [x] **Orchestration A+（2026-11-03）**:
  - **目的**: オーケストレーター（plan 固定の通常セッション）が、通常のワーカーセッションを複数管理する。ワーカーは既存の `delegate` サブエージェントを使える。オーケストレーション自体は `delegate` / `runSubagent` を使わない。
  - **安全策（A+）**: 担当パス必須・重複拒否、同時 3 ワーカー、`apply_patch` のスコープ検査、ワーカーの git / undo / checkpoint 禁止、チェックポイント無効化、ワーカー間のシェル直列化、バックグラウンドシェル禁止、完了後の `orchestrator_diff` レビュー。専用プロンプトは `packages/hy-cli/prompts/orchestrator.md` と `worker.md`。
  - **自動化**: ワーカー完了 / 失敗 / 承認要求でオーケストレーターを自動起床。5 分間イベントがないワーカーは心拍通知。オーケストレーターは待機ループを持たない。
  - **UI**: 開始 / 終了、オーケストレーターとワーカーの階層表示、読み取り専用ワーカーチャット、Details のワーカーカード / 停止。
  - **永続化**: `<stateDir>/orchestration.json`。再起動時は実行中ワーカーを `interrupted` にして通知。
  - **対象外**: ワーカーごとの git worktree / 自動マージ / 複数オーケストレーション。同一ワークスペース + パス分担を維持。

## 3.1 重要な設計判断（Rev 3）
- シェルにもワークスペースへの書き込みを許す（DSH 方式の capability SID + Low ラベル + FILE_DELETE_CHILD 拒否）。Rev 2 の「書き込みはすべて patch 経由」ではビルドもテストも動かないため。
- libuv の名前付きパイプ EPERM は親側の DACL では直せない（libuv のソースで確認）。Node 系テストランナーなど制限トークンで動かないコマンドは、ユーザーポリシーか CLI の `--verify-cmd` でだけ unconfined にできる（OQ-2、決定済み）。対象のコマンドは Phase 1 の実測で特定する。
- チェックポイントは一時インデックスで `add -A`、変化したパスだけ復元、ユーザーのインデックスを復元する（実験で検証済み）。

## 3.1.1 Rev 3.1 の判断（Phase 1 スパイクの結果、2026-11-02 承認）
- A: `.git/` と `.hy-harness/` は付与の前に用意し、ハーネスの git の前に毎回検査する。git は空のフックディレクトリと `core.fsmonitor=false` で実行する（付与後の `.git` はサンドボックスから書けるため）。
- B: 専用 temp は `%USERPROFILE%\.hy-harness	mp`。祖先ディレクトリを偽装トークンで開けるか `initialize` で確かめる（パッケージ SID の ACE を持つディレクトリは Low トークンから開けないため）。
- C: サンドボックスモード `low-integrity`（制限 SID なし、Low のみ）を追加。pipe や IPC で子プロセスを起動するツール用で、unconfined より狭い。
- D: ACL のないボリュームを `non-acl-volumes` として報告する（2026-11-03 追記: Codex 互換で workspace-write を許可し、そのボリューム全体を書き込み可能にする。GUI 警告は非表示）。
- E: revoke は SID で走査して取り除く。
- F: `hy-ptc-worker` は能力なしの AppContainer で起動する。

## 3.1.2 Phase 4 の判断（2026-11-02）
- サンドボックスは opt-in（ユーザーが決定）。既定は `unconfined` のままにする。既定にすると、`--sandbox` なしの初回の `hy run` でもワークスペースの ACL を変更し、ACL のないボリュームや `%TEMP%` 配下のワークスペースでは止まるため。
- 2026-11-03 変更: ACL 非対応ボリューム（F: / G:）でも `workspace-write` を許可する。Codex と同じくボリューム全体が書き込み可能で、NTFS 側は制限される。GUI の sandbox 警告は非表示。

## 3.2 MVP 実装の判断（2026-11-02）
- まず**動く縦の一本**を通すため、`workspace-write` は実装せず、`unconfined` + パス検査 + 実行ポリシー + チェックポイントで運用する。起動時に `enforcement: "none"` と既知の穴を必ず表示する。
- `hy-exec-server` は stdout を JSON-RPC 専用にし、ログは stderr に出す。ジョブは Job Object（割り当てに失敗した場合は `taskkill /T /F`）で管理する。
- チェックポイントは `refs/hy/checkpoints/<run>/<label>` のシャドウコミット。`git add -A` を一時インデックスに対して行い、ロールバックは `diff-tree` で変わったパスだけを復元する。
- 小規模ローカルモデルでも動かせるよう、`apply_patch` は unified diff に加えて `{file, content}` の全体書き込みを受け付ける（ホスト側で diff に変換）。`run_code` は `--ptc` を付けたときだけプロンプトに表示する。
- 既定プロバイダーは Ollama `qwen2.5:3b`。DeepSeek のキーはあるが API が残高不足（HTTP 402）を返すため、既定にはしない。

## 3.3 Desktop GUI の判断（2026-11-03）
- Electron のメインプロセスが `packages/hy-cli/src/web-server.ts` を in-process で起動し、`BrowserWindow` はループバック URL を読む。DSH の Desktop と同じ「Host が Web アプリを配信する」形にした。
- UI は React / Vite を入れず、TypeScript + CSS の単一ページにした。exFAT の作業コピーで依存を増やさず、`hy web` と Electron が同じ資産を使えるため。DSH のスロット / プラグイン UI 体系までは再現しない。
- 起動 URL のトークンを HttpOnly Cookie に交換する。`EventSource` はヘッダーを付けられないため、Cookie 認証が必要だった。
- セッションログの投影は `projectChat` に集約し、ツール結果は callId ではなく**ログの出現順**で引数と対応付ける。`step/end` が `assistant/message` より先に書かれるため、step 番号からの callId 推定は外れる。ライブ表示は callId で更新する。
- `AgentOptions.callIdPrefix` を追加し、ライブのツール呼び出し ID をターンごとに一意にした。以前は `step-1` がターンをまたいで衝突し、前のターンのツールカードを更新していた。
- Verifier loop は `hy ralph` を子プロセスで起動し、stdout / stderr を GUI に流す。Ralph の状態機械を GUI 用に複製しないため。`--unattended-ok` を渡し、自動承認は GUI で明示したときだけにする。
- GUI の設定保存はユーザー `config.json` に限定し、反映は再起動とする。プロジェクト設定を GUI から書き換えると信頼境界が崩れるため。
- Browser / Desktop 自動操作は `@playwright/mcp` と `agent-desktop` の MCP プリセットを再利用し、GUI は `/api/sessions/:id/mcp-call` で直接呼ぶ。汎用 MCP プロキシにすると任意ツールを GUI から実行できてしまうため、`playwright` と `agent-desktop` の 2 サーバーだけに制限する。
- スマホアクセスは `hy web --tailscale` で Tailscale IPv4 にだけバインドし、起動 URL をそのまま開く方式にした。Funnel / パブリック公開は使わない。PWA マニフェストを同梱して「ホーム画面に追加」を可能にし、トークンは起動ごとに更新する（再起動後は新しい URL を開く）。
- モバイルではサイドバー / 右パネルを固定オーバーレイにし、本文は常にグリッド2列目に置く。`sidebar-collapsed` の 64 px グリッドがモバイルの 0 px 指定を上書きしていたため、状態クラスを含めた明示的な上書きにした。
- 永続PTYは `node-pty` + xterm.js を採用した。PTY は Web セッションごとに1つ保持し、SSE で出力・入力を同期する。モデルのツールには公開せず、GUI ユーザーだけが操作する。サンドボックス外でユーザー権限のシェルが動くため、UI に警告を表示し、単発コマンド（ポリシー準拠）とモードを分ける。サーバー終了時は全 PTY を破棄する。
- ブラウザ自動操作の既定を Chrome にした（2026-11-03、ユーザー指示）。`automation.browser.browser` の既定値と Settings の未指定時を `chrome` に揃え、Chrome 156 で起動を確認する。

## 10. 作業記録の場所

- 2026-11-02〜11-11（§4〜§5.86）の詳細な作業記録・調査ログ・比較結果は [docs/history/project-log-2026-11.md](docs/history/project-log-2026-11.md) に移した（2026-11-11、内容は変更なし）。この文書が 383KB に達し、作業開始時に全体を確認できなくなったため。
- 本文書には、目的と成功条件、設計判断、現在の状態、未解決事項、再発しうる問題だけを置く。新しい作業は §12 以降に追記し、文書が再び肥大化したら同じ方法で履歴に移す。
- 本文中の §4〜§5.86 は履歴ファイルの節番号を指す（重複を避けるため、本文書の新しい節は §10 から始める）。

## 11. 現在の状態（2026-11-11 時点）

- 構成: Rust の実行デーモン（`hy-exec-server`、Windows 専用。サンドボックス・ジョブ・パッチ・チェックポイント）、TS の `core`（エージェントループ、5 系統のプロバイダ適応、応答の修復、ツール）、`seams`（圧縮・予算・Guardian・ralph）、`hy-cli`（CLI・Web/Electron GUI・オーケストレーション）、`bench`（DSH との比較）。
- モデル固有の情報（価格・窓・能力）はハーネスに持たず、ユーザーが `config.json` の `models[]` に登録する方針（§5.83）。`hy models probe --save` で実測値を登録できる（§12）。
- 単体テスト: Linux + Node 22 で 790 件中 787 件成功。残る 3 件は環境由来（Windows の `.cmd` シム、`soffice` 不在、Node 22 での承認タイムアウト試験）。Windows + Node 24 の CI が正。

## 11.1 未解決事項と次の作業

- **実機での確認待ち（Windows）**: §12・§13 の変更はすべて単体テストまでの確認。§13 では特に、永続シェルの修正（B14）、Anthropic のストリーミング（`role.streaming: true` で有効化し、実 API で確認後に既定化を判断）、Responses のストリーミングの実画面表示。結合テスト（`pnpm test:integration`）、Web GUI の実画面（検証サマリーの通知、状態行の料金）、オーケストレーションでのワーカーの段階起動とキャッシュ命中率、`hy models probe` の実 API での結果は未確認。
- **実ログでのリプレイ**: `pnpm eval:replay` を手元の `session.v1.jsonl`（testHY の各実行など）にかけ、検証ゲートと停滞検知がどの実行のどこで作動するかを確認する。多発するなら `guards.stallSteps` の既定（8）や検証ゲートの対象を見直す。
- **Group B の保留分**（§13）: B3-2 の既定値（Grader `low` の実測と、Guardian の難読化コマンド集での比較が先）、Gemini のストリーミングと画像入力（このセッションから公式ドキュメントに届かず形式を確認できない）、B12 の親用下限・同時実行配分、B13 ワーカー別 worktree、B18 巨大ファイル分割（Phase 1 は `app.ts`）。見送り: B1・B2・B4-2（行番号）・B15・B16・B12 の `finalSchema` 強制。
- **既存の残件**（§5.83〜5.86 から継続）: Web UI の既定値の重複（G-17）、`[DONE]`/`finish_reason` 欠落の許容（安全側で見送り中）、BOM・非 UTF-8・symlink、役割別プロンプト、設定 JSON の警告、hooks/skills の検証、プロキシ、価格・互換フラグの GUI 登録、実 400 による適応リトライの実走確認。
- **改善案の残り**（2026-11-11 に提示した 40 件のうち未着手）: A2 strict スキーマ、A3 プロトコル選択の永続化、A4 編集後の自動診断、A8 リポジトリマップ、A10 effort の段階調整、A11 フェイルオーバー、A12 ツール束の固定、A13 Gemini 画像、A15 修復規則の発火統計、B6 圧縮タイミング、B7 引き継ぎ要約、B8 オーケストレーション採否の提示、B9 ツール別出力予算、C3 委任の構造化、C4 ワーカー別 worktree、C5 親コンテキストの節約、C6 オーケストレーター適性、D4〜D8、E3 プロキシ、E5 署名、E6 文字コード、F2〜F4、F7。
- **承認が必要なもの**: E4（NTFS でのサンドボックスの既定化）と F6（`web-server.ts` 6,300 行・`app.ts` 7,300 行の分割）は既存の設計判断を変えるため、ユーザーの承認後に着手する。

## 11.2 再発しうる問題と対策

- **キャッシュの先頭が崩れる**: 履歴の書き換え（圧縮・古い結果の短縮・再起動時の再構築）やシステムプロンプト・ツール一覧の変更で、以後の入力がすべて未キャッシュになる（§5.62・5.63・5.70）。原因は `step/end.prefix`（何件目まで同じで、最初に変わったのが system・tools・履歴のどれか）で特定する（§12）。
- **既定値が未登録モデルを止める**: 予算上限の既定値が価格未登録のモデルでセッションを起動不能にした（§5.71）。上限や検証は「明示設定時のみ」「価格が登録されたモデルのみ」に効かせる。
- **モデル切り替えが別の役割の設定まで書き換える**: 親のモデルをワーカーの既定に保存した（§5.72）。保存先は役割からサーバーが決める。
- **ポータブル版の二重起動で更新ファイルが消える**: 同じ展開先を共有していた（§5.82）。`portable.unpackDirName: true` を維持する。
- **環境変数がプロセスに継承されない**: Windows の User スコープの変数は既存プロセスに届かない（§5.83）。実 API の確認時は明示的に読み出して渡す。
- **結合テストが環境で起動しない**: 制限付きサンドボックスでは `spawn EPERM`、Linux では実行デーモンがビルドできない（Windows API 依存）。単体テストで確認できる形（純粋関数・小さなモジュール）に切り出してから結合テストを Windows で回す。
- **再生成した生成物が古い**: `gen:config-schema` は `core` のビルド出力から生成する。ソース変更後は先にビルドしてから生成する（§12 で一度発生）。

## 12. 2026-11-11 ハーネスによる補助と制御の強化（改善案の実装）

- **目的**: 構造・履歴・詰まっている点を踏まえて提示した改善案 40 件から、効果が大きく、この環境で検証できるものを自分で順に選んで実装する（ユーザー指示）。
- **成功条件**: 各項目に単体テストを付け、既存テストを壊さないこと。型検査・生成物の差分検査が通ること。挙動を変える制御は設定で無効化できること。
- **実装（コミット順）**:
  - A6/D1 検証ゲートと検証サマリー（`progress.ts`）: コード編集の後に検査がないまま最終回答したら 1 回だけ差し戻す（文書だけの編集は対象外）。ターン末に変更ファイルと実行した検査を `turn/verification` に記録し、GUI の回答の下に「検証済み/検証失敗/未検証」を表示する。`guards.verifyGate` で無効化できる。
  - A5 停滞の段階エスカレーション: 成功した編集も新しい結果もないステップが N 回続いたら方針転換の注記、2N 回で強い注記（`ask_user` があれば質問を促す）、3N 回でターンを止める。既定 N=8、`guards.stallSteps`（0 で無効）。同一呼び出しの抑止や循環検知では捕まらない「形を変えて失敗し続ける」ケースが対象。
  - A14 シェルの注意喚起: 終了コード 0 でも PowerShell のエラーレコード、HTTP 4xx/5xx、curl のエラー、Python の Traceback が出ていれば `attention` を付ける。結果はエラーにせず、検証サマリーでは失敗として扱う。
  - A9 `edit_file` の不一致: 空白だけが違う場合は、ファイル中の実際の行（行番号付き）か最も近いブロックを返す。自動適用はしない。
  - A7 検証コマンドの自動発見（`project-checks.ts`）: `package.json`（ロックファイルから pnpm/yarn/bun/npm を判定）、`Cargo.toml`、`go.mod`、pytest/ruff/mypy の設定、`Makefile`、`deno.json` に宣言された検査をセッションコンテキストに載せる。ソースからの推測や実行はしない。
  - B5 キャッシュ破壊の診断: `step/end` にツール一覧のハッシュと、直前のリクエストとの共通メッセージ数・最初に変わった部分を記録する。ベンチの集計も原因別に数える。
  - E1/E2 秘密情報: モデル送信前の伏字と `git_commit` の検査を、GitHub 以外の主要サービスの鍵、PEM 秘密鍵、URL・ヘッダーの認証情報、資格情報らしい環境変数の値そのものに拡張。JWT や `password = "..."` はテストでの誤検出が多いため対象外（GUI の表示用マスクのみ）。
  - C1 ワーカー完了の証拠: `STATUS: done` の報告に、ホストが記録した変更ファイルと検査結果を添える。最後の編集後に検査がない、または最後の検査が失敗している場合は、受け入れ前の確認を促す。ステータス自体は変えない。
  - C2 終了理由: `turn/error.cause` に、誰が止めたか（ユーザー・オーケストレーション停止・ワーカー停止/クローズ・チャット削除・終了処理）か、何が失敗したか（予算とその次元・Guardian・プロバイダと HTTP 状態・コンテキスト超過・実行デーモン）を記録する。中断理由は `abort()` の引数ではなくセッションに書く（`fetch` の失敗の形を変えないため）。
  - B1 料金表示と対話セッションの上限（`cost.ts`）: 登録価格からの料金の目安を状態行に表示（既定で表示。価格未登録なら非表示、キャッシュ内訳がなければ上限値として「≤」）。明示した `budget.maxCostUsd` を対話セッションにも適用する（価格が登録されたモデルのみ。使用額はログの使用量から再計算するので再起動で戻らない）。
  - A1 能力プローブ（`model-probe.ts`、`hy models probe [--role R] [--no-vision] [--save] [--json]`）: テキスト・ネイティブ呼び出し・1 応答内の 2 呼び出し・赤青の小画像を送って実測し、`--save` で `models[].capabilities` に保存する。障害（5xx 等）は「非対応」と記録しない。G-7 として `usesNativeTools` が登録済みの `capabilities.tools` を見るようにした。
  - F1 保存ログのリプレイ（`replay.ts`、`pnpm eval:replay`）: ログの応答とツール結果を再生して現在のコードで Agent を走らせ、判断の列（ツール実行・差し戻し理由・停止・完了）を比べて最初の分岐点を報告する。差し戻した応答本文を `turn/retry.rejected` に残すようにし（`rebuildHistory` は無視）、再生不能な区間を減らした。
  - B4 ワーカーの段階起動（`worker-warmup.ts`）: 新しいワーカーは直前の新規ワーカーの最初の応答を最大 8 秒待ってから開始し、共通の先頭部分をキャッシュから使えるようにする。
  - D2 エラーへの対処案内: 予算切れ、Guardian、コンテキスト超過、実行デーモン停止、プロバイダの 401/403・402・404・429・5xx に 1 行の案内を付ける。
  - F5 本文書の整理（§10・§11）。
- **計画からの変更**: 当初の順序（A6/D1 → A5 → A14 → A7 → A9 → B5 → E1 → C1/C2 → B1 → A1 → F1 → F5）に、効果のわりに小さい G-7・B4・D2 を追加した。E4・F6 は承認が必要なため未着手。
- **検証（Linux + Node 22、この環境）**: `tsc -b`（core/seams/hy-cli/sdk）、web・desktop の型検査、`check:api`・`check:api-schema`・`check:config-schema`・`check:protocol-methods`・`check:protocol` がすべて成功。単体テスト 790 件中 787 件成功（新規 33 件。残る 3 件は作業前からの環境由来）。`hy models probe --mock` と `--save`、`pnpm eval:replay` をサンプルログで実行して動作を確認。
- **未検証**: 実行デーモンが Linux でビルドできないため、結合テストと GUI の実画面は未実施。実 API（プローブ、料金、ワーカーの段階起動によるキャッシュ命中率）も未確認。§11.1 の「実機での確認待ち」を参照。

## 13. 2026-11-13 Group B（B1〜B18）の検証結果に基づく実装

- **経緯**: 外部から提示された改善案 B1〜B18 を、現行コードで前提を確認して「無条件」「要検証」「見送り」に分類した。ユーザーが要検証 11 件を実機・実 API で検証し（Windows サンドボックス、Gemini/OpenAI/DeepSeek の実 API、Guardian 10 件・Grader 6 件の A/B）、その結果から実装範囲を決めた。Anthropic は API キーがなく未検証。
- **成功条件**: 承認した範囲だけを実装し、各項目に単体テストを付ける。会話履歴・API 送信・キャッシュの先頭を変える変更は入れない（B7 はログと画面だけ）。未検証の経路（Anthropic のストリーミング）は既定で無効にする。
- **実装（コミット順）**:
  - B17: SDK・ACP では `ask_user` を出さない（質問文がそのまま返答として返っていた）。
  - B3-2 ①: Guardian・ralph の Grader・ゴールの Grader がロールの effort を送る（設定が無視されていた）。既定値は変えていない。
  - B14: 読み書きに失敗した永続シェルを閉じる（`$/cancelRequest` ではデーモンの同期 `shell/read` が止まらない）。ポリシーが別のサンドボックスを指定したコマンドは承認前にワンショットへ回す。開けなかった理由は 1 回だけ伝える。
  - B11: `hy doctor` は想定済みのギャップ（常設 5 種と non-ACL ボリューム）を `ok` のまま、`deny-read-failed`・`read-only-failed`・未知のギャップだけ `warn` にする。
  - B8: 最後の編集後の検査が失敗したまま完了しようとしたら 1 回だけ差し戻す（未検査の差し戻しと合わせて 1 ターン 1 回）。失敗したシェル結果にも終了コードを残す。
  - B12（圧縮）: 委任したサブエージェントにもセッションと同じ spill・圧縮（サブエージェントのモデルの窓で）。
  - B7: ネイティブ呼び出しに併記された文章を `assistant/message.prose` に記録し、画面とリプレイで使う。履歴と送信は呼び出しのみのまま。
  - B9: ワークスペース（pnpm・npm/yarn/bun workspaces・Cargo・go.work）で、編集したパッケージの検査を絞り込み形式で先頭に出す。一覧は該当パッケージの集合が変わったときだけ作り直す。
  - B5: `worker` バンドルに `lsp` を追加。
  - B10: ベンチのレポートにサブエージェント分と合計の行を追加（既存行は不変）。
  - B4-1: 8 MB 超のファイルは分割して読む。ハッシュと行数は全体のまま。全体読みとの一致を文字コード・改行・範囲・チャンク長の組み合わせで確認。
  - メモリ抽出: 要約役の effort を使い、既定は `none`。
  - B3-1: Responses は既定で、Anthropic は `role.streaming: true` のときだけストリーミング。イベントから非ストリーミングと同じ本体を組み立てて既存の解析関数に渡す。ループの早期停止つき。Gemini の `status: incomplete` を出力上限として扱う。
  - B6・B12（予算）: 見積もりにツール定義を含め、実行中のリクエストを予約として計上する（並列で上限を超えない）。USD 上限下の予約を窓まるごとから見積もり×1.5（窓が上限）に変更。キャッシュ割引を前提にした許可は入れていない（上限を保証できないため）。
- **計画からの変更**: Gemini のストリーミングと画像入力は見送った。ai.google.dev がこのセッションのネットワーク設定で遮断され、検索で得たイベント名も出典ごとに食い違っていたため。
- **検証（Linux + Node 22）**: 型検査（全パッケージ・Web・デスクトップ）と生成物の差分検査が成功。単体テスト 813 件中 810 件成功（残る 3 件は作業前からの環境由来）。ストリーミングはローカルの SSE スタブサーバーで、行の途中で分割された配信も含めて確認した。
- **未検証**: 実行デーモンが Linux でビルドできないため、B14 の実機動作と結合テスト。Anthropic の実 API でのストリーミング。Web GUI の実画面（B7 の文章表示、Responses の逐次表示）。

