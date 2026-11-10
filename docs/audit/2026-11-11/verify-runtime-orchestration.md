# 実行基盤・オーケストレーション・検証ゲート・ベンチの検証（主張6）

- 日付: 2026-11-11
- 対象: `F:\HY-HARNESS`（未コミット変更を含む作業ツリー）
- 依頼: 別セッション調査報告のうち、実行基盤・オーケストレーション・検証ゲート・ベンチに関する 7 項目を実コードで検証する。**ソースは変更していない。**
- 方法: `read_file` / `search_grep` で該当箇所を実在確認し、状態遷移はコードを追跡した。Rust は既存テストの一覧と実行結果を取得した。**実行による再現（4 MiB 出力、承認タイムアウト等）は行っていない**（§9）。
- 表記: **事実** = コードを読んで確認した内容 / **(推測)** = コードから導いたが実行していない内容 / file:line はすべて実ファイルで確認済み。

---

## 0. 判定一覧

| # | 主張（要約） | 判定 | 根拠の中心 |
|---|---|---|---|
| 1 | 4 MiB 到達で後続を捨て、`clip` が「最初の 4 MiB の末尾」を返す。1 バイトの不正 UTF-8 で出力全体が Shift_JIS 化する | **正確**（補足 2 点） | `crates/hy-exec-server/src/jobs.rs:139,150-165,347-357,30-38` |
| 2 | クライアントのタイムアウト時に `$/cancelRequest` を送らない。`exec` が `hardTimeoutMs` を参照しない | **正確**（影響は限定的） | `packages/core/src/exec-rpc.ts:346-367,383-384` |
| 3 | 承認の 5 分タイムアウト後、ワーカーが動き続けても `blocked` に固着し `heartbeatCheck` の対象外になる | **正確** | `packages/hy-cli/src/web-server.ts:2040-2050,3036-3041,3063-3083` |
| 4 | 読取専用サブエージェントに親の `roleInstruction`（worker.md）が注入される | **正確**（Web の worker / orchestrator に限る） | `packages/hy-cli/src/session-app.ts:1052,1329,1354`、`packages/hy-cli/src/web-server.ts:1965` |
| 5 | `tamper-rejected` で `rollback()` せず `continue`。Gate 2 は 64 KB で切り詰めた diff に「全変更が含まれなければ pass:false」と指示 | **正確**（帰結を追加） | `packages/seams/src/verifier-ralph.ts:224-234,288-289` |
| 6 | ベンチがモデル・effort 固定、`cacheHitTokens` の 1 ステップ欠落で全体 null 化、`.sub` を main と混在 | **一部正確**（null 化の範囲に差） | `bench/harness/run.mjs:20-21,98-99`、`bench/harness/logs.mjs:14-17,78-90` |
| 7a | 共有単一 `shellQueue` による直列化 | **正確** | `packages/hy-cli/src/web-server.ts:1241-1253,1933-1942,1987` |
| 7b | 親の二重ステータス / 対話注入 | **確認不能**（主張の対象が特定できない） | 候補: `web-server.ts:1915,3040` |
| 7c | ワーカー毎の role / effort 指定ができない | **正確** | `packages/hy-cli/src/web-server.ts:1780-1792`、`packages/core/src/config.ts:822-827` |

**最重要**: 1・3・5 は「コードどおりに壊れる」ことを確認した。特に 5 の Gate 2 は、**正しい大規模変更が原理的に通らない**（64 KB 超の diff は必ず「変更が欠けている」と判定される）ため、ループの収束性に影響する。

---

## 1. 4 MiB 超出力の末尾欠落

### 判定: 正確

### 根拠（事実）

- `MEM_CAP = 4 * 1024 * 1024`（`jobs.rs:139`）。上限は **stdout / stderr 別**（`jobs.rs:152-155` で `buf` を選ぶ）。
- `Captured::append` は**リングバッファではなく単純打ち切り**（`jobs.rs:150-165`）。

