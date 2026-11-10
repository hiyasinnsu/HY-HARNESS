# HY-HARNESS モデル/タスク汎用性監査 — オーケストレーターが直接確認した事実

- 日付: 2026-11-11
- 対象: `F:\HY-HARNESS`（未コミット変更を含む作業ツリー）
- 方法: `packages/core`, `packages/seams`, `packages/hy-cli` の実装を読み、`read_file` / `search_grep` で行番号を確認した。**ソースコードは変更していない。**
- 表記: 「事実」はコードで確認した内容、「推測」はそこから導いた未検証の予測。行番号は本ファイル作成時点のもの。
- 本ファイルは領域別レポート（`llm-provider-assumptions.md` ほか）に依存しない、独立した確認記録である。統合と優先度付けは `README.md` で行う。

---

## 1. 余計な場合分け（モデル名・プロバイダ名で挙動が変わる箇所）

| # | 場所 | 現在の条件 | 意図 | 判定 | 汎用化案 |
|---|---|---|---|---|---|
| S-1 | `packages/core/src/llm.ts:467` | `role.provider === 'deepseek' \|\| /deepseek/i.test(role.model)` のときだけ、過去の推論を `reasoning_content` として送り返す | DeepSeek 系だけが推論の返送を受ける | **過剰**（名前一致） | ロール設定に `reasoningEcho: 'none' \| 'field'` を持たせ、既定は「サーバが前回の応答で返した推論フィールドを返送する」という**観測ベース**にする。名前で決めない |
| S-2 | `packages/core/src/llm.ts:1508` | `provider === 'gemini' && model === 'gemini-3.8-flash'` のときだけ価格表をハードコード | 予算機能のため | **過剰**（単一モデル直書き） | 価格はカタログ（`model-catalog.ts`）に集約し、未登録なら「予算を使うには価格設定が必要」と明示して**実行は継続**（現状は例外で停止） |
| S-3 | `packages/core/src/model-catalog.ts:133` | `/(^o\d\|gpt-5\|gpt-6\|reason)/i.test(model)` で `max_completion_tokens` を選ぶ | 新しい OpenAI 推論モデルは `max_tokens` を拒否する | **誤り（条件が広すぎる）** | 名前ではなく「送って 400 が返ったらもう一方のフィールドで再送する」自己修復を既定にし、正規表現は廃止。（推測）`deepseek-reasoner` のような名前を OpenAI 互換サーバで使うと誤って `max_completion_tokens` を送る |
| S-4 | `packages/core/src/model-catalog.ts:140` | `!/gpt-6\.1-terra/i.test(model)` で「reasoning_effort と tools を同時に送れるか」を決める | 1 モデルの 400 を回避 | **過剰**（単一モデル直書き） | 400 の本文パターンで自己修復する仕組み（`llm.ts:443-447` に既にある）を既定にし、モデル名の除外リストを削除 |
| S-5 | `packages/core/src/model-catalog.ts:147` | `temperatureAllowedFor` が `tokenFieldFor === 'max_tokens'` で決まる（トークン上限フィールドから温度可否を導出） | 推論モデルは既定温度のみ | **誤り（無関係な項目の流用）** | `compat` を独立した能力記述（`tokenField` / `temperature` / `effortWithTools`）として持ち、既定は「送って 400 なら次のリクエストから落とす」適応に寄せる |
| S-6 | `packages/core/src/config.ts:81-85` | `usesNativeTools` がプロバイダ enum の許可リストで決まる | ネイティブ関数呼び出しの可否 | **要確認**（過去に gemini の入れ忘れでモードが途中変更された: `project.md:1068-1100`） | プロバイダではなく**モデル/サーバの能力**（`/models` のメタデータ、初回 400 の自己修復、ユーザー設定）で決める。1 ターン中に native→text へ切り替えると system prompt が変わりキャッシュも壊れる |
| S-7 | `packages/core/src/config.ts:540-541, 555, 561-566` | OpenCode のベース URL かつ特定モデル名のとき、保存済みモデルを別名へ**黙って書き換える** | 旧プロファイルの 400「Model is unavailable」回避 | **過剰**（データ移行を実行時に混ぜている） | 選択時に `/models` で検証して UI で選ばせ、設定読み込みでは書き換えない。移行はバージョン付きの設定マイグレーションで 1 回だけ行う |
| S-8 | `packages/hy-cli/src/session-app.ts:1071` | 思考要約の `effort` を `provider === 'opencode'` のときだけ `'none'` にする | 要約で推論フェーズを使わない | **過剰** | 「要約・タイトル生成などの補助ロールは既定で effort なし」とロール種別で決め、プロバイダ名で分けない |
| S-9 | `packages/hy-cli/src/session-app.ts:1583-1587` | `cacheCompaction` を opencode/deepseek かつ compactor と同一設定のときだけ有効化 | ネイティブ prefix を再利用できる provider だけ圧縮を最適化 | **要確認** | 「compactor が同じ provider/model/baseUrl/鍵なら prefix を再利用する」という**構造条件だけ**で判定し、プロバイダ名を外す |
| S-10 | `packages/core/src/llm.ts:1024` と `packages/core/src/model-catalog.ts:100` | Gemini アダプタは画像付きメッセージで例外を投げる一方、カタログは `vision: true`、`config.ts:91-99` も画像可と判定する | — | **誤り（矛盾）** | 能力表を単一の真実にし、アダプタが実装していない能力は `false` にする。未対応なら実行時に落とさず「このモデルは画像を受け取れない」とツール結果で返す |
| S-11 | `packages/core/src/tools.ts:42-120` | `edit_file` の `old_str`/`old_string`/`path`、`read_file` の `file`、`search_grep` の `path`→`glob` など、**ツールごとに手書きの別名変換** | モデルが別名で引数を送るため | **過剰**（対象ツールが増えると破綻） | `ToolSpec` に `aliases: Record<string,string>` を宣言させ、汎用の変換 1 本で処理する。単一キーオブジェクト（`{"shell":{...}}`）の展開も汎用規則にする |
| S-12 | `packages/core/src/reply-guard.ts:456-508` | 「次にやります」と宣言して止まった応答の検出が**日本語の活用形と英語の定型句のみ** | ターンが空振りで終わるのを防ぐ | **誤り（言語依存）** | 言語推定をやめ、「ツール呼び出しが無い」「ファイル変更が無い」「目的が未達」という**状態**で判定する。または最終回答に明示マーカーを要求する |
| S-13 | `packages/hy-cli/web/src/app.ts:2788-2820` | UI がプロバイダ既定値とモデル一覧を独自に持つ（`deepseek` の maxOutput 393,216、`opencode` の context 1,000,000 など） | 設定画面の入力補助 | **誤り（重複定義）** | 既定値はコアの `defaultRole` / `model-catalog` から API 経由で配る。UI 側の定数表を削除する |

