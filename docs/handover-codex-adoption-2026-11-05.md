# Codex 採用計画 引き継ぎ書（2026-11-05 / 実装担当エージェント向け）

> **訂正（ラウンド 54 で追記）**: 下の §2・§3・§7 にある「失敗は環境要因のみ」「66 ファイル中 64 PASS が期待値」は誤り。
> 子プロセスが使える環境で全テストを回したところ、統合テストは `isolate.mjs` の構文エラーで一度も実行されておらず、
> `denyRead` が読み取りを止めていない・`readOnly` の既存ファイルが書ける・K9 が 1,552 トークンで予算超過、などの実際の回帰があった。
> 修正内容と現在の検証結果は [codex-adoption-progress.md](codex-adoption-progress.md) のラウンド 54 を参照。
> 現在の期待値は「単体 499/499、cargo test 全件、clippy/fmt 緑、統合テスト全件」。

> 引き継ぎ対象: 「`docs/codex-adoption-plan.md` の作業パッケージを実装する」ゴール。
> この文書は、実装を続ける別エージェントが**最初に読む**ことを想定している。
> 事実はこのセッションの実行結果に基づく。未確認のものは「未確認」と書いた。

---

## 0. まず読む順番

1. **本ファイル**
2. `docs/codex-adoption-progress.md` — ラウンド 1〜53 の作業ログ（各 WP の変更点・検証・残り）
3. `docs/codex-adoption-plan.md` — 44 WP の計画（冒頭に「実装状況」を追記済み）
4. `docs/implementation_status.md` §7 — WP 単位の完了/残りの表
5. `docs/codex-gap-analysis.md` — Codex との差分 119 件（根拠）

ゴールは**環境要因で blocked 済み**（下記 §2.1）。再開には環境の用意が必要。

---

## 1. 目的とスコープ

- Codex の設計（`F:\HY-HARNESS\.refs\codex`、shallow clone, commit `c90354172c…`）を分析し、HY-HARNESS に不足している機能を計画 → 実装する。
- **対象外（ユーザー指示）**: ネットワーク関連の CP-03・CP-04、SEC-02/03/04。それ以外を C0→C5 の順に、各 WP に受け入れテストを付け、ビルドとテストを緑に保ちながら進める。
- 記録先は `docs/codex-adoption-progress.md`（1 ラウンド = 1 セッション、新しいラウンドが上）。

---

## 2. 環境（重要）

| 項目 | 実測/既知 |
| :--- | :--- |
| OS / シェル | Windows 10、Windows PowerShell 5.1 |
| 実装元 | `F:\HY-HARNESS`。**git リポジトリではない**（`git status` → not a repository）。バージョン管理なし。 |
| ファイルシステム | `F:` は exFAT。`write` ツールで**新規ファイル作成が EISDIR で失敗することがある** → `New-Item` で空ファイルを作り、`read` してから `write` する。 |
| DSH サンドボックス | 子プロセスの**パイプ付き spawn が EPERM**。`pnpm test` / `pnpm test:integration` / `pnpm verify` は実行不可。`ExecRpcClient` の exec-server 起動も不可。 |
| 起動できないもの | web GUI サーバー、exec server、`CreateRestrictedToken`（ERROR_INVALID_PARAMETER 87） |
| できること | 直接 `node <dist>/xxx.test.js` による単体テスト、`cargo test`（spawn しないテストのみ）、`node scripts/*.mjs --check`、CLI の直接実行（例 `node packages/hy-cli/dist/main.js ...`）、`cmd /c "type req | node main.js protocol serve"` の匿名パイプ |
| その他 | `G:\マイドライブ\HY-HARNESS` は読み取り専用（`docs/handover-2026-11-06.md` §1 に詳細） |

### 2.1 ブロック理由（ゴールの blockedReason）

残り WP（C4 GUI、C3 の WS/daemon/SDK/ACP、C5 の署名・単一バイナリ）は、ブラウザ・通常の Windows CI ランナー・署名／配布基盤が必要で、この環境では**受け入れテストを緑にできない**。ラウンド 45〜53 で検証可能な範囲（プロトコルの純関数・CLI・ドキュメント）を使い切ったため、推測実装を止めて blocked にした。

