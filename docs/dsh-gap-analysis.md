# DeepSeek Harness（DSH）比較ギャップ分析 — HY-HARNESS が劣っている／不足している機能

- **日付**: 2026-11-04
- **比較対象**:
  - DSH: `deepseek-ai/deepseek-harness`（MIT、developer preview）。実機インストール版 **0.2.1-rc.3** のランタイム（`resources/app.asar` 内の `@deepseek-ai/*` **307 パッケージ**と各 README）＋ GitHub `master` の `README.md` / `docs/user/guide/*` を一次資料とした。
  - HY-HARNESS: 本リポジトリ（`F:\HY-HARNESS`）の 2026-11-04 時点の実装。
- **前提**: 本レポートは **機能の有無と優劣のみ** を列挙する。HY-HARNESS が 2026-11-03 に「対象外」と承認した範囲のうち、DSH に実在するもの（プラグインマーケット/Creator、マルチユーザー/ピア共有、IDE 連携＝ACP）は依頼どおり「不足」として載せ、表の「区分」列に `対象外` と明記した。DSH に存在しない SSH 先実行・クラウド実行は比較対象外（下の注意を参照）。
- **重大度**: **A** = 体験・安全・拡張性の根幹に関わる／**B** = 明確な機能差／**C** = 軽微・運用・将来。
- **注意（DSH 側の事実確認）**: DSH 0.2.1-rc.3 には **クラウド実行** と **SSH 先でのリモート実行** のパッケージは存在しない（SSH は「SSH 経由で Web UI を起動し、クライアント側のポート転送で開く」対応のみ）。`docs/feature-parity.md` の「DSH は SSH 先実行・クラウドあり」という記述は DSH 側を過大評価している（§14 の参考資料と併せて確認）。

---

## 0. 総評

DSH は「**すべてがプラグイン**」を掲げる Cordis ベースの基盤で、307 パッケージが *seam（抽象）＋ backend（実装）＋ bundle（構成）* の三層に分かれ、**プロファイル（YAML パッチの積層）でアプリそのものを再構成**する。単一のコーディングエージェントではなく、**Web・Desktop・CLI（headless）・SDK（TS/Python）・ACP** の 5 サーフェスを同じコアから生み出す製品群である。

HY-HARNESS は Codex/DSH の「機能」を TypeScript/Rust に移植し、**Windows 10 のサンドボックス、ターン単位チェックポイント、検証ゲート付き Ralph、Guardian、オーケストレーション A+、MCP サーバ、LSP、永続 PTY、Tailscale 個人アクセス**など、DSH に無い／勝る機能も多い。一方で、**拡張基盤（プラグイン合成・型付き RPC・クライアント拡張）、実行中ステアリングと継続可能サブエージェント、プロバイダ基盤、セッション形式の進化、配備（TLS/リバースプロキシ/アクセス制御）、SDK/ACP、文書まわりの UI** が構造的に不足している。

### 機能量の比較（実測ベース）

| 指標 | DSH 0.2.1-rc.3 | HY-HARNESS（2026-11-04） |
| :--- | :--- | :--- |
| パッケージ数 | 307（`@deepseek-ai/*`、うち `dsh-*` 296・外部 11） | TypeScript 4 パッケージ＋Rust 4 クレート |
| モデル向けツール | 約 40（プリセットで増減） | 直接 14＋`run_code` 内 9（＋plugin/goal/orchestration 動的） |
| アプリ形態 | web / headless / sdk / sdk-minimal / acp / desktop（profile） | `hy` CLI 12 サブコマンド＋`hy web`＋Electron |
| GUI | クライアントプラグイン約 60、設定ページ 8 | 右パネル 8 タブ＋モーダル 10 |
| API | 型付き RPC（Typert）＋約 9 コントローラ＋30 超の Remote | 素の HTTP 13 グループ／約 30 サブエンドポイント |
| セッション形式 | v4（v0→v4 の 4 マイグレーション） | v1（JSONL、マイグレーションなし） |
| モデルプロバイダ | pi-ai カタログ（Anthropic/OpenAI/Kimi/GLM 等）＋DeepSeek 2 経路＋任意ゲートウェイ | 6（ollama/deepseek/openai-compatible/opencode/gemini/mock） |
| UI 言語 | en / zh（プラグイン辞書で拡張） | en / ja / zh |

### 集計

**111 項目を評価し、106 項目が「不足または劣位」**（A 21／B 40／C 45）。残り 5 項目は機能として同等だが、実装方式や周辺 UX に差が残るもの（Guardian と承認 seam、読み取り前編集、headless 実行、ブラウザタブなど）。

---

## 1. プラグイン基盤・構成（最大の構造差）

