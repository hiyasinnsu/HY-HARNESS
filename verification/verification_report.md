# HY-HARNESS design_draft_rev3 / refinement_notes の一次ソース裏取り

- 照合日: 2026-11-02
- 生成: `python -I tools/verify.py . --report verification_report.md`（すべての抜き書きが引用行で原文と一致した場合だけ生成される）
- 判定の内訳: 確認 23 件、推論 5 件、実測 4 件、修正 4 件

| 判定 | 意味 |
| :--- | :--- |
| 確認 | 一次ソースの記述で裏付けられた |
| 実測 | ローカル実験（experiments/）で裏付けられた |
| 修正 | 裏取りの結果、Rev 3 の記述を訂正した |
| 推論 | 直接の記述はなく設計上の推論。指定のフェーズ／スパイクで実測する |

## R-1a【確認】

Rev 2 では子シェルが書けるのは .hy-harness/tmp のみ。一方 DSH の workspace-write はワークスペース配下への書き込みを許す

- `../design_draft.md:186` — “child shell processes receive write DACL + Low Mandatory Integrity ACE only on `.hy-harness/tmp`”
- `sources/dsh_note_sandbox_win.txt:9` — “`workspace-write` (writes under the workspace root plus a backend-defined temp area)”

## R-1b【確認】

ハードリンクは全リンクで同じ実体を共有し、pnpm は node_modules をストアからハードリンクする。全ハードリンク拒否は pnpm を壊す

- `sources/ms_hardlinks.txt:17` — “Any changes made to a hard-linked file are instantly visible to applications that access it through the links that reference it.”
- `sources/pnpm_motivation.txt:38` — “All remaining dependencies are fetched and hard linked from the store to `node_modules`.”
- `sources/dsh_note_sandbox_win.txt:13` — “because NTFS ACLs belong to file objects, a granted workspace hard link still grants an external alias…Rejecting all hard links would reject ordinary pnpm workspaces”

## R-1c【推論】

ハードリンク（nNumberOfLinks>1）に ACE を付けずにスキップすれば別名経由の越境を防げる。所要時間は Phase 1 S-1 で実測

- `sources/dsh_note_sandbox_win.txt:43` — “EAGER full-tree workspace propagation (`SetNamedSecurityInfoW` walks every descendant immediately — tens of seconds on large workspaces), paid once per workspace per machine”

## R-2a【確認】

0xC0000142 は制限 SID に logon SID と Everyone を残すことで回避される。CREATE_NO_WINDOW / CREATE_NEW_CONSOLE の子は落ちる。Rev 2 は WinSta0/デスクトップ DACL で解決するとしていた

- `sources/dsh_note_sandbox_win.txt:13` — “Logon SID + Everyone are keep-alive invariants (early DLL init dies with 0xC0000142 and CNG crashes pwsh with 0xE0434352 without them)”
- `sources/dsh_note_sandbox_win.txt:43` — “children created with `CREATE_NO_WINDOW` or `CREATE_NEW_CONSOLE` die with `STATUS_DLL_INIT_FAILED`”
- `../design_draft.md:185` — “grants `WINSTA_READATTRIBUTES | WINSTA_ACCESSGLOBALATOMS` on `WinSta0`”

## R-2b【確認】

libuv の EPERM の原因: libuv は既定 SD（Everyone は読み取りのみ）で名前付きパイプを作り、書き込み権限付きで名前で開き直す。WRITE_RESTRICTED では書き込み判定に制限 SID も必要なので拒否される。親側のパイプ DACL では直せない