```rust
150:     fn append(&mut self, stream: Stream, data: &[u8]) {
151:         self.total += data.len() as u64;          // 総量は数え続ける
156:         if buf.len() >= MEM_CAP {
157:             self.truncated = true;
158:             return;                                // 以降のバイトは捨てる
159:         }
160:         let take = data.len().min(MEM_CAP - buf.len());
161:         buf.extend_from_slice(&data[..take]);
```

- `clip` は保持バッファの**先頭 10,000 バイト**（`RESULT_HEAD`, `jobs.rs:137`）と**末尾 20,000 バイト**（`RESULT_TAIL`, `jobs.rs:138`）を取る（`jobs.rs:347-357`）。末尾の開始位置は `bytes.len() - RESULT_TAIL`（`jobs.rs:354`）＝**保持バッファの末尾**。
  → 4 MiB を超えた出力では、返る「末尾」は `[4 MiB-20,000, 4 MiB)`、すなわち**最初の 4 MiB の末尾**であり、真の最終出力ではない。主張どおり。
- UTF-8 判定はスライス全体に対して 1 回（`jobs.rs:30-38`）。失敗すると **Windows では同じスライス全体を `encoding_rs::SHIFT_JIS` でデコード**する（`jobs.rs:36`）。1 バイトの不正バイト（例: 途中で切れた CP932 のリードバイト、バイナリ混入）で、そのスライス内の正当な UTF-8 日本語も CP932 の別文字に化ける。主張どおり。
  - ただし対象は「そのスライス」単位（head / tail / 1 ページ）。ページ境界の文字分割は `page_bytes` / `at_authoritative_end`（`jobs.rs:323-324,337-345`）で緩和されているが、**混在エンコーディング自体は緩和されない**。
  - 非 Windows は `String::from_utf8_lossy`（`jobs.rs:41`）なので、この症状は Windows 固有。

### 補足（主張との差分）

1. **真の末尾はログファイルに残っており、`job_output` で取得できる。** 読み取りループは保持バッファと無関係に全バイトをログへ書く（`jobs.rs:683-684,712-713`、`append_log` は `jobs.rs:779-788`）。`Job::output` はログをオフセット指定でページングする（`jobs.rs:295-335`）。エージェント向けツール `job_output` も存在する（`packages/core/src/tools.ts:1200-1207`、`packages/core/src/tool-registry.ts:671`）。
   → 「末尾が失われる」のは**`exec/command` の戻り値（`Job::result` → `clip`）だけ**。ただしシェル結果には `job_id` と `truncated: true` が入る（`tools.ts:2125-2131`）のに、「この末尾は本当の末尾ではない／続きは job_output で読め」という案内は無い。モデルが末尾を信用すると、最後に出たエラー行を見落とす。
2. **`Captured::truncated` は誰も読んでいない。** 設定は `jobs.rs:157,163`、読み出しは無く、`ExecResult.truncated` は `clip` の戻り値同士の OR（`jobs.rs:289`）。4 MiB 保持時は `clip` が必ず true を返すため実害は無いが、条件が変わると壊れる死んだフラグ。

### 影響と修正方針

- 影響: 大量出力（ビルドログ、テストスイート、ループの printf）で**最後にだけ出る失敗理由が結果から消える**。エラーは「途中までの出力＋無関係な末尾」になる。
- 方針: 保持側をリングバッファ（直近 4 MiB）にして `clip` の末尾を真の末尾にする、または `clip` をログファイルの末尾から生成する。復号は「スライス全体を CP932」ではなく、無効バイト位置で区切って**区間ごとに UTF-8 / CP932 を選ぶ**（もしくは 1 バイトずつ lossy）。`captured.truncated` を `ExecResult` に反映する。

---

## 2. クライアント側タイムアウトでキャンセルされない

### 判定: 正確（ただし実害は限定的）

### 根拠（事実）

- `request()` は 2 つの終了経路を持つ（`packages/core/src/exec-rpc.ts:346-368`）。
  - **abort（`signal`）**: `$/cancelRequest` を送ってから reject（`exec-rpc.ts:353-361`、送信は 358）。
  - **タイムアウト**: pending を消して reject するだけ（`exec-rpc.ts:363-367`）。**`$/cancelRequest` を送らない。** 主張どおり。
