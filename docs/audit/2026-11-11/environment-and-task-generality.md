# 領域D 監査: 環境・タスク汎用性・配布時リスク

- 日付: 2026-11-11
- 対象: `F:\HY-HARNESS`（未コミット変更を含む作業ツリー）
- 担当: 監査ワーカー D（環境・タスク汎用性・配布時リスク）
- 方法: ソースを読み、`read_file` / `search_grep` / PowerShell の行番号付き出力で `file:line` を実ファイル上で確認した。**ソースコードは変更していない。** 変更したのは本ファイルのみ。
- 表記: **事実** = コードで確認した内容。**(推測)** = コードから導いたが実行して再現していない予測。行番号は本ファイル作成時点の作業ツリーのもの。
- モデル・プロバイダ固有の話は担当 A/B/C の領域なので、ここでは扱わない（既定プロバイダが特定ベンダー固定かどうかだけ確認した）。

---

## 0. 要約

1. **非 Windows ではビルドも起動も成立しない**が、CLI 側には非 Windows を想定した分岐が残っており（`/tmp` ソケット等）、失敗が「不可解なスタックトレース」になる。コード上は `#![cfg(windows)]` で確定。事実。
2. **出力の文字コードは CP932 固定**。日本語以外の ANSI コードページ環境（英語版 Windows の CP1252、中国語 CP936、韓国語 CP949、ロシア語 CP1251 など）では文字化けする。事実（コード）＋(推測)（症状の程度）。
3. **CRLF ファイルでは `edit_file` が原理的に一致しない**（read_file が LF に正規化し、edit_file は生バイト列で件数照合する）。事実（コード経路）。Windows の既定 `core.autocrlf=true` のリポジトリで頻発する。
4. **Windows で MCP の `npx` 起動が失敗する**（シェルなし `spawn`）。Claude Desktop 等から取り込んだ設定はほぼ `npx` を使うため、移行直後に MCP 全体が動かない。事実（コード）＋Node の仕様。
5. ユーザー定義（hooks）に**実行時スキーマ検証が無い**。文字列配列を書くと先頭 1 文字を実行しようとする。事実。

---

## 1. 一覧表

### 1.1 OS・シェル・実行デーモン

| 場所(file:line) | 現在の前提 | 破綻する環境・タスク | 症状 | 根拠 | 修正方針 | 優先度 |
|---|---|---|---|---|---|---|
| `crates/hy-sandbox-windows/src/lib.rs:12` / `crates/hy-exec-server/src/sandbox.rs:15-22` / `crates/hy-exec-server/src/fs_guard.rs:8` | サンドボックス層は Windows API 前提。`hy-sandbox-windows` は crate 全体が `#![cfg(windows)]`、`hy-exec-server` はその型を無条件に `use` する | macOS / Linux / WSL | `cargo build -p hy-exec-server` が通らない。CLI（TypeScript）だけは起動するため、利用者には「実行だけできない」状態に見える | 事実: `#![cfg(windows)]` と無条件 `use hy_sandbox_windows::…`、無条件 `use std::os::windows::fs::MetadataExt;` | 起動時に `process.platform !== 'win32'` を検出し、`--exec-server` / `HY_EXEC_URL`（リモート実行）の案内を出す。README の対応表と一致させる。将来の移植時は `build_env` / `cmdline` の POSIX 対応（下記）が別途必要 | 高 |
| `packages/core/src/exec-rpc.ts:82`, `75` | 実行デーモンが見つからないとき `'hy-exec-server'` という裸の名前を返し、そのまま `spawn` する（`.exe` を先に探すが、無ければ PATH 依存） | 配布物に Rust バイナリ同梱を忘れた / `pnpm build` だけ実行した（`docs/troubleshooting.md:8-12` が「pnpm build は Rust をビルドしない」と注意している）/ 非 Windows | 起動失敗。`main.ts:1893` が `error.stack` をそのまま出すため、利用者には長いスタックトレースだけが見える | 事実（`exec-rpc.ts:190` の `spawn`、`main.ts:1885-1895`） | spawn 前に存在確認し、「hy-exec-server が見つからない。`cargo build -p hy-exec-server` か `--exec-server <path>`」と1行で返す。トップレベル catch は既定でメッセージ表示、`HY_DEBUG=1` のときだけスタック | 高 |
| `packages/core/src/exec-rpc.ts:98-113` | `childTransport` は `child.on('exit')` と `stderr` だけを購読し、`child.on('error')` を持たない | 実行ファイルが無い（ENOENT） | Node の `ChildProcess` は起動失敗を `'error'` イベントで通知し、リスナが無いと未処理例外になる。事実（Node の仕様）。※本サンドボックスでは EPERM が**同期 throw** されることを実測した（下記「検証ログ」） | 事実（コード）＋Node 仕様 | `child.on('error')` を追加し、`onExit` と同じ経路で `initialize` の pending を reject する | 高 |
| `crates/hy-exec-server/src/cmdline.rs:30-44` | シェルは `pwsh.exe` → `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` の順で固定 | PowerShell を無効化したポリシーの端末、Server Core / Nano Server、ARM64 で 5.1 が無い環境 | `plan()` が存在しない exe を返し、コマンド実行が spawn エラーになる | 事実（コード） | 検出時に `is_file()` で確認し、無ければ「PowerShell が見つからない。`--exec-server` の設定か、cmd ダイアレクトを指定せよ」と返す。`cmd.exe` ダイアレクトへのフォールバックを設定で許す | 中 |
| `crates/hy-sandbox-windows/src/lib.rs:41-48`（`known_gaps`）/ `docs/enforcement-gaps.md:18`（S8） | confined モードのシェルは PowerShell のみ。Git Bash（MSYS2）は `0xC0000142` で動かない | bash / make / POSIX ツール前提のタスク（データ分析のシェルスクリプト、OSS の `./configure`） | confined では起動エラー、unconfined にすれば動くが安全柵を外すことになる | 事実（既存文書） | 起動時の `gap` に「bash は low-integrity 以上でのみ動く」と明示。CI/タスク別の推奨モードを docs に表で持つ | 中 |
| `packages/core/src/exec-rpc.ts:36` | `GRANT_TIMEOUT_MS = 30 * 60_000`。初回の ACL 付与は1回のツリー走査 | 巨大リポジトリ（数十万ファイル）、ネットワーク共有（SMB）上のワークスペース | 初回コマンドが最大30分無反応。`try` 中はタイムアウトしないので、利用者には「固まった」ように見える | 事実（コード）。`docs/troubleshooting.md:52-55` は「10万ファイルで約4秒」としているが、共有フォルダの実測は無い | 進捗を stderr に出す（例: 1万件ごと）。`initialize` のタイムアウトを設定可能にし、既定を5分程度にする | 中 |
| `crates/hy-exec-server/src/server.rs:966-1003` | `build_env` の許可リストが Windows 前提（`SystemRoot`, `ComSpec`, `PATHEXT`, `USERPROFILE`, `APPDATA`, `ProgramFiles` …） | 将来の macOS / Linux 対応 | `HOME` が渡らず git が `$HOME not set` で失敗、`LANG`/`LC_ALL` が無く出力が英語固定、`TMPDIR` が無く一時ファイルがワークスペース内に固定、`SSH_AUTH_SOCK` が無く ssh が通らない、色・TZ も落ちる | 事実（コード）。現状は 1.1 のとおり非 Windows でビルドできないため**未到達** | POSIX では `HOME`, `LANG`, `LC_ALL`, `TZ`, `TMPDIR`, `SHELL`, `XDG_*`, `SSH_AUTH_SOCK`, `TERM` を許可リストに加える | 低（現状ブロック） |
| `crates/hy-exec-server/src/cmdline.rs:68-80`, `:106` | `PATH` を `';'` で分割、`PATHEXT` 前提 | POSIX（PATH は `':'`） | コマンド解決が全滅する | 事実（コード）。未到達 | `std::env::split_paths` を使う | 低（現状ブロック） |

