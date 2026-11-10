# プロバイダ層の検証（主張1・2）

- 対象: 別セッション報告のうち **主張1（プロバイダ再生成による学習状態の消失）** と **主張2（アダプタ間の能力差）**。
- 検証日: 2026-11-11
- 方法: ソースの読解のみ（`read_file` / `Select-String`）。**コードは変更していない。**
- 読んだファイル: `packages/hy-cli/src/session-app.ts`, `packages/core/src/llm.ts`, `llm-negotiate.ts`, `model-catalog.ts`, `config.ts`, `config-schema.ts`, `agent.ts`, `features.ts`
- 主張文そのものは、リポジトリ内の `docs/audit/2026-11-11/` に同一文面が見つからなかった（`createProvider` / `echoReasoning` / `KV` / `completeStreaming` で全文検索）。したがって**渡された文面を対象に検証**した。
- 推測には「(推測)」を付ける。行番号は本文執筆時点の作業ツリーで実在を確認済み。

---

## 0. 結論

| 主張 | 判定 | 要点 |
|---|---|---|
| 1. 毎ターン `createProvider` → `drop` / `echoReasoning` が消える → reasoning の送信がターン内で反転し KV キャッシュが壊れ、400 も毎ターン再発 | **骨格は正確（一部条件付き）** | 再生成・状態消失・Step 1 → Step 2 の挿入は**すべてコードどおり**。「Step 2 で突然挿入」は**そのステップが reasoning を返した場合のみ**。「キャッシュが壊れる」は**毎ターン1回・不一致区間の大きさはプロバイダの prefix 保持に依存（推測）**。 |
| 2. Ollama / Gemini / Anthropic / Responses の取りこぼしと、ストリーミング・反復検知・タイムアウトの `OpenAiProvider.completeStreaming` 偏在 | **正確（列挙はすべて一致）** | 個別項目はすべてコードで確認。**主張に無い同種の欠落が1つある**: OpenAI 互換アダプタも `tool_calls[].id` を捨てている。 |

**影響度（要約）**: 完走率への直接影響は小さい（400 は自動回復する）。効くのは **①キャッシュヒット率（毎ターン1回のprefix不一致）、②毎ターン +1 往復の遅延（400→drop→再送）、③能力活用（Gemini の temperature 未送信、effort 7値中4値が無言で無効、Anthropic の思考が使えない、Responses の reasoning 要約を捨てている、構造化出力が4アダプタで使えない）**。

---

## 1. 主張1: ターンごとのプロバイダ再生成

### 1.1 コードで確認した事実

| # | 事実 | 根拠 |
|---|---|---|
| F1 | `build` は `Conversation` のメソッドではなく、`Conversation.create` が作るクロージャをコンストラクタで受け取ったもの | `session-app.ts:1152`, `session-app.ts:1570` |
| F2 | `Conversation` の生成時に1回、`runTurn` の**開始時**に1回、**finally でもう1回** `build` が呼ばれる。つまり**1ターンにつき `createProvider` が2回**走る | `session-app.ts:1176`, `session-app.ts:1744`, `session-app.ts:1784` |
| F3 | `build` は毎回 `createProvider(role, …)` を呼んで `new Agent({ provider })` を作る | `session-app.ts:1582` |
| F4 | `createProvider` は毎回 `createUnbudgetedProvider` を呼び、`new OpenAiProvider(...)` 等を**その場で生成**する。インスタンスのキャッシュ・メモ化は無い | `llm.ts:1483-1484`, `llm.ts:1524-1541` |
| F5 | `drop` / `tokenField` / `omitEffortWithTools` / `echoReasoning` はすべて**インスタンスの private フィールド**。初期値はコンストラクタで役割・レジストリから決める | `llm.ts:429`, `llm.ts:434`, `llm.ts:436`, `llm.ts:441`, `llm.ts:449-452` |
| F6 | `drop` は 400 の本文から学習して Set に足すだけ。ディスクにもログにも保存しない | `llm.ts:489-497` |
| F7 | `echoReasoning` は「そのエンドポイントが reasoning を返した」時点で true になる（ストリーミング / 非ストリーミングの両方） | `llm.ts:619`, `llm.ts:690-692` |
| F8 | 送信側は `role.reasoningEcho ?? echoReasoning` が真のときだけ、assistant 履歴に `reasoning_content` を付ける | `llm.ts:474`, `llm.ts:477` |
| F9 | 履歴に reasoning が載るのは `reasoningHistory === 'full'` のときで、既定が `full` | `agent.ts:819`, `config.ts:1028` |
| F10 | ターン終了時の `build`（F2 の2回目）が作る provider は、次のターン開始時の `build` で上書きされるまで使われない（`this.agent` の利用は `run` の1箇所だけ） | `session-app.ts:1752`, `session-app.ts:1744`, `session-app.ts:1784` |
| F11 | 学習状態は `OpenAiProvider` だけのものではない。`Agent` の `native`（ネイティブツール呼び出し）フラグも `run()` のローカル変数で、400 で false にしてもターンを跨がない | `agent.ts:618`, `agent.ts:782`, `agent.ts:862` |