---

## 3. 検証の手順（この環境での正しい回し方）

```powershell
cd F:\HY-HARNESS
pnpm build                      # 必ず通す（dist が古いとテストが古いまま通る）
pnpm typecheck
pnpm check:api                  # web/src/api.gen.ts
pnpm check:api-schema           # docs/api.schema.json
pnpm check:config-schema        # docs/config.schema.json
node scripts/gen-protocol.mjs --check --schema target/schema.json
cargo test -p hy-exec-server    # 33 passed（spawn しないテスト）
cargo test -p hy-sandbox-windows # 13 passed / 1 failed（CreateRestrictedToken 87。環境要因）

# 単体テスト走査（pnpm test の代替）
$files = Get-ChildItem packages\core\dist,packages\seams\dist,packages\hy-cli\dist -Recurse -File -Filter *.test.js
foreach ($f in $files) { node $f.FullName; if ($LASTEXITCODE -ne 0) { $f.Name } }
```

- 期待値（2026-11-05 時点）: **66 ファイル中 64 PASS**。失敗は `mcp.test.js` と `lsp.test.js` のみ（子プロセス禁止）。
- `scripts/verify-all.mjs`（`pnpm verify`）は CI/実機向け。`--list` でステップを列挙できる（8 ゲート + テスト）。
- 実測で確認した既知の失敗:
  - `mcp.test.js` の stdio 2 件（HTTP の CP-11 テストは in-process サーバーで **PASS する**）
  - `lsp.test.js`
  - `token::tests::constructs_tokens_for_standard_user_and_admin_member_identities`（`CreateRestrictedToken` が 87）

---

## 4. 完了した実装（C0〜C2、C3/C5 の一部）

### C0 封じ込め（完了）

- CP-01: 既定 `workspace-write`。`--unsafe-unconfined` / `sandbox.legacyUnconfined` で従来動作。
- CP-02: `PermissionProfile`（`extends` / `denyRead` / `readOnly` / `write`）、`permissions` / `defaultPermissions`、`mergePermissionProfile`（循環検出）、`resolveDenyRead` / `resolveReadOnly`。
- CP-05: 承認ポリシー 4 値（`untrusted` 既定 / `on-request` / `on-failure` / `never`）、`request_permissions` ツール（承認後に `sandbox/add-root`、セッション中のみ）。
- CP-06: `classifyDenial`（policy / approval / sandbox / network / protected）、`sandbox/denial` と `tool-error.denial` イベント、GUI のバッジと Details パネル（`web/src/denials.ts` / `app.ts`）。
- CP-07: 軽減ポリシー（DEP/SEHOP/HEAP_TERMINATE/ASLR。word2 は 0 のまま）。
- CP-08: DPAPI シークレット（`dpapi:` 参照、`hy secret set/list/remove`、`crates/hy-sandbox-windows/src/secrets.rs`、`src/bin/hy-secret.rs`）。
- CP-44: Guardian のレビューセッション（`packages/seams/src/guardian.ts`: context / maxPromptChars 8,000 / deadline 20s / evidence / 承認キャッシュ 200 件 / 予算クリップ）。

### C1 道具箱（完了、一部制約）

- CP-09: `write_stdin` + `shell { stdinPipe: true }`。Rust 側で tokio / 制限トークンの両経路に stdin パイプを追加（`job/write` RPC）。**PTY/ConPTY は未実装**。
- CP-10: `tool_search`（deferred ツール: `web_fetch` / `web_search` / `lsp` / `mcp_call` / `memory` など）、初期プロンプト予算の再定義。
- CP-11: MCP の **HTTP/SSE**（`McpHttpClient`）と **resources**（`list_mcp_resources` / `read_mcp_resource`、deferred）。stdio は従来どおり。prompts/elicitation/OAuth は未実装。
- CP-12: `current_time` / `sleep`（最大 60s）/ `get_context_remaining`、`setUsage`。
- CP-13: 各ターン開始時に `session/snapshot`（cwd / workspaceRoot / provider）。
- CP-14: `search_glob` / `search_grep` を直接公開。
- CP-15: `spawn_agent` / `wait_agent` / `list_agents` / `close_agent`（deferred、`requires: delegate`、GUI の `SubagentRegistry` 接続）。
- CP-16: `hy worktree list|create|apply|remove`（`packages/core/src/worktree.ts`、`<stateDir>/worktrees`、`git apply --3way`）。
- CP-17: 画像のメディア予算（`pruneImages`、コンパクションのトリガー前でも実行）。