### 1.2 文字コード・出力整形

| 場所(file:line) | 現在の前提 | 破綻する環境・タスク | 症状 | 根拠 | 修正方針 | 優先度 |
|---|---|---|---|---|---|---|
| `crates/hy-exec-server/src/jobs.rs:28-41` | 出力が UTF-8 でなければ **Shift_JIS（CP932）** でデコードする。コメントも「local Japanese ANSI code page」 | 日本語以外の ANSI コードページ: 英語版 Windows（CP1252）、中国語（CP936/GBK）、韓国語（CP949）、ロシア語（CP1251）、西欧（CP850） | `cmd.exe` / PowerShell 5.1 / 古いネイティブツールの出力が文字化けする。`Ω`→`?`、`é`→`?`、中国語は全滅 | 事実（`encoding_rs::SHIFT_JIS.decode`）。(推測) 実害は「エラーメッセージが読めない」→ モデルが原因を誤認する | (a) 実行前に `[Console]::OutputEncoding` を UTF-8 に設定する（`-EncodedCommand` の前置きに追加）。(b) それでも残る分は OS の ANSI コードページ（`GetACP`）に応じて `encoding_rs` の対応表を使う。(c) 設定で `outputEncoding` を上書き可能にする | 高 |
| `packages/core/src/tools.ts:2137-2180` | UTF-16 は BOM、または「先頭8KBの80%以上が ASCII ユニット」でのみ判定。それ以外は UTF-8 として `toString('utf8')` | BOM なし UTF-16LE の日本語文書（.NET 系ツール、WMI、一部の業務ソフトの CSV/LOG）。CP932/GBK/EUC-JP のテキスト | BOM なし UTF-16 は「`binary file`」エラーで読めない。CP932 は U+FFFD に置換された状態で「読めて」しまい、化けた内容をモデルに渡す | 事実（コード）。(推測) 化けた内容を根拠に回答を作るため、静かな誤りになる | 非 UTF-8 を検出したら「このファイルは UTF-8 ではない（CP932 の可能性）。`iconv` で変換するか、shell で読め」と返す。少なくとも「置換が起きた」ことを結果に含める | 中 |
| `crates/hy-exec-server/src/patch.rs:211-218` | パッチ対象は厳密に UTF-8（BOM のみ許容）。非 UTF-8 は `file is not valid UTF-8` | CP932 の設定ファイル・CSV | `read_file` は成功する（化けた内容）のに `apply_patch` / `write_file` は拒否する。読み取りと書き込みで判定が食い違う | 事実（コード） | `read_file` の時点で非 UTF-8 を明示し、`write_file` での「UTF-8 に変換して保存する」選択肢を提示する（現状はエラー文だけ） | 中 |
| `packages/core/src/tools.ts:2351-2360` + `packages/core/src/tools.ts:861` | `wholeFilePatch` は旧内容を `readFileSync(utf8)` してから `^\uFEFF` を除去するが、`edit_file` が渡す新内容は BOM 文字（U+FEFF）を保持したまま | UTF-8 BOM 付きのファイル（Windows のメモ帳・Excel 由来の CSV、業務系の JSON） | `edit_file` の結果、先頭に U+FEFF が二重に入る。`.json` / `.toml` は `patch.rs:328-338` の検証で `result is not valid JSON` となり編集自体が失敗する（他の拡張子では不可視の二重 BOM） | 事実（コード経路）。**実ファイルでの再現は未実施** | `edit_file` の入出力で BOM を正規化する（読み取り時に U+FEFF を落とし、`wholeFilePatch` 側で復元する） | 中 |
| `packages/core/src/tools.ts:174-190` | `cleanPowerShellOutput` は CLIXML を想定 | pwsh 7（CLIXML を出さない） | 無害（素通り）。5.1 では `$ProgressPreference` 前置（`cmdline.rs:119-128`）で CLIXML が出にくくしてある | 事実（コード）。対応済み | 変更不要 | 低 |
| `packages/core/src/web.ts:130` | `web_fetch` の本文は常に UTF-8 デコード | Shift_JIS / GBK / EUC-KR のページ（国内の企業サイト、官公庁の古いページ） | 化けた本文をモデルが要約する | 事実（コード）。(推測) 実害は中程度（最近のページはほぼ UTF-8） | `Content-Type` の charset と `<meta charset>` を見て `TextDecoder` でデコードする | 低 |

### 1.3 パス・ファイルツール

