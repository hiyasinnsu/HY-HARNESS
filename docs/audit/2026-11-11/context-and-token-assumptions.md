# C: 文脈長・トークン計測・圧縮・ロール構成の監査

対象: `F:\HY-HARNESS`（2026-11-11 時点の作業ツリー）
範囲: `packages/core/src/agent.ts`, `tokens.ts`, `config.ts`, `model-catalog.ts`, `ledger.ts`,
`memory-pipeline.ts`, `packages/seams/src/{spill-compaction,budget,guardian}.ts`,
`packages/hy-cli/src/{session-app,session-title-gen,usage,doctor,main}.ts`, `packages/core/src/llm.ts`。
ソースは一切変更していない。

## 0. 表記

- **事実**: この監査で `read_file` / `search_grep` により行番号まで確認した記述。付録 A に一覧。
- **推測**: コードから読み取れるが、実 API・実モデルでの再現を取っていない記述。文中に `(推測)` と明記する。
- 判定の語: **妥当**（意図と実装が一致）/ **過剰**（一般化できるのに特定名で分岐）/ **誤り**（前提が実装と食い違う）/ **要確認**（実 API で確かめる必要がある）。
- 既存文書との関係: `docs/implementation_status.md:161-165` が Spill/Compaction の仕様、`:277` が既知の取りこぼし、
  `:342` が CP-23（トークン計測）、`docs/troubleshooting.md:36-38` が「reasoning が出力予算を食う」症状を既に記載している。
  本レポートはそれらと重複する箇所を「既知」と注記し、差分（実装と文書の食い違い、未知モデル側の穴）を中心に書く。

---

## 1. 一覧表: 特定モデル・特定プロバイダで挙動が変わる箇所

