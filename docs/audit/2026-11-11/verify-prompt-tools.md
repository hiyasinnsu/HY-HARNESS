# 検証: プロンプトとツール公開（主張5項目）

- 日付: 2026-11-11
- 対象: `F:\HY-HARNESS`（作業ツリー。`build-info.json` は `0.5.54` / builtAt `2026-11-10T18:02:13Z` / `dirty: true`）
- 目的: 別セッションの調査報告にある「プロンプトとツール公開」に関する主張5件を、実コードと実行結果で確かめる。**ソースは変更していない。**
- 表記:
  - **事実** = コードまたは実行結果で確認した内容。
  - **(推測)** = コードから導いたが再現していない内容。
  - file:line はすべて `read_file` / `Get-Content` で実在を確認した。
- 参照した既存レポート: `docs/audit/2026-11-11/prompt-and-toolcall-assumptions.md`（G-16、text モードの説明不足）、`docs/audit/2026-11-11/environment-and-task-generality.md`（`lsp.ts:189` の `.cmd`）、`docs/audit/2026-11-11/README.md`（P-4、T-5）。

---

## 0. 判定サマリ

| # | 主張 | 判定 | 一行の根拠 |
|---|---|---|---|
| 1 | lean4 分岐が PowerShell / read-before-edit / 検索 / patch 規則を `tool-docs.ts` へ逃がしたため、`richToolDocs: false` と `native: false` ではどちらの文面にも残らない | **一部正確** | lean4 本文からは4種すべて消える（実測 0 件）が、`richToolDocs: false` の短縮説明と `native: false` の `renderToolPrompt` には PowerShell・read-before-edit・patch の基本が残る。**両経路で消えるのは「検索は shell より search_* を使う」だけ** |
| 2 | `ptc` 既定 false + `job_*` は `wire: false` のため、`shell` がバックグラウンド化すると制御できない | **正確（条件付き）** | `dispatch` は `wire: false` を拒否し（`tools.ts:1126`）、`ptc` 既定は false（`config.ts:1033`）。ただし `stdinPipe: true` のジョブは `write_stdin` で操作でき、`run_code` を幻覚すれば `dispatch` は止めない |
| 3 | `editFile` が `resolveRootPath` と `decodeTextBuffer` を迂回し、`resolveInside` と `'utf8'` を直接使う | **正確** | `tools.ts:919,921` で確認。UTF-16 ファイルは `read_file` が返した文字列で 0 件一致（実測）。ただし `cwd` 非適用は `write_file` / `apply_patch` も同じで、`edit_file` 固有なのは解決器の不一致 |
| 4 | `mcpToolSpecs` が上限・説明切詰め・deferred 化なしで全 MCP ツールを `readOnly: false` 固定で公開する | **ほぼ正確** | `tools.ts:1097-1114` で確認。上限 40 件と 160 字切詰めは `mcp_call` のカタログ側だけ（`mcp.ts:50,716-721`）。ただしサーバ単位の `tools` allowlist はある（`mcp.ts:614-615`）。`readOnlyHint` は取得済みなのに捨てている（`mcp.ts:247` vs `tools.ts:1107`） |
| 5 | `LspManager.connect` が `.cmd` 解決（`ComSpec`）を持たず、`stderr` も破棄する | **正確** | `lsp.ts:183-190` は素の `spawn(exe, args)` と `stderr.resume()` だけ。`mcp.ts:60,97` の `resolveWindowsCommand` / `stdioCommand` を共有していない。しかも設定例が `typescript-language-server`（`config-schema.ts:492`）で、Windows の npm シムは `.cmd` |

確認した主張: **5件**（正確 3、一部正確 1、ほぼ正確 1、不正確 0、確認不能 0）。
追加所見: 5件（§6）。

---

## 1. 主張1 — lean4 の必須ルールが `richToolDocs: false` / `native: false` で消える

### 主張

`packages/core/src/prompt.ts` の lean4 分岐（`buildSystemPrompt`）は PowerShell 注意・read-before-edit・検索・patch 規則を `tool-docs.ts` へ逃がしたため、`richToolDocs: false` のときと `native: false`（`renderToolPrompt`）のときに、どちらの文面にも残らない。

### 判定: 一部正確

- 「lean4 本文から4種の規則が消えている」は**事実**。
- 「`richToolDocs: false` で消える」は**一部だけ事実**。短縮説明（`TOOL_SPECS[].description`）に PowerShell・read-before-edit・patch の基本が残る。
- 「`native: false` で消える」は**不正確**。text プロトコルは `renderToolPrompt` で短縮説明を列挙するので、PowerShell 等は残る。
- ただし **「検索は shell ではなく search_glob / search_grep を使う」はどちらの経路でも消える**。主張の方向は正しいが、範囲が「4種すべて」ではない。

### 根拠（コード）