### 1.2 下位項目の判定

| 下位項目（主張の文言） | 判定 | 根拠と補足 |
|---|---|---|
| `Conversation.build`（`session-app.ts:1580-1582`）が毎ターン `createProvider` を呼ぶ | **正確** | `build` の実体は 1570、`createProvider` は 1582。行範囲はほぼ一致（実際は 1570-1630 のクロージャ）。呼ばれる回数は毎ターン2回（1744 / 1784）。 |
| そのため `OpenAiProvider` の `drop`（400学習）がターンごとに消える | **正確** | F4-F6。プロセス内で唯一の保持先がインスタンス。 |
| 同じく `echoReasoning` がターンごとに消える | **正確** | F4, F5, F7。 |
| 結果、次ターン Step 1 は過去の reasoning を送らない | **正確** | F8 の `echo` が初期値に戻るため、`openAiMessages(..., false)` になり履歴中の `reasoning_content` が全段落ちる（F9 の条件付き）。 |
| 応答後の Step 2 で突然挿入する | **一部正確** | 挿入されるのは **Step 1 の応答が reasoning を返した場合のみ**（`llm.ts:619`, `llm.ts:690-692`）。reasoning を返さないモデルでは反転しない。`role.reasoningEcho: true` を設定した場合も最初から返送するので反転しない（`llm.ts:474`）。 |
| そのため KV キャッシュが壊れる | **一部正確** | 機構は正しい: 同一履歴の先頭寄りの assistant メッセージで `reasoning_content` の有無が変わるため、その位置以降の prefix が一致しなくなる。ただし (a) 影響するのは OpenAI 互換系のみ（Gemini は reasoning を返送しない `llm.ts:1023-1032`、Anthropic は自前のブレークポイント `llm.ts:1209`）、(b) 毎ターンの Step 1 は**前ターンの Step 1 と同じ形**なので、プロバイダが複数の prefix を保持していれば部分的にヒットし得る（推測。保持粒度・TTL はサーバ実装依存）、(c) Step 2 以降は前ターン末尾と同じ形に戻る。**「毎ターン1回、履歴の途中で1箇所ずれる」が正確な形**。 |
| 400 再試行もターンごとに再発する | **正確** | `reasoning_content` を拒否するエンドポイントでは、毎ターン Step 2 で 400 → `drop` → 再送（`llm.ts:531-538`, `llm.ts:670-676`）。さらに `tokenField` / `temperature` / `effort` / `response_format` / `stream_options` / `tools` を拒否するエンドポイントでは、**Step 1 で**毎ターン 400 → 再送になる（`llm.ts:467-483`）。 |
| （暗黙）完走率が下がる | **一部正確** | 学習した1フィールドの 400 は自動回復するので、ターンは完走する。失敗に直結するのは、`rejectedFields` の文言ヒューリスティック（`llm-negotiate.ts:23-41`）が拾えない 400 で、これは毎ターン同じ箇所で失敗し続ける。 |

### 1.3 影響（主張1）

- **KV キャッシュ**: 毎ターンの最初のリクエストで、前ターンに返送していた `reasoning_content` が落ちる。プロバイダが自動 prefix キャッシュを持つ場合（DeepSeek / OpenAI / OpenCode 系）、ずれた位置以降はキャッシュミス単価になる。定量的な金額は `pricing` がユーザー登録制のため算出しない。Anthropic（明示ブレークポイント）と Gemini（reasoning 返送なし・`previous_interaction_id` 継続）はこの機構の影響を受けない。
- **完走率**: 自動回復するため直接の失敗要因ではない。コストは **毎ターン +1 往復**（400 → drop → 再送）と、ログ/ターミナルに出続ける 400 ノイズ。`native` フラグの再学習（F11）も同様に毎ターン +1 往復。
- **能力活用**: ターン内では学習が効くので、1ターンが長いほど損は小さい。逆に「1メッセージ1ターン」の使い方では毎回同じ 400 を払う。

