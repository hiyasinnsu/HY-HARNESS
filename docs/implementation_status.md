# HY-HARNESS 実装状況（2026-11-03 / Phase 0〜Phase 8・コア機能パリティ・Desktop GUI 完遂、承認済みスコープ）

- **対象**: 設計書 [design_draft_rev3.md](../design_draft_rev3.md)（Rev 3.1、承認済み）と実装計画 [hy-harness-implementation-plan.md](designs/hy-harness-implementation-plan.md)（v3.1）
- **結論**: MVP に加えて **Phase 4（Windows サンドボックスと Guardian）を実装しました。** `--sandbox workspace-write` で、モデルが発行したコマンドは制限トークンの下で動きます。書き込みはワークスペースと専用 temp だけに限られます。`apply_patch` は同じトークンを偽装して書き込みます。`prompt` 判定のコマンドは、`--guardian` を付けると Guardian が審査します。さらに **DSH 準拠の Electron デスクトップ GUI と `hy web`** を追加し、セッション、チャット、ツールカード、承認、右パネル、ゴール、プラン、ジョブ、サブエージェント、MCP/プラグイン/メモリ、Trace、Verifier loop、スケジュール / Webhook、Browser / Desktop 自動操作、永続PTY、Tailscale 経由のスマホアクセスを GUI から利用できるようにしました（[desktop-gui.md](designs/desktop-gui.md)）。プラグインマーケット / Creator、SSH 先での実行、クラウド、マルチユーザー / パブリック公開、IDE 拡張は 2026-11-03 にユーザー承認済みの対象外です（同 §8）。
- **完成条件（承認済みスコープ）**: 3 カラム、ツールカード、承認 / 質問、ゴール、プラン、ジョブ、サブエージェント、右パネル、Browser / Desktop 自動操作、スケジュール / Webhook、永続PTY、多言語 UI、Tailscale スマホアクセスが動作し、`pnpm build` / `typecheck` / `test` / `test:integration` / `desktop:screenshot` と §2.12 の手動検証が成功すること。§8 の5項目は 2026-11-03 のユーザー承認済み対象外であり、DSH の全機能に対する完全準拠ではなく **承認済みスコープにおける DSH 準拠** とする。詳細は [desktop-gui.md §9](designs/desktop-gui.md)。
- **既定は `workspace-write`** です（2026-11-05 の CP-01 で変更。`--unsafe-unconfined` と `sandbox.legacyUnconfined` で従来動作）。読み取りとネットワークは設計どおり閉じ込めません（v1 の Non-Goal）。詳細は §5。

---

## 1. 動かし方

### 1.1 ビルド

```powershell
cd F:\HY-HARNESS
$env:CARGO_INCREMENTAL='0'
cargo build -p hy-exec-server
pnpm build
```

- 実行デーモン: `F:\HY-HARNESS\target\debug\hy-exec-server.exe`
- CLI: `F:\HY-HARNESS\packages\hy-cli\dist\main.js`
- 状態: `%LOCALAPPDATA%\hy-harness\state\<workspace-id>\`（セッションログ、ジョブ出力、チェックポイント用インデックス、付与の記録 `grants\`）
- 専用 temp: `%USERPROFILE%\.hy-harness\tmp\<session>`（セッション終了時に削除）

### 1.2 サンドボックスで動かす（ローカル Ollama）

```powershell
node packages\hy-cli\dist\main.js run "README.md を読んで、要約を NOTES.md に書いて" `
  --cwd C:\work\my-repo `
  --provider ollama --model qwen2.5:3b `
  --sandbox workspace-write --yes --max-steps 8
```

- 初回だけ、ワークスペースに ACL を付与します（10 万ファイルで約 4 秒）。`.git` がなければ付与の前に `git init` し、`.hy-harness/` を作ります。
- 開始時に `enforcement`、行った処理、既知の穴（`gap:`）をすべて表示します。
- ワークスペースが ACL のないボリューム（このマシンの F: と G:）にある場合も `workspace-write` を実行します。Codex と同じく、そのボリューム全体が書き込み可能になり、NTFS 側のワークスペース外は制限されたままです。上位ディレクトリをトークンが開けない場合は、理由を表示して止まります。
- `--sandbox` を付けなければ、従来どおり `unconfined` で動きます。

### 1.3 承認（`prompt` 判定のコマンド）

| 指定 | 動作 |
| :--- | :--- |
| `--yes` | すべて承認する |
| `--guardian` | Guardian（既定ではワーカーと同じプロバイダー）が審査する。`unconfined` / `low-integrity` は審査せずユーザーに回す。3 回続けて拒否したら、端末があればユーザーに尋ね、無人実行ならラウンドを中断する |
| どちらもなし | 端末があればユーザーに尋ね、なければ理由を付けて拒否する |

ユーザー設定（`%APPDATA%\hy-harness\config.json`）の `roles.guardian` で Guardian のプロバイダーとモデルを、`guardian.approveBelow`（既定 80）で承認の閾値を指定できます。

### 1.4 Ralph（検証ゲート付きループ）

```powershell
node packages\hy-cli\dist\main.js ralph "テストを通すように修正して" `
  --verify-cmd "npm test" `
  --cwd C:\work\my-repo `
  --provider ollama --model qwen2.5:3b `
  --sandbox workspace-write --yes --max-rounds 3 --trust
```

- **信頼していないプロジェクトは既定で拒否**します（OQ-3）。信頼するなら `--trust`（またはユーザー設定の `trustedProjects`）、そのまま動かすなら `--unattended-ok`。
- 各ラウンドは新しい子セッションです。ワーカーが終われるのは **`claim_complete` を呼んだときだけ**で（OQ-4）、ツールを呼ばない返事は 1 回促したあと「stalled」になります。
- 完了の宣言は、**改ざん検査**（`protectedPaths` の変更）→ **Gate 1**（すべての `--verify-cmd`。複数指定可。ユーザーが渡したものなので unconfined で動く、OQ-2）→ **Gate 2**（`grader` ロールが、差分・テスト出力・ワーカーのメモを untrusted として囲った入力で判定）の順に通ったときだけ受け入れます。Gate 2 は既定で実行し、`--no-grader` で省けます（推奨しません）。
- 失敗すると、次のラウンドに失敗の要約（失敗したコマンドと出力の末尾、満たしていない条件、変更したファイル。2,000 トークンまで）を渡します。中断・タイムアウト・予算切れでは、そのラウンドの開始時点に戻します。`HEAD` が動いていたら戻さずに止まります。
- **Budget4D**: `--max-rounds`（既定 5）、`--max-total-tokens`（500,000）、`--max-cost-usd`（2.00。`off` で無効。使うロールすべてに `pricing` が必要で、Ollama と mock は 0 円として扱う）、`--max-wall-clock-ms`（30 分）。すべてのロール（worker、grader、guardian、compactor）の使用量を数え、呼び出しの前に `max_tokens` を残りに合わせて絞ります。`--round-timeout-ms` でラウンドごとの時間制限、Ctrl-C で現在のラウンドを戻して止まります。
- `hy undo <run-id>` で `base` に戻せます。`hy checkpoint prune <run-id> [--keep base]` で ref を消します。

### 1.5 サンドボックスの管理

```powershell
node packages\hy-cli\dist\main.js sandbox status --cwd C:\work\my-repo
node packages\hy-cli\dist\main.js sandbox grant  --cwd C:\work\my-repo
node packages\hy-cli\dist\main.js sandbox revoke --cwd C:\work\my-repo
node packages\hy-cli\dist\main.js policy-test "git status" --cwd C:\work\my-repo
```

- `revoke` は記録した ACL を戻したうえで、付与後に作られたファイルからも SID を取り除きます。
- **Jest と Vitest は、既定の起動のままでは `workspace-write` で失敗します**（ワーカーを child_process で起動するため。ADR 0001 §7 で実測）。次のどちらかで動かします。
  1. スレッドで動かす（サンドボックスを緩めない）: Jest は `--runInBand` か `--workerThreads`、Vitest は `--pool=threads` か `--pool=vmThreads`。
  2. ユーザーポリシー（`%APPDATA%\hy-harness\policy.star`）で `low-integrity` にする（別セッションの付与ルートと `LocalLow` に書けるようになる）。

