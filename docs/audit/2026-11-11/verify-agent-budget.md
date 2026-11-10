# 検証: USD 予算とエージェントループの主張（主張 3・4）

- 検証日: 2026-11-11
- 対象: 別セッション調査報告の **主張 3（USD 予算、3 項目）** と **主張 4（エージェントループの 4 バグ、a〜d）**
- 方法: 現行ツリーのソース実読（行番号は `read_file` / `search_grep` で実在確認）、既存テストの確認、`packages/core/dist`（src より新しいビルド）に対する挙動プローブ。**新規テストファイルは作っていない。**
- 制約: ソースは変更していない。行番号は本作業ツリーの現時点のもの。既存の監査文書は行番号が古い（付録 A）。
- 表記: **事実** = コードまたは実測で確認した内容、**(推測)** = コードからの推論で実機確認していない内容。

## 0. 前提: どの実行経路でどの USD 機構が効くか

主張 3 の各項目は「USD 上限が有効なとき」だけ成立する。有効化条件と経路を先に固定する。

| 経路 | USD 機構 | 根拠 | 備考 |
| --- | --- | --- | --- |
| 対話（`chat`） | なし | `web-server.ts:2239` が `session.kind === 'chat'` を除外 | 予算オブジェクト自体を渡さない |
| オーケストレーションのターン（orchestrator / worker） | `withModelBudget` + `active.reservedCostUsd` | `web-server.ts:2236-2254`、呼び出し `web-server.ts:3286`, `3367` | 予約 → `settle` で実費に置換 |
| `hy ralph`（ラウンド・worker・grader） | `Budget4D` | `main.ts:945-955`、`budget.meter` を `main.ts:957-963` | 対話側は `session-app.ts:1287` が `budget=undefined` |
| 予算の有効化 | `config.budget.maxCostUsd` は既定 `undefined` | `config.ts:947-956` | project の `budget4D.maxCostUsd` か `--max-cost-usd` で有効 |
| 価格 | 同梱なし。ユーザー設定のみ | `model-catalog.ts:19-25`, `llm.ts:1479-1481` | 未設定なら USD 上限時に例外（`llm.ts:1498-1502`） |

事実: したがって 3-1 / 3-2 はオーケストレーション経路、3-3 は ralph 経路の問題である。

## 1. 主張 3-1 — 予算下で fetch 例外と 5xx の再試行を禁止

**判定: 正確（条件付き）**

事実:

- `postWithRetry`（`llm.ts:301`）は `const budgeted = paidModelRequest.getStore() === true`（`llm.ts:307`）を取り、fetch 例外時に `if (budgeted || init.signal?.aborted || attempt >= retry.retries) throw error`（`llm.ts:318`）で**再試行しない**。
- 5xx は `const retriable = response.status === 429 || !budgeted && response.status >= 500`（`llm.ts:324`）で、予算下では再試行対象から外れる。
- `openStreamWithRetry` も同一（`llm.ts:340`, `:346`, `:352`, `:358`）。
- `paidModelRequest` は `createProvider` の `complete` 内で `maximum > 0` のときだけ true にされる（`llm.ts:1467`, `:1508`）。

差分・補足:

- 429 は予算下でも再試行する（`llm.ts:324`, `:358`）。「fetch 例外と 5xx」という主張の切り分けは正しい。
- 5xx は通常「リクエストが処理されていない = 課金されていない」可能性が高いため、この禁止は安全側に過剰である（**推測**。プロバイダ仕様依存）。
- `postWithRetry` は `listModels` など `complete` 外でも使われる（`llm.ts:1214`, `:1340`）。それらは予算コンテキスト外なので従来どおり再試行する。

影響:

- **完走率**: 中。USD 上限を設定した実行だけ、一時的な 502 / 接続断 1 回でターンが落ちる（予算なしなら最大 6 回再試行、`llm.ts:281`）。
- **コスト**: 小（過剰請求の防止という設計意図には合う）。

