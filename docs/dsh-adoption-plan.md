# DSH 差分導入 実装計画（HY-HARNESS v0.2 → v0.4）

- **日付**: 2026-11-04
- **前提レポート**: [dsh-gap-analysis.md](dsh-gap-analysis.md)（111 項目評価、不足 106 件: A 21 / B 40 / C 45）
- **基本方針**: **HY の強みは一切置き換えない。** 不足・劣位と判定した項目だけを、DSH の*設計・データ形式・UX・テスト観点*から移植する。DSH の `@deepseek-ai/*` パッケージ（Cordis 依存）は vendoring せず、HY の TypeScript/Rust の作法で再実装する。
- **対象外（再確認）**: プラグインマーケット／Creator、クライアントプラグイン機構、Cordis 動的ロード、マルチユーザー RBAC／ライブ共有は、2026-11-03 の承認どおり**作らない**。ただし「プロファイル合成」「設定スキーマ」「API 契約」など、その土台になる*軽量版*は作る（§2.3）。

---

## 1. 原則

### 1.1 保持する強み（回帰させない）

| # | 強み | 保護するテスト（既存／追加） |
| :-- | :--- | :--- |
| K1 | Windows 10 サンドボックス（制限トークン、ACL 付与/取消、`.git` ガード、非 ACL ボリューム対応） | `win10-sandbox.test.mjs`, `ptc-appcontainer.test.mjs`, `crates/hy-sandbox-windows` |
| K2 | ターン単位チェックポイント＋`/undo`＋`hy undo`＋`checkpoint prune` | `chat-resume.test.mjs`, `verifier-ralph.test.mjs`, checkpoint 単体 |
| K3 | 検証ゲート付き Ralph（改ざん検査→Gate 1→Gate 2、Budget4D、ラウンドロールバック） | `verifier-ralph.test.mjs` |
| K4 | Guardian（unconfined は承認しない、3 回拒否で停止） | `guardian.test.mjs`, `guardian.test.ts` |
| K5 | オーケストレーション A+（スコープ重複拒否、直列化シェル、レビュー/close 規律、再起動時の interrupted 正規化） | `web-ui.test.mjs`, `orchestration.test.ts` |
| K6 | ターンキューの耐久性（原子的書込、crash 時の uncertain、pause/resume） | `turn-queue.test.ts`, `turn-queue.test.mjs` |
| K7 | `hy mcp-server`（他エージェントから `hy_run`） | `mcp-server.test.mjs` |
| K8 | LSP ツール、ワークスペースメモリ | `lsp.test.ts`, memory 単体 |
| K9 | PTC（AppContainer ワーカー、生成 SDK、サブコール制限、トークン量 ≤1,200） | `ptc-appcontainer.test.mjs`, `tool-overhead.test.mjs` |
| K10 | 永続 PTY（GUI 専用・モデル非公開） | `web-ui.test.mjs` |
| K11 | portable exe と自己更新 | `update-script.test.mjs` |
| K12 | Tailscale 個人端末アクセス＋PWA | 手動検証（README §Phone access） |
| K13 | ja/zh/en UI、桜テーマ | `desktop:screenshot` |
| K14 | 実行デーモンの鮮度ガード（stale build での誤検証防止） | `fresh-build.mjs` |

**ルール**: 上記の既定挙動を変える変更は、必ず ADR を 1 本追加し、既存テストを*弱めずに*通すこと。特に K1〜K6 は「機能追加の巻き添え」で壊れやすい。

### 1.2 採用する（DSH から移植）

- エージェント協調（ステアリング、継続可能サブエージェント）
- ツール面（write/edit、read_image、永続シェル、working_directory、present、session_query、schedule ツール）
- セッション基盤（形式バージョン＋移行、FTS 検索）
- プロバイダ基盤（Anthropic Messages、OpenAI Responses、モデルカタログ、compat、reasoning efforts）
- 配備（TLS、trusted host、public URL、Host/Origin フェンス）
- 構成（軽量プロファイル/バンドル、設定ダンプ、API 契約）
- 連携（ACP、SDK/Python）
- 文書・成果物（プレビュー、Office→PDF、成果物カード）
- デスクトップ更新フィード、オンボーディング

### 1.3 採用しない（理由つき）

| 項目 | 理由 |
| :--- | :--- |
| Cordis／動的プラグイン／マーケット／Creator | 承認済み対象外。HY の型安全なビルド時構成を壊す |
| クライアントプラグイン bundle／HMR | 同上。UI は内部レジストリで拡張点だけ用意 |
| Typert 完全移植 | 過剰。HTTP 契約＋スキーマ生成の軽量版で 80% を取る |
| マルチユーザー RBAC／ライブ共有 | 承認済み対象外 |
| 製品分析・セッションログ送信 | プライバシー方針に反する。OTel はオプトインのみ |
| Agent Teams | オーケストレーション A+ が HY の答え。共有タスクボードのみ将来検討 |
| `str_replace_editor` | `edit_file` で代替 |
| DSH の Ralph | HY の検証ゲート付き Ralph が上位互換 |
| SSH 先リモート実行／クラウド | DSH にも存在しない（レポート §0） |