| 場所(file:line) | 現在の前提 | 破綻する環境・タスク | 症状 | 根拠 | 修正方針 | 優先度 |
|---|---|---|---|---|---|---|
| `packages/core/src/tools.ts:861-866` | `edit_file` は `readFileSync(full,'utf8')` の生文字列に対して `old` の出現数を数える。一方 `read_file` は `\r\n` を `\n` に正規化して返す（`tools.ts:1766-1772`） | CRLF のファイル（Windows の既定 `core.autocrlf=true` のチェックアウト、メモ帳で編集したファイル） | モデルは `read_file` の内容（LF）を `old` に貼るので、必ず「not found」または「occurs N times」の不一致になる。結果として `edit_file` が使えず、`write_file` で全置換に走る（差分が巨大化） | 事実（コード）。テストは LF のみ（`packages/core/src/tools.test.ts:144-160`） | 照合時のみ CRLF を LF に正規化し、書き戻しは `patch.rs` の dominant-EOL 保存（`patch.rs:219-245`）に任せる | 高 |
| `packages/core/src/tools.ts:1763` | `read_file` は `statSync` の後、**ファイル全体**を `readFileSync` する。400行/50k文字の制限はその後 | 数GBの CSV・ログ・SQLite・Parquet（データ分析タスク） | メモリ不足でプロセスが落ちる、またはスワップで数分固まる | 事実（コード）。`search_grep` には 16MB 上限と明示スキップがある（`tools.ts:415`, `:1678`, `:438`）が、`read_file` には無い | `stat.size` で上限を設け、「大きすぎる。`startLine`/`endLine` で範囲指定するか shell で `Get-Content -TotalCount` / `head` を使え」と返す。範囲指定時はストリーム読みにする | 中 |
| `packages/core/src/tools.ts:1628`, `:1630` | ディレクトリ走査は `isSymbolicLink()` を無条件でスキップする | symlink で構成されたリポジトリ（pnpm の `node_modules`、`docs -> ../shared/docs`、モノレポの共有パッケージ） | `search_glob` / `search_grep` は symlink 先を検索しないのに、`read_file` は開ける（`realpathSync` で解決）。「検索で見つからない → 存在しない」とモデルが誤認する | 事実（コード） | 既定はスキップのまま（ループ対策）でよいが、結果に「symlink N 件をスキップした」を追加する。もしくは追従を設定で許可し、訪問済み realpath でループを切る | 中 |
| `packages/core/src/tools.ts:130-147`, `crates/hy-exec-server/src/server.rs:936-950` | `cwd` は「絶対パスまたは `:` を含む値」を絶対として扱う | UNC（`\\server\share\repo`）は Windows では問題ないが、POSIX では正当なディレクトリ名 `foo:bar` が絶対パス扱いになる | 非 Windows で `cwd: "data:2026"` が「ワークスペース外」エラーになる | 事実（コード）。未到達（非 Windows でビルド不可） | `Path::is_absolute()` だけで判定する（`:` 判定は Windows のドライブレター専用にする） | 低 |
| `packages/core/src/tools.ts:341-358` | 封じ込めは `realpathSync` で行う（symlink 脱出は防ぐ） | ワークスペース内へのハードリンク（`mklink /H`、`ln`） | 外側の実体を直接書き換えてしまう懸念 | 事実: `patch.rs:606-614` は「同一ディレクトリに temp を書いて rename で置換」、`tools.ts:1833-1836` も temp+rename。よって**リンクは切れて実体は変わらない**（安全側）。`apply_patch` の失敗時ロールバックは `std::fs::write`（`patch.rs:539`）なので、そこだけは実体を書き換え得る | ロールバックも temp+rename に統一する（優先度は低いが一貫性のため） | 低 |
| `packages/core/src/tools.ts:364`（`SEARCH_SKIP`） | 検索は `.git` / `node_modules` / `.hy-harness` を常に除外 | データ分析で `.git` 内の LFS や、`node_modules` 内の型定義を読みたいタスク | 「検索で出ない」→ モデルが「無い」と判断。`note` で理由は返す（`tools.ts:400`） | 事実（コード）。説明あり | 変更不要（`read_file` は開ける旨も `note` に含まれている） | 低 |

### 1.4 外部コマンド・ネットワーク

| 場所(file:line) | 現在の前提 | 破綻する環境・タスク | 症状 | 根拠 | 修正方針 | 優先度 |
|---|---|---|---|---|---|---|
| `packages/core/src/mcp.ts:81-87` | MCP stdio サーバを **シェルなし** `spawn(command, args)` で起動する | Windows で `"command": "npx"` / `"uvx"` / `"pnpm"`（`.cmd` シム）。Claude Desktop / Cursor の設定を `hy import claude` で取り込んだ直後（`docs/migration.md:42` は `env` をそのままコピーすると書く） | `ChildProcess` の `'error'`（ENOENT）で起動失敗。`McpClient` は `fail()` するが、原因は「spawn npx ENOENT」で `.cmd` の話は出ない | 事実（コード）＋Node の仕様（`.bat`/`.cmd` は `shell` なしで実行できない）。`packages/hy-cli/src/documents.ts:142-150` には正しい `ComSpec` 経由の実装が既にある | Windows では拡張子なしのコマンドを `PATHEXT` で解決し、`.cmd`/`.bat` なら `cmd /d /s /c` 経由にする（引数は個別にクォート）。または MCP 起動だけ `shell: true` にし、`command`/`args` を配列のまま渡す | 高 |
| `packages/core/src/lsp.ts:189` | LSP サーバもシェルなし `spawn(exe, args)` | 同上（`npx` 経由の LSP、`cmd` ラッパー） | 「language server exited with code …」または ENOENT | 事実（コード）。`.exe` は libuv が解決するため実害は MCP より小さい（(推測)） | MCP と同じ解決関数を共有する | 中 |
| `packages/core/src/hooks.ts:88-93` | フックはシェルなし・配列の先頭を exe として `spawn`。タイムアウトは既定10秒 | シェル前提の書き方（`["powershell","-Command","..."]` は可、`["echo hi > out.txt"]` は不可）。`command` に文字列を書いた設定 | `spawn` の `'error'` は拾う（`hooks.ts:103`）ので停止はしないが、「hook n failed (exit null): spawn … ENOENT」としか出ない | 事実（コード）。形状の検証が無い（`packages/core/src/config-schema.ts:3` が「loader は未知キーを無視」と明記） | ロード時に `command` が `string[]` かつ非空であることを検証し、設定エラーとして1行で報告する | 中 |
| `packages/core/src/web.ts:96-100` | `fetch` を直接呼ぶ。プロキシ設定を読まない | 企業プロキシ配下（`HTTP_PROXY`/`HTTPS_PROXY` が必須の環境）、TLS 傍受（社内 CA） | `web_fetch` / `web_search` が `fetch failed`（cause が読めない）で失敗 | 事実（コード）。undici は既定で環境変数プロキシを読まない | `HTTPS_PROXY` / `NO_PROXY` を読み、`ProxyAgent` を dispatcher に渡す（Node 24 の `NODE_USE_ENV_PROXY=1` でも可）。失敗時は cause を出す | 中 |
| `packages/core/src/git.ts:11-20` | `PATH` 上の `git.exe` / `git` を探し、無ければ明示エラー | git 未インストール | 「Git executable not found. Install Git and make it available on PATH.」 | 事実（コード）。**良い例** | 変更不要（(推測) ストア版 git のシムは `git.exe` なので見つかる） | 低 |
| `packages/core/src/lsp.ts:178-179` | 拡張子に対応する LSP 設定が無ければ明示エラー | LSP 未設定 | 「no language server is configured for .rs; configured: …」 | 事実（コード）。**良い例** | 変更不要 | 低 |
| `packages/hy-cli/src/documents.ts:75-90`, `:128-131` | `HY_SOFFICE` → OS 別の既定パス → `where`/`which` の順で探し、無ければ 415 と明示メッセージ | LibreOffice 未インストール | 「LibreOffice is not installed … Install it (or set HY_SOFFICE)」 | 事実（コード）。**良い例（プラットフォーム分岐の模範）** | 変更不要 | 低 |