| 場所 | 内容 |
|---|---|
| `prompt.ts:235` | `if (extras.native) {` — **lean4 分岐は native のときだけ**（text プロトコルは `prompt.ts:291-305` の別経路） |
| `prompt.ts:241-246` | `promptVariant === 'lean3' || 'lean4'` の分岐。コメントに「the lines the detailed tool descriptions (tool-docs.ts) cover dropped: the shell line, read-before-edit, where to search, how to patch」＝落とした自覚がある |
| `prompt.ts:249-288` | lean4 本文。`Tool use:` と `Rules:` のみで、PowerShell / read-before-edit / 検索 / patch の文言は無い |
| `prompt.ts:94` | `const doc = rich ? ... RICH_TOOL_DOCS[t.name] : undefined` |
| `prompt.ts:102` | `description: doc?.description ?? t.description` — rich でないときは**短縮説明**に落ちる |
| `tool-registry.ts:893-913` | `renderToolPrompt` は `- name(args: …) → …` と `t.description`（短縮）だけを出し、`RICH_TOOL_DOCS` を参照しない |
| `config.ts:1031` | `richToolDocs: user?.richToolDocs !== false`（既定 true） |
| `config.ts:1030` | `promptVariant` の既定は `'lean4'` |
| `config-schema.ts:418-421` | `richToolDocs` はユーザー設定として公開。`false` を禁止する制約は無い（「Send the detailed tool descriptions (default true)」） |
| `prompt.test.ts:104-111` | lean4 本文のテストは `native: true`（:108）のみ。`:110` の `assert.doesNotMatch(p, /…search_glob\|apply_patch\|edit_file/)` で「本文に無いこと」を固定している。**`richToolDocs: false` との組み合わせは未固定** |
| `prompt.test.ts:144-161` | rich / plain の差は `nativeToolDefs` だけで検証している |

### 実測（dist 0.5.54 の `packages/core/dist/prompt.js`、`buildSystemPrompt` は dist:136）

`node --input-type=module` で dist を直接呼び、同じ needle を走査した結果:

| 構成 | 長さ | `PowerShell` | `read_file` | `Read a file before editing` | `search_glob` | `apply_patch` | `edit_file` | `Use this rather than shell` |
|---|---|---|---|---|---|---|---|---|
| `native: true, promptVariant: 'lean4', richToolDocs: false`（**system prompt**） | 1022 字 | MISS | MISS | MISS | MISS | MISS | MISS | MISS |
| `native: false, promptVariant: 'lean4'`（**system prompt = text プロトコル**） | 4726 字 | HIT | HIT | MISS | HIT | HIT | MISS※ | MISS |

※ `edit_file` は `TOOL_SPECS` ではなく hy-cli の plugin ツール（`session-app.ts:434-449`）なので、`extraTools` を渡さないこの実験では出ない。実セッションでは text プロトコルにも `edit_file` の短縮説明が出る。

ネイティブ定義（`nativeToolDefs`）の説明文の長さ:

| ツール | `richToolDocs: false` | `richToolDocs: true` |
|---|---|---|
| `read_file` | 71 字 | 621 字 |
| `shell` | 663 字 | 1576 字 |
| `search_glob` | 108 字 | 250 字 |
| `search_grep` | 64 字 | 235 字 |
| `apply_patch` | 233 字 | 751 字 |

### 規則ごとの残存（主張の「どちらの文面にも残らない」の内訳）

| 落とした規則 | lean4 本文 | `richToolDocs: false` の短縮説明 | `native: false` の `renderToolPrompt` |
|---|---|---|---|
| PowerShell / Unix コマンド回避 / heredoc | 無し | **有り**（`tool-registry.ts` の `shell` 短縮: "On Windows use PowerShell, not Bash; avoid Unix grep/head/find and Bash heredocs…"） | **有り**（同じ短縮） |
| read-before-edit | 無し | **部分的に有り**（`read_file`「(read before editing)」、`shell`「Read an existing file before changing it」、`apply_patch`「Read existing files first」）。「編集系は未読ファイルを拒否する」という**機構の説明は無い** | 同（短縮） |
| 検索は shell ではなく `search_glob` / `search_grep` | 無し | **無し**（短縮は "Root-relative paths matching a glob…"/"Regex lines; optional path glob" のみ） | **無し** |
| patch 規則 | 無し | **部分的有り**（`---/+++`、numbered `@@`、`*** Begin Patch` 不可、read first、split、added roots）。**複数ファイル可・新規は `--- /dev/null`・unchanged context 行は無い** | 同（短縮） |
| 「毎回新しいプロセス」「quote paths」「非ゼロ exitCode は失敗」 | 無し | 無し（rich のみ） | 無し |
| `read_file` の `startLine`/`endLine`/`spill://` | 無し | 無し（rich のみ） | 無し |

rich 説明の該当箇所: `tool-docs.ts:44-57`（read_file。:49 が read-before-edit、:50 が「検索は shell より `search_*`」）、`tool-docs.ts:110`（「a small targeted change edit_file is simpler」）、`tool-docs.ts:119-131`（edit_file）、`tool-docs.ts:135`（write_file）。

### 主張との差分

1. 「`richToolDocs: false` のとき…残らない」→ **過大**。PowerShell・read-before-edit・patch の基本は短縮説明に残る。
2. 「`native: false`（`renderToolPrompt`）のとき…残らない」→ **誤り**。`renderToolPrompt` は短縮説明を列挙する（`tool-registry.ts:903-905`）。
3. 正しくは「**lean4 が落とした規則のうち、検索の方針と詳細（パラメータ・patch 記法・shell のプロセスモデル）は、`richToolDocs: false` でも text モードでも戻らない**」。

