# LLM プロバイダ適応層とモデル能力カタログの監査（担当A）

- 監査日: 2026-11-11
- 対象: `packages/core/src/llm.ts`、`packages/core/src/model-catalog.ts`、`packages/core/src/config.ts`、`packages/core/src/config-schema.ts` と、それらを固定しているテスト・CLI・GUI 側の重複定義
- 範囲: リクエスト／レスポンスの変換のみ。`tool_calls` の解釈・修復（reply-guard、agent の JSON テキストプロトコル）は担当Bの範囲なので判定しない。
- 制約: コードは変更していない。本レポートのみ。行番号はすべて `read_file` / `search_grep` で実ファイルの内容を確認したものだけを書いた。
- 表記: **事実** = コードで確認した内容（file:line 付き）。**(推測)** = コードから推定したが実サーバでは未確認の内容。判断に迷うものは「要確認」。

---

## 0. 結論

1. **プロバイダ単位の分岐（Anthropic / OpenAI Responses / Gemini Interactions / Ollama）は妥当。** HTTP パス・ヘッダ・ボディ・応答ブロックが根本的に違うため、分岐ではなく別アダプタにするのが正しい。ここを無理に共通化すると壊れる。
2. **問題は「モデル名の文字列一致」で能力を推定している点。** `deepseek`、`gpt-6.1-terra`、`^o\d`、`gpt-5`、`gpt-6`、`reason`、`gemini-3.8-flash` の数系統がハードコードされ、カタログに無いモデルは文字列ヒューリスティックに落ちる（`model-catalog.ts:133`、`model-catalog.ts:140`、`llm.ts:467`、`llm.ts:1508`）。
3. **最も危険なのは、ストリーミング経路にだけ適応リトライが無いこと。** 非ストリーミングには「max_tokens が拒否されたら max_completion_tokens で1回だけ再送」「reasoning_effort と tools の衝突を検出したら effort を落とす」がある（`llm.ts:674-675`）が、`completeStreaming`（`llm.ts:482`）には同等の処理が無い。GUI/CLI は `onEvent` を常に渡すため（`session-app.ts:1615`）、`streaming` 機能は既定オン（`features.ts:20`）で、**OpenAI 互換ではストリーミングが既定経路**になる。未知モデルでの 400 はそのままターン失敗になる。
4. **未知サーバ向けの逃げ道が設定に存在しない。** カスタムヘッダ、`extra_body`、パス結合の制御（`/v1` の有無・クエリ保持）、API キーのヘッダ方式（Bearer 以外）を role に指定する手段が無い（`config.ts:49` の `RoleConfig` に該当フィールドが無い）。
5. 既存テストは「特定モデル専用の期待」を固定している（`model-catalog.test.ts:34-38`、`config.test.ts:56-65`）。これは回帰検出として妥当だが、**新しいモデルを足すたびにテストを直す必要がある**構造でもある。

---

## 1. モデル・プロバイダ固有分岐の一覧

判定の凡例: **妥当** = 仕様差に由来し、現状のままでよい。**過剰** = 一般化できるのに特定名で分けている。**誤り** = コードと意図（コメント・仕様）が食い違う、または到達しない。**要確認** = 実サーバで確かめないと断定できない。

### 1.1 モデル名で分岐している箇所