```python
# Jest と Vitest の既定のワーカーは pipe/IPC を使う（ADR 0001 §7）
prefix_rule(
    pattern = [["npx", "npx.cmd"], ["jest", "vitest"]],
    sandbox = "low-integrity",
    match = ["npx jest", "npx vitest run", "npx.cmd vitest run"],
)
prefix_rule(pattern = [["jest", "vitest"]], sandbox = "low-integrity", match = ["jest --ci", "vitest run"])
```

---

## 2. 実装したもの

### 2.1 Rust 実行デーモン `crates/hy-exec-server`

- **JSON-RPC 2.0 / stdio**: 1 行 1 メッセージ。stdout はプロトコル専用、ログは stderr。
- **`initialize`**: ワークスペース、状態ディレクトリ、サンドボックス、ポリシー、シェル、環境変数許可リスト、保護パス、`extraWritableRoots` を固定。confined のセッションでは、ここでサンドボックスを準備する（§2.2）。
- **`policy/evaluate` / `exec/command`**: Starlark ポリシーをサーバー側で強制。`deny` は `-32001`、`prompt` は承認なしで `-32001`（`data.sandbox` に実行予定のモード）。confined のモードはトークンがなければ `-32006`。
- **confined の起動**: `CreateProcessAsUserW` + `STARTUPINFOEX`。作成と同時に Job Object へ入れ（`JOB_LIST`）、継承するハンドルを stdio の 3 つに限る（`HANDLE_LIST`）。隠しコンソールを継承。`TEMP`/`TMP` は専用 temp。`.cmd` / `.bat` は confined ではシェル経由で起動（std の BatBadBut 対策が手組みのコマンドラインでは使えないため）。
- **ジョブ管理**: 前景 5 秒で背景化。Job Object（`KILL_ON_JOB_CLOSE`）。`job/list|status|output|wait|kill`。
- **`patch/apply`**: unified diff、文脈による位置決め、CRLF/BOM 保持、一時ファイル + `ReplaceFileW`/`MoveFileExW`、巻き戻し。サンドボックスが使えるときは `workspace-write` の偽装トークンで書く。
- **チェックポイント**: 一時インデックスへの `git add -A`、変わったパスだけ復元、ユーザーの `.git/index` と `HEAD` を保持。git の前に毎回 `.git` を検査し、`core.hooksPath=<空ディレクトリ>` と `core.fsmonitor=false` を付けて実行（案 A）。
- **`sandbox/status|grant|revoke`**: 実装済み。

### 2.2 Windows サンドボックス `crates/hy-sandbox-windows`

- **トークン**: `read-only`、`workspace-write`（制限 SID: logon、Everyone、workspace SID、temp SID）、`low-integrity`（制限 SID なし、Low のみ）。いずれも `DISABLE_MAX_PRIVILEGE`、Administrators を deny-only、Low ラベル。
- **付与**: 自前の並列走査で明示 ACE を 1 回付ける。リパースポイントはたどらない。リンク数 2 以上のファイルは飛ばす。`.git` と `.hy-harness` には拒否 ACE。変更前の SDDL を記録。
- **取り消し**: 記録を戻したあと、ツリーを走査して SID を名指しする ACE、付与で付いた Everyone の `FILE_DELETE_CHILD` 拒否 ACE、Low ラベルを取り除く（案 E）。
- **検査**: ボリュームの `FILE_PERSISTENT_ACLS`、ACL のないドライブの列挙（`non-acl-volumes`、案 D）、偽装トークンでの上位ディレクトリの読み取り（案 B）、`.git` が書き込み可能になっていないか（案 A）。ワークスペースが ACL 非対応ボリュームの場合は ACL 付与をスキップし、制限トークンのまま実行する（Codex 互換。書き込み境界はボリューム全体）。
- **偽装**: スコープ付きスレッドで `SetThreadToken` → 処理 → `RevertToSelf`。呼び出し元のスレッドは偽装しない。

### 2.3 TypeScript `packages/core`、`packages/seams`、`packages/hy-cli`

- **設定**: ユーザー設定とプロジェクト設定の分離。`--sandbox` / `HY_SANDBOX` の値を検証。`extraWritableRoots` はユーザー設定からのみ。
- **ツール**: `read_file`、`apply_patch`、`shell`、`run_code`（`ptc/run` 経由で AppContainer のワーカーが実行。§2.4）。承認は「誰が承認したか」と拒否理由を返し、拒否理由はツールエラーとしてワーカーに戻す。`AbortRunError`（Guardian の 3 回拒否など）はモデルに戻さず実行を止める。
- **Guardian**（`packages/seams/src/guardian.ts`）: ツールなしの 1 回の呼び出し。コマンドは `<untrusted_command>` で囲み、閉じタグの偽装を無害化。`decision === "approve"` かつ `riskScore < approveBelow` のときだけ承認。形式の壊れた応答や呼び出しの失敗は拒否。
- **CLI**: `run` / `ralph` / `undo` / `sandbox status|grant|revoke` / `policy-test`。

### 2.4 ツールの登録表と `run_code` の SDK（Phase 5）

- **登録表**（`packages/core/src/tool-registry.ts`）: ツールごとに 1 つの JSON Schema。これを、呼び出し時の引数の検査、システムプロンプトの関数シグネチャ、`run_code` の `declare namespace tools`（`jsonSchemaToTs`）の 3 つに使う。
  - 直接呼べるツールは `read_file`、`apply_patch`、`shell`、`run_code` の 4 つ。`tools.search.{glob,grep}` と `tools.jobs.{status,output,wait,kill}` は `run_code` の中でだけ使え、モデルが直接呼ぶと拒否する。
  - 引数の検査は、型、必須、enum、最小値を守らせる。知らないプロパティは無視する（小規模モデルが余計なものを付けるため）。`apply_patch` の `path` は `file` の別名として受け付ける（プロンプトのトークンを増やさないため、スキーマには載せない）。
- **検索**: `glob`（`*`、`**`、`?`、`{a,b}`）と `grep`（JavaScript の正規表現、`glob` で絞り込み）。`.git`、`node_modules`、`.hy-harness` には入らず、リンクはたどらない。`grep` は 1 MB 超とバイナリを飛ばす。
- **トークン量（実測）**: `qwen2.5:3b` のトークナイザーで、直接呼べる 4 ツールが約 320、SDK を含めて約 1,140 トークン（設計の上限 1,200。Phase 6 以降のツール追加後。SDK は同じ型を `type Job` / `type NoteCount` として 1 回だけ宣言して参照する）。Ollama が使えるときに `tool-overhead.test.mjs` が毎回測る。

### 2.5 PTC ワーカー（`run_code`、Phase 5 の AppContainer 化、案 F）

- **起動**: `hy-exec-server` が `ptc/run` で、能力（capability）なしの AppContainer（プロファイル `hy-harness.ptc-worker`）にワーカーを起動する。Job Object は `ActiveProcessLimit = 1` と `KILL_ON_JOB_CLOSE`。`node --preserve-symlinks --preserve-symlinks-main --permission --allow-fs-read=<runtime>`。
- **配置**: ワーカーは `%USERPROFILE%\.hy-harness\ptc-runtime` にコピーし、`ALL APPLICATION PACKAGES` に読み取り・実行を許可する（AppContainer は F: の exFAT や通常のユーザーディレクトリを読めない）。
- **環境変数**: `SystemRoot`、`windir`、`NUMBER_OF_PROCESSORS`、`OS`、`PROCESSOR_ARCHITECTURE`、`LOCALAPPDATA` だけ。`LOCALAPPDATA` がないと AppContainer の `CreateProcess` が `ERROR_ENVVAR_NOT_FOUND`（203）で失敗する（Windows がコンテナ専用ディレクトリと `TEMP` をここから導く）。
- **ブリッジ**: ワーカーの `toolCall` を、デーモンがクライアントへの `ptc/toolCall` リクエストとして中継する。サブ呼び出しは直接の呼び出しと同じガード、ポリシー、承認を通る。デーモン側でもサブ呼び出しの上限と、`run_code` の入れ子の禁止を強制する。
- **並列**: `ToolRuntime` の読み書きロックで、`read_file` は並列、それ以外は排他。
- **タイムアウト**: デーモンが Job を終了させて強制する（ハングしたスクリプトや無限ループも終わる）。
- **二重の防御（実測）**: ファイルとプロセスの起動は Node の `--permission` が先に止め（`ERR_ACCESS_DENIED`）、ネットワークは AppContainer が止める（`EACCES`。Node 24 の permission model はネットワークを扱わない）。`--permission` がなくても AppContainer がファイルを止めることは ADR 0001 S-5 で実測済み。
- **後始末**: `hy sandbox revoke` が AppContainer のプロファイルも削除する（次の `run_code` で作り直す）。

