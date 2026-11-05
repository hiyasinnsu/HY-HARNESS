# ADR 0001: Windows サンドボックス（Phase 1 実現性スパイクの結果）

- **状態**: 承認（Accepted、2026-11-02）。§6 の設計変更案 A〜F はユーザーがすべて承認し、設計書 Rev 3.1 と実装計画 v3.1 に反映した
- **日付**: 2026-11-02
- **対象**: [design_draft_rev3.md](../../design_draft_rev3.md) §4.2 / §4.4、Phase 1（S-1〜S-6）、OQ-1、OQ-2
- **スパイク**: [`spikes/win-sandbox/`](../../spikes/win-sandbox/)（使い捨て）。`hy-sandbox-windows` の下書き（`token.rs`、`sid.rs`、`fs.rs`、`console.rs`、`util.rs`）を `#[path]` でそのまま取り込み、下書き自体も検証した
- **生データ**: [`spikes/win-sandbox/results/results.json`](../../spikes/win-sandbox/results/results.json)、OQ-2 の実測は [`results/oq2.json`](../../spikes/win-sandbox/results/oq2.json)（`spikes/win-sandbox/oq2_measure.mjs`、2026-11-02 追記）および [`results/oq2-esbuild-npm.json`](../../spikes/win-sandbox/results/oq2-esbuild-npm.json)（`spikes/win-sandbox/oq2_esbuild_npm.mjs`、2026-11-03 追記）
- **再現**: `cargo build --offline --release`（`spikes/win-sandbox`）→ `python -I run_matrix.py all`

---

## 1. 結論

**Go。** `workspace-write`（§4.2 のトークン構成）で `cargo build`、`cargo test`、`tsc`、`npm test`（子プロセスを pipe で起動しないスクリプト）、`git status`、Windows PowerShell 5.1、`cmd` が動いた。Phase 1 の終了条件（「`cargo build` と `tsc` が動かなければアーキテクチャを見直す」）を満たす。

書き込みの封じ込めは、外部、別の付与ルート、`.git`、`.hy-harness`、ハードリンク、ジャンクション、ユーザープロファイル、HKCU のすべてで期待どおりだった（S-3）。パッチャーの偽装トークンは、ジャンクションを高速に差し替える競合下でも外への書き込みを 0 件に抑えた（S-6）。

ただし、設計の前提を崩す発見が 3 つあり、Phase 4 の前に設計の修正が必要（§5、§6）。

1. **付与後に作られた `.git` はサンドボックスから書ける**（ルートの継承 ACE と Low ラベルを引き継ぐ）。`.git/config` に `core.fsmonitor` などを書かれると、ハーネスが git を実行したときに封じ込めの外でコードが走る。
2. **Low 整合性のトークンは、パッケージ SID の ACE を持つディレクトリを開けない**。このマシンでは `%USERPROFILE%\AppData` と `AppData\Local` が該当し、`%TEMP%` 配下では Node のスクリプト実行（`realpath`）が失敗した。
3. **ACL のないボリューム（exFAT/FAT32: このマシンの `F:`、`G:`）にはサンドボックスから自由に書ける**。

## 2. 環境

| 項目 | 値 |
| :--- | :--- |
| OS | Windows 10 22H2（10.0.19045.6466） |
| アカウント | UAC で権限を落とした管理者（`BUILTIN\Administrators` は deny-only、Medium） |
| フィクスチャ | `%USERPROFILE%\hy-spike-fixture`（C:、NTFS）。`%TEMP%` は §5.2 の理由で不可 |
| Defender | リアルタイム保護 有効 |
| ツール | Node 24.19.0、npm 11.17.0、TypeScript 6.0.3（F: から読み込み）、Rust（rustup の cargo）、Git 2.50.1、Windows PowerShell 5.1、Git Bash（Git for Windows 同梱） |
| 未導入 | pwsh 7、Jest、Vitest（オフラインのため導入せず。§7） |

その他: このマシンの `%TEMP%` には OpenAI Codex の Windows サンドボックスが付けた ACE（`CodexSandboxUsers` と `S-1-5-21-…-2104364734` に Modify）が残っている。HY-HARNESS の制限 SID ではないので結果には影響しない。

## 3. トークンと付与（スパイクで実装したもの）