---

## 2. 設計上の決定

### 2.1 サンドボックスの既定（**要ユーザー判断**）

- 現状: 既定 `unconfined`（2026-11-02 のユーザー決定）。
- DSH: fail-safe は `read-only`、配備が `workspace-write` を選択。**セッション単位で切替**でき、切替はログに残り再起動後も保持。
- **提案**: 既定値は変えない（過去の決定を尊重）。代わりに **GUI の初回に「Confined（推奨）」を提示**し、選択時は ACL 付与まで含めて 1 クリックで完了させる。セッション単位の切替（§WP-12）は実装する。
- 既定を `workspace-write` に変える判断をする場合は、非 ACL ボリューム（F:/G:）の警告と ACL 初回付与の同意を必須にする。

### 2.2 ステアリングの意味論

- 追加するのは **ターン内ステアリング**（実行中に届いたメッセージを次のステップ境界で履歴に挿入）。ターンキューの「次のターンとして予約」はそのまま残す（K6）。
- ログ: `user/steer` イベント（`seq` 順で再構築）。undo は従来どおり**ターン単位**（steer はターンを増やさない）。
- 圧縮: steered メッセージは通常の user メッセージとして扱う（組境界を壊さない）。

### 2.3 プロファイル/バンドル（軽量版）

- Cordis は入れない。**ビルド時に登録される型付きバンドル**を JSON で選択する:
  - 組み込み: `core`, `ptc`, `minimal`, `audit`（読み取り専用）, `orchestrator`, `worker`
  - 解決順: `core` → `profiles.<name>.bundles[]` → ユーザー config → CLI フラグ
  - バンドルが寄与できるもの: ツール集合、プロンプト節、ロール既定、UI パネル、スラッシュコマンド
- `--profile` は既存の config 上書きと後方互換（bundles を書かなければ従来どおり）。

### 2.4 API 契約（Typert の軽量代替）

- `packages/hy-cli/src/api-contract.ts` に全ルートを宣言（method/path/request/response/エラー）。
- `scripts/gen-api-types.mjs` が `web/src/api.gen.ts` を生成。`pnpm check:api` でドリフト検出。
- 実行時は `readJson` の後段で契約検証（既存の `HttpError` を利用）。
- SSE イベントも契約に含める（イベント名と payload）。

### 2.5 文書変換の依存

- LibreOffice を同梱しない。`soffice.exe`（または Word COM）を**検出できたときだけ** Office→PDF を有効化し、UI に「未検出」を明示。PDF は Electron は標準ビューア、Web は PDF.js（MIT）を同梱。

---

## 3. マイルストーン概要

| MS | 内容 | 主な WP | 見積（人日） | 期間目安（1 人＋AI） |
| :-- | :--- | :--- | --: | :--- |
| M0 | ベースライン固定・ADR・計測 | WP-00, 01 | 5 | 1 週 |
| M1 | 安全と配備（TLS/フェンス/モード切替/設定ダンプ） | WP-10〜12 | 22 | 5 週 |
| M2 | 協調（形式 v2・ステアリング・継続サブエージェント・成果物） | WP-20〜23 | 40 | 9 週 |
| M3 | ツールと実行（write/edit・永続シェル・FTS） | WP-30〜32 | 32 | 7 週 |
| M4 | プロバイダと構成（Messages/Responses・バンドル・契約） | WP-40〜43 | 34 | 7 週 |
| M5 | 連携と成果物（ACP・SDK/Python・文書・更新） | WP-50〜53 | 40 | 9 週 |
| M6 | 磨き（タイトル・統計・fork・フィードバック・OTel） | WP-60〜63 | 30 | 6 週 |
| **合計** | | | **203** | **約 10 か月** |

- **2 人並行**（A: コア/エージェント、B: プロバイダ/UI/連携）なら **約 5.5 か月**。
- **最小セット（協調＋履歴＋ツール＋検索）**: M0＋WP-10/20/21/22/30/32 ＝ **61 人日（約 3 か月）**。
- **推奨初期セット**: 上記＋WP-12（サンドボックス切替）＋WP-31（永続シェル）＝ **87 人日（約 4.5 か月）**。
- リリース: M1 完了で **v0.2.0**、M3 完了で **v0.3.0**、M6 完了で **v0.4.0**。

