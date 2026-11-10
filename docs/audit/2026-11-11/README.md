# HY-HARNESS 汎用性監査 — 余計な場合分けと、未知モデル・未知タスクでの破綻

- 日付: 2026-11-11
- 対象: `F:\HY-HARNESS`（未コミット変更を含む作業ツリー）
- 依頼: (1) 特定モデル・特定プロバイダ専用の余計な場合分けを洗い出し、同じ失敗を防げる汎用仕様を示す、(2) 配布先の利用者が違うモデル・違うタスクを使ったときに起きる不具合をコードから推定し、修正方針を示す。
- 制約: 初回監査（本ディレクトリのレポート）はコードを変更せずに行った。2026-11-11 の追補で §3 の P0/P1 の一部を実装した。**実装した範囲・検証結果・残件は §7 を参照。** §0〜§2 は初回監査時点の記述である。
- 表記:
  - **事実** = コードを読んで確認した内容。
  - **(推測)** = コードから導いたが、実行して再現していない内容。
  - 行番号の先頭に **✓** = オーケストレーターが実ファイルで再確認した箇所。✓ の無い行番号は領域別レポートで確認されたもので、本統合では再確認していない（付録 A〜D 参照）。

---

## 0. 結論

1. **モデル名でプロンプトを切り替える処理は無い。** `prompt.ts` の分岐は「プロンプト版」「native / text」「objective / 最終スキーマ / 通常」だけで、モデル名・プロバイダ名は現れない（B レポート §0-1）。懸念されていた「モデル X のときだけ指示を変える」形の対症療法は、プロンプトではなく **適応層・ツール呼び出しの解釈・言語ヒューリスティック** に存在する。
2. **余計な場合分けの本体は「モデル名の文字列一致で能力を推定する」こと。** `deepseek`（✓`llm.ts:467`）、`^o\d|gpt-5|gpt-6|reason`（✓`model-catalog.ts:133`）、`gpt-6.1-terra`（✓`model-catalog.ts:140`）、`gemini-3.8-flash`（✓`llm.ts:1508`）の 4 系統。カタログに無いモデルは必ずこのヒューリスティックに落ち、名前が少し違えば外れる。
3. **最も影響が大きいのは、適応リトライがストリーミング経路に無いこと。** 非ストリーミングには「`max_tokens` が拒否されたら `max_completion_tokens` で再送」「`reasoning_effort`×`tools` の衝突を検出したら effort を落とす」がある（✓`llm.ts:665-691`）が、`completeStreaming`（✓`llm.ts:482-511`）には無い。`streaming` は既定オン（✓`features.ts:18-22`）で、GUI/CLI は常に `onEvent` を渡すため、**OpenAI 互換ではストリーミングが既定経路**になる。
4. **未知モデルで最初に落ちるのはコンテキスト長。** ロールは provider 既定の窓を継承し（✓`packages/core/src/config.ts` は `MODEL_CATALOG` を import しない）、カタログの値は使われない。`openai-compatible` の既定は 1,047,576 トークンなので、実窓が 32k のモデルでは圧縮が一度も発火せず、超過 400 でターンが全損する。超過 400 を捕まえて圧縮する経路は無い（✓`agent.ts:718-728` は native ツールの 400 のみ）。
5. **配布直後に踏む環境側の穴が 3 つある。** MCP の `npx` 起動不可（✓`mcp.ts:81-87`、シェルなし `spawn`）、実行デーモン不在時のスタックトレース（✓`exec-rpc.ts:82, 98-113`、`child.on('error')` 無し）、CRLF ファイルで `edit_file` が一致しない（✓`tools.ts:861-866`、`read_file` は LF 正規化）。
6. **言語依存の判定が 1 つ残っている。** 「次にやります」と宣言して止まった応答の検出が日本語の活用形と英語の定型句のみ（✓`reply-guard.ts:456-508`）。中国語・韓国語などの利用者は、未完了のまま最終回答として受理される。

---

## 1. 余計な場合分けの一覧と汎用化案

判定: **過剰** = 一般化できるのに特定名で分けている / **誤り** = 意図と実装が食い違う、条件が広すぎる / **要確認** = 実サーバで確かめないと断定できない / **妥当** = 仕様差に由来し残すべき。

### 1.1 置き換えるべき場合分け（優先度順）

