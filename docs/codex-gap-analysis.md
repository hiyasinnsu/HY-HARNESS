# HY-HARNESS と OpenAI Codex の比較分析（2026-11-05）

- **目的**: `openai/codex` の実装を一次コードから分析し、本プロジェクト（HY-HARNESS v0.4.0）と比較して、**劣っている点・不足している機能を網羅的に洗い出す**。実装計画は [codex-adoption-plan.md](codex-adoption-plan.md)。
- **対象**: OpenAI Codex `main` の `c90354172c5c49535b122443e9a8ed52c2233b80`（2026-11-05 取得。`F:\HY-HARNESS\.refs\codex` に shallow clone）。HY-HARNESS は 2026-11-05 時点の作業ツリー（v0.4.0、M0–M6 完了後）。
- **方法**: Codex は `docs/*.md` の大半が developers.openai.com へのリンクだけのスタブなので、**コードそのもの**（`codex-rs/` の 118 のトップレベルクレート（ワークスペースメンバーは 168）、5,819 個の `.rs`、約 227 万行）を根拠にした。HY 側は実装・テスト・既存ドキュメントを突き合わせた。根拠にはファイルパスを付ける。行番号は変わりうるので、原則としてパスで示す。
- **参照クローン**: `F:\HY-HARNESS\.refs\codex`（`.gitignore` 済み、121 MB）。分析の再現に使える。
- **限界**: Codex は 1 つのリポジトリで 227 万行あり、全行を読んではいない。機能の存在はモジュール・型・ツール定義・テストで確認し、意味は README とコードの構造から判断した。**「未確認」と書いた項目は断定していない**。

- **実装後の状況（2026-11-06 追記）**: 本文は 2026-11-05 時点の分析のまま残す。その後、計画 C0〜C5 の対象 WP（ネットワーク関連の CP-03/04 と SEC-02/03/04 は対象外）を実装した。§0 の構造的な負け 4 点のうち、(b) 既定 `workspace-write`（CP-01）、(c) hy-protocol/1・常駐デーモン・SDK（CP-25〜30）、(d) `tool_search` と遅延ツール（CP-10）は解消済み。(a) は読み取りのみ `denyRead`（NO_READ_UP ラベル）で対応し、ネットワークは対象外のまま。WP ごとの状況は [implementation_status.md §7](implementation_status.md)、検証の記録は [codex-adoption-progress.md](codex-adoption-progress.md)、プロトコルは [protocol.md](protocol.md)、移行は [migration.md](migration.md)。

---

## 0. 要旨

1. **Codex は「エージェントの賢さ」より「封じ込めと統合の工学」に投資している**。30,000 行級の Windows サンドボックス、WFP によるネットワーク遮断、HTTP/SOCKS5 プロキシと MITM フック、パス単位の権限モデル、12 種のフック、1,719 個のスナップショットテスト。HY が持つ機能の多くは「動く」が、**同じ機能の深さ（異常系・診断・境界）で 1〜2 桁差**がある。
2. **HY が構造的に負けているのは 4 点**。(a) 読み取りとネットワークを閉じ込めない、(b) サンドボックスが opt-in で、既定が `unconfined`、(c) 第三者が使えるステートフルなプロトコル（app-server 相当）がない、(d) ツール表面が 14 個固定で、モデルが自分でツールを探せない。
3. **一方で HY は Codex にない強みを持つ**。検証ゲート付きの完了判定（`hy ralph` の Gate 1/2・改ざん検査・Budget4D）、ターン単位チェックポイントと `/undo`、ゴール、プラン専用オーケストレーション、Windows デスクトップ GUI と 3 言語 UI、ローカル PTC の明示的なトークン予算。**これらは捨てずに残す**。
4. ギャップは **119 件**に整理した（P0: 7、P1: 28、P2: 51、P3: 33）。すべてを実装するのは非現実的なので、計画では **「採る / 後で採る / 採らない」** を明示した。総工数は約 **389 人日**（1 人なら 19〜21 か月、2 人で 10〜11 か月）と見積もる。
5. 優先順位の原則は **「安全側の既定 → モデルの道具箱 → 外部統合 → UX → 運用」**。最初の 6 か月で (1) 読み取り/ネットワークの閉じ込め、(2) ツール表面の拡張、(3) app-server 相当プロトコル、(4) memories/hooks/skills の深化 に集中するのが妥当。

---

## 1. Codex の実装分析

### 1.1 全体構造とプロセスモデル

```
┌──────────────────────────────────────────────────────────────────────┐
│ clients: TUI (codex) / codex app / IDE extension / SDK / MCP clients │
└───────────────┬──────────────────────────────────────────────────────┘
                │ app-server protocol (JSON-RPC: thread/turn/item, approvals, config)
┌───────────────▼──────────────────────────────────────────────────────┐
│ codex-core: session/turn loop, tools, context, compaction, guardian   │
│  ├─ codex-protocol  (typed models, permissions, items, events)        │
│  ├─ codex-config    (layered config, profiles, managed requirements)  │
│  ├─ codex-model-provider / login (OpenAI, Azure, Bedrock, OAuth)      │
│  ├─ codex-sandboxing (Seatbelt / Landlock+bwrap / Windows backends)   │
│  ├─ codex-network-proxy (HTTP + SOCKS5 + MITM hooks)                  │
│  ├─ codex-execpolicy (Starlark)   codex-hooks   codex-skills          │
│  ├─ codex-memories  codex-rollout  codex-thread-store  codex-otel     │
│  └─ codex-exec-server (PTY exec over ws; local or remote)             │
└──────────────────────────────────────────────────────────────────────┘
```

- **1 バイナリ・多クライアント**。`codex` は TUI、`codex exec` は非対話、`codex app-server` は他クライアント向けのサーバー、`codex exec-server` は PTY 実行サーバーとして同じ `codex-core` を共有する（`codex-rs/cli/src/main.rs`、`codex-rs/app-server/`、`codex-rs/exec-server/README.md`）。
- **118 のトップレベルクレート**（ワークスペースメンバーは 168）に分割され、`core` だけで 949 ファイル・約 50 万行。`tui` が 1,203 ファイル・約 49 万行。合計 **5,819 ファイル / 2,267,533 行 / 25,577 個のテスト属性 / 1,719 個の `.snap`**。
- **セッション状態は `rollout`（JSONL 追記ログ）+ `thread-store`（ローカル DB）**。`thread-store` はアカウント別、migration、圧縮、添付、読み取り状態まで持つ（`codex-rs/thread-store/`、`codex-rs/rollout/`）。
- **サーバーは daemon 化できる**。`app-server-daemon` が update loop・shutdown admission・remote control を持つ（`codex-rs/app-server-daemon/README.md`）。

### 1.2 実行モデル（session / turn / item）

| 概念 | Codex | 根拠 |
| :--- | :--- | :--- |
| Thread | 会話。fork / resume / archive / delete / rollback / 読み取り状態 / 添付を持つ | `app-server-protocol/src/protocol/v2/thread.rs` |
| Turn | 1 回のユーザー入力に対する実行。`turn/start`・`turn/interrupt`・`turn/steer`（実行中ステアリング） | `protocol/v2/turn.rs` |
| Item | ストリームされる単位（メッセージ、推論、ツール呼び出し、承認要求、差分、コンパクション…） | `protocol/v2/item.rs`（70 KB） |
| 承認 | 承認要求も item として流れ、クライアントが応答する | `core/src/tools/approvals.rs`（38 KB） |
| 実行 | モデル呼び出し・ツール・サブエージェント・コンパクション・OTEL が 1 つの turn に同居 | `core/src/codex_thread.rs`（59 KB） |