```
M0 ─ M1 ─┬─ M2 ── M3 ─┬─ M4 ── M5 ── M6
         │             │
         └(並行可)──────┘   ※ M4 のプロバイダ系は M2 と並行可能
```

---

## 4. 作業パッケージ詳細

### M0: ベースライン固定（5 人日）

**WP-00 ゴールデン回帰スイート（3d）**
- 目的: K1〜K14 を 1 コマンドで検証し、以降の変更で壊れたら即座に分かるようにする。
- 内容: `tests/regression/golden.test.mjs` を追加。checkpoint→undo の完全一致、Ralph の状態遷移、Guardian 3 回拒否、スコープ重複拒否、ターンキューの crash 復旧、MCP server、PTC の隔離、トークン量上限を固定値で検証。
- 対象: `package.json`（`test:regression`）、`tests/regression/`。
- 受け入れ: `pnpm test:regression` が緑、CI に追加、所要 < 5 分。
- 依存: なし。

**WP-01 ADR と計測（2d）**
- 内容: `docs/adr/0002-dsh-adoption.md`（採用/不採用、§1〜2 の決定を記録）、`scripts/bench-startup.mjs`（起動・1 ターン・検索の基準値）。
- 受け入れ: ADR レビュー完了、基準値が `docs/bench-baseline.md` に記録。

---

### M1: 安全と配備（22 人日）

**WP-10 TLS・trusted host・public URL・Host/Origin フェンス（7d）** — 対応: D1, D2
- 内容:
  - `hy web --tls-cert <pem> --tls-key <pem>`（両方必須、失敗時は HTTP に落ちず終了）。
  - `--trusted-host <authority>`（複数可）、`--public-url <http(s)://…/>`。
  - リクエスト境界で Host を検証: loopback / bind IP / trusted host 以外は 403。ブラウザ経路は `Origin`/`Sec-Fetch-Site` も検証。TLS 時は Cookie に `Secure`。
  - `web-server.ts` の `createServer` を `https.createServer` に切替可能にする。
- 対象: `packages/hy-cli/src/web-server.ts`, `cli-args.ts`, `main.ts`, `docs/designs/desktop-gui.md`（§security）, 新 `tests/integration/web-deploy.test.mjs`（自己署名証明書＋前置プロキシをテスト内で起動）。
- 受け入れ: (1) 不正 Host が 403、(2) 前置プロキシ（`/ui` 剥がし）経由で API が通る、(3) 証明書不正で起動失敗、(4) Tailscale バインドは自動 trusted、(5) 既存 web-ui テストが緑。

**WP-11 設定ダンプ・スキーマ・`hy config`（4d）** — 対応: P9
- 内容: `hy config dump [--profile]`、`hy config schema`（`config.ts` の型から JSON Schema を生成）。`--json` 出力。差分チェック `pnpm check:config-schema`。
- 対象: `packages/core/src/config.ts`, `packages/hy-cli/src/main.ts`, `scripts/gen-config-schema.mjs`。
- 受け入れ: 生成スキーマが CI でドリフトなし、`dump` が実効値を出す。

**WP-12 セッション単位サンドボックスモード＋昇格 UX（11d）** — 対応: D11（既定値は §2.1 の判断に従う）
- 内容:
  - ログ `sandbox/mode { mode }` を追加し、再構築時に復元。
  - デーモン: `exec/command` に任意 `mode` を追加。`initialize` の既定モードを上書き可能に。トークンはモード別にキャッシュ（`crates/hy-exec-server/src/sandbox.rs`）。
  - API: `POST /api/sessions/:id/sandbox { mode }`、GUI はヘッダーのモードチップ＋`/permission` 相当の切替。
  - 「1 回だけ広げる」昇格: 承認後に `{ mode, once: true }` で 1 コマンドのみ実行。
  - PTY は従来どおり非サンドボックスであることを UI に明示（K10）。
- 対象: `crates/hy-protocol/src/lib.rs`（params）, `crates/hy-exec-server/src/server.rs`, `sandbox.rs`, `packages/core/src/exec-rpc.ts`, `tools.ts`, `web-server.ts`, `web/src/app.ts`, `pnpm gen:protocol`。
- 受け入れ: モード切替が再起動後も保持、confined モードで `sandbox/status` の gap が正しく出る、K1 の既存テストが緑、非 ACL ボリュームの警告が維持。

---

### M2: 協調（40 人日）

**WP-20 セッション形式 v2 と移行ハーネス（6d）** — 対応: S1
- 内容:
  - `session/format { format: 2 }` を先頭に記録（既存ログは v1 として扱う）。
  - `packages/core/src/session-migrations.ts`: `migrateEvents(raw[]): SessionEvent[]`。イベント型ごとの変換関数を持ち、未知の型は安全に無視。
  - `readEvents` はヘッダーを見て移行。**書き込み時に勝手に変換しない**（読み取り時移行）。
  - ゴールデンログ: `tests/fixtures/session-v1.jsonl` と将来の v2。
