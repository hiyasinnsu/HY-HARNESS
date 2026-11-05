# Codex 差分の導入進捗

- **計画**: [codex-adoption-plan.md](codex-adoption-plan.md)。**分析**: [codex-gap-analysis.md](codex-gap-analysis.md)。
- **方針の変更**: ユーザー指示（2026-11-05）により **ネットワーク関連（CP-03 ネットワーク閉じ込め/プロキシ、CP-04 ネットワーク承認、SEC-02/03/04）は後回し**。それ以外を C0 → C5 の順に実装する。
- **記録**: 1 ラウンド = 1 セッション。各 WP の「実装した内容」「検証」「残り」を追記する。

---

## ラウンド 54（2026-11-05）— 実環境での全テストと回帰の修正

### 前提の訂正（重要）

ラウンド 45〜53 の「66 ファイル中 64 PASS、失敗は環境要因のみ」は**誤り**だった。今回の環境（Claude Code、子プロセス・Ollama・NTFS のユーザープロファイルが使える）で `pnpm test`・`pnpm test:integration`・`cargo test`・`cargo clippy`・`cargo fmt --check` を初めて全部回したところ、環境要因と見なしていた失敗の多くが**実際の回帰**だった。統合テストは `tests/integration/isolate.mjs` の構文エラー（PowerShell の置換で `\n` が文字のまま入った）で**1 本も実行されていなかった**。

### 修正