- `sources/libuv_pipe.txt:248` — “pipeHandle = CreateNamedPipeA(name,…PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT, 1, 65536, 65536, 0,…NULL);”
- `sources/libuv_pipe.txt:310` — “client_access |= GENERIC_WRITE;”
- `sources/libuv_pipe.txt:329` — “client_pipe = CreateFileA(pipe_name,”
- `sources/ms_createnamedpipe.txt:121` — “The ACLs in the default security descriptor for a named pipe grant full control to the LocalSystem account, administrators, and the creator owner. They also grant read access to members of the Everyone group and the anonymous account.”
- `sources/ms_createrestrictedtoken.txt:50` — “The new token contains restricting SIDs that are considered only when evaluating write access.”
- `sources/ms_restricted_tokens.txt:18` — “Access is granted only if both access checks allow the requested access rights.”
- `sources/dsh_note_sandbox_win.txt:13` — “named pipes keep the Win32 layer's owner/SYSTEM/Admins-full, Everyone/ANONYMOUS-read-only template, so piped grandchild stdio remains denied”

## R-2c【推論】

Jest（既定 child_process）と Vitest（既定 pool=forks）は Windows で名前付きパイプの IPC を使うので影響を受ける見込み。Rust std の子プロセス stdio は別経路（NtCreateNamedPipeFile + 相対オープン）なので cargo は影響を受けない可能性がある。S-2 で実測

- `sources/jest_worker.txt:71` — “By default, `jest-worker` will use `child_process` threads to spawn new Node.js processes.”
- `sources/vitest_config_pool.txt:12` — “- **Default:** `'forks'`”
- `sources/node_net.txt:216` — “The node:netmodule supports IPC with named pipes on Windows”
- `sources/libuv_process_stdio.txt:248` — “err = uv__create_stdio_pipe_pair(loop,”
- `sources/rust_std_child_pipe.txt:64` — “Note that we specifically do *not* use `CreatePipe` here because…Instead, we use `NtCreateNamedPipeFile` to create the”

## R-3【確認】

親ディレクトリの FILE_DELETE_CHILD は制限 SID の同意なしに子の削除を許すため、Low ラベルと Everyone への FILE_DELETE_CHILD 拒否が必要

- `sources/ms_file_access_rights.txt:33` — “For a directory, the right to delete a directory and all the files it contains, including read-only files.”
- `sources/dsh_note_sandbox_win.txt:13` — “which no restricting SID has to co-sign, so `cmd /c del` deleted files outside the workspace wherever the caller's ambient SIDs hold Modify”
- `sources/dsh_note_sandbox_win.txt:13` — “each grant also DENIES `FILE_DELETE_CHILD` to the world SID”
- `sources/ms_mic.txt:15` — “a principal with a low integrity level cannot write to an object with a medium integrity level”

## R-4a【実測】

git add -u は既存の未追跡ファイルを捕捉できない。一時インデックスでの add -A は捕捉できる

- `experiments/git_checkpoint.log:2` — “[E2] add -u captures .env.local: 0”
- `experiments/git_checkpoint.log:3` — “[E2] add -A captures .env.local: 1”

## R-4b【実測】

Rev 2 のロールバック（本物のインデックスへの read-tree + checkout-index -f -a）は、未追跡ファイルを戻せず、無関係なファイルの mtime を変え、未ステージの変更をステージ済みにしてしまう

- `experiments/git_checkpoint.log:4` — “[E3] rev2: .env.local restored: no”
- `experiments/git_checkpoint.log:5` — “[E3] rev2: f10 mtime changed: yes”
- `experiments/git_checkpoint.log:7` — “[E3] rev2: f2 unstaged change became staged: yes”
- `sources/git_checkout_index.txt:152` — “forces overwrite of existing files”
- `sources/cargo_fingerprint.txt:24` — “Filesystem mtime tracking is also used to check if a unit is dirty.”

## R-4c【実測】

Rev 3 のロールバック（diff-tree + 変更パスだけ checkout-index + ユーザーのインデックス復元）は、全項目を復元し、無関係なファイル・HEAD・ステージ状態を保つ

- `experiments/git_checkpoint.log:8` — “[E4] diff-tree changes: M .env.local;M f3.txt;A new.txt;”
- `experiments/git_checkpoint.log:9` — “[E4] .env.local restored: yes…[E4] f3 restored: yes…[E4] new.txt deleted: yes…[E4] f10 mtime unchanged: yes…[E4] node_modules untouched: yes…[E4] user staged f1 preserved: yes…[E4] f2 still unstaged: yes…[E4] HEAD unchanged: yes”

## R-4d【実測】

commit-tree は作成者情報が未設定だと失敗する

- `experiments/git_checkpoint.log:1` — “[E1] commit-tree failed without identity: Author identity unknown”
- `sources/git_commit_tree.txt:184` — “author name, email and date…committer name and email and the commit time.”

## R-4e【修正】

GIT_ATTR_SOURCE + core.autocrlf=false でバイト単位で同一に保存される（実測）。ただし --attr-source が入ったのは Git 2.41 で、Rev 3 の『≥ 2.40』は誤り → ≥ 2.41 に訂正

- `experiments/git_checkpoint.log:16` — “[E5] default config stores raw bytes: no”
- `experiments/git_checkpoint.log:17` — “[E5] GIT_ATTR_SOURCE+autocrlf=false stores raw bytes: yes”
- `sources/git_main.txt:313` — “Read gitattributes from <tree-ish>instead of the worktree. See gitattributes[5]. This is equivalent to setting the GIT_ATTR_SOURCEenvironment variable.”
- `sources/git_relnotes_2_41.txt:119` — “"git --attr-source=<tree> cmd $args" is a new way to have any”

## R-4f【推論】

checkout-index -f -a は 10,000 ファイルで 500 ms を超える。Phase 8 の bench:checkpoint で実測

- 直接の一次ソースなし（推論。検証フェーズで実測する）

## R-5【確認】

Rev 2 ではリポジトリ内の .hy-harness/config.json で baseUrl と apiKeyEnv を指定できた（API キー流出の経路）

- `../design_draft.md:108` — “Configuration is resolved in precedence order: CLI flags > environment variables > `.hy-harness/config.json` > built-in defaults.”
- `../design_draft.md:114` — “apiKeyEnv?: string;…baseUrl?: string;”

## R-6【確認】

Rev 2 の Grader は、モデルが更新できる Rationale Ledger を判定材料として受け取る

- `../design_draft.md:29` — “Provide a model-updatable Capped Rationale Ledger”
- `../design_draft.md:195` — “Invokes the `grader` role model in a read-only context with the original Objective, active `Rationale Ledger`”

## M-1【確認】

Rev 2 の bash ツールはシェルを定義していない。DSH は同じトークン形状で pwsh executor を使う

- `../design_draft.md:166` — “`bash({ command: string, cwd?: string, timeoutMs?: number })”
- `sources/dsh_note_sandbox_win.txt:51` — “The [pwsh executor decision](../../archived/feature/2026-08-01-pwsh-tool-and-executor.md) owns the pwsh-sandbox/tool-pwsh dialect split this rung consumes.”

## M-2【確認】

複合判定の文字集合が §3 とリスク表で食い違う。cmd の ^ や %、PowerShell の --% や @ も特殊文字。.bat の引数エスケープは Rust 1.77.2 で修正された

- `../design_draft.md:181` — “(`&`, `|`, `;`, `` ` ``, `$(`, `>`, `<`)”
- `../design_draft.md:234` — “any command string containing `[&|;`$()<>]`”
- `sources/ms_cmd.txt:103` — “The ampersand &, pipe |, and parentheses ( )are special characters that must be preceded by the escape character ^or quotation marks”
- `sources/ps_about_parsing.txt:200` — “The only interpretation it performs is to substitute values for environment variables that use standard Windows notation, such as %USERPROFILE%.”
- `sources/ps_about_splatting.txt:17` — “Splatting is a method of passing a collection of parameter values to a command as a unit.”
- `sources/rust_cve_2024_24576.txt:15` — “The fix will be included in Rust 1.77.2”

## M-4【確認】

Rev 2 はツール呼び出しなしの応答をすべて完了宣言とみなす

- `../design_draft.md:193` — “signals `claim_complete` either by finishing a turn with zero tool calls”

## M-5【確認】

Rev 2 の Ledger は上限超過時に最も古いエントリを黙って削除する

- `../design_draft.md:159` — “the entry with the lowest `updatedAtStep` (`least-recently-updated`) is evicted from the active map”

## M-6【確認】

append-only なのに『イベントを破棄』と書いている。tool/call が二重。Gemini は thought signature の、DeepSeek は tools 使用時に reasoning_content の返送が必要

- `../design_draft.md:63` — “discards Round 1's uncommitted session events”
- `../design_draft.md:152` — “"tool/call": { callId: string; name: string; args: unknown; stepIndex: number };”
- `sources/gemini_thinking.txt:725` — “Thought signatures are encrypted representations of the model's internal reasoning. They are required to maintain reasoning continuity across multi-turn interactions.”
- `sources/deepseek_thinking.txt:54` — “If the request carries the toolsparameter: the reasoning_contentof all previous turns should be passed back to the API”

## M-7【確認】

Rev 2 の不変条件は『⟺』

- `../design_draft.md:81` — “'Model-visible ⟺ logged'”

## M-8【修正】

【訂正】Rev 3 の『bytes/4 は日本語で 1.5〜2 倍少なく見積もる』は一次ソースで裏付けられない。DeepSeek の公式比では、英語は少なめ（0.25 vs 0.3）、中国語は多め（3 byte/4 = 0.75 vs 0.6）に見積もる。偏りはプロバイダーごとに違うので、プロバイダー別の係数に改める

- `sources/deepseek_token_usage.txt:13` — “1 English character ≈ 0.3 token.…1 Chinese character ≈ 0.6 token.…The actual number of tokens processed each time is based on the model's return”
- `sources/gemini_tokens.txt:36` — “For Gemini models, a token is equivalent to about 4 characters.”
- `../design_draft.md:135` — “estimateTokens(text) = Math.ceil(Buffer.byteLength(text, "utf8") / 4)”

## M-9【確認】

Rev 2 のロール設定にはコンテキスト窓も単価もないが、75% という基準はコンテキスト窓に対する比率

- `../design_draft.md:113` — “model: string;…apiKeyEnv?: string;…baseUrl?: string;”
- `../design_draft.md:124` — “compactionTriggerRatio: number;// default: 0.75 (75% of model context window)”

## M-10【確認】

Rev 2 の RPC メソッドにキャンセルがない。-32001〜-32006 は JSON-RPC が実装定義サーバーエラー用に予約した範囲に収まる

- `../design_draft.md:177` — “Methods: `exec/command`, `job/status`, `job/wait`, `job/kill`, `patch/apply`, `checkpoint/create`, `checkpoint/rollback`, `policy/evaluate`, `ptc/run`.”
- `sources/jsonrpc_spec.txt:120` — “-32000 to -32099”

## M-11a【確認】

ReplaceFileW は置き換え先の ACL を保持し、置き換え先に DELETE と書き込み権限を要する（→ ACE を付けていないハードリンクファイルは、偽装した書き込みスレッドからは置き換えられない）

- `sources/ms_replacefile.txt:37` — “The function attempts to open this file with the SYNCHRONIZE, GENERIC_READ, GENERIC_WRITE, DELETE, and WRITE_DACaccess rights so that it can preserve all attributes and ACLs.”

## M-11b【推論】

ReplaceFileW で置き換えるとハードリンクは切り離され、外部の別名は元の内容を保つ（直接の記述なし。Phase 2 のテストで実測）。偽装時のアクセス判定はスレッドのトークンで行われる

- `sources/ms_setthreadtoken.txt:14` — “The SetThreadTokenfunction assigns an impersonation tokento a thread.”
- `sources/ms_client_impersonation.txt:14` — “Impersonationis the ability of a thread to execute using different security information than the process that owns the thread.”

## M-13【確認】

Rev 2 は環境変数を除外リスト方式で取り除く

- `../design_draft.md:184` — “Strips sensitive host environment variables (`*_API_KEY`, `*_TOKEN`, `*_SECRET`, `AWS_*`, `GITHUB_TOKEN`)”

## M-14【確認】

--allow-net は v25.0.0 で追加された。v24 の --permission はネットワークを制限しない。Node 自身が『seat belt』で悪意あるコードへの保証はないとしている。Node 26 は Active LTS。stripTypeScriptTypes は RC

- `sources/node_cli.txt:502` — “--allow-net#…Added in: v25.0.0”
- `sources/node_permissions_v24.txt:106` — “When starting Node.js with --permission, the ability to access the file system through the fsmodule, spawn processes, use node:worker_threads, use native addons, use WASI, and enable the runtime inspector will be restricted.”
- `sources/node_permissions.txt:92` — “It does not provide security guarantees in the presence of malicious code.”
- `sources/node_release.txt:12` — “| [26.x][] | **Active LTS**      | [Lithium][]  | 2026-05-05     | 2026-10-28”
- `sources/node_module.txt:250` — “Added in: v23.2.0, v22.13.0History…Stability: 1.2 - Release candidate”

## M-18【確認】

GitHub ホスト型の Windows ランナーは Server 2022/2025 と Windows 11 Arm だけで、Windows 10 はない

- `sources/gh_runner_images.txt:40` — “| Windows Server 2025<br>”
- `sources/gh_runner_images.txt:41` — “| Windows Server 2022<br>”
- `sources/gh_runner_images.txt:42` — “| Windows 11 Arm64<br>”

## M-19【確認】

ワークスペースに付けた ACE は常駐する変更として残る（後始末が必要）

- `sources/dsh_note_sandbox_win.txt:43` — “standing workspace security-descriptor mutations (the reuse cache, plus inert residue when a workspace is renamed)”

## W-1【確認】

CreateProcessAsUserW: 呼び出し元のトークンを制限したものなら SE_ASSIGNPRIMARYTOKEN は不要。JOB_LIST は Windows 10 以降、HANDLE_LIST で継承するハンドルを限定できる。SidsToDisable は deny-only

- `sources/ms_createprocessasuser.txt:34` — “If hTokenis a restricted version of the caller's primary token, the SE_ASSIGNPRIMARYTOKEN_NAMEprivilege is not required.”
- `sources/ms_updateprocthreadattribute.txt:79` — “PROC_THREAD_ATTRIBUTE_JOB_LIST…Supported in Windows 10 and newer”
- `sources/ms_updateprocthreadattribute.txt:37` — “PROC_THREAD_ATTRIBUTE_HANDLE_LIST…a pointer to a list of handles to be inherited by the child process.”
- `sources/ms_createrestrictedtoken.txt:56` — “specify the deny-only SIDs in the restricted token”

## W-2【確認】

LUA_TOKEN を付けるとビルトイン Administrator がプロセスを起動できない。MXC は Windows 11 24H2 以降。AppContainer には既定の読み取り権限がない

- `sources/dsh_note_sandbox_win.txt:57` — “with that flag, the built-in Administrator user cannot start any process”
- `sources/dsh_note_sandbox_win.txt:31` — “sets the product floor at Windows 11 24H2 (build 26100)”
- `sources/dsh_note_sandbox_win.txt:35` — “An AppContainer token carries no ambient read access”

## W-3【確認】

ConPTY は Windows 10 1809 以降。Windows 10 のサポートは 2025-10-14 に終了

- `sources/ms_createpseudoconsole.txt:54` — “Windows 10 October 2018 Update (version 1809)”
- `sources/ms_win10_lifecycle.txt:10` — “Windows 10 will reach end of support on October 14, 2025.”

## W-4【修正】

【改善】ファイルシステムの判定は名前の比較ではなく FILE_PERSISTENT_ACLS フラグで行うべき。exFAT と FAT32 は ACL もハードリンクも持たない。F: は exFAT、G: は FAT32 と表示されることを実測で確認

- `sources/ms_getvolumeinformation.txt:61` — “The specified volume preserves and enforces access control lists (ACL). For example, the NTFS file system preserves and enforces ACLs, and the FAT file system does not.”
- `sources/ms_fs_comparison.txt:60` — “Hard links…Yes…No…Yes…No”
- `sources/ms_fs_comparison.txt:178` — “Access control lists…Yes…No…No…No”
- `experiments/fs_probe.log:1` — “fsutil hardlink: Error: Incorrect function.”
- `experiments/fs_probe.log:4` — “fsinfo F: File System Name : exFAT”
- `experiments/fs_probe.log:8` — “File System Name : FAT32”

## W-5【修正】

【注記】cordis の npm 上の latest タグは 4.0.0-rc.12（RC）。『正確なバージョンで固定』は RC に依存することになる点を明記する

- `sources/cordis_npm.txt:4` — “cordis-4.0.0-rc.12.tgz”

## U-1【推論】

未検証のまま残る設計判断: ポリシーは境界ではない（M-3）、ReadBeforeEdit のハッシュ化（M-12）、予算のクランプ（M-15）、改ざんチェック（M-16）、フェーズの並べ替え（M-17）、.git への拒否 ACE（R-3 の後半）。いずれも一次ソースの事実ではなく設計判断なので、各フェーズの終了条件テストで検証する

- 直接の一次ソースなし（推論。検証フェーズで実測する）