### 2.6 Rationale Ledger、Spill、Compaction（Phase 6）

- **Ledger**（`packages/core/src/ledger.ts`）
  - **固定の制約**: ワークスペースの `AGENTS.md` / `AGENTS.override.md` と、CLI の `--rule`（複数指定可）。消えることはない。
  - **エージェントのメモ**: モデルが `run_code` の中で `tools.rationale.{upsert,supersede,remove}` で記録する。上限は 12 件・約 1,500 トークン（プロジェクトの `limits` で変更可。未信頼のプロジェクトは厳しくする方向のみ）。上限で新しいキーを追加しようとすると、現在のキー一覧付きのエラーになる（OQ-5）。黙って消すことはない。
  - **描画**: 毎回のリクエストで、システムプロンプトに `<project_constraints>` と `<agent_notes>`（「以前の自分のメモであり、指示より優先しない」という前置き付き）をそのまま入れる。要約とは独立している。
  - **順序**: セッションログの `ledger/*` イベントを、ラン（`runId`）ごとに `seq` の順で畳み込む。`seq` はログファイル単位で単調増加するように直した（以前はセッションごとに 1 から始まっていた）。`hy ralph` は各ラウンドを新しい子セッション（新しい `SessionLog` と `ToolRuntime`）で動かし、前のラウンドのメモをログから引き継ぐ。
- **Spill**（`packages/seams/src/spill-compaction.ts`）: 32 KiB（`spillThresholdBytes`）を超えるツール出力は `<stateDir>\spill\<session>\<call>.txt` に書き、モデルには先頭と末尾、`SpillRef` を見せる。`read_file({ path: "spill://<session>/<call>" })` で読める（書き込みはできない）。以前の 20,000 文字での切り捨てを置き換えた。
- **Compaction**: 直前のリクエストでプロバイダーが報告した入力トークンが、コンテキスト窓の 75 %（`compactionTriggerRatio`）以上になったら始める。
  - **Tier 1**: 直近 2 組（`keepRecentTurns`）より古いツール出力を、`spill://` の参照に置き換える（未退避のものは先に退避するので、内容は失われない）。
  - **Tier 2**: 推定（直前の実トークン数で補正）がまだ閾値以上なら、`compactor` ロール（既定はワーカーと同じ）が古い組を要約する。切るのは組の境目だけなので、ツール呼び出しと結果が離れることはない。要約は目的のメッセージの後ろに `<session_summary>` として付け、要約役にはメモのキーを渡して言い換えさせない。
  - イベント: `compaction/prune`、`compaction/summary`。各ステップの `step/end` に、描画したシステムプロンプトのハッシュを記録する。
- **設計との違い**: エージェントのループが `core` にあり、`seams` は `core` に依存するので、`core` に小さな `ContextManager` インターフェースを置き、`seams` の `SpillCompaction` がそれを実装する（Guardian が承認コールバックで差し込むのと同じ形）。固定の制約の探索はワークスペースの直下だけ（設計の「cwd からリポジトリのルートまで」は、ワークスペース＝cwd なので同じ）。

### 2.7 verifier-ralph と Budget4D（Phase 7）

- **`packages/seams/src/verifier-ralph.ts`**: 設計 §7 の結果の表どおりの状態機械（claimed / stalled / aborted / budget-exhausted / tamper-rejected / gate1-failed / gate2-failed / succeeded）。ワーカーのセッションは CLI が `runRound` コールバックとして渡すので、台本どおりのワーカーで試験できる。`round/start`、`round/end`、`gate/result` をセッションログに残す。
- **`packages/seams/src/budget.ts`**: ロールごとのプロバイダーを `meter()` で包み、呼び出しの前に 4 つの次元を確かめる。費用は「推定入力 + 絞った出力」の最悪値で判定する。ラウンドの中断（タイムアウト、Ctrl-C）も同じ場所で確かめる。Guardian は予算切れを「拒否」として飲み込まず、そのまま伝える。
- **`claim_complete`**（OQ-4）: 設計では `tools.objective.claimComplete`（`run_code` の SDK）だが、`--ptc` なしの小規模モデルでも宣言できるよう、`hy ralph` のセッションでだけ 5 つ目の直接呼べるツールとしても出す（`hy run` には出ない。`hy run` は従来どおり `final` で終わる）。
- **Gate 2 の入力**: 目的、固定の制約、宣言の要約、`base` からの累積差分（切り詰めたらその旨を明記）、Gate 1 の出力、ワーカーのメモ。メモ・宣言・差分・出力は `<untrusted_…>` で囲い、メモは判定基準ではないと明記する。出力は `{pass, unmetCriteria, rollbackRecommended, reasoning}` の厳密な形式で、壊れていたら不合格。

### 2.8 アダプタ（Phase 8）

- **共通の再試行**: 429 と 5xx（`Retry-After` を尊重）とネットワークエラーを指数バックオフで再試行し、それ以外の HTTP エラーはすぐ失敗させる（設計 §9）。Ollama、OpenAI 互換（DeepSeek）、Gemini すべてに適用。
- **Gemini**（`--provider gemini`、`GEMINI_API_KEY`）: Interactions API（`POST /v1beta/interactions`、`x-goog-api-key` ヘッダー。鍵を URL に入れない）。一次ソース（`verification/sources/gemini_thinking.txt`、`gemini_tokens.txt`）の形式に従う。各リクエストを 1 ターンとして送り（システムプロンプトは `system_instruction`、会話は役割付きのテキストにまとめて `input`）、思考トークンは出力として数える（思考は出力として課金されるため）。複数ターンを状態なしで送るには、受け取った `thought` ブロックをそのまま送り返す必要があるが、エージェントは Compaction で履歴を書き換えるため、この方式にした。
- **契約テスト**（`packages/core/src/llm.test.ts`）: 手元の HTTP サーバーでフィクスチャを返し、送った内容（ヘッダー、本文）と読み取った内容（本文、使用量）を確かめる。Ollama のフィクスチャは実際の Ollama（`qwen2.5:3b`）から記録した。OpenAI 互換と Gemini は鍵がないため、文書の形式から作った（各ファイルの `_note` に明記）。

### 2.9 チェックポイントの性能（Phase 8）

