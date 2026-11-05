# Codex 差分の導入計画（実装計画 v1）

- **実装状況**: 2026-11-05 の時点で **C0〜C2 を完了**、C3 は CP-25/CP-26（JSON-RPC の thread/turn 制御・承認・API スキーマ）、C5 は CP-37/38/39/42 を実装済み。C4 の GUI と C3 の WS/SDK・C5 の配布物は未着手。WP 単位の表は [implementation_status.md §7](implementation_status.md)、ラウンドごとの検証は [codex-adoption-progress.md](codex-adoption-progress.md)。
- **前提**: [codex-gap-analysis.md](codex-gap-analysis.md) の 119 件（P0: 7、P1: 28、P2: 51、P3: 33）。
- **日付**: 2026-11-05。**対象**: HY-HARNESS v0.4.0（Windows 10 first、TS 制御プレーン + Rust 実行デーモン）。
- **原則**:
  1. **既存の強みを壊さない**。検証ゲート（`hy ralph`）、チェックポイント、ゴール、Orchestration A+、K1–K14 の不変条件、PTC の 1,200 トークン予算は維持する。
  2. **安全側の既定に寄せる**。サンドボックスは「使うと安全」ではなく「既定で安全、必要なら外す」に変える。ただし移行期間の互換モードを用意する。
  3. **機能を足すより深さを上げる**。同じ名前の機能（Guardian、hooks、memories、approval）を Codex 水準の異常系・診断・予算まで作る。
  4. **境界はプロトコルに置く**。GUI・CLI・IDE・SDK は同じ app-server 相当の面を使う。
  5. **すべての作業パッケージに受け入れテストを付ける**。テストのない WP は完了にしない。
- **ネットワークは後回し（2026-11-05 のユーザー指示）**: CP-03（閉じ込め・プロキシ）と CP-04（ネットワーク承認）、および SEC-02/03/04 は実装しない。C0 の残り（CP-01/02/05/06/07/08/44）を先に進め、ネットワークは個人利用段階の後に別計画とする。進捗は [codex-adoption-progress.md](codex-adoption-progress.md)。\n- **見積り**: 全 44 WP で約 **389 人日**、**今回の対象（ネットワーク以外）は約 363 人日**（後述 §8）。Codex が 2 年以上・大規模チームで作ったものを 1 人で追う前提なので、**「採る範囲」を絞った上での楽観値**である。

---

## 1. ロードマップ

| フェーズ | 内容 | WP | 人日 | 出口条件 |
| :--- | :--- | :--- | --: | :--- |
| **C0** 封じ込め | 既定サンドボックス、パス権限、承認、診断、シークレット、Guardian の深化（ネットワークは後回し） | CP-01/02/05/06/07/08/44 | 50 | `workspace-write` が既定で、読み取りが制限され、違反が GUI/CLI に出る。Sandbox e2e が Windows 10 で通る |
| **C1** 道具箱 | `write_stdin`、`tool_search`、MCP 拡張、ユーティリティ、サブエージェント制御、worktree | CP-09〜CP-17 | 75 | モデルが対話プロセスを操作でき、必要ならツールを探してロードできる。サブエージェントを待機・再開できる |
| **C2** ループ | ストリーミング、フック 11 種、memories、skills 選択、コンパクション、トークン精度 | CP-18〜CP-24 | 61 | 生成が逐次表示され、フックで 11 点に介入でき、セッションを跨ぐ記憶が自動で溜まる |
| **C3** プロトコル | HY Protocol v1、スキーマ生成、daemon、exec-server、SDK、移行 | CP-25〜CP-31 | 79 | 第三者が `@hy/protocol` でクライアントを書ける。CLI/GUI/SDK が同じ面を使う |
| **C4** UX | スラッシュコマンド、差分/履歴、承認 UI、セッション管理、キーマップ | CP-32〜CP-36 | 32 | GUI の操作網羅が Codex の主要コマンドに追いつく |
| **C5** 運用 | 設定レイヤ、フラグ、OTEL/診断、署名、単一バイナリ、QA | CP-37〜CP-43 | 66 | 配布・診断・観測が製品水準。署名済み exe が出る |

**実行順序**: C0 を最優先で完結させる（他フェーズと並行しない）。その後 C1 と C2 を並行、C3 は C2 の後半から、C4 は C1 の後、C5 は随時。**クリティカルパスは CP-02 → CP-03 → CP-25 → CP-26**。

---

## 2. 作業パッケージ（C0: 封じ込め）

### CP-01 既定サンドボックスの切替と互換モード（SEC-16、4 日）
- **内容**: 既定を `workspace-write` にし、`--unsafe-unconfined` を明示したときだけ `unconfined` にする。既存ユーザーのために `sandbox.mode` 未設定時の 1 回だけの移行プロンプトを出し、`legacyUnconfined: true` を設定に書いた場合のみ旧動作を維持する。
- **変更**: `packages/core/src/config.ts`、`sandbox-mode.ts`、`packages/hy-cli/src/cli-args.ts`、`packages/desktop`（初回ウィザード）。
- **受け入れ**: 新規ワークスペースで `hy run` が `workspace-write` で起動し、`hy sandbox status` が既定を示す。旧設定の移行テスト。既存 K1–K14 と `win10-sandbox.test.mjs` が通る。
- **リスク**: ACL 付与の初回コストと、AppContainer ACE のあるディレクトリ（S7）での起動失敗。ウィザードで事前検査する。