| # | DSH の機能 | DSH 根拠 | HY-HARNESS の現状 | 差分 | 重大度 | 区分 |
| :-- | :--- | :--- | :--- | :--- | :-- | :-- |
| P1 | プロファイル＝順序付きバンドルの YAML パッチ積層。`$DSH_HOME/profiles/<name>/` でアプリを再構成 | `dsh`, `dsh-app-boot`, `dsh-base`, `dsh-web-app` | 固定コードの seam。`--profile` はユーザー JSON の上書きのみ | アプリ構成そのものを差し替えられない | A | 未着手 |
| P2 | プラグインマネージャ（pnpm 連携で install/remove、有効化/無効化、設定ページ、更新） | `dsh-plugin-manager`, `dsh-client-ui-plugin-manager` | `config.json` の `plugins[]` にモジュールパスを書くのみ | 導入・更新・設定 UI がない | A | 対象外 |
| P3 | プラグインマーケット（ユーザー設定の索引 URL、検索、SemVer、互換性、Discover タブ） | `dsh-plugin-market`, `dsh-plugin-market-index`, `dsh-client-ui-plugin-market` | なし | マーケットなし | A | 対象外 |
| P4 | Creator モード（実行時 API 検査 `cordis_inspect_*`、Host/Client の動的プラグイン実行、review 可能な変更草案） | `dsh-tool-cordis`, `dsh-cordis-host-runner`, `dsh-cordis-client-runner`, `dsh-client-ui-entry-customization` | なし | 自己拡張できない | A | 対象外 |
| P5 | クライアントプラグイン機構（`dsh.client` 宣言→ブラウザ bundle、遅延 CJS、`__DSH_BOOT__`、スロット） | `dsh-client-modules`, `dsh-client-resources`, `dsh-client-hmr` | 単一の `app.ts`（UI フレームワークなし） | UI 拡張点がない | A | 対象外 |
| P6 | ホスト HMR（プラグイン/設定の即時反映、失敗時 `restart-required` 報告） | `dsh-hmr`, `dsh-config-editor` | 設定は「再起動で反映」と明記 | 反復速度で劣る | B | 未着手 |
| P7 | 型付き RPC（`@Remote`/`@RemoteScope`、生成スキーマ、コード付きエラー、ストリーム/アップリンク） | `dsh-typert-protocol`, `dsh-typert-registry`, `dsh-typert-loader`, `dsh-api-gateway` | 素の HTTP＋SSE、型は手書き | 契約の検証・生成・版管理がない | A | 未着手 |
| P8 | 設定 UI がプラグインのスキーマから自動生成（revision、競合検出、機密の伏字、volatile のみ） | `dsh-settings`, `dsh-client-ui-settings*` | 専用 UI（モデル/承認/サンドボックス等） | 新設定のたびに UI 実装が必要 | B | 未着手 |
| P9 | `--dump-config` / `--dump-config-schema` / 構成グラフ・設定カタログの自動生成 | `dsh`（reference）, `docs/config-catalog.md` | なし | 構成の可視化・検証がない | B | 未着手 |
| P10 | プラグインのバージョン互換性（`engines.dsh`、完全一致免除、取消、永続化） | `dsh-package-manifest`, `dsh-app-boot` | なし | 互換性破壊を検出できない | C | 未着手 |
| P11 | スコープ付き登録（エージェント/グループ単位の contribution と後始末） | `dsh-scope` | 手続き的な条件分岐 | プラグイン間の分離が弱い | C | 未着手 |
| P12 | 6 つのアプリプロファイル（web/headless/sdk/sdk-minimal/acp/desktop） | `dsh-web-app` ほか各 `*-app` | CLI＋web＋Electron のみ | SDK/ACP 面がない | A | 未着手 |

## 2. エージェントループ・協調

| # | DSH の機能 | DSH 根拠 | HY-HARNESS の現状 | 差分 | 重大度 | 区分 |
| :-- | :--- | :--- | :--- | :--- | :-- | :-- |
| E1 | **実行中ステアリング**: inbox への splice（挿入・編集・削除・claim）、次のステップ境界で反映、キャンセル時も配信済み本文を保持 | `dsh-agent`, `dsh-agent-loop` | ターン完了まで待つ**ターンキュー**（`/api/turn-queue`） | 走っているターンに割り込めない | A | 未着手 |
| E2 | **継続可能サブエージェント**: `subagent`/`subagent_fork`（親の完了ターンを seed）、`send_message`/`interrupt_agent`/`list_agents`、外部バックエンド（ACP/SDK/Codex/Claude Code）、`maxDepth`/`maxActiveSubagents` | `dsh-subagent`, `dsh-subagent-fork-in-process`, `dsh-subagent-spawn-in-process`, `dsh-tool-subagent-control` | `delegate` は一発実行・再帰なし。オーケストレーターの worker への `send` はあるが、子エージェントの継続・割り込み・一覧はない | 長時間の委譲に向かない | A | 未着手 |
| E3 | **Agent Teams**: Lead＋名前付き teammate、DM、永続共有タスクボード、cold resume、fork/spawn 選択 | `dsh-experimental-agent-team`, `dsh-experimental-tool-agent-team`, `dsh-experimental-client-ui-agent-team` | オーケストレーション A+（スコープ分担、レビュー、close 規律）で代替 | 共有タスクボードと対等メッセージがない | B | 実験的（DSH 側） |
| E4 | **`workflow` ツール**: モデルが JS を書き `agent()`/`parallel()`/`pipeline()`/`phase()` で多数のサブエージェントへ fan-out、`run_in_background`、構造化戻り値 | `dsh-workflow`, `dsh-tool-workflow`, `dsh-workflow-ptc` | なし（オーケストレーターは逐次） | 大規模並列の定型がない | A | 未着手 |
| E5 | エージェントプリセット（standard/ptc/minimal/cordis をセッション毎に選択、YAML 宣言、プリセット編集 UI） | `dsh-agent-preset*`, `dsh-client-ui-agent-preset` | ロール固定（worker/grader/…）と `--ptc` のみ | セッション毎の構成切替がない | B | 未着手 |
| E6 | native 関数呼び出しと PTC（`run_code`）の**エージェント単位切替** | `dsh-agent-tool-presentation` | プロセス全体の `--ptc` | 混在できない | B | 未着手 |
| E7 | 1 ステップの並列呼び出し上限（既定 10、exclusive 呼び出しは順序障壁） | `dsh-agent-loop` | 読み取り専用のみ並列 | 書き込みの並列度制御がない | C | 未着手 |
| E8 | `AGENTS.md`＋`CLAUDE.md` のユーザー/プロジェクト階層、バイト予算、fs 操作・再開時の再読込 | `dsh-agent-instructions` | `AGENTS.md`/`AGENTS.override.md`/`RULE.md` の階層（CLAUDE.md なし） | 互換ファイル名と予算がない | B | 未着手 |
| E9 | `todo_write`（毎回全置換、ターンをまたいで永続、UI 投影、並列 in-progress 可） | `dsh-tool-todo`, `dsh-client-ui-*`（todo 投影） | `update_plan`（in_progress 1 件まで、Plan タブ） | UI 投影と永続の作りが弱い | B | 未着手 |
| E10 | `ask_user_question` の **timed モード**（回答待ちでモデルを止めない、期限後も回答可能） | `dsh-tool-ask-user`, `dsh-user-questions` | 回答まで待つ | 非同期待ちがない | C | 未着手 |
| E11 | ペルソナ（プリセット別プレフィックス/サフィックス、`complete` で全置換） | `dsh-persona` | ロール別プロンプト | 人格の差し替えがない | C | 未着手 |
| E12 | time / tmux コンテキスト（時刻・経過・tmux ペイン位置） | `dsh-time-context`, `dsh-tmux-context` | 日付のみ | 経過時間・tmux 認識なし | C | 未着手 |
| E13 | ツール呼び出しの協調タイムアウト・ミドルウェア（`TOOL_TIMEOUT`） | `dsh-tool-call-timeout-policy` | ツール個別のタイムアウト | 統一ポリシーがない | C | 未着手 |
| E14 | コンテキスト管理の**分離された戦略**: 基本要約、画像オフロード（古い画像をパスに置換）、ツール結果プルーナ、統一 retention、トークンメーター | `dsh-compaction`, `-basic`, `-image-offload`, `-tool-result-pruner`, `dsh-output-retention`, `dsh-token-meter` | 2 段（spill→要約）＋ledger。画像はログに残したまま | 画像の文脈圧迫、計測の粒度で劣る | B | 未着手 |