| # | 場所 (file:line) | 現在の条件 | 何のための分岐か | 根拠 | 判定 | 汎用化案 |
|---|---|---|---|---|---|---|
| C-1 | `packages/hy-cli/src/session-app.ts:1582-1587` | `cacheCompaction = (provider==='opencode' \|\| provider==='deepseek') && compactor と provider/model/baseUrl/key が一致` | 圧縮要約で会話の先頭を再利用（プロバイダのプレフィックスキャッシュに当てる）ため | 事実: `cacheCompaction` は `replayTools` になり `spill-compaction.ts:181-185, 312-314` の分岐を選ぶ。`model-catalog.ts:27` の `capabilities.cache` には**読み手が無い**（`capabilities` の参照は `model-catalog.ts:152` の `vision` 判定と、`main.ts:762-765` の `hy models` 表示の tools/vision/reasoning だけ） | **過剰** | 判定を「compactor が同一ルート」＋「カタログの `cache:true` またはロール設定 `cache`」に置き換える。Gemini/Anthropic も `cache:true` なのに今は対象外 |
| C-2 | `packages/hy-cli/src/session-app.ts:1071`、`packages/hy-cli/src/session-title-gen.ts:81` | `role.effort ?? (provider==='opencode' ? 'none' : undefined)` | 要約・タイトル生成で reasoning に 160/48 トークンを使い切らせない | 事実: `llm.ts:657` が `effort` を `reasoning_effort` として送る。`model-catalog.ts:27` に `capabilities.reasoning` があるが判定には未使用 | **過剰** | `role.effort ?? (catalog.reasoning ? 'none' : undefined)`。DeepSeek 直・Anthropic でも同じ症状が出る（`docs/troubleshooting.md:36-38` が既知） |
| C-3 | `packages/hy-cli/src/session-app.ts:677-681, 721-724, 1067, 2082` | `provider === 'mock'` なら `Mock*Provider` | オフライン E2E と `--mock` 用 | 事実: 4 箇所に同じ形が散在（compactor / guardian / summarizer / grader） | **妥当**（理由は正しい） | 分岐自体は残してよいが、`LazyProvider`（`llm.ts:1144-1160`）と同じ場所に provider ファクトリを 1 つ作り、`mock` 判定を 1 箇所に寄せる |
| C-4 | `packages/core/src/config.ts:764-775` + `packages/core/src/model-catalog.ts:32-35` | ロールは常に `defaultRole(provider)` の `contextWindowTokens`/`maxOutputTokens` を継承し、**モデル名では引き直さない** | 素早い既定値の提供 | 事実: `config.ts` は `MODEL_CATALOG`/`catalogForRole` を一切 import していない（grep 0 件）。カタログ側のコメントは「role が指定しないときエントリが埋める」と書いてあるが、その実装がない | **誤り**（文書と実装が不一致） | 解決順を `role 明示 > catalog(provider:model) > provider 既定` にする。カタログに無いモデルは保守的既定（例 32,768）に落とす |
| C-5 | `packages/core/src/llm.ts:1534` | `Math.max(role.contextWindowTokens, catalogForRole(role)?.contextWindowTokens ?? 0)` | 費用予約の最悪値計算 | 事実: ユーザーが「プロキシの実上限は 64k」と小さく設定しても、カタログ値の方が大きければ**大きい方**が使われる | **誤り** | `role.contextWindowTokens` を優先し、カタログは role が未設定のときだけ使う。上限見積りは「小さい方を信じる」のが安全側 |
| C-6 | `packages/core/src/model-catalog.ts:130-134` | `/(^o\d\|gpt-5\|gpt-6\|reason)/i` で `max_completion_tokens` を選ぶ | OpenAI 系のトークン上限フィールド名の差 | 事実: カタログに無いモデル名でこの正規表現に落ちる。`llm.ts:430-441` に 400 を見て切り替えるフォールバックが既にある | **要確認**（ヒューリスティックとしては許容、ただし一次手段にすべきでない） | 400 フォールバックを一次手段にし、名前ヒューリスティックは初期値だけ。判定材料はエラーボディ（実装済み） |
| C-7 | `packages/core/src/model-catalog.ts:137-141` | `!/gpt-6\.1-terra/i.test(model)` | そのモデルが `reasoning_effort` と tools の同時指定を拒むため | 事実: カタログ `compat.effortWithTools` が優先。`llm.ts:444-448` に 400 フォールバックもある | **妥当**（実測に基づく除外）だがモデル名ハードコード | カタログ `compat` に寄せ、名前ヒューリスティックは撤去。未知モデルは 400 で 1 回だけ落とす |
| C-8 | `packages/core/src/llm.ts:466-467` | `sendsReasoning = provider==='deepseek' \|\| /deepseek/i.test(model)` | 過去の reasoning を `reasoning_content` として送り返す | 事実: `llm.ts:656` がこのフラグで履歴を組み替える。他プロバイダは reasoning を送らない | **要確認** | 「reasoning を履歴に戻せる」を capability にし、既定 off。400/422 を受けたら自動で off にする（今はモデル名一致のみ） |
| C-9 | `packages/core/src/llm.ts:1499-1512` | `gemini-3.8-flash` の固定価格（2027-01-01 で 2 倍）と `opencode.ai/inference/go` は 0 円 | 費用予約と USD 予算のため | 事実: 価格表がカタログ（`model-catalog.ts`）と `llm.ts` の 2 箇所に分散し、片方は日付分岐 | **要確認**（日付で単価が変わる前提が本当か未検証。0 円扱いは予算を無効化する） | 価格はカタログ 1 箇所に集約。日付・プラン依存は設定ファイルで表現し、不明なら「USD 予算は使えない」と明示エラー（`budget.ts:64-81` の既存挙動に合わせる） |
| C-10 | `packages/seams/src/spill-compaction.ts:181-185` | `replayTools` があると `afterResponse` が即 return | C-1 のキャッシュ経路では事前要約をしない（同期経路で先頭を再利用するため） | 事実: `replayTools` は `agent.ts:673` で `cacheCompaction` のときだけ渡る | **過剰** | 「事前要約」と「prefix 再利用」は排他ではない。事前要約だけ常時有効にし、同期要約で prefix を使うかどうかだけを分ければよい |
| C-11 | `packages/seams/src/spill-compaction.ts:312-314` | 同期 replay は `lastInputTokens>0` かつ `effectiveTokens < window*0.95` かつ画像 0 枚 | 窓ぎりぎりで要約リクエスト自体が 400 になるのを避ける | 事実: `0.95` はハードコード。画像があると replay しない | **妥当**（安全弁）だが閾値が固定 | `0.95` を `limits` に出す。画像は「画像だけ落とした prefix」で replay できる余地がある |
| C-12 | `packages/hy-cli/src/doctor.ts:53-59` | `KEYLESS = {mock, ollama}`、env 名は provider 名の三項演算子チェーン | 認証情報の有無を診断 | 事実: `role.apiKeyEnv` を尊重しつつ、既定 env 名を provider で決めている。`config.defaultRole` も同じ env 名を持つ（二重管理） | **過剰** | env 名は `defaultRole` だけが持ち、doctor は `role.apiKeyEnv` を読む。未知 provider の既定 `OPENAI_API_KEY` も不要になる |
| C-13 | `packages/hy-cli/src/doctor.ts:100-104` | 検査するのは worker / grader / compactor の 3 ロールのみ | 主要ロールの確認 | 事実: `summarizer` / `advisor` / `orchestrator` / `subagent` / `guardian` は未検査。summarizer は思考要約（`:1068`）と自動メモリ抽出（`:1185`）で使われる | **誤り**（不足） | `HarnessConfig` のロールを列挙して回る（型で漏れを防ぐ）。少なくとも summarizer は必須 |
| C-14 | `packages/hy-cli/src/session-app.ts:671` と `:1474`、`:2147-2157` | `contextWindowTokens: config.role.contextWindowTokens` を**構築時に 1 回だけ**読む。`/model` は `context` を作り直さない | 圧縮トリガと `get_context_remaining` の基準 | 事実: `sessionContext(...)` は `:1280` で 1 回だけ呼ばれる。`setModel` は `this.agent` だけ作り直す | **誤り** | `contextWindowTokens` を数値で渡さず `() => number` にする（`ledgerKeys` や `goal` と同じくクロージャで渡す）。`tools.ts:251` も同様 |
| C-15 | `packages/hy-cli/src/session-app.ts:2103` | grader に `maxTokens: role.maxOutputTokens` をそのまま渡す | 判定 JSON を出させる | 事実: grader ロールは worker を継承するので、DeepSeek 既定では **262,144** を要求する（`config.ts:590`）。同じ理由で `agent.ts:712` も毎ステップ `role.maxOutputTokens` を送る | **誤り** | grader は 512〜1,024 など用途別の固定上限にする（compactor 800 / summarizer 160 / guardian 256 は既にそうなっている）。worker 側は `min(maxOutputTokens, 窓 - 推定入力)` でクランプする |
| C-16 | `packages/core/src/llm.ts:425-427` | OpenAI 系以外は無条件に `max_tokens` | プロトコル差の吸収 | 事実: `tokenFieldFor` を呼ぶのは 3 プロバイダのみ | **妥当** | 変更不要 |