- `exec()` の RPC タイムアウトは `Math.max(120_000, (foregroundWaitMs ?? 5_000) + 30_000)`（`exec-rpc.ts:383-384`）。`hardTimeoutMs` は参照しない（型には存在する: `packages/core/src/protocol.gen.ts:166`）。主張どおり。
- サーバは `$/cancelRequest` を受けると**ジョブを kill する**（`crates/hy-exec-server/src/server.rs:588-594`、gate も同様に 572-579）。つまりタイムアウト時に取り消しを送らない＝**デーモン側のプロセスは動き続ける**。

### 補足（影響の限定要因）

- abort 経路は正しくキャンセルする。呼び出し側は `this.signal` を渡している（`packages/core/src/tools.ts:2056`）。
- 前景固定モード（`noBackgroundShell`: Web の worker / orchestrator、`web-server.ts:1988`）では `foregroundWaitMs = hardTimeoutMs + 5_000` にして（`tools.ts:2034`）、RPC タイムアウトがハードタイムアウトより必ず長くなるようにしてある。実際 `hardTimeoutMs` の既定 600,000（`tool-docs.ts:24`、`tools.ts:2029`）→ RPC 635,000 ms。
- 通常モードでもサーバは `foregroundWaitMs`（既定 5,000 ms）で `backgrounded` を返す（`server.rs:587,596-600`）ため、RPC タイムアウトは通常発火しない。**発火するのは転送やデーモンが固まったとき**で、まさにそのときにキャンセルされないのが問題。
- 影響: 固まった RPC の後もコマンドは走り続け、モデルはエラーを見て再実行しうる（二重実行）。ジョブは `job_status` / `job_output` で回収できるが、その案内は無い。
- 方針: タイムアウト経路でも `$/cancelRequest` を送る（pending を消す前に）。`exec` の既定タイムアウトに `hardTimeoutMs` を加味する。

---

## 3. オーケストレーションの状態固着

### 判定: 正確

### 事実（状態遷移の追跡）

1. ワーカーの承認要求は `requestApproval` が作る（`web-server.ts:2025-2052`）。ワーカーなら `onWorkerApproval` で **`status: 'blocked'`** にする（`web-server.ts:2047-2050` / 定義 3043-3048、`blocker: 'approval required: …'`）。
2. 5 分でタイムアウトし、`pendingApprovals` を消して **`resolve(false)`**（`web-server.ts:2040-2045`）。**このときワーカーの status は触らない。**
3. 拒否されたツール呼び出しはエラーとしてモデルに返り、ワーカーのターンは**そのまま続く**（`web-server.ts:2039-2051` は解決するだけでターンを止めない）。
4. 以降のイベントは `onWorkerEvent` を通るが、戻すのは `queued -> running` だけ（`web-server.ts:3036-3041`、該当行 3038）。
5. `heartbeatCheck` は **`worker.status !== 'running'` を即 skip**（`web-server.ts:3063-3068`）。したがって固着中はストール検知の対象外（60 秒ごとに実行: `web-server.ts:6094`）。

### 発生条件

- ワーカーが承認要求を出し、**5 分以内に誰も承認/拒否しない**（ユーザーが GUI を見ていない、かつオーケストレーターが `orchestrator_approve` を呼ぶターンを取らない）。`userOnlyApproval` の要求（`web-server.ts:3056-3058`）はオーケストレーターが承認できないため、この条件に落ちやすい。
- かつ、拒否後もワーカーが同じターンで作業を続ける。

### 解除されうる経路（＝固着の終わり）

- 新しいターンの開始: `sendWorker` の新規ターン（`web-server.ts:2862`）、`resumePendingWorker`（`web-server.ts:2286`）、`approveWorker`（`web-server.ts:2964`、ただし**pending が残っている場合のみ**。2941-2942 で `no pending approval` を投げる）。
- ターン終了時の再計算: `onTurnFinished` がレポートから status を決め直す（`web-server.ts:2649-2685`）。

つまり「ターンが終わるまで最大で残りターン全体」固着する。

### 影響