| 場所(file:line) | 現在の条件 | 何のための分岐か | 根拠（コメント・テスト・検証記録） | 判定 | 汎用化案 |
|---|---|---|---|---|---|
| `llm.ts:467` | `role.provider === 'deepseek'` または `/deepseek/i.test(role.model)` のときだけ `sendsReasoning = true` | 過去ターンの推論を `reasoning_content` として送り返すかの判定 | コメント `llm.ts:456`、テスト `llm.test.ts:214`。DeepSeek は tools 利用時に reasoning_content の完全な送り返しを要求する（`verification/sources/deepseek_thinking.txt`） | 妥当（ただし一般化の余地） | role に `sendReasoningContent: 'auto' / 'always' / 'never'` を追加し、`auto` はカタログの compat で決める。名前に依存しない |
| `llm.ts:59` | `withReasoning` が真のとき assistant メッセージへ `reasoning_content` を付ける（`openAiMessages`、`llm.ts:56`） | DeepSeek 系への送り返し | 同上。他の OpenAI 互換サーバは未知フィールドを 400 にすることがあるため opt-in（`llm.ts:53`） | 妥当 | 送り返し形式を `reasoning_content` / `reasoning` / `thinking` ブロックから選べるようにする（要確認: どれを要求するサーバがあるか） |
| `llm.ts:424-427` | provider が `openai-compatible` / `opencode` / `openai-responses` のときだけ `tokenFieldFor` を使い、それ以外は `max_tokens` | OpenAI 系だけ `max_tokens` と `max_completion_tokens` の差があるため | `llm.ts:423` のコメント、`llm.test.ts:94` | 妥当（provider 判定として） | provider ではなく「OpenAI Chat Completions 系アダプタか」で判定する（Responses は実際には `max_output_tokens` なので、現状の whitelist に含める意味は無い） |
| `model-catalog.ts:133` | `^o\d` / `gpt-5` / `gpt-6` / `reason` のいずれかに一致したら `max_completion_tokens` | カタログに無いモデルのフォールバック | `model-catalog.ts:130`、テスト `model-catalog.test.ts:26-28` | 過剰 | 正規表現を廃止し、カタログ未登録時は `max_tokens` を既定にして 400 応答で自動切替（既存の `alternateTokenField` を使う）。`reason` は "reasoner" 以外の語（例: `llama-3-reasoning`）も拾うため誤爆する |
| `model-catalog.ts:140` | `/gpt-6\.1-terra/i` のときだけ「effort と tools を同時に送らない」 | gpt-6.1-terra が 400 を返すため | `llm.test.ts:510`、`llm.test.ts:537`（gpt-6.2-terra の実エラー文） | 過剰（特定名） | 既定は「同時に送る」にし、`reasoningEffortConflict`（`llm.ts:444`）の検出時に role 単位で学習・キャッシュする。名前列挙は最後の手段 |
| `llm.ts:444` | 400 の本文に `reasoning_effort` と `function tools` の両方を含むときだけ effort を落とす | 上記衝突の実行時フォールバック | `llm.ts:443` のコメント | 要確認（文言依存） | 文言一致ではなく「400 かつ送信パラメータ名を含む」汎用パラメータ削除器にする（下記 1.4） |
| `model-catalog.ts:147` | 「temperature 可」= `tokenFieldFor(...) === 'max_tokens'` | 推論系モデルは既定温度しか受けない、という推定 | `model-catalog.test.ts:37-38` | 要確認 | token field と temperature 受理可否は独立した能力。従属させると `max_completion_tokens` を使う別理由のモデルまで温度固定になる |
| `llm.ts:493` / `llm.ts:664` | 上記で false なら `temperature` を送らない | 400 回避 | 同上 | 妥当（機構として） | role の `temperature` を明示した場合は送る／送らないを利用者が上書きできるようにする |
| `llm.ts:1508-1513` | `provider === 'gemini'` かつ `model === 'gemini-3.8-flash'` の固定価格。しかも 2027-01-01 で単価を 2 倍にする日付分岐（`llm.ts:1509`） | セッション USD 上限の見積り | `llm.ts:1506` | 誤り（配布物に日付依存の価格が埋まる） | 価格はカタログ（`ModelInfo.pricing`）と role の `pricing` だけにする。日付で変わる単価は設定ファイル側へ |
| `llm.ts:1512-1513` | `provider === 'opencode'` かつ baseUrl が `https://opencode.ai/inference/go/` で始まるとき価格 0 | OpenCode Go は無料、という前提 | `config.ts:629` の既定 baseUrl と一致 | 要確認（料金改定で誤請求・誤予算） | baseUrl 正規表現ではなく role の `pricing` を既定値として持たせる |
| `config.ts:554-557` | `model === 'gemini-3.8-flash'` かつ OpenCode の Go パスなら「利用不可」とみなす | 過去に Gemini 用モデル名が OpenCode ロールへ保存された事故の回復 | `config.ts:561` のコメント、`config.ts:562-564` で既定モデルへ戻す（`config.ts:563`） | 要確認（恒久化すると、将来 Gemini が Go で使えるようになったとき誤って書き換える） | 「保存値が特定モデルのときだけ別モデルへ置換」ではなく、モデル一覧の取得結果と突き合わせて無効なら既定へ戻す |
| `config.ts:539-542` | `deepseek-flash` / `deepseek-v4-flash` を `deepseek-v4.1-flash` に読み替え（`config.ts:540-541`） | 旧名の互換 | `config.ts:536` のコメント | 妥当（期限付きの移行） | エイリアス表に「いつまで」をコメントで明記し、削除予定を残す |
| `config.ts:97` | provider が gemini / openai-compatible / deepseek / anthropic / openai-responses なら「画像入力可」とみなす | 画像ツールの提示可否 | `roleSupportsImages` の provider 既定 | 過剰（provider 単位で true。**Gemini アダプタは画像を送れず例外を投げる**: `llm.ts:1024`） | `role.vision` とカタログ `capabilities.vision`（`model-catalog.ts:151`）を必須経路にし、provider 既定 true を廃止する |
| `config.ts:98-100` | ollama / opencode はモデル名の正規表現（llava, -vl, gemma3 …）で画像可否を推定 | ローカルモデルの判定 | `model-catalog.test.ts:44` | 妥当（ただし名前依存） | カタログ優先のまま、未知モデルは既定 false（現状どおり）。UI で上書きしやすくする |
| `llm.ts:389` | Ollama へ常に `think: false` | thinking 非対応モデルでの 400 回避 | コードのみ。テストなし | 要確認（Ollama 上の推論モデルの推論を常に捨てる） | role の `effort` か `thinking` 設定に連動させる |
| `llm.ts:391` | tools が無く `json !== false` なら `format: 'json'` | Ollama の構造化出力 | `llm.test.ts:66` | 妥当 | 変更不要 |

### 1.2 プロバイダで分岐している箇所（妥当なもの）

| 場所(file:line) | 現在の条件 | 何のための分岐か | 根拠 | 判定 | 汎用化案 |
|---|---|---|---|---|---|
| `llm.ts:1007`（Gemini） | provider `gemini` は Interactions API（`llm.ts:1058` の `/interactions`、`x-goog-api-key` ヘッダ `llm.ts:1061`） | Gemini の独自 API 形状 | `verification/sources/gemini_thinking.txt`、`verification/sources/gemini_tokens.txt`、`llm.test.ts:283` 系のスタブ | 妥当 | なし（アダプタ分離を維持） |
| `llm.ts:1218`（Anthropic） | provider `anthropic` は Messages API（`/v1/messages` `llm.ts:1249`、`x-api-key` と `anthropic-version` `llm.ts:1253`） | Messages API の形状 | `llm-providers.test.ts:42` | 妥当 | なし |
| `llm.ts:1311`（Responses） | provider `openai-responses` は `/responses`（`Authorization: Bearer`、`llm.ts:1377`） | Responses API の形状 | `llm-providers.test.ts:117` | 妥当 | なし |
| `llm.ts:379`（Ollama） | provider `ollama` は `/api/chat`（`llm.ts:382`）、`num_ctx`/`num_predict`（`llm.ts:394-397`） | Ollama の独自パラメータ | `llm.test.ts:66` | 妥当 | なし |
| `llm.ts:1184` / `llm.ts:1200` | Anthropic だけ `cache_control` ブレークポイントを挿す | Anthropic は明示ブレークポイントが必要 | `llm-providers.test.ts:42` | 妥当 | なし |
| `llm.ts:483` / `llm.ts:641` / `llm.ts:736` | OpenCode のホスト（または provider）のときだけ `x-opencode-session` と `User-Agent` を付ける | セッション単位のキャッシュルーティング | `llm.test.ts:177-180` | 妥当 | なし（ただし下記 2.9 のヘッダ一般化と重なる） |
| `llm.ts:1531` | 予算実行時、provider `mock`/`ollama` は課金対象外 | ローカルは課金されない | コードのみ | 妥当 | なし |