- **トークン**: 下書き `token.rs` の `create_confined` をそのまま使用。`CreateRestrictedToken(DISABLE_MAX_PRIVILEGE | WRITE_RESTRICTED)`、Administrators を deny-only、制限 SID は `ro` = [logon, Everyone]、`ww` = [logon, Everyone, workspace SID, temp SID]、整合性 Low、既定 DACL = [user, SYSTEM, logon, temp]。
- **付与（walker）**: 既存オブジェクトごとに 1 回、`SetKernelObjectSecurity` で明示 ACE を追加する（`SetNamedSecurityInfoW` の自動伝播は使わない）。ディレクトリには capability SID の継承可能な許可 ACE（FILE_ALL_ACCESS）、Everyone への `FILE_DELETE_CHILD` 拒否（CI）、Low の no-write-up ラベル（OI|CI）を付ける。ファイルには継承なしで許可 ACE と Low ラベルを付ける。リパースポイントは辿らず触らない。リンク数が 2 以上のファイルは飛ばす。最上位の `.git` と `.hy-harness` には入らず、capability SID への書き込み・削除の拒否 ACE（OI|CI）を付ける。変更前の DACL とラベルを SDDL で記録し、`revoke` で戻す。
- **起動**: `CreateProcessAsUserW` + `STARTUPINFOEX`（`PROC_THREAD_ATTRIBUTE_JOB_LIST` と `HANDLE_LIST`）。Job は `KILL_ON_JOB_CLOSE`。環境変数は §4.2 item 5 の許可リストで、`TEMP`/`TMP` は付与済みの専用 temp。

## 4. 項目別の結果

### S-1 走査時間（10 万ファイルの `node_modules`）

合成した 10 万ファイルのツリー（約 1,560 パッケージ × 64 ファイル、約 4,700 ディレクトリ）。pnpm 形式はワークスペースの外のストアからハードリンクした。C:（NTFS）、Defender 有効。

| 形式 | 操作 | オブジェクト | 変更 | ハードリンクで除外 | 時間 |
| :--- | :--- | ---: | ---: | ---: | ---: |
| npm | 下見（開く + リンク数 + SD 読み取り）、1 スレッド | 104,691 | 0 | 0 | 5.9 s |
| npm | 下見、8 スレッド | 104,691 | 0 | 0 | 1.3 s |
| npm | **付与、8 スレッド** | 104,691 | 104,691 | 0 | **4.4 s**（列挙 0.34 s） |
| npm | 取り消し（1 スレッド、記録の復元 + 監査） | | 104,691 復元 | | 14.9 s |
| pnpm | 下見、8 スレッド | 104,692 | 0 | 100,000 | 1.3 s |
| pnpm | **付与、8 スレッド** | 104,692 | 4,692 | **100,000** | **1.5 s** |
| pnpm | 取り消し | | 4,692 復元 | | 0.5 s |

- 失敗 0 件。付与後に作ったファイルが 1 件、取り消し後も SID を持っていた（§5.4）。
- **ハードリンクの穴は塞がる**（`[V:R-1c]` の推論を実測で確認）: pnpm 形式でハードリンクしたファイルにサンドボックスから書き込むと拒否され、ストアの中身は変わらなかった。ディレクトリには付与されるので、新しいファイルは作れる。
- DSH が報告した「初回に数十秒止まる」は、自前の walker では起きない。10 万ファイルで 5 秒以下なので、設計どおり初回に 1 回走らせ、進捗を表示すればよい。取り消しは並列化していないので遅い（並列化すれば付与と同程度になる見込み）。

### S-2 名前付きパイプの `EPERM` とツールチェーン

**`workspace-write` での可否**（`ro` は書き込みを伴うものが失敗し、それ以外は同じ）:

| コマンド | `ww` | 備考 |
| :--- | :--- | :--- |
| `cmd /c echo` | ✅ | |
| `node -e` / `node script.js` | ✅ | ワークスペースが AppData 配下だと失敗（§5.2） |
| `npm --version`、`npm test`（`node test.js`） | ✅ | npm run-script は stdio を継承するので通る |
| `tsc -p`（出力をワークスペースへ） | ✅ | |
| `cargo build --offline`、`cargo test --offline` | ✅ | AppData 配下では「could not canonicalize path AppData」の警告のみ |
| `git status` | ✅ | |
| `git add -A` | ❌（意図どおり） | `.git/index.lock` を作れない。ワーカーに git の書き込みはさせない設計なので問題なし |
| Windows PowerShell 5.1（`Set-Content` でワークスペースへ） | ✅ | |
| Git Bash（MSYS2） | ❌ `0xC0000142` | `NtCreateDirectoryObject(\BaseNamedObjects\msys-2.0…)` が `0xC0000022`。§S-4 |

