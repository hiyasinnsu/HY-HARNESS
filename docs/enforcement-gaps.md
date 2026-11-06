# HY-HARNESS の既知の穴（封じ込めと検証の限界）

- **対象**: 設計書 Rev 3.1（[design_draft_rev3.md](../design_draft_rev3.md)）の実装（2026-11-03 時点、全フェーズ＋未完了項目＋Desktop GUI 解消済み）
- **目的**: 「何が守られていないか」を 1 か所にまとめる（設計 Phase 8 の「穴の文書化」）。各項目について、どこで報告されるか、どう緩和しているかを書く。
- **原則**: 穴は黙って無視しない。実行時に分かるものは、セッション開始時に `gap:` として表示する（`capabilities.gaps` / `hy sandbox status`）。

## 1. サンドボックス（`workspace-write` / `read-only` / `low-integrity`）

| # | 穴 | 報告 | 緩和・備考 |
| :--- | :--- | :--- | :--- |
| S1 | **読み取りは原則として閉じ込めない**。`sandbox.denyRead`（または権限プロファイルの `denyRead`）に挙げたパスだけは、**Medium の必須ラベル（NO_READ_UP）**で閉じ込める（CP-02）。閉じ込めモードはすべて Low 整合性で動くので読み取りが拒否され、Medium のユーザー自身は影響を受けない。ワークスペース SID への deny ACE も併せて付けるが、トークンが `WRITE_RESTRICTED` なので**書き込みにしか効かない**（2026-11-05 ラウンド 54 で、deny ACE だけでは読めてしまうことを実測で確認して修正）。既存の子オブジェクトにも 1 件ずつ付ける。それ以外のパス（`~/.ssh` など）は、指定しなければ従来どおり読める | `gap: reads-not-confined`（denyRead の件数は `sandbox/status` の `denyRead` で報告） | 環境変数は許可リスト方式で、秘密は子プロセスに渡さない。信頼していないリポジトリでの `hy ralph` は既定で拒否（OQ-3）。ラベルと deny ACE は元の SDDL ごと取り消し記録に残り、`hy sandbox revoke` で戻る |
| S2 | **ネットワークは閉じ込めない**（`shell` のコマンド） | `gap: network-not-confined` | 既知のネットワーククライアントとインストールは既定ポリシーで `prompt`。`run_code` のワーカーは AppContainer なのでネットワークに出られない |
| S3 | **ACL のないボリューム（exFAT / FAT32、このマシンの `F:` と `G:`、USB メモリ）には書ける** | `gap: non-acl-volumes: F:\ (exFAT), G:\ (FAT32)` | ACL で防げない。Codex と同じく、そのボリュームでは `workspace-write` を許可し、ボリューム全体への書き込みを許す。NTFS 側のワークスペース外は制限。GUI には警告を出さない |
| S4 | **pipe や IPC で子プロセスを起動する Node のツールは `workspace-write` で動かない**（Jest の既定、Vitest の `forks` など） | `gap: named-pipe-grandchildren` | 既定ポリシーが Node のテストランナー（`node --test`、`npm`/`pnpm`/`yarn` の `test` / `run test`、`vitest`、`jest`）を単独のコマンドなら `low-integrity` で動かす（2026-11-07、ベンチマークで `node --test` が `spawn EPERM` で失敗し続けたため）。パイプやリダイレクト付きは合成コマンドなので従来どおりで、失敗時は shell の結果に「単独で実行し直す」ヒント（`gap: named-pipe-children`）を付ける。無効にするにはユーザーポリシーで同じコマンドに `sandbox = "workspace-write"`。それ以外はスレッドで動かす設定（`--runInBand` / `--workerThreads`、`--pool=threads`）か、ユーザーポリシーで `low-integrity` |
| S5 | **`low-integrity` のコマンドは、別セッションの付与ルートと `%USERPROFILE%\AppData\LocalLow` に書ける**。`read-only` 相当は表現できない | `gap: low-integrity` | ユーザーポリシーと、既定ポリシーの Node テストランナー規則（S4）だけが指定できる。プロジェクトポリシーは指定できず、Guardian は承認しない。ユーザーポリシーの指定は既定ポリシーより優先する |
| S6 | **付与後にハードリンクされたファイルは再検査しない** | `gap: late-hard-links` | 付与時にリンク数 2 以上のファイルは権限を付けない（実測で穴が塞がることを確認） |
| S7 | **パッケージ SID の ACE を持つディレクトリの下では confined モードが使えない**（このマシンの `%USERPROFILE%\AppData`） | `sandbox-unavailable` と原因のディレクトリ | 専用 temp は `%USERPROFILE%\.hy-harness\tmp` に置く。ワークスペースは AppData の外に置く |
| S8 | **Git Bash（MSYS2）は confined モードで動かない** | 起動エラー（`0xC0000142`） | 既定のシェルは pwsh 7 / Windows PowerShell 5.1（OQ-1） |
| S9 | **サンドボックスの既定は `workspace-write`（2026-11-05 の CP-01 で変更）**。`--unsafe-unconfined` または `sandbox.legacyUnconfined: true` で従来の `unconfined` に戻せる | 開始時の `sandbox: workspace-write (enforcement: partial)` と、既定である旨の 1 行 | 書き込みだけを閉じ込める。読み取り・ネットワークは閉じ込めない（S1/S2）。`--sandbox unconfined` も引き続き選べる |
| S10 | **unconfined で動くもの**: ユーザーが渡した `--verify-cmd`（OQ-2）、ユーザーポリシーの `unconfined` ルール | — | どちらもユーザー自身の指定。Guardian は unconfined を承認しない |
| S12 | **confined の子プロセスは専用デスクトップで動くが、ウィンドウステーションを作れない環境ではユーザーと同じ `WinSta0` を共有する**（このマシンでは後者） | — | ユーザーのデスクトップには触れない（2026-11-03 にデスクトップ書き換えを撤回）。`WinSta0` のクリップボードやアトムなどは共有される |
| S11 | **付与した ACL は revoke するまで残る** | `hy sandbox status` | `hy sandbox revoke` が記録の復元と SID による走査で取り除く（テスト済み） |