### 影響: 中

- 既定（`richToolDocs: true`）では問題なし。影響するのは「`richToolDocs: false` を選んだユーザー」と「native から text へ落ちたセッション」（`agent.ts:779-786` の「400 かつ `rejectsTools`」、`agent.ts:860-864` の `retryProtocol`）。
- 実害が読みやすい順:
  1. **検索行動** — 検索ツールの短縮説明は「何をするか」だけで「shell より使え」が無い。Windows で `grep`/`find` を打ち続けるモデルは、PowerShell 注意だけでは止まらない。
  2. **`read_file` の操作** — `startLine`/`endLine` の意味と `spill://` の存在が消える。400 行/50,000 字で切れた出力の続きを読む手段が説明されない。
  3. **`apply_patch` の記法** — 複数ファイル・新規ファイル（`--- /dev/null`）・context 行の要件が消える。短縮の「numbered @@ hunks」だけでは初回の失敗率が上がる (推測)。
- PowerShell 注意と read-before-edit は短縮に残るため、**この2点を理由に「必須ルール欠落」と呼ぶのは強すぎる**。

### 修正方針

- `prompt.ts` の lean4 本文で、`extras.richToolDocs === false` のときに落とした4行（shell の環境注意、read-before-edit、検索の推奨、patch の記法要約）だけを戻す。プロンプト版ではなく `richToolDocs` で切り替える（G-16 の分離方針と一致）。
- あるいは `richToolDocs: false` を「短縮定義」ではなく「lean4 本文 + 短縮定義」の組として定義し直す。
- text モードにも詳細説明を送る案（`prompt-and-toolcall-assumptions.md:150`）は本項と重複する。**本検証の追加点は「lean4 本文が落とした規則の一覧」と「`richToolDocs: false` × lean4 がテストで固定されていない」こと**。

---

## 2. 主張2 — `ptc: false` でバックグラウンドジョブを操作できない

### 主張

`config.ts` で `ptc` は既定 false。`job_status` / `job_output` / `job_wait` / `job_kill` はすべて `wire: false` で、`tools.ts` の dispatch が直呼びを拒否するため、`shell` がバックグラウンド化すると制御できない。

### 判定: 正確（条件付き）

主経路の判定は**正確**。ただし「制御できない」が無条件に真なのは「`stdinPipe` 無しで backgrounded になった通常のジョブ」に限る。3つの条件を付けて確定させる。

### 根拠（コード）

| 場所 | 内容 |
|---|---|
| `config.ts:1033` | `ptc: overrides.ptc ?? process.env.HY_PTC === '1'` — **既定 false** |
| `tool-registry.ts:186,190,204,210` | `job_status` / `job_output` / `job_wait` / `job_kill` はすべて `wire: false` |
| `tool-registry.ts:868-876` | `offeredTools` は `t.wire` を要求し、`run_code` は `(ptc \|\| t.name !== 'run_code')` で **ptc のときだけ**提示 |
| `tools.ts:1126` | `!spec.wire && !viaSdk` のとき「only available inside run_code as tools.<sdk>」で throw |
| `tools.ts:1192` | `case 'run_code': return this.runCode(a)` — **ptc の検査は無い**（§2 の条件3） |
| `tool-registry.ts:136` | `shell` の出力 enum に `'backgrounded'`、`jobId` を返す |
| `tool-docs.ts:28-30` | `BACKGROUND_SHELL_GUIDANCE`: 「a command still running then keeps going as a background job … with a `jobId`」。「その後どうするか」は書かない |
| `tool-registry.ts:260` | `sleep` の説明: 「Wait briefly (max 60 s) **when polling a job** or a build」— ポーリング手段が無いのにポーリングを示唆 |
| `server.rs:587` | `Duration::from_millis(p.foreground_wait_ms.unwrap_or(5_000))` — 既定 5 秒で backgrounded |
| `jobs.rs:212` | `job/write` は stdin パイプが無いジョブで「this job has no stdin pipe; start it with `shell { stdinPipe: true }`」を返す |

### 「制御できない」の確定

1. **通常の backgrounded ジョブ（`stdinPipe` 無し）→ 操作不能。事実。**
   - 提示されるツールに `job_*` は無い（`offeredTools` が `wire` を要求）。
   - 代替になりそうな `write_stdin`（`wire: true`、`tool-registry.ts:499`、常時提示）は、`tools.ts:1336` が先に `exec.jobWrite` を呼ぶ。stdin パイプの無いジョブでは `jobs.rs:212` で失敗するため、出力の読み出しにも到達しない。
   - したがって、モデルが持てるのは「`jobId` という文字列」と「あとで `sleep` する手段」だけ。
2. **`shell { stdinPipe: true }` で開始したジョブ → `write_stdin` で操作できる。事実。**
   - `tools.ts:1334-1359`: `jobWrite` → `jobOutput`（オフセット管理）→ `jobStatus` で `exited` 判定。実質 `job_output` + `job_wait` の代替。
   - ただし backgrounded になる**前に** `stdinPipe: true` を指定している必要があり、事後の回復手段ではない。