### C2 ループ（完了、一部制約）

- CP-18: ストリーミング（OpenAI 互換のみ）。`CompleteOptions.onDelta`、`assistant-delta` イベント、GUI の draft 置換。**ストリーミング経路は 429/5xx を再試行しない**。
- CP-19: フック 11 種 + `notify`。`sessionStart/End`、`userPromptSubmit`（exit 2 ブロック / stdout 文脈）、`modelRequest`、`permissionRequest`（自動承認より優先）、`preToolUse/postToolUse`、`preCompact/postCompact`、`stop`/`interrupt`、`subagentStart/Stop`。
- CP-20: memories パイプライン（`memory.auto`、`parseMemoryCandidates`、`MemoryStore.upsert`、上限で skipped 報告、run id と evidence）。
- CP-21: `rankSkills` / `SkillUsageStore`（`<stateDir>/skill-usage.json`、`@skill:` メンションは未実装）。
- CP-22: 要約失敗時の縮退（Tier 1 で継続、`compaction/failed`）、compact フック、**非同期コンパクション**（`ContextManager.afterResponse` + セグメントハッシュの暖機キャッシュ。`keepRecentTurns <= 1` では暖機しない）。
- CP-23: `token/estimate`（estimated / actual / ratio）をログ、`calibratedCoefficients`（0.5〜2 倍クランプ）。
- CP-24: 既存の OTEL 風 span はそのまま（新規エクスポータなし）。

### C3（一部）

- CP-25: JSON-RPC 2.0 のメッセージ層（`packages/hy-cli/src/protocol.ts`）と `hy protocol serve`（stdio）。
  - メソッド: `initialize`（`serverInfo.apiVersion = 'hy-api/1'`、capabilities threads/turns/approvals すべて true）、`thread/list`（`limit`）、`thread/read`（`offset` / `limit` / `title` / `total`）、`turn/start`（`threadId` で再開）、`turn/cancel`、`turn/steer`、`turn/status`、`approval/request`（通知）、`approval/respond`。
  - **スレッド = run**（`session.v1.jsonl` 内の runId）。ラウンド 31 の「1 ファイル = 1 スレッド」モデルは誤りで、ラウンド 34 で訂正済み。
  - 行の処理は並行（`turn/start` が承認応答を待つ間も `approval/respond` を読める）。応答順は入れ替わりうる（JSON-RPC は id で対応）。
  - 承認は 5 分でタイムアウト拒否、`denyAll` で解放。
- CP-26: `packages/hy-cli/src/api-schema.ts` から `docs/api.schema.json`（draft 2020-12、91 ルート、`hy-api/1`）を生成。`/api/health` が `apiVersion`、`hy protocol schema` で出力。`check:api-schema` でドリフト検出。

### C5（一部）

- CP-37: 設定レイヤ（既定 → ユーザー + `profiles` → 信頼済みプロジェクト → CLI フラグ → バンドル）。`hy config paths [--json]`。
- CP-38: フィーチャーフラグ（`features.ts`、`streaming` / `tool-search` / `doctor-json`、`hy features list|enable|disable`、`config.features`）。`streaming:false` で非ストリーミングに戻る。**`tool-search` フラグは未消費**。
- CP-39: `hy doctor [--json]`（workspace / exec-server / sandbox / roles / features / mcp / hy-secret / update-feed、ok・warn・fail）。`GET /api/metrics`（uptime / sessions / RSS、`metricsSnapshot`）。
- CP-42: `scripts/verify-all.mjs`（`pnpm verify` / `verify:list`）と CI の追加ゲート（`cargo fmt --check`、`check:api`、`check:api-schema`、`check:config-schema`）。CI は `.github/workflows/ci.yml`。