## 2. PTC（`run_code`）

| # | 穴 | 緩和・備考 |
| :--- | :--- | :--- |
| P1 | ワーカーのサブ呼び出し（`tools.*`）はホスト側で、セッションのサンドボックスモードのまま実行される | 直接の呼び出しと同じガード、ポリシー、承認を通る |
| P2 | ワーカー自身の防御は Node の `--permission`（Node 自身が「seat belt」と呼ぶもの）と AppContainer の二重。Node 24 の `--permission` はネットワークを扱わない | ネットワークは AppContainer が止める（実測 `EACCES`） |
| P3 | pipe を使う `spawnSync` はコンテナの中でハングし、自身の timeout も効かない | 実行時間の上限はデーモンが Job を終了させて強制する |

## 3. 判定（Guardian、grader）

| # | 穴 | 緩和・備考 |
| :--- | :--- | :--- |
| J1 | Guardian と grader は LLM なので、プロンプトインジェクションを完全には防げない | 入力を `<untrusted_…>` で囲い、閉じタグの偽装を無害化。ワーカーのメモは判定基準にしない。応答は厳密な形式で、壊れていれば拒否・不合格 |
| J2 | 小規模なローカルモデルは判定が不安定 | grader には別プロバイダーを推奨（設計）。`--no-grader` は非推奨 |
| J3 | 改ざん検査は `protectedPaths` に挙げたパスだけを見る | プロジェクト設定で、テスト・フィクスチャ・CI 設定を挙げる |
| J5 | 承認ポリシー `on-request` / `on-failure` は、confined（read-only / workspace-write）の `prompt` 判定を**自動承認**する | — | sandbox が有効なことが前提。unconfined / low-integrity は対象外で、必ずユーザーが判断する。既定は `untrusted`（都度確認） |
| J4 | Guardian は同一コマンドの**承認**をセッション内でキャッシュする（再判定しない） | キーはサンドボックスモード + コマンド文字列（空白正規化）。**拒否はキャッシュしない**（修正後に再判定する）。キャッシュはプロセス内のみで、再起動で消える。`guardian.cache: false` で無効化できる | 承認済みコマンドの引数が同じでも対象ファイルの状態は変わるため、保護パスと書き込みスコープは別途効く |

