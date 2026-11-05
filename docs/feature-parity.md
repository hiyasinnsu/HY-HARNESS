# HY-HARNESS と Codex / DeepSeek Harness の機能比較

- **対象**: OpenAI Codex CLI（`openai/codex`）と DeepSeek Harness（`deepseek-ai/deepseek-harness`、以下 DSH）
- **日付**: 2026-11-03（HY-HARNESS は Phase 8 の後の追加実装まで）
- **根拠**: Codex と DSH の機能は、調査フェーズで取得した一次ソース（`C:\Users\川野創太\research\hy-harness\sources\`）の行番号で示す。行番号のない項目（Codex の TUI、`resume`、`/undo`、`/review`、`/init`、update_plan、notify、`--full-auto`、Web 検索、unified exec）は、本文を取得していない公開機能名によるもので、一次ソースでは確かめていない。HY-HARNESS の機能は、それを確かめるテストで示す。
- **結論**: 下の表のとおり、両者のコーディングエージェントとしての機能の大部分は HY-HARNESS にもある。2026-11-03 に **DSH 準拠の Electron デスクトップ GUI と `hy web`** を追加し、セッション、チャット、ツールカード、承認、右パネル、ゴール、プラン、ジョブ、サブエージェント、MCP/プラグイン/メモリ、Trace、Verifier loop、スケジュール / Webhook、ブラウザ / デスクトップ操作、永続PTY、Tailscale 経由の個人端末アクセスを GUI から使える。一方で、**プラグインマーケット / Creator mode、SSH 先での実行、クラウド、マルチユーザー / パブリック公開、IDE 拡張**は 2026-11-03 にユーザー承認済みの対象外である。Linux / macOS のサンドボックスとネットワークの閉じ込めは引き続き未実装のギャップである（§3）。したがって「DSH の全機能に対する完全な上位互換」とは**言えない**。言えるのは「承認済みスコープにおいて DSH 準拠の Windows 10 ローカル CLI + デスクトップ GUI エージェント」である。
- **更新（2026-11-05）**: 本書の Codex 側の記述は 2026-11-03 時点の一次資料に基づく。同日後に Codex のコード全体（`main`、`c903541`）を再分析した結果と、**119 件の不足リスト・実装計画**は [codex-gap-analysis.md](codex-gap-analysis.md) と [codex-adoption-plan.md](codex-adoption-plan.md) を参照。Codex 側の記述が食い違う場合は新しい分析を優先する。

## 1. 両者の主要機能と HY-HARNESS の対応

| 機能 | Codex（根拠） | DSH（根拠） | HY-HARNESS | 確認しているテスト |
| :--- | :--- | :--- | :--- | :--- |
| 対話セッション | TUI | Web UI（`dsh_readme.md:24-27`） | `hy chat`（行単位の REPL）、Electron デスクトップ、`hy web` | `chat-resume.test.mjs`、`web-ui.test.mjs` |
| デスクトップ / Web GUI | IDE 連携、app | Web UI、Desktop（`dsh_readme.md:24-27`） | Electron 3 カラム GUI（セッション、チャット、ツールカード、承認、Files / Diff / Plan / Details / Trace、設定、ゴール、Verifier loop）。`hy web` も同じ UI | `tests/integration/web-ui.test.mjs`、`pnpm desktop:screenshot` |
| 非対話実行と機械可読出力 | `codex exec`（`codex_docs_tree.md:103`） | CLI モード | `hy run --json`（JSONL のイベント）、`--output-last-message`、`--output-schema`（JSON Schema で最終出力を検証） | `chat-resume.test.mjs`、`commands.test.mjs`、`packages/core/src/agent.test.ts` |
| セッションの再開・一覧・検索 | `codex resume` | session / session-query（`dsh_pkg_readme.md:70`） | `hy resume <run-id>`/`--last`、`hy sessions [--search]` | `chat-resume.test.mjs` |
| ターン単位の取り消し | `/undo` | — | `/undo`（ターン前のチェックポイントへ戻し、会話からも消す）、`hy undo <run-id>` | `chat-resume.test.mjs` |
| AGENTS.md の階層読み込み | `agents_md.rs`（`codex_core_agents_md_rs.md:1-18`） | context（`dsh_pkg_readme.md:53`） | ユーザーの `AGENTS.md`、git ルートから作業ディレクトリまで、各ディレクトリで `AGENTS.override.md` 優先（Codex と同じ規則） | `packages/core/src/ledger.test.ts` |
| スキル | `docs/skills.md`（`codex_docs_tree.md:131`） | skill（`dsh_pkg_readme.md:51`） | `SKILL.md`（ユーザー、`.hy-harness/skills`、`.agents/skills`）、カタログはプロンプトに 1 行ずつ、本文は `skill_load` | `packages/core/src/skills.test.ts` |
| カスタムプロンプト / スラッシュコマンド | `docs/slash_commands.md`（`codex_docs_tree.md:135`） | — | `prompts/<name>.md` を `/name args` で（`$ARGUMENTS`、`$1`〜`$9`） | `commands.test.mjs` |
| 計画ツール | update_plan | todo_write（`dsh_pkg_readme.md:62`） | `update_plan`、`/plan` | `chat-resume.test.mjs`、`tool-registry.test.ts` |
| 計画モード | — | plan（`dsh_pkg_readme.md:63`） | `/plan-mode`（読むだけ、ユーザーが解除するまで書けない） | `commands.test.mjs` |
| ユーザーへの質問 | — | interaction の ask-user（`dsh_pkg_readme.md:77`） | `ask_user`（対話時だけ提供） | `commands.test.mjs` |
| MCP クライアント | `mcp_tool_call.rs`（`codex_core_tree.md:451`） | mcp（`dsh_pkg_readme.md:68`） | stdio の MCP（ページング、読み取り専用ヒントと信頼済みサーバーは承認なし、ほかは承認） | `packages/core/src/mcp.test.ts`、`tests/integration/mcp.test.mjs` |
| MCP サーバー（他のエージェントから使う） | app-server（`codex_rs_tree.md:111-129`） | sdk / acp（`dsh_pkg_readme.md:75-76`） | `hy mcp-server`（`hy_run`、`runId` で会話を継続） | `tests/integration/mcp-server.test.mjs` |
| サブエージェント | `multi_agent_tool.rs`（`codex_tools_tree.md:171`） | subagent（`dsh_pkg_readme.md:54`） | `delegate`（既定は読み取り専用、再帰なし、`run_code` から並列） | `tests/integration/subagent.test.mjs` |
| コードレビュー | `/review` | — | `hy review [--base]`、`/review`（読み取り専用のサブエージェント） | `commands.test.mjs` |
| AGENTS.md の生成 | `/init` | — | `/init` | `commands.test.mjs` |
| 手動コンパクション、モデル切り替え | `/compact`、`/model`（`compact.rs`: `codex_core_tree.md:263`） | compaction（`dsh_pkg_readme.md:52`） | `/compact`、`/model` | `commands.test.mjs` |
| フック / 通知 | `hook_runtime.rs`（`codex_core_tree.md:415`）、notify | フックのプラグイン | `preToolUse`（終了コード 2 でブロック）、`postToolUse`、`turnEnd`、Codex 方式の `notify` | `tests/integration/hooks.test.mjs` |
| Web の取得・検索 | Web 検索 | web の search/fetch（`dsh_pkg_readme.md:58`） | `web_fetch`（opt-in、許可ドメイン以外は承認）、`web_search`（ユーザーが設定した SearXNG 形式の検索先） | `packages/core/src/web.test.ts`、`tests/integration/web.test.mjs` |
| LSP | — | lsp（`dsh_pkg_readme.md:50`） | `lsp`（定義、参照、ホバー、診断、シンボル。拡張子ごとにユーザーが設定） | `packages/core/src/lsp.test.ts`（偽の LSP サーバー） |
| 画像入力 | `image_preparation.rs`（`codex_core_tree.md:419`） | attachment（`dsh_pkg_readme.md:60`） | `--image`（Ollama と OpenAI 互換。Gemini は未対応） | `packages/core/src/llm.test.ts`（契約テストのみ） |
| ネイティブな関数呼び出しと並列呼び出し | あり | あり | Ollama・OpenAI 互換・DeepSeek で既定（Gemini はテキストのプロトコル）。1 ステップの複数呼び出しは、読み取りだけなら並列 | `agent.test.ts`、`llm.test.ts`（Ollama は実記録）。Ollama `qwen2.5:3b` で実走 |
| 繰り返し呼び出しの注意 | — | guard の repeat-tool-reminder（`dsh_pkg_readme.md:65`） | `RepeatToolReminderGuard` | `agent.test.ts` |
| 設定プロファイル | config のプロファイル（`codex_docs_tree.md:91`） | bundle の `--profile`（`dsh_pkg_readme.md:66`） | `--profile <name>`（ユーザー設定の `profiles`） | `packages/core/src/config.test.ts` |
| 承認の自動化 | `--full-auto` | 権限プリセット | `--full-auto`（workspace-write で閉じ込めて走るものだけ自動承認）、`--yes`、Guardian | `packages/seams/src/guardian.test.ts` |
| 実行ポリシー | Starlark の execpolicy（`codex_docs_tree.md:107`） | 権限ポリシー | Starlark（読み込み時の match / not_match テストつき） | `crates/hy-execpolicy` |
| 自動判定によるレビュー | `guardian_review.rs`（`codex_core_tree.md:403`） | — | Guardian（unconfined は承認しない、3 回で停止） | `guardian.test.ts`、`tests/integration/guardian.test.mjs` |
| プログラムからのツール呼び出し | code mode（`code_mode_host.rs`: `codex_core_tree.md:231`） | ptc-runtime | `run_code`（AppContainer の中の Node） | `tests/integration/ptc-appcontainer.test.mjs` |
| 長い出力の退避とコンパクション | compact | spill / compaction（`dsh_pkg_readme.md:52, 61`） | spill、2 段のコンパクション、固定制約と上限つきメモ | `spill-compaction.test.ts`、`ledger.test.ts` |
| バックグラウンドジョブ | unified exec | jobs（`dsh_pkg_readme.md:55`） | 5 秒で自動的にジョブ化、`tools.jobs.*` | `crates/hy-exec-server` のテスト |
| 目標までの反復 | — | ralph（自己申告で終了: `dsh_tool_ralph.md:12`） | `hy ralph`（独立した検証ゲート 2 段、4 次元の予算、ラウンドごとのロールバック） | `tests/integration/verifier-ralph.test.mjs` |

## 2. HY-HARNESS が上回る点

- **完了判定の検証**: DSH の ralph は「worker の報告は独立に検証されない」（`dsh_tool_ralph.md:12`）。HY の `hy ralph` は、検証コマンド（Gate 1）と別モデルの grader（Gate 2）が通るまで終わらない。改ざん検査、4 次元の予算（ラウンド、トークン、USD、時間）、ラウンドごとのロールバックもある。
- **Windows 10 のサンドボックス**: Codex の Windows コンテナ（MXC）は Windows 11 24H2 以降（`dsh_note_sandbox_win.txt` が引く mxc の方針）。DSH は Windows 10 で動くが、報告されている穴（pipe の EPERM、ハードリンク、全体への ACL 伝播）がある。HY は同じトークン構成で、ハードリンクの除外、`.git` の保護、付与の記録と取り消しを加えた（ADR 0001）。
- **コンパクションを越えて残る制約**: AGENTS.md と `--rule` は要約に入れず、毎回そのままプロンプトに入れる。モデルのメモは上限つきで、上限では黙って捨てずに拒否する。
- **ターン単位のチェックポイント**: 対話の各ターンの前に git ref のチェックポイントを作り、`/undo` で無関係なファイルの更新日時を変えずに戻す（ロールバックは 1 万ファイルで約 265 ms）。
- **プロンプトの節約**: ツールの説明とスキル・MCP のカタログは、その機能があるときだけ載せる。既定のツールと SDK で約 1,140 トークン（上限 1,200）。

## 2.1 GUI の機能対応（DSH Web UI / Desktop との比較）

| GUI 機能 | DSH | HY-HARNESS | 根拠 |
| :--- | :--- | :--- | :--- |
| 3 カラム（サイドバー / 会話 / 右パネル） | あり | あり | `packages/hy-cli/web/styles.css` |
| セッション一覧・検索・実行中表示 | あり | あり | `web-ui.test.mjs`、`screenshots/desktop.png` |
| セッションのピン留め / アーカイブ | あり | あり（`ui-state.json` に永続化、アーカイブ表示切替） | `web-ui.test.mjs` |
| チャット・Markdown・コード | あり | あり | `markdown.ts`、`web-ui.test.mjs` |
| ツールカード（読み・編集・シェル・検索・委譲・MCP） | あり | あり | `tool-registry` の全ツール、`web-ui.test.mjs` |
| 承認 / 拒否 / `ask_user` | あり | あり | 承認カード、`web-ui.test.mjs` |
| ファイルツリー・プレビュー・差分 | あり | あり（Files / Diff） | `/api/files/*`、`/api/sessions/:id/diff` |
| 設定（モデル、サンドボックス、プラグイン、メモリ、Web） | あり | あり（保存は再起動で反映） | `/api/settings`、`web-ui.test.mjs` |
| ワークスペース選択 | あり | あり（Electron の最近使った一覧 + ネイティブダイアログ） | `packages/desktop/src/main.ts` |
| ゴール / プランモード / モデル切替 | あり | あり | `/api/sessions/:id/goal`、`plan-mode`、`model` |
| スラッシュコマンド | あり | あり（`/help` に一覧） | `app.ts` |
| 画像添付 | あり | あり（png/jpeg/webp/gif、最大 8 枚） | `/api/sessions/:id/turn` の `images`、`web-ui.test.mjs` |
| `@file` 参照 | あり | あり（候補検索 + 挿入） | `/api/files/search` |
| バックグラウンドジョブ | あり | あり（Details の Jobs、出力 / kill） | `/api/sessions/:id/jobs` |
| サブエージェント | あり | あり（Details の Subagents と子トランスクリプト） | `/api/sessions/:id/subagents` |
| MCP / プラグイン / ワークスペースメモリのカタログ | あり | あり（Details） | `/api/sessions/:id/mcp|plugins|memory` |
| プラグイン管理 / 再読み込み | あり（マーケット + 有効化） | あり（Settings でパス編集、再読み込み、Electron のファイル選択、読み込み済みツール / エラー表示。マーケットはなし） | `/api/plugins`、`web-ui.test.mjs` |
| Browser / Terminal / Desktop 右パネル | あり | あり（iframe プレビュー + Playwright 自動操作 / 永続 PTY + 単発コマンド / agent-desktop） | `app.ts`、`pty.ts`、`/api/sessions/:id/mcp-call` |
| 多言語 UI | あり（英語 / 中国語） | あり（English / 日本語 / 中文、自動判定 + Settings で切替） | `i18n.ts`、`screenshots/desktop.png` |
| 生の実行トレース | あり（Trajectory） | あり（Trace タブ） | `/api/sessions/:id/trajectory` |
| Verifier loop（Ralph） | あり | あり（GUI から `hy ralph` を起動、出力を表示） | `/api/ralph`、`web-ui.test.mjs` |
| デスクトップ通知 | あり | あり（ウィンドウが非アクティブのとき） | preload `notify` |
| テーマ（ダーク / ライト） | あり | あり | `styles.css` |
| プラグインマーケット / Creator mode | あり | なし（プラグインは設定のモジュールパス） | §3 |
| スケジュール / Webhook | あり | あり（cron + Webhook の CRUD / 実行 / 履歴） | `/api/automation`、`cron.test.ts` |
| ブラウザ / デスクトップ操作 | あり | あり（Playwright MCP / agent-desktop MCP、GUI から操作） | `automation-mcp.test.mjs`、`screenshots/browser-automation.png` |
| 永続 PTY | あり | あり（node-pty + xterm.js、Terminal タブの永続シェル） | `pty.ts`、`web-ui.test.mjs`、`screenshots/terminal-pty.png` |
| SSH 先での実行 | あり | なし | §3 |
| クラウド実行 / マルチユーザー / パブリック公開 | あり | なし（Tailscale 経由の個人端末アクセスは可） | §3 |
| IDE 拡張 | あり（Codex） | なし（`hy mcp-server` で代替） | §3 |
| コマンドパレット | あり | あり（Ctrl+K、コマンドとセッション） | `app.ts` |
| 多言語 UI | あり（英語 / 中国語） | あり（English / 日本語 / 中文） | `i18n.ts` |

## 3. HY-HARNESS にないもの（上位互換と言えない理由）

2026-11-03 のユーザー承認により、プラグインマーケット / Creator mode、SSH 先での実行、クラウド実行、マルチユーザー / パブリック公開、IDE 拡張は対象外として確定した。ローカルの永続PTY、ブラウザ / デスクトップ操作、スケジュール / Webhook、Tailscale 経由の個人端末アクセスは実装済みである。

| 機能 | Codex / DSH | HY-HARNESS | 理由・扱い |
| :--- | :--- | :--- | :--- |
| Web UI、デスクトップアプリ、IDE 拡張 | DSH の Web UI（`dsh_readme.md:24-27`）、Codex の IDE / app（`openai_codex_readme.md`） | **Electron デスクトップと `hy web` を実装済み**（IDE 拡張はなし） | GUI は [desktop-gui.md](designs/desktop-gui.md)。IDE からは `hy mcp-server` で使える |
| 全画面の TUI | Codex | 行単位の REPL | 機能（コマンド、承認、再開）は REPL で提供 |
| Linux / macOS のサンドボックス | Codex の linux-sandbox（`codex_rs_tree.md:363`）、DSH の bwrap / Landlock / Seatbelt（`dsh_pkg_readme.md:47`） | Windows のみ | Windows 10 を第一とする設計。ほかの OS では `unconfined` のみ |
| ネットワークの閉じ込め | Codex の network-proxy（`codex_rs_tree.md:411`）、network_approval（`codex_tools_tree.md:179`） | `shell` のネットワークは閉じ込めない（`enforcement-gaps.md` S2） | `web_fetch` は承認制。シェルのコマンドは既定ポリシーで承認制 |
| クラウド実行、ChatGPT ログイン | Codex の cloud-tasks、login | なし | 対象外（ローカルのエージェント） |
| ブラウザ・デスクトップ操作 | DSH の computer-use / browser-use（`dsh_pkg_readme.md:45-46`） | **実装済み（opt-in）**: Browser の Playwright モードと Desktop の agent-desktop モード。Windows のみ | `@playwright/mcp` / `agent-desktop` を MCP プリセットとして利用 |
| SSH 先での実行 | DSH の ssh（`dsh_pkg_readme.md:41, 43`） | なし | 未実装（ローカルの永続PTYは実装済み） |
| 予約した後続作業 | DSH の schedule（`dsh_pkg_readme.md:35`） | **実装済み**: cron スケジュールと Webhook | `/api/automation`、`cron.ts` |
| 実行時のプラグイン読み込み・自己改変 | DSH の extensions（`dsh_pkg_readme.md:67`、Cordis） | なし（seams はビルド時の構成） | 未実装 |
| セッションをまたぐ記憶 | Codex の memories（`codex_rs_tree.md:375`） | なし（ラン単位のメモと AGENTS.md） | 未実装 |
| Gemini のネイティブ関数呼び出しと画像 | — | テキストのプロトコル、画像は拒否 | 手元の一次ソースに関数呼び出しの形がない |
| 実モデルでの確認 | — | Ollama `qwen2.5:3b` のみ。DeepSeek（残高不足）、Gemini と OpenAI（鍵なし）は契約テストのみ | `enforcement-gaps.md` V4 |

## 4. 信頼の境界（追加した機能）

追加した機能のうち、プロセスの起動やネットワークを伴うものは、すべて**ユーザー自身の設定**（`%APPDATA%\hy-harness\config.json`）から来る。信頼していないプロジェクトの `.hy-harness/config.json` は MCP サーバーとフックを追加できない（`config.test.ts`、`mcp.test.mjs`）。詳細は [enforcement-gaps.md](enforcement-gaps.md) の §6。