### CP-02 パス権限モデル v1（SEC-01、SEC-08、SEC-09、18 日）
- **内容**: `PermissionProfile` を導入する。`{ read: path[] | 'all' | 'none', write: path[], denyRead: path[], denyWrite: path[] }` を名前付きで定義し、`default_permissions` で選ぶ。Windows の制限トークンに対し、(a) deny-read の ACL（`FILE_GENERIC_READ` の deny ACE）、(b) 書き込みルート配下の読み取り専用 carve-out、(c) パスの正規化（`\\?\` 除去、symlink/junction の実体解決、大文字小文字）を実装する。強制できない指定は **起動時に拒否**する（fail closed）。
- **変更**: `crates/hy-sandbox-windows/src/{token,acl,grants,workspace_acl}.rs`、`crates/hy-exec-server/src/rpc.rs`（`initialize` の権限受け渡し）、`crates/hy-protocol`（型）、`packages/core/src/{config,sandbox-mode}.ts`。
- **受け入れ**: `denyRead: ["~/.ssh", "**/.env"]` で子プロセスが `EACCES`/`ACCESS_DENIED` になる。carve-out 配下は読み取り専用。`hy sandbox status` が実効ポリシーを返す。新規 `tests/integration/sandbox-permissions.test.mjs`（8 ケース）。
- **リスク**: ACL の順序（explicit deny が継承 allow に勝つ）と、付与の取り消し漏れ。`grants` の記録形式を拡張し、`revoke` の往復テストを必須にする。

### CP-03 ネットワークの閉じ込めとプロキシ（SEC-02、SEC-04、20 日）
- **内容**: 2 段で作る。**(1) プロキシ**: ローカルの HTTP プロキシ（許可リスト、`CONNECT`、ループバックのみ待受、`HTTP(S)_PROXY` の子プロセス注入）。**(2) 遮断**: Windows の WFP フィルタで、confined トークンの子プロセスの外向き通信を既定で遮断し、プロキシとループバックだけ通す。WFP が使えない環境（非管理者・グループポリシー）では **サンドボックス起動を拒否**し、`--allow-network` を明示したときだけ通す。
- **変更**: 新規 `crates/hy-sandbox-windows/src/wfp.rs`（`FwpmFilterAdd` ラッパー）、`crates/hy-exec-server/src/`、`packages/core/src/tools.ts`（シェル起動時の環境注入）、`docs/enforcement-gaps.md`。
- **受け入れ**: confined の `curl https://example.com` が失敗し、許可した宛先だけ通る。プロキシ経由の許可宛先は通る。ループバックのモデルサーバー（Ollama）は通る。`gap:` ではなく `network: confined (allowlist n)` と表示する。新規 `tests/integration/sandbox-network.test.mjs`（8 ケース）。
- **リスク**: WFP は管理者権限とドライバ依存。**代替として「プロキシ必須 + プロキシ外への直接通信は OS で保証しない」段階を設け、診断で明示する**（S2 の正直な縮小）。

### CP-04 ネットワーク承認とドメイン許可（SEC-03、6 日）
- **内容**: 承認要求の種別に `network` を足し、`host`・`port`・`protocol`・`command` を表示する。ユーザーは「1 回 / このセッション / 常に」を選ぶ。Guardian は confined のネットワーク要求だけ審査できる（unconfined は不可）。
- **変更**: `packages/core/src/tools.ts`（承認コールバックの型拡張）、`packages/seams/src/guardian.ts`、`packages/hy-cli/src/web-server.ts`（承認カード）、`web/app.ts`。
- **受け入れ**: 承認カードに宛先が出る。拒否するとツールエラーとしてモデルに戻る。Guardian の判定がログに残る。`web-ui.test.mjs` に 3 ケース追加。
- **依存**: CP-03。

### CP-05 承認ポリシーの拡張と `request_permissions`（SEC-12、TOOL-06、5 日）
- **内容**: `approvalPolicy` を `untrusted | on-request | on-failure | never` に拡張し、`--full-auto` は `on-failure` の別名として残す。`request_permissions` ツールを追加し、モデルが「読み取り追加」「書き込み追加」「ネットワーク」を要求できるようにする。要求は CP-02 のプロファイル差分として承認 UI に出し、承認された範囲だけセッション中に有効化する。
- **変更**: `packages/core/src/{config,tools,tool-registry}.ts`、`crates/hy-exec-server`（実行時の権限更新 RPC）。
- **受け入れ**: モデルが `request_permissions` を呼び、承認後にだけ対象パスへ書ける。拒否時はツールエラー。`tool-registry.test.ts` と新規結合テスト。

### CP-06 違反レポート・診断 UI・拒否からの自動回復（SEC-13、SEC-19、UX-08、6 日）
- **内容**: 拒否された操作（読み取り拒否、書き込み拒否、ネットワーク拒否、ポリシー deny）を `sandbox/denial` イベントとして記録し、セッションログと GUI の Details → Sandbox に表示する。`hy sandbox status --json` に実効ポリシーと直近の拒否を含める。承認カードには「なぜ止まったか」と「許可する方法」を書く。**自動回復**として、拒否が権限不足に分類できた場合は 1 回だけ権限を広げて再試行し、その旨を承認要求として出す（モードは `escalate-once` で無効化できる）。
- **変更**: `crates/hy-sandbox-windows`、`crates/hy-exec-server/src/session_log.rs`、`packages/hy-cli/src/web-server.ts`、`web/app.ts`、`web/i18n.ts`。
- **受け入れ**: 拒否 3 種が GUI に出る。`web-ui.test.mjs` に 2 ケース。スクリーンショット更新。