---

## 2. 主張2: アダプタ間の能力差

### 2.1 アダプタ別マトリクス（コードで確認）

| 項目 | Ollama (`llm.ts:368`) | OpenAI 互換 (`llm.ts:424`) | Gemini (`llm.ts:974`) | Anthropic (`llm.ts:1185`) | Responses (`llm.ts:1278`) |
|---|---|---|---|---|---|
| (a) `temperature` を送る | **送る** `llm.ts:394` | **送る**（400 で drop）`llm.ts:480` | **送らない**（`generation_config` に無い）`llm.ts:1046-1051` | **送る** `llm.ts:1206` | **送らない** `llm.ts:1312-1329` |
| (b) `role.extraBody` を反映 | 無 | **有（唯一）** `llm.ts:484` | 無 | 無 | 無 |
| (c) `options.json` / 構造化出力 | **有** `format:'json'` `llm.ts:392` | **有** `response_format` `llm.ts:470,483` | 無 | 無 | 無 |
| (d) `effort` の変換 | 無視（`think:false` 固定）`llm.ts:390` | `reasoning_effort`（drop 可 / tools 併用時 omit 可）`llm.ts:482` | `low\|medium\|high` のときだけ `thinking_level`、他は**無言で破棄** `llm.ts:1048-1050` | **無視**（`thinking` を送らない）`llm.ts:1203-1211` | `reasoning.effort` に素通し（値検証なし）`llm.ts:1319-1324` |
| (e) 応答 reasoning を返す | 返さない（`thinking` を読まない）`llm.ts:405-419` | 返す `llm.ts:613-621`, `llm.ts:690-692` | 返す（thought ステップ）`llm.ts:1085-1092` | パースは有るが**要求しないので通常発生しない** `llm.ts:1252` | **捨てる** `llm.ts:1377-1384` |
| (f) ツール呼び出し ID | 無（API が返さない）`llm.ts:411,417-419` | **捨てる** `llm.ts:545,627,647` | **保持** `llm.ts:1090-1096`, `llm.ts:1100` | **捨てる** `llm.ts:1253` | **捨てる** `llm.ts:1364,1383` |
| (g) `onDelta` ストリーミング | 無（`stream:false`）`llm.ts:389` | **有** `llm.ts:661` | 無 | 無 | 無 |
| (h) 反復検知 / タイムアウト | 無 / 無 | **有 / 有（ストリーミング経路のみ）** `llm.ts:552-575`, `llm.ts:520` | 無 / 無 | 無 / 無 | 無 / 無 |

補足（マトリクス外）:

- `role.headers` は `requestHeaders` 経由で OpenAI 互換（`llm.ts:503`）・Gemini（`llm.ts:1028`）・Anthropic（`llm.ts:1218-1222`）・Responses（`llm.ts:1344`）に効く。**Ollama だけは素の `Content-Type` のみ**（`llm.ts:385`）。
- 429 / 5xx の再試行は `postWithRetry`（`llm.ts:294-326`）と `openStreamWithRetry`（`llm.ts:340`）で**全アダプタ共通**。主張の「偏在」は「ストリーミング・反復検知・タイムアウト」についてであり、リトライは該当しない（主張の書き方で誤読しやすい点）。

### 2.2 下位項目の判定