- 受け入れ: v1 ログの読み込み・追記・再開が同一挙動、移行の単体テスト 6 件、`hy sessions --json` の形が不変。

**WP-21 ステアリング inbox（11d）** — 対応: E1
- 内容:
  - `Conversation.steer(message, images?)` を追加。`Agent` に `inbox` を持たせ、**各ステップのモデル要求直前**に drain して履歴へ append＋`user/steer` をログ。
  - 再構築: `rebuildHistory` が `user/steer` を user メッセージとして順序どおり復元。
  - API: `POST /api/sessions/:id/steer`（busy でない場合は 400 で `turn` を案内）。SSE に `entry`（`steering: true`）を流す。
  - UI: 実行中も送信ボタンを有効化。Shift+Enter は従来、Enter は「ステア」を選ぶ設定（既定は送信＝ステア）。キューのバッジと競合しないよう「今すぐ割り込む / ターン後に送る」を選択。
  - 安全: steer で届いたメッセージも通常の承認・ポリシー・トークン予算の対象。
- 対象: `packages/core/src/agent.ts`, `packages/hy-cli/src/session-app.ts`（Conversation）, `web-server.ts`, `web/src/app.ts`, `chat-projection.ts`。
- 受け入れ: 実行中に送ったメッセージが次のステップで反映される（モックで検証）、undo が steer を含むターンを正しく戻す、compaction が組境界を壊さない、再起動後に履歴が一致。

**WP-22 継続可能サブエージェント（15d）** — 対応: E2
- 内容:
  - `SubagentRegistry`（`packages/hy-cli/src/agents.ts`）: childId=`<parent>.subN` を durable に扱い、状態 `running|idle|interrupted|closed` を持つ。ログに `agent/spawn`, `agent/message`, `agent/interrupt`, `agent/close`。
  - ツール: `delegate` に `background?: boolean` を追加（戻り値 `{agentId}`）。新規 `send_message`, `interrupt_agent`, `list_agents`。
  - 子は親の承認ブリッジを使う（`agentId` 付き）。読み取り専用既定・再帰なしは維持。
  - 再起動時: `running` の子は `interrupted` に正規化し、オーケストレーションの stale 正規化と同じ規律（K5）。
  - API/UI: `/api/sessions/:id/agents`、`/agents/:id/message`、`/interrupt`。Details の Subagents を「継続可能」に拡張（フォローアップ送信・停止）。
  - 上限: 同時 8、深さ 1。
- 対象: `packages/hy-cli/src/session-app.ts`, 新 `agents.ts`, `web-server.ts`, `tool-registry.ts`, `web/src/app.ts`, `crates` 変更なし。
- 受け入れ: バックグラウンド委譲→完了通知→フォローアップ→再開が動く、再起動で幽霊 running が残らない、既存 `delegate` の挙動（同期）が不変。

**WP-23 `todo_write`・`present`・成果物カード（8d）** — 対応: E9, T7, U3
- 内容:
  - `update_plan` を `todo_write` の意味論に拡張（全置換、`allowParallelInProgress` 設定、`plan/update` ログ投影）。既存 `/plan` と Plan タブはそのまま。
  - `present { files: [{path, description?}] }` を追加（通常ファイルのみ、ワークスペース内、最大 8）。ログ `deliverable/presented`。
  - UI: 会話内にドキュメントカード（アイコン、サイズ、行数、`Open`/`Show in folder`）。`Diff` タブに「変更ファイル（ターン単位）」。
- 対象: `tool-registry.ts`, `tools.ts`, `session-app.ts`, `chat-projection.ts`, `web-server.ts`, `web/src/app.ts`, `desktop/src/main.ts`（openPath）。
- 受け入れ: モデルが `present` したファイルがカードに出て開ける、`todo_write` がリロード後も残る。

---

### M3: ツールと実行（32 人日）

**WP-30 `write_file`/`edit_file`/`read_image`/`working_directory`（9d）** — 対応: T1, T3, T6
- 内容:
  - `write_file {file, content}`（新規 or 全置換、読み取り前編集の hash 検証を再利用）、`edit_file {file, old, new, count?}`（一意一致、失敗時は候補行を返す）。
  - `read_image {path}`: PNG/JPEG/WebP/GIF、上限 8 MiB / 8192 px（2026-11-08、高解像度スキャン対応）。画像非対応モデルでは明示エラー。
  - `working_directory {path?}`: セッション cwd を設定/取得。`shell` の既定 cwd、`read_file`/`apply_patch` の相対解決、`load_workspace_roots` の表示に反映。ログ `session/cwd`。ワークスペース外は拒否。
  - トークン量の再測定（K9 の ≤1,200 を維持、超過時は SDK 記述を圧縮）。