### CP-07 プロセス堅牢化と環境スナップショット（SEC-11、4 日）
- **内容**: confined の子プロセス起動時に、(a) 親の環境を許可リストで再構築、(b) `PROCESS_MITIGATION_*` ポリシー（ASLR、CFG、子プロセス制限）を可能な範囲で設定、(c) `NoNewPrivs` 相当（トークンの特権除去）を確認する。`shell { env: {...} }` の明示上書きだけを許可する。
- **変更**: `crates/hy-sandbox-windows/src/{token,process}.rs`、`crates/hy-exec-server/src/cmdline.rs`。
- **受け入れ**: 許可外の環境変数が子プロセスに見えない。既存の `envPassthrough` テストが通る。

### CP-08 シークレット管理（SEC-18、5 日）
- **内容**: API キーを Windows Credential Manager（`CredWrite`）に保存する `SecretStore` を追加し、`config.json` には参照（`keyring:hy/deepseek`）だけを書く。既存の平文キーは初回起動時に移行する。ログと GUI にはマスク済みの値だけを出す（`secret-mask.ts` を共通化）。
- **変更**: 新規 `packages/core/src/secrets.ts`、`packages/hy-cli/src/{main,web-server}.ts`、`config.schema.json`。
- **受け入れ**: 平文キーが `config.json` から消える。`hy config dump` が `keyring:` を出す。移行テスト。

---

### CP-44 Guardian のレビューセッション化（SEC-15、8 日）
- **内容**: Guardian を「1 回の判定」から「レビューセッション」に変える。(a) 直近のツール呼び出しと差分を文脈として渡す、(b) 入出力のトークン予算と締切、(c) 判定の根拠（引用）を残す、(d) 同じコマンドの再判定をキャッシュする、(e) 拒否が続いたら circuit breaker で人に回す、(f) 画像を含む承認（スクリーンショット）に対応する。
- **変更**: `packages/seams/src/guardian.ts`（拡張）、`packages/core/src/agent.ts`（呼び出し点）、`web/app.ts`（根拠の表示）。
- **受け入れ**: 判定の根拠が GUI に出る。同じコマンドの再判定が 0 回になる。予算超過で人に回る。`guardian.test.ts` を 8 → 14 ケースに拡張。
- **依存**: CP-05、CP-06。

---
## 3. 作業パッケージ（C1: 道具箱）

### CP-09 `write_stdin` と unified exec（TOOL-01、TOOL-14、12 日）
- **内容**: exec-server に「セッション」概念を追加する。`exec/start`（PTY 付き、`yield_time_ms`、`max_output_tokens`）、`exec/write`（`chars`）、`exec/poll`、`exec/kill`。モデル向けには `shell` の `persistent: true` を拡張し、`write_stdin` ツールを足す。既存の `job_*` は「バックグラウンド」用に残す。
- **変更**: `crates/hy-exec-server/src/{jobs,pty}.rs`、`crates/hy-protocol`、`packages/core/src/{exec-rpc,tools,tool-registry}.ts`。
- **受け入れ**: `python` の REPL に式を送って出力が返る。TUI アプリの起動と終了ができる。タイムアウトで Job が確実に終了する。`tests/integration/unified-exec.test.mjs`（5 ケース）。
- **リスク**: 出力のバッファリングとバイナリ混在。`max_output_tokens` で切り、spill に逃がす。

### CP-10 `tool_search` と遅延ロード（TOOL-02、14 日）
- **内容**: ツールを `Direct | Deferred | DirectModelOnly | Hidden` に分類し、`tool_search` で名前・説明を検索してロードする。プロンプトには Direct だけを載せ、Deferred は「検索で見つかる」と 1 行で示す。K9 の 1,200 トークンは「初期プロンプト」の上限として維持し、ロード後の合計は別枠で計測する。
- **変更**: `packages/core/src/{tool-registry,prompt,agent}.ts`、`packages/hy-cli/src/session-app.ts`、`tests/integration/tool-overhead.test.mjs`。
- **受け入れ**: 初期プロンプトのツール定義が減り、`tool_search` で MCP/プラグインのツールをロードできる。トークン計測を更新。K9 は「初期 ≤1,200」に再定義し、テストを 2 本に分ける。
- **リスク**: モデルが検索を使わず「ツールがない」と答える。システムプロンプトに検索の使い方を明示し、`delegate` などは Direct に残す。

### CP-11 MCP の拡張（TOOL-03、TOOL-04、TOOL-05、12 日）
- **内容**: MCP クライアントを (a) stdio / HTTP / SSE、(b) OAuth（PKCE、device code）、(c) `resources/list`・`resources/read`・`resources/templates`、(d) `prompts/list`・`prompts/get`、(e) elicitation、(f) 接続プールに拡張する。モデル向けに `list_mcp_resources`・`read_mcp_resource` を追加し、リソースは `@mcp:` 参照で添付できるようにする。
- **変更**: `packages/core/src/mcp.ts`（全面的に書き直し）、`tool-registry.ts`、`packages/hy-cli/src/{web-server,app}.ts`。
- **受け入れ**: HTTP MCP サーバーに繋がる。resource を読める。OAuth のモックサーバーでトークン更新が通る。`mcp.test.ts` を 3 倍に拡張。
- **リスク**: OAuth のブラウザ起動（Electron と CLI で経路が違う）。`openExternal` を抽象化する。

### CP-12 ユーティリティツール（TOOL-10、CTX-03、4 日）
- **内容**: `current_time`、`sleep`（上限付き）、`get_context_remaining`、`new_context_window` を追加する。`get_context_remaining` は provider の実測 usage と推定の差を返す。
- **変更**: `packages/core/src/{tools,tool-registry}.ts`、`packages/seams/src/spill-compaction.ts`（残量の計算）。
- **受け入れ**: 長時間作業でモデルが残量を見て圧縮を選べる。単体テスト 4 件。