## 3. モデル向けツール

| # | DSH のツール／機能 | DSH 根拠 | HY-HARNESS の現状 | 差分 | 重大度 | 区分 |
| :-- | :--- | :--- | :--- | :--- | :-- | :-- |
| T1 | `read` / `write` / `edit` の 3 分割（行番号付き read、アトミック書込、安定エラーコード）＋**読み取り前編集ポリシー** | `dsh-tool-fs`, `dsh-fs-observation-policy` | `read_file`＋`apply_patch` のみ（read-hash 検証はあり） | 単純な write/edit がない | B | 未着手 |
| T2 | `str_replace_editor`（view/create/str_replace/insert、opt-in） | `dsh-tool-str-replace-editor` | なし | Claude Code 系モデルとの相性 | C | 未着手 |
| T3 | `read_image`（ワークスペースの画像をツールで読む） | `dsh-tool-fs` | 添付画像のみ | 途中で画像を参照できない | B | 未着手 |
| T4 | **永続シェル**（bash/pwsh の cwd・環境変数・関数・バックグラウンドジョブが呼び出し間で残る） | `dsh-tool-bash-persistent`, `dsh-tool-pwsh-persistent`, `dsh-terminal*` | 毎回新しいシェル。PTY は GUI 専用でモデル非公開 | 反復コマンドが遅く状態を保てない | A | 未着手 |
| T5 | `terminal` ツール 6 種（open/send/read/signal/close/list、owner 分離） | `dsh-tool-terminal` | なし | REPL・ログ監視ができない | B | 実験的（DSH 側） |
| T6 | `working_directory`（セッションの cwd を永続変更） | `dsh-tool-working-directory`, `dsh-working-directory` | `shell` の cwd 引数のみ（毎回指定） | モノレポ横断が面倒 | B | 未着手 |
| T7 | `present`（成果物を宣言、カード表示、既定アプリで開く） | `dsh-tool-present`, `dsh-client-ui-deliverables` | なし | 「何を作ったか」の提示が弱い | B | 未着手 |
| T8 | `session_query` 5 種（過去セッションの検索・トレース・イベント読取、同一 cwd 限定） | `dsh-tool-session-query`, `dsh-session-query` | なし（CLI の `--search` のみ） | 過去作業の再利用が弱い | B | 実験的（DSH 側） |
| T9 | `load_workspace_dependencies`（同梱 Python/Node/pnpm の絶対パスと版） | `dsh-tool-workspace-dependencies` | なし（ホストの node/pnpm 前提） | 環境非依存性で劣る | C | 未着手 |
| T10 | `cordis_inspect_list` / `cordis_inspect_query`（実行中 API の検査） | `dsh-tool-cordis` | なし | Creator 専用 | C | 対象外 |
| T11 | MCP: **streamable-http トランスポート**、resources/templates の 3 ツール、サーバー指示のプロンプト注入 | `dsh-mcp-client`, `dsh-mcp-resources` | stdio のみ、tools のみ | HTTP MCP・resources が使えない | B | 未着手 |
| T12 | サーバー由来の豊富な jobs API（owner 検証、出力リング 256 KiB、byte offset の follow、完了通知でアイドル起動） | `dsh-jobs`, `dsh-jobs-local`, `dsh-tool-jobs` | `job_status/output/wait/kill`（`run_code` 内） | 通知・follow がない | C | 未着手 |
| T13 | 同梱 ripgrep による glob/grep（ホスト rg 非依存、.git 除外） | `dsh-tool-fs-search` | 自前実装（glob/grep） | 大規模リポジトリで速度差 | C | 未着手 |
| T14 | `schedule_create/list/update/delete`（モデルが予約、6 セレクタ、配信履歴、CAS 更新） | `dsh-tool-schedule`, `dsh-schedule` | GUI/API のスケジュール＋Webhook（モデルツールなし） | モデルが自分で予約できない | B | 未着手 |
| T15 | fs の watch・変更フィード、アトミック書込＋DACL 保存、ハードリンク保護 | `dsh-fs-local`, `dsh-fs` | `apply_patch` の一時ファイル置換 | 監視・権限保存が弱い | C | 未着手 |
| T16 | スキルのユーザー起動（`/name`）とホットリロード、`disable-model-invocation` | `dsh-skill-filesystem`, `dsh-tool-skill`, `dsh-client-ui-skill` | `SKILL.md`＋`skill_load`（40 件上限） | 起動 UI・即時反映がない | C | 未着手 |