- 実際に動いているワーカーが、親の digest では「blocked — approval required: …」と表示される（`web-server.ts:2382-2390`。blocker が残っているため「waiting for approval」ではなく古いコマンド文字列が出る）。親は「承認待ち」と誤認して close / stop を保留しうる。
- ストール検知（heartbeat）がそのワーカーに限り効かない。固着したまま無音で止まっても、親は起きない。
- なお `workersAreWriting()` は `session.busy` も見るため（`web-server.ts:2273-2278`）、シェル排他の判定は壊れない（ワーカーが実際に動いている間は busy=true）。影響は**表示・検知・クローズ判断**に限定される。

### 方針

タイムアウト解決時に、その要求で `blocked` にしたワーカーを `running` に戻す（承認待ち以外の理由の blocker は保持）。`heartbeatCheck` の対象を `running || blocked` に広げ、blocked は「承認待ちのまま N 分」を通知する。

---

## 4. サブエージェントへの役割プロンプト誤注入

### 判定: 正確（Web の worker / orchestrator セッションに限る）

### 事実

- ワーカーセッションの会話設定は `roleInstruction: workerPrompt()`（`web-server.ts:1963-1967`）。`workerPrompt` は `packages/hy-cli/prompts/worker.md` を読む（`web-server.ts:1664,1677-1678`）。
- `delegate` ツールは親の `options.roleInstruction` を**そのまま** `runSubagent` に渡す（`session-app.ts:1337-1355`、該当 1354）。`runSubagent` は `config.subagentRole` の provider / model を使いながら（`session-app.ts:1028-1031`）、`roleInstruction` を Agent に渡す（`session-app.ts:1052`）。
- 背景エージェント（`childRunner`）も `readOnly` 引数と無関係に同じ値を渡す（`session-app.ts:1322-1329`、該当 1329 / 定義 593-631 の 622）。
- `roleInstruction` はシステムプロンプトに連結される（`packages/core/src/agent.ts:601`、`packages/core/src/prompt.ts:207`）。
- 読取専用サブエージェントでもツールは読み取り系に制限される（`session-app.ts:983,999`）。**書き込みはできない**が、プロンプトは worker.md のまま。

注入される内容（`packages/hy-cli/prompts/worker.md` 実物）: 「You are a worker session managed by an orchestrator」「Work only inside the repository-relative scope named in your task」「End with these machine-readable lines `STATUS: done | partial | blocked` …」。

### 影響

- 読取専用の探索エージェントが「スコープ内の作業者」として振る舞い、**`STATUS:` 行を最終回答に混ぜる**、スコープ外の調査を遠慮する、`delegate` の再委譲を検討するなど、意図しない出力・手順になる。
- オーケストレーターのサブエージェントには `orchestrator.md` が入り、「プロジェクト全体の所有者」という誤った自己像を与える。
- トークンも無駄に消費する（worker.md は 39 行・約 3,000 文字）。
- CLI セッション（plan / read-only 親）は `options.roleInstruction` が未設定なので発生しない。

### 方針

サブエージェントには親の `roleInstruction` を渡さない（`session-app.ts:1052,1329,1354` を削除）。役割が必要なら `subagent.md` 相当の専用プロンプトを `config.subagentRole` 側に持たせる。少なくとも `readOnly === true` のときは渡さない。

---

## 5. verifier-ralph の tamper-rejected と Gate 2

### 判定: 正確（＋帰結を追加）

### 事実

- tamper 判定は `checkpointDiff(runId, 'base', 64 * 1024)`（`verifier-ralph.ts:224`）の `filesChanged` と保護パターンの照合（225）。該当したら `end('tamper-rejected', …)` の後に **`continue`**（226-234）。**`rollback()` を呼んでいない。** 主張どおり。モジュール冒頭の表も「tamper-rejected | kept」と明記している（`verifier-ralph.ts:9`）。
- `rollback()` は失敗・中断時（210）、Gate 2 が `rollbackRecommended` を返したとき（305-307）だけ。
- Gate 2 は `diff.truncated` のとき「TRUNCATED: only the stat and the first hunks are shown」を付けたうえで（288）、**「If any required change is missing from <untrusted_git_diff>, return pass:false」**と指示する（289）。主張どおり。
- 切り詰めは Rust 側で `patch.len() > max_bytes` のとき patch のみ（`crates/hy-exec-server/src/checkpoint.rs:439-445`）。`files_changed` は全件（437,453）なので tamper 判定自体は欠落しない。