## 2. 主張 3-2 — 全コンテキスト窓で予約、例外時は最大値を settle、degenerate では settle しない

**判定: 正確（差分 3 点）**

事実:

- 予約額: `const context = role.contextWindowTokens`（`llm.ts:1503`）→ `const maximum = (context * pricing.inputPerMTokUsd + options.maxTokens * pricing.outputPerMTokUsd) / 1_000_000`（`llm.ts:1504`）→ `const settle = reserve(maximum)`（`llm.ts:1505`）。実際のプロンプト長ではなく**窓の全量**を入力単価で見積もる。
- 例外時: `catch` で `settle(maximum)`（`llm.ts:1511`）。`web-server.ts:2249` は `maximum === settled` なら何もしないため、**予約は最大値のまま確定**する（返金ではない）。
- degenerate: `if (result.degenerate || ... ) return result`（`llm.ts:1515`）で `settle` を呼ばずに返る。`reservedCostUsd` は `maximum` のまま残る（`web-server.ts:2245` で加算、減算は `settle` のみ `web-server.ts:2248-2252`。他に書き換え箇所は無い）。

差分:

1. `mock` / `ollama` は予約対象外（`llm.ts:1496`）。`pricing` 未設定は予約前に例外（`llm.ts:1497-1502`）。
2. **同じ「settle しない」は degenerate だけではない**。`!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens) || inputTokens <= 0 || outputTokens < 0` でも早期 return する（`llm.ts:1515`）。usage を返さないエンドポイント（例: `stream_options` を拒否して落とした場合 `llm.ts:478`、usage 無しのストリーム）はこの経路で予約を残す。
3. `reservedCostUsd` は orchestration レコードに永続化され（`web-server.ts:2245`, `:2250`）、orchestration 終了まで戻らない。

影響（**大**）:

- 予約は「窓全量 × 入力単価 + 出力上限 × 出力単価」。既定 `deepseek` ロールは `contextWindowTokens: 1_048_576` / `maxOutputTokens: 262_144`（`config.ts:626-639`）。単価を入力 $0.28/Mtok・出力 $0.42/Mtok と仮定すると 1 リクエスト ≈ **$0.40**（単価は例）。上限 $2.00 なら**同時 5 本**で枠が埋まる。
- degenerate 1 回で $0.40 が残留し、直後の再試行がさらに $0.40 を予約する（`agent.ts:876-891` の 1 回リトライ）。数回で上限に達し、次の要求は `web-server.ts:2243` の `Error`（`LlmError` ではない）で失敗する。これは `agent.ts:768-789` の catch（context overflow / tools 拒否のみ処理）を素通りしてターンごと落ちる。
- **コストの過小計上ではなく過大計上**（安全側）だが、完走率を大きく落とす。

## 3. 主張 3-3 — `Budget4D` が `cachedInputPerMTokUsd` を無視

**判定: 正確**

事実:

- `cachedInputPerMTokUsd` は型として宣言されるだけ（`budget.ts:19`）で、`budget.ts` 内に読み取り箇所が無い（リポジトリ全体の grep でも `budget.ts` は宣言のみ）。
- `record`: `this.costUsd += (usage.inputTokens * p.inputPerMTokUsd + usage.outputTokens * p.outputPerMTokUsd) / 1e6`（`budget.ts:146-149`）。`completion.usage` の `cacheHitTokens` は使わない（呼び出し `budget.ts:173`）。
- `admit` の最悪コスト見積りも全入力を通常単価で計算（`budget.ts:133`）。
- 対照的に `llm.ts:1517` は `(inputTokens - cached) * input + cached * (cachedInputPerMTokUsd ?? input)` とキャッシュ単価を反映する。

差分:

- 影響するのは `Budget4D` を使う `hy ralph` のみ。オーケストレーション経路は `llm.ts:1517` なので正しく反映される。

影響（**中〜大**、ralph の完走率）:

- 例: 入力 200k のうち 180k がキャッシュヒット、通常 $1.00/Mtok・キャッシュ $0.10/Mtok とすると実費 ≈ **$0.038** に対し計上は **$0.20**（約 5 倍、単価は例）。HY は system prompt を byte 一致で維持する設計（`agent.ts:725` のコメント）なのでキャッシュヒットは常態であり、ralph の USD 上限は実費より早く尽きる。
- 過少計上ではないため「上限を超えて課金される」危険は無い。

## 4. 主張 4-a — 降格時に `brokenRetried` を戻さないため、直後の 1 回の書式ミスで失敗

**判定: 正確**

事実:

- `retryProtocol`（`agent.ts:860-872`）: `if (brokenRetried && native) { native = false; protocolFallback = true; ... }`（`agent.ts:861-863`）。**`brokenRetried` は false に戻さない。**
- 降格後、呼び出しでも final でもない返答は `if (protocolFallback && brokenRetried) return failReply(step, 'tool-protocol', ...)`（`agent.ts:975-976`）で即失敗。テキストプロトコル本来の再試行（`agent.ts:977-980`）に到達しない。
- `brokenRetried` が戻るのは「ツール呼び出しが 1 つでも成功したとき」（`agent.ts:1106`）と steer 割込み時（`agent.ts:701-703`）だけ。

検証（既存テスト）:

- `agent.test.ts:573`「a broken pseudo tool call is retried natively, then tries the text protocol before stalling」が、同一の壊れた返答 3 回で `retries.length === 2`（`agent.test.ts:610-612`）→ `outcome === 'stalled'` を**仕様として固定**している。主張の挙動は現行テストで再現済み。

影響（**中**）:

- ネイティブ 2 回 + テキスト 1 回で打ち切り。プロトコルが変わった直後の 1 回は書式の揺れが起きやすいため、完走率を落とす。
- 修正はテストの期待値更新を伴う（「仕様」として固定されているため）。

## 5. 主張 4-b — 全コール blocked で待機復帰するとき `messages.push` とログをしない

**判定: 正確（差分: `turn/end` は記録される）**

事実:

- 待機復帰: `if (this.options.allowWaitingReply?.() && ...) { const final = 'Waiting for the active workers. ...'; sessionLog.append('turn/end', { status: 'completed', reason: 'waiting-for-workers' }); onEvent({ type: 'final', ... }); return {...} }`（`agent.ts:1156-1161`）。
- この分岐には `messages.push(reply(final))` が無く、`assistant/message` の記録も無い（同分岐内に `append('assistant/message')` は無い）。
- 対照: 通常の最終返答は `turn/end`（`agent.ts:1090`）→ `messages.push(reply(content))`（`agent.ts:1091`）→ `final` イベント。`assistant/message` はその前段で記録済み（`agent.ts:1022`）。
- この時点で `messages` の末尾は、直前に push した assistant の呼び出し文（`agent.ts:1100`）と **ユーザーのツール結果**（`agent.ts:1142-1156`）である。

影響:

- 返却 `history = messages.slice(1)` の末尾が user。ログ由来の履歴も同じ末尾になる（`rebuildHistory` は `assistant/message`（`agent.ts:275-277`）と `tool/result`（`agent.ts:349-357`）から同じ並びを作る）ため、両者は一致する（再開時の再送は壊れない）。
- 次ターンは user が連続する。Anthropic は同一ロールを結合し（`llm.ts:1178-1180`）、Gemini はテキスト化（`llm.ts:1022`）、OpenAI 系はそのまま送るため**例外にはならない（推測）**。
- 実害は**可視性**: ログに最終文が無いため、`projectChat`（`chat-projection.ts:229`、`turn/end` の case が無い）でリロード後にこの行が消え、`exportMarkdown`（`transcript-export.ts:94-96` は `assistant/message` のみ）でも出ない。実行中のストリーム表示だけに残る。
- モデルも次ターンで「自分が待機を宣言した事実」を持たない。ただしツール結果が末尾にあるため自然に継続できる（**推測**）。