| # | 場所 | 現在の条件 | 判定 | 汎用化案 |
|---|---|---|---|---|
| G-1 | ✓`packages/core/src/llm.ts:467` | `provider === 'deepseek' \|\| /deepseek/i.test(model)` のときだけ過去の推論を `reasoning_content` として送り返す | 過剰 | ロール設定 `reasoningEcho: 'auto' \| 'always' \| 'never'` を追加。`auto` は「前回の応答でサーバが返した推論フィールドを、同じ名前で返す」という観測ベースにする。送り返し形式は `reasoning_content` / `reasoning` / thinking ブロックから選べるようにする |
| G-2 | ✓`packages/core/src/model-catalog.ts:133` | `/(^o\d\|gpt-5\|gpt-6\|reason)/i` に一致したら `max_completion_tokens` | 誤り（条件が広すぎる） | 既定は `max_tokens`。400 の本文を見て反対側で 1 回再送する既存機構（`alternateTokenField`）を一次手段にする。名前の正規表現は廃止。（推測）`deepseek-reasoner` のような名前を OpenAI 互換サーバで使うと誤送信になる |
| G-3 | ✓`packages/core/src/model-catalog.ts:140` | `!/gpt-6\.1-terra/i` で「reasoning_effort と tools を同時に送れるか」を決める | 過剰 | 既定は「同時に送る」。400 本文（`reasoning_effort` と `function tools`）で検出したらロール単位で学習・キャッシュ（`llm.ts:444` の既存検出を一般化） |
| G-4 | ✓`packages/core/src/model-catalog.ts:147` | `temperatureAllowedFor` が `tokenFieldFor === 'max_tokens'` で決まる | 誤り（無関係な項目の流用） | `tokenField` / `temperature` / `effortWithTools` / `tools` / `vision` を独立した能力フラグにする。既定は「送って 400 なら次から落とす」適応 |
| G-5 | ✓`packages/core/src/llm.ts:1508-1513` | `gemini-3.8-flash` の固定価格（2027-01-01 で 2 倍）、OpenCode Go の URL なら 0 円 | 過剰・誤り（日付依存が配布物に埋まる） | 価格はカタログとロール設定だけにする。日付・プラン依存は設定ファイルへ。未登録なら「USD 予算は使えない。トークン上限のみ」と明示して**実行は継続**（現状は例外で停止） |
| G-6 | ✓`packages/core/src/config.ts:554-566` | OpenCode のベース URL かつ `gemini-3.8-flash` のとき、保存済みモデルを黙って既定へ書き換える | 過剰 | 読み込み時の書き換えをやめ、`/models` の取得結果と突き合わせて UI で選ばせる。設定の移行はバージョン付きマイグレーションで 1 回だけ行う |
| G-7 | ✓`packages/core/src/config.ts:81-85` | `usesNativeTools` がプロバイダ enum の許可リスト | 要確認（過去に gemini の入れ忘れでターン途中に native→text へ切り替わった: `project.md:1068-1100`） | プロバイダではなく能力で決める（カタログの `capabilities.tools`、初回 400 の試行、ユーザー設定）。切替はターン境界に限る |
| G-8 | ✓`packages/hy-cli/src/session-app.ts:1071` | 思考要約の effort を `provider === 'opencode'` のときだけ `'none'` | 過剰 | 「補助ロール（summarizer / title / compactor）は既定で effort なし」とロール種別で決める（`session-title-gen.ts:81` も同様） |
| G-9 | ✓`packages/hy-cli/src/session-app.ts:1583-1587` | `cacheCompaction` を opencode / deepseek かつ compactor と同一設定のときだけ有効 | 過剰 | 「compactor が同一 provider/model/baseUrl/鍵なら prefix を再利用する」という構造条件だけにする。カタログの `capabilities.cache` は現在どの判定にも使われていない |
| G-10 | ✓`packages/core/src/model-catalog.ts:100` と ✓`llm.ts:1024` と ✓`config.ts:97` | カタログは Gemini を `vision: true`、`roleSupportsImages` も可と判定するが、Gemini アダプタは画像付きメッセージで例外を投げる | 誤り（矛盾） | 能力表を単一の真実にし、アダプタが送れない能力は `false`。未対応なら実行時例外ではなくツール結果で「このモデルは画像を受け取れない」と返す |
| G-11 | ✓`packages/core/src/model-catalog.ts:82` | `openai-responses:gpt-4.1-mini` の `compat` 定義 | 誤り（到達しない） | Responses アダプタは `tokenFieldFor` / `temperatureAllowedFor` を呼ばないため未使用。削除するか、Responses 側で意味を持たせる |
| G-12 | ✓`packages/core/src/tools.ts:42-120` | `edit_file` の `old_str`/`old_string`/`path`、`read_file` の `file`、`search_grep` の `path`→`glob` など、ツールごとに手書きの別名変換 | 過剰 | `ToolSpec` に `aliases: Record<string,string>` を宣言させ、汎用変換 1 本で処理する。単一キーオブジェクト（`{"shell":{…}}`）の展開も汎用規則にする |
| G-13 | ✓`packages/core/src/reply-guard.ts:456-508` | 「次にやります」宣言の検出が日本語の活用形と英語の定型句のみ | 誤り（言語依存） | 言語推定をやめ、「ツール呼び出し 0 回」「ファイル変更なし」「目的が未達」という**状態**で 1 回だけ確認する。objective / goal モードの「claim 以外は final にしない」を通常モードへ一般化する |
| G-14 | `packages/core/src/reply-guard.ts:13-24, 126-127` | 壊れた呼び出しの検出がテンプレート閉じタグの列挙（`</｜DSL…`, `</tool_call`, `</function`, `Begin Patch` など） | 要確認（未知タグは検出できない） | 「本文中の `</[A-Za-z_｜|][^<>\n]{0,40}>` が JSON 片と同居するときだけ壊れた呼び出し」という一般規則にする |
| G-15 | ✓`packages/core/src/reply-guard.ts:334` | `recoverTemplateCall` は `{` 始まり以外を復元しない | 誤り（XML 単体は検出のみ） | `<tool_call>` / `<function=NAME>` / `<parameter name=…>` を JSON へ変換する汎用パーサを追加する |
| G-16 | ✓`packages/core/src/prompt.ts:230-265` | `lean3` と `lean4` の system prompt は文字列として同一で、差は `nativeToolDefs` の `rich` だけ | 過剰（重複分岐） | 1 分岐に統合し、「詳細ツール説明」を `richToolDocs: boolean` として版から切り離す。`legacy` / `lean` / `lean2` はベンチ専用にし、配布設定からは選べなくする |
| G-17 | ✓`packages/hy-cli/web/src/app.ts:2788-2820` | UI がプロバイダ既定値とモデル一覧を独自に持つ（`deepseek` の maxOutput 393,216、`opencode` の context 1,000,000） | 誤り（重複定義） | 既定値はコアの `defaultRole` / `model-catalog` から API 経由で配る。UI 側の定数表を削除する |
| G-18 | `packages/core/src/llm.ts:389` | Ollama へ常に `think: false` | 要確認（推論モデルの推論を常に捨てる。テストなし） | ロールの `effort` / `thinking` 設定に連動させる |
| G-19 | `packages/hy-cli/src/doctor.ts:53-59` | API キー環境変数名をプロバイダ名の三項演算子チェーンで決める（`defaultRole` と二重管理） | 過剰 | 環境変数名は `defaultRole` だけが持ち、doctor は `role.apiKeyEnv` を読む |
| G-20 | ✓`packages/core/src/config.ts:540-541` | `deepseek-flash` / `deepseek-v4-flash` → `deepseek-v4.1-flash` の読み替え | 妥当（期限付き移行） | そのまま残す。ただし「いつまで」をコメントに明記し、削除予定を残す |

### 1.2 残すべき分岐（「場合分け」に見えるが妥当）

- **プロバイダ別アダプタ**: Anthropic Messages（`llm.ts:1218` 付近）、OpenAI Responses（`llm.ts:1311` 付近）、Gemini Interactions（`llm.ts:1007` 付近）、Ollama `/api/chat`（`llm.ts:379` 付近）。HTTP パス・ヘッダ・ボディ・応答ブロックが根本的に違うため、共通化すると壊れる。
- **Anthropic の `cache_control` ブレークポイント**（`llm.ts:1184, 1200`）: 明示指定が必要な仕様。
- **OpenCode のセッションヘッダ**（`llm.ts:483, 641`）: キャッシュのルーティングキー。
- **Ollama の `format: 'json'`**（✓`llm.ts:391`）: 構造化出力の仕様。
- **`mock` / `ollama` を課金対象外にする**（`llm.ts:1531`）: ローカル実行に費用は無い。
- **プラットフォーム別の説明文**（✓`tool-docs.ts:21`）: 環境依存であってモデル依存ではない。