### 追加の帰結（判定の根拠になる事実）

1. **tamper の diff は `base` からの累積**（224）。保護パスへの変更を取り消さない限り、**以後の全ラウンドで同じ tamper-rejected になる**。digest の文言は「change the code, not the tests or fixtures」（230）で、明示的な「元に戻せ」ではない。ワーカーが戻さなければ予算切れまで進み、**保護パスを変更したままの作業ツリーが残る**（成功時の `checkpointPrune(['base'])`（`verifier-ralph.ts:321`）は通らない）。
2. **64 KB を超える正当な diff は Gate 2 を通れない。** プロンプトは「diff に無い変更＝未達」と定義しているため（289）、切り詰められた以上、正しい実装でも `pass:false` になる。`rollbackRecommended` が false ならツリーは保持され（`verifier-ralph.ts:304-316`）、次のラウンドも同様に落ちる。**大規模だが正しい変更でループが収束しない**。
3. Gate 2 の `maxTokens: 800`（295）で verdict の JSON が切れると `parseGraderVerdict` が失敗し、「malformed verdict」で `pass:false`（297-302）になる **(推測: 出力長次第)**。

### 方針

- tamper-rejected では保護パスだけを `checkpointRollback` するか、少なくとも「保護パスを base の内容へ戻してから再提出」を digest に明記する。累積 diff で判定するなら、当該ラウンドの差分（`rN` からの diff）で判定する。
- Gate 2 は切り詰め時に「欠落＝未達」と判定させない。diff を分割して渡す、`filesChanged` と stat だけで判定させる、切り詰め時は `pass:false` を強制しない、のいずれか。

---

## 6. ベンチの測定盲点

### 判定: 一部正確

| 主張 | 判定 | 根拠 |
|---|---|---|
| モデル・effort 固定 | **正確**（設計意図でもある） | `bench/harness/run.mjs:20-21`（`deepseek-v4.1-flash` / `max` の定数）、`run.mjs:98-99`（`roles.worker` がその組み合わせでなければ**例外で停止**）。バリアントはプロンプト版と `reasoningHistory` だけを変える（`run.mjs:107-124`） |
| 1 ステップの `cacheHitTokens` 欠落で全体を null 化 | **一部正確**: null になるのは `hit` / `miss` / `hitRate` のみ。`input` / `output` / `requests` は残る | `bench/harness/logs.mjs:14-17`（`reported === steps.length` を要求。該当 16）、`logs.mjs:81`（`cacheHitTokens` が数値でなければ null）。欠落は `cacheReportedSteps` / `cacheTotalSteps` で診断できる（`logs.mjs:25-26`） |
| `.sub` を main と混在 | **正確**（ただし両ハーネスで対称） | `bench/harness/logs.mjs:78-81`（`main` 判定は `modelWaitMs` にだけ使い、`steps` には全 runId を積む）。DSH 側も子セッションのログを読み込んで合算する（`logs.mjs:193-196`） |

### 補足

- モデル・effort 固定は「同一条件で比較する」ための意図的な固定であり、fairness の欠陥ではない。盲点は**カバレッジ**で、他プロバイダ・他モデル・低 effort の挙動（適応リトライ、トークンフィールド、推論返送）はこのベンチでは一切測れない。定数を CLI 引数にして `meta.json` に記録するのが素直。
- `.sub` 混在の実害: `input` / `output` / `toolCalls` / `requests` はサブエージェントを含むのに、`turns` / `activeMs` / `modelWaitMs` は main のみ（`logs.mjs:15-20,88-91`）。したがって **`input / turn` や `harnessMs` はスコープの違う量の比**になる。サブエージェント使用量が HY と DSH で違えば時間・効率の比較が歪む。トークン合計の比較自体は両者対称なので成立する。

---

## 7. 余力項目

### 7a 共有単一 `shellQueue` による直列化 — 正確