### 1.5 初回起動・設定・ユーザー定義

| 場所(file:line) | 現在の前提 | 破綻する環境・タスク | 症状 | 根拠 | 修正方針 | 優先度 |
|---|---|---|---|---|---|---|
| `packages/core/src/config.ts:448-450` | ユーザー設定は `%APPDATA%\hy-harness`。無ければ `~/AppData/Roaming/hy-harness` | macOS / Linux | `~/.config` を使わず `~/AppData/Roaming` を作る。`hy import claude` 等の探索先もずれる | 事実（コード）。`HY_CONFIG_DIR` で回避可能 | `process.platform` で `~/Library/Application Support` / `$XDG_CONFIG_HOME` に切り替える（`HY_CONFIG_DIR` は維持） | 中 |
| `packages/core/src/config.ts:517-520` | 状態ディレクトリは `%LOCALAPPDATA%\hy-harness\state\<id>`、無ければ `~/AppData/Local/...` | macOS / Linux | 同上。`--state-dir` で回避可能 | 事実（コード） | `~/Library/Application Support` / `$XDG_STATE_HOME`（または `$XDG_DATA_HOME`）に切り替える | 中 |
| `packages/core/src/config.ts:522-525` | `workspaceId` は**全 OS で** `workspaceRoot.toLowerCase()` をハッシュする | 大文字小文字を区別する FS（Linux/macOS の既定、WSL） | `/work/Foo` と `/work/foo` が同じ状態ディレクトリ・同じセッション索引・同じ undo 履歴を共有する。ACL 付与やロックも混線する | 事実（コード）。`config.ts:131` では `win32` のときだけ小文字化しており、方針が不統一 | `workspaceId` も `process.platform === 'win32'` のときだけ小文字化する | 中 |
| `packages/core/src/config.ts:527-533` | `readJson` は解析失敗を握り潰して `undefined`（=既定値）を返す | 手編集で JSON が壊れた設定（末尾カンマ、コメント、BOM） | **設定が丸ごと無視される**。利用者は「設定したのに反映されない」としか分からない。`hy config dump` を見るまで気づけない | 事実（コード） | 解析失敗を警告（stderr 1行 + `hy doctor` の `config` 行を `warn`）にする。コメント付き JSON を許すなら JSONC として読む | 中 |
| `packages/core/src/config.ts:760` | 既定プロバイダは `ollama`（`qwen2.5:3b`, `127.0.0.1:11434`） | Ollama 未起動 | 接続拒否 | 事実（コード）。特定ベンダー固定ではない（**良い**）。`docs/troubleshooting.md:24-30` に `curl` の確認手順あり | Ollama 未起動時のエラーに「Ollama が起動しているか（`curl http://127.0.0.1:11434/api/tags`）」を添える | 低 |
| `packages/hy-cli/src/doctor.ts:77-81` | `exec-server` の判定は `fs.existsSync(path)` | 実行ファイルが `PATH` 上にだけある（配布物で `bin/` に置いた場合など） | `resolveServerPath()` は見つからないと裸の `'hy-exec-server'` を返す（`exec-rpc.ts:82`）ため、実際には起動できるのに `fail` 表示になり `hy doctor` が終了コード 1 を返す | 事実（コード） | `PATH` 解決を含めた存在確認にする、または `sandbox/status` の応答（起動できたか）で判定する（同ファイルは既に sandbox 行でその方式を使っている） | 低 |
| `packages/hy-cli/src/main.ts:171-172` | usage の既定値表記が `%LOCALAPPDATA%` 固定。`--provider` の一覧に `openai-responses` が無い（`config.ts:663` には存在） | 非 Windows / Responses API 利用者 | ヘルプと実装のずれ | 事実（コード） | usage を `config.ts` の定数から生成する | 低 |
| `packages/core/src/secrets.ts:1-8`, `:33-46` / `packages/hy-cli/src/doctor.ts:132-138` | `hy secret` は DPAPI ヘルパ `hy-secret.exe` 固定 | 非 Windows（DPAPI が無い） | `hy-secret.exe was not found (build it: cargo build -p hy-sandbox-windows --bin hy-secret)` と明示される（クラッシュはしない） | 事実（コード）。(推測) macOS の Keychain / Linux の Secret Service を使う実装が別途必要 | 非 Windows では「この機能は未対応。環境変数か設定の `apiKey` を使え」と案内する | 低 |
| `packages/core/src/skills.ts:33-45`, `:51-88` | frontmatter は `name` / `description` の1行のみを読む簡易パーサ。不正な skill は黙ってスキップ | YAML の複数行（`description: >`）、クォート内の `:`、`name` に日本語 | 説明が `>` になったり、skill が一覧に出ない（エラーは出ない） | 事実（コード）。(推測) 実害は「登録したのに使われない」 | `hy doctor` に「読み込めなかった skill」を出す。複数行記法に対応する | 低 |
| `packages/core/src/plugins.ts:52-58` | プラグインの `import` 失敗は `errors` に積んで続行。タイムアウト無し | トップレベル `await` でハングするプラグイン、巨大な依存を読み込むプラグイン | 起動が止まる（`errors` にすら到達しない） | 事実（コード）。(推測) 原因の特定は難しい | プラグイン読み込みに時間上限を設け、超過を `errors` に積む | 低 |