3. **`run_code` を幻覚すれば到達できる。事実（実装の抜け）。**
   - `dispatch` は「提示されていないこと」を検査しない。`tools.ts:1120-1130` の拒否条件に `ptc` は無く、`spec.wire === true` の `run_code` は素通りする。
   - `runCode` の sub-call は `TOOLS_BY_SDK` から引くので（`tools.ts:2198-2204`）、`tools.jobs.status` 等に `viaSdk: true` で到達する。
   - 実行側の準備も常時行われている: `ptcWorkerPath` / `ptcNodePath` は initialize で無条件に送られ（`exec-rpc.ts:259-262`）、worker も同梱されている（`packages/core/dist/ptc-worker.mjs`、2,714 バイト）。したがって `ptc: false` でも `run_code` 自体は動く。
   - つまり「操作不能」は**提示の保証であって強制ではない**。プロンプトに SDK 宣言が無いので実際には起きにくい (推測)。
4. **`noBackgroundShell` のセッションではジョブが残らない。事実。**
   - `tools.ts:2116-2119`: backgrounded になったら `jobKill` してエラー。
   - 設定箇所: Web GUI セッション `web-server.ts:1948`、worker セッション `web-server.ts:1988`。プロンプトも `foregroundShell` に切り替わる（`prompt.ts:58-65`、`tool-docs.ts:25-26,32-41`）。
   - よって本項の実害は **CLI の通常セッション**（`session-app.ts` 経由で `noBackgroundShell` を渡さない場合）に限られる。

### 影響: 中〜高（CLI）

- ビルドやテストが 5 秒（`server.rs:587`）を超えると backgrounded になり、以後そのジョブの出力・終了コード・kill はモデルから触れない。実行しっぱなしのプロセスが残る。
- 回避は「`foregroundWaitMs` を大きくする」「`hardTimeoutMs` を意識する」しかなく、これは rich 説明にしか書かれていない（`tool-docs.ts:28-30`。`richToolDocs: false` だと短縮の "After foregroundWaitMs it becomes a job." だけになる）。
- `sleep` の説明（`tool-registry.ts:260`）が「ポーリング」を誘うため、モデルが存在しない `job_status` を呼んで `unknown tool` を踏む可能性がある (推測)。

### 修正方針

- `job_status` / `job_output` / `job_wait` / `job_kill` を `wire: true` にする（少なくとも `readOnly` の3つ）。PTC の `run_code` を必要としない。
- 併せて `dispatch` に「提示されていないツールは実行しない」検査を入れる（`ptc` / `allowTools` / `features` の合成）。現状は `run_code` が抜け道。
- `shell` の backgrounded 戻り値に「`write_stdin` は `stdinPipe` のジョブだけ」「`foregroundWaitMs` を上げよ」の1行を含める。

---

## 3. 主張3 — `editFile` が `cwd` / 文字コードで不整合

### 主張

`tools.ts` の `editFile` が `resolveRootPath`（working_directory）と `decodeTextBuffer`（UTF-16 対応）を迂回し、`resolveInside(this.workspaceRoot, file)` と `'utf8'` を直接使っている。

### 判定: 正確

コードは主張どおり。**追加で、`cwd` 非適用は `write_file` / `apply_patch` も同じ**で、`edit_file` 固有なのは「解決器が違うので `main:` 前置や複数ルートも通らない」点。UTF-16 の影響は実測で確認した。

### 根拠（コード）

| 場所 | 内容 |
|---|---|
| `tools.ts:909-929` | `editFile` 本体 |
| `tools.ts:919` | `const full = resolveInside(this.workspaceRoot, file)` — `resolveRootPath` を使わない |
| `tools.ts:921` | `const before = fs.readFileSync(full, 'utf8')` — `decodeTextBuffer` を使わない |
| `tools.ts:375-399` | `resolveInside`: `:` を含む入力を拒否（:376-378）、`realpathSync` で封じ込め、`rel` 正規化はしない |
| `tools.ts:747-783` | `resolveRootPath`: `this.cwd` 前置（:753-755）、`root:`、`..` 拒否、`realpath`、`normalizeRel` |
| `tools.ts:2227-2271` | `decodeTextBuffer`: UTF-8 / UTF-16LE / UTF-16BE / BOM を判定。binary は `undefined` |
| `tools.ts:1800-1824` | `readFile` は `resolveRootPath`（:1814）→ `decodeTextBuffer`（:1823） |
| `tools.ts:1928-1932` | `applyPatch` の `canonicalPath` は `'main:' + rel` を `resolveRootPath` に渡す（:1931） |
| `tools.ts:753-755` | `cwd` 前置の条件は `input === rel`。`main:` を付けた時点で成立しない → **`write_file` / `apply_patch` も cwd を前置しない** |
| `tools.test.ts:269-293` | `working_directory` のテストは `read_file` だけで、「cwd に対して解決される」ことを固定している |

### 実測1: UTF-16 ファイル（in-memory で両経路を再現）