補足（事実）: `config.ts:585-588` のコメントは「クライアントが出力を `compactionTriggerRatio` の残り 25% に制限するので input + max_tokens は窓を超えない」と書いているが、
そのクランプは `packages/core/src/llm.ts` にも `agent.ts` にも存在しない（`maxTokens` の出現は `llm.ts:394,500,657,1080,1238,1348,1535` のみで、いずれも素通し）。
クランプに相当するのは `budget.ts:118-141` の `admit()` だけで、これは ralph（`main.ts:946`）でしか使われない。→ **文書と実装が食い違っている**。

---

## 2. 未知モデル / 未知タスクでの破綻シナリオ

| # | 発生条件 | 症状 | 影響 | 検出方法 | 修正方針 |
|---|---|---|---|---|---|
| S-1 | カタログに無いモデルを、窓の大きい provider（`openai-compatible` = 1,047,576 / `opencode` = 1,000,000）で指定（`config.ts:600,631`） | 圧縮トリガが `0.75 × 1,047,576 ≈ 786k` になり一度も発火しない。実窓を超えた時点で provider が 400 を返し、ターンごと失敗 | **大**（長いセッションが必ず落ちる） | `token/estimate`（`agent.ts:735-743`）の `ratio` と、400 のエラーボディ。400 を分類するコードが無い（grep: `context_length` 0 件） | (a) 未知モデルは保守的既定（32k）にする（C-4）。(b) `400` + `context`/`token`/`too long` を検出して「Tier 1 強制 → それでも駄目なら Tier 2 → 1 回だけ再試行」の経路を `agent.ts:718-728` に追加 |
| S-2 | usage を返さないプロバイダ（自己ホストの OpenAI 互換、一部ゲートウェイ） | `inputTokens = 0`（`llm.ts:415,710,1126` の `?? 0`）。`get_context_remaining` は `used:0, remaining:window, source:'provider'` を返し（`tools.ts:1197-1205`、`setUsage` は `agent.ts:745` で無条件）、モデルは「まだ全部残っている」と誤認。`afterResponse` の事前要約も永久に発火しない（`spill-compaction.ts:184`） | 中（誤った自己判断で長い作業を続ける／圧縮が遅れる） | `step/end` の `usage.inputTokens === 0` が続く。`token/estimate` の `actual:0` | `usage` が 0 のときは `source:'estimated'` と推定値を返す。`lastInputTokens` に推定値を入れて圧縮トリガを動かす（`beforeRequest` は既に `:227` で 1.35 倍のフォールバックを持つが、`afterResponse` には無い） |
| S-3 | 窓を実より**大きく**設定（S-1 と同じ）／**小さく**設定（`ollama` 既定 32,768 に対し実モデル 8k、`config.ts:575`） | 大きい: 400。小さい: 早すぎる圧縮で文脈を失う。Ollama は `num_ctx`（`llm.ts:397`）を超えた分を**黙って切り捨てる**可能性がある `(推測)` | 中〜大 | 圧縮イベントの頻度（`compaction/result`）と `ratio` の推移 | 窓は「宣言値」と「観測値」を分けて保持し、`usage.inputTokens > 宣言窓` を観測したら宣言値を引き上げて `session/app` に警告を出す |
| S-4 | 画像を多数添付（`MAX_IMAGE_MESSAGES = 16`、`spill-compaction.ts:68`） | `estimateTokens` は `content` しか数えない（`spill-compaction.ts:226`、`agent.ts:735`、`budget.ts:156`）。画像 16 枚分（1 枚 1,000 トークン前後とすると 1.6 万）が丸ごと過小評価 | 中（圧縮が遅れる／`remaining` が甘く出る） | `image/attached` イベントの枚数と `actual/estimated` 比 | 画像 1 枚あたりの固定係数（例 1,000）を推定式に加える。`tokens.ts` に `estimateMessages(messages)` を用意し、3 箇所の `map(m=>m.content).join` を置き換える |
| S-5 | `reasoningHistory: 'full'`（既定、`config.ts:966`）で reasoning を返すモデル | reasoning はリクエストに含まれる（`llm.ts:656`）が、推定は `content` のみ。毎ステップ数千トークンの過小評価 | 中 | `assistant/thinking` の長さと `actual/estimated` 比 | 推定に `m.reasoning?.length` を加える。`'full'` の既定はトークン費用が大きいので、圧縮時だけ落とす選択肢も用意する |
| S-6 | ネイティブツール + MCP カタログ（`agent.ts:672-673, 716`） | ツール定義は `options.tools` として messages の外に出るため推定に含まれない。MCP サーバが多いと定義だけで数千〜1 万トークン | 中 | `requestTools` のサイズ（JSON 文字数）をログに出す | `prompt.ts`/`tool-registry.ts` 側でツール定義の推定トークンを計算し、`beforeRequest` に渡して加算する |
| S-7 | `delegate` でサブエージェントに大量ファイルを読ませる | サブエージェントの `Agent` には `context` が渡っていない（`session-app.ts:1028-1062`）。spill も圧縮も無く、ツール出力は 20,000 文字で切り捨て（`agent.ts:470, 1155`）。窓を超えると 400 でサブエージェントが失敗し、親にはエラーだけが返る | **大**（「大量ファイル」という代表的な未知タスクで壊れる） | サブエージェントの `step/end` に `usage.inputTokens` が窓へ接近する記録が残る | サブエージェントにも `context`（SpillCompaction）と `ledger` を渡す。少なくとも `toolOutput` の spill だけは共有する |
| S-8 | 長時間の対話セッション（`hy chat` / web） | 対話経路に `Budget4D` が無い（`session-app.ts:1280` の第 4 引数が `undefined`、`new Budget4D` は `main.ts:946` = ralph のみ）。`agent.ts:636` の step ループに上限が無い。止まるのはコンパクションとループガードだけ | 大（費用が無制限。トークン上限の設定が効かない） | `turn/end` の `usage` 累積 | 対話にも `Budget4D`（少なくとも tokens と USD）を既定で適用し、`--max-total-tokens` を効かせる。step 上限も `limits` に出す |
| S-9 | ralph で窓の大きいモデルを使う | `maxTotalTokens` 既定 500,000（`budget.ts:32`）は**リクエストごとの入力を累積**する（`budget.ts:146`）。200k 窓のモデルだと 3 リクエスト程度で `BudgetExhaustedError`（`budget.ts:125`） | 中（長いタスクが途中で止まる） | `budget exhausted (tokens)` のメッセージ | 「累積トークン」と「ピーク文脈」を別の次元に分ける。既定値をモデルの窓から導く（例 `窓 × 20`） |
| S-10 | 出力上限の大きいモデル（DeepSeek 262,144 / OpenCode 131,072） | `max_tokens` にそのまま送る（`agent.ts:712`, `session-app.ts:2103`）。provider が「prompt + max_tokens ≤ 窓」を強制すると 400 `(推測: OpenAI 系の一部はこの検査をする)` | 中 | 400 のボディ | `min(maxOutputTokens, 窓 - 推定入力 - 余白)` でクランプする。`config.ts:585-588` のコメントが約束している挙動を実装する |