## 4. セッション・永続化・検索

| # | DSH の機能 | DSH 根拠 | HY-HARNESS の現状 | 差分 | 重大度 | 区分 |
| :-- | :--- | :--- | :--- | :--- | :-- | :-- |
| S1 | **セッション形式の版管理と 4 段のマイグレーション**（v0→v1→v2→v3→v4、凍結デコーダ、header 判定） | `dsh-session-format*`, `dsh-session-format-v0-to-v1` … `v3-to-v4` | JSONL v1 のみ。移行コードなし | 形式変更で過去ログを読めなくする risk | A | 未着手 |
| S2 | 永続化の抽象化（backend seam、Zstd フレーム、torn-tail 回復、単一 writer） | `dsh-session-persistence`, `-jsonl` | 直接 fs 追記 | 破損回復が弱い | B | 未着手 |
| S3 | チェックポイントポリシー（モデル要求前・ツール実行前・pre-step で強制フラッシュ、fail-closed） | `dsh-session-checkpoint-policy` | ターン前の git チェックポイント（別物） | クラッシュ時の要求/副作用の取りこぼし | B | 未着手 |
| S4 | **SQLite FTS5 のランキング全文検索**（スニペット、カーソル、メタフィルタ、セッション横断/単一） | `dsh-session-query`, `-sqlite` | 部分文字列走査（`hy sessions --search`、GUI 検索） | 大規模履歴で実用差 | A | 未着手 |
| S5 | プロジェクション・レジストリ＋永続キャッシュ（ログ再構築なしの一覧表示） | `dsh-session-projection`, `-cache` | 起動時にログを読む | 起動・一覧が遅くなる | B | 未着手 |
| S6 | セッション統計（ターン/ステップ、LLM/ツール時間、TTFT、デコード時間） | `dsh-session-stats` | トークン数のみ | 性能診断ができない | C | 未着手 |
| S7 | ターンアウトライン（未ロードのターンへジャンプ、プレビュー付き） | `dsh-session-turn-outline` | なし | 長い会話の移動が弱い | C | 未着手 |
| S8 | LLM によるタイトル生成（first-prompt / all-prompts、pin/refresh、語数・バイト上限） | `dsh-session-title*` | 自動タイトルは最初のユーザー発言。手動名のみ | 一覧の可読性 | B | 未着手 |
| S9 | セッション fork | `dsh-session` | なし | 分岐試行ができない | B | 未着手 |
| S10 | `@session` 参照（他セッションを境界付き untrusted 文脈として注入、cwd 親和ランキング） | `dsh-session-reference` | `@file` のみ | 過去の文脈参照がない | B | 未着手 |
| S11 | ZIP エクスポート（セッションツリー＋添付、`/export`） | `dsh-session-log-export` | Markdown/JSON エクスポート | 添付・子セッションが欠ける | C | 未着手 |
| S12 | 添付ストア（内容アドレス、sha256 重複排除、fsync＋ハードリンク公開、画像正規化、自動削除なし） | `dsh-attachment`, `dsh-attachment-local` | 画像は base64 でログ/キューに保持 | 容量・重複・一貫性で劣る | B | 未着手 |
| S13 | ストリーミング・アップロード（Blob/Stream、進捗、中断） | `dsh-client-file-upload` | 一括 base64 | 大きい添付で不利 | C | 未着手 |

## 5. モデル・プロバイダ・資格情報