UTF-16LE + BOM の `"const a = 1\r\nconst b = 2\r\n"` を `decodeTextBuffer` と `Buffer#toString('utf8')` に通した結果:

```
decodeTextBuffer length=26 equals original: true
utf8 read length=54 contains U+FFFD: true contains NUL: true
replace on decoded: 1
replace on utf8 read: 0
utf8 head: "��c\u0000o\u0000n\u0000s\u0000t\u0000 \u0000a\u0000 \u0000=\u0000 \u00001\u0000..."
```

- `read_file` は `decodeTextBuffer` 経由なので、モデルは正しいテキストを受け取る。
- `edit_file` は同じバイトを `'utf8'` で読むため、`replaceIgnoringEol` の一致は **0 件**。エラーは `edit_file: the text to replace was not found in <file>.` に `nearbyLines(before, oldText)`（文字化けした行）を添えるだけ（`tools.ts:924`）。
- 該当ファイルの典型は PowerShell 5.1 の `>` / `Out-File` 既定（UTF-16LE + BOM）。Windows 既定環境で作ったログ・設定ファイルがこれに当たる。

### 実測2: `working_directory` との組み合わせ（コード追跡）

`working_directory {path:'docs'}` の後:

| 操作 | 解決先 | 結果 |
|---|---|---|
| `read_file {path:'report.md'}` | `docs/report.md`（`resolveRootPath` の cwd 前置） | 読める（`tools.test.ts:279-281` が固定） |
| `edit_file {file:'report.md'}` | `<root>/report.md`（`resolveInside` は cwd を見ない） | ルートに同名ファイルが無ければ `path does not exist in the workspace: report.md`（`tools.ts:389-391`） |
| `write_file {file:'report.md'}` | `<root>/report.md`（`canonicalPath` が `main:` を付ける） | ルート側に同名ファイルが**無ければ新規作成**、**既存なら** read-hash 検査で `read_file is required before editing report.md`（`tools.ts:1956-1959`） |
| `apply_patch {file:'report.md'}` | 同上 | 同上 |

- さらに食い違うのは、`read_file` の read-hash キーが cwd 前置後の `docs/report.md`（`tools.ts:1842-1843`）、`apply_patch` の検査キーが `report.md`（`main:` 前置で cwd 非適用、`tools.ts:1951-1957`）になる点。**自然な順序で読んで編集すると別ファイルとして扱われ、エラー文は「read_file が要る」と言う**。
- 回避は `read_file {path:'main:report.md'}` でルート基準のキー（`report.md`）を作ったうえで `edit_file {file:'report.md'}` を呼ぶこと。`edit_file` 自身は `:` を拒否する（`tools.ts:376-378`）ため、`main:` 付きでは呼べない。**この「読みだけ `main:` を付ける」手順はどこにも説明されていない**（`session-app.ts:459` の説明とも食い違う）。
- なお `working_directory` 自身の説明は「shell cwd, **read_file and write_file** paths」（`session-app.ts:459`）で、`write_file` が cwd を守らない実装と食い違う（§6 追加所見 A）。

### 影響: 中

- UTF-16 ファイル: `edit_file` が使えず、`write_file` で全置換するしかない。モデルは「古い内容が無い」と誤認しやすい。
- `working_directory` 使用時: `edit_file` の解決先が `read_file` と食い違い、原因の分からない「not found」「read_file is required」になる。
- 封じ込め自体は `resolveInside` が `realpath` で行うため、**セキュリティ上の穴ではない**（`tools.ts:380-398`）。

### 修正方針

- `editFile` を `readFile` と同じ経路に統一する: `const { rel, full } = this.resolveRootPath(file)` → `decodeTextBuffer(fs.readFileSync(full))` → 変更後テキストを `applyPatch({ file: rel, content: after })` に渡す。
- あるいは `applyPatch` 側で `readHashes` のキーを「cwd 解決後の rel」に統一し、`read_file` と同じ名前空間にする。
- `working_directory` の説明を「shell cwd と read_file」に直すか、`write_file` / `apply_patch` にも cwd を適用する（どちらかに寄せる）。

---

## 4. 主張4 — MCP ツール公開の非効率

### 主張

`tools.ts` の `mcpToolSpecs` が上限・説明切詰め・deferred 化なしで全 MCP ツールを `readOnly: false` 固定で公開し、トークン増と並列実行阻害（`isReadOnly`）を招く。

### 判定: ほぼ正確

本体は事実。ただし「上限なし」は**既定の話**で、サーバ単位の `tools` allowlist は存在する（`mcp.ts:614-615`）。「並列実行阻害」は正確で、しかも `readOnlyHint` を取得済みなのに捨てている点が根拠として強い。

### 根拠（コード）