---

## 2. 未知タスク別の破綻シナリオ（環境起点）

モデル名ではなく**タスクの種類**から見た破綻。各行は「発生条件 → 影響 → 検出方法 → 修正方針」。

### 2.1 データ分析（CSV / ログ / ノートブック）

- **発生条件**: 数百MB〜数GBの CSV・ログを `read_file` で開く。あるいは CP932 の CSV を編集する。
- **影響**: `read_file` は全体をメモリに読む（`tools.ts:1763`）ため OOM/長時間停止。CP932 は化けたまま返り（`tools.ts:2179`）、`write_file` で保存しようとすると `patch.rs:215-218` が拒否する。
- **検出方法**: `read_file` の所要時間と RSS、`binary file` / `file is not valid UTF-8` の頻度。
- **修正方針**: 1.3 の行1・1.2 の行2・3。加えて、shell 経由の `head`/`Get-Content -TotalCount` を `read_file` のエラー文で案内する。

### 2.2 文書処理（Office / PDF / 業務ファイル）

- **発生条件**: UTF-16LE（BOM なし）のログ、CP932 の設定ファイル、UTF-8 BOM 付き JSON を編集する。
- **影響**: 読めない（binary）/ 化ける / 編集が `result is not valid JSON` で失敗する（1.2 の行4）。
- **検出方法**: `binary file`、`file is not valid UTF-8`、`result is not valid JSON` の発生回数。
- **修正方針**: `decodeTextBuffer` の判定を広げ、BOM の正規化を `edit_file` 側で行う。`documents.ts` の Office プレビューは既に良好（1.4 の行7）。

### 2.3 巨大リポジトリ / モノレポ

- **発生条件**: 初回の ACL 付与、`search_grep` の 15 秒/256MB 予算、symlink 構成。
- **影響**: 初回が最大30分無反応（`exec-rpc.ts:36`）。検索は常に部分結果（`tools.ts:442-446` の `budgetNote` で明示される）。symlink 先は見つからない（`tools.ts:1628`）。
- **検出方法**: `stoppedEarly` / `truncated` の頻度、初回コマンドの所要時間。
- **修正方針**: 進捗表示、symlink スキップ件数の報告。

### 2.4 非 git ディレクトリ

- **発生条件**: git 管理外のディレクトリで `hy run`。
- **影響**: チェックポイントが無効になり `/undo` が使えない。**ターンは継続する**（`packages/hy-cli/src/session-app.ts:1710-1716` が失敗を捕まえ、`[hy] checkpoints off: …` を1行出す）。
- **評価**: 劣化が graceful。**対応不要**（理由は 4 章）。

### 2.5 読み取り専用ディレクトリ / 共有フォルダ（SMB・UNC）

- **発生条件**: ワークスペースが読み取り専用、またはネットワーク共有上。
- **影響**: 書き込みは OS のエラー（EACCES/EPERM）がそのまま返る（`tools.ts:1834-1835`）。ACL 付与の走査が遅く、タイムアウトは30分（`exec-rpc.ts:36`）。UNC の cwd は `normalizeShellCwd`（`tools.ts:130-147`）で相対化されるため、モデルが絶対 UNC を渡すと「cwd must be inside the primary workspace」になる（仕様どおりだが、メッセージから UNC が原因とは分からない）。
- **検出方法**: `cwd must be inside` の発生、書き込みエラーの errno。
- **修正方針**: 1.1 の行6（進捗・タイムアウト）と、パスが UNC のときの専用メッセージ。

### 2.6 英語版 Windows / 別ロケール

- **発生条件**: システム ANSI コードページが CP932 以外。
- **影響**: 1.2 の行1（文字化け）。加えて `cleanPowerShellOutput` は CLIXML の `<S S="Error">` を拾うので**エラー文言自体は言語非依存**で取れる（事実: 正規表現はタグのみ）。ロケール依存で壊れるのはデコードだけ。
- **修正方針**: 1.2 の行1。

### 2.7 非 Windows（macOS / Linux / WSL）

- **発生条件**: `pnpm build` 後に `hy run`。
- **影響**: 実行デーモンがビルドできず、CLI はスタックトレースで落ちる（1.1 の行1〜3）。WSL は Linux 扱いなので同じ。
- **検出方法**: `hy doctor` の `exec-server` 行（ただし PATH 上の場合は誤判定、1.5 の行6）。
- **修正方針**: 起動時の明示拒否 + リモート実行（`HY_EXEC_URL`）の案内。`session-app.ts:770-777` にリモート接続の経路が既にあるので、これを非 Windows の既定の逃げ道として文書化する。

---

## 3. 事実と推測の区別

### 3.1 コードで確認した事実（再掲・主要なもの）