**Node の子プロセス**（`ww`/`ro` とも同じ。Node 24.19.0）:

| 呼び出し | 結果 |
| :--- | :--- |
| `spawnSync(…, {stdio:'pipe'})`、`execSync`、`spawn`（非同期 pipe）、`fork`（IPC）、`windowsHide` 付き | ❌ `EPERM` |
| `spawnSync(…, {stdio:'inherit'})`、`{stdio:'ignore'}` | ✅ |
| `worker_threads` | ✅ |

**直るかどうか**（S-2 の「トークンや所有者の調整で直るか」）:

| トークンの変種 | pipe/IPC |
| :--- | :--- |
| 下書きどおり（既定 DACL に logon SID と temp SID） | ❌ |
| 既定 DACL を呼び出し元の元の DACL に戻す | ❌ |
| Low をやめる（Medium のまま） | ❌ |
| 制限 SID に `Users` / `Authenticated Users` を追加 | ❌ |
| Administrators を deny-only にしない | ❌ |
| **制限 SID をなくす（Low のみ）** | ✅ |

原因は **WRITE_RESTRICTED の制限 SID** で、整合性レベルではない。既定 DACL を変えても直らないので、設計の推論（libuv が名前付きパイプを開き直すときの 2 回目のアクセスチェック `[V:R-2b]`）と整合する。トークン側の調整では直らない。

**Low のみのトークン（制限 SID なし）の封じ込め**（S-3 を同じ項目で再実行）: 外部への書き込み・削除、`.git`、`.hy-harness`、ハードリンク、ジャンクション、ユーザープロファイル、HKCU はすべて防いだ。防げなかったのは **別セッションの付与ルート**（Low ラベル付きなので書ける）、**`%USERPROFILE%\AppData\LocalLow`**、`ro` モード（表現できない）の 3 つ。unconfined よりはるかに狭いので、Node のテストランナー用の中間モードとして提案する（§6 案 C）。

### S-3 削除の封じ込めとルートをまたぐ削除

`ww` で 29 項目を試し、28 項目が期待どおりだった。残る 1 項目が §5.1 の穴。

- ✅ 許可: ワークスペース内の作成・削除・改名・ツリーの `mkdir`→`rmdir /s`、専用 temp への書き込み
- ✅ 拒否: 外部への作成・上書き・削除、外部からワークスペースへの移動、ワークスペースから外部への移動、別の付与ルートへの書き込み・削除、`.git` の追記・新規作成・削除・改名、`.hy-harness` の書き込み・改名、外部とハードリンクしたファイルの上書き、ジャンクション経由の書き込み、ジャンクションの差し替え（`rmdir junc`）、`%USERPROFILE%` 直下への書き込み、`HKCU\Software` への書き込み、`LocalLow` への書き込み、`ro` でのワークスペースへの書き込み
- ⚠️ 既知の穴（再確認）: 外部の読み取りは可能
- ⚠️ **新しい穴**: exFAT（`F:`）への書き込みが成功した（§5.3）
- ❌ **新しい穴**: 付与後に作られた `.git` の `config` に追記できた（§5.1）
- 補足: ワークスペース内にあるハードリンク名（`hl.txt`）は削除もできない（ファイル自身にも親にも削除権がない）。pnpm の `node_modules` を作り直す操作（`pnpm install`）は `ww` では失敗するので、インストールは既定ポリシーどおり `prompt` → unconfined で扱う

### S-4 隠しコンソールと ConPTY

| コンソール | `cmd` | `node -e` | `node`（子プロセス表） |
| :--- | :--- | :--- | :--- |
| 継承（設計の既定） | ✅ | ✅ | ✅（pipe は S-2 と同じく `EPERM`） |
| `CREATE_NEW_CONSOLE` + `SW_HIDE` | ✅ | ✅ | ✅ |
| `CREATE_NO_WINDOW` | ✅ | ✅ | ✅ |
| ConPTY | ✅（終了コード 0） | ✅ | ✅ |