- **ストリーミングが前提**。モデルの出力はイベントとして逐次流れ、ツール呼び出しは増分で組み立てられる。HY は `stream: false` の一括応答（`packages/core/src/llm.ts`）。
- **コンパクションは 3 系統**。ローカル要約（`core/src/compact.rs`）、サーバー側（remote）v2（`compact_remote_v2.rs` 58 KB、メディア予算・履歴・インストール・試行錯誤を分離）、非同期コンパクション（既定 65 % で発火、`core/src/config/mod.rs` の `DEFAULT_ASYNC_COMPACTION_THRESHOLD_PERCENT`）。
- **undo は ghost snapshot**。ツール実行前にファイル状態をスナップショットし、大きい未追跡ファイル・ディレクトリは除外する（`GhostSnapshotConfig`、既定 10 MB / 200 エントリ）。HY の git ref ベースのチェックポイントと思想は同じで、HY の方が計測済みの性能目標を持つ。

### 1.3 セキュリティモデル（Codex の核心）

Codex の封じ込めは **「権限プロファイル」→「サンドボックスバックエンド」→「ネットワークプロキシ」→「承認」→「Guardian」** の 5 層で、それぞれが独立したクレートになっている。

#### (a) 権限モデル（パス単位）

`codex-rs/protocol/src/permissions/` に、読める/書ける/拒否するをパス単位で表現する型がある（`target.rs`、`enforcement.rs`、`local_aliases.rs`、`materialization` 系）。`[permissions]` 設定は **split filesystem policy**（読み取りルート、書き込みルート、書き込みルート配下の読み取り専用 carve-out、明示的な `none`）を表現でき、名前付きプロファイルと `default_permissions` を持つ。

- Windows の昇格サンドボックスは、この split policy をそのまま強制できる（`core/README.md` の「Windows」節）。
- 強制できない組み合わせ（明示的な読み取り拒否 carve-out など）は **fail closed**（弱い強制で走らせない）。
- MXC（Microsoft BaseContainer）バックエンドは、同一パスの別表記・symlink/junction を最も厳しい権限に寄せ、より具体的なパスが祖先の許可を上書きする（`codex-rs/mxc-sandbox/README.md`）。

#### (b) サンドボックスバックエンド

| OS | 実装 | 根拠 |
| :--- | :--- | :--- |
| macOS | Seatbelt（`.sbpl` ポリシー、read-only platform defaults、daemon socket、fcntl/TLS テスト） | `sandboxing/src/seatbelt.rs`（43 KB）、`seatbelt_*.sbpl` |
| Linux | Landlock + seccomp + bubblewrap + PID namespace。bwrap が古い/無い場合の互換経路と警告 | `sandboxing/src/landlock.rs`、`bwrap.rs`、`linux_pid_namespace.rs`、`core/README.md` |
| Windows | ① 昇格サンドボックス（専用サービス + sandbox ユーザー + WFP ファイアウォール + DPAPI + ConPTY）② 非昇格の制限トークン ③ MXC BaseContainer ④ AppContainer 系 | `windows-sandbox-rs/src/`（119 ファイル。`wfp.rs`、`elevated_impl.rs`、`deny_read_acl.rs`、`token.rs`）、`mxc-sandbox/` |
| 全 OS | プロセス堅牢化（`process-hardening`）、起動時の環境スナップショット | `codex-rs/process-hardening/`、`core/src/spawn.rs` |

- **ネットワークは OS レベルで遮断する**。Windows は WFP フィルタ（`windows-sandbox-rs/src/wfp.rs`、`wfp_setup.rs`、`wfp/filter_specs.rs`）、Linux/macOS はサンドボックスプロファイル。
- **読み取り拒否 ACL** を Windows で実装している（`deny_read_acl.rs`、`deny_read_resolver.rs`、`deny_read_state.rs`）。HY の「読み取りは閉じ込めない」（`docs/enforcement-gaps.md` S1）に対する直接の差。

#### (c) ネットワークプロキシ

`codex-rs/network-proxy/`（74 ファイル）は HTTP（既定 `127.0.0.1:3128`）と SOCKS5（既定 `8081`）を立て、**許可/拒否リスト**・**limited モード（読み取り専用ネットワーク）**・**HTTPS MITM とフック**（リクエストヘッダの削除、資格情報の置換）・**unix socket 許可**・**ローカル/プライベート IP の遮断**・**upstream プロキシ**を提供する（`network-proxy/README.md`）。`network_approval`（`core/src/tools/network_approval.rs` 55 KB）と組み合わせ、**ツール単位のネットワーク承認**を行う。

#### (d) 承認と execpolicy

- 承認は **`AskForApproval`（untrusted / on-request / granular / never）** と **サンドボックスプリセット（read-only / workspace-write / danger-full-access 相当）** の直交した 2 軸。
- Starlark の execpolicy（`codex-rs/execpolicy/`）は **prefix ルール + ホスト実行ファイル解決 + ネットワークルール + テスト**。HY の `hy-execpolicy` と同じ系統だが、Codex は「どの実行ファイルが解決されるか」まで扱う。
- **`request_permissions` ツール**でモデルが実行中に権限昇格を要求できる（`core/src/tools/request_permissions.rs`）。ユーザーは差分を見て許可する。HY にはこの経路がない。

#### (e) Guardian

`codex-rs/core/src/guardian/`（`review_session.rs` 37 KB、`request_budget.rs`、`input_budget.rs`、`transcript.rs`、`trusted_tool.rs`、`verified_answers.rs`）と `guardian-context/`（`budget.rs` 22 KB、`composition.rs` 33 KB、`enforcement.rs` 17 KB）。

HY の Guardian（1 回の LLM 呼び出し、`decision` と `riskScore`、3 回拒否で停止）と**思想は同じ**だが、Codex は **レビューセッション**（複数ターンの審査、トランスクリプト、予算、画像、承認済みツールの記憶、カバレッジ）まで持つ。**「同じ機能の深さ」で大きな差**が出ている代表例。

### 1.4 ツール表面

Codex がモデルに出すツールは **名前空間つき・モデル別の tool mode**（`Direct` / `CodeMode` / `CodeModeOnly`）で切り替わり、**公開クラス**（`Direct` / `Deferred` / `DeferredModelOnly` / `DirectModelOnly` / `Hidden`）でプロンプトへの載り方が変わる（`core/src/tools/mod.rs` の `requested_tool_mode`、`tools/src/tool_executor.rs` の `Exposure`、`tool_namespaces_info.rs`、`tools/src/tool_search.rs`）。