### CP-13 shell snapshot（TOOL-13、3 日）
- **内容**: セッション開始時に `cwd`・主要環境変数・PowerShell のプロファイル有無を記録し、再開時に復元する。`working_directory` の変更履歴も残す。
- **変更**: `packages/core/src/tools.ts`、`packages/core/src/session-log.ts`、`crates/hy-exec-server`。
- **受け入れ**: 再開後に `cwd` が一致する。`session-fork` でも引き継がれる。

### CP-14 検索ツールの直接公開とツール表の再設計（TOOL-17、4 日）
- **内容**: `search_glob` / `search_grep` を Direct に昇格し、`run_code` 内の `tools.search.*` と同じ実装を共有する。あわせて `tool-registry` のスキーマを「説明・引数・返り値・公開クラス」の構造に整理する。
- **変更**: `packages/core/src/{tool-registry,tools}.ts`。
- **受け入れ**: 小モデルが検索を直接使える。K9 の初期プロンプトを再計測。

### CP-15 サブエージェント制御プレーン（TOOL-08、AGENT-01、AGENT-03、10 日）
- **内容**: `spawn_agent`・`send_input`・`wait_agent`・`close_agent`・`resume_agent`・`list_agents` を追加し、既存の `delegate` をその上に載せる。待機は `yield_time_ms` 付きで、バックグラウンドの子を回収できる。子の状態（running/waiting/done/interrupted）を既存の Orchestration A+ と共有する。
- **変更**: `packages/core/src/{tools,agent}.ts`、`packages/hy-cli/src/{session-app,orchestration}.ts`、`packages/hy-cli/src/web-server.ts`。
- **受け入れ**: 2 体の子を並行に走らせ、片方だけ待って結果を使える。中断・再開ができる。`subagent.test.mjs` を拡張。
- **リスク**: 既存のスコープ検査との整合。ワーカーの生成 API を一本化する。

### CP-16 ワークツリー分離（PROTO-13、12 日）
- **内容**: スレッド/ワーカーごとに `git worktree` を作り、`--worktree` と GUI の「新しいワークツリーで開始」を追加する。マージは自動にせず、`orchestrator_diff` と `hy worktree apply` で明示的に行う。keep-count と自動掃除の設定を持つ。
- **変更**: 新規 `packages/core/src/worktree.ts`、`packages/hy-cli/src/{main,orchestration}.ts`、`crates/hy-exec-server`（cwd の切替）。
- **受け入れ**: 2 つのワーカーが同じファイルを編集しても衝突しない。`apply` で取り込める。`worktree.test.ts`（4 ケース）。
- **リスク**: exFAT の F: では worktree が遅い/失敗する。NTFS を要求し、`gap:` で明示する。

### CP-17 画像前処理（TOOL-15、CTX-16、4 日）
- **内容**: `read_image` に `detail`（high/original）と自動リサイズを追加し、プロバイダごとの上限に合わせる。メディア予算をコンパクションに反映する。
- **変更**: `packages/core/src/{tools,llm}.ts`、`packages/seams/src/spill-compaction.ts`。
- **受け入れ**: 4,000 px の画像が自動で縮小され、トークンが想定内に収まる。

---

## 4. 作業パッケージ（C2: ループとコンテキスト）

### CP-18 ストリーミング（CTX-01、12 日）
- **内容**: 各プロバイダで SSE を読み、`assistant/delta`・`thinking/delta`・`tool-call/delta` をセッションログと GUI に流す（現状はセッションイベントだけが SSE で、モデル応答は一括）。ツール呼び出しの JSON は増分で組み立て、壊れたら従来のリトライに落とす。停止は `AbortSignal` を SSE の reader まで伝播させる。
- **変更**: `packages/core/src/llm.ts`、`packages/core/src/agent.ts`、`packages/hy-cli/src/{chat-projection,web-server}.ts`、`web/app.ts`。
- **受け入れ**: 長い応答が逐次表示され、Stop が 500 ms 以内に効く。`llm.test.ts` に SSE フィクスチャ 3 種。

### CP-19 フックの拡張（CTX-08、7 日）
- **内容**: `sessionStart`・`sessionEnd`・`userPromptSubmit`・`preCompact`・`postCompact`・`permissionRequest`・`stop`・`interrupt`・`modelRequest`・`subagentStart`・`subagentStop` を追加する。各フックは JSON を stdin で受け取り、`{ block, reason, mutate }` を stdout で返せる。MCP フック（サーバー経由）も許可する。
- **変更**: `packages/core/src/hooks.ts`、`agent.ts`、`packages/hy-cli/src/session-app.ts`、`docs`。
- **受け入れ**: 各イベントが発火する。`block` が効く。`hooks.test.mjs` を 11 ケースに拡張。

### CP-20 memories パイプライン（CTX-06、14 日）
- **内容**: (1) セッション終了時に rollout から「学び」を抽出、(2) ワークスペース単位で統合・重複排除、(3) 開始時に引用付きで注入、(4) `memory/status` と GUI の編集 UI。上限は 20 件・2,000 トークンを維持しつつ、統合で自然に古いものを畳む。
- **変更**: `packages/core/src/memory.ts`（拡張）、新規 `packages/core/src/memory-pipeline.ts`、`packages/hy-cli/src/{session-app,main}.ts`。
- **受け入れ**: 3 セッション走らせると 1〜3 件の記憶が自動で残り、次のセッションのプロンプトに入る。手動の `memory` ツールと共存する。`memory.test.ts`（6 ケース）。

### CP-21 skills の選択と推薦（CTX-07、7 日）
- **内容**: カタログを「名前・1 行説明・トリガー」に絞り、モデルに `skill_select`（候補を返す）と `@skill:` メンションを提供する。選択履歴を記録し、頻度の低いスキルを落とす。MCP 依存のスキルは起動時に解決する。
- **変更**: `packages/core/src/skills.ts`、`prompt.ts`、`web/app.ts`（`@` 候補）。
- **受け入れ**: 20 個のスキルがあってもプロンプトが膨らまない。選択の適合率をテストで測る。