**自動回復経路の不在（事実）**: `packages/core/src/llm.ts` と `agent.ts` にコンテキスト超過を分類する処理は無い。
`agent.ts:718-728` の 400 ハンドリングは `native && /tool/i.test(error.message)` の 1 条件だけで、それ以外の 400 はそのまま throw する。
つまり S-1 / S-7 / S-10 は「ターン全損」で終わり、ユーザーが `/compact` を手で打つまで回復しない。

---

## 3. 数値の根拠（既定値）

| 値 | 意味 | 場所 | 備考 |
|---|---|---|---|
| `{ascii:0.3, nonAscii:0.6}` | トークン推定係数 | `packages/core/src/tokens.ts:15` | 全プロバイダ共通。DeepSeek の公表値由来（`:6-8` のコメント） |
| `ceil(ascii*0.3 + other*0.6)` | 推定式 | `packages/core/src/tokens.ts:17-25` | `content` のみ。画像・reasoning・tools 定義は対象外 |
| 0.5 〜 2 倍クランプ | 実測比の補正 | `packages/core/src/tokens.ts:50` | `calibratedCoefficients` は**テストでしか呼ばれていない**（本番の校正は `spill-compaction.ts:254` のインライン `ratio` のみ）。`implementation_status.md:342` の記述と実装がずれている |
| 1.35 | usage 不明時の安全係数 | `packages/seams/src/spill-compaction.ts:227, 254` | 推定の過小を 35% 補正 |
| `triggerRatio = 0.75` | 圧縮の発火比率 | `packages/seams/src/spill-compaction.ts:97`、`config.ts:882` | 未信頼プロジェクトでは `Math.min` でしか緩められない |
| Tier 1 の目標 `window × 0.75 × 0.8` | 一度に下げる先 | `packages/seams/src/spill-compaction.ts:270` | 発火のたびに細かく刈らないため |
| `keepRecentTurns = 2` | 直近何組を残すか | `packages/seams/src/spill-compaction.ts:98`、`config.ts:883` | 未信頼では `Math.max`（＝厳しくできない。ここだけ向きが逆） |
| `thresholdBytes = 32 * 1024` | spill に送る出力サイズ | `packages/seams/src/spill-compaction.ts:96`、`config.ts:881` | **バイト**判定 |
| `HEAD = TAIL = 4_000` | spill 時に見せる先頭・末尾 | `packages/seams/src/spill-compaction.ts:52-53` | **文字**単位。日本語 32KiB ≈ 10.9k 文字に対し 8k 文字見せるので削減率が小さい |
| `MAX_IMAGE_MESSAGES = 16` | 画像を保持する上限 | `packages/seams/src/spill-compaction.ts:68, 229` | トリガ超過時は `keepRecentTurns`（2）まで落ちる |
| 要約入力 2,000 文字/メッセージ | 圧縮プロンプトの切り詰め | `packages/seams/src/spill-compaction.ts:160` | 長いツール出力は要約時に見えない |
| 要約出力 800 トークン | compactor の上限 | `packages/seams/src/spill-compaction.ts:189, 312` | 300 語指定と整合 |
| replay 可否 `0.95 × window` | 同期 replay の安全弁 | `packages/seams/src/spill-compaction.ts:314` | ハードコード |
| `contextWindowTokens` 既定 | ollama 32,768 / deepseek 1,048,576 / openai-compatible 1,047,576 / openai-responses 1,047,576 / anthropic 200,000 / opencode 1,000,000 / gemini 1,048,576 / mock 32,768 | `packages/core/src/config.ts:575, 589, 600, 610, 621, 631, 645, 653` | カタログは `model-catalog.ts:42, 52, 61, 70, 79, 89, 98, 107`。値がほぼ重複 |
| `maxOutputTokens` 既定 | 8,192 / 262,144 / 32,768 / 32,768 / 32,768 / 131,072 / 65,536 / 4,096 | `packages/core/src/config.ts:576, 590, 601, 611, 622, 635, 646, 654` | `agent.ts:712` が毎ステップそのまま送る |
| `maxOutputTokens` の最終フォールバック | 4,096 | `packages/core/src/agent.ts:523` | `Agent` を直接使う経路（テスト・埋め込み）向け |
| 20,000 文字 | context manager 無しの切り詰め | `packages/core/src/agent.ts:470, 1155` | サブエージェントが該当（S-7） |
| 5 ラウンド / 500,000 トークン / 2 USD / 30 分 | Budget4D 既定 | `packages/core/src/config.ts:891-894`、`packages/seams/src/budget.ts:32` | 2 USD は `config.ts:887-888`。ralph のみ |
| 12 件 / 1,500 トークン | Ledger の上限 | `packages/core/src/ledger.ts:38, 161-175` | 超過は黙って捨てずエラー（OQ-5）。推定は `:152-153` |
| 5 件 / 6,000 文字 / 400 トークン | 自動メモリ抽出の上限 | `packages/core/src/memory-pipeline.ts:13-14, 103` | 入力は `:93` で切り詰め |
| 8,000 文字 / 256 トークン / 20 秒 | Guardian の予算 | `packages/seams/src/guardian.ts:130-131, 184-187` | 文字ベース。トークンとは独立 |
| 160 トークン / 6,000 文字 | 思考要約 | `packages/hy-cli/src/session-app.ts:1072, 1086` | 日本語化の再試行は `:1102` で 4,000 文字 |
| 48 トークン / 20 秒 | タイトル生成 | `packages/hy-cli/src/session-title-gen.ts:82, 91` | 入力は 4,000 文字（`:33`） |
| 24 件 / 12,000 文字 | ゴール判定の証拠 | `packages/hy-cli/src/session-app.ts:2118-2129` | 末尾 12,000 文字だけ |