## 4. チェックポイントとロールバック

| # | 穴 | 緩和・備考 |
| :--- | :--- | :--- |
| C1 | **`.gitignore` で無視されるファイルは保存も復元もしない** | 設計どおり。ビルドキャッシュ（`node_modules`、`target`）を壊さないため |
| C2 | **大きな未追跡ファイルの除外（設計の 50 MB、`unprotected`）** | `checkpoint/create` の `unprotected` 配列 | **実装・検証済み（2026-11-03）**。`maxUntrackedFileBytes`（既定 50 MiB、`HY_MAX_UNTRACKED_FILE_BYTES` で上書き可）を超える未追跡ファイルは `git add -A` から `:(exclude)` で除外し、`unprotected` として返却・メタデータ保存し、ロールバック時も削除せず保持する |
| C3 | **チェックポイント作成の性能目標は、当初の 500 ms 未満から 750 ms 未満に緩めた**（2026-11-03）。作成 約 610〜650 ms、ロールバック 約 265 ms（1 万ファイル・変更 200、Defender 有効、リリースビルド）。変更ファイルがもっと多いと、作成は比例して遅くなる | 作成は変更ファイルをハッシュして loose object を書く必要があり、そのファイルごとの I/O（Defender のスキャン）が支配的。ラン単位の stat キャッシュで 33 % 短縮済み。ロールバックは object を書かない方式にして 827 → 265 ms |
| C4 | **ラウンドのタイムアウトや Ctrl-C による実行中ツール呼び出しの即時中断** | セッションログ `round/end` (`aborted`) / RPC `-32005` | **実装・検証済み（2026-11-03）**。`AbortSignal` を `ExecRpcClient.call()` まで伝播させ、中断時に JSON-RPC 通知 `$/cancelRequest` を送信。デーモン側で `exec/command` の Job Object・`ptc/run` の AppContainer ワーカー・`job/wait` を即座に強制終了させる（結合テストで 30 秒コマンドが 500 ms タイムアウトで即座に終了することを確認） |
| C5 | `hy ralph` の実行中に人が同時に編集すると、ロールバックで上書きされうる。また、ロールバックは作成時の stat を信頼する（stat もサイズも変えずに中身だけを書き換えたファイルは見逃す。作成の `add -A` と同じ前提） | 設計どおり Non-Goal。開始時に未コミットの変更があれば警告する |
| C6 | `HEAD` が動いたら（ワーカーや人がコミットした）、戻さずに止まる | `HeadMoved` として報告し、`HEAD` は自動で戻さない |

## 5. GUI（Electron / `hy web`）