### CP-22 コンパクションの強化（CTX-04、CTX-05、9 日）
- **内容**: (a) 非同期コンパクション（閾値 65 %、ターンを止めない）、(b) ツール出力の保持方針（重要出力は要約後も残す）、(c) メディア予算、(d) 要約の失敗時に 1 段前の状態へ戻す、(e) `preCompact`/`postCompact` フック。
- **変更**: `packages/seams/src/spill-compaction.ts`、`packages/core/src/agent.ts`。
- **受け入れ**: 100 ターンのセッションで制約と直近のツール出力が残る。`spill-compaction.test.ts` を拡張。

### CP-23 トークン計測とキャッシュ（CTX-12、CTX-02、CTX-13、6 日）
- **内容**: プロバイダ別の補正係数を実測で更新する仕組み（直近 usage との誤差を記録）、`prompt_cache_key` の指定、キャッシュヒット率の表示、モデル別の正確な上限。
- **変更**: `packages/core/src/{tokens,llm}.ts`、`web/app.ts`。
- **受け入れ**: 推定誤差が ±10 % 以内。キャッシュヒットがヘッダーに出る。

### CP-24 モデルカタログと推論パラメータ（MODEL-04、MODEL-06、CTX-15、6 日）
- **内容**: プロバイダの `/models` を定期取得して能力（vision、reasoning、tool mode、最大出力）を保存する。`verbosity`・`summary`・`service_tier` をロール設定に追加し、未対応プロバイダでは無視する。
- **変更**: `packages/core/src/{model-catalog,llm,config}.ts`、`web/app.ts`。
- **受け入れ**: 新モデルがカタログに出る。未対応パラメータで 400 にならない。

---

## 5. 作業パッケージ（C3: プロトコルと統合）

### CP-25 HY Protocol v1（PROTO-01、PROTO-07、PROTO-08、28 日）
- **内容**: 現在の HTTP API + SSE の上に、**ステートフルな JSON-RPC 2.0 プロトコル**を設計・実装する。最小の面は `initialize`、`thread/start|resume|fork|list|read|archive`、`turn/start|steer|interrupt`、`item/*`（承認・質問・ツール呼び出し）、`review/start`、`config/get|set`。**イベントは item 単位**で流し、クライアントは同じ面から承認に応答する。GUI・CLI・ACP・SDK はこの面に載せ替える（HTTP API は互換のため残す）。
- **変更**: 新規 `packages/core/src/protocol/`（型・サーバー・クライアント）、`packages/hy-cli/src/web-server.ts`（アダプタ）、`packages/hy-cli/src/{acp,sdk-server}.ts`。
- **受け入れ**: 2 つのクライアントが同時に 1 スレッドを購読できる。承認が item として往復する。`tests/integration/protocol.test.mjs`（10 ケース）。
- **リスク**: 既存 GUI の作り直しに近い。**HTTP API を残して段階移行**し、GUI は最後に切り替える。

### CP-26 スキーマ生成と適合テスト（PROTO-02、9 日）
- **内容**: プロトコル型から JSON Schema と TS 型を生成し、`pnpm check:protocol` で差分を検出する。`@hy/protocol` パッケージとして公開する。バージョン（v1）と `experimental` マーカーを付け、実験的メソッドは既定で隠す。
- **変更**: `scripts/gen-protocol.mjs`（拡張）、`packages/protocol/`（新規）、`tests/integration/protocol-schema.test.mjs`。
- **受け入れ**: 生成物が CI で検証される。古いクライアントが新しいサーバーに繋いでも壊れない（未知メソッドはエラーコードで返す）。

### CP-27 トランスポートと daemon（PROTO-03、PROTO-09、12 日）
- **内容**: stdio / WebSocket / 名前付きパイプの 3 経路。`hy serve --daemon` で常駐し、複数接続をブローカーする。daemon の再起動・排他・バックオフを実装する。
- **変更**: 新規 `packages/hy-cli/src/daemon.ts`、`web-server.ts`。
- **受け入れ**: daemon を落としても再接続する。2 クライアントの同時操作が競合しない。

### CP-28 exec-server の WS/PTY 化（PROTO-05、9 日）
- **内容**: exec-server を `--listen ws://IP:PORT` で待ち受けられるようにし、`exec/start|write|poll|kill` を CP-09 と共通化する。認証はトークン + `--allow-remote` の明示。
- **変更**: `crates/hy-exec-server/src/main.rs`、`rpc.rs`、`packages/core/src/exec-rpc.ts`。
- **受け入れ**: 別プロセスの exec-server に繋いでコマンドが動く。認証なしでは拒否。

### CP-29 実行時設定 API（PROTO-06、5 日）
- **内容**: `config/get|set`、`mcpServer/reload`、`plugin/reload`、`model/set` をプロトコルに載せる。GUI の「再起動して反映」を減らす。
- **変更**: `packages/hy-cli/src/web-server.ts`、`packages/core/src/config.ts`。
- **受け入れ**: モデル切替と MCP 再読み込みが再起動なしで効く。

### CP-30 SDK と ACP の更新（PROTO-10、7 日）
- **内容**: `packages/sdk`（TS）と `python/` を新プロトコルに追従させ、型付きクライアント・イベント購読・承認コールバックを提供する。ACP も同じ面に載せる。
- **変更**: `packages/sdk/src/index.ts`、`python/hy_harness/__init__.py`、`packages/hy-cli/src/acp.ts`。
- **受け入れ**: SDK のサンプルが動く。型が生成物と一致する。