---

## 4. 事実と推測の切り分け

**事実（コードで確認）**
1. カタログはロード時に参照されない（`config.ts` に import が無い）。未知モデルは provider 既定の窓を引き継ぐ（C-4）。
2. `capabilities.cache` は未使用（読み手なし）。`.tools` / `.reasoning` は `hy models` の表示（`main.ts:762-765`）だけで判定には使われず、`.vision` だけが判定に効く（`model-catalog.ts:152`）。
3. コンテキスト超過（400）を分類・再試行する経路は存在しない。
4. 対話セッションに `Budget4D` は無い（`session-app.ts:1280`）。
5. サブエージェントに `context` が無い（`session-app.ts:1028-1062`）。
6. `/model` 切替後も圧縮トリガの窓は古いまま（C-14）。
7. `calibratedCoefficients` は本番未使用（`tokens.test.ts` のみ）。
8. 推定式は画像・reasoning・ネイティブツール定義を数えない（3 箇所とも `content` のみ）。
9. spill の閾値はバイト、見せる範囲は文字（`spill-compaction.ts:52-53, 96`）。
10. `config.ts:585-588` の「25% にクランプする」というコメントに対応する実装が無い。
11. `keepRecentTurns` だけ未信頼プロジェクトで厳しくできない（`config.ts:883` が `Math.max`）。
12. `docs/implementation_status.md:277` は「要約のリクエストは … 会話の先頭を使い回してはいない」と書くが、実装には先頭を再利用する replay 経路がある（`spill-compaction.ts:312-323`、`cacheCompaction` のときだけ）。文書が古い。