| 場所 | 内容 |
|---|---|
| `tools.ts:1097-1114` | `mcpToolSpecs`: 全 `options.mcp.tools` を走査し、`wire: true` / `permission: 'mcp_call'` / **`readOnly: false`** / `requires: 'mcp'` / `exposure` 未指定（= **direct**）/ `description` は「server/tool. 説明」を**切詰めなし** / `input: tool.inputSchema` をそのまま |
| `tools.ts:1116-1118` | `isReadOnly` は `spec(name)?.readOnly === true` |
| `prompt.ts:92-93` | 直呼び MCP があると `mcp_call` を提示から外す（`directMcp` → filter） |
| `prompt.ts:99-104` | `nativeToolDefs` は `RICH_TOOL_DOCS` に無いツールの説明をそのまま使う（MCP ツール用のエントリは無い） |
| `mcp.ts:50` | `MAX_CATALOG_TOOLS = 40` |
| `mcp.ts:716-721` | `renderCatalog` は先頭 40 件、説明は `slice(0, 160)`、超過は `(N more not listed)` — **`mcp_call` 用カタログにだけ上限がある** |
| `mcp.ts:247` | `readOnly: t.annotations?.readOnlyHint === true` — ヒントを取得している |
| `mcp.ts:631` | `needsApproval` は `readOnly` を承認要否に使う |
| `mcp.ts:614-615` | `config.tools` があれば**サーバ単位**で allowlist 可能（既定は全件） |
| `agent.ts:593-594` | 毎ターン `mcpToolSpecs()` を `extraTools` に足す |
| `agent.ts:1248` | `calls.every((c) => this.options.tools.isReadOnly(c.tool))` のときだけ並列 |
| `tools.ts:2204` | `run_code` 内の sub-call も `spec.readOnly` で read/write ロックを分ける |

### 具体的な効果

1. **トークン増**: 定義は「名前 + `server/tool. description` + 入力スキーマ全文」。`mcp_call` 経路なら 40 件・160 字で頭打ちだが、直呼び経路はその両方をバイパスする。playwright 級のサーバ（20〜30 ツール、スキーマが長い）では数千トークン規模 (推測。MCP サーバを起動できないため未実測、§7)。
2. **並列阻害**: 読み取り専用 MCP（例: `playwright/browser_snapshot`、`filesystem/read_file`）も `readOnly: false` なので、`agent.ts:1248` で他の読み取りツールと並列にならず、`tools.ts:2204` では write ロックを取る。`readOnlyHint` は既にある（`mcp.ts:247`）ので、情報は捨てている。
3. **deferred 化の喪失**: `mcp_call` は `exposure: 'deferred'`（`tool-registry.ts:306-314`、:310）で `tool_search` から読み込む設計だが、直呼びがあると `mcp_call` 自体が提示から外れる（`prompt.ts:92-93`）。**deferred 機構は MCP 直呼びがある間は実質無効**。

### 主張との差分

- 「上限なし」→ 既定では正しいが、`mcpServers.<name>.tools` の allowlist がある（`mcp.ts:614-615`）。「上限も切詰めも `mcp_call` 側にしかない」と言うのが正確。
- 「`readOnly: false` 固定」→ 正確。加えて `readOnlyHint` が取得済み（`mcp.ts:247`）であることが根拠として使える。

### 影響: 中

- ツール定義は prefix cache の対象なので毎ターン課金されないが、初回・cache miss・モデル切替で効く。
- 読み取り MCP の直列化はターン時間に直結する（GUI の体感に効く）。

### 修正方針

- `readOnly: tool.readOnly` にする（少なくとも `trusted` サーバ、または `annotations.readOnlyHint === true`）。ヒントは自己申告なので、承認は `needsApproval` に残し、並列性だけ解禁するのが安全。
- 件数上限（例 40）と説明の切詰め（例 160 字）を直呼びにも適用する。入力スキーマは `description` への要約に留め、必要なら `mcp_call` に逃がす。
- 既定を `mcp_call` + `deferred` に戻し、直呼びはオプトイン（`mcpServers.<name>.directTools: true`）にする。deferred の設計（`tool-registry.ts:310,868-876`）と整合する。

---

## 5. 主張5 — `LspManager` の Windows `.cmd` 非対応と stderr 破棄

### 主張

`packages/core/src/lsp.ts` の `connect` が `mcp.ts` の `.cmd` 解決（`ComSpec`）を持たず、`stderr` も破棄する。

### 判定: 正確

### 根拠（コード）

| 場所 | 内容 |
|---|---|
| `lsp.ts:183-190` | `const [exe, ...args] = config.command` → `spawn(exe, args, { cwd, stdio: ['pipe','pipe','pipe'], windowsHide: true })` → `child.stderr.resume()` |
| `lsp.ts:10-13` | import は `node:child_process` / `fs` / `path` / `url` のみ。`mcp.ts` の解決関数を共有していない |
| `mcp.ts:60` | `resolveWindowsCommand`: `PATH` + `PATHEXT` で `.COM/.EXE/.BAT/.CMD` を解決（T-5 の実装） |
| `mcp.ts:97-114` | `stdioCommand`: `.cmd` / `.bat` は `ComSpec`（既定 `cmd.exe`）で `cmd /d /s /c "<line>"`、引数は `quoteForCmd`（`mcp.ts:86`）で個別クォート |
| `config-schema.ts:492` | schema-valid な設定例: `lsp: { ts: { command: ['typescript-language-server', '--stdio'], extensions: ['.ts', '.tsx'] } }`。この例は「tests とドキュメントが使う」（`config-schema.ts:479-480`） |
| `lsp.ts:45-46` | exit で `fail('exited with code …')`、error で `fail(e.message)` |
| `lsp.ts:88-96` | `fail` は保留中の request を reject するだけ |
| `mcp.ts:127,139,204` | MCP は `stderrTail` を 2,000 字保持し、失敗メッセージに末尾 500 字を載せる |