### CP-31 移行ツール（PROTO-11、9 日）
- **内容**: Claude Code（`CLAUDE.md`、`.claude/`、MCP 設定、フック）と DSH（セッション、設定）から、AGENTS.md・skills・MCP・フック・メモリを取り込む `hy import` を実装する。取り込みは差分を見せて確認してから書く。
- **変更**: 新規 `packages/hy-cli/src/import.ts`、`web/app.ts`（ウィザード）。
- **受け入れ**: フィクスチャから取り込み、生成物が正しい。`import.test.ts`（5 ケース）。

---

## 6. 作業パッケージ（C4: UX）

### CP-32 スラッシュコマンドとパレットの拡張（UX-03、UX-10、7 日）
- **内容**: `/status`・`/usage`・`/diff`・`/export`・`/skills`・`/mcp`・`/plugins`・`/hooks`・`/memories`・`/resume`・`/fork`・`/archive`・`/rename`・`/worktree`・`/import`・`/doctor`・`/config`・`/compact` を GUI と CLI に揃える。Ctrl+K の対象をコマンド・セッション・ファイル・設定に広げる。
- **変更**: `web/app.ts`、`packages/hy-cli/src/main.ts`、`web/i18n.ts`。
- **受け入れ**: 一覧が `/help` と一致する。主要 10 コマンドの E2E。

### CP-33 差分・トランスクリプト・履歴検索（UX-02、9 日）
- **内容**: 差分ビューア（行単位のコメント、折り畳み、untracked 対応）、トランスクリプトの全文検索（F3 相当）、生ログと整形表示の切替、ターン単位の巻き戻し（Esc Esc 相当）。
- **変更**: `web/app.ts`、`web/styles.css`、`packages/hy-cli/src/chat-projection.ts`。
- **受け入れ**: 1,000 メッセージのセッションで検索が 200 ms 以内。スクリーンショット更新。

### CP-34 承認 UI の情報量（UX-08、5 日）
- **内容**: コマンド・作業ディレクトリ・ネットワーク宛先・権限差分・影響を受けるパスを 1 画面に出す。「1 回 / セッション / 常に」の選択と、拒否理由の入力。
- **変更**: `web/app.ts`、`packages/hy-cli/src/web-server.ts`。
- **受け入れ**: `web-ui.test.mjs` に 4 ケース。キーボードだけで承認/拒否できる。

### CP-35 セッション管理 UI（UX-06、UX-09、5 日）
- **内容**: rename / archive / delete / fork / worktree 開始を GUI から。モデルピッカーに能力（vision / reasoning / tool mode）を表示。
- **変更**: `web/app.ts`、`packages/hy-cli/src/session-*.ts`。
- **受け入れ**: 各操作の E2E。

### CP-36 キーマップ・statusline・テーマ（UX-04、6 日）
- **内容**: ショートカットの編集（既存）に加え、statusline の項目選択、シンタックスハイライトのテーマ、Vim 風の入力モード（任意）。
- **変更**: `web/{app,styles}.ts`・`web/shortcuts.ts`。
- **受け入れ**: 設定が `ui-state.json` に保存され、再起動で復元される。

---

## 7. 作業パッケージ（C5: 運用と品質）

### CP-37 設定レイヤと requirements（OPS-01、OPS-02、11 日）
- **内容**: user / project / system / managed（環境変数 or `%PROGRAMDATA%`）の 4 層にし、`requirements`（禁止設定の強制）を追加する。`-c key=value` と `--enable/--disable` を実装する。`hy config layers` で出所を表示する。
- **変更**: `packages/core/src/config.ts`、`packages/hy-cli/src/main.ts`、`config.schema.json`。
- **受け入れ**: 上位層が下位層を上書きし、requirements 違反は起動時に拒否。`config.test.ts` を拡張。

### CP-38 フィーチャーフラグ（OPS-03、5 日）
- **内容**: `features` テーブル（Stable / Experimental / Deprecated）を導入し、実験的機能を既定で隠す。`hy features list|enable|disable`。
- **変更**: `packages/core/src/config.ts`、`packages/hy-cli/src/main.ts`。
- **受け入れ**: フラグで新機能を出し分けられる。設定スキーマに反映。

### CP-39 OTEL メトリクスと診断（OPS-04、OPS-07、OPS-13、10 日）
- **内容**: 既存の span に metrics（ターン時間、ツール時間、トークン、失敗率）を追加し、W3C traceparent を伝播する。`hy doctor`（環境・サンドボックス・プロバイダ・MCP の診断、`--json`）を追加する。サポートバンドル（ログ + 設定 + 診断）を出力する。
- **変更**: `packages/hy-cli/src/telemetry.ts`、新規 `packages/hy-cli/src/doctor.ts`。
- **受け入れ**: OTLP コレクタでメトリクスが見える。`hy doctor --json` がスキーマに合う。

### CP-40 署名と配布（OPS-09、OPS-10、6 日）
- **内容**: exe のコード署名（証明書がある場合）、署名検証手順の文書化、winget/scoop マニフェストの用意、`hy update` のロールバック検証。
- **変更**: `electron-builder.yml`、`.github/workflows/`、`docs`。
- **受け入れ**: 署名済み exe が SmartScreen の警告を出さない（証明書がある場合）。更新の失敗で旧版に戻る。