### 1.3 カタログと能力フラグ

| 場所(file:line) | 現在の条件 | 何のための分岐か | 根拠 | 判定 | 汎用化案 |
|---|---|---|---|---|---|
| `model-catalog.ts:151` | `catalogVision` だけがカタログの能力を実際に消費する | 画像可否の推定 | `config.ts:97` の分岐と対 | 過剰（他は表示専用） | `capabilities.tools` / `reasoning` / `cache` も判定に使う |
| `main.ts:762` | `hy models` は `capabilities` を表示するだけ | 利用者への情報提示 | `main.ts:762-765` | 妥当（表示） | 表示だけでなく `usesNativeTools`（`config.ts:83`）の入力にする |
| `model-catalog.ts:82` | `openai-responses:gpt-4.1-mini`（`model-catalog.ts:75`）に `compat: { tokenField: 'max_tokens', temperature: false }` | 一見 Responses の互換性定義 | 実際には Responses アダプタ（`llm.ts:1311`）は `tokenFieldFor`/`temperatureAllowedFor` を呼ばない（`llm.ts:492-493`、`llm.ts:662-664` は `OpenAiProvider` のみ） | 誤り（到達しない設定。読み手を誤らせる） | 未使用の compat を削除するか、Responses アダプタ側で意味を持たせる |
| `config-schema.ts:399` | `models`（再利用プリセット）を定義 | GUI の設定モデル一覧 | 消費は `web-server.ts:578` と GUI のみ。CLI 側の参照は無い | 要確認（CLI からは効かない） | プリセットを CLI/GUI 共通の解決経路（config ロード時）に寄せる |

### 1.4 共通の仮定（プロバイダ／モデル非依存に見えて実は固定）

| 場所(file:line) | 現在の条件 | 何のための分岐か | 根拠 | 判定 | 汎用化案 |
|---|---|---|---|---|---|
| `llm.ts:499` | ストリーミングで常に `stream_options: { include_usage: true }` | 最終チャンクの usage 取得 | `llm.test.ts:597` | 過剰（未知フィールドを 400 にするサーバがある） | 400 時に `stream_options` を落として再送（非ストリーミングの `alternateTokenField` と同じ方式） |
| `llm.ts:503` / `llm.ts:660` | tools が無く `json !== false` なら `response_format: { type: 'json_object' }` | 構造化出力 | `llm.test.ts:94` 系のスタブ | 過剰 | 400 時に `response_format` を落として再送。role で無効化も可能に |
| `llm.ts:280` | `DEFAULT_RETRY = { retries: 6, baseDelayMs: 1_000, maxDelayMs: 15_000 }` 固定 | 429/5xx の再試行 | `llm.test.ts:740` | 要確認（role ごとに調整できない） | `role.retry` を追加。`Retry-After` の ms 指定・HTTP 日付形式も扱う |
| `llm.ts:506` | ストリーミングだけ 600 秒固定のタイムアウト | 無限待ちの回避 | コードのみ | 過剰（非ストリーミングにはタイムアウトが無い） | `role.timeoutMs` を共通化し、両経路に適用 |
| `llm.ts:592` / `llm.ts:596` | `delta.content` は string、推論は `reasoning_content` か `reasoning` のみ | 差分の取り込み | `llm.test.ts:597` | 過剰（配列 content・他フィールド名に非対応） | 正規化関数を1つ作り、`content` の配列・`reasoning_details` 等も受ける |
| `llm.ts:601` | `delta.tool_calls` の `index` と `function.arguments`（文字列）を前提 | ツール呼び出しの組み立て | `llm.test.ts:597` | 要確認（arguments がオブジェクトのサーバ、index 省略） | `arguments` は string 以外も受け、index 省略時は `id` でまとめる |
| `llm.ts:418` / `llm.ts:626` / `llm.ts:731` | OpenAI 系の tool_call `id` を捨てる（`name` と `args` のみ返す） | 履歴をテキストプロトコルで持つため | 3箇所とも同じ形。Anthropic の `tool_use.id` も捨てる（`llm.ts:1286`） | 妥当（現行設計）／要確認（id を要求するサーバ） | `ToolCall.id` は既に型にある（`llm.ts:84`）ので、ネイティブ tools を使う場合だけ保持して返す |
| `llm.ts:586` / `llm.ts:1300` / `llm.ts:1423` | 出力上限は `finish_reason === 'length'`、Anthropic `max_tokens`、Responses `max_output_tokens` のみ | 途中切れ検出 | `agent.ts:789` が `outputLimited` を見て再試行 | 過剰（`max_tokens` という値・`content_filter`・`refusal` を見ない） | 値を集合で持ち、未知値は「不明な停止」として記録する |
| `llm.ts:576-583` / `llm.ts:715-728` | usage は `prompt_tokens` / `completion_tokens` / `prompt_cache_hit_tokens` / `prompt_tokens_details.cached_tokens` のみ | トークン数とキャッシュの取得 | `llm.test.ts:238`、`llm.test.ts:652` | 過剰（`input_tokens`/`output_tokens` 形式、`cache_creation_input_tokens` 等） | usage 正規化を1関数に集約し、未知形式は生 JSON を残す |
| `llm.ts:1331` | Responses は system を `instructions` に分離（`llm.ts:1329`）。Anthropic は先頭1件のみ（`llm.ts:1235`）。Gemini は全部連結（`llm.ts:1025`） | システムプロンプトの抽出 | コードのみ | 要確認（複数 system を送る経路があるか） | 「system の扱い」をアダプタ仕様として明文化（連結 or 先頭のみ） |
| `llm.ts:1024` | Gemini は画像があると即エラー | 未実装の明示 | コードのみ | 誤り（`config.ts:97` は Gemini を画像可と判定する） | `roleSupportsImages` と Gemini アダプタの能力を一致させる |