---

## 2. 未知モデル・未知タスクで起きる不具合と修正方針

### 2.1 未知モデル（API 形状・能力）

| # | 発生条件 | 症状・影響 | 修正方針 |
|---|---|---|---|
| M-1 | 未知の OpenAI 互換サーバが `stream_options` / `response_format` / `reasoning_effort` を 400 で拒否（✓`llm.ts:499, 502, 503`） | 既定のストリーミング経路には適応リトライが無く、**ターン全損**（✓`llm.ts:482-511`） | 「400 の本文に送ったパラメータ名が含まれたら、そのパラメータだけ落として 1 回再送し、成功した組み合わせをロールにキャッシュ」する汎用ネゴシエータを、ストリーミングにも入れる |
| M-2 | サーバが `[DONE]` も `finish_reason` も返さない | 正常な応答でも `stream ended before the response was complete` で失敗（✓`llm.ts:625`） | `[DONE]` 無しでも「接続の正常終了 + 本文あり」で完了とみなす設定を用意し、既定は緩和側にする |
| M-3 | サーバが `delta.content` を配列（`[{type:'text',…}]`）で返す | 文字列だけを連結するため（✓`llm.ts:592`）、空応答になる | content / reasoning の正規化関数を 1 つ作り、文字列・配列・`reasoning_details` 等を受ける |
| M-4 | usage を返さない / フィールド名が違う | `inputTokens = 0` になり、`get_context_remaining` が「全部残っている」と誤答。圧縮の事前要約も発火しない | usage を正規化し、欠落時は `source: 'estimated'` として推定値を返す。生の usage も保持して事後に追えるようにする |
| M-5 | 名前が `reason` を含む非 OpenAI 系モデル（例: `deepseek-reasoner`）を OpenAI 互換で使う | `max_completion_tokens` を送って 400（推測） | G-2 のとおり、名前判定を廃止し 400 ベースにする |
| M-6 | 推論の返送を要求する / 拒否するモデル（DeepSeek 以外） | 返送しないと品質低下、返送すると 400（推測） | G-1 の観測ベース + `reasoningEcho` 設定 |
| M-7 | 認証が Bearer 以外（Azure OpenAI の `api-key`、社内 GW の `x-api-key`、OAuth） | 設定だけでは使えない。401/403 で停止（✓`llm.ts:488, 646, 1377` に Bearer 固定、`config.ts` にヘッダ設定なし） | ロールに `headers`（テンプレート可）と `extraBody`、パス結合の制御を追加。既定は Bearer |
| M-8 | baseUrl の末尾や `/v1` の有無が想定と違う、クエリが必要 | 404/400（推測） | `baseUrl` を URL として組み立て、`apiPath` を設定可能にする |
| M-9 | 実窓が provider 既定より小さい未知モデル | 圧縮が発火せず、超過 400 でターン全損（§0-4） | (a) 未知モデルは保守的既定（32k など）に落とす、(b) 400 の本文（`context`, `token`, `too long`, `maximum`）を検出して Tier 1→Tier 2 圧縮→1 回再試行する経路を `agent.ts:718-728` に追加、(c) ロールの窓を `() => number` で遅延評価し `/model` 切替に追随させる |
| M-10 | ネイティブ呼び出しの `args` が文字列 / 配列で返る | `agent.ts:833` が即拒否し、2 回目でプロトコル降格（✓`agent.ts:796-804`）。`tools.ts:42-48` は文字列を受けるのに層で不整合 | `agent.ts` から `normalizeToolArgs` に委譲し、文字列は `parseLooseJsonObject`、単一要素配列は unwrap する。降格は「2 回連続」にし、UI に表示する |
| M-11 | XML 単体・独自タグのツール呼び出し | 検出はするが復元できず、2 回で `tool-protocol` 停止（✓`reply-guard.ts:334`） | G-15 の汎用パーサ |
| M-12 | 画像を渡す（Gemini） | カタログは可、アダプタは例外（✓`model-catalog.ts:100` / `llm.ts:1024`） | G-10 |
| M-13 | USD 予算を設定し、価格未登録のモデル（既定の `deepseek` ロール `deepseek-flash` はカタログ未登録）を使う | `Set pricing for … before running with a session cost limit.` で**実行できない** | 未登録時の扱いを「トークン上限のみ」に落とす。既定モデルをカタログに載せる |

### 2.2 未知タスク・環境