| 主張の文言 | 判定 | 根拠と補足 |
|---|---|---|
| Ollama は `think: false` 固定 | **正確** | `llm.ts:390`。`options.effort` は一切参照されない。 |
| Ollama は `extraBody` 未反映 | **正確** | `extraBody` の参照はリポジトリ全体で `llm.ts:484` の1箇所のみ。 |
| Gemini は effort を low\|medium\|high のみ受理 | **正確** | `llm.ts:1048-1050` の正規表現。`none` / `minimal` / `xhigh` / `max` は**警告なく捨てられ**、プロバイダ既定に戻る。補助ロールの既定 `effort: 'none'`（`session-app.ts:1078`, `session-title-gen.ts:84`）は Gemini では無効。 |
| Gemini は temperature / extraBody / json 未適用 | **正確** | `generation_config` は `llm.ts:1046-1051` で `max_output_tokens` と `thinking_level` のみ。 |
| Anthropic は effort を無視 | **正確** | body は `llm.ts:1203-1211`（model / max_tokens / temperature / system / messages / tools）。`thinking` パラメータも budget 変換も無い。なお `config.ts:661` のコメント「effort maps to `thinking` budgets」に対応する実装は存在しない。 |
| Anthropic は extraBody / json 無視 | **正確** | 同上。`response_format` 相当も `text.format` 相当も無い。 |
| Anthropic は `tool_use.id` を破棄 | **正確** | `llm.ts:1253` は `{ name, args }` だけを積む（型宣言 `llm.ts:1235` に `id` はあるが未使用）。ただし harness は `tool_use` / `tool_result` ブロックを送り返さず、履歴をテキスト化する（`llm.ts:1167-1181`）ため、**現状の実害は小さい**（ID を使うのは Gemini 経路のみ `agent.ts:1143-1151`）。 |
| Responses は temperature / extraBody / json を無視 | **正確** | `llm.ts:1312-1329`。 |
| Responses は応答 reasoning を無視 | **正確** | `llm.ts:1377-1384` は `message` と `function_call` のみ。しかもリクエストでは `reasoning.summary` を要求している（`llm.ts:1319-1324`）ので、**返ってきた要約を捨てている**。 |
| Responses は `call_id` を無視 | **正確** | 型に `call_id` はある（`llm.ts:1364`）が、`llm.ts:1383` は `{ name, args }` のみ。 |
| ストリーミング・反復検知・タイムアウトは `OpenAiProvider.completeStreaming` に偏在 | **正確** | ディスパッチは `llm.ts:661`。反復検知は `llm.ts:552-575`、明示タイムアウトは `llm.ts:520` のみ。`openStreamWithRetry` の利用も `llm.ts:525` の1箇所だけ。 |

### 2.3 主張に無いが同種の欠落

- **OpenAI 互換アダプタも `tool_calls[].id` を捨てている**（`llm.ts:545`, `llm.ts:627`, `llm.ts:647`）。主張2は Responses の `call_id` だけを名指ししているが、Chat Completions 経路も同じ。現状は ID を必要としないテキスト履歴方式なので実害は無いが、「ID を保持するアダプタは Gemini だけ」という非対称は残る。

### 2.4 影響（主張2）

- **KV キャッシュ**: Gemini・Anthropic は送る内容が少なく、temperature/effort の欠落がキャッシュを壊すことはない。影響は「キャッシュ」より「決定性」に出る（Gemini は `temperature: 0` を指定しても送られないため既定 1.0 で動く。`session-app.ts:1605` の `temperature: role.temperature ?? 0` が Gemini では効かない）。
- **完走率**: Responses は json モードが無いため、JSON 前提の補助ロール（grader / guardian など `llm.ts:147-148` の既定 json=true）で**パース失敗の確率が上がる**。ただし `reply-guard` 側の修復があるため直ちに失敗とは限らない（未検証）。Anthropic / Gemini も同様。
- **能力活用**: Gemini の thinking 制御が 7 値中 3 値しか効かない、Anthropic の拡張思考が使えない、Responses の reasoning 要約を課金して捨てている、構造化出力が 4 アダプタで使えない。いずれも「未知のモデル・未知のプロバイダで能力を引き出せない」方向の欠落で、誤動作ではない。

---

## 3. 既存 `README.md` §7 との関係

矛盾する点（コードを正とする）:

1. **§7.1 の M-7 / R-7 行**: 「`role.headers`、`extraBody`、`apiPath`、`requestTimeoutMs` を追加し、**OpenAI 互換・Anthropic・Responses・Gemini に適用**」とあるが、実際に4アダプタへ適用されているのは **`headers` だけ**。
   - `extraBody` → `llm.ts:484`（OpenAI 互換のみ）
   - `apiPath` → `llm.ts:510`（OpenAI 互換のみ）
   - `requestTimeoutMs` → `llm.ts:520`（OpenAI 互換の**ストリーミング経路のみ**）
   - `config-schema.ts:63-76` の説明文（`extraBody` / `apiPath` / `requestTimeoutMs`）はプロバイダを限定していないため、設定画面・ドキュメントからは「どこでも効く」と読める。