### CP-41 単一バイナリ化の調査と実装（OPS-08、20 日）
- **内容**: Node 依存を外すため、(a) 制御プレーンを Node SEA（Single Executable Application）で包む、(b) あるいは重要部分を Rust に移す、の 2 案を試作して比較する。まずは portable exe の起動時間とサイズを測り、目標（起動 100 ms 以内、配布 60 MB 以下）を決める。
- **変更**: `scripts/`、`packages/desktop`、必要なら `crates/`。
- **受け入れ**: 試作が起動し、ベンチで比較できる。判断を ADR に残す。
- **リスク**: SEA は native モジュール（node-pty）と相性が悪い。**「採らない」判断もあり得る**（§10）。

### CP-42 QA の強化（QA-01〜QA-05、9 日）
- **内容**: スナップショットテスト（プロンプト、ツールスキーマ、GUI の主要画面）、プロパティテスト（パス正規化、差分適用）、モックモデルのシナリオ集、カバレッジの CI ゲート（TS 行 95 % / Rust 行 85 %）。
- **変更**: `tests/`、`package.json`、CI。
- **受け入れ**: 新規テストが CI で走り、閾値を下回ると失敗する。

### CP-43 ドキュメントと移行ガイド（OPS-12、5 日）
- **内容**: サンドボックスの新しい既定と移行手順、プロトコルのリファレンス、SDK の例、`docs/codex-gap-analysis.md` の更新。
- **変更**: `docs/`、`README.md`。
- **受け入れ**: 初見の開発者が 30 分でクライアントを書ける。

---

## 8. 工数と体制

| フェーズ | WP | 人日 |
| :--- | :--- | --: |
| C0 封じ込め（ネットワークを除く） | CP-01/02/05/06/07/08/44 | 50 |
| C1 道具箱 | CP-09〜CP-17 | 75 |
| C2 ループ | CP-18〜CP-24 | 61 |
| C3 プロトコル | CP-25〜CP-31 | 79 |
| C4 UX | CP-32〜CP-36 | 32 |
| C5 運用 | CP-37〜CP-43 | 66 |
| **合計** | **44 WP** | **389**（うち今回の対象は 363） |

- **1 人**: 約 19〜21 か月（休み・調査・手戻りを含めると 24〜26 か月）。**2 人**: 約 10〜11 か月。**3 人**: 約 8 か月。
- 並列化の推奨: C0 は 1 人で集中。C1（ツール）と C2（ループ）は別の人。C3 は C2 の後半から 1 人を専任。C4/C5 は余力で。
- **削るなら**: C4 の UX（32 日）と C5 のうち CP-41（20 日）を落とすと **337 日**。CP-25 を「HTTP API の拡張」に留めれば（28 → 10 日）**約 371 日**。

---

## 9. リスクと対策

| # | リスク | 影響 | 対策 |
| :--- | :--- | :--- | :--- |
| R1 | WFP / 読み取り拒否 ACL が Windows 10 22H2 の非管理者環境で使えない | C0 の前提が崩れる | 起動時に能力を検出し、**使えないならサンドボックスを拒否**（fail closed）。`--allow-unconfined` の明示を要求し、`gap:` で表示 |
| R2 | ACL 付与の取り消し漏れ・パフォーマンス劣化 | ユーザー環境を壊す | `grants` の記録を拡張し、`revoke` の往復テストを CI に追加。10 万ファイルのベンチを維持 |
| R3 | 既定の変更で既存ユーザーのワークフローが止まる | 離脱 | 1 回だけの移行プロンプト、`legacyUnconfined` の明示設定、リリースノートで告知 |
| R4 | Protocol v1 の設計が GUI の作り直しに発展する | 長期化 | HTTP API を残した段階移行。GUI の切替は最後。プロトコルの変更は ADR で固定 |
| R5 | `tool_search` でモデルがツールを見つけられない | 品質低下 | 主要ツールは Direct に残す。検索のヒット率をテストで測る。システムプロンプトに使い方を明記 |
| R6 | memories の自動化が誤った記憶を残す | 品質・安全性 | 引用付き、上限、ユーザーが GUI で削除可能、`memory` ツールとの整合 |
| R7 | ストリーミングでプロバイダごとの差異が大きい | 実装コスト | 共通の `delta` 正規化層を作り、プロバイダ別のテストを追加 |
| R8 | 単一バイナリ化が native モジュールで破綻 | 工数浪費 | CP-41 は試作で判断。**採らない判断を許容** |
| R9 | 作業範囲が広がり、既存の強み（ralph/goal/GUI）が壊れる | 退行 | K1–K14、`test:regression`、ベンチ ±10 %、スクリーンショットを各フェーズのゲートにする |

---

## 10. 採らないもの（非目標）と理由

| 項目 | 判断 | 理由 |
| :--- | :--- | :--- |
| クラウド実行 / Cloud tasks | 採らない | ローカル完結の設計思想。認証・課金・データ境界が別問題 |
| ChatGPT ログイン / SSO / Bedrock / Azure / GCP | 当面採らない | 個人ローカル用途。API キーで足りる（CP-08 で安全に保存） |
| IDE 拡張（VS Code / Cursor） | P3 で再検討 | 承認済み対象外だが、CP-25 のプロトコルがあれば実装可能になる。優先度は低い |
| プラグインマーケット / Creator | 採らない | 承認済み対象外。供給・審査・セキュリティの運用コストが大きい |
| 音声（realtime） | 採らない | 価値に対して実装・検証コストが高い |
| フルスクリーン TUI | 採らない | GUI が主面。CLI は REPL で十分。ただし CP-32/33 で不足を補う |
| iOS/Android ネイティブ | 採らない | PWA で足りる |
| Bazel への移行 | 採らない | pnpm + cargo で足りる。CI 時間は CP-42 で改善 |
| MXC（Microsoft BaseContainer） | 様子見 | Windows 11 前提。Windows 10 first の方針と合わない |

---

## 11. 検証とゲート