| # | 発生条件 | 症状・影響 | 修正方針 |
|---|---|---|---|
| T-1 | 非 Windows（macOS / Linux / WSL）で起動 | Rust 側が `#![cfg(windows)]` でビルドできず、CLI だけ起動して「実行だけできない」状態。エラーはスタックトレース（D レポート §1.1） | 起動時に `process.platform` を検査して明示的に拒否し、README の対応表と一致させる |
| T-2 | 実行デーモンが見つからない（配布物に同梱漏れ、`pnpm build` のみ） | `resolveServerPath` が裸の `hy-exec-server` を返し（✓`exec-rpc.ts:82`）、`child.on('error')` が無いため未処理例外（✓`exec-rpc.ts:98-113`） | spawn 前に存在確認し、1 行で「`cargo build -p hy-exec-server` か `--exec-server <path>`」と返す。`'error'` を購読して同じ経路で reject する |
| T-3 | 英語版 Windows・中国語版など（ANSI コードページが CP932 以外） | 一回限りの `shell` 実行の出力が化ける（✓`jobs.rs` は非 UTF-8 を Shift_JIS でデコード、✓`cmdline.rs:119` は `$ProgressPreference` のみ設定）。永続シェルは ✓`shell.rs:25-27` で UTF-8 を設定済み | 一回限りの経路にも `[Console]::OutputEncoding = UTF8` を前置きし、残りは `GetACP` に応じたコードページでデコードする。設定で上書き可能にする |
| T-4 | CRLF のファイル（Windows 既定の `core.autocrlf=true`） | `read_file` は LF に正規化して返すが、`edit_file` は生文字列で照合するため必ず不一致（✓`tools.ts:861-866`）。全置換に走り差分が巨大化 | 照合時だけ CRLF を LF に正規化し、書き戻しは dominant-EOL 保存に任せる |
| T-5 | MCP 設定が `npx` / `uvx` / `pnpm`（`.cmd` シム）を使う | Windows ではシェルなし `spawn` のため起動不可（✓`mcp.ts:81-87`）。Claude Desktop 等から取り込んだ設定はほぼ該当 | `PATHEXT` で解決し、`.cmd`/`.bat` は `cmd /d /s /c` 経由にする（`documents.ts:142-150` に既存実装あり） |
| T-6 | BOM 付き UTF-8、CP932 の CSV / 設定ファイル | `read_file` は化けた内容で成功し、`apply_patch` は「not valid UTF-8」で拒否。`edit_file` で BOM が二重化しうる（D レポート §1.2） | 非 UTF-8 を検出したら結果に明示し、UTF-8 へ変換して保存する選択肢を提示する。BOM は読み取りで落とし、書き戻しで復元する |
| T-7 | 数 GB の CSV・ログ（データ分析） | `read_file` は 400 行制限の前にファイル全体を読むため、メモリ不足で落ちる（D レポート §1.3） | `stat.size` で上限を設け、範囲指定を促す。範囲指定時はストリーム読みにする |
| T-8 | `delegate` でサブエージェントに大量ファイルを読ませる | サブエージェントには `context`（圧縮）が渡っておらず（`session-app.ts:1028-1062`）、窓を超えると 400 で失敗 | サブエージェントにも `SpillCompaction` と Ledger を渡す |
| T-9 | 長時間の対話セッション | 対話経路に `Budget4D` が無く（✓`session-app.ts:1280` の引数が `undefined`）、`agent.ts` の step ループにも上限が無い。トークン上限設定が効かない | 対話にも tokens / USD の予算を既定で適用し、step 上限を `limits` に出す |
| T-10 | 非コーディングのタスク（文書処理・データ分析）／非日本語利用者 | システムプロンプトは "coding agent"、詳細ツール説明は read/search/patch/shell の 7 ツールのみ（✓`tool-docs.ts`）。思考要約は日本語出力を強制（`session-app.ts:1077-1088`） | 役割（coding / analysis / writing）でツール説明を選ぶ。要約の出力言語は UI 言語設定に従う |
| T-11 | 設定 JSON が壊れている（末尾カンマ・コメント・BOM） | `readJson` が解析失敗を握り潰し、設定が丸ごと既定に戻る（D レポート §1.5）。利用者は気づけない | 解析失敗を警告し、`hy doctor` で `warn` にする |
| T-12 | hooks / skills / plugins の書式が想定外 | 検証が無く、文字列配列を書くと先頭 1 文字を実行しようとする。壊れた skill は黙ってスキップ（D レポート §1.4-1.5） | ロード時に型検証し、読み込めなかったものを `hy doctor` に出す |
| T-13 | 企業プロキシ配下（`HTTPS_PROXY` 必須、TLS 傍受） | `web_fetch` / `web_search` が `fetch failed` で失敗（D レポート §1.4） | `HTTPS_PROXY` / `NO_PROXY` を読み、失敗時は cause を表示する |

---

## 3. 修正の進め方

### P0: 配布前に直す（未知モデル・初回起動で確実に踏む）

1. ストリーミング経路に、非ストリーミングと同じ適応リトライを入れる（M-1）。**変更範囲が狭く効果が最大。**
2. コンテキスト超過 400 の検出と自動圧縮→再試行、未知モデルの保守的既定窓（M-9）。
3. `agent.ts` の引数検査を `tools.ts` に委譲し、文字列 args を受ける（M-10）。
4. プロトコル降格を「2 回連続」にし、UI に表示する（M-10）。
5. MCP の Windows `.cmd` 起動対応（T-5）。
6. 実行デーモン不在時の明示エラーと `child.on('error')`（T-2）。
7. `edit_file` の CRLF 正規化（T-4）。
8. Gemini の画像可否の矛盾を解消（G-10 / M-12）。
9. 認証ヘッダ・`extraBody`・パス結合の設定口（M-7）。

### P1: 汎用化（設計変更を伴う）

10. 能力フラグ化（G-1〜G-4）とカタログの単一真実化（G-17、カタログ未参照の解消）。
11. 汎用パラメータ削除ネゴシエータを 1 本に統合する（M-1 と共通）。
12. XML / 独自タグのツール呼び出しパーサ（G-15）と、閉じタグ列挙の一般規則化（G-14）。
13. 引数別名のデータ駆動化（G-12）。
14. 言語非依存の「宣言して停止」判定（G-13）。
15. 一回限りシェル経路の UTF-8 設定とコードページ対応（T-3）。
16. 非 Windows の明示拒否（T-1）。
17. プロンプト版の縮約と `richToolDocs` の分離（G-16）。
18. サブエージェントへの圧縮導入（T-8）、対話セッションの予算（T-9）。
19. usage / finish_reason の正規化（M-4）。

### P2: 余裕があれば（低優先）

- `doctor` のロール網羅（G-19、C レポート C-13）
- 設定読み込み失敗の警告（T-11）、hooks / skills の検証（T-12）
- `web_fetch` の charset 対応（D レポート §1.2）
- symlink スキップ件数の注記、`read_file` のサイズ上限（T-7）
- プロキシ対応（T-13）
- `config-schema.ts` のモデルプリセットを CLI からも効くようにする（A レポート §1.3）

---

## 4. 低優先と判断したもの（理由付き）

- **`reply-guard` の修復パターン追加**（既知の壊れ方を 1 つずつ増やす）: 個別追加は将来の未知形式に効かない。汎用パーサ（G-15）を優先し、個別パターンは残すが主経路にしない。
- **`promptVariant` の各版の再測定**: 効果測定は `docs/prompt-tuning-handover.md` に既存。配布判断に必要なのは版の縮約（G-16）であり、再測定は不要。
- **UI 文言の多言語化**: 機能の正しさに影響しない。G-13 と T-10 の言語依存を先に直す。
- **Ollama `think: false`（G-18）**: ローカル推論モデルの推論を捨てる問題だが、影響は品質のみで停止しない。設定で上書きできるようにすれば足りる。
- **モデル名エイリアス表（G-20）**: 妥当な移行措置。期限を明記して残す。
- **`capabilities.tools` / `reasoning` の表示専用利用**: 表示自体は害が無い。G-7 の能力判定に使うとき一緒に直す。