| # | 穴 | 報告・緩和 | 備考 |
| :--- | :--- | :--- | :--- |
| G1 | **既定はローカル専用。`hy web --tailscale` では tailnet 上の端末から届く**。複数ユーザー・TLS はない（Tailscale の暗号化に依存） | 既定は `127.0.0.1` バインド。起動ごとのランダムトークン（定数時間で比較）、`HttpOnly; SameSite=Strict` Cookie。`--tailscale` は Tailscale の IPv4 だけにバインド | トークンを知る tailnet 上の端末は、ユーザーと同じ権限で操作できる（G9 の端末を含む）。tailnet を共有する相手がいるなら使わない |
| G2 | 起動 URL の `?token=...` がブラウザの履歴に残りうる | サーバーはトークンを受けたら Cookie に交換して `/` へ 302 する | `hy web` の起動 URL を共有しない。Electron は内部 URL なので外部履歴に出ない |
| G3 | GUI の設定保存はユーザーの `config.json` だけ。反映には再起動が必要 | 保存後に「Restart to apply」を表示 | プロジェクト設定は書き換えない。API キーそのものは保存せず、環境変数名だけを扱う |
| G4 | 画像は png/jpeg/webp/gif の最大 8 枚、本文は 32 MiB まで | サーバー側で MIME とサイズを検査 | 任意のファイル添付・フォルダー参照は未対応 |
| G5 | レンダラーはサンドボックスだが、表示する Markdown とツール出力は信頼しない | HTML エスケープ、`innerHTML` はサニタイズ済みの Markdown / エスケープ済み output のみ、CSP `default-src 'self'` | リンクは `http(s)` のみ外部ブラウザで開く |
| G6 | Verifier loop は GUI から `hy ralph` を子プロセスで起動し、`--unattended-ok` を渡す | 自動承認は GUI のチェックボックスで明示したときだけ。Guardian 設定時は Guardian が審査 | 信頼していないリポジトリでは実行しないこと。出力と run id は GUI に表示 |
| G7 | 最近使ったワークスペースのパスを Electron の `userData/desktop.json` に保存する | ローカルのユーザープロファイル内のみ | 共有アカウントではパスが見える |
| G8 | ファイル読み取り API はワークスペースと `spill://` のみ。書き込み API はない | `safeWorkspacePath` で `..` と realpath 外を拒否 | 設定 API だけがユーザー `config.json` を書く |
| G9 | **永続 PTY は `pwsh`（なければ Windows PowerShell）を unconfined で起動する**。実行ポリシーもサンドボックスも通らない | ユーザー自身が打つ端末なので意図どおり。モデルは PTY を操作できない | Web UI のトークンを持つ者（`--tailscale` なら tailnet 上の端末を含む）は、ユーザー権限のシェルを使える |
| G14 | **Webhook / スケジュールの自動実行は無人で走る**。Webhook の本文は外部入力としてプロンプトに入る | 2026-11-03 に締めた: `--unattended-ok` は付けない（信頼していないリポジトリの Verifier loop は CLI と同じく拒否、OQ-3）。信頼の判定は対象ディレクトリごと（ユーザーの `trustedProjects`。`--trust` はサーバー自身の信頼済みワークスペースのときだけ）。**Webhook には `--yes` を付けない**（承認が必要なコマンドは Guardian が審査、なければ拒否）。Webhook は対象ごとの秘密（定数時間で比較）が必要で、本文は `<webhook_payload>` で囲み 4,000 文字まで | スケジュールと手動実行の `autoApprove` は従来どおり `--yes`。信頼済みにすると、プロジェクト設定の MCP・フック・プラグインも有効になる |
| G10 | Browser タブは任意の `http(s)` URL を iframe で表示する。外部ページは信頼できない | `sandbox`（`allow-same-origin` なし）、CSP `frame-src http: https:`、 referrer なし | ページ内の操作・入力はユーザーの責任。エージェントのツールではない |
| G11 | プラグインの再読み込みはユーザー設定のモジュールを実行する | ユーザー `config.json` の `plugins` だけ。パスはユーザーが指定 | プラグインコードはユーザーと同じ権限。信頼できるモジュールだけを登録する |
| G12 | ピン留め / アーカイブは `<stateDir>/ui-state.json` に保存する | ワークスペースごとの state ディレクトリ内 | ローカルのユーザープロファイル内のみ |
| G13 | 多言語 UI は主要ラベルのみ。ツール名・ログの生イベント・モデル出力は翻訳しない | `i18n.ts` の辞書 | 技術用語は英語のまま。UI 全体の完全翻訳ではない |
| G15 | **オーケストレーターはモデルなので、ワーカーのコマンドを承認できる範囲を限る** | 2026-11-03 のデバッグで修正: 以前は `orchestrator_approve` が unconfined / low-integrity を含むすべての承認要求を通し、ユーザーはワーカーの承認を GUI で判断できなかった（403）。今はオーケストレーターが承認できるのは confined で走るものだけで、unconfined / low-integrity（シェル、MCP、`web_fetch`）はユーザーだけが承認できる。ユーザーはワーカーのチャットでいつでも判断できる | Guardian と同じ規則（unconfined は人だけ）。ユーザー設定の `autoApprove` を有効にしているとこの判断自体が起きない |