- `hy-sandbox-windows` は `#![cfg(windows)]`、`hy-exec-server` はその型を無条件に使う（`crates/hy-sandbox-windows/src/lib.rs:12`, `crates/hy-exec-server/src/sandbox.rs:15-22`, `crates/hy-exec-server/src/fs_guard.rs:8`）。
- 出力デコードのフォールバックは Shift_JIS のみ（`crates/hy-exec-server/src/jobs.rs:36`）。
- `read_file` は CRLF を LF に正規化し（`packages/core/src/tools.ts:1766-1772`）、`edit_file` は生文字列で照合する（`packages/core/src/tools.ts:861-866`）。
- `read_file` はファイル全体をメモリに読む（`packages/core/src/tools.ts:1763`）。
- 検索は symlink をスキップする（`packages/core/src/tools.ts:1628`）。
- MCP / LSP / hooks はシェルなし `spawn`（`packages/core/src/mcp.ts:81`, `packages/core/src/lsp.ts:189`, `packages/core/src/hooks.ts:93`）。
- 設定ディレクトリは `%APPDATA%` / `%LOCALAPPDATA%` 前提（`packages/core/src/config.ts:449`, `:518`）。
- `workspaceId` は全 OS で小文字化（`packages/core/src/config.ts:523-525`）。
- 既定プロバイダは `ollama`（`packages/core/src/config.ts:760`）。
- 壊れた設定 JSON は無言で既定に戻る（`packages/core/src/config.ts:527-533`）。
- `pipeChildGap` の EPERM 判定は終了コードを見ない（`packages/core/src/tools.ts:160-169`）。

### 3.2 推測（(推測) と明記したもの）

- 英語版 Windows 等で、文字化けしたエラー文が原因誤認を招く度合い。
- CP932 の CSV を「化けたまま」モデルが解釈して誤った分析結果を出す可能性。
- ハングするプラグイン・巨大依存のプラグインによる起動停止の頻度。
- 非 Windows の POSIX 対応（`build_env` / `PATH` 分割）が実際にどこまで必要かは、移植を決めてからでないと判断できない。
- ストア版 git のシム（`git.exe`）が `git.ts` の探索で見つかること。

### 3.3 実測したが本番コードの再現ではないもの

- 本監査セッションのサンドボックスでは `node -e "spawn('npx', …)"` が **`Error: spawn EPERM` を同期的に throw** した（`node:internal/child_process:458`）。したがって「起動失敗は必ず `'error'` イベント」とは限らず、環境によっては同期例外になる。`exec-rpc.ts:190` の `spawn` は `try/catch` を持たないため、どちらの形でもスタックトレースになる。
- `pipeChildGap` の誤検知を実測した。コマンドの**出力**に `EPERM` と `spawn` の両方を含む行があると、終了コード 0 でも `gap: named-pipe-children` が付いた（自分の `Select-String` 出力で2回）。`docs/enforcement-gaps.md:14` は「失敗時にヒントを付ける」と書いているが、実装は成功時にも付き得る。

---

## 4. 配布前に最低限直すべきもの トップ5

1. **非 Windows を明示的に拒否する（1.1 の行1〜3）**
   現状は「ビルドできない → 裸の名前で spawn → スタックトレース」。配布先で最初に踏む地雷として最もコストが高い。`process.platform` の1か所で判定し、`--exec-server` / `HY_EXEC_URL` を案内するだけで、サポート問い合わせの質が変わる。`exec-rpc.ts:98-113` の `'error'` リスナ追加も同じ修正に含める。

2. **出力デコードを CP932 固定から外す（1.2 の行1）**
   日本語話者以外が最初に踏む。「英語版 Windows で `dir` の出力が化ける」は再現も説明も簡単だが、現状はコードにその分岐が無い。まず `-EncodedCommand` の前置きで `[Console]::OutputEncoding = [Text.Encoding]::UTF8` を設定し、残りを ANSI コードページでデコードする。

3. **CRLF ファイルで `edit_file` を動かす（1.3 の行1）**
   Windows の既定チェックアウトは CRLF なので、**配布先の大多数**で `edit_file` が失敗する。失敗するとモデルは `write_file`（全置換）に逃げ、差分が膨らみ、トークンとレビュー負荷が増える。照合の正規化だけで直る。

4. **Windows で MCP の `npx` を起動できるようにする（1.4 の行1）**
   `hy import claude` の主要ユースケース（Claude Desktop の MCP 設定を取り込む）が、Windows ではほぼ確実に失敗する。`documents.ts:142-150` に正しい実装が既にあるので、共通ヘルパに切り出して MCP / LSP / hooks で共有する。

5. **エンコーディングの「読み取りと書き込みの不一致」を解消する（1.2 の行2〜4）**
   「読めるのに書けない」「化けたまま読める」は、静かな誤りとデータ破壊につながる。`read_file` で非 UTF-8 を明示し、BOM を正規化し、`write_file` での UTF-8 変換を利用者が選べるようにする。

---

## 5. 対応不要と判断したもの（理由付き）

| 項目 | 場所 | 対応不要の理由 |
|---|---|---|
| 非 git ディレクトリでの `/undo` 無効化 | `packages/hy-cli/src/session-app.ts:1710-1716` | 失敗を捕まえて `checkpoints = false` にし、`[hy] checkpoints off: <理由>` を1行出す。ターンは継続する。**劣化が明示的で graceful** |
| ハードリンク経由の外部ファイル破壊 | `crates/hy-exec-server/src/patch.rs:606-614`, `packages/core/src/tools.ts:1833-1836` | 書き込みは temp + rename なので、リンクは切れて外部の実体は変わらない（安全側）。ロールバック経路（`patch.rs:539`）だけは `fs::write` だが、これは失敗時の復元であり通常経路ではない |
| symlink の無限ループ | `packages/core/src/tools.ts:1628` | `isSymbolicLink()` で無条件にスキップするためループしない。検索性の犠牲（1.3 の行3で別途指摘）とは分けて評価する |
| `rg` への依存 | — | 検索は自前実装（`walkDir` + JS 正規表現）。外部バイナリ依存が無いことは配布上の利点 |
| LibreOffice 不在 | `packages/hy-cli/src/documents.ts:128-131` | 415 と「インストールするか `HY_SOFFICE` を設定」という明示メッセージ。OS 別の探索も実装済み |
| git 不在 | `packages/core/src/git.ts:11-20` | 「Install Git and make it available on PATH.」と明示。git 依存の機能（`git_status` 等）はオプション扱い |
| LSP 未設定 | `packages/core/src/lsp.ts:178-179` | 「no language server is configured for .ext; configured: …」と明示 |
| 不正な skill | `packages/core/src/skills.ts:51-88` | 名前の検証に通らない skill はスキップし、プロセスは落ちない。上限（40件・200字）もある |
| 不正なプラグイン（構文エラー・tools 配列なし） | `packages/core/src/plugins.ts:52-62` | `errors` に積んで続行。ツール名・`run`・スキーマも検証している（`plugins.ts:66-78`） |
| 既定プロバイダが特定ベンダー固定か | `packages/core/src/config.ts:760` | 既定は `ollama`（ローカル・キー不要）。プロバイダ一覧に8種、`apiKeyEnv` も設定可能。**ベンダー固定ではない** |
| TTY が必要なプログラム | `packages/core/src/tools.ts:1983-1985`, `crates/hy-exec-server/src/shell.rs:116`, `packages/hy-cli/src/pty.ts:53` | `tty` / `stdinPipe` オプションがあり、confined セッションでは「stdin を sandbox トークンに通せない」と理由付きで断る（`shell.rs:116`）。PTY 実装はプラットフォーム分岐を持つ（`pty.ts:53`） |