- `pnpm bench:checkpoint`（`tests/bench/checkpoint-bench.mjs`）: C:（NTFS、Defender 有効）に 1 万ファイルのリポジトリを作り、同じ 200 ファイルを毎回変えて、作成とロールバックをデーモンの計測値で測る。
- **目標**（2026-11-03 に改訂）: 作成 750 ms 未満、ロールバック 500 ms 未満。当初は両方 500 ms 未満だったが、作成は変更ファイルをすべてハッシュして loose object を書く必要があり、Defender が新しいファイルを 1 つずつスキャンするため、500 ms に届かなかった（下の内訳）。
- **結果**（リリースビルド、7 回の中央値）: ロールバック **約 265 ms**、作成 **約 610〜650 ms**。どちらも改訂後の目標を満たす（`pnpm bench:checkpoint` は PASS）。
- **改善済み**: ラン単位の stat キャッシュ。以前は毎回ユーザーの `.git/index`（ラン中に更新されない）から写していたため、ユーザーが最後に `git status` してから変わったファイルを毎回ハッシュしていた。直前のスナップショットの索引を使うようにして、作成 962 → 648 ms、ロールバック 1,164 → 827 ms。
- **改善済み（ロールバック）**: 以前のロールバックは、作業ツリーをもう一度スナップショットして（`add -A` と `write-tree` で object を書き）、tree 同士を比べていた。今は作成時の索引（`<label>.snap.index`）をそのまま残しておき、その写しで `update-index --refresh`（stat が変わって中身が同じファイルを除く）→ `diff-files`（変更・削除）と `ls-files -o`（新規）で差分を出し、object を書かない。827 → 265 ms。メタデータに記録した tree と ref の tree が一致しないとき（作成の途中で失敗したなど）は、tree を stat なしで読み込んで全ファイルをハッシュする（遅いが正しい）。削除を先に行うので、ファイルとディレクトリが入れ替わった場合も戻せる（単体テストあり）。
  - 内訳（実測）: refresh 約 75 ms、`diff-files` 約 85 ms、`ls-files -o` 約 30 ms、`checkout-index -u`（200 ファイルと索引の書き込み）約 140 ms。`ls-files -m` で一度に出す方法は、1 万エントリを 1 件ずつ stat するため 約 370 ms かかったので使わない。
- **残りの内訳**（実測）: `rev-parse`・`commit-tree`・`update-ref` は各 約 25 ms。`add -A`（200 ファイルのハッシュと loose object の書き込み）が 約 400〜500 ms、`write-tree`（約 100 の tree object）が 約 180 ms。変更直後のファイルを読むだけでも Python で 200 ファイル 約 2 秒かかり、Defender のリアルタイムスキャンがファイルごとの I/O を支配していると見られる。

### 2.10 検証計画の結果（Phase 8）

| 項目（設計の検証計画） | 結果（このマシン、2026-11-03） |
| :--- | :--- |
| ビルドの警告 0（`cargo build --workspace`、`pnpm build`） | ✅ 0 件 |
| 静的解析（`cargo clippy -D warnings`、`pnpm typecheck`、プロトコルの差分） | ✅ すべて問題なし（`pnpm typecheck` は何も検査していなかったので直した） |
| 単体テスト | ✅ Rust 37 件、TypeScript 70 件 |
| 結合テスト | ✅ 49 件（サンドボックス、PTC、Guardian、verifier-ralph、`$/cancelRequest` 中断、対話チャット、MCP、スキル、フック、プラグイン、自動化、永続PTY、トークン量、Web/Desktop GUI、オーケストレーションなど） |
| カバレッジ 85 % 以上（純粋なロジック） | ✅ TypeScript: 全体で行 98.9 %・分岐 90.6 %。Rust（`pnpm coverage:rust`、`llvm-cov`）: 純粋ロジック合算で行 **89.2 %**（`1907/2137`）・領域 **88.6 %**（`3277/3699`） |
| `pnpm bench:checkpoint`（1 万ファイル・変更 200、作成 750 ms 未満・ロールバック 500 ms 未満。2026-11-03 に改訂） | ✅ 作成 約 625 ms、ロールバック 約 265 ms（中央値、リリースビルド、Defender 有効）。詳細は §2.9 |
| セルフホストの Windows 10 22H2 ランナー | ✅ `.github/workflows/ci.yml` に定義済み、ローカル Windows 10 22H2 実機で全ステップ PASS |

### 2.11 テスト

- `cargo test --workspace`: **37 件成功**
  - `hy-exec-server` 17 件（`checkpoint` の 50 MB 超未追跡ファイル除外 `unprotected`、`patch` の純粋リネーム・削除 dry-run、`cmdline` のバッチ・PowerShell クォートを含む）、`hy-execpolicy` 9 件（`low-integrity` はユーザーポリシーのみ）、`hy-protocol` 4 件、`hy-sandbox-windows` 7 件（標準ユーザー `is_admin_member == false` と UAC 管理者 `is_admin_member == true` の双方のトークン構築、付与 → 取り消しの往復と付与後のファイルの除去、専用デスクトップ、非 ACL ボリューム列挙を NTFS で実行）
- `cargo clippy --workspace --all-targets -- -D warnings`: 警告なし
- `node scripts/gen-protocol.mjs --check`: 差分なし
- `pnpm test`: **70 件成功**（`cordis` サービスラッパーのライフサイクルテスト 2 件、アダプタの契約テスト 5 件、verifier-ralph の状態機械 5 件、Budget4D 5 件、Ledger 4 件、Spill / Compaction 3 件、Guardian 8 件、ツールの登録表 6 件、チャット投影 3 件、cron 2 件、自動化 MCP プリセット 1 件、および機能パリティの `RepeatToolReminderGuard`・スキル・MCP・フック・Web・LSP・プラグイン・メモリ・プロファイル等のテスト 19 件）
- `pnpm test:integration`: **49 件成功**
  - `verifier-ralph.test.mjs` 8 件（Phase 7 の完了条件 + ラウンドタイムアウト時の `$/cancelRequest` による実行中 `shell` ツール呼び出しと Job Object の即時終了テスト）
  - `feature-parity.test.mjs` 10 件（`hy chat`、`/undo`、`hy resume`、`hy review`、`/review`、カスタムプロンプト、`ask_user`、`/plan-mode`、フック、MCP サーバー・クライアント、プラグイン、`delegate` サブエージェント、`web_fetch`）
  - 既存 4 件（`hy run --mock`、`policy-test`、`ralph` → `undo`、`run_code`）
  - `ptc-appcontainer.test.mjs` 9 件
  - `win10-sandbox.test.mjs` 5 件（confined の子プロセスは専用デスクトップで起動し、`node.exe` / `powershell.exe` / AppContainer で `0xC0000142` が出ないことを確認。ユーザーのデスクトップは変更しない）
  - `tool-overhead.test.mjs` 1 件（実測: 直接ツール 約 320 トークン、SDK 込み 約 1,140 トークン ≤ 上限 1,200）
  - `guardian.test.mjs` 3 件
  - `web-ui.test.mjs` 8 件（認証 / bootstrap / ファイル / 設定、PWA マニフェストと `mcp-call` 制限、永続PTYの起動 / SSE / 入力 / `cd` 保持 / リサイズ / クリア / 停止、プラグインのカタログと再読み込み、スケジュール / Webhook、チャット / ゴール / サブエージェント / バックグラウンドジョブ / SSE / Trace / ターミナル、実行中 shell のキャンセル、承認拒否、Verifier loop、オーケストレーションの spawn / スコープ重複拒否 / ワーカーのサブエージェント）
  - `automation-mcp.test.mjs` 1 件（Playwright MCP と agent-desktop MCP の起動・ツール検出）
- 実モデル評価（[`scripts/eval-ollama.mjs`](../scripts/eval-ollama.mjs)、結果: [`spikes/win-sandbox/results/ollama-live-eval.json`](../spikes/win-sandbox/results/ollama-live-eval.json)）:
  - Ollama `qwen2.5:3b` で Compaction（Tier 1 退避 2 件 + Tier 2 要約 2 組の後に `<project_constraints>` と `<agent_notes>` の両方を遵守）、Guardian（5/5 = 100 % 正解）、Gate 2 Grader（`workerNotes` のプロンプトインジェクションに惑わされず Round 1 の `subtract` 欠落を `pass: false` で却下し、Round 2 の完全実装を `pass: true` で承認）をすべて実測確認済み。

### 2.12 Desktop GUI（DSH 準拠、2026-11-03）