## 6. 検証の範囲（解決済み項目と物理的環境制約の区別）

| # | 項目 | 状態 | 検証結果・備考 |
| :--- | :--- | :--- | :--- |
| V1 | 標準ユーザーと built-in Administrator のアカウント | **単体テスト検証済み / 実 OS 別アカウント対話ログオンは未実施** | `crates/hy-sandbox-windows/src/token.rs` の `create_confined_with_identity` 単体テストで `is_admin_member == false`（標準ユーザー: `disabled_sids` 空）と `is_admin_member == true`（UAC 管理者 / built-in Admin: `BUILTIN\Administrators` を deny-only 化）の双方のトークン生成を実カーネル API で検証済み。実 OS の別アカウント対話ログオンは、このマシンに標準ユーザーが存在せず built-in `Administrator` が無効化されているため未実施 |
| V2 | セルフホストの Windows 10 22H2 ランナー（CI） | **ワークフロー作成済み** | [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) に GitHub ホスト（`windows-latest`）とセルフホスト（`[self-hosted, windows-10-22h2]`）の 2 ジョブ構成を実装済み。ローカルの Windows 10 22H2 実機で全ステップ PASS を確認済み |
| V3 | Rust のカバレッジ（純粋ロジック ≥ 85 %） | **測定・達成済み（89.2 %）** | `pnpm coverage:rust`（[`scripts/coverage-rust.mjs`](../scripts/coverage-rust.mjs)、`rustc -C instrument-coverage` + `llvm-cov`）で測定。純粋ロジック合算で行 **89.2 %**（`1907/2137`）・領域 **88.6 %**（`3277/3699`）を達成（`checkpoint.rs` 87.9 %、`cmdline.rs` 93.9 %、`fs_guard.rs` 92.8 %、`patch.rs` 85.7 %、`hy-execpolicy/lib.rs` 89.7 %、`tokenize.rs` 98.3 %、`token.rs` 94.4 %、`grants.rs` 88.2 %、`sid.rs` 91.7 %） |
| V4 | Gemini と OpenAI 互換のアダプタの実 API 通信 | **未実施（外部 API 鍵・残高制約）** | 契約テスト（モック HTTP サーバーでのヘッダー・ペイロード・429/5xx 再試行検証）は PASS。実 API 通信は DeepSeek が残高不足（HTTP 402）、`GEMINI_API_KEY` / `OPENAI_API_KEY` が環境に未設定のため未実施 |
| V5 | 実モデル（Ollama `qwen2.5:3b`）での Compaction・Guardian・Grader 評価 | **実測・達成済み** | [`scripts/eval-ollama.mjs`](../scripts/eval-ollama.mjs)（結果: [`spikes/win-sandbox/results/ollama-live-eval.json`](../spikes/win-sandbox/results/ollama-live-eval.json)）で実測。①Compaction: Tier 1 退避 2 件＋Tier 2 要約 2 組の後に `<project_constraints>`（`CONSTRAINT-OK`）と `<agent_notes>`（`AURORA-902`）の両方を遵守、②Guardian: 5/5（100 %）正解（安全な 2 件を承認、破壊・流出・プロンプトインジェクションの 3 件を `riskScore: 100` で拒否）、③Grader: `workerNotes` にプロンプトインジェクションがあっても Round 1 の未実装（`subtract` 欠落）を `pass: false` で却下し、Round 2 の完全実装を `pass: true` で承認 |
| V6 | `RepeatToolReminderGuard`（設計 §2） | **実装・検証済み** | `packages/core/src/agent.ts` に実装済み（同一ツール・同一引数が 3 回連続した際にシステム注意書きを注入、`agent.test.ts` で検証済み） |