---

## 6. 既存文書との関係（重複と差分）

- `docs/enforcement-gaps.md:14`（S4）: 「pipe や IPC で子プロセスを起動する Node のツールは `workspace-write` で動かない」「**失敗時**は shell の結果に『単独で実行し直す』ヒント（`gap: named-pipe-children`）を付ける」と記録されている。**差分**: 実装の `seen` 判定（`packages/core/src/tools.ts:160`）は終了コードを見ないため、**成功時にも**ヒントが付く（3.3 で実測）。文書は「失敗時」と限定しているので、実装または文書のどちらかを直す必要がある。
- `docs/troubleshooting.md:8-12`: 「`hy-exec-server.exe` が無い/古い → `cargo build -p hy-exec-server`」。**差分**: 症状（スタックトレースになること）と、非 Windows では**ビルド自体ができない**ことが書かれていない。
- `docs/migration.md:20`: 「ワークスペースが `%TEMP%` の下にあると閉じ込めが使えない」。**差分**: 共有フォルダ（SMB）と巨大リポジトリの初回時間については記述が無い。
- `README.md:361-365`: 「Persistent shell keeps one interactive PowerShell (**or `$SHELL` on other platforms**) alive」。**差分**: 実行デーモンは Windows 専用（1.1 の行1）なので、他プラットフォームの `$SHELL` 経路は現状到達できない。README の表現を実装に合わせるか、移植を明記する。
- `docs/audit/2026-11-11/00-verified-findings.md` L-3: 非 Windows の失敗を「(推測) サンドボックスの初期化で落ちる」としている。**本レポートでコード根拠（`#![cfg(windows)]`、無条件の Windows 依存 import）を確認したため、事実に格上げできる**。ただし「どこで最初に落ちるか」は CLI の起動順（`openClient` → `resolveServerPath` → `spawn`）で決まり、サンドボックス初期化より前である（`packages/hy-cli/src/session-app.ts:745-777`）。

---

## 7. 確認した file:line の件数

**38 項目（本文全体では異なる `file:line` 参照が 114 件）**。すべて `read_file` または行番号付きの `Select-String` / `Get-Content` 出力で実ファイル上の存在と内容を確認し、最後に機械照合（ファイルの存在と行番号が範囲内か）で 114 件すべてが解決することを確認した。

| # | file:line | 確認した内容（要約） |
|---|---|---|
| 1 | `crates/hy-sandbox-windows/src/lib.rs:12` | `#![cfg(windows)]` |
| 2 | `crates/hy-exec-server/src/fs_guard.rs:8` | 無条件 `use std::os::windows::fs::MetadataExt;` |
| 3 | `crates/hy-exec-server/src/sandbox.rs:15-22` | `use hy_sandbox_windows::…` を無条件に列挙 |
| 4 | `crates/hy-exec-server/src/jobs.rs:30` | `fn decode_output` |
| 5 | `crates/hy-exec-server/src/jobs.rs:36` | `encoding_rs::SHIFT_JIS.decode` |
| 6 | `crates/hy-exec-server/src/jobs.rs:39` | `#[cfg(not(windows))]` は lossy UTF-8 |
| 7 | `crates/hy-exec-server/src/server.rs:966-974` | `ALLOWED` 環境変数リスト（`SystemRoot` / `USERPROFILE` …） |
| 8 | `crates/hy-exec-server/src/server.rs:1015-1016` | `PYTHONIOENCODING=utf-8` の注入 |
| 9 | `crates/hy-exec-server/src/server.rs:936-950` | `resolve_cwd` と `value.contains(':')` |
| 10 | `crates/hy-exec-server/src/shell.rs:128` | `.env_clear()` |
| 11 | `crates/hy-exec-server/src/cmdline.rs:30-44` | `pwsh.exe` → `powershell.exe` の検出 |
| 12 | `crates/hy-exec-server/src/cmdline.rs:68-80`, `106` | PATH の `';'` 分割 |
| 13 | `crates/hy-exec-server/src/patch.rs:211-218` | BOM 除去と `file is not valid UTF-8` |
| 14 | `crates/hy-exec-server/src/patch.rs:219-245` | dominant EOL の保存 |
| 15 | `crates/hy-exec-server/src/patch.rs:328-338` | JSON / TOML の検証 |
| 16 | `crates/hy-exec-server/src/patch.rs:539`, `606-614` | ロールバックの `fs::write` と `write_replace`（temp+rename） |
| 17 | `packages/core/src/exec-rpc.ts:36` | `GRANT_TIMEOUT_MS = 30 * 60_000` |
| 18 | `packages/core/src/exec-rpc.ts:70-82` | `resolveServerPath`（`.exe` → 裸名） |
| 19 | `packages/core/src/exec-rpc.ts:98-113` | `childTransport`（`'exit'` のみ、`'error'` 無し） |
| 20 | `packages/core/src/exec-rpc.ts:182-195` | `static start` の `spawn` |
| 21 | `packages/core/src/tools.ts:160-170` | `pipeChildGap` の `seen` 判定とメッセージ |
| 22 | `packages/core/src/tools.ts:2037` | `pipeChildGap(result, command)` の呼び出し |
| 23 | `packages/core/src/tools.ts:861-866` | `edit_file` の生文字列照合 |
| 24 | `packages/core/src/tools.ts:1763-1772` | 全体読み込みと CRLF→LF 正規化 |
| 25 | `packages/core/src/tools.ts:1833-1836` | temp + rename の書き込み（`'utf8'`） |
| 26 | `packages/core/src/tools.ts:2137-2180` | `decodeTextBuffer`（UTF-16 判定と UTF-8 フォールバック） |
| 27 | `packages/core/src/tools.ts:2351-2360` | `wholeFilePatch` の BOM 除去 |
| 28 | `packages/core/src/tools.ts:1628-1631` | symlink スキップとディレクトリ走査 |
| 29 | `packages/core/src/tools.ts:364`, `415`, `438` | `SEARCH_SKIP` と 16MB 上限・スキップ注記 |
| 30 | `packages/core/src/config.ts:449`, `518`, `523-525` | `%APPDATA%` / `%LOCALAPPDATA%` / 小文字化 |
| 31 | `packages/core/src/config.ts:760` | 既定プロバイダ `ollama` |
| 32 | `packages/core/src/mcp.ts:81-87` | シェルなし `spawn` と `env` |
| 33 | `packages/core/src/lsp.ts:189`, `178-179` | シェルなし `spawn` と未設定エラー |
| 34 | `packages/core/src/hooks.ts:88-103` | 配列先頭を exe として `spawn` |
| 35 | `packages/core/src/web.ts:96-100`, `130` | プロキシ未使用の `fetch` と UTF-8 デコード |
| 36 | `packages/core/src/skills.ts:33-45` / `packages/core/src/plugins.ts:52-78` | 簡易 frontmatter / import 失敗の収集 |
| 37 | `packages/hy-cli/src/doctor.ts:77-81`, `132-138` | exec-server の `existsSync` 判定 / `hy-secret.exe` |
| 38 | `packages/hy-cli/src/main.ts:171-172`, `1726`, `1893` / `packages/core/src/config-schema.ts:3` / `README.md:362` / `docs/troubleshooting.md:8-12` / `docs/migration.md:20` / `docs/enforcement-gaps.md:14`, `18` | usage・非 win32 分岐・スタック表示・スキーマ非強制・各文書の記述 |