---

## 5. 未検証・確度の限界（正直な記載）

- **実 API は呼んでいない。** 本監査はコードの読解のみ。`docs/enforcement-gaps.md` V4 は「Gemini と OpenAI 互換の実 API 通信は未実施」と記録しており、その後 `project.md` に社外ゲートウェイ（`openai-compatible:hy4`）の実走記録があるが、Azure・vLLM・LM Studio・OpenRouter 等は未確認。
- **再現実験をしていない項目**: ストリーミング 400、`[DONE]` 欠落、content 配列、usage 欠落、CRLF の `edit_file`、CP1252/CP936 の文字化け、BOM 二重化、MCP `npx` 起動、非 Windows 起動。いずれもコード経路からの推定。
- **サンドボックスの制約**: 本監査環境では `spawn` が EPERM で拒否され、外部コマンドを伴う検証ができなかった（D レポート §検証ログ）。
- **優先度は判断を含む**: 「配布前に直す」は、利用者が最初に踏む確率と復旧の難しさで並べた。工数見積りはしていない。
- **`docs/implementation_status.md` の該当節は未参照**（A レポート）。既存文書との重複は各レポートで注記した範圍のみ確認した。

---

## 6. 付属レポート

| ファイル | 担当領域 | 行数 |
|---|---|---|
| `00-verified-findings.md` | オーケストレーターが直接確認した事実（本 README の骨子） | 90 |
| `llm-provider-assumptions.md` | A: LLM プロバイダ適応層・モデル能力カタログ（一覧 39 行、破綻シナリオ 11 項目、file:line 229 箇所） | 273 |
| `prompt-and-toolcall-assumptions.md` | B: プロンプト・ツール呼び出し・応答修復（判定表、差し替え文面、破綻シナリオ 8 項目） | 242 |
| `context-and-token-assumptions.md` | C: 文脈長・トークン計測・圧縮・ロール構成（一覧 16 行、破綻シナリオ 10 項目、既定値表 23 行） | 190 |
| `environment-and-task-generality.md` | D: 環境・タスク汎用性・配布時リスク（一覧 31 行、未知タスク 7 種、対応不要 11 件） | 298 |

本 README と各レポートが食い違う場合は、行番号を直接確認した **本 README と `00-verified-findings.md` を優先**する。各レポートには、本 README が採用しなかった細目・テスト行番号・既存文書との差分が残っている。

---

## 7. 実装状況（2026-11-11 追補）

利用者の指示（「検証できる部分は検証しつつ修正する」「調べないと分からない可変的な事項はハーネスに持たせずユーザー登録にする」）に沿って、次の項目を実装した。

### 7.1 実装した項目

| 監査ID | 変更 | 主なファイル |
|---|---|---|
| G-2 / G-3 / G-4 / G-11 | モデル名の正規表現（`^o\d`/`gpt-5`/`gpt-6`/`reason`、`gpt-6.1-terra`）と、tokenField から temperature を導く従属を削除。未登録モデルは汎用の既定（`max_tokens`・temperature 可・effort+tools 可） | `packages/core/src/model-catalog.ts` |
| 新方針 | 組み込みのモデル別データ（価格・コンテキスト長・能力）を廃止し、`config.json` の `models[]` を唯一の台帳に。`pricing` / `compat` / `capabilities` を登録できる | `model-catalog.ts`, `config.ts`, `config-schema.ts` |
| G-1 | `deepseek` 名判定を削除。推論の返送は「そのエンドポイントが返したら以後返す」観測ベース＋`role.reasoningEcho` / `models[].compat.reasoningEcho` で強制可能 | `packages/core/src/llm.ts` |
| M-1 / R-1〜R-3 | 400 の本文から拒否された任意フィールド（tokenField / effort / stream_options / response_format / temperature / reasoning_content / tools）を判定し、1 回だけ落として再送。**ストリーミング経路にも適用** | `packages/core/src/llm-negotiate.ts`（新規）, `llm.ts` |
| M-3 / M-4 | `content` の配列と、usage のフィールド名差（`input_tokens` 等・cache 系）を正規化 | `llm-negotiate.ts`, `llm.ts` |
| M-7 / R-7 | `role.headers`（`${apiKey}` 置換）、`extraBody`、`apiPath`、`requestTimeoutMs` を追加。当初は OpenAI 互換にのみ適用し、§8.2 の追記で全アダプタ（Ollama / Gemini / Anthropic / Responses）へ拡張 | `llm.ts`, `config.ts`, `llm-negotiate.ts` |
| G-5 / M-13 | Gemini 固定価格・日付分岐・OpenCode 0 円を削除。価格はロールか `models[]` の登録のみ。未登録で USD 上限を指定した場合は理由を明示して停止 | `llm.ts` |
| G-6 | 読み込み時に OpenCode の特定モデルを黙って書き換える処理を削除（選択時の検証は残す） | `config.ts` |
| G-10 / M-12 | Gemini は画像を送れないため `roleSupportsImages` を false に（カタログは廃止） | `config.ts` |
| G-12 | `ToolSpec.aliases` を追加し、ツール別の手書き別名をデータへ移動 | `tools.ts`, `tool-registry.ts`, `session-app.ts` |
| G-15 / M-11 | XML 単体のツール呼び出し（`<tool_call>` / `<function=…>` / `<invoke>` / 既知ツール名タグ）を汎用パーサで復元 | `reply-guard.ts` |
| G-13 | 「宣言して停止」の検出は既定の日本語・英語を残し、`announcePatterns` でユーザーが言語別パターンを登録できるようにした | `config.ts`, `agent.ts` |
| G-16 | lean3 と lean4 の分岐を統合し、詳細ツール説明を `richToolDocs`（既定 true）へ分離。native プロンプトに `<untrusted_…>` はデータである旨を追加 | `prompt.ts`, `tool-docs.ts` |
| G-8 / G-9 | summarizer / title の effort を「補助ロールは既定 none」に。`cacheCompaction` はプロバイダ名ではなく compactor との同一ルートだけで判定 | `session-app.ts`, `session-title-gen.ts` |
| G-19 / C-13 | 鍵の環境変数名を `roleApiKeyEnv` に一本化し、`hy doctor` は設定済みの全ロールを検査 | `config.ts`, `doctor.ts` |
| 新方針（サンドボックス） | 制限付きモードの `spawn EPERM` / `0xC0000142` を**終了状態から判定**し、コマンド形ごとに一度だけ low-integrity への昇格を承認カードで尋ね、承認後に同じコマンドを再実行する。承認できるのはユーザーだけ（Guardian 不可）。`pipeChildGap` の誤検知（部分一致）も、行頭の Node エラー行に限定して解消 | `packages/core/src/tools.ts` |
| M-9（圧縮側） | `ContextManager.forceCompact` を追加。コンテキスト超過の 400/413 を検出したら強制圧縮して 1 回再試行。step 上限も追加 | `agent.ts`, `packages/seams/src/spill-compaction.ts` |
| M-10 | ネイティブ引数の文字列・単一要素配列を正規化。ツール非対応 400 の判定を「能力拒否の文言」に限定 | `agent.ts` |
| T-4 | `edit_file` を LF 正規化して照合し、ファイルの支配的な改行で書き戻す | `tools.ts` |
| T-5 | Windows で `npx`/`uvx`/`pnpm` の `.cmd` シムを `PATHEXT` で解決し `ComSpec` 経由で起動 | `mcp.ts` |
| T-2 | 実行デーモンが見つからない場合の 1 行エラーと `child.on('error')` | `exec-rpc.ts` |
| T-3 | 一回限りのシェルにも `[Console]::OutputEncoding = UTF8` を前置き（永続シェルと同じ） | `crates/hy-exec-server/src/cmdline.rs` |