- 対象: `tool-registry.ts`, `tools.ts`, `agent.ts`（プロンプト）, `session-app.ts`, `prompt.ts`, `tests/integration/tool-overhead.test.mjs`。
- 受け入れ: 新ツールのスキーマ検証・承認・run_code 内 SDK 反映、トークン上限維持、PTC のサブコールからも利用可。

**WP-31 永続シェル（15d）** — 対応: T4（T5 のターミナル API は将来）
- 内容:
  - デーモン: セッション当たり 1 本の PowerShell を保持（`shell/open`, `shell/write`, `shell/read`, `shell/close`）。stdout/stderr を 1 本のストリームに統合し、**番兵マーカー＋終了コード**でコマンド境界を判定（UTF-8 固定、CLIXML 抑止）。
  - 非 confined は既存の `spawn` を、confined は `CreateProcessAsUser` に stdin パイプを追加（`crates/hy-sandbox-windows/src/spawn.rs`）。stdin が使えない環境では自動で one-shot にフォールバックし、理由を `gap:` に出す。
  - ツール: `shell` に `persistent?: boolean` を追加（既定 false、`--persistent-shell` かバンドルで opt-in）。タイムアウト/`exit`/キャンセルでシェルを破棄して再生成。
  - UI: Terminal タブとは独立（モデル用）。Details に「model shell」状態を表示。
  - Job Object で kill、出力は既存の spill に流す。
- 対象: `crates/hy-protocol/src/lib.rs`, `crates/hy-exec-server/src/{server,jobs}.rs`, `crates/hy-sandbox-windows/src/spawn.rs`, `packages/core/src/{exec-rpc,tools}.ts`, `pnpm gen:protocol`。
- 受け入れ: `cd`・環境変数・関数定義が次の呼び出しに残る（e2e）、confined で動くか gap を報告、タイムアウトで状態が残らない、既存 one-shot が不変。

**WP-32 FTS5 検索と `session_query`（8d）** — 対応: S4, T8
- 内容:
  - `node:sqlite`（Node 24 同梱、FTS5 3.53 確認済み）で `<stateDir>/index/session-fts.db` を作成。**`tokenize='trigram'`** を使う（日本語・英語の部分一致と bm25 ランキングを確認済み）。
  - スキーマ: `sessions(run_id, cwd, started_at, last_seq)` ＋ `events_fts(run_id, seq, kind, ts, text)`。インデクサは JSONL をバイトオフセットで追従し、200 イベント/2 秒でバッチ commit。
  - CLI: `hy sessions --search` を FTS に切替、`hy index status|rebuild`。
  - API: `GET /api/search?q=&cwd=&limit=`、GUI の検索を横断検索に。
  - ツール: `session_query`（opt-in、同一 cwd のみ、caller 除外、上位 5 件＋スニペット）。
  - インデックスが壊れたら自動再構築（ログが正）。
- 対象: 新 `packages/core/src/session-index.ts`, `main.ts`, `web-server.ts`, `tool-registry.ts`, `package.json`（`"test:index"`）。
- 受け入れ: 日本語クエリでヒット、10 万イベントで検索 < 100 ms、インデックス削除後も再構築で復旧、既存 `--search` の出力互換。

---

### M4: プロバイダと構成（34 人日）

**WP-40 Anthropic Messages / OpenAI Responses アダプタ（10d）** — 対応: M1, M2
- 内容:
  - `AnthropicProvider`: `system` 分離、`tool_use`/`tool_result` ブロック、`stop_reason`、usage（cache_read/write）、画像（base64）。
  - `OpenAiProvider` に `api: 'chat' | 'responses'` を追加（Responses は `input`/`output_text`、tools 形式）。
  - 設定: `provider: 'anthropic' | 'openai-responses'` と `baseUrl`/`apiKeyEnv`。
  - 契約テスト: 記録済みフィクスチャ（鍵なし）＋実 API は任意。
- 対象: `packages/core/src/llm.ts`, `config.ts`, `llm.test.ts`。
- 受け入れ: 契約テスト、画像・ツール呼び出し・リトライ・usage が既存と同じ形で動く。

**WP-41 モデルカタログ・compat・reasoning efforts（7d）** — 対応: M5, M6, M7
- 内容:
  - `GET <baseUrl>/models` 取得（10 分キャッシュ、失敗時はプリセット）。Settings に「モデル取得」。
  - `compat` 設定: `developerRole`, `maxTokensField`, `thinkingFormat`（off 時の `thinking: disabled`）。
  - `reasoningEfforts`: `{ level: wireValue }` をモデル定義に追加し、UI の Effort を宣言ベースに。