各フェーズの完了時に、以下をすべて満たすこと。

1. **既存の不変条件**: K1–K14（`pnpm test:regression`）が緑。`wireTools` の数が意図せず変わらない（CP-10 で意図的に変える場合はテストを更新）。
2. **ビルドと型**: `pnpm build`、`pnpm typecheck`、`cargo build --workspace`、`cargo clippy --workspace --all-targets -- -D warnings`。
3. **テスト**: `pnpm test`、`pnpm test:integration`、`cargo test --workspace`。新規 WP には必ずテストを追加。
4. **ベンチ**: `pnpm bench:startup` が ±10 % 以内、`pnpm bench:checkpoint` が作成 750 ms / ロールバック 500 ms 以内。
5. **サンドボックス**: Windows 10 22H2 実機で `win10-sandbox.test.mjs` と新規の権限/ネットワークテスト。
6. **GUI**: `pnpm desktop:screenshot` で主要画面を再取得し、差分を確認。
7. **ドキュメント**: `docs/enforcement-gaps.md` と `docs/implementation_status.md` を更新。ギャップを塞いだら該当行を消す。

---

## 12. 完了の定義（Definition of Done）

「Codex との融合」が達成されたと言えるのは、次を満たしたとき。

- **安全**: 既定で読み取り・書き込み・ネットワークが制限され、拒否は説明され、`--unsafe-unconfined` を明示しない限り外れない。
- **道具**: モデルが対話プロセスを操作でき、必要ならツールを探してロードでき、MCP の resources/prompts を使える。
- **記憶**: セッションを跨ぐ学びが自動で溜まり、引用付きで注入され、ユーザーが編集できる。
- **統合**: 第三者が `@hy/protocol` でクライアントを書け、CLI・GUI・SDK・ACP が同じ面を使う。
- **運用**: 署名済みの配布物、`hy doctor`、OTEL メトリクス、設定レイヤと requirements、スナップショットテスト。
- **維持**: `hy ralph` の 2 ゲート、ゴール、チェックポイント、Orchestration A+、GUI の 3 言語が壊れていない。

---

---

## 13. 今回の計画に含めないギャップと扱い

§2〜§7 の WP が覆うのは 67 件。残りは次の 4 つに分ける（重複計上があるため、内訳の合計は 119 より小さくなる）。

### 13.1 次のフェーズ（C6）で採る

| ID | 内容 | 理由 |
| :--- | :--- | :--- |
| SEC-07 | Windows 昇格サンドボックス（専用ユーザー / サービス） | C0 の ACL 方式で足りない管理者環境が出たとき。設計は ADR に残す |
| SEC-14 | execpolicy の表現力（host_executable、ネットワーク） | 企業・チーム利用で必要になったとき |
| TOOL-09 | orchestrator ツールのモデル化 | CP-15 の後に、GUI 専用の操作をモデルへ開放 |
| TOOL-12 | ツール出力の構造化 | CP-10 のツール整理と同時に |
| CTX-14 | モデルフォールバック | 有償プロバイダを使うときに |
| CTX-17 | 入力添付の拡張（MCP リソース等） | CP-11 の後続 |
| PROTO-14 | プロジェクト信頼の段階化 | CP-02 の権限モデルと同時に設計 |
| AGENT-04 | オーケストレーターの深化 | CP-15/16 の後 |
| AGENT-05 | セッションを跨ぐ引継ぎ | CP-25 の後 |
| OPS-14 | trace bundle とオフライン再生 | CP-39 の後続 |
| MODEL-05 | モデル別 tool mode | CP-10 の後続 |
| UX-11 | 通知の文脈（クリックで該当ターンへ） | CP-32 の後続 |

### 13.2 後で（P2、必要になったら）

SEC-05（Linux サンドボックス）、CTX-09（AGENTS.md の深さ）、CTX-10（rollout 互換）、CTX-11（トランケーション方針）、CTX-18（読み取り状態）、CTX-19（指示の階層）、TOOL-11（非同期ユーザー通知）、TOOL-16（hosted tools）、TOOL-18（動的ツール）、UX-13（移行ウィザード）、OPS-11（Linux/macOS CI）、QA-06（ベンチ継続）。

### 13.3 採らない（§10 の非目標）

SEC-06（macOS）、PROTO-04（IDE 拡張）、PROTO-12（プラグイン市場）、PROTO-15（企業認証）、UX-01（TUI）、UX-05・AGENT-07（音声）、UX-07（サイド会話）、UX-12（画像ペーストは PWA で代替）、MODEL-01/02/03/07/08（hosted tools・Azure/Bedrock/GCP・ChatGPT ログイン・プロキシ・LM Studio）、OPS-05/06（アナリティクス・フィードバック送信）、OPS-12（ドキュメントサイトは当面リポジトリ内）。

### 13.4 既存の仕組みで足りる

TOOL-07（プラグイン市場を採らないため不要）、CTX-13（ローカルプロバイダ中心のため不要）、QA-06（既存の 2 ベンチで足りる）。ほかは WP の中で部分的に扱う。

## 14. 最初の 2 週間（着手順）

1. CP-01（既定の切替、2 日）と CP-06（違反レポートの器、1 日）を先に置く。
2. CP-02 の設計（権限プロファイルの型、ACL の順序、fail closed の条件）を ADR に書く（2 日）。
3. CP-02 の Windows 実装（deny-read と carve-out）に着手（5 日）。
4. 並行して CP-03 の WFP 試作（WFP API のラッパー、許可/拒否の 2 ケース）を 3 日で評価する。
5. 2 週間の終わりに、`workspace-write` が既定で、`~/.ssh` が読めず、`curl` が既定で失敗するデモを作る。