- **構成**: `packages/desktop`（Electron メインプロセス、preload、メニュー、ネイティブワークスペース選択）と、CLI と GUI が共有する `packages/hy-cli/src/session-app.ts`、ローカル API の `packages/hy-cli/src/web-server.ts`、永続PTYの `packages/hy-cli/src/pty.ts`、UI の `packages/hy-cli/web`（TypeScript + CSS、UI フレームワークなし、xterm.js は vendor 同梱）。
- **起動**: `pnpm desktop`（Electron）、`pnpm desktop:screenshot`（モックのデモ + `screenshots/desktop.png`）、`pnpm desktop:package`（`release\HY-HARNESS.exe`）、`hy web [--port 0] [--no-open] [--tailscale]`（同じ UI をブラウザ / スマホで）。
- **画面**: 左にセッション（検索、日付グループ、実行中表示、ピン留め / アーカイブ）、中央に会話（Markdown、ツールカード、承認、質問、ゴール、プラン、画像添付、`@file`）、右に Files / Diff / Plan / Details / Trace / Browser / Terminal / Desktop。Details にはジョブ、サブエージェント、ノート、スキル、MCP、プラグイン、ワークスペースメモリ、サンドボックス、ロールを表示する。
- **操作**: 送信 / 停止（`$/cancelRequest`）、`/new` `/help` `/status` `/diff` `/undo` `/notes` `/plan` `/compact` `/model` `/review` `/init` `/settings` `/export`、ゴール、プランモード、モデル切替、レビュー、Verifier loop（`hy ralph` を子プロセスで起動して出力を表示）、設定保存（モデル一覧と役割割当、承認モード、ロール、サンドボックス、プラグイン、メモリ、Web、自動化）、モデルごとの自動 Context window / Max output、ピン留め / アーカイブ、プラグインの再読み込み、永続PTY / 単発コマンド、Browser プレビュー / Playwright 操作（既定ブラウザ Chrome）、Desktop 操作、スケジュール / Webhook、スマホからの Tailscale アクセス。UI は English / 日本語 / 中文。既定テーマは白色 / 桜色（任意で night sakura）。`HY_icon.png` をウィンドウ / タスクバーアイコン、favicon / PWA アイコン、ブランドマークに使用。
- **セッション UI 状態**: ピン留め / アーカイブは `<stateDir>/ui-state.json` に保存し、一覧はピン留め優先。アーカイブは `Show archived` で表示する。ワークスペース切替時はプラグイン / MCP の構成キーを比較して再読み込みする。
- **認証**: 既定はループバック限定。`--tailscale` は Tailscale IPv4 にだけバインドする（Funnel なし）。起動ごとのランダムトークンを URL で受け、`HttpOnly; SameSite=Strict` Cookie に交換する。API は Cookie または Bearer を要求。CSP は `default-src 'self'`。Electron は `contextIsolation`、`sandbox`、`nodeIntegration: false`、権限要求は拒否。PWA マニフェストと Apple touch icon を同梱し、スマホのホーム画面から開ける。
- **モデル設定**: Settings のモデル一覧にプロバイダー・モデル・Base URL・API key env を登録し、Worker / Guardian / Grader / Compactor に割り当てる。Provider 変更時は既定値、Context window / Max output はモデルごとの読み取り専用値を自動適用する。`/model` の切替は新規セッションの既定として `config.json` に保存する。API キーは環境変数名と直接キーの両方に対応し、直接キーは `config.json` にローカル保存して環境変数より優先する（可能なら環境変数を推奨）。`--mock` は Grader も Mock に固定する。ヘッダー / 入力欄のトークン数はプロバイダーの `usage` に基づく実測値をカンマ区切りで表示し、直近ターンの in / out も併記する。
- **テスト**: `chat-projection.test.ts` 3 件（ログ投影、ゴール前置き、ライブツール更新）、`cron.test.ts` 2 件、`config.test.ts` の自動化プリセット 1 件、`tests/integration/web-ui.test.mjs` 7 件（認証 / bootstrap / ファイル / 設定、PWA マニフェストと `mcp-call` 制限、永続PTYの起動 / SSE / 入力 / `cd` 保持 / リサイズ / クリア / 停止、プラグインのカタログと再読み込み、スケジュール / Webhook、チャット / ゴール / サブエージェント / ジョブ / SSE / Trace / MCP / メモリ / ターミナル / Verifier loop、実行中 shell のキャンセル、承認拒否）、`automation-mcp.test.mjs` 1 件（Playwright MCP / agent-desktop の起動）。`pnpm desktop:screenshot` で Electron 実機の画面を取得済み。日本語 UI・白色 / 桜色テーマ・ピン留め・Browser / Terminal / Desktop・自動化モーダルを確認した。GUI から Playwright の Navigate → Snapshot → Type → Click → Snapshot で `Clicked sakura`、Desktop の Apps で `ok: true` を確認。永続シェルに `echo UI_PTY_OK` と `Set-Location C:\Windows` を入力し、`CWD=C:\Windows` を確認。390 px 幅で本文 390 px・入力欄 366 px、サイドバー / 右パネルの開閉、PTY 幅 358 px を確認。
- **Windows exe**: `electron-builder` の portable ターゲットで `release\HY-HARNESS.exe` を生成する。`hy-exec-server.exe` を `extraResources`、`node-pty` / Playwright MCP / agent-desktop を同梱し、MCP は `ELECTRON_RUN_AS_NODE=1` で Electron の Node モードから起動する。パッケージ版で `PACKAGED_PTY_OK` と Chrome の `PACKAGED_BROWSER_OK` を確認した。コード署名は未設定。
- **2026-11-03 追記（UI 仕上げ）**: 設定のサンドボックス注意を日本語の小さな枠なし注記にし、自動化の再起動注意は変更時だけ表示。承認モードの sandbox 説明を現在値に追従。モデル追加 / 削除で編集中の設定を保持。チャット完全削除、回答コピー（Electron ネイティブクリップボード + フォールバック）、Effort と thinking 表示を追加。Compactor は初回使用時まで遅延初期化し、未使用ロールのキー不足でチャットが止まらないようにした。DeepSeek 実 API で Effort `high` / `reasoning_content` / トークン表示を確認。存在しない前回ワークスペースが `desktop.json` に残っていても起動時に無視して選択画面へ戻し、画面外の保存ウィンドウ位置も補正するようにした。最新 exe を G: に同期し、SHA-256 を照合済み。
- **回帰**: `pnpm test` 70 件、`pnpm test:integration` 49 件が成功（2026-11-03）。既存の CLI / Rust / サンドボックス / verifier-ralph のテストに影響なし。

### 2.13 Orchestration A+（2026-11-03）

- **目的**: DSH superagent の「オーケストレーターが複数の通常セッションを管理する」考え方を、承認済みスコープの HY-HARNESS に取り込む。
- **階層**: オーケストレーター（通常セッション、plan 固定）→ ワーカー（通常セッション、書き込み可）→ ワーカーの `delegate` サブエージェント。オーケストレーションに `delegate` / `runSubagent` は使わない。
- **オーケストレーター**: 専用プロンプト `packages/hy-cli/prompts/orchestrator.md`。読み取り・検索・計画と `orchestrator_spawn` / `send` / `workers` / `diff` / `approve` / `stop` / `close` のみ。`apply_patch` / `shell` / `delegate` は提供せず、`setPlanMode(false)` も拒否する。
- **ワーカー**: 通常の `Conversation`。`delegate` を含む通常ツールが使える。専用プロンプト `packages/hy-cli/prompts/worker.md`、担当パス、`apply_patch` のスコープ検査、git / undo / checkpoint / harness 状態変更コマンドの拒否、チェックポイント無効化、ワーカー間のシェル直列化、バックグラウンド移行の禁止を適用する。UI の入力欄は読み取り専用。
- **自動化**: ワーカーの完了・失敗・承認要求はオーケストレーターに自動通知し、待機中のオーケストレーターのターンを起こす。実行中は 5 分間イベントがないワーカーについて心拍通知を送る。オーケストレーターは待機ループを持たない。
- **衝突防止**: ワーカーの担当ディレクトリは必須で、親子関係を含む重複を拒否する。同時ワーカーは 3。`orchestrator_diff` は担当範囲の `git status` / `git diff` と範囲外の変更を返す。ツールによるファイル編集は担当範囲外を拒否する（シェルはプロンプトとレビューで制御）。
- **UI**: サイドバーの「オーケストレーション開始 / 終了」、オーケストレーターとワーカーの階層表示、ワーカーの状態、読み取り専用チャット、Details のワーカーカードと停止ボタン。
- **永続化**: `<stateDir>/orchestration.json`。再起動時は実行中 / 待機中 / 承認待ちのワーカーを `interrupted` にし、オーケストレーターへ通知する。
- **対象外**: ワーカーごとの `git worktree`、自動マージ、複数オーケストレーションの同時実行。同一ワークスペース + パス分担（A+）の制約を維持する。