| 分類 | ツール | 根拠 |
| :--- | :--- | :--- |
| ファイル | `apply_patch`（CLI 互換の仮想 `apply_patch` を含む） | `core/src/tools/handlers/apply_patch*`、`core/README.md` |
| シェル | `exec_command`（unified exec。`yield_time_ms` で戻り、再開できる）と `write_stdin`（実行中プロセスへの入力）。unified exec が無効なら `shell` の一発実行 | `handlers/unified_exec/{exec_command,write_stdin}.rs`、`core/src/unified_exec/` |
| 画像 | `view_image`（detail 指定、リサイズ） | `handlers/view_image.rs`（20 KB） |
| 計画・質問 | `plan`、`update_plan`、`request_user_input`、`request_user_input_async` | `handlers/plan*.rs`、`request_user_input*.rs` |
| コンテキスト | `get_context_remaining`、`new_context_window` | `handlers/get_context_remaining*.rs` |
| 検索・発見 | `tool_search`、動的ツール（dynamic tool）、MCP ツール検索 | `core/src/tools/tool_search.rs`（24 KB）、`tools/src/tool_search.rs` |
| MCP | `list_mcp_resources`、`read_mcp_resource`、`list_mcp_resource_templates`、MCP prompts、OAuth | `core/src/tools/mcp_resource.rs`、`rmcp-client/` |
| マルチエージェント | v2: `spawn_agent`・`send_message`・`followup_task`・`wait_agent`・`interrupt_agent`・`list_agents`／v1: `spawn_agent`・`send_input`・`resume_agent`・`wait_agent`・`close_agent`／別系統で `delegate`・`orchestrator` | `handlers/multi_agents_v2/*.rs`、`handlers/{spawn,send_input,wait,close_agent,resume_agent,delegate,orchestrator}.rs` |
| 権限・拡張 | `request_permissions`、`request_plugin_install`、`list_available_plugins_to_install` | `handlers/request_*.rs` |
| ユーティリティ | `sleep`、`current_time`、`wait_for_environment`、`send_message_to_user_async`、`followup_task` | `handlers/{sleep,current_time,wait,user_messaging}.rs` |
| コード実行 | code mode の `exec` / `wait`（モデルが JS を書き、ツールを JS から呼ぶ。V8 isolate + in-process sandbox） | `code-mode-protocol/src/lib.rs`、`code-mode-runtime/`、`core/src/tools/code_mode/` |
| ホスト型 | hosted `web_search`（プロバイダ側で実行）、`web.run`（自前の検索/取得）、`image_gen.imagegen` | `spec_plan.rs`、`tools/src/tool_spec.rs`、`ext/web-search/src/tool.rs` |

- **ツール数は固定ではない**。モデルが `tool_search` で必要ならロードする遅延ロード方式。HY は 14 ツール固定で、増やすと PTC の 1,200 トークン予算（K9）に直接効く。
- **`write_stdin` は HY に無い決定的な差**。HY の永続シェルは「コマンドを書く → 出力を読む」の 1 往復（`packages/core/src/tools.ts` の `shellPersistent`）で、実行中の対話プログラムに文字を送れない。
- **MCP は resources/prompts/OAuth まで**。HY は `tools/list` と `tools/call` だけ（`packages/core/src/mcp.ts`）。

### 1.5 拡張機構

| 機構 | Codex | HY |
| :--- | :--- | :--- |
| MCP クライアント | stdio / HTTP / SSE、OAuth、resources、prompts、tool search、MCP App UI | stdio のみ、tools のみ |
| MCP サーバー | **なし**（`codex-mcp` はクライアント接続管理。別バイナリの `message-board-mcp` のみ） | `hy mcp-server`（`hy_run` のみ） |
| Skills | 選択・推薦・メンション・MCP 依存・スナップショット（`skills/src/selection.rs` 15 KB） | カタログ + `skill_load`（`packages/core/src/skills.ts` 4.8 KB） |
| Hooks | 11〜12 イベント（SessionStart/End、UserPromptSubmit、Pre/PostToolUse、Pre/PostCompact、PermissionRequest、Stop、Interrupt、ModelRequest、SubagentStart/Stop）、シェル / MCP ランナー、出力 spill | 3 イベント（preToolUse、postToolUse、turnEnd）+ notify |
| Memories | **自動パイプライン**（rollout 抽出 → 統合 → 読み出し時注入 → 引用 → telemetry、`memories/README.md`） | 手動 20 件・約 2,000 トークン（`packages/core/src/memory.ts`） |
| Plugins | マーケットプレイス、リモートカタログ、npm ソース、バンドル、メトリクス、トグル（`core-plugins/` 99 ファイル） | ユーザー設定のモジュールパスのみ（マーケットは対象外） |
| Code mode | V8 の分離ランタイム（`v8_enable_sandbox`） | AppContainer の Node（`--permission`） |
| 移行 | Claude Code 等からの設定・MCP・フック・メモリ・サブエージェント取り込み（`external-agent-migration/`） | なし |

### 1.6 プロトコルと統合

`codex-rs/app-server-protocol/` は **巨大な型付きプロトコル**（`thread_history.rs` 240 KB、`common.rs` 182 KB、`export.rs` 114 KB、v1/v2、JSON Schema / TS の生成、fixtures）。

- メソッドは **177 個（client→server）+ 9 個（server→client）+ 82 個の通知**（`app-server-protocol/src/protocol/common.rs` の `ClientRequest`）。例: `initialize`、`thread/start|resume|fork|list|search|read|archive|delete|revert|compact`、`turn/start|steer|interrupt`、`review/start`、`model/list`、`fs/*`、`mcpServer/*`、`skills/*`、`hooks/list`、`plugin/*`、`marketplace/*`、`project/*`、`remoteControl/*`、`windowsSandbox/*`、`account/*`。
- **スキーマの生成物がある**。`codex app-server generate-ts` と `generate-json-schema` が公式に配布される（`cli/src/main.rs`）。クライアントはこれを型として使う。
- トランスポートは stdio / WebSocket（`ws://IP:PORT`）/ unix socket。`app-server-client` が Rust クライアント、`app-server-test-client` が適合テスト用。
- **IDE 拡張（VS Code / Cursor / Windsurf）と `codex app` は、このプロトコルの上に載っている**（README 冒頭）。
- 別系統で **`codex exec-server`** がある。PTY 付きでサブプロセスを制御する小さな JSON-RPC サーバーで、`ws://IP:PORT` でも待ち受けられる（`exec-server/README.md`）。**リモート実行の土台**。
- **SDK は TypeScript（`@openai/codex-sdk`）と Python（`openai-codex`）**の 2 系統（`sdk/`）。`codex exec --json --output-schema` で CI からも使える。

### 1.7 CLI と設定の表面

- **サブコマンドは 31 個**（`cli/src/main.rs` の `Subcommand`）。`agents`、`exec`、`review`、`login/logout`、`mcp`、`plugin`、`app-server`、`remote-control`、`app`、`completion`、`update`、`doctor`、`sandbox`、`debug`、`apply`、`resume`、`queue`、`archive/unarchive/delete`、`fork`、`cloud`、`features`、`migrate-rollouts`、`migrate-nfs-db`、`tcp-tunnel`、`execpolicy`、`responses-api-proxy`、`stdio-to-uds`、`exec-server` など。
- **`codex doctor`**（`--json` / `--summary` / `--network-only`）があり、環境診断を製品機能として持つ。
- **設定は `ConfigToml` の 1 つのスキーマ**（`config/src/config_toml.rs`、`deny_unknown_fields`、`--strict-config`、JSON Schema 生成）。トップレベルだけで 60 以上の表があり、`model_providers`、`permissions`、`default_permissions`、`mcp_servers`、`apps`、`plugins`、`marketplaces`、`projects`（`trust_level`）、`history`、`ghost_snapshot`、`tools`、`agents`、`goals`、`memories`、`skills`、`hooks`、`features`、`otel`、`analytics`、`tui`、`windows` を含む。
- **`-c/--config key=value` の上書き**と `--enable/--disable <FEATURE>` がある（`utils/cli/src/config_override.rs`、`main.rs`）。
- **安定性は `features` レジストリで管理**する。`Stage::{Stable, Experimental, UnderDevelopment, Deprecated, Removed}` で、このスナップショットでは Stable 約 66、Experimental 約 9、UnderDevelopment 約 94、Deprecated 約 7、Removed 約 50（`features/src/lib.rs`）。
- **`--full-auto` は現行の Codex には存在しない**（`full-auto` の一致 0 件）。HY の `--full-auto` は Codex の旧仕様を残している。


### 1.8 運用・品質