### 7.2 検証（実行したもの）

| 検証 | 結果 |
|---|---|
| `tsc -b packages/core packages/seams packages/hy-cli packages/sdk` ＋ web / desktop の型検査 | **成功（exit 0）** |
| 単体テスト `node --test "packages/*/dist/**/*.test.js" "packages/hy-cli/web/test/*.test.mjs"` | **全件 pass（exit 0）** |
| 回帰 `pnpm test:regression` | 9 pass / 20 skip / **0 fail**（skip はサンドボックスの EPERM） |
| `cargo build -p hy-exec-server` / `cargo test -p hy-exec-server` | 成功 / **42 passed** |
| `pnpm gen:config-schema` / `check:config-schema` | 再生成・一致 |
| 隔離 config でのスモーク | `richToolDocs=false`・`announcePatterns`・`models[]` の registry・`compat.tokenField`・Gemini の vision=false を確認 |
| 統合テスト（個別実行） | `models.test.mjs` / `onboarding.test.mjs` は pass。`edit-tools.test.mjs` は workspace-write の private temp が作れず 1 件が環境要因で失敗 |
| 昇格機構の単体テスト | `tools.test.ts` に 3 件追加（検出の厳格化、コマンド形ごとに1回だけ尋ねる、Guardian の承認では昇格しない）。全件 pass |
| パッケージ生成 `pnpm desktop:package:next`（サンドボックス解除後） | **成功**。`release/next/HY-HARNESS-0.5.54-20261111-0304.exe`（196,126,389 bytes、SHA-256 `35B0C83A…78AE72A0`）。コード署名なし |

### 7.3 未実装・残件

- **G-7**（`usesNativeTools` の能力化）、**G-17**（Web UI の既定値の重複解消）、**M-2**（`[DONE]`/`finish_reason` 欠落の許容）。M-2 は「切断された応答を完了として黙認しない」安全側の判断で、既定は厳格のままにした。
- **M-9 の (a)**（未知モデルの保守的既定窓）。ロールの窓は依然として provider 既定を継承する。400 の自動回復は実装したが、初回超過は起きる。
- **T-6〜T-13**（BOM・非 UTF-8、巨大ファイル、symlink、サブエージェントの圧縮、対話セッションの予算、役割別プロンプト、設定 JSON の警告、hooks/skills の検証、プロキシ）。
- 価格・互換フラグを GUI から登録する画面（現状は `config.json` の `models[]` を直接編集）。
- **昇格の記憶の範囲**: 承認したコマンド形はそのセッション内だけ記憶し、プロセスを終えると忘れる。`policy.star` への永続化は GUI の承認カードの「常に」に委ねている（エージェントからワークスペース外の設定は書かない方針）。
- `docs/implementation_status.md` など既存文書のうち、モデル台帳・プロンプト版・doctor の記述は本追補に合わせて未更新の箇所がある（`docs/codex-adoption-progress.md` の doctor 記述のみ更新済み）。

### 7.4 挙動の変更（利用者に影響する点）

- `hy models` と `/api/models` は**登録済みのモデルだけ**を返す（組み込みの一覧は無い）。ロールは `roles.*` の値だけで動く。
- USD 予算を使うには、そのモデルの `pricing` をロールか `models[]` に登録する必要がある。
- 推論の送り返しは「そのエンドポイントが返したら以後返す」。再開直後の 1 リクエストは返送しない（強制するには `reasoningEcho: true`）。
- ツール非対応とみなして JSON テキストへ切り替える条件が、`/tool/i` から「能力拒否の文言」に狭まった。
- ベンチの旧プロンプト版（hy-lean / hy-legacy / hy-lean2 / hy-lean3）は `richToolDocs: false` を明示して過去条件を保つ。

### 7.5 実 API での確認（2026-11-11 追記）

`OPENCODE_API_KEY` はユーザー環境変数（User スコープ）に存在し、プロセス環境には継承されていなかった。User スコープから読み出して子プロセスへ渡し、`opencode / deepseek-v4.1-flash` で次を実走した（短いプロンプトのみ）。

| 確認 | 結果 |
|---|---|
| ストリーミング + ツール無し | 200。`{"ok":true}` を受信、usage（in 50 / out 8）を解析 |
| ストリーミング + ネイティブツール | 200。`read_file` のツール呼び出しと引数オブジェクトを解析 |
| 推論の返送 | 1回目で reasoning 55 文字を受信。2回目のリクエストに `reasoning_content` が入り 200、正答（`5`） |
| `max_completion_tokens` | このゲートウェイは**そのまま受理**（200）。トークン上限フィールドの切替は不要だった |
| 400 の適応リトライ | **再現できず**。範囲外 temperature（5）、`reasoning_effort: 'ultra'`、不正なツール名のいずれも 200 で受理された。このゲートウェイは検査が緩く、実 400 を起こせない |