- 対象: `config.ts`, `llm.ts`, `web-server.ts`, `web/src/app.ts`。
- 受け入れ: ゲートウェイ互換の 3 ケース（developer role 拒否、max_tokens のみ、DeepSeek thinking）をモックサーバーで再現。

**WP-42 プロファイル/バンドル合成（10d）** — 対応: P1, P8, P12
- 内容: §2.3 のとおり。`packages/core/src/bundles.ts` に組み込みバンドル、`resolveProfile(config, name)`。`hy run --bundle minimal`、GUI のセッション作成時にプリセット選択。設定はバンドル既定＋ユーザー上書き＋CLI。
- 対象: `config.ts`, 新 `bundles.ts`, `main.ts`, `session-app.ts`, `web-server.ts`, `web/src/app.ts`。
- 受け入れ: `minimal` でツールが 3 つに絞られる、`--profile` 後方互換、解決結果が `hy config dump` に出る。

**WP-43 API 契約層（7d）** — 対応: P7（軽量版）
- 内容: §2.4。まず GET/POST の主要 40 ルートから。SSE イベント型も生成。
- 受け入れ: 未宣言ルートが CI で失敗、クライアントが生成型のみ参照、実行時検証が 400 を返す。

---

### M5: 連携と成果物（40 人日）

**WP-50 ACP サーバ（10d）** — 対応: I1
- 内容: `hy acp`（stdio NDJSON、ACP v1）。`initialize`, `session/new`, `session/load`, `session/prompt`, `session/cancel`, `session/update`（`agent_message_chunk`, `tool_call`, `tool_call_update`）, `session/close`。モデル選択と MCP サーバ添付は最小限。fs はクライアント能力に従う。
- 対象: 新 `packages/hy-cli/src/acp.ts`, `main.ts`, 新 `tests/integration/acp.test.mjs`（台本クライアント）。
- 受け入れ: 台本クライアントで 1 ターン＋ツール通知＋キャンセル、既存の承認は「セッション既定」で動く。

**WP-51 SDK（JSON-RPC）＋ Python パッケージ（12d）** — 対応: I2, I3
- 内容: `hy serve --sdk`（stdio JSON-RPC 2.0 NDJSON）: `initialize`, `session.create/resume/prompt/cancel/close`, 通知 `session/event`, `session/status`。Python `hy_harness`（stdlib のみ、`subprocess`＋スレッド）を `python/` に。TS クライアントは `packages/sdk`。
- 対象: 新 `packages/hy-cli/src/sdk-server.ts`, `python/`, 新 `tests/integration/sdk.test.mjs`。
- 受け入れ: Python 例が動く、`pip install -e python` で同梱、CI は Python 3.10+ で 1 例。

**WP-52 文書プレビュー・Office→PDF・成果物（10d）** — 対応: U2, U3, I6
- 内容: §2.5。`/api/documents/preview?path=` が PDF を返す（キャッシュは SHA-256）。PDF.js を同梱。Office は `soffice --headless --convert-to pdf` か Word COM を検出時のみ。Office スキルのプロンプト雛形を `packages/hy-cli/prompts/` に追加。
- 受け入れ: PDF/画像/Office の表示、未検出時の明示、変換失敗がモデルに返る。

**WP-53 デスクトップ更新フィード・オンボーディング（8d）** — 対応: X1, X2
- 内容: リリースフィード（HTTPS JSON: version/url/sha256/signature/notes/mandatory）を Ed25519 で検証。既存の scheduled-task 差し替えに進捗・失敗ロールバックを追加。初回起動に「ワークスペース選択 → サンドボックス選択（§2.1） → モデル設定」の 3 ステップ。
- 受け入れ: dry-run の更新テスト（既存 `update-script.test.mjs` を拡張）、署名不正で拒否。

---

### M6: 磨き（30 人日）

- **WP-60** LLM タイトル（first-prompt）・セッション統計・fork・`@session` 参照（10d）— S6〜S10, U13
- **WP-61** メッセージ評価（ログのみ、送信なし）・ショートカット編集・テーマ/フォント・Open In・シークレットマスク（8d）— U4, U8〜U11, D8
- **WP-62** オプトイン OTel（ローカル OTLP、既定 off、セッション内容は送らない）（4d）— D9
- **WP-63** ドキュメント（英/日の導入手順、移行ガイド、トラブルシュート）と i18n 追加キー（8d）— Q1

---

## 5. ギャップ対応表（A 級 21 件）