**推測（(推測) と明記）**
1. (推測) Ollama は `num_ctx` 超過分を切り捨てて 400 を返さない。返さないなら S-3 は「静かな文脈喪失」になる。
2. (推測) OpenAI 系の一部は「prompt + max_tokens ≤ 窓」を検査して 400 を返す。返すなら S-10 は未知モデルで頻発する。
3. (推測) 画像 1 枚あたり 1,000 トークン前後。プロバイダ・解像度で大きく変わる。
4. (推測) Gemini / Anthropic のキャッシュは C-1 の replay 経路に載せられる（`cache:true` を持っているため）。実際のヒット率は未測定。
5. (推測) `reasoningHistory:'full'` の reasoning は DeepSeek 実測でステップあたり 1〜3k トークン。実ログでの集計は未実施。

---

## 5. 優先度の高い汎用化 トップ 5

1. **未知モデルの窓・出力上限を保守的にする（C-4 / C-5 / S-1 / S-10）**
   解決順を `role 明示 > catalog > provider 既定` にし、カタログに無ければ 32k 程度に落とす。同時に `max_tokens` を
   `min(maxOutputTokens, 窓 - 推定入力 - 余白)` でクランプする。1 箇所（`config.resolveRole` と `agent` のリクエスト組み立て）で直り、
   「未知モデルで API 400」という最も致命的な失敗を消せる。