---

## 2. 未知モデル・未知サーバでの破綻シナリオ

各項目は「コードが仮定していること（file:line）」「壊れる対象」「症状」「検出方法」「汎用化案」の順。事実と推測は文末の印で区別する。

### 2.1 reasoning / thinking の送り返し

- **仮定（事実）**: 送り返すのは provider が `deepseek` かモデル名に `deepseek` を含むときだけ（`llm.ts:467`）。形式は `reasoning_content` 固定（`llm.ts:59`）。応答からの取り込みも `reasoning_content` と `reasoning` の2つだけ（`llm.ts:596`、`llm.ts:717`）。
- **壊れる対象**: (a) DeepSeek 以外で「推論の送り返しを要求する」サーバ（vLLM の reasoning parser、OpenRouter の `reasoning_details`、Qwen 系の独自フィールドなど）(b) provider が `deepseek` でもモデルが別系統のとき（無条件に送るので未知フィールド拒否の 400）。
- **症状**: (a) 400（「reasoning_content が不足」）または推論の文脈欠落による品質低下、(b) 400「unknown field reasoning_content」。(推測)
- **検出方法**: `step/end`（`agent.ts:770`）の usage と 400 本文。`hy doctor` に「直近 400 の本文」を出す。テストは `llm.test.ts:214` が DeepSeek 固定なので、他形式は未検出。
- **汎用化案**: role に `sendReasoningContent: auto/always/never` と `reasoningField` を持たせ、`auto` は「初回 400 の本文に `reasoning` を含む → always に切替」で学習。`Usage` に `rawUsage` を残す。
- ※ `docs/prompt-tuning-handover.md:170` に「DeepSeek には reasoning_content で返す」と既出。本監査の差分は「他プロバイダへ一般化する手段が無い」点。

### 2.2 temperature / top_p / max_tokens の受理可否

- **仮定（事実）**: temperature の可否は `tokenFieldFor(...) === 'max_tokens'` から派生（`model-catalog.ts:147`）。`top_p` はどこにも送っていない（`llm.ts` 全体に `top_p` が無い）。max_tokens のフィールド名は provider と名前ヒューリスティックで決定（`llm.ts:424-427`、`model-catalog.ts:133`）。値の上限は role の `maxOutputTokens` をそのまま送る（`agent.ts:712` が `maxTokens: this.maxOutputTokens`）。
- **壊れる対象**: temperature を 0 で拒否するサーバ（範囲が (0,2] の API）、`top_p` 必須のサーバ（(推測): 一部の中国系 API は `top_p` 既定で問題ないため実害は小さい）、`max_tokens` の上限が小さいモデルに大きい値を送る場合（例: 既定 `openai-compatible` は 32,768（`config.ts:601`）だが、ユーザーがモデルだけ小さいモデルへ変えると 400「max_tokens too large」）。
- **症状**: 400 でターン失敗。temperature 非対応は「既定値のみ」なので 400 になりやすい（推測）。
- **検出方法**: 400 本文。`hy models` は role の値を表示するが、モデル上限との比較はしない。
- **汎用化案**: 「拒否されたパラメータを1つ落として1回だけ再送し、結果を role に記録」する汎用ネゴシエータ。対象は `temperature` / `top_p` / `max_tokens` / `max_completion_tokens` / `response_format` / `stream_options` / `reasoning_effort`。`maxTokens` は入力トークン見積りと `contextWindowTokens` から clamp する（現状 clamp は無い。`config.ts:587` のコメントは「25% 予備で収まる」前提であり、コード上の clamp ではない）。

### 2.3 ストリームの delta 形式

- **仮定（事実）**: SSE の `data:` 行のみを読み（`llm.ts:553`）、`[DONE]`（`llm.ts:555`）または `finish_reason`（`llm.ts:586`）で完了とみなす。`delta.content` は string のみ（`llm.ts:592`）。完了が来なければ例外（`llm.ts:625`）。
- **壊れる対象**: (a) `stream: true` を無視して通常 JSON を返すゲートウェイ → `data:` 行が無いので `finished` が立たず「stream ended before the response was complete」、(b) Content-Type が `text/event-stream` でない実装、(c) `content` が配列（パーツ形式）のサーバ → 取り込みゼロで空応答、(d) `[DONE]` を送らず `finish_reason` も送らないサーバ、(e) usage が最終チャンクに無い（2.4）。
- **症状**: (a)(b) は毎回失敗、(c) は「成功したが content が空」でモデルが無言、(d) も毎回失敗。
- **検出方法**: レスポンスの `Content-Type` を確認していない（事実: `openStreamWithRetry`（`llm.ts:339`）は status しか見ない）。`stream: true` で送ったのに 1 度も `data:` を読まなかった場合に「サーバがストリーミング非対応」として非ストリーミングへ落とす、が現状無い。
- **汎用化案**: (1) `Content-Type` が SSE でなければ本文を通常 JSON として解釈、(2) `data:` が 0 件のまま終了したら非ストリーミングで1回再試行、(3) `content` 配列を連結、(4) 完了判定を「`finish_reason` / `[DONE]` / 接続終端のいずれか + usage の有無」に緩める（ただし途中切れ検出は維持）。