| 区分 | 内容 | 主な変更 | 検証 |
| :--- | :--- | :--- | :--- |
| **CP-02（セキュリティ）** | **`denyRead` が読み取りを止めていなかった**。閉じ込めトークンは `WRITE_RESTRICTED` なので、ワークスペース SID への deny ACE は書き込みにしか効かない。さらに `SetKernelObjectSecurity` は継承 ACE を既存の子へ伝播しないため、ディレクトリ直下の既存ファイルには ACE すら付いていなかった | `grants::add_deny_ace_tree`（既存の子を 1 件ずつ処理し、全オブジェクトの SDDL を取り消し記録に残す）。`denyRead` は **Medium の必須ラベル `NO_READ_UP`**（全閉じ込めモードは Low 整合性）を併せて付ける。`docs/enforcement-gaps.md` S1 を更新 | `deny_then_restore_round_trips`（既存ファイルのラベルと復元）PASS。統合 `sandbox-deny-read` で**閉じ込めトークンの `type` が拒否され、ユーザーは読める**ことを実測 |
| **CP-02（セキュリティ）** | `readOnly` も同じ伝播漏れで、カーブアウト内の**既存ファイルに書き込めた**（grant が各ファイルに明示 allow を付けるため） | 同じ `add_deny_ace_tree`（ラベルなし） | `carve_out_round_trips` に既存ファイルの検証を追加。統合で `echo > keep.txt` が拒否される |
| **CP-02** | `canonicalize` の `\\?\` 付きパスのまま比較していたため、`readOnly` は常に「ワークスペース外」で拒否、`denyRead` の「ワークスペース/祖先は拒否」ガードは決して発火しなかった | `sandbox.rs` で `plain_path` を通す | 新規統合テスト「denyRead refuses the workspace and its ancestors」PASS |
| **K9 / CP-10・12・14** | 初期ツールプロンプトが **1,552 トークン**（予算 1,200）。PTC では wire ツールと SDK が同じ署名を二重に載せていた（CP-14 で search も重複） | `renderSdk(..., mirrored)`: 同じプロンプトに wire 版がある SDK 関数は `tools.readFile = read_file` の 1 行にまとめる | Ollama `qwen2.5:3b` 実測で **1,168 トークン**（wire 710）。`tool-overhead.test.mjs` PASS |
| **CP-10** | モックプロバイダが deferred ツール（`mcp_call` / `web_fetch`）を直接呼んで「not loaded」で失敗。`lsp.test` も同じ | モックは「not loaded」エラーで `tool_search` → 元の呼び出しを再試行（実モデルと同じ回復手順）。`lsp.test` は先に `tool_search` | `mcp.test` / `web.test` / `lsp.test` PASS |
| **CP-16** | `hy worktree apply` が変更をステージしたまま残し、`remove` が `--force` なしで失敗 | apply 成功後にワークツリーのブランチ `hy/<name>` へコミット（フックは尊重、ID 未設定時のみ既定 ID）。失敗時は `committed:false` を CLI が警告 | 統合 `worktree.test` に `git show hy/feature:FEATURE.md` を追加して PASS |
| **CP-42** | CI ゲートの `cargo fmt --check` と `cargo clippy -D warnings` が通っていなかった | `cargo fmt --all`、`secrets` テストの `expect` を `Result` に、`server.rs` の冗長クロージャ | 両ゲート PASS |
| テスト基盤 | `isolate.mjs` の構文エラー。`%TEMP%` の上位に AppContainer ACE がある機械では閉じ込めサンドボックスが使えず、`tmpRoot()` の fixture で 8 件失敗 | `isolate.mjs` を修復。`capability.mjs` に `canConfineTemp`（exec server に問い合わせる）を追加し、使えなければユーザープロファイルに fixture を作る | `guardian` / `win10-sandbox` 9 件 PASS |
| テストの期待値 | `ptc-appcontainer`（CP-14 で `search_grep` は直接公開になった）、`worktree`（`core.autocrlf=true` で CRLF）、`sandbox-deny-read`（引数欠落の `assert.deepEqual`、承認なしの書き込みコマンド） | 期待値を設計どおりに更新 | PASS |

### 検証結果（この環境）

- `pnpm build` / `typecheck` / `check:api` / `check:api-schema` / `check:config-schema` / `check:protocol`: 成功
- 単体 `pnpm test`: **499 / 499 PASS**（`mcp`・`lsp` を含む）
- `cargo test`（exec-server 33、sandbox 14 + 2、protocol、execpolicy）: すべて PASS。`CreateRestrictedToken` の 87 もこの環境では再現しない
- `cargo clippy --workspace --all-targets -D warnings` / `cargo fmt --check`: PASS
- 統合 `pnpm test:integration`: **113 / 113 PASS**（スキップ 0、所要約 10 分。初回は失敗パスで exec server が残って終了しなかったが、修正後は再現しない）
- `pnpm verify`: **11 ゲートすべて PASS**。`scripts/verify-all.mjs` 自体も一度も通っていなかった（存在しないルート `tsconfig.json` を `tsc -b --force` していた）ので、プロジェクトを明示し、`cargo fmt` / `clippy` を追加し、子プロセスが使える環境では `lsp`/`mcp` を飛ばさず `pnpm test` を回すようにした

### 残り

- C4 GUI（CP-32〜36）: この環境にはブラウザペインがあるので着手できる。
- C3（CP-27〜31）、C5（CP-40/41/43）は従来どおり。

---

## ラウンド 53（2026-11-05）— 再確認と残作業の性质

### 検証結果（この環境）

`pnpm build` / `typecheck` 成功。生成物（API 型・API スキーマ・config スキーマ）はすべて up to date。単体 **66 ファイル中 64 PASS**（失敗は `mcp`/`lsp` のサブプロセス禁止のみ）。

### 残作業の性質（重要）

残る WP は、この環境では**検証できない**領域に集中している:

1. **C4 GUI（CP-32〜36）**: ブラウザでの操作・表示確認が必要。
2. **C3（CP-27/28/30/31）**: WebSocket・daemon・SDK/ACP は実ランナーとクライアント実装が必要。
3. **C5（CP-40/41）**: 署名・単一バイナリはビルド／配布基盤（CI 実機・証明書）が必要。

コードを書くこと自体は可能だが、**受け入れテストを緑にできない**ため、これ以上の推測実装は避け、検証可能な範囲（プロトコルの純関数・CLI・ドキュメント）に留めた。次回は CI 実機・ブラウザ・配布基盤が使える環境で再開する。

---

## ラウンド 52（2026-11-05）— `thread/read` にタイトル

### 完了

| WP | 内容 | 主な変更 | 検証 |
| :--- | :--- | :--- | :--- |
| **CP-25** | トランスクリプトの見出し | `ThreadView` に `title` を追加（最初の user メッセージの 1 行目、最大 80 文字）。`thread/list` のタイトルと一致する | `protocol-threads.test.js` のページングテストに `title` の検証を追加して **PASS**。単体 66 ファイル中 64 PASS（`mcp`/`lsp` は環境要因） |

### 次ラウンド

1. C4 UX の GUI（純関数＋配線に限定）。
2. C5: 単一バイナリ配布物、署名の運用手順。
3. protocol の承認通知を GUI に表示。

---

## ラウンド 51（2026-11-05）— 計画ヘッダに実装状況を追記

計画 [codex-adoption-plan.md](codex-adoption-plan.md) の冒頭に「実装状況」を追加した。C0〜C2 完了、C3 は CP-25/CP-26、C5 は CP-37/38/39/42 を実装済みで、C4 GUI と C3 の WS/SDK、C5 の配布物が未着手であることを 1 行で示し、[implementation_status.md §7](implementation_status.md) と本ファイルへリンクした。コード変更なし。

---

## ラウンド 50（2026-11-05）— `thread/read` のページング

### 完了

| WP | 内容 | 主な変更 | 検証 |
| :--- | :--- | :--- | :--- |
| **CP-25** | 長いトランスクリプトのページング | `readThread(logFile, threadId, { offset, limit })` と `thread/read` の `offset` / `limit`（非数・負値は -32602）。戻り値に `total` を追加し、`items` は要求された範囲だけ | 新規 `protocol-threads.test.js` 1 件 PASS（offset/limit/0/既定）。**実測**: `limit:-1` → `-32602 limit must be a non-negative number`、未知スレッド → `-32602 unknown thread nope`。単体 66 ファイル中 64 PASS（`mcp`/`lsp` は環境要因） |

### 次ラウンド

1. C4 UX の GUI（純関数＋配線に限定）。
2. C5: 単一バイナリ配布物、署名の運用手順。
3. protocol の承認通知を GUI に表示。

---

## ラウンド 49（2026-11-05）— 全ゲート再確認

### 検証結果（この環境）

| ゲート | 結果 |
| :--- | :--- |
| `pnpm build` / `pnpm typecheck` | 成功 |
| `check:api` / `check:api-schema` / `check:config-schema` / protocol 型 | すべて up to date |
| 単体テスト | **66 ファイル中 64 PASS**。失敗は `mcp`/`lsp`（サブプロセス禁止）のみ |

コード変更なし。次回は C4 GUI か C5 配布物（ブラウザ／実ランナーでの検証が必要な領域）から再開する。

---

## ラウンド 48（2026-11-05）— `thread/list` の limit

### 完了

| WP | 内容 | 主な変更 | 検証 |
| :--- | :--- | :--- | :--- |
| **CP-25** | 一覧の件数制限 | `listThreads(logFile, { limit })` と `thread/list` の `limit` パラメータ（非数・負値は -32602、既定は全件）。長いログでもクライアントが件数を絞れる | 新規 `protocol-threads.test.js` 1 件 PASS（limit 2 / 0 / 既定）。**実測**: `limit:-1` → `-32602 limit must be a non-negative number`、`limit:2` → `{threads:[]}`。単体 66 ファイル中 64 PASS（`mcp`/`lsp` は環境要因） |

### 次ラウンド

1. C4 UX の GUI（純関数＋配線に限定）。
2. C5: 単一バイナリ配布物、署名の運用手順。
3. protocol の承認通知を GUI に表示。

---

## ラウンド 47（2026-11-05）— protocol のバージョン情報

### 完了

| WP | 内容 | 主な変更 | 検証 |
| :--- | :--- | :--- | :--- |
| **CP-25 / CP-26** | プロトコルのバージョン情報 | `initialize` の `serverInfo` に `apiVersion: 'hy-api/1'` を追加（HTTP API のバージョンと一致）。クライアントはプロトコル版と API 版を同時に確認できる | `protocol.test.js` PASS。**実測**: `initialize` → `serverInfo: {name, version, apiVersion:"hy-api/1"}`。`pnpm build` 成功 |

### 次ラウンド

1. C4 UX の GUI（純関数＋配線に限定）。
2. C5: 単一バイナリ配布物、署名の運用手順。
3. protocol の承認通知を GUI に表示。

---

## ラウンド 46（2026-11-05）— 実装状況の整理

`docs/implementation_status.md` に **§7「Codex 採用計画の実装状況（WP 単位）」** を追加した。C0〜C5 の完了 WP と残り、検証の現状（単体 66 ファイル中 64 PASS、失敗は環境要因のみ）を 1 表にまとめ、次回の引き継ぎ点を明確にした。コード変更なし。

---

## ラウンド 45（2026-11-05）— `GET /api/metrics`（観測の足場）

### 完了

| WP | 内容 | 主な変更 | 検証 |
| :--- | :--- | :--- | :--- |
| **CP-39**（観測） | プロセスのメトリクス | 新規 `packages/core/src/metrics.ts`: `metricsSnapshot`（uptime / sessions / RSS、負値・NaN は 0）。`GET /api/metrics` を API 契約に追加し web-server から返す。`api.gen.ts` と `docs/api.schema.json` を再生成（**91 ルート**） | 新規 `metrics.test.js` 1 件 PASS（丸め・クランプ）。`check:api` / `check:api-schema` / `check:config-schema` すべて up to date。単体 66 ファイル中 64 PASS（`mcp`/`lsp` は環境要因） |

### 実装メモ

- HTTP のルート自体はこの環境では起動できないため未実測。レスポンスは純関数でテスト済みで、 web-server は `metricsSnapshot({uptime, sessions, rss})` を返すだけ。
- OTEL エクスポータは導入しない方針（ローカル用途に十分）。将来必要なら同じスナップショットを Prometheus 形式にする拡張点だけ用意できる。

### 次ラウンド

1. C4 UX の GUI（純関数＋配線に限定）。
2. C5: 単一バイナリ配布物、署名の運用手順。
3. protocol の承認通知を GUI に表示。

---

## ラウンド 44（2026-11-05）— CP-25 `turn/status`

### 完了

| WP | 内容 | 主な変更 | 検証 |
| :--- | :--- | :--- | :--- |
| **CP-25** | ターンの実行状態 | `protocol-turn.ts` に `turnStatusMethod(host)`（`{threadId}` → `{running}`、id 必須）。`hy protocol serve` は `turnControllers` の有無で判定 | 新規 `protocol-turn.test.js` 1 件 PASS（実行中/非実行・id 欠落）。**実測**: `turn/status {threadId:"run-1"}` → `{running:false}`、空 → `-32602 threadId is required`。単体 65 ファイル中 63 PASS（`mcp`/`lsp` は環境要因） |

### 実装メモ

- クライアントは `turn/start` の前に `turn/status` で実行中かを確認でき、二重開始を避けられる。
- プロトコルのターン制御は `start` / `cancel` / `steer` / `status` / `approval/respond` が揃った。

### 次ラウンド

1. C4 UX の GUI（純関数＋配線に限定）。
2. C5: OTEL メトリクス、単一バイナリ配布物。
3. protocol の承認通知を GUI に表示。

---

## ラウンド 43（2026-11-05）— CP-25 `turn/steer`

### 完了

| WP | 内容 | 主な変更 | 検証 |
| :--- | :--- | :--- | :--- |
| **CP-25** | 実行中ターンへの追加入力 | `protocol-turn.ts` に `turnSteerMethod(host)`（`{threadId, message}`、空は -32602、`host.steer` 無しは内部エラー、未実行スレッドは -32602）。`hy protocol serve` は会話の `steer()` に接続（inbox 経由で次のステップ境界に届く） | 新規 `protocol-turn.test.js` 1 件 PASS（成功・未知スレッド・message 欠落）。**実測**: `turn/steer {threadId:"nope"}` → `-32602 no running turn for thread nope`、`{threadId}` のみ → `-32602 message is required`。単体 65 ファイル中 63 PASS（`mcp`/`lsp` は環境要因） |

### 実装メモ

- 実行中でないスレッドへの steer は**キューに積まれる**（次のターンで届く）。`turn/start` と並行に送る想定で、ack は「受理した」の意味。
- プロトコルのターン制御は `start` / `cancel` / `steer` / `approval/respond` が揃った。残るは承認**要求**の GUI 表示と `thread/archive` などの管理系。

### 次ラウンド

1. C4 UX の GUI（純関数＋配線に限定）。
2. C5: OTEL メトリクス、単一バイナリ配布物。
3. protocol の承認通知を GUI に表示。

---

## ラウンド 42（2026-11-05）— CP-25 `turn/cancel`

### 完了

| WP | 内容 | 主な変更 | 検証 |
| :--- | :--- | :--- | :--- |
| **CP-25** | 実行中ターンの中断 | `protocol-turn.ts` に `turnCancelMethod(host)`（`{threadId}`、`host.cancel` 無しは内部エラー、実行中でなければ -32602）。`hy protocol serve` は run ごとに `AbortController` を持ち、`turn/start` の実行中に `turn/cancel` で `abort()`。完了時に controller を破棄 | 新規 `protocol-turn.test.js` 1 件 PASS（成功・未知・空 id・非オブジェクト）。**実測**: `turn/cancel {threadId:"nope"}` → `-32602 no running turn for thread nope`、空 → `-32602 threadId is required`。単体 65 ファイル中 63 PASS（`mcp`/`lsp` は環境要因） |

### 実装メモ

- `turn/start` は `Conversation.turn(message, images, signal)` に controller の signal を渡すので、キャンセルは既存の `AbortRunError` 経路に乗る（`stop` フックも発火する）。
- キャンセル後に同じスレッドへ再度 `turn/start` すると新しい controller で再開する（会話は Map に残る）。
- 実際のモデル呼び出しを伴うキャンセルはこの環境では未実測（exec server 起動が EPERM）。CI/実機で確認する。

### 次ラウンド

1. C4 UX の GUI（純関数＋配線に限定）。
2. C5: OTEL メトリクス、単一バイナリ配布物。
3. protocol の承認通知を GUI に表示。

---

## ラウンド 41（2026-11-05）— `hy doctor` にフィーチャーフラグ

### 完了

| WP | 内容 | 主な変更 | 検証 |
| :--- | :--- | :--- | :--- |
| **CP-39 / CP-38** | 診断に有効フラグを表示 | `buildDoctorReport` に `features` チェックを追加（`config.features` で ON のもの、無ければ `none`）。`ok` 固定（情報行） | `doctor.test.js` の検査順テストを更新して **PASS**。単体 65 ファイル中 63 PASS（`mcp`/`lsp` は環境要因）、`pnpm build` / `typecheck` 成功 |

### 実装メモ

- `features` は情報行なので `warn` にしない。実験的フラグを有効にしている利用者をサポートで即座に確認できる。
- これで CP-38（レジストリ・設定・CLI・診断）が揃った。

### 次ラウンド

1. C4 UX の GUI（ブラウザ検証が必要なため、純関数＋配線に限定）。
2. C5: OTEL メトリクス、単一バイナリ配布物。
3. protocol の承認通知を GUI に表示。

---

## ラウンド 40（2026-11-05）— CP-42 CI ゲートの補強

### 完了

| WP | 内容 | 主な変更 | 検証 |
| :--- | :--- | :--- | :--- |
| **CP-42** | CI に生成物ドリフトと整形の検査を追加 | `.github/workflows/ci.yml`: `cargo fmt --all -- --check` と、ビルド後の `check:api` / `check:api-schema` / `check:config-schema` を追加（従来は protocol 型のみ）。生成物が古いままマージされる経路を塞ぐ | ローカルで同じ 3 チェックが **up to date**。単体 65 ファイル中 63 PASS（`mcp`/`lsp` は環境要因）。`pnpm build` 成功 |

### 実装メモ

- CI の既存ジョブはクリーンビルド → clippy → protocol 型 → build → typecheck → カバレッジ → 統合テストの順。新しいチェックは build の後に置いた（`gen-api-schema` / `gen-api-types` が `dist` を読むため）。
- Windows 10 実機ジョブ（自己ホスト）は従来どおり任意（`ENABLE_WIN10_SELF_HOSTED`）。
- `pnpm verify`（ローカル一括）と CI のゲートがほぼ同じ内容になった。

### 次ラウンド

1. C4 UX の GUI 側（この環境ではブラウザ検証ができないため、純関数＋配線に限定）。
2. C5 残り（OTEL メトリクス、単一バイナリの配布物）。
3. protocol の `approvals` 通知を GUI で表示。

---

## ラウンド 39（2026-11-05）— CP-35 セッション fork

### 完了

| WP | 内容 | 主な変更 | 検証 |
| :--- | :--- | :--- | :--- |
| **CP-35**（一部） | run のフォーク | 新規 `packages/core/src/fork.ts`: `forkRun(logFile, fromRunId, toRunId, {upToTurn})`（run のイベントを `session/format` を除いて新 run に複製、`--turn n` で途中まで、元 run は不変、未知 run/同一 id はエラー）。CLI `hy fork <run-id> [--turn n]`（新しい run id を出力） | 新規 `fork.test.js` 2 件 PASS（全体コピー・途中まで・未知 id）。**実測**: シードした 1 ターンのログを `fork run-a --turn 1` で複製し、`[hy] forked 1 turn(s) / 3 event(s)` と新 run id、新 run のイベント列を確認。単体 65 ファイル中 63 PASS（`mcp`/`lsp` は環境要因） |

### 実装メモ

- フォークは「新しい run id でイベントを追記する」だけなので、既存の履歴再構築（runId でフィルタ）がそのまま動く。
- `session/format` はコピーしない（新 run では不要。ファイル単位のメタデータ）。
- 元 run のイベントは変更しない（`readEvents` → `append` の一方向）。
- **未実装**: GUI の fork ボタン（CP-35 の UI 部分）と、fork 時の `turn/undo` 正規化。

### 次ラウンド

1. C4 UX の残り（CP-32 スラッシュコマンド GUI、CP-33 差分/検索、CP-34 承認 UI）。
2. C5 残り（OTEL・署名・単一バイナリ）。
3. `hy fork` の GUI 露出。

---

## ラウンド 38（2026-11-05）— CP-19 フック配線の完結

### 完了

| WP | 内容 | 主な変更 | 検証 |
| :--- | :--- | :--- | :--- |
| **CP-19** | 残っていた配線 | `Conversation.reportSubagentStopped(agentId, status)` を追加し、GUI の `interrupt` / `close` エンドポイントから呼ぶ（`subagentStop` 発火）。GUI の**シャットダウン**で全セッションの `void conv.end()` を呼び、`sessionEnd` を発火 | `pnpm build` / `pnpm typecheck` 成功。既存 `hooks.test.js` の subagent / sessionEnd payload テスト PASS。単体 64 ファイル中 62 PASS（`mcp`/`lsp` は環境要因） |

### 実装メモ

- これで CP-19 の 11 イベント + `notify` が**全経路で発火**する（CLI / GUI / シャットダウン / interrupt）。
- `end()` はフラグで 1 回だけ。`reportSubagentStopped` は `void` で投げっぱなしにし、GUI 応答を遅らせない。
- GUI 経路のフックは HTTP を介するため E2E 未実測（この環境ではサーバーを起動できない）。CI/実機で確認する。

### 次ラウンド

1. C4 UX（CP-32〜36）。
2. C5 残り（OTEL・署名・単一バイナリ）。
3. `hy verify` の CI 配線。

---

## ラウンド 37（2026-11-05）— CP-19 `subagentStart` / `subagentStop`

### 完了

| WP | 内容 | 主な変更 | 検証 |
| :--- | :--- | :--- | :--- |
| **CP-19** | サブエージェントのライフサイクル | `Hooks` に `subagentStart` / `subagentStop` を追加。`backgroundDelegate` が spawn 後に `subagentStart({runId, agentId, task, readOnly})`、`closeAgent` が `subagentStop({runId, agentId, status})` を発火。設定スキーマにも追加 | 新規 `hooks.test.js` 1 件 PASS（両 payload）。単体 64 ファイル中 62 PASS（`mcp`/`lsp` は環境要因）。`check:config-schema` up to date、`pnpm build` / `typecheck` 成功 |

### 実装メモ

- `subagentStart` は `delegate { background: true }` とモデル向け `spawn_agent` の両方（同じ `backgroundDelegate`）で発火する。
- `subagentStop` は **close のみ**。GUI からの interrupt では発火しない（`agents.interrupt` 経路は Registry 側でフックを持たないため）。必要なら `SubagentRegistry` にコールバックを足す。
- これで CP-19 のフックは CP 計画の 11 種すべて + `notify` を実装した。残るは GUI シャットダウン時の `sessionEnd` と interrupt 時の `subagentStop` の配線のみ。

### 次ラウンド

1. C4 UX（CP-32〜36）。
2. C5 残り（OTEL・署名・単一バイナリ）。
3. GUI シャットダウン / interrupt フックの配線。

---

## ラウンド 36（2026-11-05）— CP-19 `sessionEnd` の配線

### 完了

| WP | 内容 | 主な変更 | 検証 |
| :--- | :--- | :--- | :--- |
| **CP-19** | `sessionEnd` フック | `Conversation.end()` を追加（1 回だけ発火、`{runId, turns}`）。CLI `hy run` / `hy review` の終了時、GUI のセッション削除（`DELETE /api/sessions/:id`）から呼ぶ。二重発火はフラグで防止 | 新規 `hooks.test.js` 1 件 PASS（payload が `{event:'sessionEnd', runId, turns}`）。単体 64 ファイル中 62 PASS（`mcp`/`lsp` は環境要因）。`pnpm build` / `pnpm typecheck` 成功 |

### 実装メモ

- `end()` は**非同期だが失敗しない**（`Hooks.each` が報告して握りつぶす）。CLI ではターン完了後に await、GUI では `void`（削除処理を遅らせない）。
- GUI の**シャットダウン経路**（プロセス終了時の一括 dispose）はまだ `end()` を呼んでいない。必要なら `web-server` の停止処理に追加する。
- これで CP-19 のイベントは `sessionStart` / `sessionEnd` / `userPromptSubmit` / `modelRequest` / `permissionRequest` / `preToolUse` / `postToolUse` / `preCompact` / `postCompact` / `stop` / `interrupt` / `turnEnd` + `notify` が出揃った（`subagentStart`/`subagentStop` は未実装）。

### 次ラウンド

1. C4 UX（CP-32〜36）。
2. C5 残り（OTEL・署名・単一バイナリ）。
3. `subagentStart` / `subagentStop` フック。

---

## ラウンド 35（2026-11-05）— CP-22 非同期コンパクション

### 完了

| WP | 内容 | 主な変更 | 検証 |
| :--- | :--- | :--- | :--- |
| **CP-22** | ターンを止めない要約 | `ContextManager.afterResponse?` を追加（Agent が各完了後に呼ぶ）。`SpillCompaction` は入力を超えていれば **Tier 2 の要約をバックグラウンドで生成**し、セグメントのプレフィックスハッシュでキャッシュ（最大 4 件、使ったら削除）。`beforeRequest` は同じキーのキャッシュや進行中の処理があればそれを使い、コンパクターを二重に呼ばない。要約プロンプトは `summaryMessages` に共通化 | 新規 `spill-compaction.test.js` 2 件 PASS（warm 生成 → 次リクエストで再利用し **calls=1 のまま** / compactor 無し・閾値未満は何もしない）。既存の Tier 1/2・失敗縮退・フックのテストも PASS。単体 64 ファイル中 62 PASS（`mcp`/`lsp` は環境要因） |

### 実装メモ

- キャッシュキーは「次に圧縮されるプレフィックス」に合わせる: 生成時は `keepRecentTurns - 1` 個を末尾から除いたセグメント、利用時は `keepRecentTurns` 個を除いたセグメント。次リクエストで 1 ペア増えても同じ範囲になる。
- `keepRecentTurns <= 1` では世代がずれるため暖機しない（同期経路のみ）。
- 失敗・タイムアウトは握りつぶし（`inflight` から削除）。次回の同期経路が通常どおり要約する。
- 要約プロンプトは同期経路と共通化したため、Tier 1 の spill を行わない分だけ入力量が増えるが、内容（各メッセージ 2,000 文字）は同じ。

### 次ラウンド

1. C4 UX（CP-32〜36）。
2. C5 残り（OTEL・署名・単一バイナリ）。
3. CP-25 の承認 UI / ステアリング通知。

---

## ラウンド 34（2026-11-05）— CP-25 スレッドモデルの修正と再開

### 訂正（重要）

ラウンド 31 は「スレッド = `stateDir/sessions/*.jsonl` の 1 ファイル」とモデル化していたが、これは**このコードベースでは誤り**。実際は 1 ワークスペースに `session.v1.jsonl` が 1 本あり、**run（runId）が会話**、ターンがその中に追記される。ラウンド 34 で run 単位に修正した。

### 完了

| WP | 内容 | 主な変更 | 検証 |
| :--- | :--- | :--- | :--- |
| **CP-25** | スレッド = run、再開対応 | `protocol-threads.ts` を `listThreads(logFile)` / `readThread(logFile, runId)` に変更（runId でグループ化、`turns` は user メッセージ数）。`hy protocol serve` は `sessionLogPath(config.stateDir)` を使う。`turn/start` の `threadId` で既存 run を再開（存在しない id は **exec server を起動する前に** -32602）、run ごとに `Conversation` をキャッシュ | `protocol-threads.test.js` を書き直して 2 件 PASS（run 分割・新しい順・items）。`protocol-turn.test.js` 1 件 PASS（`threadId` がホストへ渡り、空文字は -32602）。**実測**: `turn/start {threadId:"nope"}` → `-32602 unknown thread nope`、`thread/list` → `{threads:[]}`。単体 64 ファイル中 62 PASS（`mcp`/`lsp` は環境要因） |

### 実装メモ

- `listThreads` は `runId` の無いイベント（`session/format` など）を無視する。
- 再開は `Conversation.create(config, client, runId, …)` が共有ログから履歴を再構築する仕組みに乗る。同じ runId の会話は Map にキャッシュし、2 回目以降の turn は同じインスタンスを使う。
- 応答は並行処理のため**到着順が入れ替わりうる**（JSON-RPC は id で対応するので仕様どおり）。

### 次ラウンド

1. 非同期コンパクション（CP-22 の残り）。
2. C4 UX（CP-32〜36）。
3. C5 残り（OTEL・署名・単一バイナリ）。

---

## ラウンド 33（2026-11-05）— CP-25 承認のプロトコル化

### 完了

| WP | 内容 | 主な変更 | 検証 |
| :--- | :--- | :--- | :--- |
| **CP-25** | 承認の往復 | 新規 `packages/hy-cli/src/protocol-approvals.ts`: `ApprovalBridge`（`ask` が `approval/request` を通知して id を発行、`respond` が検証して解決、既定 5 分でタイムアウト拒否、`denyAll` で全解放）。`hy protocol serve` の `askUser` に接続し、`capabilities.approvals` を `true` に。**行の処理を並行化**（`turn/start` が承認応答を待つ間も `approval/respond` を読めるように） | 新規 `protocol-approvals.test.js` 3 件 PASS（往復・不正応答・タイムアウト/denyAll）。**実測**: `initialize` が `approvals:true`、未知名は -32602、`approved` 非 boolean は -32602。単体 64 ファイル中 62 PASS（`mcp`/`lsp` は環境要因。一度 `protocol-threads` が同時実行で落ちたが再実行で安定、ビルド完了前の走査が原因） |

### 実装メモ

- 承認は**通知 + 別リクエスト**で往復する。stdin の読み取りを直列に await すると `turn/start` が応答待ちの間 `approval/respond` を読めずデッドロックするため、行ごとに Promise を積んで並行に処理するよう変更した。
- タイムアウトは拒否（`approval/expired` を通知）。`denyAll` はサーバー終了時に未解決の承認をすべて拒否する。
- 実際のターン実行（モデル呼び出し）はこの環境では未実測。`approvals: true` を返すので、クライアントは `turn/start` 中に来る `approval/request` に応答できる。

### 次ラウンド

1. スレッド再開（会話ストア）。
2. 非同期コンパクション（CP-22 の残り）。
3. C4 UX / C5 残り。

---

## ラウンド 32（2026-11-05）— CP-25 `turn/start`

### 完了

| WP | 内容 | 主な変更 | 検証 |
| :--- | :--- | :--- | :--- |
| **CP-25** | プロトコルからの 1 ターン実行 | 新規 `packages/hy-cli/src/protocol-turn.ts`: `turnStartMethod(host, notify)`（`message` 必須、`threadId` は再開未対応として -32602、画像は配列で受け取り、agent イベントを `turn/event` 通知へ）。`hy protocol serve` が**遅延生成**の `Conversation` に接続し、`initialize` の `capabilities.turns` を `true` に変更。stdin EOF で exec client を停止 | 新規 `protocol-turn.test.js` 1 件 PASS（引数検証・イベント通知・結果・再開拒否）。**実測**: serve で `initialize` が `turns:true`、`turn/start {}` が -32602、`threadId` 付きが -32602。単体 63 ファイル中 61 PASS（`mcp`/`lsp` は環境要因） |

### 実装メモ

- 実際の 1 ターン（モデル呼び出し・exec server）はこの環境では子プロセス禁止のため未実測。CI/実機で `turn/start {"message":"…"}` を実行して確認する。
- スレッドは**新規作成のみ**（`Conversation.create` は新しいセッションログを作る）。既存スレッドへの再開は会話ストアの実装が必要なので、明示的に拒否している。
- `turn/event` は JSON-RPC 通知なので、クライアントは id なしで受け取る。承認要求はまだ通知しない（`capabilities.approvals: false`）。

### 次ラウンド

1. スレッド再開（会話ストア）と承認のプロトコル化。
2. 非同期コンパクション（CP-22 の残り）。
3. C4 UX / C5 残り。

---

## ラウンド 31（2026-11-05・再開後）— CP-25（thread の読み取りと `hy protocol serve`）

### 完了

| WP | 内容 | 主な変更 | 検証 |
| :--- | :--- | :--- | :--- |
| **CP-25** | thread/list・thread/read と stdio サーバー | 新規 `packages/hy-cli/src/protocol-threads.ts`: セッションログ（`<stateDir>/sessions/*.jsonl`）から `listThreads`（新しい順・タイトル・runs・events）と `readThread`（user / assistant / tool / error の項目、未知は `-32602`）。`hy protocol serve` が stdin の JSON-RPC を読み、`initialize` / `thread/list` / `thread/read` に応答（`notify` でサーバー通知も送れる） | 新規 `protocol-threads.test.js` 2 件 PASS。**実測**: 3 リクエストをパイプし、initialize の capabilities、`threads: []`、未知スレッドの `-32602` を確認。単体 62 ファイル中 60 PASS（`mcp`/`lsp` は環境要因） |

### 実装メモ

- 読み取り専用から始めた。`capabilities.turns` は `false` で、`turn/start` はまだ生えていない（クライアントは capability で判断できる）。
- スレッド ID はセッションログ先頭イベントの `sessionId`。ファイルは `stateDir/sessions` を走査する。
- タイトルは最初の `user/message` の 1 行目（最大 80 文字）。無ければファイル名。
- `hy protocol schema`（HTTP API）と `hy protocol serve`（JSON-RPC）を同じコマンドに同居させた。

### 次ラウンド

1. `turn/start`（Conversation へのアダプタ）と承認・ステアリングのプロトコル化。
2. 非同期コンパクション（CP-22 の残り）。
3. C4 UX / C5 残り（OTEL・署名・単一バイナリ）。

---

## ラウンド 30（2026-11-05）— 総括（未完了・継続）

### 最終検証（この環境で取得できた証拠）

| ゲート | 結果 |
| :--- | :--- |
| `pnpm build` / `pnpm typecheck` | 成功 |
| 単体テスト走査 | **61 ファイル中 59 PASS**。失敗は `mcp.test.js` / `lsp.test.js` のみ（DSH サンドボックスが子プロセスのパイプを禁止する環境要因。CI/実機では実行対象） |
| `check:api-schema` / `check:config-schema` / protocol 型チェック | すべて up to date |
| `cargo test -p hy-exec-server` | **33 passed** |
| `cargo test -p hy-sandbox-windows` | **13 passed / 1 failed**（`token::tests::constructs_tokens_for_standard_user_and_admin_member_identities` のみ。`CreateRestrictedToken` がこの環境で ERROR_INVALID_PARAMETER 87 を返す既知の環境要因） |
| `node scripts/verify-all.mjs --list` | 69 ステップ（8 ゲート + 61 テスト）を列挙 |

### 完了した範囲

- **C0 封じ込め**: denyRead / readOnly / 承認ポリシー / denial 分類 / 軽減ポリシー / DPAPI / Guardian レビュー（CP-01/02/05/06/07/08/44）。
- **C1 道具箱**: write_stdin（PTY なし）/ tool_search / MCP HTTP・resources / ユーティリティ / スナップショット / 検索直接化 / サブエージェント制御 / ワークツリー / メディア予算（CP-09/10/11/12/13/14/15/16/17）。
- **C2 ループ**: ストリーミング（OpenAI 互換）/ フック 11 種 / memories / skills 選択 / コンパクション縮退 / トークン計測（CP-18/19/20/21/22/23）。
- **C3 の一部**: API スキーマとバージョン（CP-26）、HY Protocol v1 の**メッセージ層のみ**（CP-25）。
- **C5 の一部**: `hy doctor`（CP-39）、フィーチャーフラグと CLI（CP-38）、`pnpm verify`（CP-42）。

### 未完了（次回以降）

1. **C3 本体**: CP-25 の thread/turn 実データ接続と `hy serve --protocol`、CP-27 WebSocket、CP-28 exec-server WS、CP-29 設定 API、CP-30 SDK/ACP、CP-31 Codex からの移行。
2. **C4 UX**: CP-32〜36（スラッシュコマンドの GUI、subagent パネル、scratchpad、セッション UI ほか）。
3. **C5 残り**: OTEL メトリクス、署名・公証、単一バイナリ、`verify` の CI 配線。
4. **C2 残り**: 非同期コンパクション、`sessionEnd` / `subagentStart` / `subagentStop` フック、`@skill:` メンション、`tool-search` フラグの消費。

### ゴールの状態

計画の全 WP は完了していないため、**ゴールは未達のまま継続**する。難易度・残量はブロック要因ではないので blocked にはしない。

---

## ラウンド 29（2026-11-05）— CP-42（一括検証）

### 完了

| WP | 内容 | 主な変更 | 検証 |
| :--- | :--- | :--- | :--- |
| **CP-42**（一部） | QA ゲートの一本化 | 新規 `scripts/verify-all.mjs`: **クリーンビルド**（`tsc -b --force`、増分ビルドで隠れたエラーを検出）→ `typecheck` → `check:api` / `check:api-schema` / `check:config-schema` / protocol 型チェック → `cargo test`（sandbox / exec-server）→ 単体テスト走査、を順に実行。子プロセス必須の `mcp`/`lsp` は環境依存として skip 表示（CI は実機で実行）。`pnpm verify` / `pnpm verify:list` を追加 | `node scripts/verify-all.mjs --list` で **69 ステップ**（8 ゲート + 61 テスト）の列挙を確認。この環境では Node からの子プロセス生成が EPERM のため本体は CI/実機で実行（既知の制約） |

### 実装メモ

- 単体テストの一覧は `packages/*/dist/**/*.test.js` を走査して作るので、新しいテストを足すと自動でゲートに入る。
- `--list` は副作用なしで、CI のデバッグや「何が走るか」の確認に使える。
- この環境で実行できない理由（DSH サンドボックスが子プロセスのパイプを禁止）は既知で、`verify` は CI/実機向けと明記。

### 残り（最終ラウンドに記録）

1. 非同期コンパクション（CP-22 の残り）。
2. CP-25 の thread/turn 接続・`hy serve --protocol`・WS（CP-27）・SDK/ACP（CP-30/31）。
3. C4 UX（CP-32〜36）と C5 の残り（OTEL メトリクス・署名・単一バイナリ）。

---

## ラウンド 28（2026-11-05）— CP-19 の残り（stop / interrupt）

### 完了

| WP | 内容 | 主な変更 | 検証 |
| :--- | :--- | :--- | :--- |
| **CP-19** | 中断系フック | `Hooks` に `stop` / `interrupt` を追加。`Conversation.turn` の `finally` で `signal.aborted` なら `stop`、`catch` で `interrupt`（理由付き）を発火。設定スキーマに 2 イベント追加 | 新規 `hooks.test.js` 1 件 PASS（payload の `event` / `turn` / `reason`、`empty` の更新）。単体 61 ファイル中 59 PASS（`mcp`/`lsp` は環境要因）。`check:config-schema` up to date |

### 実装メモ

- `stop` は**ユーザーによる停止**（`AbortSignal`）、`interrupt` は**例外による中断**として区別する。どちらも応答を待たない（`void`）ので、ターンの終了を遅らせない。
- フックの失敗は既存の `each` が報告して握りつぶす（ターンは止めない）。
- **未配線**: `sessionEnd`（メソッドはあるが、GUI のセッション終了・CLI 終了時の呼び出しが未実装）、`subagentStart` / `subagentStop`、`sessionStart` の GUI 側。

### 次ラウンド

1. CP-42 QA（`tsc -b --force` を含む一括検証）。
2. 非同期コンパクション（CP-22 の残り）。
3. CP-25 の thread/turn 接続。

---

## ラウンド 27（2026-11-05）— CP-37（設定レイヤ）

### 完了

| WP | 内容 | 主な変更 | 検証 |
| :--- | :--- | :--- | :--- |
| **CP-37** | 設定の重ね合わせと可視化 | `config.ts` に `configPaths(workspaceRoot, stateDir)` を追加し、`hy config paths [--json]` で**各レイヤの実パス**（user / project / skills / state / spill / worktrees / sessions）を表示。`--profile <name>` は既存の `applyProfile`（ユーザー設定の `profiles` を深くマージ、未知の名前はエラー）で動作することをテストで固定 | 新規 `config.test.js` 2 件 PASS（プロファイルのマージと provider 継承・未知プロファイルのエラー / レイヤパス）。実測 `hy config paths --cwd .` で全パスを確認。単体 61 ファイル中 59 PASS（`mcp`/`lsp` は環境要因） |

### 実装メモ

- 解決順を明文化: **既定 → ユーザー設定（+ profile）→ 信頼済みプロジェクト → CLI フラグ → バンドル**。プロジェクト設定は信頼済みのときだけ読む（既存方針）。
- `profiles` はユーザー設定のトップレベルに置き、`--profile dev` で深くマージする。配列は置換（マージしない）、`undefined` は元の値を残す。
- `hy config dump` は解決済みの値を出し、`paths` は「どこから来るか」を出す、という役割分担。

### 次ラウンド

1. 非同期コンパクション（CP-22 の残り）。
2. CP-25 の thread/turn 接続。
3. CP-42 QA（`tsc -b --force` を含む検証スクリプト）。

---

## ラウンド 26（2026-11-05）— CP-38 の仕上げ（`hy features`）

### 完了

| WP | 内容 | 主な変更 | 検証 |
| :--- | :--- | :--- | :--- |
| **CP-38** | フラグの CLI 管理 | `hy features [list|enable <name>|disable <name>] [--json]`。`list` は解決済みの on/off と成熟度・説明を表示。`enable`/`disable` は `writeUserConfig` でユーザー設定の `features` だけを更新（他の設定を保持）、未知の名前はエラー終了 2 | 一時 `HY_CONFIG_DIR` で実測: `list --json` が既定値を表示 → `features disable streaming` が保存 → `list` が `off streaming` を表示。単体 61 ファイル中 59 PASS（`mcp`/`lsp` は環境要因） |

### 実装メモ

- 保存はユーザー設定のみ（プロジェクト設定からの上書きは不可、CP-38 の方針どおり）。
- `assertFeatureName` で typo を拒否するので、`enable streamng` のような指定は**何もせず失敗**する。
- これで CP-38 の範囲（レジストリ・設定・実効フラグ・CLI）は完了。

### 次ラウンド

1. CP-25 の thread/turn 実データ接続と `hy serve --protocol`。
2. 非同期コンパクション（CP-22 の残り）。
3. CP-37 設定レイヤ（profile / マージ順）。

---

## ラウンド 25（2026-11-05）— CP-25（HY Protocol v1 のメッセージ層）

### 完了

| WP | 内容 | 主な変更 | 検証 |
| :--- | :--- | :--- | :--- |
| **CP-25**（土台） | JSON-RPC 2.0 メッセージ層 | 新規 `packages/hy-cli/src/protocol.ts`: `PROTOCOL_VERSION = 'hy-protocol/1'`、`parseRequest`（エラーコード -32700 / -32600）、`ProtocolServer.handle`（-32601 / -32602 / -32603、通知は応答せずログのみ）、`initializeHandler`（バージョンと capabilities の交渉）、`ProtocolRpcError`、`send`（サーバー起点通知） | 新規 `protocol.test.js` **4 件 PASS**（initialize の交渉・thread/turn の応答と invalidParams・フレーミングエラー・通知の無応答とログ） |

### 実装メモ

- トランスポート（stdio / WebSocket）と thread/turn の実装は分離した。`ProtocolServer` は 1 行入力 → 最大 1 行出力の純粋なディスパッチャで、`hy-cli` から直接テストできる。
- 通知の失敗はレスポンスにせず `log` に流す（JSON-RPC の仕様どおり）。
- **未実装**: thread/list・thread/read・turn/start の実データ接続、`hy serve --protocol`、WebSocket トランスポート（CP-27）、SDK のプロトコルクライアント（CP-30）。

### 次ラウンド

1. プロトコルの thread/turn 接続（SessionIndex / Conversation へのアダプタ）と `hy serve --protocol`。
2. 非同期コンパクション（CP-22 の残り）。
3. CP-37 設定レイヤ（profile / マージ順）。

---

## ラウンド 24（2026-11-05）— CP-38（フィーチャーフラグ）

### 完了

| WP | 内容 | 主な変更 | 検証 |
| :--- | :--- | :--- | :--- |
| **CP-38**（一部） | 機能フラグ | 新規 `packages/core/src/features.ts`: `FEATURES`（`streaming` / `tool-search` / `doctor-json`、成熟度と既定値）、`resolveFeatures` / `featureEnabled` / `assertFeatureName`。`config.features` で上書き（未知の名前は無視、書き込み側は `assertFeatureName` で拒否）。`Agent` の `features.streaming = false` で delta を送らない | 新規 `features.test.js` 2 件、`agent.test.js` 1 件（streaming off で onDelta が渡らない・既定は渡る）、`config.test.js` 1 件（user 設定から解決）PASS。単体 60 ファイル中 58 PASS（`mcp`/`lsp` は環境要因）。`check:config-schema` / `check:api-schema` up to date |

### 実装メモ

- 既定は stable=ON、experimental=OFF（`defaultOn`）。上書きはユーザー設定の `features` のみ（プロジェクト設定からは変更できない）。
- `tool-search` フラグは登録のみで、まだプロンプト側の消費は未配線（次回 `promptExtras` に渡す）。
- CLI `hy features list|enable|disable` は未実装（`writeUserConfig` を使えば追加できる）。

### 次ラウンド

1. CP-25 HY Protocol v1 の最小実装（JSON-RPC 2.0 + thread/read）。
2. `tool-search` フラグの消費と CLI `hy features`。
3. 非同期コンパクション。

---

## ラウンド 23（2026-11-05）— CP-39（`hy doctor`）

### 完了

| WP | 内容 | 主な変更 | 検証 |
| :--- | :--- | :--- | :--- |
| **CP-39**（一部） | 環境診断コマンド | 新規 `packages/hy-cli/src/doctor.ts`: `buildDoctorReport`（node / workspace / config / exec-server / sandbox（enforcement・gaps・denyRead・readOnly）/ role の認証情報 / MCP / hy-secret / update-feed を `ok`・`warn`・`fail` で評価）と `roleHasCredentials`。CLI `hy doctor [--json]`（exec-server に届かない場合は sandbox を warn として続行） | 新規 `doctor.test.js` 2 件 PASS（正常系の検査順・欠落で fail/warn、keyless provider と env/リテラルキー）。`hy doctor --json --cwd .` の実測で JSON を確認。単体 59 ファイル中 57 PASS（`mcp`/`lsp` は環境要因） |

### 実装メモ

- レポートは**注入した事実**から組み立てる純関数。CLI が exec-server・config・パスを渡すため、テストでプロセスを起動せずに検証できる。
- sandbox が取得できない場合は `warn`（`fail` にしない）。ワークスペースや exec-server の不在は `fail` にして終了コード 1。
- 検査項目: `node`, `workspace`, `config`, `exec-server`, `sandbox`, `denyRead`, `readOnly`, `role:worker/grader/compactor`, `mcp`, `hy-secret`, `update-feed`。

### 次ラウンド

1. CP-25 HY Protocol v1（thread / turn / item）。
2. 非同期コンパクション（CP-22 の残り）。
3. CP-38 フィーチャーフラグ / CP-37 設定レイヤ。

---

## ラウンド 22（2026-11-05）— CP-26（API スキーマ、C3 開始）

### 完了

| WP | 内容 | 主な変更 | 検証 |
| :--- | :--- | :--- | :--- |
| **CP-26** | API のスキーマ生成とバージョン | 新規 `packages/hy-cli/src/api-schema.ts`: `API_VERSION = 'hy-api/1'`、`fieldSchema` / `buildApiSchema` / `renderApiSchema`（draft 2020-12、画像フィールドは `{mimeType,data}` の配列）。`scripts/gen-api-schema.mjs` が `docs/api.schema.json` を生成し `--check` でドリフト検出。`/api/health` に `apiVersion`。CLI `hy protocol schema` で出力。`package.json` に `gen:api-schema` / `check:api-schema` | 新規 `api-schema.test.js` **3 件 PASS**（全ルート被覆・重複なし・summary・バージョン形式・画像スキーマ・決定的 JSON）。単体 58 ファイル中 56 PASS（`mcp`/`lsp` は環境要因）。`check:api` / `check:api-schema` / `check:config-schema` すべて up to date |

### 実装メモ

- 既存の `api.gen.ts`（クライアント用 TS 型）と並び、**言語非依存の JSON Schema** を追加した。第三者は `docs/api.schema.json` だけでリクエストを検証できる。
- バージョンは破壊的変更でのみ更新する（`hy-api/1`）。`/api/health` とスキーマ文書の両方に出る。
- レスポンスは型名（`HealthResponse` 等）のみで、形は TS 側が正。JSON Schema はリクエスト側を厳密に表現する方針。

### 次ラウンド

1. **CP-25 HY Protocol v1**（thread / turn / item、承認、ステアリングのステートフル JSON-RPC）。
2. CP-27 トランスポート（stdio / WS）と daemon。
3. 非同期コンパクション（CP-22 の残り）。

---

## ラウンド 21（2026-11-05）— CP-23（トークン計測）

### 完了

| WP | 内容 | 主な変更 | 検証 |
| :--- | :--- | :--- | :--- |
| **CP-23** | 推定と実測の記録・補正 | `Agent` が各ステップで `token/estimate`（`estimated` / `actual` / `ratio`）をセッションログに記録。`tokens.ts` に `calibratedCoefficients(samples, base)`（実測比で係数を補正、0.5〜2 倍にクランプ）を追加。`prompt_cache_key` は既に CP-23 で送信済み | 新規 `tokens.test.js` 2 件 PASS（係数・クランプ・NaN/0 の無視）、`agent.test.js` 1 件 PASS（estimated > 0・actual 500・ratio の一致）。単体 57 ファイル中 55 PASS（`mcp`/`lsp` は環境要因） |

### 実装メモ

- 記録は**ログだけ**で、自動的に係数を書き換えることはしない（誤差の傾向を見てから手動で係数・モデル設定を直す）。`calibratedCoefficients` はその判断材料を返す純関数。
- 推定値は「メッセージ本文の合計」を係数で換算したもの。ツール定義や画像は含まないため、実測との差は主にそこから出る（ratio で分かる）。
- これで CP-23 の範囲（キャッシュキー・推定記録・補正・モデル別パラメータ）は完了。

### 次ラウンド

1. **C3 開始**: CP-25 HY Protocol v1（thread / turn / item、承認、ステアリング）。
2. CP-26 スキーマ生成と適合テスト。
3. 非同期コンパクション（CP-22 の残り）。

---

## ラウンド 20（2026-11-05）— CP-22（コンパクション強化）

### 完了

| WP | 内容 | 主な変更 | 検証 |
| :--- | :--- | :--- | :--- |
| **CP-22** | 要約失敗時の縮退と compact フック | `SpillCompaction`: Tier 2 のコンパクターが失敗したら **Tier 1 の結果を返してターンを継続**（`compaction/failed` をログ）。`preCompact` / `postCompact` フックを追加（pairs / tokens / summarized）。`Hooks` に `preCompact` / `postCompact` を追加し、`sessionContext` → `SpillCompaction` へ配線。設定スキーマ更新 | 新規 `spill-compaction.test.js` 2 件 PASS（失敗時: summary なし・`compaction/failed`・hooks が `pre:6`/`post:false`、成功時: `<session_summary>` と `post:true`）。単体 56 ファイル中 54 PASS（`mcp`/`lsp` は環境要因）。生成物チェック up to date |

### 実装メモ

- 失敗時の扱いを「ターンを落とす」から「Tier 1 で継続し、理由を記録」に変更。要約が壊れてもセッションは止まらない。
- `postCompact` は成功・失敗の両方で呼ばれ、`summarized` で区別できる（監査・通知向け）。
- メディア予算は CP-17 で実装済み（画像の間引き）。
- **未実装**: 非同期コンパクション（ターンを止めない背後実行）。`ContextManager` に `afterResponse` を足す設計が必要なため、次回以降の課題として記録。

### 次ラウンド

1. CP-23 トークン計測の精緻化（推定誤差の記録・補正）。
2. 非同期コンパクション（CP-22 の残り）。
3. C3 へ（HY Protocol v1）。

---

## ラウンド 19（2026-11-05）— CP-21（スキルの選択）

### 完了

| WP | 内容 | 主な変更 | 検証 |
| :--- | :--- | :--- | :--- |
| **CP-21** | スキルの順位付けと使用統計 | `skills.ts` に `rankSkills(skills, query, { usage, limit })`（名前の語一致 +10、説明の語 +1、名前の部分一致 +3、使用回数を小数で加算。**3 文字未満の名前は語一致の対象外**）と `SkillUsageStore`（`<stateDir>/skill-usage.json`、壊れたファイルは空扱い、原子的書き込み）。`ToolRuntime.onSkillLoad` を追加し、`skill_load` 成功時に回数を記録。セッションはカタログを**使用回数順**で構築 | 新規 `skills.test.js` 2 件 PASS（順位付け・使用回数のタイブレーク・limit / 永続化・ソート・破損ファイル）。単体 56 ファイル中 54 PASS（`mcp`/`lsp` は環境要因）。`pnpm build` / `typecheck` / 生成物チェック OK |

### 実装メモ

- 順位付けは**プロンプトのカタログ順**にだけ使う（スキル本文は従来どおり `skill_load` で取得）。40 件上限と 1 行説明は維持。
- 使用回数は 0.1 倍で加点するため、名前・説明の一致を追い越さない（よく使うだけのスキルが無関係な要求で先頭に来ない）。
- テストで見つかった不具合: 1 文字のスキル名が本文中の文字（例: "relevant" の "a"）に一致して +10 されていた。**3 文字未満は名前一致の対象外**にして修正。
- `@skill:` メンションは未実装（GUI の `@` 候補はファイル / セッションのみ）。次回の UX ラウンドで追加する。

### 次ラウンド

1. CP-22 コンパクション強化（非同期・ツール出力保持・メディア）。
2. CP-19 の残り（compact/stop/subagent フック）。
3. CP-23 トークン計測の精緻化。

---

## ラウンド 18（2026-11-05）— CP-20（memories パイプライン）

### 完了

| WP | 内容 | 主な変更 | 検証 |
| :--- | :--- | :--- | :--- |
| **CP-20** | セッションからの自動メモリ | 新規 `packages/core/src/memory-pipeline.ts`: `parseMemoryCandidates`（厳密 JSON・キー検証・最大 5 件）、`MemoryPipeline.run(digest)`（summarizer ロール 1 回、JSON モード、6,000 文字上限）、`MemoryStore.upsert`（キー単位の置換、run id と evidence を保存、上限で **skipped を報告**・黙って捨てない）。設定 `memory.auto`、`HarnessConfig.memoryAuto`。ターン終了後に best-effort で実行 | 新規 `memory-pipeline.test.js` **3 件 PASS**（厳密パース・統合と重複排除・満杯時の skipped/error・provider 失敗で無変更）。`config.test.js` 1 件追加（`memory.auto` の解決）PASS。単体 56 ファイル中 54 PASS（`mcp`/`lsp` は環境要因）。生成物チェック up to date |

### 実装メモ

- 抽出は **summarizer ロール**（既定はワーカーと同じ）。1 ターンにつき 1 回・最大 400 出力トークン・JSON モード。
- 入力は「目的・最終回答・使ったツール・触れたファイル・run id」を 6,000 文字に切って渡す。セッション本文をそのまま入れない（プロンプト注入とトークン対策）。
- ノートは `key` 単位で置換。`source`（run id）と `evidence`（短い引用）を保存し、GUI/CLI から由来が分かる。
- 上限（20 件 / 約 2,000 トークン）に達した場合、**新規キーは skipped** として返し、呼び出し側はログに出す。既存キーの更新は許可。
- 失敗（provider エラー・JSON 破損）はストアを変更しない。
- 既知の制約: 読み取り専用セッションでも抽出は走る（ストアはユーザー状態のみ）。`files` は未収集（空配列）。

### 次ラウンド

1. CP-21 skills の選択・推薦。
2. CP-22 コンパクション強化（非同期・ツール出力保持・メディア）。
3. CP-19 の残り（compact/stop/subagent フック）。

---

## ラウンド 17（2026-11-05）— CP-19（フック）

### 完了

| WP | 内容 | 主な変更 | 検証 |
| :--- | :--- | :--- | :--- |
| **CP-19** | ライフサイクルフック | `hooks.ts` を 9 イベントに拡張（`sessionStart` / `sessionEnd` / `userPromptSubmit` / `modelRequest` / `permissionRequest` / `preToolUse` / `postToolUse` / `turnEnd` / `notify`）。`HookRunner` を注入可能にし、ブロック（exit 2）・文脈（stdout）・情報通知の意味をテスト可能にした。`Agent` が `userPromptSubmit`（ブロック → `AbortRunError`、stdout → `<untrusted_hook_context>`）と `modelRequest`（各ステップ前）を実行。`createApprover` が `permissionRequest` を**最優先**で評価（自動承認より前に拒否）。CLI/GUI のセッションで `sessionStart` を発火。設定スキーマに 5 イベントを追加 | 新規 `hooks.test.js` **5 件 PASS**（ブロック・文脈・権限拒否・イベント payload・tools フィルタ・empty）。`agent.test.js` 1 件 PASS（文脈がプロンプトに入る／ブロックでターン終了）。単体 55 ファイル中 53 PASS（`mcp`/`lsp` は環境要因）。生成物チェック up to date |

### 実装メモ

- `permissionRequest` は **`--yes` / `--full-auto` / 承認ポリシーより先**に評価する。フックの拒否が自動承認で上書きされない。
- `userPromptSubmit` の stdout は `<untrusted_hook_context>` で囲み、指示ではなくデータとして渡す（プロンプトインジェクション対策）。
- フックは従来どおり**ユーザー設定または信頼済みプロジェクト**のみ。実行は unconfined・ユーザー権限。
- 未実装: `sessionEnd` の GUI 側発火、`preCompact`/`postCompact`、`stop`/`interrupt`、`subagentStart`/`subagentStop`。CP-19 の残りとして次回以降に追加。

### 次ラウンド

1. CP-20 memories パイプライン（抽出→統合→注入、引用付き）。
2. CP-19 の残り（sessionEnd / compact / stop / subagent フック）。
3. CP-21 skills の選択・推薦。

---

## ラウンド 16（2026-11-05）— CP-18（ストリーミング）

### 完了

| WP | 内容 | 主な変更 | 検証 |
| :--- | :--- | :--- | :--- |
| **CP-18** | モデル出力のトークンストリーミング | `CompleteOptions.onDelta`、`OpenAiProvider.completeStreaming`（`stream: true` + `stream_options.include_usage`、`data:` 行の解析、content / reasoning / tool_calls の増分組み立て、最終 usage、600 秒で abort）。`Agent` が delta を `assistant-delta` イベントに変換。`chat-projection` が draft エントリを伸ばし、確定メッセージで置き換える | 新規 `llm.test.js` 1 件（**in-process SSE サーバー**で content / reasoning / tool_calls / usage / delta 配列を検証）、`chat-projection.test.js` 1 件、`agent.test.js` 1 件（delta → イベント）PASS |

### 実装メモ

- 対応は **OpenAI 互換アダプタ**（OpenAI / DeepSeek / OpenCode / openai-compatible）のみ。Anthropic / Gemini / Responses は非ストリーミング（従来どおり）。
- ストリーミング経路は `postWithRetry` を通らないため、**429/5xx の自動再試行は無い**。エラーは `LlmError` として返り、エージェント側の壊れたツール呼び出しリトライだけが効く。次回、ストリーム用の再試行（開始前のみ）を追加する余地あり。
- `assistant-delta` はセッションログに残さない（最終 `assistant/message` だけを記録）。GUI は draft を表示し、確定メッセージが来たら置き換えるので二重表示にならない。
- `stream_options.include_usage` を送るため、usage は最終チャンクで得られる（プロバイダによっては 0 のまま＝従来の「推定値で補正」経路）。

### 次ラウンド

1. CP-19 フック 11 種（sessionStart/End、userPromptSubmit、pre/postCompact、permissionRequest、stop、interrupt、modelRequest、subagentStart/Stop）。
2. CP-20 memories パイプライン。

---

## ラウンド 15（2026-11-05）— CP-16（ワークツリー）で C1 完了

### 完了

| WP | 内容 | 主な変更 | 検証 |
| :--- | :--- | :--- | :--- |
| **CP-16** | git worktree 分離 | 新規 `packages/core/src/worktree.ts`: `parseWorktreeList`（porcelain）、`sanitizeWorktreeName`、`WorktreeManager`（`isRepo` / `list` / `create` / `remove` / `apply`）。CLI `hy worktree list|create <name>|apply <name>|remove <name> [--base] [--force] [--no-3way]`。worktree は `<stateDir>/worktrees/<name>`（リポジトリ外）、ブランチ `hy/<name>`。`apply` は `git add -A` → `git diff --cached --binary` → `git apply --3way`、衝突はファイル名を返す | 新規 `worktree.test.js` 2 件 PASS（porcelain 解析・名前の無害化）。CLI 実測で非 git ディレクトリでは「not a git repository」を返すことを確認。CI/実機用 `tests/integration/worktree.test.mjs`（作成 → 編集 → apply → 本体に反映 → remove）を追加。既存 54 ファイル中 52 PASS（`mcp`/`lsp` は環境要因） |

### C1（道具箱）の完了状況

| WP | 状態 |
| :--- | :--- |
| CP-09 write_stdin / unified exec | ✅（PTY なし） |
| CP-10 tool_search・K9 再定義 | ✅ |
| CP-11 MCP HTTP/SSE・resources | ✅（prompts/elicitation なし） |
| CP-12 ユーティリティ | ✅ |
| CP-13 セッションスナップショット | ✅ |
| CP-14 検索ツール直接化 | ✅ |
| CP-15 サブエージェント制御 | ✅ |
| CP-16 ワークツリー | ✅ |
| CP-17 メディア予算 | ✅ |

**C1 完了**（計画のスコープ内）。次は C2（ループとコンテキスト）。

### 次ラウンド

1. **CP-18 ストリーミング**（SSE の delta、途中表示、Stop の即時性）。
2. CP-19 フック 11 種、CP-20 memories パイプライン。

---

## ラウンド 14（2026-11-05）— CP-11（MCP 拡張）

### 完了

| WP | 内容 | 主な変更 | 検証 |
| :--- | :--- | :--- | :--- |
| **CP-11** | MCP の HTTP/SSE と resources | `mcp.ts`: `McpServerConfig.url` / `headers`、`McpTransport` インターフェース、**`McpHttpClient`**（POST + JSON または SSE 応答、`mcp-session-id`、`initialize` / `notifications/initialized`、タイムアウト）、stdio 側にも `listResources` / `readResource`、`McpManager` に `resources()` / `readResource()`。ツール `list_mcp_resources` / `read_mcp_resource`（deferred、`requires: 'mcp'`） | 新規 `mcp.test.js` の CP-11 2 件 PASS（**in-process HTTP サーバー**で tools/list・tools/call・resources/list・SSE の resources/read・セッション通知を検証、HTTP 500 はエラーとして報告され致命でない）。既存の stdio テスト 2 件は子プロセス起動が EPERM のためこの環境では失敗（従来どおり環境要因） |

### 実装メモ

- HTTP 応答は `application/json` と `text/event-stream` の両方に対応。SSE は `data:` 行を JSON として読み、id が一致した時点で reader を cancel する（通知だけを流し続けるサーバーでも停止する）。
- `initialize` の応答が 2xx でない場合はサーバー起動失敗として `errors` に積む（1 台の失敗で他は止めない）。
- resources の列挙はサーバーごとに独立して失敗を許容（`resources()` が `{ resources, errors }` を返す）。
- prompts / elicitation / OAuth は未実装（進捗 doc の残り）。
- 読み取りは 100,000 文字で切り詰め、`truncated` を返す。

### 次ラウンド

1. CP-16 ワークツリー分離（git worktree + スコープ）。
2. C2: ストリーミング（CP-18）、フック拡張（CP-19）、memories（CP-20）。

---

## ラウンド 13（2026-11-05）— CP-13 / CP-17

### 完了

| WP | 内容 | 主な変更 | 検証 |
| :--- | :--- | :--- | :--- |
| **CP-13** | セッションのスナップショット | `agent.ts` が各ターン開始時に `session/snapshot`（cwd・workspaceRoot・provider）を記録。cwd は既存の `restoreCwd` で再開時に復元される | 新規 `agent.test.js` の CP-13 1 件 PASS |
| **CP-17** | 画像のメディア予算 | `packages/seams/src/spill-compaction.ts` に `pruneImages()`（直近 `keepRecentTurns` 件の画像付きメッセージだけ残し、古い添付は「画像 N 枚を削除」の注記に置換）。`beforeRequest` の**先頭**で実行するので、コンパクションのトリガー未満でも効く | 新規 `spill-compaction.test.js` の CP-17 2 件 PASS（古い画像だけ削除・最近は保持・トリガー前でも実行）。既存の Tier 1/2 テストも PASS |

### 実装メモ

- 画像はトークン費用が大きいため、**トークン閾値と無関係に**毎リクエスト間引く。削除した添付は `read_image` で読み直せる旨を本文に残す。
- `pruneImages` は純関数としてエクスポートし、ユニットテストで境界（keep=2、画像メッセージ 3 件）を確認。
- CP-13 は「記録・復元」のうち、環境変数と PowerShell プロファイルの記録までは行わない（環境は許可リストで決定的、プロファイルはサーバー側で固定）。必要になったら `session/snapshot` に項目を足す。
- **発見**: `packages/core/src/agent.test.ts` が import 欠落のまま dist に残っており、インクリメンタルビルドが差分を検出するまで露見しなかった。import（`fs`/`os`/`path`/`Agent`/`SessionLog`/`ToolRuntime`）を補って解消。CI では `tsc -b --force` 相当を回すべき。

### 次ラウンド

1. CP-11 MCP 拡張（HTTP/SSE・resources/prompts）。
2. CP-16 ワークツリー分離。
3. C2 へ（ストリーミング・フック・memories）。

---

## ラウンド 12（2026-11-05）— CP-15（サブエージェント制御）

### 完了

| WP | 内容 | 主な変更 | 検証 |
| :--- | :--- | :--- | :--- |
| **CP-15** | サブエージェントのライフサイクル | 4 つの deferred ツール（`spawn_agent` / `wait_agent` / `list_agents` / `close_agent`、`requires: 'delegate'`）。`ToolRuntime` に `waitAgent` / `listAgents` / `closeAgent` コールバック。`session-app` の `SubagentRegistry` に接続（`wait` は 30 秒既定のタイムアウト付き `Promise.race`、`list` は id/task/status、`close` は registry の `close`） | `tools.test.js` の CP-15 1 件 PASS（未ロードはエラー → `tool_search` → spawn / wait / list / close、コールバックの引数を検証）。wire 一覧を更新。全単体 53 ファイル中 51 PASS（`mcp`/`lsp` は環境要因） |

### 実装メモ

- deferred のため**初期プロンプトのトークンは増えない**（`tool_search` で `agent` を検索したときにだけ現れる）。`requires: 'delegate'` なので、サブエージェントを持てないセッション（ワーカーの子など）には出ない。
- `wait_agent` は 30 秒で待機を打ち切り `{ final: '', status, timedOut: true }` を返す。タイマーは `unref()` するのでプロセスを引き止めない。
- `close_agent` は registry の状態を返すだけで、実行中のエージェントは停止しない（先に `interrupt` 相当が必要）。実行中を閉じたい場合は GUI の停止か `wait` を使う。
- GUI/CLI の両方で `delegate` があるセッションに配線。CLI の同期 `delegate` のみの環境では `wait_agent` などは「web session only」エラーになる（registry がないため）。

### 次ラウンド

1. CP-11 MCP 拡張（HTTP/SSE・resources/prompts・elicitation）。
2. CP-16 ワークツリー分離。
3. CP-17 画像の前処理とメディア予算。

---

## ラウンド 11（2026-11-05）— CP-09（write_stdin / unified exec）

### 完了

| WP | 内容 | 主な変更 | 検証 |
| :--- | :--- | :--- | :--- |
| **CP-09** | 実行中プロセスへの入力 | **Rust**: `SpawnSpec.stdin_pipe`、`Job` に stdin sink（tokio 版は `tokio::sync::mpsc` + 書き込みタスク、制限トークン版は `std::sync::mpsc` + 書き込みスレッド）、`JobManager.write`、プロトコル `job/write` と `ExecCommandParams.stdinPipe`、server のハンドラ。**TS**: `ExecRpcClient.jobWrite`、`shell { stdinPipe: true }`、`write_stdin` ツール（job ごとの出力オフセットを保持し、新規出力または終了まで最大 `timeoutMs` 待つ） | `cargo test -p hy-exec-server` 33 件 PASS（既存）。`tools.test.js` の CP-09 1 件 PASS（write → 出力 → 終了の組み立てを fake client で検証）。wire 一覧と SDK スナップショットを更新。E2E 用 `tests/integration/write-stdin.test.mjs` を追加（Node ワンライナーに hello を送って GOT:hello を確認、CI/実機用） |

### 実装メモ

- 2 経路を同時に実装した: (a) 非 confinement の `tokio::process` は `ChildStdin` を書き込みタスクが所有、(b) 制限トークンの `spawn` は `ConfinedChild.stdin`（`std::fs::File`）を書き込みスレッドが所有。どちらも `job/write` から同じ `StdinSink` に届く。
- **PTY（ConPTY）は未実装**。したがって全画面 TUI やカーソル制御を期待するプログラムではなく、行単位の対話（REPL、`set /p`、`readline` など）が対象。`write_stdin` は `shell { stdinPipe: true, foregroundWaitMs: 300 }` のように backgrounded にしてから使う。
- `write_stdin` は新規出力が来た時点で返る（最大 `timeoutMs`、既定 2 秒）。出力は job ごとのオフセットで読み進めるため、続けて呼ぶと続きが返る。
- この環境では子プロセス起動が EPERM のため E2E は実行していない。Rust コンパイル、既存テスト、fake client による TS テスト、CI 用統合テストの追加まで。

### 次ラウンド

1. CP-15 サブエージェント制御プレーン（`spawn_agent` / `wait_agent` / `list_agents` / `close_agent`）。
2. CP-11 MCP 拡張（HTTP/SSE・resources）。
3. CP-16 ワークツリー分離。

---

## ラウンド 10（2026-11-05）— request_permissions

### 完了

| WP | 内容 | 主な変更 | 検証 |
| :--- | :--- | :--- | :--- |
| **CP-05**（残り） | `request_permissions` ツール | `tool-registry` に wire ツールを追加（`write: string[]`, `reason`）。`tools.ts` の実装: 各パスを絶対化し、存在しないパスは `rejected`、既存パスは**承認要求**（`sandbox: unconfined` でユーザー判断を強制、Guardian 不可）→ 承認後に `sandbox/add-root` でセッション中だけ追加。返り値は `granted` / `rejected` / `note` | 新規 `tools.test.js` 1 件 PASS（承認 → 追加、存在しないパスは拒否、`unconfined` の強制、`sandboxAddRoot` 呼び出しを検証）。`tool-registry.test.js` の wire 一覧を更新して PASS |

### 実装メモ

- 読み取りの追加許可は**未対応**（deny ACE を外すのは安全でないため）。`write` のみを受け付け、読み取り・ネットワークは明示的に拒否せず対象外として扱う（入力に `read` は無い）。
- 承認は必ずユーザー（`unconfined` の合成要求）。`--yes` の場合は承認済みとして通る。
- 追加した root は `sandbox/add-root` のセッション状態にのみ入り、`revoke` で消える。`config.extraWritableRoots` は変更しない。
- **CP-09（write_stdin / unified exec）は持ち越し**。理由: 現行の Job は `stdin = NUL` 固定で、書き込み可能なセッションには (a) 非 confinement の `tokio::process` と (b) 制限トークンの `spawn` の両経路で stdin ハンドルを保持する改修が必要。PTY（ConPTY）はさらに別作業。次ラウンドでこの 2 経路を実装する。

### 次ラウンド

1. **CP-09**: Job に stdin パイプと書き込みハンドルを追加し、`exec/start|write|poll|kill` と `write_stdin` ツールを実装。
2. CP-15 サブエージェント制御プレーン（`spawn_agent` / `wait_agent` / `list_agents`）。
3. CP-11 MCP 拡張（HTTP/SSE・resources）。

---

## ラウンド 9（2026-11-05）— CP-12 / CP-14

### 完了

| WP | 内容 | 主な変更 | 検証 |
| :--- | :--- | :--- | :--- |
| **CP-12** | ユーティリティツール | `current_time`（ISO・ローカル・TZ・曜日）、`sleep`（最大 60 秒、`AbortSignal` で中断可）、`get_context_remaining`（`contextWindowTokens` と直近の provider 実測 usage）。`ToolRuntime.setUsage()` を追加し、Agent が各ステップ後に usage を渡す。全セッションで `contextWindowTokens` を配線 | 新規 `tools.test.js` の CP-12 1 件（時刻・5 ms 待機・残量の前後）PASS |
| **CP-14** | 検索ツールの直接公開 | `search_glob` / `search_grep` を `wire: true` に（`run_code` SDK と同一実装） | `tool-registry.test.js` の wire 一覧・検索の直接提示を更新して PASS。全単体 53 ファイル中 51 PASS（`mcp`/`lsp` は環境要因） |

### 実装メモ

- `sleep` は当初 deferred にしたが、`requires` を持たないため全セッションで `tool_search` が常時出てしまう。**直接ツールに変更**した（小さい・中止可能）。
- `get_context_remaining` は「使用量がまだ無い」場合は `remaining = window, source = none` を返す（誤って 0 を返さない）。
- wire ツールは 19、うち deferred 5（web_fetch / web_search / lsp / mcp_call / memory）。**初期プロンプトは直接 14 + tool_search**。
- K9 の再計測（Ollama 必要）は未実施。`docs/bench-baseline.md` の更新は実測後に行う。
- `contextWindowTokens` はセッション開始時の値。モデルを切り替えると古くなるため、次回 `setModel` から更新する余地を残す。

### 次ラウンド

1. **CP-09 `write_stdin` / unified exec**（exec-server のセッション API）。
2. `request_permissions`（CP-05 の残り。承認 → 追加 writable root）。
3. CP-15 サブエージェント制御プレーン。

---

## ラウンド 8（2026-11-05）— C1 開始・CP-10

### 完了

| WP | 内容 | 主な変更 | 検証 |
| :--- | :--- | :--- | :--- |
| **CP-10** | `tool_search` と遅延ロード、K9 の再定義 | **registry**: `ToolSpec.exposure`（`direct` / `deferred`）、`deferredTools()`、`offeredTools` / `renderToolPrompt` / `renderSdk` に `active` 引数。`web_fetch` / `web_search` / `lsp` / `mcp_call` / `memory` を deferred に。`tool_search` を追加（deferred が 1 つ以上あるときだけ提示）。**prompt**: `PromptExtras.activeTools`、`promptFeatures` が `deferred` を自動追加。**runtime**: `ToolRuntime.activateTools` / `activatedTools` / `deferredAvailable`、`tool_search` の実装（名前・説明の語で検索、最大 10、空クエリは全件）、未ロードの deferred 呼び出しはエラー。**agent**: ステップごとにシステムプロンプトを再生成し、ロード済みツールを同じターン内で使えるようにした（テストダブルには寛容） | 新規 `tool-registry.test.js` の CP-10 2 件、`tools.test.js` の CP-10 1 件 PASS（未ロードで失敗 → `tool_search` → 呼び出し成功）。全単体 53 ファイル中 51 PASS（`mcp`/`lsp` は環境要因）。`pnpm build` / `typecheck` 成功 |

### 実装メモ

- **K9 の再定義**: 「初期プロンプト（直接ツール + PTC SDK）≤ 1,200 トークン」に変更。遅延ロード分は初期プロンプトに含まれない。`tool-overhead.test.mjs` は従来どおり初期値を測る（Ollama がある環境でのみ実行）。
- 遅延対象は「機能フラグでしか現れない低頻度ツール」に限定した。`delegate` / `ask_user` / `skill_load` は常時直接（小モデルが最初の一手で使うため）。
- `tool_search` は deferred が 1 つも無いセッション（機能が全部オフ）では提示されない。
- プロンプトはステップ境界で再生成する。ロード後は同じターンの次のステップから見える（ネイティブ関数呼び出し・テキストプロトコルの両方）。
- 未測定: 初期プロンプトの新しいトークン数（Ollama が必要）。`docs/bench-baseline.md` の再計測は次回。

### 次ラウンド

1. **CP-09 `write_stdin` / unified exec**（exec-server のセッション API）。
2. CP-12 ユーティリティツール（`current_time` / `sleep` / `get_context_remaining`）と CP-14 検索ツールの直接公開（K9 に余裕ができたため追加可能）。
3. `request_permissions`（CP-05 の残り）もここで追加。

---

## ラウンド 7（2026-11-05）— C0 完了

### 完了

| WP | 内容 | 主な変更 | 検証 |
| :--- | :--- | :--- | :--- |
| **CP-06**（残り） | Details → Sandbox の拒否一覧とパス権限の表示 | 新規 `packages/hy-cli/web/src/denials.ts`（`sumDenials`）、`app.ts` の `sandboxRows`（mode / enforcement / denyRead 件数 / readOnly 件数 / ブロックされた呼び出しの種別内訳 / 直近の拒否理由 / 適用失敗パス）、`types.ts` に `denyRead` / `readOnly` 系、i18n 4 キー（英/日/中）、`.denial-list` の CSS | 新規 `web/test/denials.test.mjs` PASS、web テスト全件 PASS、`pnpm build` / `pnpm typecheck` 成功 |

### C0 の完了状況（ネットワークを除く）

| WP | 状態 |
| :--- | :--- |
| CP-01 既定サンドボックス | ✅ |
| CP-02 パス権限（denyRead / readOnly / extends） | ✅ |
| CP-05 承認ポリシー 4 値 | ✅（`request_permissions` は CP-10 後） |
| CP-06 拒否の可視化 | ✅（分類・イベント・バッジ・Details 一覧） |
| CP-07 プロセス堅牢化 | ✅（緩和ポリシー。E2E は CI/実機） |
| CP-08 DPAPI シークレット | ✅ |
| CP-44 Guardian レビューセッション | ✅（GUI への evidence 表示は未了・Trace で確認可） |
| CP-03 / CP-04 ネットワーク | 対象外（ユーザー指示） |

**C0（封じ込め）は完了**。次は C1（道具箱）。

### 次ラウンド

1. **CP-10 `tool_search` と K9 の再定義**（初期プロンプト ≤1,200、遅延ロード分は別枠）。ここで K9 を「初期」に再定義しないと CP-12/14 と `request_permissions` が入らない。
2. CP-09 `write_stdin` / unified exec。
3. CP-12 ユーティリティツール、CP-14 検索ツールの直接公開。

---

## ラウンド 6（2026-11-05）

### 完了

| WP | 内容 | 主な変更 | 検証 |
| :--- | :--- | :--- | :--- |
| **CP-05**（承認ポリシー） | `untrusted` / `on-request` / `on-failure` / `never` の 4 値 | `packages/core/src/config.ts`（`ApprovalPolicy` 型、`parseApprovalPolicy`、ユーザー設定と CLI 上書き、既定 `untrusted`）、`packages/hy-cli/src/cli-args.ts`（`--approval`）、`packages/seams/src/guardian.ts`（`createApprover` に `policy`。`never` は承認せず拒否、`on-request`/`on-failure` は confined を自動承認）、usage、設定スキーマ | `guardian.test.js` **14 件 PASS**（新規: never / on-request / untrusted の 3 挙動）。`config.test.js` **11 件 PASS**（既定・上書き・不正値）。`check:config-schema` up to date |
| **CP-07** | プロセス緩和ポリシーの強制 | `crates/hy-sandbox-windows/src/spawn.rs`: `PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY` を属性リストに追加（DEP / SEHOP / heap corruption での終了 / bottom-up + high-entropy ASLR）。属性リストの数を +1。第 2 ワードは 0（JIT・ツールチェーンを壊さないため） | `cargo test -p hy-sandbox-windows cp07` PASS（ビットの検証）。実際のプロセス生成はこの環境では `CreateRestrictedToken` が失敗するため CI/実機で確認 |

### 実装メモ

- 承認ポリシーの既定は **`untrusted`**（従来どおり都度確認）。`on-request` / `on-failure` は Codex に合わせて confined の `prompt` を自動承認するが、**unconfined / low-integrity は対象外**（必ずユーザー）。
- `never` は「承認しない」であり「すべて拒否」ではない。Guardian も呼ばれず、理由付きでツールエラーになる。
- CP-05 の `request_permissions` は **K9（PTC プロンプト ≤1,200 トークン）に抵触するため CP-10 の後**に回す（現状 1,185 トークンで余地が 15）。CP-10 で K9 を「初期プロンプト」に再定義してから追加する。
- 緩和ポリシーは子プロセスが下げられない（`CreateProcess` 時に固定）。DEP/SEHOP/ASLR は互換性が高く、拡張ポイント制限や dynamic code 禁止は入れない。

### 次ラウンド

1. CP-06 の残り（Details → Sandbox の拒否一覧、`approval/decision` の GUI 表示）。
2. C1 へ: CP-10 `tool_search`（K9 再定義）、CP-09 `write_stdin`。

---

## ラウンド 5（2026-11-05）

### 完了

| WP | 内容 | 主な変更 | 検証 |
| :--- | :--- | :--- | :--- |
| **CP-44** | Guardian のレビューセッション化 | `packages/seams/src/guardian.ts`: `context`（直近のツール呼び出し）/ `maxPromptChars`（既定 8,000、超過分は明示的に切り詰め）/ `deadlineMs`（既定 20 秒、`AbortSignal.timeout` を provider に伝播）/ `evidence`（判定の根拠、200 文字上限）/ 承認キャッシュ（サンドボックス + 正規化コマンドがキー、**拒否はキャッシュしない**、上限 200、LRU）。`packages/core/src/tools.ts`: `ToolRuntime.recentActivity()`（直近 8 呼び出しの 1 行ダイジェスト）と `ApprovalDecision.evidence`。`packages/hy-cli`: GUI/`hy run` の Conversation と `hy ralph` のラウンドで `guardian.setContext(() => tools.recentActivity())` を接続し、承認のたびに `approval/decision`（コマンド・モード・可否・理由・根拠）をセッションログへ記録 | `node packages/seams/dist/guardian.test.js` **13 件 PASS**（既存 9 + 新規 4: evidence とキャッシュ、拒否は非キャッシュ、文脈と予算、締切 signal）。`pnpm build` / `pnpm typecheck` 成功。単体テスト全走査 53 ファイル中 51 PASS（`mcp`/`lsp` は環境要因） |

### 実装メモ

- 文脈は**呼び出し側が所有**する（`ToolRuntime.recentActivity()`）。Guardian はモデルではなく、渡された文字列をそのまま `<recent_activity>` で囲むだけで、内容は指示として扱わない。
- 予算は「コマンド最大 4,000 文字」「固定ヘッダ約 300 文字」を差し引いて文脈に割り当てる。切った場合は `… [truncated N chars]` を残す。
- キャッシュは**承認のみ**。拒否をキャッシュすると、ユーザーがポリシーを直した後も通り続けるため。
- 決定ログは `approval/decision`。Trace タブで確認できる（GUI の承認カードへの evidence 表示は次ラウンド）。

### 次ラウンド

1. CP-06 の残り（Details → Sandbox の拒否一覧、`approval/decision` の GUI 表示）。
2. CP-07 プロセス堅牢化（プロセス緩和ポリシー）。
3. C1 へ: `tool_search`、`write_stdin`、MCP 拡張。

---

## ラウンド 4（2026-11-05）

### 完了

| WP | 内容 | 主な変更 | 検証 |
| :--- | :--- | :--- | :--- |
| **CP-08** | API キーの DPAPI 保存と解決 | **Rust**: `crates/hy-sandbox-windows/src/secrets.rs`（`CryptProtectData` / `CryptUnprotectData`、`dpapi:` 参照）、`src/bin/hy-secret.rs`（stdin で protect/unprotect）、統合テスト `tests/secrets_bin.rs`。**TS**: 新規 `packages/core/src/secrets.ts`（`resolveSecretBin`、`isSecretRef`、`resolveSecretRef`、`protectSecret`、テスト注入可能な `SecretCodec`）、`RoleConfig.apiKeySecret` と `secrets` マップ、`loadConfig` での解決（全ロール）、`writeUserConfig`、CLI `hy secret list|set|remove`、設定スキーマ、`electron-builder.yml` に `hy-secret.exe` | Rust の lib テスト 3 件 PASS（往復・不正入力・毎回のソルト）。`hy-secret` 実機の手動往復（`cmd` 経由）を確認。TS: `secrets.test.js` 3 件、`config.test.js` 10 件 PASS。CLI 実測（分離した `HY_CONFIG_DIR`）で「未知の secret」エラーと `secret remove` の設定書き換えを確認。`config dump --show-secrets` の統合テストを追加（CI/実機用） |

### 実装メモ

- 平文は**ディスクに一切書かない**。`config.json` には `dpapi:<base64>` だけが残り、復号は実行時のプロセス内のみ。`hy config dump` は `apiKey` を既定で伏字にする。
- 値は **stdin からしか受け取らない**（argv はプロセス一覧に出るため）。
- 復号に失敗したときは暗号文をエラーに含めず、「どのロールのどの secret か」と原因だけを出す。
- `hy-secret.exe` が見つからない場合はビルドコマンドを案内する。ポータブル exe では `resources/hy-secret.exe` を探し、`electron-builder.yml` の `extraResources` に追加した。
- 制約: DSH sandbox 内では `spawnSync` が EPERM のため、CLI からの DPAPI 呼び出しを含む E2E はこのセッションでは実行できない（Rust テストと手動往復で代替）。

### 次ラウンド

1. CP-06 の残り（Details → Sandbox の拒否一覧、`sandbox/status` の拒否履歴）。
2. CP-44 Guardian のレビューセッション化。
3. CP-07 プロセス堅牢化。
4. C1 へ（`tool_search`、`write_stdin`）。

---

## ラウンド 3（2026-11-05）

### 完了

| WP | 内容 | 主な変更 | 検証 |
| :--- | :--- | :--- | :--- |
| **CP-02**（第 2 スライス） | `readOnly` carve-out とプロファイル継承 | **Rust**: 新規 `crates/hy-sandbox-windows/src/read_only.rs`（deny-write ACE、`DENY_WRITE_MASK` を公開）、`hy-protocol` の `InitializeParams.readOnly` と `SandboxStatusResult.{readOnly,readOnlyMissing,readOnlyFailed}`、`hy-exec-server` の `Sandbox::apply_read_only`（ワークスペース外・ルート自身は拒否、`revoke` で復元）。**TS**: `PermissionProfile.extends`（循環検出つき継承）、`sandbox.readOnly`、`readOnlySubpaths` の解決とワークスペース内の検証、initialize への受け渡し、CLI 表示、設定スキーマ | `cargo test -p hy-sandbox-windows read_only` PASS（carve-out → revoke で復元）。`cargo test -p hy-exec-server` 33 件 PASS。`node packages/core/dist/config.test.js` 9 件 PASS（extends・`readOnly` の workspace 内検証・循環拒否）。`gen:protocol --check` / `check:config-schema` up to date |

### 実装メモ

- carve-out は「ワークスペース SID への deny-write ACE」。読み取りは許可したまま、作成・変更・削除・子の削除（`FILE_DELETE_CHILD`）を拒否する。`.git` の保護と同じマスク。
- スナップショットは `state/grants/read-only.jsonl`。`sandbox/revoke` が deny-read → read-only → grant の順に戻す。
- `permissions.<name>.extends` は base のリストを先に結合する。循環・未知の名前は起動時にエラー。
- `readOnly` がワークスペース外を指す場合は**設定エラー**（fail closed）。サーバー側でも二重に拒否し `readOnlyFailed` に出す。
- 追加の統合テスト（CI/実機用）: carve-out 内が読めて書けない、外は書ける、ユーザーは書ける、ワークスペース外の `readOnly` は `readOnlyFailed` に出る。

### 次ラウンド

1. CP-06 の残り（Details → Sandbox の拒否一覧、`sandbox/status` の拒否履歴）。
2. CP-08 シークレット保存（exec-server に DPAPI ベースの `secret/protect|unprotect` を追加）。
3. CP-44 Guardian のレビューセッション化。
4. CP-07 プロセス堅牢化。

---

## ラウンド 2（2026-11-05）

### 完了

| WP | 内容 | 主な変更 | 検証 |
| :--- | :--- | :--- | :--- |
| **CP-02**（第 1 スライス） | `denyRead` による読み取りの閉じ込め（Windows の deny ACE） | **Rust**: 新規 `crates/hy-sandbox-windows/src/deny_read.rs`、`grants.rs` に `add_deny_ace` / `has_deny_ace_for` / `restore`（SDDL スナップショットを JSONL に記録）、`hy-protocol` の `InitializeParams.denyRead` と `SandboxStatusResult.{denyRead,denyReadMissing,denyReadFailed}`、`hy-exec-server` の `Sandbox::apply_deny_read`（ワークスペースとその祖先は拒否、存在しないパスは報告）、`revoke` で復元。**TS**: `PermissionProfile` / `permissions` / `defaultPermissions` / `sandbox.denyRead` の解決（`~`・`$HOME`・`%VAR%` 展開、重複排除）、`HarnessConfig.denyRead`、initialize への受け渡し、`reportSandbox` の表示、設定スキーマ。 | `cargo test -p hy-sandbox-windows deny_read` 2 件 PASS（deny → 継承 → revoke で完全復元、存在しないパスの報告）。`cargo test --workspace` は 46 件 PASS、失敗 1 件は環境要因（`CreateRestrictedToken` が DSH sandbox 内で `ERROR_INVALID_PARAMETER`）。`node packages/core/dist/config.test.js` 8 件 PASS（プロファイル解決・未知プロファイル・プロジェクト設定による追加不可）。`gen:protocol --check` / `check:config-schema` とも up to date |

### 実装メモ

- deny ACE は **ワークスペース SID** に対して付ける。この SID は制限トークンにしか含まれないため、**ユーザー本人は引き続き読める**。`.git` の書き込み拒否（ADR 0001 A）と同じ仕組み。
- スナップショット（元の SDDL）は `state/grants/deny-read.jsonl` に追記し、`hy sandbox revoke` が `grants::restore` で戻す。何度初期化しても、復元は最初のスナップショットを使う。
- `denyRead` にワークスペース自身・その祖先を書いた場合は拒否する（エージェントが何も読めなくなるため）。存在しないパスは `denyReadMissing` に出して続行する。
- サーバー側の権限モデルは「パス → deny のみ」の第 1 スライス。`readOnly` / `write` の carve-out とプロファイル合成（extends）は未実装。
- `scripts/gen-protocol.mjs` に `--schema <file>` を追加した（cargo を起動できない環境でも生成・検査できるように）。

### 次ラウンド

1. CP-02 の残り: 読み取り専用 carve-out（writable root 配下の `readOnly`）と `permissions.<name>.extends`。
2. CP-06 の残り: Details → Sandbox に拒否一覧、`hy sandbox status --json` の拒否履歴。
3. CP-08 シークレット保存（DPAPI / Credential Manager）。
4. CP-44 Guardian のレビューセッション化。
5. CP-07 プロセス堅牢化。

### 検証環境の制約（更新）

- `CreateRestrictedToken` が DSH sandbox 内で失敗するため、**confined モードの E2E はこのセッションでは実行できない**（`token::tests::constructs_tokens_for_standard_user_and_admin_member_identities` の失敗はこれ）。
- 新規の `tests/integration/sandbox-deny-read.test.mjs` は、DSH の外（Windows 実機 / CI）で実行する。内容: `denyRead` で制限トークンが読めないこと、ユーザーは読めること、`sandbox/revoke` で ACL が戻ること、存在しないパスの報告。

---

## ラウンド 1（2026-11-05）

### 完了

| WP | 内容 | 主な変更 | 検証 |
| :--- | :--- | :--- | :--- |
| **CP-01** | サンドボックスの既定を `workspace-write` に | `packages/core/src/config.ts`（`sandboxSource`、`sandbox.legacyUnconfined`）、`packages/hy-cli/src/cli-args.ts`（`--unsafe-unconfined`）、`packages/hy-cli/src/main.ts`（既定である旨の通知・usage）、`packages/core/src/config-schema.ts`、`packages/hy-cli/src/onboarding.ts`（既定の選択肢を先頭に）、`tests/integration/isolate.mjs`（他テストは `HY_SANDBOX=unconfined` を固定）、`tests/integration/default-sandbox.test.mjs`（新規） | `node packages/core/dist/config.test.js` 7 件 PASS（既定・legacy・CLI・env）。CLI 実測で `sandboxSource: default` / `workspace-write`、`--unsafe-unconfined` で `unconfined` を確認 |
| **CP-24** | Responses API の推論パラメータ | `RoleConfig` に `verbosity` / `reasoningSummary` / `serviceTier`、`OpenAiResponsesProvider` の payload、設定スキーマ | `node packages/core/dist/llm-providers.test.js` 4 件 PASS（送信 body を検証） |
| **CP-23**（一部） | プロンプトキャッシュキー | 同上で `prompt_cache_key` を送信（`hy-<sessionId>`） | 同上 |
| **CP-06** | 拒否の分類と可視化 | 新規 `packages/core/src/denial.ts`（`classifyDenial`）、`agent.ts`（`sandbox/denial` イベント + `tool-error` の `denial`）、`chat-projection.ts`（カードへの付与）、Web の `app.ts`/`types.ts`/`i18n.ts`/`styles.css`（`blocked: <kind>` バッジ） | `denial.test.js` 2 件、`chat-projection.test.js` 14 件 PASS |

### 未完了・次ラウンド

- **CP-06 の残り**: Details → Sandbox パネルに拒否の一覧と件数を出す。`hy sandbox status --json` に直近の拒否を含める。
- **CP-23 の残り**: 推定トークンと実測の誤差を `token/estimate` として記録し、補正係数を更新する。
- **CP-02**: パス権限モデル（deny-read / carve-out）。Rust の ACL と `initialize` の権限受け渡し。
- **CP-08**: シークレットの OS 保存（DPAPI / Credential Manager）。
- **CP-44**: Guardian のレビューセッション化。
- **CP-12 / CP-14 / CP-09 / CP-10**: ツール表面（`tool_search` を先に実装してから、K9 を「初期プロンプト ≤1,200」に再定義する）。

### 検証環境の制約（重要）

- DSH の sandbox（workspace-write）では、**子プロセスを pipe 付きで起動できない**（`spawn EPERM`）。このため `node --test` のランナー、`pnpm test`、`pnpm test:integration`、および子プロセスを起動するテスト（`mcp.test.js`、`lsp.test.js`、GUI の統合テスト）はこのセッション内では実行できない。
- 代替として、**単体テストをファイル単位で直接実行**した: 52 ファイル中 **50 PASS**。失敗 2 件はどちらも `spawn EPERM` に起因する環境要因（`lsp.test.js` は明示的に EPERM、`mcp.test.js` はスタブサーバーの起動失敗）。
- `cargo test -p hy-execpolicy` は 9 件 PASS（Rust のテストは実行できる）。
- **外部（DSH の外）で `pnpm build` / `pnpm typecheck` / `pnpm test` / `pnpm test:integration` を一度通すこと**。この記録ではビルドと型検査（どちらも成功）と上記の単体テストまでを確認済みとする。

### 検証コマンドの記録

```powershell
pnpm build                 # OK
pnpm typecheck             # OK（変更前後）
node packages/core/dist/config.test.js          # 7 PASS
node packages/core/dist/denial.test.js          # 2 PASS
node packages/core/dist/llm-providers.test.js   # 4 PASS
node packages/hy-cli/dist/chat-projection.test.js # 14 PASS
node packages/hy-cli/dist/onboarding.test.js    # 4 PASS
cargo test -p hy-execpolicy                     # 9 PASS
```

### 既存ドキュメントへの反映

- [README.md](../README.md) / [README.ja.md](../README.ja.md): サンドボックスの既定を `workspace-write` に更新。
- [docs/enforcement-gaps.md](enforcement-gaps.md) S9: 既定変更と opt-out を記録。
- [docs/implementation_status.md](implementation_status.md) §1/§5: 既定と不変条件を更新。
- [docs/config.schema.json](config.schema.json): `pnpm gen:config-schema` で再生成。

### 気づいた負債

- `packages/hy-cli/web/src/types.ts` は core/CLI の型を手で写しており、今回も `denial` を両方に足す必要があった。CP-25/CP-26 の型生成で解消する。
- `pnpm test` が DSH sandbox 内で動かないため、CI（Windows 実機）での確認が必須。