- **OTEL**（`otel/README.md` 11 KB、managed OTEL 設定）、**analytics**（`analytics/` 30 ファイル、イベント縮約）、**feature flags**（`features/`）、**rollout-trace**（`rollout-trace/README.md`）、**feedback**、**user-verification**。
- **テスト**: 25,577 個のテスト属性、1,719 個の `insta` スナップショット、`core/tests/suite/` の 275 ファイルの E2E、Bazel（`BUILD.bazel`、`MODULE.bazel`）、Wine での Windows 実行テスト（`core/README.md`）。
- **設定レイヤは 9 段**（packaged defaults −10、MDM 0、system 10、enterprise bundle 15、user 20/21、project 25、session flags 30、legacy managed 40/50）。**フィーチャーフラグは 212 個**で成熟度を持つ（`config/src/config_layer_source.rs`、`features/src/lib.rs`）。
- **認証**: OAuth PKCE / device code / token refresh / ChatGPT backend、Azure、Bedrock（`login/`、`model-provider/src/auth.rs`）。
- **配布**: 単一バイナリ、npm / Homebrew / インストーラ、GitHub Releases、自己更新。

### 1.9 設計思想（HY が学ぶべき点）

1. **失敗側に倒す（fail closed）**。強制できない権限は「弱く走らせる」のではなく拒否する。
2. **境界を型で持つ**。権限・ツール名・プロトコルが型で表現され、境界を越えるときにだけ文字列へ落とす。
3. **クライアントを増やしても壊れない**。TUI・アプリ・IDE が同じ app-server を共有する。
4. **拡張は遅延ロード**。ツール・スキル・MCP を全部プロンプトに入れず、必要なら検索させる。
5. **観測可能性を最初から入れる**。OTEL・analytics・trace・ベンチが製品の一部。

---

## 2. HY-HARNESS の現状（比較の基準）

| 領域 | 実装 | 根拠 |
| :--- | :--- | :--- |
| 構成 | TypeScript の制御プレーン（約 58,000 行）+ Rust の実行デーモン（4 クレート、9,168 行） | `packages/`、`crates/` |
| サンドボックス | Windows の制限トークン + ACL 付与/取り消し。`workspace-write` / `read-only` / `low-integrity`。**既定 `unconfined`、opt-in**。読み取り・ネットワークは閉じ込めない | `crates/hy-sandbox-windows/`、`docs/enforcement-gaps.md` S1/S2/S9 |
| ポリシー | Starlark の prefix ルール（`deny`/`prompt`/`unconfined`/`low-integrity`） | `crates/hy-execpolicy/` |
| 承認 | 手動 / confined の自動承認 / 全自動 + Guardian（1 回呼び出し、3 回拒否で停止） | `packages/seams/src/guardian.ts` |
| ツール | 14 の wire ツール + プラグインツール。`read_file`/`apply_patch`/`shell`/`run_code`/`search_*`/`job_*`/`rationale_*`/`claim_complete`/`update_plan`/`skill_load`/`mcp_call`/`delegate`/`web_*`/`lsp`/`memory`/`ask_user` | `packages/core/src/tool-registry.ts`、`packages/hy-cli/src/session-app.ts` |
| 実行ループ | ステップ無制限、読み取りのみ並列、壊れた JSON/重複呼び出し/空応答へのリトライ、ステアリング、ターンキュー | `packages/core/src/agent.ts` |
| コンテキスト | spill（32 KiB）→ Tier 1（退避）→ Tier 2（要約）。75 % で発火。固定制約とモデルメモは要約しない | `packages/seams/src/spill-compaction.ts` |
| セッション | JSONL ログ、再開、fork、FTS5 検索、`/undo`、チェックポイント（git ref）、計測 | `packages/core/src/{session-log,session-index}.ts`、`crates/hy-exec-server/src/checkpoint.rs` |
| 完了判定 | `hy ralph`（改ざん検査 → Gate 1 検証コマンド → Gate 2 grader、Budget4D、ラウンドロールバック） | `packages/seams/src/verifier-ralph.ts` |
| 拡張 | stdio MCP（tools のみ）、skills、3 種フック、プラグイン、LSP、ワークスペースメモリ | `packages/core/src/{mcp,skills,hooks,plugins,lsp,memory}.ts` |
| プロトコル | exec-server の JSON-RPC（stdio）、HTTP API + SSE、ACP、MCP サーバー、TS/Python SDK | `crates/hy-exec-server/`、`packages/hy-cli/src/{web-server,acp,sdk-server}.ts` |
| モデル | Ollama / DeepSeek / OpenAI 互換 / OpenCode / Gemini / Anthropic / Responses / mock。API キーは環境変数か平文設定 | `packages/core/src/{llm,config}.ts` |
| GUI | Electron + ブラウザ。3 カラム、承認、goal、plan、job、subagent、Trace、Browser/Terminal/Desktop、3 言語 | `packages/hy-cli/web/`、`packages/desktop/` |
| 運用 | opt-in OTLP span、フィードバック（ローカル）、Ed25519 署名フィード + portable 自己更新、ベンチ 2 種 | `packages/hy-cli/src/{telemetry,feedback,update-feed}.ts`、`scripts/bench-startup.mjs` |
| 品質 | 単体 107（Rust 37 + TS 70）+ 結合 49 = 156、カバレッジ 98.9 %（TS 行）/ 89.2 %（Rust 行） | `docs/implementation_status.md` §2.10–2.11 |

---

## 3. 比較表（主要次元）

| 次元 | Codex | HY-HARNESS | 判定 |
| :--- | :--- | :--- | :--- |
| 言語・配布 | Rust 単一バイナリ、118 クレート（メンバー 168）、227 万行 | TS + Rust、Node 24 必須、portable exe | **劣る**（配布・起動） |
| サンドボックス既定 | 既定で有効（workspace-write 相当） | 既定 `unconfined`、opt-in | **大きく劣る** |
| 読み取り封じ込め | あり（split policy / deny-read ACL、fail closed） | なし | **大きく劣る** |
| ネットワーク封じ込め | WFP / Seatbelt / proxy + 承認 | なし | **大きく劣る** |
| 権限モデル | パス単位・名前付きプロファイル・昇格要求 | 3 モード + Starlark ルール | **劣る** |
| クロスプラットフォーム | Linux/macOS/Windows（Wine テスト含む） | Windows のみ（他 OS は unconfined） | **大きく劣る** |
| ツール表面 | 40+（遅延ロード、名前空間、tool mode） | 14 固定 + プラグイン | **劣る** |
| 実行中プロセスの操作 | `write_stdin` / ConPTY / unified exec | コマンド 1 往復のみ | **劣る** |
| MCP | stdio/HTTP/SSE、OAuth、resources、prompts、サーバー | stdio、tools のみ | **劣る** |
| フック | 11〜12 イベント | 3 イベント | **劣る** |
| メモリ | 自動パイプライン（抽出・統合・引用） | 手動 20 件 | **大きく劣る** |
| スキル | 選択・推薦・依存・スナップショット | カタログ + 読み込み | **やや劣る** |
| プロトコル | app-server（thread/turn/item、v1/v2、生成物） | HTTP API + exec JSON-RPC | **大きく劣る** |
| IDE / アプリ統合 | VS Code/Cursor/Windsurf、`codex app` | Electron GUI のみ | **劣る**（一部対象外） |
| 認証 | OAuth / ChatGPT / Azure / Bedrock / keyring | API キーのみ | **劣る** |
| ストリーミング | 前提 | 一括応答 | **劣る** |
| コンパクション | ローカル + remote v2 + 非同期 | 2 段（spill + 要約） | **やや劣る** |
| 完了判定 | 自己申告（独立した検証ゲートはなし） | **ralph の 2 ゲート + 予算** | **勝る** |
| チェックポイント | ghost snapshot（git 以外も） | git ref + 計測済み性能 | **同等〜勝る** |
| ゴール / プラン運用 | TUI の goal/plan コマンド | 永続ゴール + 自律ラウンド + grader | **勝る** |
| GUI | TUI + アプリ + IDE | Electron 3 カラム + Web + PWA | **勝る**（GUI の機能は同等） |
| 多言語 UI | 英語のみ（推定） | 英/日/中 | **勝る** |
| オーケストレーション | マルチエージェント v2 + orchestrator | Orchestration A+（スコープ検査） | **同等**（HY は worktree なし） |
| 観測 | OTEL + analytics + trace + 25k テスト | OTLP span + 156 テスト | **劣る** |
| 拡張の市場 | プラグインマーケット | なし（対象外） | 対象外 |