| # | DSH の機能 | DSH 根拠 | HY-HARNESS の現状 | 差分 | 重大度 | 区分 |
| :-- | :--- | :--- | :--- | :--- | :-- | :-- |
| M1 | pi-ai カタログによる多数プロバイダ（Anthropic / OpenAI / Kimi / GLM 等）＋宣言的ゲートウェイ | `dsh-llm-pi-ai`, `dsh-client-ui-settings-models` | 6 種のみ | 選択肢が狭い | A | 未着手 |
| M2 | 3 つの API プロトコル（OpenAI Chat Completions / OpenAI Responses / Anthropic Messages） | `dsh-llm-pi-ai`, `docs/user/guide/providers.md` | Chat Completions 系＋Gemini Interactions | Anthropic 直・Responses が使えない | A | 未着手 |
| M3 | OAuth/対話サインイン＋資格情報ストア（保存ファイル＞起動 env＞`.env`、OS ユーザー限定、ローテーション） | `dsh-credentials*`, `dsh-authorization` | env 名 or 平文キー（`config.json`） | 安全な保存・更新がない | B | 未着手 |
| M4 | DeepSeek アカウント（サインイン、残高、モデル一覧、`min_version` ゲート、`ACCOUNT_QUOTA`） | `dsh-llm-deepseek-account`, `dsh-deepseek-account*`, `dsh-api-account-controller` | API キーのみ | 課金・アカウント連携がない | B | 未着手 |
| M5 | モデル一覧の自動取得（`/models`、10 分キャッシュ、失敗時フォールバック）と UI の検索・選択 | `dsh-llm-deepseek-api-key`, `dsh-client-ui-settings-models` | 手書きプリセットのみ | 新モデルへの追随が手動 | B | 未着手 |
| M6 | reasoning effort の宣言（レベル→API 値のマップ、`off` の扱い、`thinkingFormat`） | `dsh-llm-pi-ai`, `providers.md` | `reasoning_effort` の単純送信 | ベンダー差を吸収できない | B | 未着手 |
| M7 | compat スイッチ（`supportsDeveloperRole`、`maxTokensField`、`thinkingFormat` 等） | `providers.md`, `dsh-llm-pi-ai` | `max_tokens`→`max_completion_tokens` の 1 回リトライのみ | ゲートウェイ互換が弱い | B | 未着手 |
| M8 | 画像のピクセル/バイト予算と入力モダリティ宣言（モデル/ルート単位） | `dsh-llm-pi-ai`, `dsh-llm-deepseek` | 画像は provider 依存で制限なし | 大きい画像で失敗しうる | C | 未着手 |
| M9 | リトライ実行の durable 記録（`llm/retry` イベント、normal/always、Retry-After） | `dsh-llm-retry` | インメモリの指数バックオフ | 再開時に再現できない | C | 未着手 |
| M10 | 外向き HTTP プロキシ（fetch と子プロセスへの伝播、loopback 直結） | `dsh-http-proxy` | なし | 企業網で動かない | B | 未着手 |

## 6. サーバ・配備・アクセス制御・サンドボックス

| # | DSH の機能 | DSH 根拠 | HY-HARNESS の現状 | 差分 | 重大度 | 区分 |
| :-- | :--- | :--- | :--- | :--- | :-- | :-- |
| D1 | リスナー TLS（`--tls-cert`/`--tls-key`、失敗時は HTTP に落ちない） | `dsh-host-webserver`, `docs/user/guide/public-deployments.md` | なし（Tailscale で回避） | 平文のみ | A | 未着手 |
| D2 | `--public-url` / `--trusted-host` / Host・Origin フェンス / リバースプロキシ配備手順 | `dsh-web-app`, `dsh-client-connection`, `public-deployments.md` | loopback＋起動トークン Cookie のみ | 外部公開の設計がない | A | 未着手 |
| D3 | 非オーナーピアの**ロールベース・アクセス制御**（resource/action、イベントフィルタ、ピア別スナップショット） | `dsh-api-remote-access`, `dsh-api-remotes` | 単一ユーザー | 共有・委譲ができない | A | 対象外 |
| D4 | ライブ共有ビュー（リモート閲覧者ページ、権限に応じた UI 非表示） | `dsh-api-remote-access`, `dsh-client-ui-session` | なし | 同上 | B | 対象外 |
| D5 | 承認のワンショット seam（`ask`/`never`、回答者不在は fail-closed、セッション監査） | `dsh-user-approval` | 承認カード＋Guardian（同等以上） | 同等 | — | 同等 |
| D6 | 権限プリセット（Read Only / Workspace Write / Full access / Auto、リスク確認ダイアログ、`/permission`） | `dsh-permission-presets`, `dsh-client-ui-permission-presets` | 承認モード＋サンドボックス設定（分離） | ワンクリック切替がない | B | 未着手 |
| D7 | Auto review（ツール実行前に同一モデルが可否判定、許可時は Full access で実行） | `dsh-experimental-auto-review` | Guardian（承認チェーン内） | 同等機能が別位置に | C | 同等 |
| D8 | 送信テキスト中の API キー等のマスク表示（原本は保持） | `dsh-client-ui-secret-mask` | なし | 誤表示リスク | C | 未着手 |
| D9 | 匿名ユーザー ID・OTel セッション/製品テレメトリ・分析 | `dsh-anonymous-user-id`, `dsh-otel`, `dsh-session-telemetry*`, `dsh-client-product-analytics` | なし | 運用観測性がない | C | 未着手 |
| D10 | 公式 API へのセッションログ／プラグイン在庫の送信（オプトアウト可） | `dsh-session-log-deepseek`, `dsh-plugin-package-inventory-deepseek` | なし | 製品側の改善ループがない | C | 未着手 |
| D11 | サンドボックスの**既定 ON**（fail-safe は read-only、配備が workspace-write を選ぶ）、セッション毎のモード切替（ログ記録・再起動後も保持）、承認付き 1 段昇格、bwrap/Landlock/Seatbelt/Windows ACL のクロスプラットフォーム | `dsh-sandbox*`, `dsh-sandbox-policy`, `dsh-fs-sandbox`, `dsh-pwsh-sandbox` | **既定 unconfined**、Windows のみ、CLI フラグで opt-in、切替は再起動 | 安全側の既定・可搬性・昇格 UX で劣る | A | 未着手 |
| D12 | 読み取り前編集の強制（`FS_NOT_OBSERVED`、stale 版の拒否） | `dsh-fs-observation-policy` | `apply_patch` の read-hash 検証（同等） | 同等 | — | 同等 |