この結果から、ストリーミング経路・ツール呼び出し・usage・推論返送は実 API で動作を確認できた。一方、**400 を受けてのフィールド削除と再送はスタブサーバのテストのみ**で、実サーバでは未確認である。コンテキスト超過 400 からの `forceCompact` も、巨大なリクエストを送る必要があるため未実施。

サンドボックスの昇格（`spawn EPERM` → 一度だけ尋ねる）は単体テストで確認した。実環境で制限付きセッションを開いて確認するには、利用者がサンドボックスを `workspace-write` に戻した状態で、パイプを必要とするコマンド（例: `pnpm desktop:package:next`）を実行する必要がある。

---

## 8. 別セッション報告の検証（2026-11-11 追記）

別セッションが提示した「モデルを最大限有効活用する」観点の改善提案を、4領域に分けて実コードと突き合わせた。詳細は `verify-provider-layer.md` / `verify-agent-budget.md` / `verify-prompt-tools.md` / `verify-runtime-orchestration.md`。

### 8.1 判定

| 主張 | 判定 | 差分・補足 |
|---|---|---|
| 1. 毎ターンの provider 再生成で `drop` / `echoReasoning` が消える | **正確** | `session-app.ts:1744,1784,1582` → `createProvider` → 新規 `OpenAiProvider`。KV キャッシュへの影響はプロバイダの prefix 保持粒度に依存（(推測)）。`Agent` の `native` フラグもターンごとに戻る |
| 2. Ollama/Gemini/Anthropic/Responses の能力欠落 | **正確** | 個別の差分: Anthropic は `temperature` を送る（ただし thinking 未有効時）、Responses は `reasoning.effort` を送るが応答 reasoning と `call_id` を捨てる。**今回、下記 8.2 を実装して大半を解消** |
| 3. 予算のリトライ禁止・全量予約・cache 単価無視 | **正確** | 追加の欠陥: usage 欠落でも予約が残る、予約超過は素の `Error`、`reservedCostUsd` が永続化されて戻らない、ralph は cache 単価を無視、`--max-cost-usd` の help と既定値が不一致 |
| 4a. 降格時に `brokenRetried` を戻さない | **正確** | 既存テスト `agent.test.ts` が現挙動を固定している |
| 4b. 待機復帰で履歴に assistant を積まない | **正確** | `turn/end` は記録するが最終文はログに残らず、リロード/エクスポートで消える |
| 4c. `blockedSteps` が通算／`unchanged` 未クリア | **正確** | 前半は早期 stall の実害。後半は回数カウンタであり結果キャッシュではないため影響は限定的 |
| 4d. フェンス内壊れ JSON・並列 XML 拒否・型なし引数 | **正確** | 3点とも実測で確認 |
| 5-1. lean4 が規則を逃がし `richToolDocs:false` / `native:false` で消える | **一部正確** | `richToolDocs:false` では4種すべて消える。`native:false` は `renderToolPrompt` の短縮説明で PowerShell・read-before-edit・patch の基本は残り、**両経路で消えるのは「検索は search_*」だけ** |
| 5-2. `ptc:false` で `job_*` が操作不能 | **正確（条件付き）** | `stdinPipe` のジョブは `write_stdin` で出力を取れる。`run_code` の dispatch は `ptc` を見ない |
| 5-3. `edit_file` が cwd / UTF-16 を迂回 | **正確** | `write_file` も同じ。UTF-16LE+BOM で「読めるが一致しない」ことを実測 |
| 5-4. MCP 全公開・`readOnly:false` 固定 | **ほぼ正確** | `mcp_call` カタログ側に 40件/160字の上限はある。`readOnlyHint` を取得して捨てている |
| 5-5. LSP の `.cmd` 非対応・stderr 破棄 | **正確** | `lsp.ts:183-190` は素の `spawn` |
| 6-1. 4 MiB 超出力の末尾欠落・CP932 フォールバック | **正確** | `Captured` は単純打ち切り。真の末尾はログに残り `job_output` で取れる場合がある。CP932 化は Windows 限定 |
| 6-2. クライアント側タイムアウトでキャンセルされない | **正確** | `hardTimeoutMs` を `request` が参照しない |
| 6-3. 承認タイムアウト後の `blocked` 固着 | **正確** | `web-server.ts:2040-2045` / `3036-3041` / `3068` を実確認 |
| 6-4. サブエージェントへの `worker.md` 誤注入 | **正確**（Web の worker / orchestrator 経路） | `session-app.ts:1052,1329,1354` + `web-server.ts:1965` |
| 6-5. verifier-ralph の tamper / Gate 2 | **正確** | `rollback()` なしで `continue`。64KB 超の正しい大規模変更は原理的に通らない |
| 6-6. ベンチの測定盲点 | **一部正確** | `null` 化の範囲が主張より狭い。その他は未検証 |
| 6-7b. 親の二重ステータス/対話注入 | **確認不能** | 対象箇所を特定できず |

### 8.2 検証中に実装した改善（アダプタの一般化）

主張2の指摘を受け、`packages/core/src/llm.ts` を次のように一般化した（ビルド・単体テスト成功）。

- `extraBody` / `apiPath` / `requestTimeoutMs` を **全アダプタ**で適用（従来は OpenAI 互換のみ）。タイムアウトは共通の `requestSignal` に統一。
- Anthropic: `effort` を `thinking.budget_tokens` に変換（`none` は無効、`max`/`xhigh` は 32,768 に丸め、`max_tokens` 未満にクランプ）。thinking 有効時は `temperature` を送らない。
- Gemini: `effort` を `low|medium|high` に写像（`minimal`→low、`xhigh`/`max`→high、`none`→送らない）。
- Responses: `temperature`（reasoning 無効時のみ）と応答の reasoning summary、`function_call.call_id` を取得。
- Ollama: `think` を `effort` に連動（未指定/none は off）。

### 8.3 未修正（検証で確定した欠陥）