- 制限 SID に logon SID と Everyone を入れたトークンでは、`CREATE_NO_WINDOW` でも `0xC0000142` は再現しなかった（DSH の一次ソースの説明と整合）。Git Bash の `0xC0000142` はコンソールではなく、MSYS2 が `\BaseNamedObjects` にディレクトリオブジェクトを作れないことが原因（Low をやめると次は `CreateFileMapping` が拒否される。Low と制限 SID の両方をなくしたときだけ動く）。
- ConPTY はプロセスの起動は成功したが、スパイクでは擬似コンソールを閉じるのが早く出力を取りこぼした（VT の初期化列しか取れなかった）。出力の取り込みは評価していない。**設計どおり、隠しコンソールの継承を既定にする**（実装が単純で、全項目で動いた）。
- 下書き `console.rs` のバグを修正した: `CREATE_NO_WINDOW` で起動されたプロセスはコンソールを持つがウィンドウを持たないので、`GetConsoleWindow() == NULL` は「コンソールなし」を意味しない。`AllocConsole` が `ERROR_ACCESS_DENIED` を返したら既存のコンソールを使う。

### S-5 `hy-ptc-worker` を AppContainer で動かせるか

**動かせる。** 能力（capability）なしの AppContainer で Node 24 のワーカーを起動した結果:

| 項目 | 結果 |
| :--- | :--- |
| 起動 | ✅（条件付き。下記） |
| ワークスペースの読み取り・書き込み | 拒否（`EPERM`） |
| exFAT（`F:`）への書き込み | 拒否（AppContainer は ACL のないボリュームに触れない） |
| ネットワーク（`1.1.1.1:80`） | 拒否（`EACCES`） |
| 子プロセス（`stdio:'ignore'`） | 拒否（`EPERM`）。Job の単一プロセス制限の有無によらない |
| `TEMP` | Windows が `%LOCALAPPDATA%\Packages\<名前>\AC\Temp` に差し替える。プロファイル削除で消える |
| 後始末 | `DeleteAppContainerProfile` 成功 |