---

## 4. ギャップ一覧（全件）

- 列の意味: **規模** S（〜3 日）/ M（〜2 週）/ L（〜1 か月）/ XL（1 か月超）。**優先** P0（信頼・安全）/ P1（中核能力）/ P2（統合・UX）/ P3（運用・将来）。
- 「HY の現状」が空欄のものは、対応する実装がない。

### 4.1 サンドボックスとセキュリティ（SEC）

| ID | 不足している機能（Codex） | Codex の根拠 | HY の現状 | 影響 | 規模 | 優先 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| SEC-01 | 読み取りの閉じ込め（exact read roots、読み取り専用 carve-out、deny-read） | `protocol/src/permissions/`、`windows-sandbox-rs/src/deny_read_acl.rs` | なし（S1） | 秘密情報の流出、信頼できないリポジトリでの事故 | L | P0 |
| SEC-02 | OS レベルのネットワーク遮断（WFP、Seatbelt、Landlock） | `windows-sandbox-rs/src/wfp*.rs`、`sandboxing/src/seatbelt_network_policy.sbpl` | なし（S2） | データ持ち出し、外部への副作用 | XL | P0 |
| SEC-03 | ネットワーク承認（宛先・ツール単位） | `core/src/tools/network_approval.rs` | なし | 遮断できないので承認もできない | M | P0 |
| SEC-04 | HTTP/SOCKS5 プロキシ、許可リスト、limited モード、MITM フック、unix socket | `network-proxy/README.md` | なし | ネットワークを「許可制」にできない | XL | P1 |
| SEC-05 | Linux サンドボックス（Landlock + seccomp + bwrap + PID ns） | `sandboxing/src/{landlock,bwrap,linux_pid_namespace}.rs` | なし（unconfined のみ） | Linux で安全に走らせられない | XL | P2 |
| SEC-06 | macOS Seatbelt | `sandboxing/src/seatbelt.rs` | なし | macOS で安全に走らせられない | L | P3 |
| SEC-07 | Windows 昇格サンドボックス（専用ユーザー、LocalSystem サービス、DPAPI、隠し SID、ConPTY） | `windows-sandbox-rs/src/{elevated_impl,setup_provisioning,desktop,dpapi,hide_users}.rs`、`windows-sandbox-service/` | 制限トークンのみ | 管理者環境での分離が弱い | XL | P2 |
| SEC-08 | Windows 読み取り拒否 ACL と保護メタデータ | `deny_read_acl.rs`、`workspace_acl.rs` | 書き込み ACL のみ | SEC-01 の Windows 実装が無い | L | P0 |
| SEC-09 | パス単位の権限モデル（split FS policy、優先順位、エイリアス正規化、fail closed） | `protocol/src/permissions/*`、`mxc-sandbox/README.md` | 3 モードのみ | きめ細かい許可ができない | XL | P0 |
| SEC-10 | 名前付き権限プロファイルと `default_permissions`、昇格経路 | `app-server-protocol/.../permissions.rs`、`core/src/config/permissions.rs` | `--sandbox` とユーザー設定のみ | 用途別の切替ができない | M | P1 |
| SEC-11 | プロセス堅牢化（no_new_privs、ambient caps、seccomp、環境の浄化） | `codex-rs/process-hardening/`、`core/src/spawn.rs` | 制限トークン + 環境 allowlist | 子プロセス経由の回避 | M | P0 |
| SEC-12 | 承認ポリシーの粒度（protocol は untrusted / on-request / granular / never、CLI は on-request / never） | `protocol/src/protocol.rs` の `AskForApproval`、`tui/src/cli.rs` | 手動 / confined 自動 / 全自動 | 運用に合った粒度がない | S | P1 |
| SEC-13 | 違反の記録・診断・レポート（denial/violation、GUI 表示） | `sandboxing/src/{violation,denial}.rs` | `gap:` を起動時に表示 | 何が止められたか分からない | M | P1 |
| SEC-14 | execpolicy の表現力（host_executable、ネットワークルール、argv 正規化） | `execpolicy/`、`core/src/exec_policy.rs` | prefix ルール + テスト | 複雑なコマンドを安全に許可できない | M | P2 |
| SEC-15 | Guardian のレビューセッション化（予算・トランスクリプト・カバレッジ・画像） | `core/src/guardian/{review_session,request_budget,transcript}.rs` | 単発呼び出し | 判定の一貫性・監査性が低い | L | P1 |
| SEC-16 | サンドボックスの既定 ON（安全側の既定） | `core/README.md`、既定の権限プロファイル | 既定 `unconfined`（S9） | 既定のまま危険 | M | P0 |
| SEC-17 | サンドボックスの e2e・違反・バイパス試行テスト | `windows-sandbox-rs/tests/`、`sandboxing/*_tests.rs` | 5 件（win10-sandbox） | 退行を検出できない | M | P1 |
| SEC-18 | シークレット管理（OS keyring、DPAPI、環境スナップショット、redaction） | `keyring-store/`、`secrets/`、`windows-sandbox-rs/src/dpapi.rs` | 環境変数名 or 平文 `config.json` | 鍵が平文で残る | M | P1 |
| SEC-19 | サンドボックス拒否からの自動回復（escalate → 再試行 → 再審査、`SandboxOverride`） | `protocol/src/sandbox.rs`、`core/src/tools/orchestrator.rs` | エラーをモデルに返すだけ | 詰まったときに人間が介在する | M | P1 |

### 4.2 実行ループとコンテキスト（CTX）