### 2.4 usage のフィールド名

- **仮定（事実）**: OpenAI 経路は `prompt_tokens` / `completion_tokens` / `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` / `prompt_tokens_details.cached_tokens`（`llm.ts:577-583`、`llm.ts:715-728`）。Anthropic は `input_tokens` / `output_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens`（`llm.ts:1289`）。Responses は `input_tokens` / `output_tokens` / `input_tokens_details.cached_tokens`（`llm.ts:1420`）。Gemini は `total_input_tokens` / `total_output_tokens` / `total_thought_tokens` / `total_cached_tokens`（`llm.ts:1108`、`llm.ts:1127`、`llm.ts:1136`）。
- **壊れる対象**: `usage` を返さないサーバ、`input_tokens`/`output_tokens` 形式を返す OpenAI 互換サーバ（(推測): 一部のゲートウェイがこの形式）、`usage` がストリーム中に 1 度も来ないサーバ。
- **症状**: `usage` が 0 のまま → `agent.ts:730` の `lastInputTokens` が 0、`CP-12 get_context_remaining` が 0 を返す、`llm.ts:1532` の予算見積り・`llm.ts:1546` の早期 return により settle が走らない。**コストが記録されないのに実行は続く**。
- **検出方法**: `step/end` の usage が 0。session log の `token/estimate` の `actual` が常に 0。既存テストは固定 usage を返すスタブのみ（`llm.test.ts:238`）。
- **汎用化案**: `Usage` に `rawUsage?: unknown` を追加し、既知フィールドが 1 つも無い場合は「usage 未報告」を明示（0 と区別）。キャッシュ可否は `cacheHitTokens === undefined` で表現済み（`agent.ts:748`）なので、同じ扱いに揃える。

### 2.5 tool_calls の形式

- **仮定（事実）**: 非ストリーミングは `choices[0].message.tool_calls[].function.name` と `arguments`（`llm.ts:708-731`）。ストリーミングは `delta.tool_calls[].index` で束ね、`arguments` を文字列連結（`llm.ts:601`）。`args` は JSON 文字列を `parseArgs`（`llm.ts:246`）で緩く解析。`id` は捨てる（`llm.ts:626`、`llm.ts:731`）。
- **壊れる対象**: `arguments` がオブジェクトで返るサーバ（ストリーミングでは `+=` で `[object Object]` になる）、`index` を送らないサーバで並列呼び出し（`i` はチャンク内位置なので別呼び出しが混ざる）、`id` を要求するサーバ（OpenAI は tool メッセージに `tool_call_id` を要求するが、HY はテキストで結果を返すので回避している）。
- **症状**: 引数が壊れて `agent.ts:833` の「非オブジェクト引数」検出 → `agent.ts:835` のプロトコル再試行。並列呼び出しの混線は「1回だけ実行される」または「引数が別呼び出しのものになる」。(推測)
- **検出方法**: `step/end` の `replyChannel: 'native'`（`agent.ts:776`）と `turn/retry` の `invalid-native-arguments`（`agent.ts:835`）。テストは `llm.test.ts:597`。
- **汎用化案**: ストリーミングでも `typeof arguments === 'string'` を確認し、非文字列は JSON 化して保持。`index` 省略時は `id`、`id` も無ければ「チャンク内で name が変わるまで同一呼び出し」とみなす。ネイティブ tools 使用時は `id` を保持して将来の `role: 'tool'` 応答に備える。

### 2.6 system ロール非対応 / tools 非対応 / 画像非対応

- **system ロール非対応（事実）**: OpenAI 経路は system をそのまま送る（`llm.ts:56`）。Anthropic は先頭1件のみ（`llm.ts:1235`）、Responses は `instructions`（`llm.ts:1329`）、Gemini は全連結して `system_instruction`（`llm.ts:1025`、`llm.ts:1066`）。system を拒否するモデル（一部の chat template）で 400 になるが、フォールバックは無い。
- **tools 非対応（事実）**: `usesNativeTools` は provider だけで決まり（`config.ts:83`）、カタログの `capabilities.tools` を見ない。tools 非対応モデルで 400 が出た場合のみ、`agent.ts:720` が「400 かつ本文に tool を含む」ときにネイティブを諦めてテキストプロトコルへ落とす（`agent.ts:723`）。**文言に `tool` が含まれないエラー（例: "function calling is not supported"）は拾えない**（`/tool/i` に一致しないため）。
- **画像（事実）**: `roleSupportsImages` は provider で true を返す（`config.ts:97`）が、Gemini アダプタは画像で即例外（`llm.ts:1024`）。Ollama は base64 配列（`llm.ts:46`）、OpenAI は `image_url` データ URL（`llm.ts:65`）、Anthropic は base64 ブロック（`llm.ts:1200`）、Responses は `input_image`（`llm.ts:1340`）。**画像非対応のモデルに送った場合の 400 フォールバックは無い**（画像を落として再送する処理は無い）。
- **症状**: Gemini + `read_image` で毎回ターン失敗。tools 非対応モデルでは 1 回ムダな 400 の後、本文に tool が無い場合はそのまま失敗。
- **検出方法**: 400 本文。`hy doctor` にはモデル能力の実測が無い。
- **汎用化案**: (1) 「400 の本文から落とすパラメータを決める」汎用器に `tools` / 画像 / `system` を追加、(2) 画像は「初回 400 → 画像を外して再送し、その旨を利用者に出す」、(3) `roleSupportsImages` と各アダプタの実装可否を単一のソース（カタログ + role）に統一。