---

## 2. 未知のモデル・未知のタスクで起きると推定される不具合

### 2.1 リクエスト形状

| # | 事実（コード） | 破綻シナリオ（推測を含む） | 検出方法 | 修正方針 |
|---|---|---|---|---|
| R-1 | ストリーミングで常に `stream_options: { include_usage: true }` を送る（`llm.ts:499`） | 未知の OpenAI 互換サーバが未知フィールドを 400 で拒否する | 400 の本文 | 400 を受けたら問題フィールドを落として 1 回再送し、以後そのセッションでは送らない（`alternateTokenField` と同じ自己修復の一般化） |
| R-2 | ツール無しのとき `response_format: { type: 'json_object' }` を送る（`llm.ts:503`, `llm.ts:660`） | JSON モード非対応サーバ（一部のローカル推論サーバ）で 400 | 400 の本文 | 同上。加えて「JSON で答えよ」をプロンプト側でも指示できるようにする |
| R-3 | `reasoning_effort` を常に送り得る（`llm.ts:502`, `llm.ts:659`） | 未知フィールドを拒否するサーバ、`effort` の値域が違うサーバで 400 | 400 の本文 | 能力記述 + 自己修復。値域は設定で上書き可能にする |
| R-4 | `[DONE]` も `finish_reason` も来ないストリームは例外（`llm.ts:625`） | `[DONE]` を送らないサーバ、`finish_reason` を最後のチャンクに入れないサーバで、正常な応答が失敗になる | 例外メッセージ | `[DONE]` 無しでも `finish_reason` か「接続の正常終了 + 本文あり」で完了とみなす設定を用意し、既定は緩和側にする |
| R-5 | `delta.content` が文字列のときだけ連結（`llm.ts:592`） | 一部サーバは content を配列（`[{type:'text',text:...}]`）で返す。無視され空応答になる | 空応答の連続 | 文字列・配列の両方を受ける |
| R-6 | ツール呼び出しの引数が文字列以外だと不正扱い（`agent.ts:833-837` 付近） | 引数をオブジェクトで返すサーバで毎回失敗 | `invalid-native-arguments` | オブジェクトはそのまま受理する |
| R-7 | 認証ヘッダが `Authorization: Bearer …` 固定（`llm.ts:488, 646, 1377`）。`RoleConfig` にヘッダ設定は無い（`config.ts` に `headers` / `api-key` の語が無い） | Azure OpenAI（`api-key` ヘッダ）、`x-api-key` を使うゲートウェイ、OAuth のみの社内プロキシは **設定では使えない** | 起動時の 401/403 | ロール設定に `headers`（テンプレート可）を追加し、既定は Bearer。401/403 の本文からヘッダ名を推定するのは危険なので設定で明示させる |