| ID | 不足している機能（Codex） | Codex の根拠 | HY の現状 | 影響 | 規模 | 優先 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| CTX-01 | モデル出力のトークンストリーミング（増分のツール呼び出し、途中経過の表示） | `core/src/client.rs`、`stream_events_utils.rs` | モデル応答は `stream: false` の一括（SSE はセッションイベントのみ） | 体感速度、長い生成の中断 | L | P1 |
| CTX-02 | プロンプトキャッシュの制御（cache key、保持、再利用の検証） | `responses_metadata.rs`、`model-provider` | キャッシュヒットの表示のみ | コスト・レイテンシ | M | P1 |
| CTX-03 | コンテキスト残量ツール（`get_context_remaining` / `new_context_window`） | `core/src/tools/handlers/get_context_remaining*.rs` | なし | モデルが圧縮を計画できない | S | P1 |
| CTX-04 | コンパクションの深さ（remote v2、メディア予算、ツール出力保持） | `core/src/compact_remote_v2*.rs`、`compact_retained_tool_outputs.rs` | Tier 1/2 のローカル要約 | 長いセッションでの劣化 | L | P2 |
| CTX-05 | 非同期コンパクション（閾値で背後実行） | `DEFAULT_ASYNC_COMPACTION_THRESHOLD_PERCENT`（65） | 同期的に要約 | ターンが止まる | M | P2 |
| CTX-06 | memories の自動パイプライン（抽出・統合・引用・telemetry） | `memories/README.md`、`core/src/memories/` | 手動 20 件（`memory.ts`） | 学習が溜まらない | L | P1 |
| CTX-07 | skills の選択・推薦・メンション・依存解決・スナップショット | `skills/src/{selection,mentions,loading}.rs` | カタログ + `skill_load` | 適切なスキルが選ばれない | M | P1 |
| CTX-08 | フックのイベント網羅（11〜12 種） | `hooks/src/{registry,schema}.rs` | 3 種 + notify | 自動化の挿し込み口が少ない | M | P1 |
| CTX-09 | AGENTS.md の深さ（階層、override、32 KiB 上限、`project_doc_fallback_filenames`、`project_root_markers`） | `core/src/agents_md.rs`、`config/src/config_toml.rs`（`project_doc_*`） | 階層 + override（`ledger.ts`） | 大規模リポジトリで破綻 | S | P2 |
| CTX-10 | セッション形式の標準化と移植性（rollout、export/import、他ツール移行） | `rollout/`、`thread-store/`、`external-agent-migration/` | 独自 JSONL、`/export` | 他ツールと相互運用できない | M | P2 |
| CTX-11 | ツール出力のトランケーション方針の明示（policy 化、保持） | `utils/output_truncation`、`exec_output` | spill + 32 KiB 閾値 | 出力の欠落が不透明 | S | P2 |
| CTX-12 | モデル別の正確なトークン計測 | `protocol/src/openai_models`、model catalog | 係数による推定（`tokens.ts`） | 予算・圧縮の誤差 | M | P2 |
| CTX-13 | レート制限・クォータの可視化 | `token_count` イベント、`usage` | 実測 usage のみ | プラン運用ができない | S | P3 |
| CTX-14 | モデルフォールバック（失敗時の代替） | `compact_model_fallback.rs`、provider 選択 | なし | 単一障害で停止 | S | P2 |
| CTX-15 | 推論パラメータの拡張（verbosity、summary、service tier） | `model-provider`、`protocol` | `effort` のみ | 出力品質の調整幅が狭い | S | P2 |
| CTX-16 | 画像の前処理（リサイズ、detail、メディア予算） | `image_preparation.rs`、`compact_remote_v2_media.rs` | 8 MiB / px 上限のみ（`read_image`） | 大きい画像で失敗 | S | P2 |
| CTX-17 | 入力添付の拡張（画像以外、MCP リソース、ドラッグ&ドロップ） | `attachment-store/`、`protocol/v2/item.rs` | png/jpeg/webp/gif 8 枚 | 資料の取り込みが弱い | M | P2 |
| CTX-18 | セッションの読み取り状態・未読・タグ・アーカイブ API | `thread read state`、`thread/list` | ピン / アーカイブ（UI 状態） | 多数セッションの管理 | S | P3 |
| CTX-19 | 指示の階層（developer / system / user、app-server 経由の注入） | `retained_instructions.rs`、protocol | システム + AGENTS.md + rules | 外部クライアントから指示を足せない | M | P2 |

### 4.3 ツール（TOOL）

| ID | 不足している機能（Codex） | Codex の根拠 | HY の現状 | 影響 | 規模 | 優先 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| TOOL-01 | `write_stdin`（実行中プロセスへの入力） | `handlers/write_stdin.rs`、`unified_exec/` | 永続シェルは 1 往復 | 対話プログラム・REPL を扱えない | M | P1 |
| TOOL-02 | `tool_search` / 遅延ロード / 名前空間 | `core/src/tools/tool_search.rs`、`tools/src/tool_search.rs` | 14 ツール固定（K9 の予算） | ツールを増やすとプロンプトが膨らむ | L | P1 |
| TOOL-03 | MCP resources / templates / prompts | `handlers/mcp_resource*.rs`、`rmcp-client/` | tools のみ | MCP サーバーの能力を半分使えない | M | P1 |
| TOOL-04 | MCP の HTTP/SSE トランスポートと OAuth | `rmcp-client/`、`app-server` の MCP OAuth | stdio のみ（`mcp.ts`） | リモート MCP に繋げない | M | P1 |
| TOOL-05 | MCP クライアントの接続プール共有・elicitation・イベントストリーム | `codex-mcp/src/{connection_manager,connection_pool,elicitation}.rs` | サーバーごとに 1 接続、elicitation なし | 多数の MCP と対話できない | M | P2 |
| TOOL-06 | `request_permissions`（モデルからの昇格要求） | `handlers/request_permissions.rs` | なし（`ask_user` で代用） | 承認フローがモデル主導でない | M | P2 |
| TOOL-07 | `request_plugin_install` / インストール可能一覧 | `handlers/request_plugin_install*.rs` | なし（市場が対象外） | 拡張の発見・導入が手作業 | M | P3 |
| TOOL-08 | マルチエージェントのライフサイクル（spawn/send/wait/close/resume/list） | `handlers/{spawn,send_input,wait,close_agent,resume_agent,list_agents}.rs` | `delegate`（同期/背景）+ GUI オーケストレーション | モデルが待機・再開できない | L | P1 |
| TOOL-09 | orchestrator ツールの本格化（並列数、待機、委譲の粒度） | `handlers/orchestrator.rs`（30 KB） | `orchestrator_*` は GUI 専用 | モデル主導の分業が弱い | L | P2 |
| TOOL-10 | `current_time` / `sleep` / `wait_for_environment` | `handlers/{current_time,sleep,wait_for_environment}.rs` | なし | 時間依存の作業ができない | S | P1 |
| TOOL-11 | 非同期のユーザー通知（`send_message_to_user_async`） | `handlers/user_messaging.rs` | なし | 長時間作業の進捗共有 | S | P3 |
| TOOL-12 | ツール出力のスキーマ付き構造化（`output_schema`、巨大スキーマの圧縮） | `tools/src/{output_schema,json_schema/compaction}.rs` | ツール結果は文字列化した JSON をそのまま返す | 出力の揺れとトークン浪費 | M | P2 |
| TOOL-13 | shell snapshot（cwd/env/alias の復元） | `core/src/shell_snapshot.rs` | `working_directory` のみ | 再起動後の再現性 | S | P2 |
| TOOL-14 | ConPTY と対話プログラム（TUI、REPL、ページャ） | `unified_exec/process_manager.rs`、`conpty` | 永続シェル（非対話） | 端末アプリを操作できない | L | P2 |
| TOOL-15 | `view_image` の detail 制御（HY は `read_image` あり） | `handlers/view_image_spec.rs` | `read_image`（サイズ上限のみ） | 画像トークンの制御 | S | P2 |
| TOOL-16 | ホスト型ツール（web_search / image_gen） | `spec_plan.rs`、hosted tools | SearXNG 経由の `web_search`、画像生成なし | 検索品質・画像生成 | M | P3 |
| TOOL-17 | 検索ツールの直接公開（glob/grep を wire に） | — | `run_code` 内のみ | 小モデルが検索を使えない | S | P2 |
| TOOL-18 | 実行時の動的ツール登録（MCP/プラグイン） | `tools/src/dynamic_tool.rs`、`tool_discovery.rs` | 起動時に固定 | セッション中の拡張 | M | P3 |

### 4.4 プロトコルと統合（PROTO）