### 2.7 finish_reason の値

- **仮定（事実）**: `length` のみ `outputLimited`（`llm.ts:586`）。Anthropic は `max_tokens`（`llm.ts:1300`）、Responses は `incomplete_details.reason === 'max_output_tokens'`（`llm.ts:1423`）。`agent.ts:789` が `outputLimited` のときだけ「切れた」として再試行する。
- **壊れる対象**: `finish_reason: 'max_tokens'` を返すサーバ（OpenAI 互換の一部）、`content_filter`、`refusal`、`stop_sequence`、未知値。
- **症状**: 途中で切れた応答が「完了」として扱われる。テキストの途中切れは最終回答として受理され、ツール呼び出しの JSON が途中なら `parseArgs`（`llm.ts:246`）が文字列を返し `agent.ts:833` で再試行になる（＝ツールは実行されない）。**部分的なツールバッチが実行されることは無い**（事実: 引数が非オブジェクトなら `agent.ts:833` が弾く）。ただし「切れた本文を最終回答として採用」は起こりうる。
- **検出方法**: `step/end`（`agent.ts:770`）に `finish_reason` を残していない（生値は `Completion` にも無い）。よって事後に判別できない。
- **汎用化案**: `Completion` に `stopReason?: string` を追加して生値を保持し、`outputLimited` は「切れ」の集合（length / max_tokens / max_output_tokens / content_filter / refusal）で計算。未知値はログに残す。

### 2.8 baseUrl のパス結合

- **仮定（事実）**: すべて文字列連結。末尾スラッシュだけ削る（`llm.ts:376`、`llm.ts:465`、`llm.ts:1017`、`llm.ts:1228`、`llm.ts:1322`）。OpenAI 系は `${baseUrl}/chat/completions`（`llm.ts:669`、`llm.ts:681`）、Anthropic は `${baseUrl}/v1/messages`（`llm.ts:1249`）、Responses は `${baseUrl}/responses`、Gemini は `${baseUrl}/interactions`（`llm.ts:1058`）、Ollama は `${baseUrl}/api/chat`（`llm.ts:382`）。
- **壊れる対象**: (a) `https://api.anthropic.com/v1` のように `/v1` まで含めて設定 → `/v1/v1/messages`、(b) クエリ付き URL（Azure OpenAI の `?api-version=`）→ クエリの後ろにパスが付いて壊れる、(c) フルパスを設定するタイプのゲートウェイ、(d) 末尾スラッシュは削るが `//` の重複は直さない。
- **症状**: 404 または 400。設定ミスとして利用者に見えるが、原因が分かりにくい。
- **検出方法**: `hy doctor` に「解決後の URL」を表示する（現状は無い）。`isOpenCodeHost`（`llm.ts:736`）はホストだけ見るので、パス誤りは検出しない。
- **汎用化案**: `new URL(path, base)` 相当で結合し、baseUrl に既にパスが含まれる場合は二重付加しない。`role.paths`（chatPath / messagesPath）を任意で上書き可能に。クエリは保持する。

### 2.9 API キーのヘッダ名

- **仮定（事実）**: OpenAI 系は `Authorization: Bearer`（`llm.ts:488`、`llm.ts:646`、`llm.ts:1377`）、Anthropic は `x-api-key`（`llm.ts:1253`）、Gemini は `x-goog-api-key`（`llm.ts:1061`）。キー解決は `roleApiKey`（`config.ts:1094`）で、provider ごとの env 名を既定にする（`config.ts:1098-1106`）。同じ対応表が `llm.ts:471` と `onboarding.ts:39` にも重複。
- **壊れる対象**: Azure OpenAI（`api-key` ヘッダ）、社内ゲートウェイ（独自ヘッダ + 追加ヘッダ必須）、キー不要のローカルサーバ（現状は provider が ollama/mock 以外だとキー必須で `llm.ts:470` が例外）。
- **症状**: 401/403、またはキー未設定例外「missing API key: set OPENAI_API_KEY」（`llm.ts:471`）。**ローカルの OpenAI 互換サーバ（vLLM / llama.cpp / LM Studio）にキーが無いと起動できない**（事実: `roleApiKey` は ollama/mock 以外で env を要求）。LM Studio 等は任意キーで通るため実害は小さいが、案内が誤解を招く。(推測)
- **検出方法**: 401/403 の本文。`hy doctor` はキーの有無だけ見る。
- **汎用化案**: role に `headers?: Record<string,string>`、`auth?: { type: 'bearer' | 'api-key' | 'x-api-key' | 'x-goog-api-key' | 'none', env?: string }` を追加。env 名の対応表は1箇所（`config.ts`）に集約し、`llm.ts:471` と `onboarding.ts:39` の重複を消す。

### 2.10 タイムアウト・リトライ・レート制限

- **仮定（事実）**: `DEFAULT_RETRY` は 6 回・指数バックオフ ±25%・最大 15 秒（`llm.ts:280`）。再試行対象は 429 と 5xx（予算付き実行では 5xx を再試行しない: `llm.ts:323`、`llm.ts:357`）。ネットワーク例外も再試行。`Retry-After` は秒として解釈（`llm.ts:327`、`llm.ts:361`）。ストリーミングは「開始前」だけ再試行（`llm.ts:339`）。非ストリーミングにタイムアウトは無い（`llm.ts:300` の `postWithRetry` に timer が無い）。ストリーミングは 600 秒固定（`llm.ts:506`）。
- **壊れる対象**: `Retry-After` をミリ秒で返すサーバ（15 秒に丸められるので実害は小さい）、HTTP 日付形式（`Number()` が NaN → バックオフへ）、408/409/425/529（過負荷）を返すサーバ（再試行しない）、応答が返らないサーバ（非ストリーミングは無限待ち）。
- **症状**: 408/529 で即失敗。非ストリーミングはハングし、`options.signal` が無い呼び出し（compactor / summarizer など）ではターンが止まる（(推測): 呼び出し側が signal を渡しているかは経路による）。
- **検出方法**: `latencyMs` は `step/end` にある（`agent.ts:729`、`agent.ts:775`）。再試行回数はログに無い。
- **汎用化案**: `role.retry`（回数・初期待ち・最大待ち）と `role.timeoutMs` を追加し、両経路に適用。再試行対象を 408/409/425/529 へ拡張。試行回数と最終ステータスを `step/end` に記録。