| ギャップ | 対応 WP | MS |
| :--- | :--- | :-- |
| P1 プロファイル/バンドル合成 | WP-42 | M4 |
| P2 プラグインマネージャ | 不採用（§1.3） | — |
| P3 プラグインマーケット | 不採用 | — |
| P4 Creator モード | 不採用 | — |
| P5 クライアントプラグイン | 不採用（内部レジストリのみ） | — |
| P7 型付き RPC | WP-43（軽量版） | M4 |
| P12 複数アプリプロファイル | WP-42, WP-50, WP-51 | M4/M5 |
| E1 実行中ステアリング | WP-21 | M2 |
| E2 継続可能サブエージェント | WP-22 | M2 |
| E4 workflow ツール | 保留（オーケストレーション A+ を優先。需要が出たら別 ADR） | — |
| T4 永続シェル | WP-31 | M3 |
| S1 セッション形式の版管理 | WP-20 | M2 |
| S4 FTS 全文検索 | WP-32 | M3 |
| M1 pi-ai カタログ | WP-40, WP-42 | M4 |
| M2 Anthropic/Responses | WP-40 | M4 |
| D1 TLS | WP-10 | M1 |
| D2 public URL/trusted host/フェンス | WP-10 | M1 |
| D3 ピア RBAC | 不採用（対象外） | — |
| D11 サンドボックス既定/切替 | WP-12（既定値は §2.1 の判断） | M1 |
| I1 ACP | WP-50 | M5 |
| I2 Python SDK | WP-51 | M5 |

B 級 40 件は WP-23/30/31/32/40/41/42/52/53/60/61 に、C 級 45 件は WP-60/61/62/63 に吸収される（詳細はレポートの ID と突き合わせ）。

---

## 6. データ・形式の変更

### 6.1 セッションログ（v1 → v2）

| 追加イベント | payload | 用途 |
| :--- | :--- | :--- |
| `session/format` | `{ format: 2 }` | 版判定（先頭のみ） |
| `user/steer` | `{ text, images? }` | ステアリング |
| `agent/spawn` | `{ agentId, task, readOnly, depth }` | 子エージェント |
| `agent/message` | `{ agentId, text, direction }` | 送受信 |
| `agent/interrupt` | `{ agentId }` | 停止 |
| `session/cwd` | `{ path }` | cwd |
| `deliverable/presented` | `{ files: [{ path, description? }] }` | 成果物 |
| `sandbox/mode` | `{ mode }` | モード切替 |

- 読み取り時移行のみ。書き込みは常に現行版。`hy sessions --json` の外部形は変えない。
- 既存 v1 ログは `format: 1` とみなし、`user/steer` 等が無いだけとして扱う。

### 6.2 FTS インデックス