条件:
1. **`node --preserve-symlinks --preserve-symlinks-main` が必要。** AppContainer は `C:\` を `lstat` できないので、メインモジュールの `realpath` が失敗する。
2. **ワーカーのファイルは `ALL APPLICATION PACKAGES`（`S-1-15-2-1`）が読めるディレクトリに置く。** exFAT や通常のユーザーディレクトリからは読めない。
3. **pipe を使う `spawnSync` はハングし、自身の `timeout` も効かなかった**（Job のタイムアウトで終了）。ワーカーは stdio の JSON 行だけで通信する設計なので問題ないが、`run_code` のタイムアウトは必ず Job 側で強制する。
4. **環境変数を空にはできない**（Phase 5 の実装時に追記）。`LOCALAPPDATA` がないと AppContainer の `CreateProcess` が `ERROR_ENVVAR_NOT_FOUND`（203）で失敗する。`USERPROFILE` や `TEMP` を足しても直らず、`LOCALAPPDATA` だけで直った。

### S-6 パッチャーの偽装と競合するジャンクション

`ww` トークンの偽装コピー（`DuplicateTokenEx` + `SetThreadToken`）を付けたスレッドで実行した。

| 操作 | 結果 |
| :--- | :--- |
| ワークスペース内への書き込み、`ReplaceFileW`、新規ファイルの `MoveFileExW` | ✅ |
| 外部への書き込み | 拒否 |
| ジャンクション（ワークスペース → 外部）経由の書き込み | 拒否（偽装なしでは成功する。境界はパス検査ではなく OS が強制している） |
| 外部とハードリンクしたファイルの上書き・`ReplaceFileW` | 拒否（設計 §4.4 の意図どおり。`SandboxViolation` として報告する） |
| **競合**: 別スレッドがディレクトリとジャンクションを 201 回差し替える間に書き込み | 成功 5,913 件（すべて実ディレクトリ内）、失敗 1,072 件、**外部に漏れたファイル 0 件** |

## 5. 新しく見つかった問題

### 5.1 付与後に作られた保護ディレクトリはサンドボックスから書ける（重大）

付与時に `.git` がないワークスペースで、付与後に `git init` すると、`.git` はルートの継承可能な許可 ACE と Low ラベルを引き継ぐ。サンドボックスから `.git\config` に追記できた（S-3 `late_git_config_append`）。`core.fsmonitor`、`core.hooksPath`、フックを書かれると、ハーネスがチェックポイントのために git を実行したとき、**封じ込めの外で任意のコードが走る**。`.hy-harness` を付与後に作る場合も同じ（ポリシーと設定を書き換えられる）。

付与時に存在する `.git` は問題ない。中身は ACE を持たず、ラベルもない（Medium）ので書けない。

### 5.2 パッケージ SID の ACE を持つディレクトリは Low トークンから開けない

- 規則（実測）: DACL に、そのオブジェクト自身に適用されるパッケージ形式の SID（`S-1-15-2-` + 7 個のサブ権限）の ACE があると、Low 整合性のトークンは `FILE_READ_ATTRIBUTES` でも開けない（`ERROR_ACCESS_DENIED`）。架空のパッケージ SID でも再現した。`S-1-15-2-1`（ALL APPLICATION PACKAGES）、`S-1-15-3-*`、継承専用（IO）の ACE、その他の SID では起きない。制限 SID の有無には関係なく、**Low をやめると起きない**。
- このマシンでは `%USERPROFILE%\AppData` と `AppData\Local` がこの ACE を持つ（どのアプリが付けたかは未確認）。`AppData\Local\Temp` は辿れるが `realpath` が祖先を `lstat` して失敗するので、`%TEMP%` 配下のワークスペースでは `node script.js` が `EPERM`、cargo は警告を出した。
- 影響: 設計どおりに専用 temp を `%LOCALAPPDATA%` 配下に置くと、Node 系ツールが temp のファイルを `realpath` したときに失敗しうる。ワークスペースが AppData 配下にある場合も同様。

### 5.3 ACL のないボリュームには書ける

exFAT と FAT32 には ACL もラベルもないので、制限トークンでも書ける（`F:\…` への書き込みが成功）。設計 §4.2 item 6 はワークスペースと付与ルートのボリュームしか検査していない。このマシンでは `F:`（ソースツリー）と `G:`（Google ドライブ）が該当する。USB メモリなども同じ。AppContainer（S-5）はこれらにも書けない。

2026-11-03 のユーザー決定により、Codex と同じ挙動を採用した。ワークスペースが ACL 非対応ボリュームにある場合も `workspace-write` を許可し、ACL 付与はスキップする。そのボリューム全体が書き込み可能になるが、NTFS 側のワークスペース外は制限されたまま。API / CLI の `non-acl-volumes` 診断は残し、デスクトップ GUI には警告を表示しない。

### 5.4 revoke は記録の復元だけでは足りない

付与後に作られたファイルは継承した ACE を持ち、ログに載らないので、記録した SDDL を戻しても capability SID が残る（スパイクでは 4 件）。revoke は「記録の復元」に加えて「SID を名指しする ACE と HY-HARNESS が付けたラベルを、ツリー全体から取り除く」走査が要る。

スパイクの walker のバグも 2 件直した: (1) `SE_DACL_AUTO_INHERITED` は `SE_DACL_AUTO_INHERIT_REQ` と一緒に設定しないとカーネルが落とす、(2) ラベルを消すと `S:NO_ACCESS_CONTROL`（null SACL）になる（意味は「ラベルなし」と同じ）。修正後、付与 → 取り消しで SDDL が完全に一致した。

## 6. 設計への変更（2026-11-02 承認、Rev 3.1 に反映）

| # | 案 | 理由 |
| :--- | :--- | :--- |
| A | **保護ディレクトリは付与の前に用意する。** ワークスペースが git リポジトリでなければ、付与の前に `git init`（または `hy run` を拒否）。`.hy-harness` も付与の前に作る。ハーネスが git を実行する前に毎回、`.git` に Low ラベルや capability SID の許可 ACE がないことを確認し、あれば実行を止める。ハーネスの git は常に `-c core.hooksPath=<状態ディレクトリ内の空ディレクトリ> -c core.fsmonitor=false` を付けて実行する | §5.1 |
| B | **専用 temp を AppData の外に置く**（例: `%USERPROFILE%\.hy-harness\tmp\<session>`）。`initialize` で、ワークスペースと各付与ルートの祖先を偽装トークンで `FILE_READ_ATTRIBUTES` で開けるか確認し、開けなければ `workspace-write` を `-32006` で不可にし理由を表示する | §5.2 |
| C | **OQ-2 の拡張: Low のみのモード（`low-integrity`）を追加する。** pipe や IPC で子プロセスを起動するツール（Jest、Vitest、esbuild など）は、ユーザーポリシーで unconfined の代わりにこのモードを指定できる。穴（別セッションの付与ルート、`LocalLow`、読み取り）は `capabilities.gaps` で報告する | §S-2。unconfined よりはるかに狭い |
| D | **ACL のないボリュームを `capabilities.gaps` に載せる。** `initialize` でローカルドライブを列挙し、`FILE_PERSISTENT_ACLS` のないものを「書き込みを封じ込められない」として報告する | §5.3 |
| E | **revoke は SID で走査して取り除く。** 記録の復元は付与前の状態の確認に使う | §5.4 |
| F | **`hy-ptc-worker` は AppContainer で起動する**（設計の「OS サンドボックスなし」を置き換える）。`--preserve-symlinks-main`、`ALL APPLICATION PACKAGES` が読める配置、Job による壁時計タイムアウトと単一プロセス制限を必須にする | §S-5 |

## 7. OQ-1 と OQ-2 への答え

- **OQ-1（Git Bash を提供するか）**: **`workspace-write` では提供しない。** MSYS2 は Low でも制限 SID 付きでも起動しない（`0xC0000142`）。動くのは Low と制限 SID の両方をなくしたとき（実質的に unconfined）だけ。既定のシェルは決定どおり pwsh 7、無ければ Windows PowerShell 5.1（`ww` で動作を確認）。
- **OQ-2（ユーザーポリシーで unconfined にするツールチェーン）**:
  - **実測で失敗**: Node の `child_process` で pipe か IPC を使うもの全般（`spawn`、`exec`、`execSync`、`fork`、`windowsHide` 付き）。
  - **実測（2026-11-02 追記）**: Jest 30.5.2 と Vitest 5.0.5（Vite 8.3.5 / Rolldown 1.2.16）を、Phase 4 の実装（`hy-exec-server`）経由で、テストファイル 4 つのフィクスチャに対して動かした。ユーザーの許可を得て registry.npmjs.org から `%USERPROFILE%\hy-oq2-fixture` に導入し、終了後に revoke して削除した。unconfined ではすべて成功。

  | 実行のしかた | `workspace-write` | `low-integrity` |
  | :--- | :--- | :--- |
  | Jest 既定（`jest --ci`、child_process ワーカー） | ❌ `spawn EPERM` | ✅ |
  | Jest `--maxWorkers=2`（child_process ワーカー） | ❌ `spawn EPERM` | ✅ |
  | Jest `--runInBand` | ✅ | ✅ |
  | Jest `--workerThreads` | ✅ | ✅ |
  | Vitest 既定（`vitest run`、`forks` プール） | ❌ `spawn EPERM`、ワーカーの終了待ちで約 10 秒後に失敗 | ✅ |
  | Vitest `--pool=forks` | ❌ 同上 | ✅ |
  | Vitest `--pool=threads` | ✅ | ✅ |
  | Vitest `--pool=vmThreads` | ✅ | ✅ |
  | `npx vitest run --pool=threads`（`.cmd` をシェル経由で起動） | ✅ | ✅ |
  | `npx vitest run`（既定） | ❌ | — |

    **既定の起動はどちらも `workspace-write` で失敗する。** スレッドで動く設定（Jest の `--runInBand` / `--workerThreads`、Vitest の `--pool=threads` / `vmThreads`）なら `workspace-write` のまま動く。`low-integrity` ではすべて動いた。
  - **追加実測（2026-11-03 追記、`esbuild` 0.25.0 と `npm install`）**: `%USERPROFILE%\hy-oq2-esbuild` にフィクスチャを作成し、`hy-exec-server` 経由で `esbuild`（CLI と Node API）および `npm install`（既定キャッシュとワークスペース内キャッシュ）を実測し、終了後に revoke（52 件復元、2 件除去、失敗 0）して削除した（[`results/oq2-esbuild-npm.json`](../../spikes/win-sandbox/results/oq2-esbuild-npm.json)）。

  | 実行のしかた | `workspace-write` | `low-integrity` | 備考 |
  | :--- | :--- | :--- | :--- |
  | `esbuild` CLI（`@esbuild/win32-x64/esbuild.exe` 直接起動） | ✅（241 ms） | ✅（194 ms） | Go ネイティブバイナリ単体起動のため pipe 子プロセスを作らない |
  | `esbuild` Node API（`esbuild.build()`） | ❌ `spawn EPERM`（61 ms） | ✅（66 ms） | Node から `esbuild.exe --service` を `stdio: 'pipe'` で起動するため `ww` では失敗 |
  | `npm install`（既定キャッシュ `%LOCALAPPDATA%\npm-cache`） | ❌ `npm error code EPERM` | ❌ `npm error code EPERM` | ワークスペース外の `%LOCALAPPDATA%\npm-cache` に書けない／開けない |
  | `npm install --cache <ws>/.npm-cache --prefer-offline` | ✅（1,408 ms） | ✅（1,374 ms） | キャッシュをワークスペース内に向け、lifecycle 子プロセスがない場合は成功 |

  - **WindowStation / Desktop の Low 整合性ラベル（2026-11-03 追記）**: セッションや親プロセスの起動経路によって `GetThreadDesktop(GetCurrentThreadId())` の SACL に明示的な Mandatory Label がない場合、Windows カーネルは Desktop を既定の Medium 整合性として扱うため、Low 整合性の子プロセス（`node.exe`、`powershell.exe`、`whoami.exe` など `user32.dll` を読み込むバイナリ）が `DllMain` で `0xC0000142`（`STATUS_DLL_INIT_FAILED`）で即死する現象を確認した。当初は `console.rs` でユーザーの `WinSta0` と `Default` デスクトップ自体にこのラベルと AppContainer / `RESTRICTED` への書き込み許可を設定していたが、セッション全体に効く副作用で、すべての AppContainer アプリにユーザーのデスクトップへの書き込み（フック、ジャーナル）を許すため撤回した（2026-11-03）。**現在の方式**: confined の子プロセスは専用のウィンドウステーションとデスクトップで起動する（Chromium のサンドボックスと同じ）。ウィンドウステーションを作れない環境（このマシンの現在のログオンでは `CreateWindowStationW` がアクセス拒否）では、現在のウィンドウステーションの中に専用デスクトップ `hy-harness-<pid>` を作る。どちらも DACL（SYSTEM、呼び出し元、ログオン SID、`RESTRICTED`、AppContainer の 2 グループ）と Low ラベルを持つ新しいオブジェクトで、ユーザーのデスクトップは変更しない。作成に失敗した場合、confined の起動は失敗する（フェイルクローズ）。**未確認**: 撤回前のコードがこのログオンセッションの `WinSta0` を書き換えたため、ウィンドウステーション側のラベルが不要であることは、ログオフ後に `win10-sandbox.test.mjs` を再実行して確かめる必要がある。
  - **unconfined にしなくてよい**: `cargo build`/`cargo test`、`tsc`、`esbuild` CLI、`npm test`（pipe を使わないスクリプト）、`git status`/`diff`、Windows PowerShell 5.1、`cmd`。
  - 案 C を採用すれば、上の「失敗」群（Jest 既定、Vitest 既定、`esbuild` Node API）は unconfined ではなく `low-integrity` で動かせる。`npm` / `pnpm` の既定 install はワークスペース外のキャッシュやハードリンク操作を伴うため、既定ポリシーどおり `prompt` → ユーザーの判断で `unconfined` で扱う。

## 8. 未検証・制限

- **アカウントの行列**: トークン構築の権限分岐ロジック（`is_admin_member == false` の標準ユーザーと `is_admin_member == true` の UAC 管理者で `SidsToDisable` に `BUILTIN\Administrators` を出し分ける処理）は `crates/hy-sandbox-windows/src/token.rs` の単体テスト `constructs_tokens_for_standard_user_and_admin_member_identities` で両方検証済み。実 OS アカウントへの対話ログオンによる E2E は、このマシンに標準ユーザーが存在せず built-in `Administrator` が無効化されているため未実施（`.github/workflows/ci.yml` のセルフホストランナー定義でカバー）。
- **pwsh 7**: 未導入のため未実行（Jest、Vitest、`esbuild`、`npm install` は §7 で実測済み）。
- **ConPTY** の出力取り込み: 未評価。
- **パッケージ SID の規則**の仕組み（どのカーネルの規則か）は一次ソースで未確認。実測だけ。
- スパイクは 1 台・1 回の測定。S-1 の時間は Defender を有効にしたまま測った。
- 付与後に作られたハードリンクの再監査は未実装（設計どおり既知の穴）。