### 2.11 モデル一覧（discovery）

- **仮定（事実）**: provider ごとに URL とヘッダを固定（`llm.ts:1437`、`llm.ts:1446`、`llm.ts:1450`）。応答は `data[]` か `models[]` の `id`/`name` をそのまま使う（`llm.ts:1476`）。
- **壊れる対象**: Gemini の ListModels は `name: "models/…"` 形式で返す（(推測): Google API の慣例）。そのまま role.model に設定すると Interactions API へ `models/gemini-…` を送ることになる。OpenAI 互換の一部は `{ data: [{ id }] }` 以外の形を返す。
- **症状**: `hy models discover` で得た名前を設定しても 404/400。Ollama 以外は接頭辞の正規化が無い。
- **検出方法**: `llm-discovery.test.ts:24` は OpenAI/Anthropic/Ollama の 3 形式のみで、Gemini のテストは無い。
- **汎用化案**: provider ごとの「一覧応答 → モデル名」変換関数を持ち、Gemini は `models/` を落とす。未知形式は生 JSON を表示する。※ `docs/troubleshooting.md:118` に `hy models discover` の案内が既出。

---

## 3. 事実と推測の切り分け

| 主張 | 種別 | 根拠 |
|---|---|---|
| provider ごとに API 形状が違い、アダプタ分割は妥当 | 事実 | `llm.ts:379`、`llm.ts:1007`、`llm.ts:1218`、`llm.ts:1311` |
| 推論送り返しは deepseek 判定のみ | 事実 | `llm.ts:467`、`llm.ts:59` |
| ストリーミングに適応リトライが無い | 事実 | `llm.ts:482` の実装に `alternateTokenField`/`reasoningEffortConflict` の呼び出しが無い。非ストリーミングは `llm.ts:674-675` |
| 既定でストリーミングが使われる | 事実（経路） | `session-app.ts:1615`（`onEvent`）、`features.ts:20`（既定オン）、`agent.ts:706` |
| 未知サーバが `stream_options` を拒否すると失敗する | 推測 | 拒否時のフォールバックが無いことからの推定。実サーバ未確認 |
| Gemini が画像を送れないのに画像可と判定される | 事実 | `config.ts:97` と `llm.ts:1024` |
| Gemini のモデル一覧が `models/` 接頭辞付きで返る | 推測 | Google API の慣例。実 API 未確認 |
| Azure OpenAI 等で `api-key` ヘッダが必要 | 推測（一般的な仕様） | コードにヘッダ切替が無いことは事実（`llm.ts:488` 固定） |
| 非ストリーミングにタイムアウトが無い | 事実 | `llm.ts:300` の `postWithRetry` に timer が無い。ストリーミングのみ `llm.ts:506` |
| usage 欠落時にコスト記録が走らない | 事実 | `llm.ts:1546` の早期 return |
| カタログの tools/reasoning/cache が判定に使われない | 事実 | 消費は `main.ts:762` の表示のみ。`usesNativeTools` は `config.ts:83` |
| `openai-responses` の compat が到達しない | 事実 | `llm.ts:1555` で Responses は別クラス。`tokenFieldFor` の呼び出しは `llm.ts:427` |
| 既定プリセットが GUI 側と二重管理で食い違う | 事実 | `config.ts:590` は 262,144、`web/src/app.ts:2795` は 393,216（同じ deepseek-flash） |

---

## 4. 優先度の高い汎用化 トップ5

1. **能力を「モデル名」ではなく role / カタログの能力フラグで持つ。**
   対象: `sendReasoningContent`、token field、temperature 可否、effort+tools 可否、tools 可否、vision、usage 形式。
   理由: 現状は `deepseek`（`llm.ts:467`）、`gpt-6.1-terra`（`model-catalog.ts:140`）、`^o\d|gpt-5|gpt-6|reason`（`model-catalog.ts:133`）の名前に依存し、未知モデルは必ずどこかで外れる。名前一致は「実測した1モデル」にしか効かない。
2. **ストリーミング経路に、非ストリーミングと同じ適応リトライと寛容な解析を入れる。**
   理由: 既定経路（`session-app.ts:1615`、`features.ts:20`）なのに、`max_tokens` 代替（`llm.ts:674`）・effort 省略（`llm.ts:675`）・`response_format`/`stream_options` の拒否対応が無い。未知モデルは「CLI では動くが GUI では 400」になり、原因究明が難しい。
3. **リクエスト互換の逃げ道を role に追加する（headers / auth / paths / extraBody）。**
   理由: `Authorization: Bearer` 固定（`llm.ts:488`）、パス文字列連結（`llm.ts:465`）、`extra_body` 無しでは Azure OpenAI・社内ゲートウェイ・中国系 API の独自必須フィールドに対応できない。DeepSeek の `thinking` トグル（`verification/sources/deepseek_thinking.txt` の `extra_body`）も現状は送れない。