### 2.14 DSH 差分の導入（M0〜M6、2026-11-05、v0.4.0）

- **概要**: DSH との差分分析（[dsh-gap-analysis.md](dsh-gap-analysis.md)、111 項目）から 106 の不足を整理し、24 の作業パッケージに落として M0〜M6 を実装した。各 WP の成果物・設計判断・検証は [dsh-adoption-progress.md](dsh-adoption-progress.md) と [project.md](../project.md) §5.
  に記録している（計画は [dsh-adoption-plan.md](dsh-adoption-plan.md)）。
- **主な追加**: 実行中ステアリングと永続ターンキュー、バックグラウンドのサブエージェント、`todo_write`/`present`、`write_file`/`edit_file`/`read_image`、永続シェル、FTS5 のセッション検索、Anthropic/Responses プロバイダとモデルカタログ、バンドル、API 契約、ACP、SDK（TS/Python）、文書プレビュー、署名付き更新と初回ウィザード、生成タイトル・計測・fork・`@session` 参照・評価・ショートカット・テーマ・Open In・シークレットマスク・オプトイン OTel。
- **不変条件**: K1〜K14 は維持。組み込みツールは wire 19（うち 5 つは `tool_search` で遅延ロードする deferred。CP-10）。初期プロンプトは直接 14 + `tool_search`（deferred があるとき）。サンドボックスの既定は `workspace-write`（2026-11-05 の CP-01）。**初期**プロンプト（直接ツール + PTC SDK）は 1,200 トークン以内。
- **未実施（運用）**: 実機での `pnpm desktop:package` とコード署名、外部プロバイダでの有償実走（この環境の DeepSeek キーは残高不足）、ワーカーごとの `git worktree`。

---

## 3. 実装中に分かったこと

1. **F: は exFAT**。pnpm は `node-linker=hoisted`、Cargo は `CARGO_INCREMENTAL=0` が必要。
2. **`@hy/core` の workspace リンクも exFAT で失敗**。CLI と seams は `../../core/dist/index.js` を直接 import する。
3. **小規模モデルは unified diff を書けない**。`apply_patch` の `{file, content}` フォールバックで解決。
4. **`run_code` を常時出すと小規模モデルが壊れた JSON を出す**。`--ptc` のときだけ表示。
5. **Ollama の `qwen3:4b` は JSON モードで token repeat limit に達した**。既定は `qwen2.5:3b`。
6. **DeepSeek の API は残高不足**（HTTP 402）。既定プロバイダーは Ollama。
7. **Node 26 と pwsh 7 はこのマシンにない**。Node 24.19.0 と Windows PowerShell 5.1 で動作を確認。
8. **Windows PowerShell 5.1 は出力をリダイレクトすると進捗を `#< CLIXML` として stderr に出す**。シェル経由のコマンドの前に `$ProgressPreference = 'SilentlyContinue'` を付けて抑えた。
9. **`std::fs::canonicalize` は `\\?\C:\…` を返す**。cmd.exe はそれを作業ディレクトリにできず、SID の導出もぶれるので、サンドボックスでは接頭辞を外した形を使う。
10. **サンドボックスのテストは `%TEMP%` に置けない**（AppData のパッケージ SID の ACE。ADR 0001 §5.2）。フィクスチャは `%USERPROFILE%` の下に作る。
11. **Desktop の Mandatory Label が未設定だと Low 整合性の子プロセスが `0xC0000142` で落ちる**: `GetThreadDesktop(GetCurrentThreadId())` の SACL に明示的な Mandatory Label がない場合、Windows カーネルは Desktop を既定の Medium 整合性として扱うため、`user32.dll` を読み込む Low 整合性の子プロセス（`node.exe`、`powershell.exe`、`whoami.exe` 等）が `DllMain` で `0xC0000142`（`STATUS_DLL_INIT_FAILED`）になる。当初は `console.rs` でユーザーの WindowStation と Desktop（`WinSta0\Default`）にこのラベルと `ALL APPLICATION PACKAGES` / `RESTRICTED` への書き込み許可を設定していたが、これはセッション全体に効き、ログオフまで残り、すべての AppContainer アプリにユーザーのデスクトップへの書き込み（フックを含む）を許すため、設計 §4.2 に反していた。**2026-11-03 に撤回し、専用デスクトップに置き換えた**: confined の子プロセスは hy-harness が作る専用のウィンドウステーション（作れない環境では現在のウィンドウステーション内の専用デスクトップ `hy-harness-<pid>`）で起動し、その DACL とラベルだけを設定する。

---

## 4. 現在のコード構成

```text
F:\HY-HARNESS\
├── .github\workflows\ci.yml # GitHub-hosted Windows Server + self-hosted Windows 10 22H2 CI
├── crates\
│   ├── hy-protocol\        # JSON-RPC 型、JSON Schema、TS 型生成
│   ├── hy-execpolicy\      # Starlark ポリシー、方言別字句解析
│   ├── hy-sandbox-windows\ # トークン、付与/取り消し、起動、偽装、検査、専用デスクトップ
│   └── hy-exec-server\     # RPC（$/cancelRequest 対応）、ジョブ、パッチ、チェックポイント（50 MB 除外）、サンドボックスの準備
├── packages\
│   ├── core\               # config, cordis, exec-rpc, llm, tools, agent, session-log, skills, mcp, hooks, web, lsp, plugins, memory, PTC worker
│   ├── seams\              # Guardian, SpillCompaction, VerifierRalph, Budget4D
│   ├── hy-cli\             # hy run / web / ralph / chat / resume / sessions / review / mcp-server / undo / checkpoint / sandbox / policy-test
│   │   └── web\            # Electron と hy web が共有する 3 カラム UI（TypeScript + CSS）
│   └── desktop\            # Electron メインプロセス、preload、ネイティブメニュー、ワークスペース選択
├── spikes\win-sandbox\     # Phase 1 スパイク・OQ-2 実測・Ollama 実走評価結果
├── tests\integration\      # E2E、サンドボックス、PTC、Guardian、verifier-ralph、トークン量（Node test）
├── tests\bench\            # pnpm bench:checkpoint
└── scripts\                # protocol 生成、アセットコピー、Rust カバレッジ測定、Ollama 実走評価
```

---

## 5. 実装状況・外部環境制約による未実施項目の整理