## 7. クライアント UI / UX

| # | DSH の機能 | DSH 根拠 | HY-HARNESS の現状 | 差分 | 重大度 | 区分 |
| :-- | :--- | :--- | :--- | :--- | :-- | :-- |
| U1 | 右サイドバーの**ドック型タブ拡張点**（browser/terminal/files/documentpreview/workflow-run/subagent chat が各々タブ種別を登録） | `dsh-client-ui-sidebar-right`, `-sidebar-*` | 固定 8 タブ | 拡張できない | B | 未着手 |
| U2 | ドキュメントプレビュー（Markdown/コードのページング、PDF/HTML/画像、**Office→PDF**、Excel） | `dsh-client-ui-sidebar-documentpreview`, `dsh-office-to-pdf`, `libreoffice-kit` | テキスト/コードのみ | Office/PDF を見られない | B | 未着手 |
| U3 | 成果物カード・変更ファイルカード（行数、ファイル別レビュータブ、インライン参照からサイドバーへ） | `dsh-client-ui-deliverables`, `dsh-workspace-changes` | Diff タブ＋`present` なし | 提示体験で劣る | B | 未着手 |
| U4 | メッセージ評価（Like/Dislike、7 カテゴリ、任意メモ、`/feedback`） | `dsh-message-feedback`, `dsh-client-ui-message-feedback`, `dsh-command-feedback` | なし | フィードバック収集がない | C | 未着手 |
| U5 | 音声入力（ローカル SenseVoice、VAD、マイク選択、レビュー可能な下書き挿入） | `dsh-experimental-voice-input*`, `-speech-to-text*` | なし | 入力手段が少ない | C | 未着手 |
| U6 | 推論（reasoning）の機械翻訳表示と原文切替 | `dsh-experimental-cot-translation*`, `dsh-experimental-client-ui-cot-translation` | なし | 英語推論の可読性 | C | 未着手 |
| U7 | インスペクタ（Chrome DevTools 同梱の CDP、生セッションログ、チャットノード表） | `dsh-experimental-inspector*`, `dsh-experimental-session-inspector` | Trace タブ（イベント一覧） | デバッグ深度で劣る | C | 未着手 |
| U8 | キーボードショートカットの参照・録音・リセット（デバイス別保存） | `dsh-client-shortcuts`, `dsh-client-ui-shortcuts` | Ctrl+K パレット固定 | カスタマイズ不可 | C | 未着手 |
| U9 | テーマ（light/dark/system、テキスト/コード/ターミナルのフォント個別設定） | `dsh-client-ui-theme` | 2 テーマ固定 | 設定自由度で劣る | C | 未着手 |
| U10 | ロケール辞書のプラグイン化（即時切替、名前空間、型付き） | `dsh-client-locale`, `dsh-client-ui-settings-general` | 3 言語のハードコード | 言語追加がビルド依存 | C | 未着手 |
| U11 | Open In（エディタ/Git GUI/ターミナル/ファイラの検出と起動、アイコン、SSH 時は非表示） | `dsh-host-open-in-app`, `dsh-client-ui-open-in-app` | 「パスを開く/フォルダを表示」のみ | アプリ選択がない | C | 未着手 |
| U12 | モデルピッカーのプロバイダ別グループ、reasoning effort 併記、削除済みでも選択保持 | `dsh-client-ui-model-selection`, `-settings-models` | フラットな一覧 | 選択体験で劣る | C | 未着手 |
| U13 | `@` 参照でファイル**とセッション**、フォルダ drill-down、正規形コピー | `dsh-client-ui-reference`, `dsh-file-reference*` | `@file` のみ（候補検索＋挿入） | セッション参照がない | B | 未着手 |
| U14 | 入力トリガー（`/`・`@` のグループ候補、キーボード/ポインタ、drill-down） | `dsh-client-ui-input-trigger`, `dsh-client-ui-commands` | `/` コマンド＋`@file` | 候補 UI が簡素 | C | 未着手 |
| U15 | 初回オンボーディング（順序付きステップ、接続復旧 UI、800 ms の状態最小表示） | `dsh-client-ui-settings-general` | ワークスペース選択のみ | 初回体験で劣る | C | 未着手 |
| U16 | ワークフロー実行・チームの可視化（run→phase→member、ステータス） | `dsh-client-ui-workflow-run`, `dsh-experimental-client-ui-agent-team` | オーケストレーター／ワーカー表示 | 対応機能が無い | C | 未着手 |
| U17 | ファイルツリーの watch 自動更新・手動リロード | `dsh-client-ui-sidebar-files` | 手動更新 | 鮮度で劣る | C | 未着手 |
| U18 | ターミナルのタブ改名・リロード後もプロセス保持・閉じると終了要求 | `dsh-client-ui-sidebar-terminal`, `dsh-api-terminal-controller` | セッション当たり 1 シェル、リロードで再接続可 | タブ管理がない | C | 未着手 |

## 8. 連携・SDK・自動化