## 6. 主張 4-c — `blockedSteps` が通算、`unchanged` が shell / run_code 後にクリアされない

**判定: 正確（後半は影響を限定して評価）**

事実（前半）:

- `let blockedSteps = 0`（`agent.ts:664`）、リセットは steer 割込み時のみ（`agent.ts:701-703`）。
- 加算は `if (++blockedSteps >= 2 && ...) return failReply(step, 'tool-no-progress', ...)`（`agent.ts:1163-1164`）。**成功した step では 0 に戻らない**ため、1 ターン内の通算 2 回で停止する。
- 加算されるのは「その step の全呼び出しが `blocked`」のときだけ（`agent.ts:1156`）。`blocked` は同一呼び出しが同一結果を既に 3 回返した場合（`agent.ts:1207-1209`）。

事実（後半）:

- `unchanged.clear()` は「`working_directory` のパス変更」「`apply_patch` / `write_file` / `edit_file`」のときだけ（`agent.ts:1213-1216`）。
- `shell` は `observe([exitCode, timedOut, stdout, stderr])`、`run_code` は `observe(raw)` のみ（`agent.ts:1217-1221`）。**ファイルを変更してもクリアされない。**
- 他にクリアされるのは steer 割込み（`agent.ts:701`）と 32 step 経過の間引き（`agent.ts:1101`）。

影響評価:

- 前半は**実害あり**（早期 stall）。多数の成功 step を挟んでも、全 blocked の step が 2 回出た時点で `tool-no-progress` でターンが終わる。
- 後半は**影響は限定的**。`unchanged` は結果キャッシュではなく回数カウンタで、ツールは毎回実行される（`agent.ts:1211`）。ファイル内容が変われば結果 hash が変わり `count` は 1 に戻る（`agent.ts:1203`）。実害が出るのは「shell / run_code が変更したのに、その呼び出しの出力が同一のまま」のケースで、no-progress 判定が早期に成立し、前半の通算と合わさって stall しやすくなる（**推測**）。

補足: `tool-no-progress` を検証するテストは無い（grep で 0 件）。

## 7. 主張 4-d — `stripFences` / 複数 `<function>` / 型なし引数

**判定: 正確（3 点とも実測で確認）**

### 7.1 未閉じフェンス内の不完全 JSON が最終回答になる

事実:

- `stripFences` は `/(?:```|~~~)[\s\S]*?(?:(?:```|~~~)|$)/g`（`reply-guard.ts:41-43`）。**閉じフェンスが無ければ `$`（末尾）まで消す。**
- `looksLikeBrokenToolCall` は冒頭でこれを適用（`reply-guard.ts:97`）。
- 未検出のまま native モードでは `action = { final: content }`（`agent.ts:969-970`）になり最終回答として扱われる。検出は `agent.ts:944`。

実測（`packages/core/dist/reply-guard.js`）:

```text
unclosedFence:false   plainBroken:true   closedFenceBroken:false
```

- 未閉じフェンス入りの不完全 JSON → `false`（壊れた呼び出しとして扱われない）
- 同じ本文をフェンス無しにすると → `true`（正しく検出）
- 閉じフェンス → `false`（「例」として無視する設計どおり）

テキストモードでは同条件でも `TEXT_PROTOCOL_RETRY` が入る（`agent.ts:977-1009`、push は `agent.ts:1008`）ため、最終回答化するのは native モード経路である。

### 7.2 複数 `<function>` の並列呼び出しを拒否

事実:

- ラッパー（`tool_call` / `tool_calls` / `function_call`、`reply-guard.ts:346`）は子要素が 1 個のときだけ再帰し、複数なら `undefined`（`reply-guard.ts:520-529`。コメントも「More than one element would drop a call, so it is refused instead.」）。

実測:

```text
pluralWrapper= undefined
singleWrapper= "{\"tool\":\"read_file\",\"args\":{\"path\":\"a\"}}"
```

### 7.3 数値・真偽値が文字列で返る

事実:

- `xmlArgumentValue` は `el.attrs.string === 'false'` のときだけ `JSON.parse`、それ以外は生テキスト（`reply-guard.ts:469-483`）。同じ規則がハイブリッド経路にもある（`reply-guard.ts:286-310` の `string === 'false' ? JSON.parse(raw) : raw`）。

実測:

```text
typedXML=   {"tool":"shell","args":{"timeoutMs":"5000","background":"true"}}
typedMarked={"tool":"shell","args":{"timeoutMs":5000,"background":true}}
```

影響:

- 数値は各ツールが `Number(...)` で吸収する箇所が多い（`tools.ts:1828-1829`, `tools.ts:2191`）。
- 真偽値は厳密比較（`tools.ts:1719` の `args.ignoreCase === true`）なので、文字列 `"true"` は**フラグが立たない**（事実 + その帰結は**推測**）。実テンプレートは `string="false"` を付けるのが通例だが、付けないモデルでは黙って挙動が変わる。

### 7.4 追加（主張外）: 引数なし XML 呼び出しの取りこぼし

事実: `xmlArguments` は引数 0 個で `undefined`（`reply-guard.ts:485-502`、判定は `:501`）。実測で `<function=current_time></function>` は `looksLikeBrokenToolCall` が `false`、`recoverXmlToolCall` も `undefined` になる。

```text
noArgXml_broken= false
noArgXml_recover= undefined
```

したがって native モードでは、引数なしツールの XML 呼び出しが**最終回答として表示される**（7.1 と同じ結末）。

## 8. 既存テストのカバレッジ

| 項目 | 該当テスト | 状態 |
| --- | --- | --- |
| 3-1 予算下の再試行禁止 | 無し（`llm.test.ts:488` は予算外経路の 429/5xx 再試行） | 未検証 |
| 3-2 予約・settle・リーク | 無し（`withModelBudget` を参照するテストが 0 件） | 未検証 |
| 3-3 キャッシュ単価 | 無し（`budget.test.ts:54` の pricing に `cachedInputPerMTokUsd` が無い） | 未検証 |
| 4-a 降格後の即失敗 | `agent.test.ts:573`（`assert` は `:610-612`） | 現挙動を固定 |
| 4-b 待機復帰の履歴・ログ | 無し（`agent.test.ts:1399` は nudge 抑止の別経路） | 未検証 |
| 4-c 通算 `blockedSteps` / `unchanged` | 無し（`tool-no-progress` の文字列はテストに 0 件） | 未検証 |
| 4-d フェンス・複数 XML・型 | `reply-guard.test.ts:236-296`（XML 復元と `string="false"` はあり。未閉じフェンスの case は無い） | 一部 |

## 9. 追加所見（主張に無いもの）

| # | 内容 | 根拠 | 影響 |
| --- | --- | --- | --- |
| A1 | usage 欠落（`inputTokens <= 0` / 非有限）でも `settle` されず予約が残る。`stream_options` を落としたエンドポイントは必ずこれになる | `llm.ts:1515`, `llm.ts:478` | 3-2 と同じリーク。かつ実費が orchestration の台帳に載らない |
| A2 | 予約超過の拒否は素の `Error` で、`agent.ts` の catch を素通りしてターンが落ちる（`BudgetExhaustedError` ではない） | `web-server.ts:2242-2243`, `agent.ts:768-789` | 予算切れが「内部エラー」として扱われる |
| A3 | `reservedCostUsd` は永続化され、worker 終了・ターン終了でリセットされない | `web-server.ts:2245`, `:2250`, `orchestration.ts:71`, `:125` | リークが orchestration の寿命まで累積 |
| A4 | ralph の `Budget4D` は `tokensUsed` を input+output で数えるが、コストは全入力通常単価 | `budget.ts:147-149` | キャッシュ常態の HY では USD 上限が実費の数倍早く尽きる |
| A5 | 3-1〜3-3、4-b、4-c に検証テストが無い（4-a は現挙動を固定） | 第 8 節 | 回帰検出できない |
| A6 | `--max-cost-usd` の help は「default 2.00」だが、config 既定は `undefined`（project 設定時のみ 2 に丸め） | `main.ts:184`, `config.ts:947-956` | USD 上限が「既定で効いている」と誤解させる |

## 10. 影響のまとめ

| 領域 | 影響 | 主因 |
| --- | --- | --- |
| コスト（過大計上） | 中〜大 | 3-2（窓全量予約 + degenerate リーク）、3-3 / A4（キャッシュ単価の無視） |
| コスト（暴走の抑止） | 現状維持 | 3-1 は保守的すぎるが安全側 |
| 完走率（予算あり） | 大 | 3-1（5xx で即失敗）、3-2（予約で枠が埋まる）、A2 |
| 完走率（ループ） | 中 | 4-a（降格後の 1 回で失敗）、4-c 前半（通算 2 回で stall） |
| 可視性・履歴 | 中 | 4-b（最終文がログ・履歴に無い）、4-d（不完全呼び出しが最終回答になる） |
| キャッシュ | 小（直接の影響なし） | 3-1 はキャッシュに触れない。3-3 はキャッシュ単価を無視するため実費と乖離 |

## 11. 未確認事項

1. 実プロバイダでの再現は未実施（API キーと課金を伴うため）。3-2 のリークと 4-b の次ターン挙動はコードからの推論を含む。
2. 5xx が「課金されない」という前提はプロバイダ仕様依存（**推測**）。
3. 実行中 UI が `final` イベントをどう保持するかは未確認。リロード時に `projectChat` から消えることは確認済み（`chat-projection.ts` に `turn/end` の case が無い）。
4. `packages/core/dist` は src より新しいビルド（`reply-guard.js` 2:10 > `reply-guard.ts` 2:06）を用いた。dist と src の一致は mtime と該当コードの目視のみで、ハッシュ比較はしていない。
5. A2 の「ターンが落ちる」先（session が failed になるか interrupted か）は未確認。

## 付録 A: 既存監査文書との差分

| 既存の記述 | 現行コード | 判定 |
| --- | --- | --- |
| `prompt-and-toolcall-assumptions.md:57`, `:164` はフェンス内不完全 JSON を「**要確認**（一貫しない）」 | `reply-guard.ts:41-43` + `agent.ts:969-970` | 本検証で**正確**と確定（未閉じフェンスのみ。閉じフェンスは設計どおり無視） |
| 同 `:60` の `brokenRetried` は `agent.ts:1038` / 降格は `agent.ts:796-804` | `agent.ts:1106` / `agent.ts:860-872` | 行番号が古い。内容は一致 |
| `llm-provider-assumptions.md:165` の「予算付きでは 5xx を再試行しない（`llm.ts:323`, `:357`）」 | `llm.ts:324`, `:358` | 内容は一致。行番号が 1 行ずれ |
| `00-verified-findings.md:16` の S-2「`gemini-3.8-flash` の価格を `llm.ts:1508` にハードコード」 | `llm.ts:1479-1481` は role / catalog のみ。`gemini-3.8-flash` の直書きは無い | 現行コードには存在しない（修正済みと**推測**） |
| `context-and-token-assumptions.md:43`「`admit()` は ralph でしか使われない」 | `main.ts:945-963`（ralph のみ）、`session-app.ts:1287` は `budget=undefined` | 一致 |

---

検証件数: 主張 7 項目（3-1〜3-3、4-a〜4-d）すべてに判定と根拠。追加所見 6 件。実測プローブ 2 回（11 出力）。未確認 5 件。