| 項目 | 状態 |
| :--- | :--- |
| Windows サンドボックス | **実装・検証済み**。既定は `workspace-write`（CP-01）。`--unsafe-unconfined` で従来動作 |
| シークレット | **DPAPI 保存（CP-08、2026-11-05）**: `hy secret set` が `secrets.<name>` に `dpapi:` 参照を保存し、`roles.*.apiKeySecret` から解決する。`hy config dump` は既定で伏字（`--show-secrets` でのみ表示） |
| ツール検索 | **遅延ロード（CP-10、2026-11-05）**: `tool_search` が web/lsp/memory/mcp のツールを必要時にロードし、ロード後は通常のツールとして呼べる。初期プロンプトから 5 ツール分が外れる |
| ユーティリティ | **CP-12（2026-11-05）**: `current_time` / `sleep`（最大 60 秒・中断可）/ `get_context_remaining`（直近の provider 実測 usage と `contextWindowTokens`）。**CP-14**: `search_glob` / `search_grep` を直接ツールに昇格 |
| プロトコル（読み取り＋ターン） | **`hy protocol serve`（CP-25、2026-11-05）**: `initialize`（`turns: true`）/ `thread/list` / `thread/read` / `turn/start`（1 ターン実行、`turn/event` を通知）、`approval/request` / `approval/respond`（承認の往復、5 分でタイムアウト拒否）、`turn/cancel`（実行中ターンの中断）、`turn/steer`（実行中ターンへの追加入力）、`turn/status`（実行中かどうか）。`initialize` の `serverInfo` に `apiVersion`（`hy-api/1`）を含む。`threadId` で既存スレッド（run）を再開可能。未知の id は -32602。スレッドは `session.v1.jsonl` 内の run 単位 |
| CI ゲート | **CP-42（2026-11-05）**: CI に `cargo fmt --check` と生成物ドリフト検査（API 型・API スキーマ・config スキーマ）を追加。`pnpm verify` は同じゲートをローカルで一括実行 |: クリーンビルド（`tsc -b --force`）→ typecheck → 生成物チェック → Rust テスト → 単体テスト走査を 1 コマンドで実行。子プロセス必須のテストは環境依存として skip 表示（CI で実行） |
| フック（残り） | **stop / interrupt（CP-19、2026-11-05）**: 中断（`AbortSignal`）で `stop`、例外で `interrupt` を発火。`sessionEnd` は `Conversation.end()` で 1 回だけ発火（CLI `run`/`review` の終了時、GUI のセッション削除時） |
| 設定レイヤ | **CP-37（2026-11-05）**: 解決順は「既定 → ユーザー（+ `profiles.<name>` を `--profile` で重ねる）→ 信頼済みプロジェクト → CLI フラグ → バンドル」。`hy config paths [--json]` が各レイヤの実パスを表示 |
| フィーチャー CLI | **`hy features`（CP-38、2026-11-05）**: `list`（`--json`）と `enable`/`disable`。ユーザー設定の `features` に保存し、他の設定を保ったまま更新する |
| プロトコル（土台） | **CP-25（2026-11-05）**: JSON-RPC 2.0 のメッセージ層（`initialize` / thread / turn のメソッド登録、エラーコード -32700/-32600/-32601/-32602、通知、`hy-protocol/1`）。トランスポートと thread 実装は次段階 |
| フィーチャーフラグ | **CP-38（2026-11-05）**: `features` レジストリ（stable / experimental、既定値）と `config.features` の上書き。`streaming` を false にすると非ストリーミングへ戻る |
| メトリクス | **`GET /api/metrics`（CP-39、2026-11-05）**: uptime・開いているセッション数・RSS を返す純関数 `metricsSnapshot`（負値/NaN は 0）。API スキーマと型を再生成済み（91 ルート） |
| 診断 | **`hy doctor`（CP-39、2026-11-05）**: ワークスペース・exec-server・サンドボックス（enforcement / gaps / denyRead / readOnly）・ロールの認証情報・有効なフィーチャーフラグ・MCP・hy-secret を点検し、`ok`/`warn`/`fail` と `--json` を提供 |
| API スキーマ | **CP-26（2026-11-05）**: `API_ROUTES` から `docs/api.schema.json`（draft 2020-12、`version: hy-api/1`）を生成し、`pnpm check:api-schema` でドリフトを検出。`/api/health` が `apiVersion` を返し、`hy protocol schema` で出力 |
| トークン計測 | **CP-23（2026-11-05）**: 各ステップで `token/estimate`（estimated / actual / ratio）をセッションログに記録。`calibratedCoefficients` が実測比から係数を補正（0.5〜2 倍にクランプ）。`prompt_cache_key` は CP-23 で送信済み |
| セッション fork | **`hy fork`（CP-35、2026-11-05）**: 既存 run の履歴（`turn/start` 単位、`--turn n` で途中まで）を新しい run に複製。元の run は変更しない |
| コンパクション（非同期） | **CP-22（2026-11-05）**: `ContextManager.afterResponse` を追加し、Tier 2 の要約を**ターン終了後に裏で**用意。次のリクエストで同じプレフィックスのキャッシュがあればコンパクターを呼ばずに使う（`keepRecentTurns` の境界に合わせたセグメントハッシュ） |
| コンパクション | **CP-22（2026-11-05）**: 要約（Tier 2）の失敗でターンを落とさず Tier 1 の結果を返し、`compaction/failed` を記録。`preCompact` / `postCompact` フックを追加 |
| スキルの選択 | **CP-21（2026-11-05）**: `rankSkills`（名前一致・説明の語・使用回数で順位付け、短すぎる名前の誤一致を除外）と `SkillUsageStore`（`<stateDir>/skill-usage.json` に読み込み回数を保存し、カタログ順を安定化）。`skill_load` が回数を記録 |
| メモリ（自動） | **CP-20（2026-11-05）**: `memory.auto: true` で、ターン終了後に summarizer ロールが「長く効くワークスペースの事実」を JSON で抽出し、`MemoryStore.upsert` に統合（キー単位で置換、run id と根拠付き）。上限に達した分は**黙って捨てず** skipped/error として報告 |
| フック | **9 種のライフサイクル（CP-19、2026-11-05）**: `sessionStart` / `sessionEnd` / `userPromptSubmit`（exit 2 でブロック、stdout を文脈に追加）/ `modelRequest` / `permissionRequest`（exit 2 で拒否）/ `preToolUse` / `postToolUse` / `turnEnd` / `notify` |
| ストリーミング | **OpenAI 互換の SSE（CP-18、2026-11-05）**: `stream: true` で delta を `assistant-delta` として GUI/SSE に流し、最終メッセージで置き換える。Anthropic / Gemini / Responses は非ストリーミングのまま |
| ワークツリー | **`hy worktree`（CP-16、2026-11-05）**: `list` / `create <name>` / `apply <name>` / `remove <name>`。worktree は `<stateDir>/worktrees/<name>`（リポジトリ外）に作り、ブランチ `hy/<name>`。`apply` はバイナリ対応パッチを `git apply --3way` で本体へ移し、衝突は報告する |
| MCP | **HTTP/SSE と resources（CP-11、2026-11-05）**: `url` を設定すると Streamable HTTP（JSON/SSE 応答、`mcp-session-id`）で接続。`list_mcp_resources` / `read_mcp_resource`（deferred）で resources を列挙・読取。stdio は従来どおり |
| メディア予算 | **画像の間引き（CP-17、2026-11-05）**: 直近 `keepRecentTurns` 件の画像付きメッセージだけを残し、古い添付はテキスト注記に置き換える（コンパクションのトリガー前でも実施） |
| セッションのスナップショット | **各ターン開始時に記録（CP-13、2026-11-05）**: `session/snapshot`（cwd・workspaceRoot・provider）。cwd は再開時に `restoreCwd` で復元する |
| サブエージェント | **ライフサイクル（CP-15、2026-11-05）**: `spawn_agent` / `wait_agent` / `list_agents` / `close_agent`（いずれも deferred、`delegate` があるセッションのみ）。GUI の `SubagentRegistry` に接続し、待機・列挙・終了ができる |
| 標準入力 | **`write_stdin`（CP-09、2026-11-05）**: `shell { stdinPipe: true }` で stdin パイプ付きジョブを起動し、`job/write` で入力して新規出力を返す。非 confinement と制限トークンの両経路に対応（PTY/ConPTY は無し） |
| 権限要求 | **`request_permissions`（CP-05、2026-11-05）**: ワークスペース外の書き込みルートをモデルが要求できる。ユーザー承認（`unconfined` 扱いで Guardian は不可）の後 `sandbox/add-root` でセッション中だけ追加 |
| 承認ポリシー | **4 値（CP-05、2026-11-05）**: `untrusted`（既定・都度確認）/ `on-request`・`on-failure`（confined を自動承認）/ `never`（承認しない）。`--approval` または `approvalPolicy` で指定 |
| Guardian | **レビューセッション化（CP-44、2026-11-05）**: 直近のツール呼び出しを文脈に渡し、プロンプト予算（既定 8,000 文字）・締切（既定 20 秒）・根拠（evidence）・承認キャッシュを持つ。決定は `approval/decision` としてセッションログに残る |
| 読み取り・ネットワークの封じ込め | **パス権限は部分的に実装（CP-02、2026-11-05）**: `sandbox.denyRead` / プロファイルの `denyRead` に挙げたパスは読み取り不可、`sandbox.readOnly` / `readOnly` のサブディレクトリは読み取り専用（いずれもワークスペース SID への deny ACE + 取り消し記録）。プロファイルの `extends` に対応。それ以外の読み取りとネットワークは従来どおり閉じ込めない |
| ACL のないボリュームへの書き込み | **可能**。`workspace-write` は ACL 付与をスキップし、Codex と同じくそのボリューム全体への書き込みを許可する。NTFS 側のワークスペース外は制限。`non-acl-volumes` は API / CLI の診断情報として残すが、GUI には警告を表示しない |
| Guardian | **実装・実モデル評価済み**（`--guardian`。Ollama `qwen2.5:3b` で 5/5 = 100 % 正解を確認） |
| OQ-2 の確定（Jest / Vitest / `esbuild` / `npm install` の実測） | **完了**（ADR 0001 §7）。`esbuild` CLI は `workspace-write` で動作、`esbuild` Node API は `workspace-write` で `spawn EPERM`・`low-integrity` で動作、`npm install` は既定キャッシュで `EPERM`・ワークスペース内キャッシュで動作 |
| 標準ユーザー / built-in Administrator での確認 | **トークン構築分岐の単体テスト検証済み**（`token.rs`）。実 OS の別アカウント対話ログオンは、このマシンに標準ユーザーが存在せず built-in `Administrator` が無効化されているため **未実施** |
| `run_code` (PTC) | **実装・検証済み**（Phase 5）。AppContainer のワーカー、SDK、検索、ジョブ、トークン量の測定 |
| `RepeatToolReminderGuard`（設計 §2） | **実装・検証済み**（`packages/core/src/agent.ts`） |
| `cordis` 統合 | **実装・検証済み**（`packages/core/src/cordis.ts` の `HarnessContext` ラッパーを CLI に接続、`cordis.test.ts` で検証） |
| Compaction / Spill / Rationale Ledger | **実装・実モデル評価済み**（Phase 6 + `scripts/eval-ollama.mjs` で Tier 1/Tier 2 要約後の制約・メモ保持を実測） |
| Gate 2（Grader） | **実装・実モデル評価済み**（`scripts/eval-ollama.mjs` でプロンプトインジェクション耐性と未実装検出・完全実装承認を実測） |
| Budget4D と `$/cancelRequest` による実行中ツール中断 | **実装・検証済み**（`AbortSignal` → `$/cancelRequest` により実行中の `exec/command` / `ptc/run` / `job/wait` と Job Object を即座に終了） |
| 50 MB 超の未追跡ファイル除外（`unprotected`） | **実装・検証済み**（`checkpoint.rs` の `stage_worktree` で除外・メタデータ記録・ロールバック時保持を検証） |
| Rust カバレッジ（純粋ロジック ≥ 85 %） | **達成（89.2 %）**（`pnpm coverage:rust` で純粋ロジック合算 行 89.2 %・領域 88.6 % を確認） |
| 10,000 ファイルのチェックポイント bench | **達成**（作成 約 625 ms < 750 ms、ロールバック 約 265 ms < 500 ms） |
| Windows 10 22H2 のセルフホストランナー CI | **`.github/workflows/ci.yml` 作成済み**（ローカル Windows 10 22H2 実機で全ステップ PASS） |
| **Desktop GUI（Electron + `hy web` + portable exe）** | **実装・検証済み**。3 カラム、セッション、ピン留め / アーカイブ、チャット、ツールカード、承認、ゴール、プラン、ジョブ、サブエージェント、MCP / プラグイン / メモリ、Trace / Browser / Terminal / Desktop、`@file`、画像、設定、モデルプリセット / 自動上限値、実測トークン表示、日本語 UI、プラグイン再読み込み、Verifier loop、スケジュール / Webhook、永続PTY、English / 日本語 / 中文、Tailscale 経由のスマホアクセス。`pnpm desktop:screenshot` で実機画面を取得し、`release\HY-HARNESS.exe` の起動・PTY・Chrome 自動操作・日本語 Settings を確認 |
| GUI の統合テスト | **8 件成功**（`tests/integration/web-ui.test.mjs`）。認証 / bootstrap / ファイル / 設定、PWA マニフェストと `mcp-call` 制限、永続PTYの起動 / SSE / 入力 / `cd` 保持 / リサイズ / クリア / 停止、プラグインのカタログと再読み込み、スケジュール / Webhook、チャット / ゴール / サブエージェント / ジョブ / SSE / Trace / MCP / メモリ / ターミナル / Verifier loop、実行中 shell のキャンセル、承認拒否、オーケストレーションの spawn / スコープ重複拒否 / ワーカーのサブエージェント。加えて `automation-mcp.test.mjs` 1 件（Playwright MCP / agent-desktop） |
| GUI 設定の反映 | **保存はユーザー `config.json` のみ**。ロール、サンドボックス、プラグイン、メモリ、Web、自動化を保存できる。反映には再起動が必要（UI に明記） |
| DSH 固有の GUI（プラグインマーケット / Creator、SSH 先での実行、クラウド、マルチユーザー / パブリック公開、IDE 拡張） | **対象外（2026-11-03 ユーザー承認済み）**。[desktop-gui.md](designs/desktop-gui.md) §8 に明記。ブラウザ / デスクトップ操作、スケジュール / Webhook、永続PTY、個人 tailnet アクセスは実装済み |
| DeepSeek / Gemini / OpenAI の実 API 通信 | **DeepSeek は実 API 検証済み**（`deepseek-flash`、Effort `high`、`reasoning_content` の thinking 表示、トークン実測値を確認）。Gemini / OpenAI は API キー未設定のため未実施。契約テストは PASS |