| # | DSH の機能 | DSH 根拠 | HY-HARNESS の現状 | 差分 | 重大度 | 区分 |
| :-- | :--- | :--- | :--- | :--- | :-- | :-- |
| I1 | **ACP サーバ**（Agent Client Protocol、エディタ/自動化クライアントからセッション作成・再開・MCP 添付・キャンセル） | `dsh-acp`, `dsh-acp-app` | なし | エディタ統合がない | A | 未着手 |
| I2 | **Python SDK**（pip wheel にネイティブランタイム同梱、Node 不要、`DeepSeekHarness.run()`、patches、profile 選択） | `python/sdk`, `docs/user/guide/python-sdk.md`, `dsh-sdk-app` | なし | プログラム埋め込みができない | A | 未着手 |
| I3 | TypeScript/JSON-RPC SDK（7 リクエスト・4 通知、NDJSON、session/prompt/resume/wait） | `dsh-sdk-protocol`, `dsh-sdk-jsonrpc-server` | なし | 同上 | B | 未着手 |
| I4 | headless プロファイル（1 回実行、`--json` NDJSON、`--session-id` 再開、exit code） | `dsh-headless` | `hy run --json`（近い） | 同等に近い | C | 同等 |
| I5 | ACP/SDK/Codex/Claude Code を**外部サブエージェント**として使う | `dsh-subagent`（外部バックエンド） | なし | 他ハーネスの再利用ができない | C | 未着手 |
| I6 | Office スキル 7 種（ルーター＋作成/操作、Python ライブラリ、LibreOfficeKit CLI、段階ロード）＋Office→PDF | `dsh-skill-office`, `dsh-office-to-pdf`, `dsh-skill-badge` | なし | 文書業務ができない | B | 未着手 |
| I7 | スケジュールのモデルツール（E14/T14 と同じ） | `dsh-tool-schedule` | なし | 同上 | B | 未着手 |

## 9. デスクトップ（Electron）

| # | DSH の機能 | DSH 根拠 | HY-HARNESS の現状 | 差分 | 重大度 | 区分 |
| :-- | :--- | :--- | :--- | :--- | :-- | :-- |
| X1 | electron-updater による自動更新・**必須更新フレーム**・更新ダイアログ | `dsh-desktop-host`（`update-*`、`mandatory-update-*`）, `electron-updater` | ステージ済み exe を scheduled task で差し替える自己更新 | 配信・強制・進捗 UI がない | B | 未着手 |
| X2 | 初回起動ウィザード（welcome）と Platform ログイン | `dsh-desktop-host`（`welcome*`, `policy-login-loading.html`） | ワークスペース選択のみ | 初回体験 | C | 未着手 |
| X3 | DeepSeek Platform サインイン連携（デスクトップ） | `dsh-deepseek-account*`, `dsh-desktop-host` preload | なし | アカウント連携 | C | 未着手 |
| X4 | デスクトップ製品分析（ナビゲーション、プリセット、インストール結果） | `dsh-client-product-analytics`, `dsh-host-product-telemetry-otel` | なし | 運用観測性 | C | 未着手 |
| X5 | ブラウザタブ（Web は iframe、Desktop は webview、履歴管理、loopback 許可） | `dsh-client-ui-sidebar-browser` | iframe プレビュー＋Playwright 自動操作 | 自動操作は HY が優位、閲覧体験は同等 | C | 同等 |

## 10. 品質・運用・ドキュメント

| # | DSH の機能 | DSH 根拠 | HY-HARNESS の現状 | 差分 | 重大度 | 区分 |
| :-- | :--- | :--- | :--- | :--- | :-- | :-- |
| Q1 | 全 307 パッケージの README（英/中）、ドキュメントサイト、ガイド | 各パッケージ `README.md` / `README.zh.md`, `docs/` | docs は日本語中心、パッケージ単位の仕様書なし | 学習コスト・貢献容易性 | C | 未着手 |
| Q2 | 構成グラフ・設定カタログ・スキーマダンプの自動生成 | `docs/config-catalog.md`, `composition.md`, `--dump-config-schema` | なし | 構成の追跡が手作業 | C | 未着手 |
| Q3 | 起動失敗・HMR の E2E 期待値マトリクス、テスト支援パッケージ | `tests/profiles/web/tests/*.expected.e2e.ts`, `dsh-client-test-runtime` | 統合テスト 67 件（前回整備） | 失敗系の網羅で劣る | C | 未着手 |
| Q4 | リリースチャネル（rc）とクライアント版ゲート（`CLIENT_UPGRADE_REQUIRED`） | `dsh-llm-deepseek-*` | 0.1.1 固定 | 版管理が弱い | C | 未着手 |

---

## 11. 優先度つきロードマップ（提案）

### フェーズ 1 — 体験と安全の底上げ（1〜2 か月）
1. **実行中ステアリング＋継続可能サブエージェント**（E1, E2）: ターンキューを inbox 化し、`send_message`/`interrupt_agent`/`list_agents` を追加。
2. **サンドボックスの既定安全化**（D11）: 既定 `workspace-write`、セッション毎のモード切替（ログ記録）、承認付き昇格。
3. **ツール面の補完**（T1, T3, T4, T6, T7）: `write`/`edit`、`read_image`、永続シェル、`working_directory`、`present`。
4. **セッション基盤**（S1, S4）: 形式バージョン＋移行、FTS5 検索。
5. **TLS とリバースプロキシ配備**（D1, D2）: `--tls-cert/key`、`--trusted-host`、Host/Origin フェンス。

### フェーズ 2 — 拡張性とプロバイダ（2〜4 か月）
6. **プロファイル/バンドル/パッチ合成**（P1, P9）＋設定のスキーマ駆動化（P8）: DSH の中核思想。
7. **型付き RPC**（P7）とクライアント拡張点（P5 の最小版）。
8. **プロバイダ基盤**（M1, M2, M5, M6, M7）: Anthropic Messages/Responses、カタログ、一覧取得、compat。
9. **ワークフローツール**（E4）＋ACP（I1）。
10. **文書・成果物**（I6, U2, U3）。