`shellQueue` は 1 個だけ生成され（`web-server.ts:1241-1253`、`acquire` は tail に連結）、ワーカー（1987）とオーケストレーター（1933-1942）の両方に `shellLock` として渡る。`tools.ts:2048` でシェル実行前に取得するため、**全ワーカーのシェルが直列化**される。ワーカーは `noBackgroundShell: true`（1988）で前景実行を強制され、オーケストレーターの取得はワーカー稼働中なら例外（1938）。サブエージェントにも伝播する（`session-app.ts:1351`）。設計どおりだが、並列度は 1。

### 7b 親の二重ステータス / 対話注入 — 確認不能

主張の指す対象を特定できなかった。「対話注入」に近い箇所として、オーケストレーターの `sessionContext` が直近 6 件の dialogue エントリを `[concurrent conversation] …` として文脈に混ぜる処理（`web-server.ts:1915`）、「二重ステータス」に近い箇所として `session.workerStatus` と `record.status` の二重保持（`web-server.ts:3040`、`onWorkerEvent`）がある。どちらを指すか確定できないため判定しない。

### 7c ワーカー毎の role / effort 指定不可 — 正確

`orchestrator_spawn` のスキーマは `title` / `task` / `requires` / `scope` のみ（`web-server.ts:1780-1792`）。ロールは `config.roles.worker` に固定（`packages/core/src/config.ts:822-827`）。したがって「このワーカーだけ安いモデル／低 effort」は指定できない。コスト制御と難易度別割当の両面で制約。

---

## 8. 追加所見（主張に無いもの）

| # | 内容 | 根拠 | 影響 |
|---|---|---|---|
| A-1 | 承認タイムアウト後、GUI の承認カードに `decision` が設定されない。遅れて承認を押すと 404 になる | タイムアウトは notice を積むだけ（`web-server.ts:2040-2045`）。押下時は `approveWorker` が pending 不在で例外（2941-2942）→ 404（4757-4762） | ユーザーは「承認したのに拒否された」と見える。再実行の案内も無い |
| A-2 | `Captured::truncated` が未使用 | `jobs.rs:146,157,163`（設定）に対し読み出しが無い。`jobs.rs:289` は clip の戻り値 | 現状は無害。将来 4 MiB 未満で打ち切る変更を入れると `truncated` が嘘になる |
| A-3 | Gate 2 の verdict が `maxTokens: 800` で切れうる | `verifier-ralph.ts:295`、失敗時は malformed で `pass:false`（297-302） | 正しい変更が「判定不能」で落ち、ループが伸びる **(推測)** |
| A-4 | `heartbeatCheck` は `running` のみ対象 | `web-server.ts:3068` | `blocked` / `queued` の停止を検知できない（§3 と同根） |

---

## 9. 未検証・確認不能

- **実行による再現は未実施**: 4 MiB 超の出力、UTF-8/CP932 混在、RPC タイムアウト、承認 5 分タイムアウト、64 KB 超 diff の Gate 2、ベンチの実走はいずれもコード読解のみ。§1〜§6 の「影響」はコードからの導出。
- **Rust テストの被覆**: `cargo test -p hy-exec-server -- --list` の 42 件に `MEM_CAP` / `Captured::append` を対象とするテストは無い（`jobs::tests` は decode / clip / page_bytes / vt の 9 件）。つまり §1 の打ち切り挙動は**テストで固定されていない**。
- 7b の主張内容（対象箇所）は特定できず。
- Web UI 側の承認カード描画（A-1 の見え方）は `packages/hy-cli/web` を読んでいないため **(推測)**。

## 10. 実行した検証コマンド

| コマンド | 結果 |
|---|---|
| `cargo test -p hy-exec-server -- --list` | 42 tests, 0 benchmarks。`jobs::tests` は 9 件で、`MEM_CAP` 関連は無し |
| `cargo test -p hy-exec-server` | **42 passed; 0 failed; 0 ignored**（4.75s、ビルド 18.59s）。PowerShell が cargo の警告を stderr 経由で `NativeCommandError` にするため exitCode は 1 だが、テスト結果行は上記のとおり |

（コードの読み取りは `read_file` と `search_grep`、行番号の確認は行番号付きのファイル読み出しで行った。ソースは変更していない。）