### 2.2 文脈長とトークン計測

| # | 事実（コード） | 破綻シナリオ | 修正方針 |
|---|---|---|---|
| C-1 | 圧縮の発火は `lastInputTokens >= triggerRatio × role.contextWindowTokens`。usage が 0 のときは推定値 × 1.35 で代用（`spill-compaction.ts:209, 227`） | トークン密度の高い言語・コード・未知のトークナイザでは 1.35 倍では足りず、圧縮が遅れて 400（コンテキスト超過）。`project.md` には DeepSeek で実測 1.58 倍と記録がある | provider の usage から**モデル別の係数を学習**して保持する（`token/estimate` ログに比率が既に残っている）。さらに 400 `context_length_exceeded` を検出して即時圧縮→再送する経路を追加する |
| C-2 | コンテキスト超過の 400 を捕まえる経路が無い（`agent.ts` の provider 呼び出しの catch は native ツール 400 と中断のみ） | 未知モデルで 1 回でも超過するとターンが失敗し、自動回復しない | C-1 と同じ。エラー本文の分類（context / rate / auth / shape）を 1 か所に集約する |
| C-3 | contextWindow / maxOutput の真実が 3 か所にある: `config.ts:575-660`（defaultRole）、`model-catalog.ts:36-111`、`packages/hy-cli/web/src/app.ts:2788-2820`（UI）。しかも値が食い違う（opencode 1,000,000 と 800,000、deepseek 262,144 と 393,216） | どの値が使われるか経路で変わり、期待した圧縮が働かない | 単一の真実（カタログ + ユーザー上書き）に統合し、役割設定はカタログを参照する |
| C-4 | 既定 `deepseek` ロールの model は `deepseek-flash`（`config.ts:582`）だが、カタログの登録は `deepseek-v4.1-flash`（`model-catalog.ts:50`） | 既定構成がカタログに無いため、価格・能力の既定が効かない。USD 予算を設定すると `llm.ts:1533-1535` で「pricing を設定せよ」の例外になり、**実行できない** | 既定モデルをカタログに載せる、または未登録時の扱いを「予算はトークンのみ」に落とす |

### 2.3 プロトコル・ツール

| # | 事実（コード） | 破綻シナリオ | 修正方針 |
|---|---|---|---|
| P-1 | native→text フォールバックは `status === 400 && /tool/i.test(message)` のときだけ（`agent.ts:720-725`） | 400 の本文に tool が含まれない拒否（`tools is not supported` 以外の表現、403、422）ではフォールバックしない | 分類を「ツール関連の拒否」全般に広げ、判定は本文の正規表現ではなく「tools を外して再送して成功したら以後 text」という**試行**で行う |
| P-2 | フォールバックはターン途中で system prompt を組み直す（`agent.ts:721-724`） | プロトコル切替でプレフィックスキャッシュが壊れ、履歴全体を再送する。モデルも直前までの指示と違う形式を要求される | 切替はターン境界で行い、同一ターン内は再試行メッセージで形式を教えるだけにする |
| P-3 | `apply_patch` は unified diff と file+content のみ。`*** Begin Patch` は明示的に非対応（`tool-docs.ts:109-118`） | Codex/Claude 系の訓練を受けたモデルは `*** Begin Patch` を出し続け、失敗を繰り返す | 受理する形式を増やす（Begin Patch → unified diff への変換）。プロンプトで禁止するだけにしない |
| P-4 | 引数の別名変換は 5 ツールのみ（S-11） | 未知のツール・MCP ツールでは別名が通らず、同じ失敗を繰り返す | スキーマ宣言による別名 + エラー文に正しい型を返す（既に `tools.ts:1115` に部分的にある） |
| P-5 | ツール呼び出しの復元（`reply-guard.ts`）は既知の壊れ方の列挙 | 未知の形式（YAML、関数呼び出し風、独自 XML、複数呼び出しの混在）は復元できず、2 回で `tool-protocol` 停止 | 「JSON として読めない本文からツール名と引数を抽出する」汎用パーサを 1 本持ち、失敗時は**同じ内容を再送させるのではなく**、抽出できた部分を提示して修正させる |