### フェーズ 3 — 製品化・運用（4 か月以降）
11. **Python/TS SDK**（I2, I3）、Plugin Manager/Market/Creator（P2, P3, P4、承認済み対象外の再評価が必要）。
12. **ピア RBAC・共有ビュー**（D3, D4、マルチユーザー方針の再評価）。
13. **自動更新・オンボーディング・アカウント**（X1〜X3）、テレメトリ/OTel（D9）。
14. **音声・翻訳・インスペクタ・ショートカット等の磨き込み**（U4〜U10）。

---

## 12. HY-HARNESS が DSH に勝っている点（公平性のため）

| 領域 | HY-HARNESS | DSH の状況 |
| :--- | :--- | :--- |
| Windows サンドボックス | ACL 付与/取り消しの記録、`.git` ガード、ハードリンク除外、非 ACL ボリューム対応、専用デスクトップ | 同等の ACL バックエンドはあるが、既定は fail-safe の read-only で、モード切替 UX が中心 |
| ターン単位チェックポイント | 毎ターン前に git ref、`/undo`・`hy undo` でファイルと履歴を戻す | ファイル復元の仕組みはない |
| Ralph | 検証コマンド（Gate 1）＋別モデル grader（Gate 2）＋改ざん検査＋Budget4D＋ラウンドロールバック | `ralph` は「未検証」と明記（README） |
| Guardian | 実行前の独立判定（unconfined は承認しない、3 回で停止） | Auto review は実験的・既定 off |
| オーケストレーション A+ | スコープ重複拒否、直列化シェル、レビュー待ちの可視化、close 規律 | チームは共有ボード型で、ファイル衝突防止は弱い |
| MCP サーバ | `hy mcp-server`（他エージェントから `hy_run` を呼ぶ） | MCP クライアントのみ |
| LSP | `lsp` ツール（定義/参照/ホバー/診断/シンボル） | なし |
| ワークスペースメモリ | `memory` ツール（上限付き、毎回再描画） | なし（セッション参照で代替） |
| デスクトップ自動操作 | Playwright＋agent-desktop MCP | ブラウザタブのみ |
| 個人端末アクセス | Tailscale バインド＋PWA | リバースプロキシ/TLS 前提 |
| 配布 | 単一 portable exe＋自己更新 | インストーラ/自動更新 |
| 日本語 UI | en/ja/zh | en/zh（プラグイン辞書） |

---

## 13. 付録: DSH パッケージ分類（307 件）

分類は重複あり（1 パッケージが複数に属する）。実測できた件数は `dsh-tool-*` 25、`dsh-client-*` 63、`dsh-experimental-*` 24、`dsh-*` 全体 296、外部 11。以下はテーマ別の目安。

| 分類 | 件数（目安） | 代表例 |
| :--- | --: | :--- |
| Cordis/基盤 | 12 | `cordis*`, `cosmokit`, `dsh-scope`, `dsh-lazy-require` |
| エージェント/ループ/プロンプト | 14 | `dsh-agent*`, `dsh-plan-mode`, `dsh-persona`, `dsh-system-prompt` |
| ツール（`dsh-tool-*`） | 25 | `dsh-tool-fs`, `dsh-tool-workflow`, `dsh-tool-terminal` |
| 実行/サンドボックス/シェル | 18 | `dsh-sandbox*`, `dsh-bash*`, `dsh-pwsh*`, `dsh-subprocess*` |
| セッション/永続化/検索 | 26 | `dsh-session*`, `dsh-spill*`, `dsh-session-query-sqlite` |
| LLM/資格情報/アカウント | 14 | `dsh-llm*`, `dsh-credentials*`, `dsh-deepseek-account*` |
| API/Remote/ゲートウェイ | 13 | `dsh-api-*`, `dsh-typert-*`, `dsh-host-webserver` |
| クライアント（`dsh-client-*`） | 63 | `dsh-client-ui-*`, `dsh-client-connection`, `dsh-client-modules` |
| プラグイン/設定 | 10 | `dsh-plugin-manager`, `dsh-plugin-market*`, `dsh-settings`, `dsh-config-editor` |
| スキル/文書 | 9 | `dsh-skill*`, `dsh-office-to-pdf`, `libreoffice-kit` |
| SDK/ACP/ヘッドレス | 8 | `dsh-acp*`, `dsh-sdk-*`, `dsh-headless` |
| 実験（`dsh-experimental-*`） | 24 | チーム、音声、翻訳、インスペクタ、ワークツリー、Ralph |
| テレメトリ/観測 | 9 | `dsh-otel`, `dsh-session-telemetry*`, `dsh-client-product-analytics` |
| ユーティリティ | 21 | `dsh-util-*`, `dsh-atomic-write`, `dsh-timeout`, `dsh-deque` |

---

## 14. 参考資料

- DSH リポジトリ: <https://github.com/deepseek-ai/deepseek-harness>
- 利用ガイド: <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/index.md>
- プロバイダ設定: <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/providers.md>
- Python SDK: <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/python-sdk.md>
- リバースプロキシ配備: <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/public-deployments.md>
- 本リポジトリの既存比較: [feature-parity.md](feature-parity.md)（DSH の SSH・クラウドに関する記述は本文冒頭の注意を参照）