---

## 8. 未確認事項（正直な記載）

- **非 Windows 実機での起動は試していない。** Rust のクロスビルド（`cargo check --target x86_64-unknown-linux-gnu` 等）も実行していない。`#![cfg(windows)]` と無条件 import からの**論理的な**結論であり、コンパイルエラーの実出力は見ていない。
- **CP1252 / CP936 等での文字化けは再現していない。** コード上の分岐（UTF-8 でなければ Shift_JIS）から導いた。
- **CRLF ファイルでの `edit_file` 失敗、BOM 二重化、`.json` の検証エラーは再現していない。** コード経路の追跡のみ。テストは LF のみ（`packages/core/src/tools.test.ts:144-160`）。
- **MCP の `npx` 起動失敗は再現していない。** 本監査セッションのサンドボックスが `spawn` を EPERM で拒否するため、外部コマンド起動を伴う実験はできなかった（実測: `node -e "spawn('npx', …)"` → `Error: spawn EPERM`）。
- **ネットワーク共有（SMB）・UNC・260 文字超のパス・日本語/絵文字入りパスの実機検証はしていない。** パス処理はコード上の分岐（`normalizeShellCwd` / `plain_path` / `resolve_cwd`）の読解に留まる。
- **英語版 Windows の実機は無い。** ロケール依存の挙動（CLIXML の文言、`chcp`、`GetACP`）は未確認。
- **`hy doctor` の PATH 誤判定はコード上の指摘のみ**（`resolveServerPath` が裸名を返す経路と `existsSync` の組み合わせ）。
- **プラグインのハングは再現していない。** タイムアウトが無いことだけ確認した。

---

## 9. 検証ログ（実行したコマンドと結果）

| 目的 | コマンド（要約） | 結果 |
|---|---|---|
| 構成の把握 | `Get-ChildItem packages/core/src -Name` ほか | 対象ファイルの存在を確認 |
| 行番号の確認 | `Select-String -Path <file> -Pattern '<snippet>'` を各ファイルに実行 | 本文の `file:line` はこの出力に基づく |
| 内容の確認 | `read_file`（`tools.ts` / `exec-rpc.ts` / `tool-docs.ts` / `config.ts` / `mcp.ts` / `web.ts` / `lsp.ts` / `git.ts` / `skills.ts` / `plugins.ts` / `hooks.ts` / `secrets.ts` / `doctor.ts` / `onboarding.ts` / Rust の `jobs.rs` / `server.rs` / `shell.rs` / `cmdline.rs` / `patch.rs` / `fs_guard.rs` / `lib.rs` / 各 docs） | 引用はこの読解に基づく |
| spawn 失敗の形 | `node -e "spawn('definitely-not-there-xyz',[])"` | `Error: spawn EPERM` が**同期 throw**。`'error'` イベントには到達しない |
| 別名の起動 | `node -e "spawn('npx',['--version'])"` | 同じく EPERM でプロセスごと終了（サンドボックスの制約） |
| `pipeChildGap` の誤検知 | `Select-String -Path packages/core/src/tools.ts -Pattern '...'`（出力に `EPERM` と `spawn` を含む行がある） | 終了コード 0 でも `gap: named-pipe-children` が付いた（2回） |
| 行番号の突き合わせ | `Get-Content` で `file:line` の行を直接表示 | 引用した行がすべて実在することを確認（初稿から行番号のずれ 9 件を修正: `skills.ts:51`, `plugins.ts:66`, `hooks.ts:88`, `patch.rs:606`, `cmdline.rs:119`, `lib.rs:41`, `lsp.ts:178`, `troubleshooting.md:8-12`, `migration.md:42`） |
| 参照の機械照合 | 本文から `file:line` を正規表現で抽出し、ファイルの存在と行数で範囲を検査 | 114 件すべてが解決（`main.ts` の同名衝突 2 件は `packages/hy-cli/src/main.ts` として確認） |

> 注: 本サンドボックスは `workspace-write` で、Node からの `spawn` は EPERM で拒否される。したがって「外部コマンドが無い環境でのエラー文」を実際に出す実験はできていない。1.4 の各指摘はコードと Node の仕様に基づく。

---

## 10. まとめ（1行）

**「Windows 日本語（CP932）・UTF-8/LF のソース・git あり・MCP 設定は npx を使わない」という1つの環境に最適化されており、それ以外では「動かない」ではなく「不可解に失敗する」点が配布上の最大リスクである。**