2. **§7.4 の「推論の返送は『そのエンドポイントが返したら以後返す』。再開直後の 1 リクエストは返送しない」**: 「以後」の範囲が**ターン内**であることが書かれていない。実装はプロバイダインスタンスの寿命＝ターンなので、**毎ターンの Step 1 が「再開直後」と同じ状態**になる。これは主張1の挙動そのもの。
3. **§7.1 の「組み込みのモデル別データを廃止し、`config.json` の `models[]` を唯一の台帳に」**: 台帳自体は実装済み（`model-catalog.ts:41` の既定は空）だが、登録できる `compat.temperature`（`config-schema.ts:460`）は**実行時に読まれない**（§4 の X-2）。「台帳に登録すれば 400 を避けられる」とは読めない記述なので矛盾とまでは言えないが、期待差は生む。

矛盾しない点（確認済み）:

- §7.1 の M-1 / R-1「**ストリーミング経路にも** 400 の適応リトライを適用」は実装されている（`llm.ts:531-538`）。§0 の「ストリーミングに適応リトライが無い」は §7 で解消済みの古い記述。
- §7.1 の G-1「推論の返送は観測ベース」は `llm.ts:474`, `llm.ts:619`, `llm.ts:690-692` と一致。

---

## 4. 追加所見（主張に無いが同じ領域で重大）

| ID | 所見 | 根拠 | 影響 |
|---|---|---|---|
| X-1 | **ネイティブツール非対応の学習もターン単位**。400 で `native=false` にしても、その `Agent` はターン末尾で捨てられる | `agent.ts:618`, `agent.ts:782`, `agent.ts:862`, `session-app.ts:1744` | ツール非対応エンドポイントでは毎ターン 1 回 400 → 再試行。主張1の一般化。 |
| X-2 | **`models[].compat.temperature` が飾り**。`temperatureAllowedFor` はテスト以外から呼ばれない | `model-catalog.ts:86-88`, `config-schema.ts:460`, `model-catalog.test.ts:34,46` | 「temperature 非対応」と登録しても初回リクエストで送ってしまい、400 を毎ターン浴びる。 |
| X-3 | `capabilities.tools` / `reasoning` / `cache` も未使用（`vision` だけ `config.ts:107` で使用） | `config-schema.ts:466-476` | 能力登録の一部が実効性を持たない。 |
| X-4 | **Responses は `reasoning.summary` を要求して捨てる** | `llm.ts:1319-1324`（要求） vs `llm.ts:1377-1384`（破棄） | 課金・レイテンシだけ発生し、思考の要約が UI にもログにも出ない。 |
| X-5 | **Anthropic の thinking パースは死んだ経路**。`thinking` を要求しないので `llm.ts:1252` は通常発火しない。`config.ts:661` のコメントは実装と不一致 | `llm.ts:1203-1211`, `llm.ts:1252`, `config.ts:661` | 拡張思考を使いたい利用者に手段が無い（`effort` を設定しても無視される）。 |
| X-6 | **Gemini の effort フィルタが無言**。範囲外の値でも警告・エラーが無い | `llm.ts:1048-1050` | 補助ロールの既定 `none` が効かず、要約・タイトル生成で余計な思考が走る（コスト・遅延）。 |
| X-7 | **補助ロールは常に非ストリーミング経路**（`onDelta` を渡さない）ため、反復検知もタイムアウトも無い | `agent.ts:756-760`, `session-app.ts:1079`, `session-app.ts:2095`（メイン会話は `onEvent` 常時で streaming 機能が既定 on: `session-app.ts:1627`, `features.ts:18-20`） | 要約・採点・圧縮・タイトル生成が暴走した場合、`maxTokens` まで走り切る。 |
| X-8 | `llm-negotiate.ts` の冒頭コメント「学んだことは**プロセスの残りずっと**保持」が実装と不一致 | `llm-negotiate.ts:6-7` vs `session-app.ts:1744` | 設計意図は「プロセス寿命」だった可能性が高い（推測）。主張1はこの意図と実装のズレを突いている。 |

---