- 主張1（ターンを跨ぐ互換学習の共有）、3（予算の予約・精算・cache 単価）、4a〜4d（エージェントループ）、5-1〜5-5、6-1〜6-6。
- `docs/audit/2026-11-11/README.md` §1〜§7 の行番号は初回監査時点のもので、実装変更により一部ずれている（例: `prompt.ts` の lean4 分岐は現在 241-288 付近、`mcp.ts` の spawn は 149 付近）。内容の判定は変わらない。

---

## 9. 残っていた欠陥の実装（2026-11-11・追補2）

§8.3 に残した項目を実装した。

### 9.1 実装

| 主張 | 変更 | 主なファイル |
|---|---|---|
| 1 | `drop` と `echoReasoning` を `${provider}\|${baseUrl}\|${model}` 単位のプロセス共有状態に移し、ターンを跨いで学習を保つ（役割の明示指定が最優先） | `llm-negotiate.ts`, `llm.ts` |
| 3 | `degenerate`・usage 不正・例外時に必ず `settle(maximum)` を呼び予約を残さない。予算下でも 5xx・通信エラーを再試行（5xx 非課金の前提をコメント化）。`Budget4D.record` が `cachedInputTokens` を受け取り `cachedInputPerMTokUsd` で計算、`meter` が `cacheHitTokens` を渡す | `llm.ts`, `budget.ts` |
| 4a | プロトコル降格時に `brokenRetried` を戻し、降格直後の1回の書式ミスで即停止しない | `agent.ts` |
| 4b | 待機復帰の最終文を assistant として履歴とログに残す | `agent.ts` |
| 4c | 成功した呼び出しで `blockedSteps` を戻す。`shell` / `run_code` 成功時は他の `unchanged` 観測を無効化（失敗した shell は維持） | `agent.ts` |
| 4d | 未閉じフェンスは中身を判定対象に残す。`looksLikeBrokenToolCall` が「`{` 始まりで括弧/文字列が崩れている・ツール系キーを含むのに JSON でない・末尾が `…`」を拾う。**native でも同じ判定**で `action` を捨てる。XML は複数呼び出しを `{"calls":[…]}` にまとめ、型付き引数にも対応 | `reply-guard.ts`, `agent.ts` |
| 5-1 | `richToolDocs: false` と text モードで、シェル構文・read-before-edit・検索・patch 形式の短い規則を必ず含める | `prompt.ts` |
| 5-2 | `job_status` / `job_output` / `job_wait` / `job_kill` を `wire: true` にし、`shell` があるセッションでのみ提示（`wireRequires: 'shell'`） | `tool-registry.ts`, `tools.ts` |
| 5-3 | `edit_file` が `resolveRootPath`（`working_directory`）と `decodeTextBuffer` を使い、検出した `encoding` を `patch/apply` に渡す。daemon は UTF-8 / UTF-8 BOM / UTF-16LE / UTF-16BE を読み書き（BOM は1つだけ） | `tools.ts`, `patch.rs`, `server.rs`, `hy-protocol` |
| 5-4 | MCP は `readOnlyHint === true` のときだけ readOnly。説明は 400 文字で切り詰め | `mcp.ts`, `tools.ts` |
| 5-5 | LSP も MCP と同じ `stdioCommand` で Windows の `.cmd` を `ComSpec` 経由で起動し、stderr の末尾を保持して異常終了時に出す | `lsp.ts` |
| 6-1 | `Captured` を「先頭 + 末尾リング」に変え、`clip` が真の末尾を返す。CP932 フォールバックは**行単位** | `jobs.rs` |
| 6-2 | タイムアウト時に `$/cancelRequest` を送る。`execTimeoutMs` が `hardTimeoutMs` より十分大きい期限を導出 | `exec-rpc.ts` |
| 6-3 | 承認タイムアウトで保留が無ければ `blocked → running`。`onWorkerEvent` も保留が無ければ解除。heartbeat は「保留承認がある間だけ」blocked を除外 | `web-server.ts` |
| 6-4 | 読み取り専用サブエージェントには `worker.md` ではなく `READ_ONLY_SUBAGENT_INSTRUCTION` を渡す | `session-app.ts` |
| 6-5 | `tamper-rejected` で `rollbackFiles()` してから継続。Gate 2 は diff が `truncated` のとき「提示範囲のみ判定、欠落は判定不能」 | `verifier-ralph.ts` |
| 6-6 | ベンチが `.sub` のリクエスト・ツール・トークンを main と分離。キャッシュは `hitReported` / `hitComplete` を併記。`HY_BENCH_MODEL` / `HY_BENCH_EFFORT` で差し替え可能 | `bench/harness/logs.mjs`, `run.mjs` |
| UI | ジャンプレールはメッセージ一覧の署名が変わったときだけ再構築。アクティブ判定は**トランスクリプト内の実要素**を測る。ジャンプ中はスクロールスパイを 700ms 止める。`span` の transition は opacity のみ。非表示中は描画を保留し、可視化時に1回だけ catch-up | `web/src/app.ts`, `styles.css` |

### 9.2 検証（実行済み）

| 検証 | 結果 |
|---|---|
| `tsc -b packages/core packages/seams packages/hy-cli packages/sdk` | 成功 |
| web / desktop の型検査 | 成功 |
| 単体テスト（`packages/*/dist/**/*.test.js` + web） | **753 pass / 0 fail** |
| `pnpm test:regression` | **29 pass / 0 fail / 0 skip** |
| `cargo test --workspace` | 45 + 12 + 4 + 14 + 2 pass |
| `pnpm gen:protocol` / `gen:config-schema` | 再生成・一致 |
| 実 API（opencode / deepseek-v4.1-flash） | ストリーミング・ネイティブツール呼び出し・usage・別ターンでの再生成が 200 で成功 |
| `pnpm desktop:package:next` | 成功。`release/next/HY-HARNESS-0.5.55-20261111-0603.exe`（196,141,635 bytes、SHA-256 `C41F6918EE4ADD573EBCF89A69C764F604C2D818CFF0D1662E7A18D76DA291E2`）。署名なし |

### 9.3 未検証

- 実プロセスで 4 MiB を超える出力（`StreamBuffer` の単体テストのみ）。
- 5 分の承認タイムアウトの実時間再現（ロジックと型検査のみ）。
- UI の実画面（ジャンプの点滅・活性化時の重さ）は型検査とビルドのみ。
- JSON 打ち切りは単体テスト（agent 46件・reply-guard 45件）で確認したが、実モデルで切り詰めを再現してはいない。