### `.cmd` の判定

- **Node の仕様（事実）**: シェルなしの `spawn` は `.cmd` / `.bat` を直接実行できない（`shell: true` か `cmd /c` が必要）。`npm -g` で入る `typescript-language-server` は Windows では `typescript-language-server.cmd` シムで、`.exe` は無い。
- したがって、**同梱の設定例（`config-schema.ts:492`）は Windows では `spawn ENOENT` になり、`lsp.ts:46` 経由で「language server spawn ENOENT」とだけ出る**。
- 再現はできていない: このセッションのサンドボックスは子プロセス生成を拒否する（実測: `spawn(process.execPath, ['-e', 'console.log(42)'])` → `spawn EPERM`、`gap: named-pipe-children …`）。同じ制約は `environment-and-task-generality.md:271` にも記録されている。よって「コード + Node の仕様」からの判定（**(推測)** を含む）。
- 既存レポート `environment-and-task-generality.md:64` が同じ箇所を指摘済み（重複）。本検証は「設定例（`config-schema.ts:492`）が該当する」ことを追加する。

### stderr の判定

- 「破棄する」は**正確**。`stderr.resume()`（`lsp.ts:190`）はパイプ詰まりを防ぐために読み捨てる実装で、内容はどこにも残らない。
- MCP は同じ状況で 2,000 字 tail を保持し、失敗時のメッセージに 500 字載せる（`mcp.ts:204`）。LSP だけ診断情報が無い。
- 「破棄する」を「読まない」と解釈すると不正確（読んでいる）。**読んで捨てている**。

### 影響: 中

- Windows では LSP ツールが実質使えない（既定例が動かない）。Rust / TypeScript の定義ジャンプを期待した利用者が最初に踏む。
- 起動に成功しても、サーバがクラッシュしたときの理由（stderr）が出ないため、設定ミスの切り分けができない。

### 修正方針

- `lsp.ts` の spawn を `mcp.ts` の `stdioCommand` + `resolveWindowsCommand` に置き換える（引数は `quoteForCmd` で処理される）。共通ヘルパに切り出すのが既存方針（`environment-and-task-generality.md:184`）と一致。
- `stderr` は末尾 2,000 字を保持し、`fail()` のメッセージに 500 字を添える（`mcp.ts:139,204` と同じ）。
- `close()` は `child.kill()` のみ（`lsp.ts:144-149`）。Windows の孫プロセスは残り得る (推測)。MCP の `close` と同様の扱いを検討。

---

## 6. 追加所見（主張に無いが、検証中に確定したもの）

| # | 場所 | 内容 | 影響 | 修正方針 |
|---|---|---|---|---|
| A | `session-app.ts:459` / `tools.ts:1928-1932` | `working_directory` の説明は「shell cwd, read_file **and write_file** paths」だが、`write_file` / `apply_patch` は `canonicalPath` が `main:` を付けるため cwd を前置しない。cwd を守るのは `shell` と `read_file` だけ（`tools.ts:753-755` の `input === rel` 条件） | 中。`working_directory` を設定したセッションで `write_file` がルート側に同名ファイルを作るか、既存なら「read_file is required」で止まる | 説明を実装に合わせるか、write 系にも cwd を適用する |
| B | `agent.ts:738` / `tool-registry.ts:903-905` | text プロトコル（`native: false`）では、MCP カタログを session context に送ったうえで、`renderToolPrompt` が同じ MCP ツールを入力スキーマ付きで列挙する（`native && mcpSpecs.length` のときだけカタログを抑制している） | 中。text モードで MCP ツールが二重に載る | `mcpSpecs.length > 0` なら native に関係なくカタログを抑制する |
| C | `tools.ts:1120-1130,1192,2188` | `dispatch` は `run_code` を `ptc` で拒否しない。提示されていない `run_code` をモデルが幻覚すると実行され、`tools.jobs.*` など `wire: false` の SDK に到達できる。worker は常時同梱・initialize で常時通知（`exec-rpc.ts:259-262`）なので、`ptc: false` でも実行は成立する | 中。`ptc` は「提示の制御」であって「権限の制御」になっていない（§2 条件3） | `dispatch` で `spec.name === 'run_code' && !ptc` を拒否する |
| D | `tool-registry.ts:257-260` | `sleep` の説明が「when polling a job or a build」とポーリングを示唆するが、`ptc: false` ではポーリング手段（`job_status`）が提示されない | 低〜中。モデルが存在しないツール名を呼ぶ (推測) | 説明を「ポーリングの合間に待つ」に留めるか、`job_status` を `wire: true` にする |
| E | 既存レポートの行番号 | `prompt-and-toolcall-assumptions.md` の `prompt.ts:230-246`（実際の lean3/lean4 分岐は 241-288、本文は 249 以降）、`tool-registry.ts:883-903`（実際は 893-913）、`config.ts:968`（実際は 1030）、`environment-and-task-generality.md` の `mcp.ts:81-87`（実際の spawn は 149、解決は 60-83・97-114） | 低（引用の正確性） | 本レポートの行番号で置き換える |