## 5. 未確認事項・限界

1. **実 API での 400 再発は未計測**。コード上の経路は確定だが、実サーバでの再現は確認していない（`README.md` §7.5 でも「400 の適応リトライは実サーバでは未確認」と記載されている）。
2. **プロバイダ側 prefix キャッシュの保持粒度・TTL は未確認**。主張1の「KV キャッシュが壊れる」の規模はここに依存する（推測で「毎ターン1回・履歴の途中で1箇所」と評価した）。
3. **`fetch` が無期限に待つかは実行環境依存**。コードに明示タイムアウトが無いことは事実（`llm.ts:294-326`, `llm.ts:340-366`）だが、Node/undici の既定値は検証していない。
4. **Gemini Interactions API が `temperature` を受け付けるかは未確認**（送っていないので不明）。「送っていない」は事実、「送れない」は未確認。
5. **構造化出力の欠落が実際にパース失敗を増やすかは未検証**（`reply-guard` の修復に依存）。
6. **テストは実行していない**（コード変更が無く、依頼にも含まれないため）。判定はすべてソース読解による。
7. 主張文の出所（別セッションのレポート）はリポジトリ内で特定できなかった。文面はオーケストレーターから渡されたものを引用している。

---

## 6. 確認した file:line

検証中に実在を確認した参照。**合計 117 件**（行範囲は1件として数え、範囲内の行を別掲した重複は除いた）。本文で引用したもの、および判定の根拠として確認したものを含む。

| ファイル | 確認した行 | 件数 |
|---|---|---|
| `packages/hy-cli/src/session-app.ts` | 1031, 1078, 1079, 1152, 1176, 1312, 1570, 1582, 1605, 1606, 1627, 1744, 1752, 1784, 2095 | 15 |
| `packages/hy-cli/src/session-title-gen.ts` | 84 | 1 |
| `packages/core/src/llm.ts` | 141, 147-148, 150, 294-326, 340-366, 368, 385, 389, 390, 392, 394, 405-419, 424, 429, 434, 436, 441, 449-452, 467, 470, 474, 477, 478, 480, 482, 483, 484, 489-497, 503, 510, 520, 525, 531-538, 545, 552-575, 613, 619, 620, 627, 647, 661, 670-676, 690-692, 974, 1014, 1023-1032, 1046-1051, 1061-1064, 1085-1096, 1100, 1116, 1167-1181, 1185, 1203-1211, 1218-1222, 1235, 1252, 1253, 1278, 1312-1329, 1344, 1364, 1377-1384, 1390, 1483-1484, 1524-1541 | 66 |
| `packages/core/src/llm-negotiate.ts` | 6-7, 23-41 | 2 |
| `packages/core/src/model-catalog.ts` | 8-19, 26-40, 41, 76-79, 81-83, 86-88, 95-97, 100-102 | 8 |
| `packages/core/src/config.ts` | 58-59, 107, 661, 1028 | 4 |
| `packages/core/src/config-schema.ts` | 25-28, 63-67, 68-71, 76, 452-465, 466-476 | 6 |
| `packages/core/src/agent.ts` | 95, 618, 754-761, 782, 819, 862, 1143-1151 | 7 |
| `packages/core/src/features.ts` | 18-20 | 1 |
| `packages/core/src/llm.test.ts` | 225-285（観測ベース返送のテスト）, 650（ストリーミング）, 736（反復検知） | 3 |
| `packages/core/src/llm-providers.test.ts` | 42（Anthropic）, 117（Responses） | 2 |
| `packages/core/src/model-catalog.test.ts` | 34, 46（`temperatureAllowedFor` のテストのみ） | 2 |
| 合計 | | **117** |

---

## 7. 最終状態

- ソースコードは未変更。本ファイルのみ新規作成。
- 主張1は**骨格が正確**（再生成・状態消失・Step 1/Step 2 の反転）。ただし「Step 2 での挿入」はモデルが reasoning を返した場合に限られ、「キャッシュ破壊」は毎ターン1回・規模はプロバイダ依存（推測）。
- 主張2は**列挙項目すべてがコードと一致**。ただし OpenAI 互換アダプタも `tool_calls[].id` を捨てている点が主張に無い。
- 追加所見 8 件（X-1〜X-8）、`README.md` §7 との不一致 3 点を記載。

STATUS: done