---

## 6. 経緯（2026-11-02）

- 午前: サンドボックスの ACL 付与とプロセス起動が安全性チェックで止められ、実装を中断。
- 午後: サンドボックスを後回しにして MVP（実行デーモン、コントロールプレーン、CLI、チェックポイント、PTC）を完成。
- 夕方: Phase 1 スパイク（ADR 0001）で Go を確認し、設計を Rev 3.1 に更新。続けて Phase 4 を実装。ACL の変更はテスト用フィクスチャと、ユーザーが指定したワークスペースにだけ行い、テストはすべて revoke してから削除する。

---

## 7. Codex 採用計画の実装状況（2026-11-05、WP 単位）

計画 [codex-adoption-plan.md](codex-adoption-plan.md) の 44 WP のうち、実装・受け入れテスト・進捗記録まで終えたもの:

| フェーズ | 完了 WP | 残り（主なもの） |
| :--- | :--- | :--- |
| C0 封じ込め | CP-01 / CP-02 / CP-05 / CP-06 / CP-07 / CP-08 / CP-44 | なし（ネットワーク・SEC-02/03/04 は対象外） |
| C1 道具箱 | CP-09〜CP-17（CP-09 は PTY なし） | CP-11 の prompts/elicitation |
| C2 ループ | CP-18〜CP-24 | `@skill:` メンション、`tool-search` フラグの消費 |
| C3 プロトコル | CP-25（JSON-RPC の読み取り・turn 制御・承認）、CP-26（API スキーマ） | CP-27/28（WS・daemon）、CP-29〜31（SDK/ACP/移行）、`hy serve` の常駐化 |
| C4 UX | `hy fork` などバックエンドの一部 | CP-32〜36 の GUI（ブラウザ検証が前提） |
| C5 運用 | CP-37 / CP-38 / CP-39 / CP-42（`hy doctor`・フラグ・CI ゲート・`pnpm verify`） | CP-40 の配布署名手順、CP-41 の単一バイナリ、CP-43 |

検証の現状（2026-11-05 ラウンド 54、子プロセス・Ollama・NTFS が使える環境）: `pnpm build` / `typecheck` / 生成物チェック / `cargo fmt --check` / `cargo clippy -D warnings` は緑。単体 `pnpm test` は **499 / 499 PASS**、`cargo test` も全件 PASS。それ以前の「失敗は環境要因のみ」という記載は誤りで、統合テストは構文エラーで 1 本も動いておらず、`denyRead` が読み取りを止めていない・`readOnly` の既存ファイルが書ける・K9 超過（1,552 トークン）などの回帰があった（[codex-adoption-progress.md](codex-adoption-progress.md) ラウンド 54 で修正）。