| ID | 不足している機能（Codex） | Codex の根拠 | HY の現状 | 影響 | 規模 | 優先 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| PROTO-01 | app-server 相当のステートフル JSON-RPC（thread/turn/item、承認、割り込み） | `app-server/`、`app-server-protocol/` | HTTP API + SSE（`web-server.ts`） | 第三者クライアントが作れない | XL | P1 |
| PROTO-02 | プロトコルのスキーマ・バージョニング・生成物・fixtures（`generate-ts` / `generate-json-schema`） | `protocol/v1.rs`、`v2/`、`schema_fixtures.rs`、`cli/src/main.rs` | ルート契約 + 型生成（`api-contract.ts`） | 互換性の保証がない | L | P1 |
| PROTO-03 | 複数トランスポート（stdio / WS / unix）と daemon | `app-server-transport/`、`app-server-daemon/` | HTTP のみ | 常駐・複数接続が弱い | L | P2 |
| PROTO-04 | IDE 拡張（VS Code / Cursor / Windsurf） | README 冒頭、`app-server` | なし（承認済み対象外） | IDE ユーザーを取り込めない | XL | P3 |
| PROTO-05 | exec-server のネットワーク待受・PTY・リモート | `exec-server/README.md`（ws://） | stdio のみ、PTY は GUI 側 | 遠隔実行・サンドボックス外実行ができない | L | P2 |
| PROTO-06 | プロトコル経由の設定変更（config/*、MCP 再読み込み、プラグイン） | `app-server` の `config/*` | HTTP の `/api/settings`（再起動要） | 実行中の構成変更ができない | M | P2 |
| PROTO-07 | レビュー専用 API（`review/start`、差分レビュー） | `app-server`、`core/src/tools/review` | `hy review`（サブエージェント） | 構造化されたレビュー結果がない | S | P2 |
| PROTO-08 | スレッドの rollback / archive / read state API | `protocol/v2/thread.rs` | `/undo`、ピン/アーカイブ（UI） | API からの操作ができない | M | P2 |
| PROTO-09 | 複数クライアントの同時接続と購読 | `app-server` の connection handling | SSE 1 本 + セッション | 家庭内の複数端末で競合 | M | P3 |
| PROTO-10 | SDK の充実（TS `@openai/codex-sdk` / Python `openai-codex`、型付きクライアント、例、テスト） | `sdk/typescript`、`sdk/python`、`app-server-client/` | TS/Python の薄いクライアント | 外部連携の敷居が高い | M | P2 |
| PROTO-11 | 他エージェントからの移行（Claude Code 等） | `external-agent-migration/` | なし | 乗り換えコスト | L | P3 |
| PROTO-12 | プラグイン市場とリモートカタログ | `core-plugins/`（99 ファイル） | なし（対象外） | 拡張の配布 | XL | P3 |
| PROTO-13 | スレッド単位の git worktree | `codex-rs/worktree/`、`/worktree` | なし（A+ の制約） | 並列作業の衝突 | L | P1 |
| PROTO-14 | プロジェクト信頼モデル（trust levels、worktree trust） | `worktree_trust_tests.rs`、`app-server` の project trust | `trustedProjects`（真偽値） | 段階的な信頼ができない | M | P2 |
| PROTO-15 | 認証の統合（OAuth、SSO、Azure/Bedrock/GCP、ゲートウェイ） | `login/`、`model-provider/src/auth.rs` | API キーのみ | 企業環境で使えない | XL | P3 |

### 4.5 UX（UX）

| ID | 不足している機能（Codex） | Codex の根拠 | HY の現状 | 影響 | 規模 | 優先 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| UX-01 | フルスクリーン TUI（差分ビュー、スクロール、マウス） | `tui/`（1203 ファイル） | 行単位 REPL + GUI | 端末だけで完結しない | XL | P3 |
| UX-02 | 差分ビューア・トランスクリプトモード・履歴検索 | `tui/src/` | Diff タブ、Trace（生ログ） | レビューのしやすさ | M | P2 |
| UX-03 | スラッシュコマンドの網羅（65 個: `/goal` `/plan` `/agents` `/worktree` `/import` `/doctor` 相当） | `tui/src/slash_command.rs` | 約 18（`/help` 一覧） | 発見性・操作速度 | M | P2 |
| UX-04 | キーマップ / Vim モード / statusline / テーマ | `tui_keymap.rs`、`/vim`、`/theme` | テーマ + ショートカット編集 | 好みに合わせられない | M | P3 |
| UX-05 | 音声モード（realtime conversation） | `voice-host/`、`realtime-webrtc/`、`/voice` | なし | ハンズフリー操作 | XL | P3 |
| UX-06 | セッション管理（rename/archive/delete/fork/worktree） | `tui`、`app-server` | rename/fork/archive あり、worktree なし | — | S | P2 |
| UX-07 | サイド会話（`/side`、`/btw`） | `slash_command.rs` | なし | 本筋を汚さず質問できない | M | P3 |
| UX-08 | 承認 UI の情報量（差分・ネットワーク・権限の可視化） | `tools/approvals.rs`、permissions | コマンド文字列と理由のみ | 判断材料が足りない | M | P1 |
| UX-09 | モデル切替と推論強度の即時変更（`/model` 内で effort を変える、プリセットの保存） | `tui`、`/model`、`/presets` | `/model` で切替、強度は Settings | 試行錯誤が遅い | S | P3 |
| UX-10 | コマンドパレットの範囲 | `tui` | Ctrl+K（コマンド + セッション） | やや狭い | S | P3 |
| UX-11 | 通知と OS 統合（種別、クリックで移動） | `notify`、hook legacy_notify | 非アクティブ時の通知 | 通知の文脈が薄い | S | P2 |
| UX-12 | 画像のクリップボード貼り付け（スクリーンショットをそのまま渡す） | `clipboard_paste.rs`、`image_preparation.rs` | ファイル選択とドラッグ&ドロップのみ | 画面共有の手間 | S | P3 |
| UX-13 | オンボーディングと移行ウィザード | `/import`、`external-agent-migration` | 3 ステップの初回ウィザード | 移行がない | M | P3 |

### 4.6 モデル（MODEL）

| ID | 不足している機能（Codex） | Codex の根拠 | HY の現状 | 影響 | 規模 | 優先 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| MODEL-01 | Responses API の hosted tools 連携 | `core/src/client.rs`、hosted tools | Responses プロバイダはあるが hosted tools なし | 検索・生成が自前 | M | P3 |
| MODEL-02 | Azure / Bedrock / GCP プロバイダ | `model-provider/src/provider.rs` | なし | 企業クラウドで使えない | L | P3 |
| MODEL-03 | ChatGPT ログインとプラン | `login/` | なし | 公式課金・枠が使えない | XL | P3 |
| MODEL-04 | モデルカタログの自動更新と能力記述（vision/reasoning/tool mode） | `model-provider/src/models_endpoint.rs` | `listProviderModels` + 組み込みカタログ | 新モデルへの追従が遅い | M | P2 |
| MODEL-05 | tool mode（direct / code mode / code-mode-only）のモデル別切替 | `core/src/tools/mod.rs` | `--ptc` の全体切替 | モデルに合わない | M | P2 |
| MODEL-06 | プロバイダ別の推論パラメータ | `protocol/src/openai_models` | `effort` のみ | 品質・コストの調整 | S | P2 |
| MODEL-07 | プロキシ・カスタム CA・HTTP/2 | `http-client/`（6 KB README） | Node の fetch 既定 | 企業網で使えない | M | P3 |
| MODEL-08 | LM Studio など他のローカル | クラート `lmstudio`、`ollama` | Ollama のみ | 選択肢が狭い | S | P3 |

### 4.7 マルチエージェントと協調（AGENT）

| ID | 不足している機能（Codex） | Codex の根拠 | HY の現状 | 影響 | 規模 | 優先 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| AGENT-01 | サブエージェントの待機・再開・列挙（モデルから） | `handlers/{wait,resume_agent,list_agents}.rs` | `delegate`（同期/背景） | 並列作業の回収が弱い | M | P1 |
| AGENT-02 | エージェントロール / グラフ / メッセージボード | `agent-roles/`、`agent-graph-store/`、`message-board/` | Orchestration A+（役割固定） | チーム的な分業ができない | L | P3 |
| AGENT-03 | エージェント間メッセージング | `handlers/send_message.rs` | `send`（GUI） | モデル同士が会話できない | M | P2 |
| AGENT-04 | オーケストレーターの深さ（同時数、待機、委譲） | `handlers/orchestrator.rs`、multi-agent v2 既定 | 3 ワーカー・スコープ検査 | 大規模分割に弱い | L | P2 |
| AGENT-05 | 中断・再開・引継ぎ（セッションを跨ぐ） | `app-server` の resume、`resume_agent` | 再起動で interrupted | 長時間作業の継続 | M | P2 |
| AGENT-06 | 子エージェントごとの予算・メールボックス・退避（配送、完了通知、residency） | `core/src/agent/control/{budget,mailbox,delivery,residency}.rs` | 固定の親子と完了通知のみ | 多数の子を安全に走らせられない | M | P1 |
| AGENT-07 | 音声エージェント | `realtime_conversation.rs`（108 KB） | なし | — | XL | P3 |

### 4.8 設定・運用・配布（OPS）

| ID | 不足している機能（Codex） | Codex の根拠 | HY の現状 | 影響 | 規模 | 優先 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| OPS-01 | 設定レイヤ（system / managed / requirements、MDM） | `config/src/loader/`、managed config | ユーザー + プロジェクト | 組織の統制ができない | L | P2 |
| OPS-02 | `-c key=value` 上書き、`--enable/--disable <FEATURE>`、プロファイル/プリセット | `utils/cli/src/config_override.rs`、`cli/src/main.rs` | `--profile` のみ | 一時的な切替が重い | S | P1 |
| OPS-03 | フィーチャーフラグ | `codex-rs/features/` | なし | 段階的リリースができない | M | P2 |
| OPS-04 | OTEL メトリクス + managed OTEL 設定 | `otel/README.md` | OTLP span のみ（opt-in） | 運用監視が弱い | M | P2 |
| OPS-05 | アナリティクス（opt-in、イベント設計） | `analytics/` | ローカルのフィードバックのみ | 改善の計測ができない | M | P3 |
| OPS-06 | 失敗時のフィードバック自動収集（ログ・設定・診断のバンドル化） | `feedback/src/{archive,upload}.rs` | 手動の ✓/✗ のみ | 不具合報告が手作業 | S | P3 |
| OPS-07 | 診断（panic ハンドラ、バックトレース、ログローテーション、サポートバンドル） | `diagnostics/`、`logging.rs` | stderr ログ | 障害調査が困難 | M | P2 |
| OPS-08 | 単一バイナリ配布（Node 不要） | Rust + npm ラッパー | Node 24 + Electron 必須 | 配布・起動が重い | XL | P2 |
| OPS-09 | パッケージマネージャ配布（npm/brew/scoop/winget） | README、`codex-cli/` | portable exe のみ | 導入の敷居 | M | P2 |
| OPS-10 | コード署名と SmartScreen 対応 | リリース手順 | 未署名（README 記載） | 警告が出る | S | P1 |
| OPS-11 | マルチプラットフォーム CI（Linux/macOS） | `.github/workflows/` | Windows のみ | 他 OS の退行 | L | P2 |
| OPS-12 | ドキュメントサイトとリファレンス | developers.openai.com/codex | リポジトリ内 docs | 発見性 | L | P3 |
| OPS-13 | 環境診断コマンド（`codex doctor --json --summary --network-only`） | `cli/src/doctor.rs` | `hy sandbox status` / `policy-test` / `/api/health` | 導入時の切り分けが手作業 | S | P2 |
| OPS-14 | trace bundle とオフライン再生（`rollout-trace`、`codex debug trace-reduce`） | `rollout-trace/README.md`、`cli/src/main.rs` | Trace タブ（生ログ） | 不具合の再現・共有が難しい | M | P2 |

### 4.9 品質（QA）

| ID | 不足している機能（Codex） | Codex の根拠 | HY の現状 | 影響 | 規模 | 優先 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| QA-01 | スナップショットテスト | `insta`、1,719 `.snap` | ゴールデン 1 種（K1–K14） | UI/プロンプトの退行検出が弱い | M | P2 |
| QA-02 | プロパティ / ファズテスト | `proptest` 等 | なし | 境界のバグ | M | P3 |
| QA-03 | モックモデルによる大規模 e2e 基盤 | `core/tests/`、test client | mock プロバイダ + 49 結合 | シナリオ網羅が弱い | M | P2 |
| QA-04 | Bazel / リモートキャッシュ | `BUILD.bazel`、`MODULE.bazel` | pnpm + cargo | ビルド時間 | L | P3 |
| QA-05 | カバレッジの可視化と CI ゲート | CI | 98.9 % / 89.2 % を計測、ゲートは無し | 退行 | S | P2 |
| QA-06 | ベンチの継続計測 | `criterion` 等 | `bench:startup`、`bench:checkpoint` | ほぼ同等 | S | P3 |

---

## 5. HY-HARNESS が上回る点（残すべき強み）

1. **完了の独立検証**。`hy ralph` は「改ざん検査 → 検証コマンド（Gate 1）→ 別モデルの grader（Gate 2）」を通るまで受理しない。Codex の完了はモデルの自己申告で、`ralph` に相当する機構を持たない（`packages/seams/src/verifier-ralph.ts`、`tests/integration/verifier-ralph.test.mjs`）。
2. **4 次元予算**（ラウンド・トークン・USD・実時間）とラウンド単位のロールバック（`packages/seams/src/budget.ts`）。
3. **チェックポイントの性能と取り消し**。1 万ファイルで作成 約 625 ms、ロールバック 約 265 ms。Codex の ghost snapshot も同思想だが、HY は目標値と計測手順を固定している（`docs/implementation_status.md` §2.9）。
4. **ゴールの自律ラウンド**。永続化された 1 目的、`update_goal`、Grader による未達判定、自動継続（`packages/hy-cli/src/goal.ts`）。
5. **プラン専用オーケストレーション**。オーケストレーターは書き込み不可、ワーカーはスコープ必須・重複拒否・直列シェル・git/undo 禁止（`packages/hy-cli/src/orchestration.ts`）。Codex の multi-agent は自由度が高いが、**スコープ衝突の防止は HY が上**。
6. **Windows デスクトップ GUI と 3 言語 UI**。TUI しか持たない Codex に対し、承認・ゴール・プラン・Diff・Trace・Browser・Terminal・Desktop を 1 画面に持つ。
7. **PTC のトークン予算の明示**。14 ツール + SDK で 1,183〜1,185 トークン（上限 1,200）を計測し、毎回の結合テストで守る（`tests/integration/tool-overhead.test.mjs`）。
8. **固定制約を要約しない**。AGENTS.md と `--rule` は毎回そのまま、モデルメモは上限で拒否（`packages/core/src/ledger.ts`）。
9. **ACP と MCP サーバーを持つ**。Codex には ACP が無く、MCP サーバーも無い（`hy acp`、`hy mcp-server`）。エディタ統合の選択肢として HY が上。
10. **LSP ツールを持つ**。定義・参照・ホバー・診断・シンボルをモデルから引ける（`packages/core/src/lsp.ts`）。Codex に LSP は無い。

---

## 6. 結論

- **「機能の有無」だけを見ると HY は Codex の 7〜8 割をカバーしている**。しかし **「同じ機能をどれだけ深く、安全に、第三者が使える形で提供しているか」では 3〜4 割**である。差が大きいのは (1) 封じ込め、(2) ツールの拡張性、(3) プロトコル、(4) メモリ/フック/スキルの自動化、(5) 配布と運用。
- したがって **「機能を足す」より「既にある機能の深さを Codex 水準に引き上げる」方が投資対効果が高い**。特にサンドボックスは、HY の思想（Windows 10・ローカル・検証ゲート）を壊さずに強化できる。
- 実装計画は [codex-adoption-plan.md](codex-adoption-plan.md)。**P0 7 件だけで「安全に人に渡せる」水準**になり、P1 28 件で「日常的に使える」、P2 以降で「他ツールと競える」水準になる。