### 2.4 言語・タスク

| # | 事実（コード） | 破綻シナリオ | 修正方針 |
|---|---|---|---|
| L-1 | 次ステップ宣言の検出が日本語・英語のみ（S-12） | 中国語・韓国語・スペイン語などで「やります」と書いて止まり、ターンが空振りで終わる | 言語非依存の状態判定に置き換える |
| L-2 | system prompt は英語、`tool-docs.ts` はコーディング前提（read/search/patch/shell の 7 ツールのみ詳細説明）。思考要約は日本語出力を強制（`session-app.ts:1077-1088`） | 非コーディング（データ分析・文書処理）や非日本語ユーザーで、説明不足・不要な日本語出力が起きる | 役割（coding / analysis / writing）でツール説明を選ぶ。要約の出力言語は UI 言語設定に従う |
| L-3 | `WINDOWS = process.platform === 'win32'` で説明文を切り替えるが、実行系（`crates/hy-*`）は Windows 専用（`tool-docs.ts:21`） | macOS/Linux では起動時に不可解な失敗になる（推測: サンドボックスの初期化で落ちる） | 非対応 OS では起動時に明示メッセージで拒否する。README の対応表と一致させる |

---

## 3. 横断的な設計原則（汎用化の指針）

1. **名前で分岐しない。能力と形式で分岐する。** プロバイダ名・モデル名の正規表現で挙動を変える箇所（S-1〜S-6）は、能力記述（capability descriptor）と実行時の自己修復に置き換える。
2. **失敗は「学習して再送」で吸収する。** すでに `alternateTokenField` と `reasoningEffortConflict` が 400 本文から学習する形を実装している。これを `stream_options` / `response_format` / `reasoning_effort` / `temperature` に一般化し、**セッション内で学習したプロファイル**を保持する。
3. **真実の源を 1 つにする。** コンテキスト長・最大出力・価格・画像可否が `defaultRole` / `model-catalog` / UI の 3 か所にある。カタログを唯一の定義とし、他は参照にする。
4. **未知は設定で補えるようにする。** 未知モデルでも `contextWindowTokens` / `maxOutputTokens` / `tokenField` / `temperature` / `vision` / `reasoningEcho` をユーザーが与えれば正しく動く。`hy doctor` で「このモデルは未登録。次の項目を確認せよ」と案内する。
5. **言語に依存しない。** 応答の良し悪しを自然言語の正規表現で判定しない。状態（ツール呼び出しの有無、変更の有無、目的の達成）で判定する。
6. **プロトコル切替はターン境界で。** ターン途中の native→text 切替はキャッシュと指示の一貫性を壊す。

---

## 4. 未確認・未検証（正直な記載）

- 実 API での検証は限定的。`docs/enforcement-gaps.md` V4 は「Gemini と OpenAI 互換の実 API 通信は未実施」と記録している（その後 `project.md` に社外ゲートウェイ `openai-compatible:hy4` の実走記録あり）。**本監査でも実 API は呼んでいない。**
- 各破綻シナリオはコードからの推定であり、再現実験はしていない。
- サンドボックス・実行系（Rust）の非 Windows 挙動は未確認。
- 領域別の詳細は同時に作成した 4 レポート（`llm-provider-assumptions.md`, `prompt-and-toolcall-assumptions.md`, `context-and-token-assumptions.md`, `environment-and-task-generality.md`）にあり、本ファイルの結論と重複する場合は本ファイルを優先する（行番号を直接確認済みのため）。ただし内容の最終的な採否は `README.md` で判定する。