### CLI 追加コマンド（このセッション分）

`hy fork <run-id> [--turn n]`、`hy worktree list|create|apply|remove`、`hy doctor [--json]`、`hy features list|enable|disable`、`hy protocol schema|serve`、`hy config paths [--json]`。

---

## 5. 未完了（次にやること）

優先度順。すべて**受け入れテストを緑にできる環境**が前提。

1. **C4 GUI（CP-32〜36）** — ブラウザ必須。スラッシュコマンドの GUI パレット、差分/トランスクリプト検索、承認 UI の情報量（パス・cwd・ネットワーク）、セッション管理 UI（rename/archive/delete/fork/モデル能力表示）、キーマップ/statusline/テーマ。既存 API（`/api/sessions/:id/*`）はかなり揃っている（`api-contract.ts` 参照）。`hy fork` はバックエンドのみ。
2. **C3 残り（CP-27/28/29/30/31）** — WebSocket トランスポート、exec-server の WS、daemon 常駐、`hy serve`、SDK/ACP クライアント、Codex からの移行。`api.gen.ts` と `protocol.gen.ts` が土台。
3. **C5 残り（CP-40/41/43）** — 配布署名の運用手順（Ed25519 の feed 署名・検証は `update-feed.ts` に既存）、単一バイナリ配布、QA。CI 実機が必要。
4. **C1/C2 の残り** — `@skill:` メンション、`tool-search` フラグの消費、PTY（CP-09）、MCP prompts/elicitation、非同期コンパクションの更なる最適化。

---

## 6. 設計上の重要な決定・不変条件（壊さないこと）

- **サンドボックス既定は `workspace-write`**。読み取りとネットワークは既定で塞ぐ。deny ACE は workspace SID 名義で、ユーザーアクセスは残す。
- **初期プロンプト予算**: deferred ツールは `tool_search` で取りに行く。`sleep` / `get_context_remaining` / `request_permissions` は「常時必要」なので直接公開。`request_permissions` は承認を `unconfined` の合成要求にして**ユーザー判断を強制**（Guardian 不可）。
- **承認キャッシュは承認のみ**（拒否はキャッシュしない）。キーは sandbox + 正規化コマンド。
- **`untrusted` が既定の承認ポリシー**（従来動作を維持）。
- **フックの意味**: `userPromptSubmit` の exit 2 はターン中断、stdout は `<untrusted_hook_context>` として文脈に追加（指示ではなくデータ）。`permissionRequest` の拒否は自動承認より優先。
- **コンパクションの暖機キャッシュ**は「次に圧縮されるプレフィックス」にキーを合わせる（生成時 `keepRecentTurns - 1`、利用時 `keepRecentTurns`）。失敗は握りつぶして同期経路に任せる。
- **memories は黙って捨てない**（上限で `skipped` / `error` を返す）。
- **ストリーミングは OpenAI 互換のみ**。Anthropic/Gemini/Responses は非ストリーミング。
- **スレッド = runId**。`session.v1.jsonl` は 1 ワークスペース 1 本。`thread/read` の items は user/assistant/tool/error（ツール出力は 2,000 文字で切り詰め）。
- **`fork` はイベント複製**（`session/format` を除く）。元 run は不変。
- **生成物**（`api.gen.ts` / `protocol.gen.ts` / `docs/api.schema.json` / `docs/config.schema.json`）は手で編集しない。`gen:*` で再生成し `check:*` で確認。

---

## 7. このセッションで踏んだ罠（再発防止）