---

## 7. 未確認事項

1. **MCP サーバを実際に起動してのツール数・トークン実測。** このサンドボックスは子プロセス生成を `EPERM` で拒否する（§5 の実測）。件数・スキーマ長の実測は未実施。
2. **LSP の `.cmd` 起動失敗の再現。** 同上。Node の仕様と `config-schema.ts:492` からの判定。
3. **UTF-16 ファイルでの `edit_file` の実ファイル実験。** 実ファイルは作らず、`decodeTextBuffer` と `toString('utf8')` の in-memory 比較で経路差を確認した（§3 実測1）。`replaceIgnoringEol` の挙動は同じ関数を dist から呼んで確認。
4. **GUI 設定画面に `richToolDocs` のトグルがあるか。** config schema と config 経路（`config.ts:1031`、`main.ts:1056`、`session-app.ts:1038`）だけ確認した。UI は未確認。
5. **`run_code` 幻覚の実頻度。** 実装上の到達可能性は確認したが、実ログでの発生は未確認。
6. **プロバイダ側の `readOnlyHint` の信頼性。** `annotations.readOnlyHint` を並列実行の判断に使ってよいかは MCP のサーバ実装依存で、未評価。

---

## 8. 実行した検証（再現手順）

```powershell
# 1) lean4 / rich の実測（dist 0.5.54 の prompt.js を直接呼ぶ）
$code = @'
import { pathToFileURL } from 'node:url'
const base = pathToFileURL(process.cwd() + '/packages/core/dist/')
const { buildSystemPrompt, nativeToolDefs } = await import(new URL('prompt.js', base).href)
const p = buildSystemPrompt('C:\\work\\alpha', false, false, { native: true, promptVariant: 'lean4', richToolDocs: false })
console.log(p.length, ['PowerShell','read_file','search_glob','apply_patch'].map((n) => n + '=' + p.includes(n)))
const defs = nativeToolDefs(false, false, { richToolDocs: false })
console.log(defs.find((d) => d.name === 'search_grep').description)
'@
$code | node --input-type=module

# 2) UTF-16 の経路差（dist の tools.js）
$code = @'
import { pathToFileURL } from 'node:url'
const base = pathToFileURL(process.cwd() + '/packages/core/dist/')
const { decodeTextBuffer, replaceIgnoringEol } = await import(new URL('tools.js', base).href)
const text = 'const a = 1\r\nconst b = 2\r\n'
const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
const decoded = decodeTextBuffer(utf16)
const asUtf8 = utf16.toString('utf8')
console.log(decoded === text, replaceIgnoringEol(decoded, 'const b = 2', 'x').count, replaceIgnoringEol(asUtf8, 'const b = 2', 'x').count)
'@
$code | node --input-type=module

# 3) spawn の可否（サンドボックスの制約確認）
$code = @'
import { spawn } from 'node:child_process'
const child = spawn(process.execPath, ['-e', 'console.log(42)'], { windowsHide: true })
child.on('error', (e) => console.log('ERROR', e.code))
child.on('exit', (c) => console.log('EXIT', c))
'@
$code | node --input-type=module
# -> THROW spawn EPERM（named-pipe-children の gap）
```

- 検証1の結果: lean4 + `richToolDocs: false` の system prompt は 1022 字で、4 needle すべて `false`。`search_grep` の短縮説明は 64 字。
- 検証2の結果: `decodeTextBuffer` は元テキストと一致し `replaceIgnoringEol` は 1 件、utf8 読みは 0 件。
- 検証3の結果: `spawn EPERM`。MCP / LSP の起動を伴う実験はこのセッションでは不可。
- 検証4（コード確認のみ）: `run_code` の実行準備は常時。`exec-rpc.ts:259-262` が `ptcWorkerPath` を無条件に送り、`packages/core/dist/ptc-worker.mjs`（2,714 バイト）が同梱されている。

---

## 9. 結論

- 5件の主張のうち、**完全に正確**なのは (2)(3)(5)（(2) は条件付き）、**ほぼ正確**なのは (4)、**一部正確**なのは (1)。
- 最も優先度が高いのは **(2) の `job_*` 非提示**（CLI で長時間コマンドが放置される）と **(3) の `edit_file`**（Windows 既定の UTF-16 ファイル、および `working_directory` 使用時に該当する編集が失敗する）。
- (1) は「必須ルール欠落」ではなく、**「両経路で戻らない規則（検索の方針・詳細）がある」**と表現するのが実態に合う。lean4 本文の lean 化そのものは既定構成（`richToolDocs: true`）では成立している。
- (4)(5) は設計の一貫性の問題（MCP: `readOnlyHint` を捨てる、LSP: `mcp.ts` の解決関数を共有しない）。どちらも既存の部品を再利用するだけで直る。