4. **「拒否されたパラメータを落として1回だけ再送」する汎用ネゴシエータに統一する。**
   理由: 今は `max_tokens`（`llm.ts:431`）と `reasoning_effort`（`llm.ts:444`）の2パターンだけを、それぞれ別の文言一致で処理している。対象を `temperature` / `top_p` / `response_format` / `stream_options` / `tools` / 画像 / `system` に広げ、成功した組み合わせを role にキャッシュすれば、未知モデルの初回 400 が1回で吸収できる。
5. **usage / finish_reason / 停止理由を正規化して保持する。**
   理由: 現在は既知フィールドのみ拾い（`llm.ts:577-583`、`llm.ts:715-728`）、`finish_reason` は `length` だけ（`llm.ts:586`）、生値は捨てている。結果として (a) usage 欠落時にコスト・context 残量が 0 になる、(b) `content_filter` 等の停止を取り逃がす、(c) 事後に原因を追えない。`stopReason` と `rawUsage` を `Completion` に残すだけで、検出可能性が大きく変わる。

---

## 5. 確認状況

- 実ファイルで内容を確認した `file:line`: **229 箇所**（付録A。重複を除く）。
- 参照した実装ファイル: `packages/core/src/llm.ts`、`packages/core/src/model-catalog.ts`、`packages/core/src/config.ts`、`packages/core/src/config-schema.ts`、`packages/core/src/agent.ts`、`packages/core/src/features.ts`、`packages/hy-cli/src/main.ts`、`packages/hy-cli/src/onboarding.ts`、`packages/hy-cli/src/session-app.ts`、`packages/hy-cli/web/src/app.ts`、`packages/hy-cli/src/web-server.ts`
- 既存文書との重複: `docs/prompt-tuning-handover.md:170`（reasoning 送り返し）、`docs/troubleshooting.md:118`（models discover）、`docs/enforcement-gaps.md:37`（小規模モデルの grader 推奨）。本レポートは「プロバイダ適応層の一般化」に絞り、プロンプト内容には踏み込んでいない。

### 未確認事項

1. 実プロバイダでの挙動は一切実行していない（API キー・ネットワーク無し）。2章の「症状」のうち (推測) を付けたものは、コードからの推定。
2. Azure OpenAI、vLLM、LM Studio、llama.cpp、OpenRouter、Moonshot 等の実際のエラーメッセージ・ヘッダ要件は未取得。
3. Gemini ListModels の `models/` 接頭辞、および Interactions API が `temperature` を受け付けるかは未確認（コードは送っていない: `llm.ts:1079-1082`）。
4. Claude 系の `thinking` ブロック送り返し（assistant の thinking ブロックを次リクエストに含める必要があるか）は未確認。Anthropic アダプタは `thinking` を要求も送信もしない（`llm.ts:1234-1244`）。
5. `config-schema.ts:399` の `models` プリセットが CLI 実行時に効くかは未確認（参照は GUI/`web-server.ts:578` のみ）。
6. `docs/implementation_status.md` の該当節は今回参照していない（プロバイダ層の記述有無を確認していない）。
7. 担当Bの `reply-guard.ts` の `tool_calls` 解釈は範囲外として判定していない。境界の重複がある可能性は残る。

---

## 付録A: 確認済み file:line 一覧

`packages/core/src/llm.ts`: 46, 53, 56, 59, 65, 84, 246, 280, 300, 323, 327, 339, 357, 361, 376, 379, 382, 389, 391, 394, 397, 406, 413, 418, 423, 424, 427, 431, 438, 439, 443, 444, 456, 465, 467, 470, 471, 482, 483, 488, 490, 492, 493, 498, 499, 502, 503, 506, 548, 553, 555, 576, 577, 583, 586, 592, 596, 601, 625, 626, 638, 641, 646, 650, 656, 659, 660, 662, 664, 669, 674, 675, 681, 708, 715, 717, 718, 728, 731, 736, 1007, 1017, 1024, 1025, 1028, 1036, 1058, 1061, 1064, 1065, 1066, 1079, 1080, 1082, 1108, 1117, 1123, 1127, 1136, 1184, 1200, 1212, 1218, 1228, 1234, 1235, 1244, 1249, 1253, 1266, 1286, 1289, 1300, 1311, 1322, 1329, 1331, 1340, 1348, 1352, 1353, 1377, 1388, 1420, 1423, 1437, 1446, 1450, 1476, 1506, 1508, 1509, 1512, 1513, 1518, 1531, 1532, 1533, 1535, 1546, 1547, 1548, 1555

`packages/core/src/model-catalog.ts`: 75, 82, 130, 133, 137, 140, 144, 147, 151

`packages/core/src/config.ts`: 49, 83, 97, 98, 536, 539, 540, 554, 555, 556, 559, 561, 562, 563, 565, 568, 587, 590, 601, 629, 882, 1094, 1098, 1099, 1100, 1102, 1103, 1104, 1106

`packages/core/src/config-schema.ts`: 399

`packages/core/src/agent.ts`: 706, 712, 720, 723, 729, 730, 748, 770, 775, 776, 789, 833, 835

`packages/core/src/features.ts`: 20

`packages/hy-cli/src/main.ts`: 762

`packages/hy-cli/src/onboarding.ts`: 39, 232

`packages/hy-cli/src/session-app.ts`: 1583, 1592, 1615

`packages/hy-cli/src/web-server.ts`: 578

`packages/hy-cli/web/src/app.ts`: 2795

`packages/core/src/llm-providers.test.ts`: 42, 117

`packages/core/src/llm.test.ts`: 66, 94, 177, 214, 238, 283, 510, 537, 597, 652, 740

`packages/core/src/model-catalog.test.ts`: 26, 28, 34, 37, 38, 44

`packages/core/src/config.test.ts`: 56, 65

`packages/core/src/llm-discovery.test.ts`: 24

`docs/prompt-tuning-handover.md`: 170

`docs/troubleshooting.md`: 118

`docs/enforcement-gaps.md`: 37