```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE sessions (run_id TEXT PRIMARY KEY, cwd TEXT, started_at INTEGER, last_seq INTEGER);
CREATE VIRTUAL TABLE events USING fts5(
  run_id UNINDEXED, seq UNINDEXED, kind UNINDEXED, ts UNINDEXED,
  text, tokenize='trigram'
);
```
- 追従は JSONL のバイトオフセット＋`seq`。壊れたら `hy index rebuild`。
- ユーザーデータは `%LOCALAPPDATA%\hy-harness\state\<id>\index\` に閉じる。

### 6.3 プロファイルバンドル（JSON）

```json
{
  "name": "minimal",
  "version": 1,
  "tools": ["shell", "read_file", "read_image", "working_directory"],
  "promptSections": ["minimal"],
  "roles": { "worker": { "model": "qwen2.5:3b" } },
  "ui": { "panels": ["terminal", "files"] }
}
```

### 6.4 API 追加（概要）

- `POST /api/sessions/:id/steer`
- `GET /api/sessions/:id/agents` / `POST .../agents/:agentId/message` / `POST .../interrupt`
- `POST /api/sessions/:id/sandbox`
- `GET /api/search?q=&cwd=&limit=`
- `GET /api/documents/preview?path=`
- `GET /api/update/check`（Desktop のみ）
- いずれも WP-43 の契約に宣言し、型を生成。

---

## 7. セキュリティ・互換性の注意

1. **サンドボックス既定**: §2.1 の判断を先に確定。既定を変える場合は ACL 初回付与の同意と非 ACL ボリュームの警告を必須にする。
2. **TLS/フェンス**: `--trusted-host` を付けない限り外部 Authority を拒否。`--public-url` は表示のみで信頼を与えない（DSH と同じ）。
3. **永続シェル**: confined で stdin が使えない場合は one-shot にフォールバックし、`gap:` に記録。無理に広げない。
4. **文書変換**: `soffice` のパスはユーザー設定。変換はサンドボックス外のプロセスなので、入力パスをワークスペース内に限定し、出力は専用 temp に。
5. **ACP/SDK**: 承認はセッション既定に従う。`--yes` 相当を暗黙に付けない。
6. **ライセンス**: DSH は MIT。プロンプト文言・スキーマ定義をコピーする場合は `THIRD_PARTY_NOTICES.md` に出所を記載する。コードは再実装を原則とする。
7. **後方互換**: `--profile` / `hy run` / `hy web` の既存フラグは不変。新フラグは opt-in。設定ファイルは未知キーを無視（現行どおり）。

---

## 8. テスト戦略とゲート

| ゲート | 内容 | 追加 |
| :--- | :--- | :--- |
| G1 | `cargo test --workspace` / `clippy -D warnings` | 変更なし |
| G2 | `pnpm typecheck` / `build` / `check:protocol` / `check:api` / `check:config-schema` | **新規 2 つ** |
| G3 | `pnpm test`（275 件＋Web UI） | 各 WP で単体追加 |
| G4 | `pnpm test:integration`（67 件） | **+6 本**（web-deploy, steer, agents, persistent-shell, fts, acp） |
| G5 | `pnpm test:regression`（K1〜K14） | **新規** |
| G6 | `pnpm desktop:screenshot` | 変更なし（UI WP で更新） |
| G7 | トークン量（≤1,200）と起動時間（基準値 ±10%） | ツール追加のたび |

- 各 WP の Definition of Done: 実装＋単体＋統合＋i18n（ja/en/zh）＋ドキュメント＋G1〜G5 緑。
- UI を含む WP は `desktop:screenshot` と 390 px 幅の確認を必須にする。

---

## 9. リスクと対策

| # | リスク | 影響 | 対策 |
| :-- | :--- | :--- | :--- |
| R1 | セッション形式変更で過去ログが読めない | 高 | 読み取り時移行＋ゴールデンログ＋バックアップ（変更前に `.bak`） |
| R2 | ステアリングが undo/compaction を壊す | 高 | 組境界の単体テスト、undo のゴールデン、監査ログ |
| R3 | 永続シェルが confined で動かない | 中 | 自動フォールバック＋`gap:` 報告。無理に権限を広げない |
| R4 | サンドボックス既定変更で既存ユーザーが止まる | 高 | §2.1 の判断を分離。既定は据え置き、UI で推奨提示 |
| R5 | プロバイダ追加でトークン/費用が膨らむ | 中 | 契約テスト、価格必須（USD 予算時）、既定は現行 |
| R6 | TLS/プロキシ設定ミスで接続不能 | 中 | 起動時検証、`--trusted-host` 必須化、テスト用プロキシ |
| R7 | スコープが膨らみ DSH の全機能移植になる | 高 | §1.3 の不採用リストと ADR で固定。A 級 21 件を上限に |
| R8 | Windows 前提の sandbox 設計とクロスプラットフォーム要求の衝突 | 中 | Windows を第一と明記。他 OS は `unconfined` のみ（現行どおり） |
| R9 | LibreOffice 依存の配布サイズ/ライセンス | 低 | 同梱しない。検出時のみ。PDF.js は MIT |
| R10 | ACP/SDK の API 面が増えて保守不能 | 中 | セッション制御を 1 つの `SessionService` に集約し、ACP/SDK/HTTP は薄いアダプタ |

---

## 10. スケジュール（1 人＋AI エージェント想定）

| 週 | 内容 |
| --: | :--- |
| 1 | M0（WP-00, 01）／ADR |
| 2–6 | M1（TLS・フェンス・設定ダンプ・モード切替）→ **v0.2.0** |
| 7–9 | WP-20（形式 v2）→ WP-21（ステアリング） |
| 10–15 | WP-22（継続サブエージェント）、WP-23（todo/present） |
| 16–22 | M3（ツール・永続シェル・FTS）→ **v0.3.0** |
| 23–29 | M4（プロバイダ・バンドル・契約） |
| 30–38 | M5（ACP・SDK/Python・文書・更新） |
| 39–44 | M6（磨き・OTel・ドキュメント）→ **v0.4.0** |

- 2 人なら M4 を M2 と並行し、**約 24 週**。
- 途中で優先度を変える場合も、**M1→M2→M3 の順序は入れ替えない**（安全と履歴形式が土台）。

---

## 11. 完了定義（v0.4.0）

1. レポート A 級 21 件のうち、不採用 5 件（P2/P3/P4/P5/D3）と保留 1 件（E4）を除く **15 件が実装済み**。
2. `pnpm test:regression` が K1〜K14 を検証し、既存 67 統合＋新規 6 統合が緑。
3. `pnpm check:api` / `check:config-schema` / `check:protocol` がドリフトなし。
4. TLS＋前置プロキシ配備、ACP、Python SDK の 3 経路が手順書どおりに動く。
5. トークン量 ≤1,200、起動時間が基準値 ±10% 以内。
6. `docs/` に移行ガイド（v0.1→v0.4）とトラブルシュートがある。