2. **コンテキスト超過 400 の自動回復（S-1 / S-7 / S-10）**
   `LlmError.status === 400` かつボディが `context` / `token` / `too long` / `maximum` を含む場合に、
   そのターンで 1 回だけ「Tier 1 強制 → 必要なら Tier 2 → 再試行」を行う。`agent.ts:718-728` の隣に 10 行程度で入り、
   未知プロバイダ全般の保険になる。分類関数は `llm.ts` の `alternateTokenField`（`:430-441`）と同じ形で書ける。

3. **`contextWindowTokens` を遅延評価にし、`/model` に追随させる（C-14 / S-3）**
   `SpillCompactionOptions.contextWindowTokens` と `ToolRuntime` の同オプションを `() => number` にする。
   `setModel` のたびにコンテキストを作り直すより安全で、呼び出し側の変更も小さい。

4. **provider 名の分岐を capability に置き換える（C-1 / C-2 / C-8）**
   `capabilities.cache` / `.reasoning` を実際に読み、`cacheCompaction` と `effort:'none'` を capability 駆動にする。
   DeepSeek 直・Gemini・Anthropic が同じ扱いになり、新しいプロバイダを足すときに `session-app.ts` を触らなくて済む。

5. **トークン推定を 1 関数に集約する（S-2 / S-4 / S-5 / S-6）**
   `estimateMessages(messages, { images, reasoning, tools })` を `tokens.ts` に置き、`agent.ts:735`、`spill-compaction.ts:226`、
   `budget.ts:156` の 3 箇所を置き換える。usage が 0 のときは `source:'estimated'` を返して圧縮トリガを動かす。
   これで「usage を返さないプロバイダ」「画像」「reasoning」の 3 つの過小評価が同時に消える。