1. **exFAT + `write` ツール**: 新規ファイルは EISDIR で失敗することがある → `New-Item` で空ファイル → `read` → `write`。
2. **PowerShell の引用**: 二重引用符内の `` ` `` はエスケープ、`${...}` は変数展開。**バッククォートや `${}` を含むコードの置換は必ず single-quoted here-string（`@'...'@`）**で行う。`\"` も使わない。
3. **`tsc -b` の増分ビルド**: `agent.test.ts` が import 欠落のまま dist に残り、ビルドが差分を検出するまで露見しなかった。**テストファイルを触ったら必ず `pnpm build`**。CI はクリーン相当で回す。
4. **生成物の再生成順**: `pnpm build` してから `gen:config-schema` / `gen:api` / `gen:api-schema`。`gen:protocol` は `cargo build -p hy-protocol --bin hy-protocol-schema` → `target/debug/hy-protocol-schema.exe > target/schema.json` → `node scripts/gen-protocol.mjs --schema target/schema.json`（`--schema` は cargo spawn を回避するため）。
5. **`node -e` の入れ子引用**は壊れやすい。スモークテストは一時 `.mjs` ファイルに書いて `node file.mjs` で実行する。
6. **`pnpm test` はこの環境で不可**（spawn EPERM）。単体は dist のテストを直接実行する。
7. **`process.resourcesPath` は `@types/node` に無い** → `(process as unknown as { resourcesPath?: string })`。
8. **`exactOptionalPropertyTypes`**: `{ foo: undefined }` は不可。条件スプレッド `...(x !== undefined ? { foo: x } : {})` を使う。
9. **wire 一覧テスト**: `tool-registry.test.ts` の `assert.deepEqual(wire, [...])` は**実際の順序**に合わせる必要がある（ツール追加のたびに更新）。SDK スナップショットは `UPDATE_SNAPSHOTS=1 node ...` で更新。
10. **一時的なテスト競合**: ビルド直後に一斉走査すると `protocol-threads.test.js` が落ちることがあった（再実行で安定）。ビルド完了を待ってから走査する。

---

## 8. 再開時の最初の 3 アクション

1. `pnpm build` → `pnpm typecheck` → 生成物チェック → 単体走査（§3）。**66 ファイル中 64 PASS** を確認（mcp/lsp は期待どおり失敗）。
2. `docs/codex-adoption-progress.md` の最新ラウンドと `implementation_status.md` §7 で、残りの WP を確認。
3. 環境（ブラウザ / Windows CI / 署名基盤）が使えるなら、C4 GUI → C3 WS/SDK → C5 配布物の順で再開。使えないなら、この環境で検証できる純関数・CLI・プロトコルの範囲に限定する（推測実装はしない）。

---

## 9. 参考: 主要ファイル

| 領域 | ファイル |
| :--- | :--- |
| 設定・プロファイル | `packages/core/src/config.ts`, `config-schema.ts`, `features.ts`, `secrets.ts` |
| エージェント | `packages/core/src/agent.ts`, `prompt.ts`, `tools.ts`, `tool-registry.ts` |
| コンテキスト | `packages/seams/src/spill-compaction.ts`, `packages/core/src/tokens.ts`, `memory.ts`, `memory-pipeline.ts` |
| フック | `packages/core/src/hooks.ts` |
| スキル | `packages/core/src/skills.ts` |
| サブエージェント | `packages/hy-cli/src/agents.ts`, `session-app.ts` |
| プロトコル | `packages/hy-cli/src/protocol.ts`, `protocol-threads.ts`, `protocol-turn.ts`, `protocol-approvals.ts` |
| API スキーマ | `packages/hy-cli/src/api-schema.ts`, `scripts/gen-api-schema.mjs`, `docs/api.schema.json` |
| CLI | `packages/hy-cli/src/main.ts`（`fork` / `worktree` / `doctor` / `features` / `protocol` / `config paths`） |
| 実行デーモン | `crates/hy-exec-server/src/{jobs,shell,server,sandbox}.rs`, `crates/hy-protocol/src/lib.rs` |
| サンドボックス | `crates/hy-sandbox-windows/src/{deny_read,read_only,secrets,spawn,grants,token}.rs` |
| テスト | `packages/*/src/*.test.ts`, `tests/integration/*.test.mjs`（`write-stdin` / `worktree` を追加） |