次点: サブエージェントへの `context` 供給（S-7）と対話セッションへの `Budget4D`（S-8）。
どちらも影響は大きいが、上の 5 つに比べると変更範囲が広い（`delegate` の配線と CLI の既定値変更）ため次点とした。

---

## 付録 A: 確認した file:line（実ファイルで read_file / search_grep 済み）

`packages/core/src/tokens.ts` 15, 17-25, 37, 50 ／
`packages/core/src/model-catalog.ts` 27, 32-35, 42, 52-53, 61-62, 70, 79, 89, 98, 107, 130-134, 137-141, 144-148, 152 ／
`packages/core/src/config.ts` 575-576, 585-590, 600-601, 610-611, 621-622, 631-635, 645-646, 653-654, 764-775, 808-819, 821-829, 879-883, 891-894, 966 ／
`packages/core/src/agent.ts` 158-163, 470, 523, 636, 672-673, 716, 718-728, 730-736, 745, 1155 ／
`packages/core/src/ledger.ts` 38, 152-153, 161-175 ／
`packages/core/src/memory-pipeline.ts` 13-14, 93, 103 ／
`packages/core/src/llm.ts` 397, 415, 425-427, 430-441, 444-448, 466-467, 656-657, 710, 1126, 1144-1160, 1238, 1499-1512, 1534-1535 ／
`packages/core/src/tools.ts` 251, 749, 1197-1205 ／
`packages/seams/src/spill-compaction.ts` 52-53, 68, 74, 96-98, 160, 181-185, 189, 208-210, 226-229, 254, 263, 270, 276, 285, 312-314 ／
`packages/seams/src/budget.ts` 32, 64-81, 118-141, 146, 156 ／
`packages/seams/src/guardian.ts` 130-131, 184-187 ／
`packages/hy-cli/src/session-app.ts` 671, 677-681, 721-724, 1028-1062, 1067-1072, 1185, 1280, 1368, 1400, 1474, 1582-1587, 1592, 1933-1935, 2076-2082, 2103, 2118-2129, 2147-2157 ／
`packages/hy-cli/src/session-title-gen.ts` 33, 81-82, 91 ／
`packages/hy-cli/src/doctor.ts` 53-59, 100-104 ／
`packages/hy-cli/src/usage.ts` 31-67 ／
`packages/hy-cli/src/main.ts` 762-765, 772-774, 946, 1045-1051 ／
`docs/implementation_status.md` 161-165, 277, 342 ／
`docs/troubleshooting.md` 36-38

**確認した file:line の件数: 19 ファイル / 117 参照（単一行 52・範囲 65）。**

---

## 未確認事項

1. 実プロバイダでの再現は取っていない。特に (a) コンテキスト超過時の 400 のボディ形式、(b) Ollama の `num_ctx` 超過挙動、
   (c) 画像 1 枚あたりの実トークン数、(d) reasoning を履歴に戻したときの実トークン増分。いずれも API キーかローカルモデルが必要。
2. `reasoningHistory:'full'` の実際のトークン寄与は実ログ集計で確認していない（`token/estimate` の `ratio` 分布を見れば検証できる）。
3. `model-catalog.ts` の値（DeepSeek 393,216 出力、OpenCode Go 131,072 上限など）が現行 API 仕様と一致するかは未検証。
   `llm.ts:1499-1512` の Gemini 価格（2027-01-01 で 2 倍）も同様。
4. Gemini / Anthropic で C-1 の replay 経路を有効化した場合のキャッシュヒット率は未測定。
5. `budget.ts` の `admit()` が使う入力推定（`budget.ts:156`）が、ツール定義・画像・reasoning を無視した結果として
   USD 上限をどれだけ超過し得るかは定量化していない（ralph のみ該当）。
6. 他ワーカー（A: プロバイダ適応層、B: プロンプト/ツール呼び出し、D: 環境・配布）のレポートは未参照。重複する指摘
   （例: `llm.ts:466-467` の `sendsReasoning`）はオーケストレーター側で統合が必要。
