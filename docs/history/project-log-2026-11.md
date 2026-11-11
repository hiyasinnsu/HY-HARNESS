# HY-HARNESS 作業記録（2026-11-02〜2026-11-11、§4〜§5.86）

`project.md` から移した作業記録です。内容は移動時点のまま変更していません。現在の状態と次の作業は `project.md` を参照してください。

## 4. 実装過程・調査ログ・エラー対策記録
- **2026-11-06 (自分のメッセージの操作と履歴の書き出し、ユーザー要望)**:
  1. **実装**: 自分のメッセージのコピー / 再送信 / 編集、自分のメッセージへのジャンプバー、デバッグ用の履歴書き出し（Markdown / JSON）。詳細は `docs/implementation_status.md` §2.15。
  2. **巻き戻しの選択肢**: 既存の巻き戻し（`/undo` の `toTurn`）は必ずファイルもチェックポイントへ戻していた。編集・再送信では作業を消さないのが既定であるべきなので `keepFiles` を追加し、ファイルを戻すのはユーザーがチェックしたときだけにした。
  3. **書き出しのルート重複**: `GET /api/sessions/:id/export` は表示中のエントリだけの簡易版が既にあり、新しいハンドラーが先に一致して古い方を隠していた（契約テストが重複を検出）。新しい方に統合し、JSON に従来の `entries` を残した。`/export` コマンドも同じダイアログを開く。
  4. **確認中に気づいた点（報告のみ）**: `maxSteps` の全廃（2026-11-04、ユーザー要望）により、ツールが失敗し続ける循環（モックでは `read_file` → `apply_patch` → `shell` の失敗）を止めるのは停止ボタンだけになっている。GUI の確認中にモックが 2,705 周（約 8,100 エントリ）回り続けた。`RepeatToolReminderGuard` は同じ呼び出しの連続しか検出しないため、この 3 つの循環は検出されない。→ 同日対応: ループガード（`detectCycle` / `cycleReminder`、`agent.ts`）を追加。2〜4 ステップの同じ呼び出し列（失敗 / 成功も同じ）が 2 周目に入るたびに、その周の最後のツール結果へ「ループしている、やり方を変えるか止めて理由を説明せよ」という `[reminder]` を付け、`guard/cycle` をログに残す。ターンは止めない（`maxSteps` 全廃の方針どおり、止めるのはユーザー）。
- **2026-11-03 (Desktop GUI)**:
  1. **Electron のバイナリが pnpm で入らなかった**: `pnpm add -D electron@45.2.1` はパッケージだけを入れ、`node_modules/electron/dist/electron.exe` がなかった。`node node_modules/electron/install.js` を手動実行して解決。CI / 新しい環境ではインストールスクリプトの実行が必要。
  2. **ターンをまたぐツール ID の衝突**: `Agent` の callId が各ターンで `step-1` に戻るため、GUI のライブ更新が前のターンのツールカードを更新していた（delegate の結果が shell のカードに出た）。`AgentOptions.callIdPrefix` を追加し、`Conversation.turn` が `t<N>-` を渡すようにした。
  3. **ログ投影の引数消失**: `step/end` が `assistant/message` より先に記録されるため、`stepEnds + 1` から callId を作ると `tool/result` の callId と一致しなかった。投影は callId ではなく出現順のキューで引数を対応付けるように変更した。
  4. **ゴール / プランモード + モックの暴走**: 前置き `[session goal: …]` により `MockProvider` の `SAY` / `REPEAT FIRST` 判定が外れ、デモの read → patch → shell ループに入った。`stripContext()` で前置きを外してから判定するようにした。
  5. **レイアウト**: 3 カラムの grid item が `min-height: 0` を持たず、右パネルが viewport を超えた。`grid-template-rows: minmax(0, 1fr)` と各列の `min-height: 0` を追加。右パネルのタブは 5 個（Files / Diff / Plan / Details / Trace）で折り返す。
  6. **デスクトップのスクリーンショット検証**: `pnpm desktop:screenshot` が Electron を起動し、モックのデモを流して `screenshots/desktop.png` を書く。ワークスペースの state を削除してから撮るので、セッション一覧が 1 件になる。
  7. **GUI の設定反映**: 設定はユーザー `config.json` に保存するが、サーバーは起動時に読むため再起動が必要。UI に明記した。プロジェクト設定は書き換えない。
  8. **ピン留め / アーカイブ**: セッション UI 状態を `<stateDir>/ui-state.json` に保存。`GET /api/sessions` は既定でアーカイブを除外し、`?archived=1` で含める。一覧はピン留め優先。
  9. **プラグイン再読み込み**: `loadPlugins(..., { cacheBust: true })` を追加。`startServices` はプラグイン / MCP の構成キーを比較し、ワークスペース切替後に古い空の `sessionPlugins` を使い回さないようにした。`closeServices` でもプラグイン / MCP をクリアする。
  10. **多言語 UI**: `i18n.ts` に English / 日本語 / 中文 の辞書を追加。初回は `navigator.language` で判定し、Settings の Language で切り替える。主要ラベル・モーダル・通知を翻訳し、ツール名や生のログは技術用語として英語のまま。
  11. **Browser / Terminal**: Browser は sandbox iframe の URL プレビュー、Terminal は `exec/command` を `approval: { by: "user" }` で実行する単発コンソール。永続 PTY ではない。CSP に `frame-src http: https:` を追加。
  12. **テストの環境変数競合**: `web-ui.test.mjs` は `HY_CONFIG_DIR` / `LOCALAPPDATA` を切り替えるため、テストを直列化し、プラグインのテストは再読み込みも確認するようにした。
  13. **白色 / 桜色テーマとアプリアイコン（2026-11-03、ユーザー指示）**: 既定テーマを `data-theme="light"` の白色 / 桜色に変更した（`--accent: #e05c88`、淡い桜色のサイドバー / パネル / フォーカスリング）。ダークテーマは night sakura に変更。`HY_icon.png`（512×512）を `packages/desktop/assets/` と `packages/hy-cli/web/` に同梱し、Electron のウィンドウ / タスクバーアイコン、favicon、サイドバーのブランドマークに使う。`localStorage` のキーを `hy-theme-v2` にして、旧ダーク設定の影響を受けないようにした。
  14. **Tailscale / PWA**: `hy web --tailscale` は `tailscale ip -4` の IPv4 にだけバインドし、自動オープンを止めて URL を表示する。`manifest.webmanifest`、Apple touch icon、`viewport-fit=cover`、safe-area 対応を追加。トークンは起動ごとに変わるため、スマホは再起動後の URL を開き直す。Tailscale CLI がない / 未ログインなら終了コード 2。この PC は非管理者で Node.js の受信ルールが未登録のため、初回接続時に Windows Firewall の許可が必要。README に昇格 PowerShell の例を記載。
  15. **モバイルレイアウトの崩れ**: 390 px 幅で本文が 64 px に押し込まれ、右パネルが閉じているのに重なっていた。原因は (a) `sidebar-collapsed` の 64 px グリッドがモバイルの 0 px 指定を上書き、(b) 固定配置した sidebar / rightbar により本文が1列目に自動配置、(c) 閉じた rightbar が `display:flex` のまま固定幅で表示、の3点。本文を `grid-column: 2` に固定し、モバイルの全状態で `0 minmax(0,1fr) 0`、rightbar は `right-open` のときだけ `display:flex` にした。実測で本文 390 px・入力欄 366 px・右パネル 359 px を確認。
  16. **自動操作パネルの実機検証**: 自動化を有効にしたサーバーで MCP 34 ツールを起動し、GUI から Playwright の Navigate → Snapshot → Type → Click → Snapshot を実行して `Clicked sakura` を確認。Desktop の Apps で `ok: true`、アプリ一覧を確認。`mcp-call` は `playwright` / `agent-desktop` 以外を 403、未有効化を 400 で拒否することをテストに追加。
  17. **永続PTY**: `node-pty@1.2.0-beta.18` + `@xterm/xterm@6.0.0` を採用。ユーザー選択により SSH は実装せず、永続PTYのみ追加した。`node-pty@1.1.0` は停止時に `conpty_console_list_agent` の `AttachConsole failed` を出す既知の競合があり、beta.18 では再現しなかった。`PersistentPty` は出力 256 KiB を保持し、SSE の snapshot で再接続時に再生する。`stop()` 後に古いプロセスの遅延 `onExit` が新しい PTY を壊さないよう、ハンドラで `this.proc === proc` を確認する。UI は右パネルの見出し折り返しを考慮し、`terminal-wrap` の flex で高さを合わせた。GUI から `echo UI_PTY_OK`、`Set-Location C:\Windows`、`Write-Output ('CWD=' + (Get-Location).Path)` を入力し、`CWD=C:\Windows` を確認。
  18. **最終スコープ確定（2026-11-03、ユーザー承認）**: 永続PTYを実装済みとし、プラグインマーケット / Creator mode、SSH 先での実行、クラウド、マルチユーザー / パブリック公開、IDE 拡張の5項目を対象外として確定した。設計書 §8、`docs/implementation_status.md`、`docs/feature-parity.md` に承認済みとして記録。
  19. **ブラウザ自動操作の既定を Chrome に変更（2026-11-03、ユーザー指示）**: `packages/core/src/config.ts` の既定と Settings の未指定時を `chrome` にした。`automation.browser.browser` を明示している既存設定はそのまま優先される。Chrome 156 で Playwright MCP の起動と `browser_navigate` を確認。
  20. **Windows exe 化（2026-11-03、ユーザー要望）**: `electron-builder` の portable ターゲットを追加し、`release\HY-HARNESS-0.1.0-portable.exe` を生成した。`extraResources` に `hy-exec-server.exe`、`files` に core / seams / hy-cli / desktop / web を指定。`asar: false` と `npmRebuild: false`、`electronFuses.runAsNode: true` を設定した。Playwright / agent-desktop MCP は `ELECTRON_RUN_AS_NODE=1` で Electron の Node モードから起動する。パッケージ版で PTY と Chrome 自動操作を確認済み。コード署名は未設定のため SmartScreen 警告の可能性がある。
  21. **UI 日本語化とトークン表示（2026-11-03、ユーザー要望）**: Settings / 自動化 / Browser / Desktop の固定英語ラベルを i18n 化し、Provider / Model / Base URL / MCP 名などの技術用語だけを英語のまま残した。設定モーダルは背景クリックでは閉じず、ドラッグで誤って閉じない。ヘッダーと入力欄のトークン表示は `k` / `M` の省略をやめ、プロバイダーの `usage` に基づく実測値をカンマ区切りで表示し、直近ターンの in / out も併記する。
  22. **モデル設定の記憶とプリセット（2026-11-03、ユーザー要望）**: Settings → Models に Provider ごとの Preset（DeepSeek / Ollama / Gemini / OpenAI / Mock）を追加し、Worker / Guardian / Grader / Compactor がそれぞれ選択できるようにした。Provider 変更時はモデル・Base URL・API key env を自動入力し、Context window / Max output はモデルごとの読み取り専用値にした。`/model` の切替は新規セッションの既定として `config.json` に保存する。設定モーダルは背景クリックでは閉じず、× / キャンセルで閉じる。API キーは環境変数名と直接キーの両方に対応し、直接キーは `config.json` にローカル保存して環境変数より優先する（可能なら環境変数を推奨）。実際の `%APPDATA%\hy-harness\config.json` は Worker を DeepSeek / `https://api.deepseek.com/v1` に修正し、元ファイルを `.bak-2026-11-02T22-55-17-571Z` に退避した。ヘッダー / 入力欄のトークン表示は `k` / `M` の省略をやめ、プロバイダーの `usage` に基づく実測値をカンマ区切りで表示し、直近ターンの in / out も併記する。設定モーダルは背景クリックでは閉じない。`--mock` では Grader も Mock に固定し、実ユーザー設定の Ollama Grader を呼ばないようにした。
   23. **オーケストレーション入口・思考要約・キャッシュ・OpenCode 対応（2026-11-03、ユーザー要望）**: オーケストレーション開始ボタンをサイドバーの新規チャット横から composer の Plan 隣へ移した。開始時は現在のチャットを変換せず、新しいオーケストレーターセッションを開く。オーケストレーターでは Plan を自動 ON にし、チップを disabled にする。思考ブロックは約4行（`max-height: calc(1.5em * 4)`）でスクロールし、その下に日本語要約を表示する。要約は新設の `summarizer` ロール（未設定時は Worker を継承）が生成し、`assistant/thinking` の seq に紐づけて `thinking/summary` としてログ保存する。usage / cache は `step/end` から再起動後に復元し、`cache H (xx.xx%)` を表示する。OpenCode は `opencode` Provider を追加し、`x-opencode-session: ses_<runId>` と `User-Agent: HY-HARNESS/0.1.0` を送る。既存の `openai-compatible` 設定でも Base URL が `opencode.ai` なら同じヘッダーを付ける。実 DeepSeek API は 503（混雑）で実走できなかったため、OpenAI 互換スタブで 2 ターン・要約・cache 36.36%・再起動復元まで確認した。この時点の exe は `35B6561ACE76634784E5AE2E1E060B6157CA33383986D6256DD3256D8E6B5074` で、G: の配布先と一致する。
   24. **起動時にワークスペース選択ダイアログが毎回出る不具合（2026-11-03、ユーザー報告）**: `%APPDATA%\HY-HARNESS\desktop.json` に `workspaces` の履歴はあったが `workspace` キーが無く、起動のたびにネイティブのフォルダ選択へ落ちていた。`chooseStartupWorkspace()` を追加し、`workspace` が無い場合は `workspaces` の先頭から実在するディレクトリを自動選択する。`--workspace` を明示して存在しない場合は、別フォルダへ勝手に切り替えず従来どおり選択を求める。回帰テスト5件を追加し、単体81件・結合49件成功。パッケージ版を `--workspace` なしで起動し、ダイアログが出ずに G: を開き、`desktop.json` に `workspace` が保存されることを確認した。最新 exe は `C9B958671F6B073AD6C5728B3B66D240D1CC344C246FF5D50F10BC260C810426`。
   25. **思考要約が JSON / 中国語のまま表示される不具合（2026-11-03、ユーザー報告）**: ローカルの `qwen2.5:3b` が `{"思考":"要約: …"}` のような JSON を返し、そのまま表示されていた。`summary-text.ts` の `cleanThinkingSummary()` でコードフェンス・JSON・「要約:」ラベルを剥がし、空の JSON は要約なしとして捨てる。プロンプトを「日本語の平文1〜3文、JSON/Markdown禁止、英語・中国語でも日本語に翻訳」に強化し、かな文字が無い場合は一度だけ翻訳パスを実行する。要約は `<details>` の外に出し、「要約」ラベル付きで常時見えるようにした。既存ログの JSON 要約も投影時にクリーニングする。あわせて、要約モデルが `deepseek-v4.1-flash-free` になっていたため Ollama `qwen2.5:3b` に戻した。無料モデルは外部 API では使えず、Go エンドポイントは 400 `Model is unavailable`、Console エンドポイントは 429 `FreeUsageLimitError`（「Free models work in OpenCode」）を返すことを実測した。単体86件・結合49件成功。最新 exe は `DA72949DEA0E8635A2A3E70E45F1A32CD310BFDF66E15352C052720C673E77C3`。
   26. **Beam Free・ロール別 Effort・設定のホットリロード・思考表示の改善（2026-11-03、ユーザー要望）**: Settings のモデル一覧に `OpenCode · Beam Free`（`beam-free`、context 1,048,576 / output 131,072）を追加し、`providerModels('opencode')` とプリセットにも登録した。Worker / Guardian / Grader / Compactor / Summarizer に Effort セレクトを追加し、`none` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max` を保存できる。Beam Free は `none` / `minimal` を除外し、既定に戻すと設定から effort を削除する。composer の Effort も同じ値に対応した。設定保存時は `loadConfig()` で新しい設定を読み、ロール・承認・Web・メモリ・プラグイン・MCP・maxSteps を実行中プロセスへ反映し、アイドル中の会話を破棄して次ターンにツール/承認/MCP を再構築する。サンドボックスだけは exec client 起動時に固定されるため再起動が必要で、UI にその旨を表示する。思考は既定で折りたたみ、`▼ 思考：要約`（閉時`▶`/開時`▼`の塗りつぶし、ピンク、中黒なし）の1行にした。`instantThinkingSummary()` が思考受信と同時に暫定要約を表示し、LLM 要約が届いたら置き換える。`CompleteOptions.json=false` を追加し、Ollama / OpenAI の強制 JSON モードを要約だけ解除した（これが空の `{}` の原因だった）。バックグラウンド要約にターンの AbortSignal を渡すのをやめ、ターン終了で要約がキャンセルされる問題も修正。思考の口調はシステムプロンプトで「日本語・敬語なし・簡潔」に指定した。単体94件・結合50件成功。最新 exe は `F6366C096FB52F1E58D76B43F970825971DF6599058393C1F353E28334E4790A`。
   27. **チャット削除後に一覧のタブが残る不具合（2026-11-03、ユーザー報告）**: 削除時に実行中ターンを abort しても、そのターンの遅延イベントがログへ書き戻され、`sessionSummary()` が run を再生成していた。`deletedRuns` のトゥームストーンを追加して一覧・`ensureSession` から除外し、`ui-state.json` の `deleted` に保存して再起動後も復活しないようにした。削除直後にログを書き換え、実行中ならターン停止後にもう一度書き換える。実行中チャットを削除して2秒後も一覧に残らない回帰テストを追加。単体94件・結合50件・Web UI 9件成功。
   28. **Orchestrator / Worker / Subagent のモデル分離（2026-11-03、ユーザー要望）**: `HarnessConfig` に `orchestratorRole` と `subagentRole` を追加し、未設定なら Worker を継承、設定時は独立した provider/model/limits/effort を使う。`ConversationOptions.role` と `Conversation.sessionRole` を追加してオーケストレーターのターンだけ別モデルにし、`runSubagent` は `config.subagentRole` を使う。Settings に Orchestrator / Subagent のロール欄を追加し、既存の Worker と合わせて3つを別々に選択できる。セッション状態に `model` を追加し、オーケストレーターのヘッダーと composer が実際のモデルを表示する。単体94件・結合50件成功。最新 exe は `F6366C096FB52F1E58D76B43F970825971DF6599058393C1F353E28334E4790A`。
   29. **新規チャットの遅延作成・削除後の空タブ・OpenAI の max_completion_tokens（2026-11-03、ユーザー報告）**: 新規チャットを押した瞬間に `POST /api/sessions` していたため、空セッションが無限に増え、チャット削除時も `newSession()` が空タブを補充していた。`newSession()` はローカルの下書き状態だけにし、最初のメッセージ送信時に初めてサーバーセッションを作る。最初の送信が失敗したら作ったセッションを削除する。削除後は下書きへ戻るだけで空タブを作らない。あわせて OpenAiProvider が GPT-5/6 系・o 系には `max_completion_tokens` を送り、400 で `max_tokens` 非対応が返った場合は一度だけ自動で切り替える。新モデルでは temperature も送らない。単体94件・結合50件・Web UI 9件成功。最新 exe は `F6366C096FB52F1E58D76B43F970825971DF6599058393C1F353E28334E4790A`。
   30. **オーケストレーション終了・再開始と UI 負荷（2026-11-03、ユーザー報告）**: `stopOrchestration()` で orchestrator と worker を abort するだけで、セッションを閉じていなかった。停止時に `uiState.archived` へ全 run を入れ、`kind='chat'`・planMode 解除・会話を破棄して一覧から消す。UI は停止後に必ず下書きへ戻り、再度開始すると新しい orchestrator セッションを作る。`kindOfRun` / `workerOfRun` は `status==='active'` のときだけ orchestration 扱いにする。「オーケストレーターを開く」は現在のセッションが実行中 orchestrator の場合だけ終了、それ以外は active な orchestrator を開く。停止後の遅延 state が現在セッションを戻さないよう SSE 世代チェックも追加。長い会話の再描画を `requestAnimationFrame` で1フレーム1回にまとめ、要約更新は該当する思考ヘッダーだけを DOM 更新する。state/turn イベントで composer 全体を作り直すのをやめ、busy 表示だけ更新する。単体94件・結合50件・Web UI 9件成功。最新 exe は `F6366C096FB52F1E58D76B43F970825971DF6599058393C1F353E28334E4790A`。
   31. **オーケストレーション操作時に入力不能・赤枠点滅・高 CPU（2026-11-03、ユーザー報告）**: グローバルの `orchestration` SSE ハンドラが、ワーカー更新やハートビートのたびに `renderComposer()` を呼び、入力欄の textarea を作り直していた。フォーカスが失われて入力できず、フォーカス枠が明滅し、長いセッションでは CPU を消費していた。オーケストレーションの `status` / `orchestratorRunId` が実際に変わったときだけヘッダーと composer を作り直し、それ以外はサイドバーとヘッダーだけ更新する。開始時の `renderShell()` も外して二重再構築をなくし、開始・終了の多重クリックをガードした。ブラウザでワーカー追加後も composer の DOM が同一でフォーカスが維持されることを確認。単体94件・結合50件・Web UI 9件成功。最新 exe は `F6366C096FB52F1E58D76B43F970825971DF6599058393C1F353E28334E4790A`。
   32. **オーケストレーターに plan モードの指示が混入（2026-11-03、ユーザー指摘）**: `Conversation.turn` が `planMode` のとき常に `[plan mode: read-only…do not change files until the user leaves plan mode]` をユーザーメッセージ先頭へ付けていた。オーケストレーターは `planOnly` なので毎ターンこれを受け取り、「現在はプランモードなので変更していません」と説明して計画ごとに止まっていた。`planOnly` のセッションではこの前置きを送らないようにし、`prompts/orchestrator.md` を「ユーザーと自然に会話し、方向性が決まったら承認待ちせず最初のタスクを開始、ワーカー報告で自動的に次のタスクへ進む」内容に書き換えた。plan mode / read-only / ツール制限をユーザーに説明しないこと、計画ごとの許可を求めないこと、独立タスクはワーカー上限まで並列化することを明記。`orchestrator_spawn` の説明も「confirmed task」から「runnable task。計画承認を待たない」に変更。単体94件・結合50件・Web UI 9件成功。最新 exe は `F6366C096FB52F1E58D76B43F970825971DF6599058393C1F353E28334E4790A`。
   33. **同一セッションの複数ルート・Guardian 方針・既知バグ（2026-11-04、ユーザー要望）**: `workspaceRoots` を追加し、主ルート `main` と明示追加したルートを同じ run/ログのまま使えるようにした。`%APPDATA%` の `workspaceRoots` に保存し、`/api/workspace/roots` の GET/POST/DELETE と、プロジェクト選択の隣の「ルートフォルダを追加」＋から追加・削除できる。ファイルツリー/検索/読み込みは `root` を受け取り、ツールは `rootId:path` と `apply_patch`/`shell` の `root` に対応。追加ルートは既定で読み取り専用、明示的に書き込み許可した場合だけ `apply_patch`（file + content）で直接書き込む。主ルート以外の書き込みはチェックポイント/undo対象外で、シェル書き込みはサンドボックスに拒否される場合があることを UI に明示した。追加・削除・同名ファイル・ルート外アクセス・会話維持の回帰テストを追加。あわせて Guardian の「unconfined/low-integrity は常に人間の承認、full-auto でも緩めない」を設定画面に明記。OpenAI 互換の空 `reasoning_content` フォールバック、要約の再翻訳後日本語チェック、Windows の CP932 出力デコード、PowerShell 向けシェル説明、ワーカー再開時の古い `lastError` 消去も修正。単体97件・結合52件・Web UI 11件・Rust 19件成功。未完了: 追加ルートのチェックポイント/undo、サマリーの UI ロケール連動、CP932 ページングのマルチバイト境界。訂正（2026-11-04）: 当初は `shell` を主ルート限定として説明していたが、entry 35 で exec-server を複数ルート対応にし、writable な追加ルートでも実行できるようにした。最新 exe は `F6366C096FB52F1E58D76B43F970825971DF6599058393C1F353E28334E4790A`。
   34. **portable exe のビルド停止と 7za 依存の除去（2026-11-04、ユーザー報告）**: 当初は「圧縮用外部プロセス（7za）の権限不足」と説明されていたが、再現した実際の停止原因は、起動中の旧 `HY-HARNESS-0.1.0-portable.exe` が出力ファイルをロックし、electron-builder が `output file is locked for writing` で待機し続けていたことだった。旧アプリを終了してロックを解除するとビルドは再開した。念のため `electron-builder.yml` に `portable.useZip: true` を追加し、portable ペイロードを NSIS の `File /r` で直接埋め込む構成に変更した。これにより 7za の子プロセスは不要になり、`ELECTRON_BUILDER_7ZIP_PATH` を存在しないパスにした状態でも `pnpm desktop:package` が成功することを確認した。ただし `makensis` は引き続き必要で、全外部プロセスを禁止する環境では別の回避策が必要。再発防止として `scripts/check-portable-lock.mjs` を追加し、`desktop:package` / `desktop:package:dir` の前に HY-HARNESS の起動を検出して明示的に失敗するようにした。生成物は 182,360,587 bytes（旧 125,431,386 bytes、NSIS zlib のため約 57 MB 増）、SHA-256 は `180C577BB4A42C9A4A891B8FA0E481B9DA0087B64F242E354A466E306B362568`。G: の配布先と一致確認済み。
   35. **オーケストレーターの「できない」報告と shell 失敗の修正（2026-11-04、ユーザー要望）**: worker の最終報告に `STATUS: done | partial | blocked` と `BLOCKED_BY:` を必須化し、ホストが解析して `blocked` / `partial` を成功扱いしないようにした。未解決ブロッカーはオーケストレーターの全ターンへ1行ダイジェストとして注入し、最終回答で言及されない場合はホストが `[unresolved blockers]` 通知を出す。`orchestrator_close` は blocked / partial / failed / interrupted を summary なしで閉じるのを拒否する。UI に partial / blocker 表示を追加。あわせて実チャット履歴（`session.v1.jsonl`）を解析し、shell 失敗の内訳を確認した。`args` の二重ネストによる invalid arguments が shell で 185 回、追加ルートへの `root` 指定による `cwd must be relative` が 172 回。前者は `normalizeToolArgs` で最大3階層まで安全に展開し、`mcp_call` の正当な `args` は変更しない。後者は、exec-server に `sandbox/add-root` / `sandbox/remove-root` を追加し、`State.extra_roots` と `resolve_cwd` を複数ルート対応にし、workspace-write では追加ルートの ACL を実行時に付与/解除する形で根本対応した。GUI から追加した writable ルートは `shell` の `root` で実行でき、`cwd` はそのルート基準。読み取り専用ルートは shell 不可。ツール説明は `root: workspace root ID (default main)` に変更し、root カタログと UI も追従した。別エージェントの監査も照合し、以下を追加修正した: 主ルート配下の絶対 `cwd` を `normalizeShellCwd` で相対化、CLIXML の stderr を `cleanPowerShellOutput` で整形、`gpt-6.1-terra` で tools 併用時に `reasoning_effort` を送らない（400 時は自動再試行）、`read_file` の root 二重指定を防止して欠損時に search を案内、システムプロンプトに「パスは search で探す」「大きな編集は分割」を追加。状態ディレクトリの累積（758 dirs / 約17.8MB）は運用課題として未対応。ツール説明は 1,188 / 1,200 tokens。単体136件・結合54件・Rust20件成功。最新 exe は `EF354E6209EEB246BE7A307EBDD494F08952AB6F8A52DD45AF46A6E0E2A0B31E`。
   36. **portable exe のセルフアップデート（2026-11-04、ユーザー要望）**: `desktop:package:next` で `release/next` に別名ビルドし、起動中の exe をロックせず更新を作れるようにした。Settings の「再起動して更新を適用」は `update:apply` IPC で `update.ps1` / `update-register.ps1` / 設定 JSON を `C:\Users\Public\hy-harness-update` にコピーし、`Register-ScheduledTask` で **対話セッションのタスク**として登録・実行する。Electron のジョブオブジェクトや展開先 temp の削除で updater が消えない。updater は旧プロセスの終了を待ち、旧 exe をバックアップ、新 exe を差し替え、`Start-Process` で同じワークスペースを再起動し、タスクを削除する。PowerShell 5.1 の `Split-Path -LiteralPath ... -Parent` がパラメーターセット解決に失敗して再起動できなかったため、`[System.IO.Path]::GetDirectoryName` に修正した。候補は `portableDir/next`、`portableDir/update`、`workspace/release/next`、`workspace/release`、`%APPDATA%/update` から選ぶ。staged が final と同じ mtime になり「no staged portable exe found」になる不具合も修正し、`scripts/tag-next-artifact.mjs` が `*-portable-next-<timestamp>.exe` を生成、判定は「内容が異なる」または「staged が新しい」なら許可する。通常の `release` 直下は新しい場合だけ許可し、ダウングレードを防ぐ。失敗時はバックアップから復元し旧 exe を起動する。ログは `C:\Users\Public\hy-harness-update\update.log`。README に手順を追記した。実機で `3B316F49...` から `C77F33C1...` への更新を実行し、置き換え後に新プロセスが起動することを確認した。現在の F: / G: final と staged は `C77F33C13C19D6E398F99BB4FB835FC0340151E033179E4A1E6B2BDDF2ECBB0A`。署名なしのため SmartScreen は残る。単体136件・結合56件・Rust20件成功。
   37. **ワーカーのステップ上限と自動継続（2026-11-04、ユーザー指摘）**: 20ステップは「1ターン内のモデル↔ツール往復」に対する暴走・コスト増の安全弁で、モデル能力の制限ではなかった。ただし実装タスクには低すぎ、上限到達が通常の Error として worker を `failed` にし、オーケストレーターが自動再開しないため作業が止まっていた。`HarnessConfig.workerMaxSteps`（既定400、`--worker-max-steps`、ユーザー設定、プロジェクトの `limits.workerMaxSteps` で変更可）を追加し、通常チャット20・オーケストレーター1000・ワーカーとサブエージェント400に分離した。サブエージェントはワーカーの予算を継承する。オーケストレーターは長期自律実行の主体なので、専用の `orchestratorMaxSteps`（既定1000、`--orchestrator-max-steps`、プロジェクトの `limits.orchestratorMaxSteps`）を設けた。既定400は、ユーザー実測（1ターンで約120回のツール呼び出し）と「200でも足りない」という指摘を踏まえた余裕で、通常作業では到達しない非常停止値として扱う。`Agent.run` の上限到達は `StepLimitError`（履歴と usage を保持）に変更し、`Conversation.turn` が履歴・使用量を確定してから投げ直す。web サーバーはワーカーが上限に達すると同じ履歴のまま1回自動継続し、それでも尽きた場合は `failed` ではなく `partial`（blocker 付き）としてオーケストレーターへ通知する。`orchestrator.md` に「ステップ予算は失敗ではないので短い継続指示を送る」、`worker.md` に「継続時は完了済みの作業を繰り返さない」を追記した。回帰テストとして、設定の既定・ユーザー/プロジェクト/CLI 上書き、`StepLimitError` の履歴・usage 保持を追加。あわせて既存テストの環境依存を修正した（`discoverPinned` のテストが実ユーザーの `%APPDATA%\hy-harness\RULE.md` を読んでいた、`reply-guard` が英文末尾のピリオド直後の JSON を行継続のメソッド呼び出しと誤認していた）。単体168件・結合56件・typecheck 成功。F: / G: の final は `B6B2CCAE6BB06F45C6EA35B676BBB97A381332DC851A057005356C157331C433`、staged は `4AA49CD1E5EAFEA0C150C270342E8DA4DCBAA69EFFB5C2EFB0787697CCF9A71B`。新しい final を起動し、Web UI が応答することを確認した。
   38. **maxOutputTokens のモデル仕様不一致（2026-11-04、ユーザー報告）**: 出力上限に頻繁に当たる原因を調査した。ユーザー設定は `deepseek-v4.1-flash` の全ロールが `maxOutputTokens: 8192` だったが、モデル仕様はネイティブ最大384K（393,216）、OpenCode Go 経由の完了トークン上限は131,072、思考モードの既定は65,536（`effort: max` は131,072）だった。実ログ（728セッション、6,748ステップ）では `outputTokens` が8,192に到達したステップが81回、4,000以上が155回、`turn/retry` は全て `invalid-json` で50回発生しており、思考トークンが8K予算を食い潰してツール呼び出しJSONが途中で切れていた。`config.ts` の OpenCode / DeepSeek 既定と `modelDefaults` を131,072に修正し、既存ユーザー設定の該当ロールとモデルプロファイルも131,072へ更新した（バックアップ `config.json.bak-20261104-080408`）。Web UI のモデルプリセットにも同じ値を反映。モデル仕様の根拠は models.dev（DeepSeek V4.1 Flash: context 1M / output 384K）と OpenCode Go の131,072上限。回帰テストとして OpenCode 既定の `maxOutputTokens` を追加。
   39. **モデル設定値の公式仕様照合（2026-11-04、ユーザー要望）**: 「公式仕様に準拠すると言った値」を全ロール・全モデルプロファイルで再確認した。一次情報は models.dev の API カタログ（`https://models.dev/api.json`）、DeepSeek公式API仕様、Google Gemini の thinking/tokens ドキュメント、Qwen2.5 モデルカード、OpenCode Go の131,072上限に関する GitHub issue。確認結果: OpenCode の `deepseek-v4.1-flash` は context 1,000,000 / ネイティブ出力384,000 / Go上限131,072で、現在値は妥当。Gemini 3.8 Flash は 1,048,576 / 65,536（旧8,192を修正）、GPT-6.1 Terra は 1,050,000 / 128,000（旧128,000 / 8,192を修正）、GPT-4.1 / 4.1 mini は 1,047,576 / 32,768、GPT-4o mini は 128,000 / 16,384、o4-mini は 200,000 / 100,000、Qwen2.5 3B は 32,768 / 8,192（旧4,096）。DeepSeek直APIの `deepseek-flash` はネイティブ 1,048,576 / 393,216 だが、既定の compaction が入力75%で発火するため入力+max_tokensがcontextを超えないよう出力を262,144に制限した。effort は OpenCode DeepSeek の公式値が none/low/high/max のため `xhigh` を `max` に修正し、UIの選択肢も low/high/max（+none）に限定。Gemini 3.8 Flash の effort は `generation_config.thinking_level` として送信するようにした（low/medium/high、minimalは不可）。Ollama は `num_ctx` を送っていなかったため、ロールの contextWindowTokens を実際のリクエストへ反映した。未解決: Kimi K3 は temperature 非対応（temperature:false）だが OpenAiProvider は temperature を送る、Gemini の temperature はアダプタが送っていない、`deepseek-chat` / `deepseek-reasoner` は現行カタログに存在しないレガシー名、MiniMax M3.1 Flash の OpenCode Go 実上限は未確認。これらは使用時までに個別対応する。
   40. **ツール呼び出しJSONの表示切れ（2026-11-04、ユーザー報告）**: 更新後に「json途中打ち切り」が再発した原因を調査した。出力上限ではなく、`agent.ts` がライブUI向け `assistant` イベントの `content` を `truncate(content, 4_000)` で切っていたことが原因。ネイティブツール呼び出しでは `content` が `{"calls":[...]}` のJSON文字列になるため、長い引数（タスク文・パス・コマンド）で4,000文字を超えるとJSONが途中で切れ、UIが解析に失敗して生テキストとして表示していた。ツール自体は完全な引数で実行されており、ログにも完全なJSONが残っている。修正として、ツール呼び出し時は `assistant` イベントにJSONを載せず、構造化された `tool-start` / `tool` イベントだけでカードを描画する。加えて `chat-projection` と Web UI は、解析に失敗した `{"tool"` / `{"calls"` 始まりのテキストを表示しない。回帰テストを追加し、単体・Web UIテスト成功。staged は `BE4ACE1BFB28B5A90CB4C7DA66276F74DC6610AFBE9147B0123903A44C1C590D`。
   41. **ルート直下ファイルのファイルスコープ（2026-11-04、ユーザー要望）**: ディレクトリ単位スコープでは `project.md` / `README.md` などワークスペース直下のファイルをワーカーに編集させられなかった（`normalizeScope` が `.` と `**` を拒否し、`assertWriteScope` はディレクトリ配下のみ許可）。`file:<path>` を正式なスコープとして追加し、単一ファイルだけを所有させる。`file:project.md`、追加ルートは `file:root-2:README.md`。`normalizeScope` / `scopesOverlap` / `workerOwnsScope` / `assertWriteScope` を対応し、`file:docs/a.md` とディレクトリ `docs` は重複、兄弟ファイルは非重複として扱う。orchestrator / worker プロンプト、`orchestrator_spawn` の説明、README を更新。回帰テストを追加。単体216件・結合57件成功。staged は `467830D7AF8453730FBFD7BAC28E1A655F27D3FAA3FC00D45A6C7C73239D5CFB`。
   42. **maxSteps 全廃と DSH 準拠の goal（2026-11-04、ユーザー要望）**: DSH の `packages/core/agent-loop/README.md` は「No built-in turn budget — tool calls or steering continue the current turn」と明記しており、DSH にツール呼び出し回数の上限は無い（`maxParallelToolCalls` は同時並列数、`maxGoalRounds` は自律ラウンド数）。HY-HARNESS の `maxSteps` / `workerMaxSteps` / `orchestratorMaxSteps` / `StepLimitError` / 自動継続 / `--max-steps` 系フラグを全廃し、ターン内は Stop・キャンセル・provider エラー・compaction で制御する。goal は DSH の `dsh-goal` / `dsh-tool-goal` / `dsh-goal-round-driver` / `dsh-command-goal` に合わせ、`GoalStore`（`active` / `paused` / `blocked` / `complete`、revision、`roundsStarted`、既定 `maxGoalRounds: 256`、復元時 disarm）と `goal/change` 永続化、`get_goal` / `create_goal` / `update_goal`、`/goal <objective|pause|resume|clear>`、idle 時の `<goal_round>` 自動実行を追加した。完了は `update_goal complete` を Grader（`graderRole`）が検証し、失敗時は unmet criteria を返して自動継続、3回失敗で blocked。blocked は同一条件3ラウンド連続を要求し、plan mode 中は自動実行しない。resume/fork/再起動後は自動再開しない。UI に phase/round/blocker と pause/resume/clear を追加。テストは GoalStore のライフサイクル・round cap・3回 block・legacy goal/set・再起動 disarm、Web UI の Grader 完了と round cap を追加。単体223件・結合59件成功。ビルド時の注意: Windows Defender が `hy-exec-server.exe` を `Behavior:Win32/Execution.A!ml` と誤検知し、`makensis` が `ERROR_VIRUS_INFECTED`（failed opening file）で失敗する。`F:\HY-HARNESS\target` と `F:\HY-HARNESS\release` を一時除外してビルドし、完了後に除外を戻す必要がある（2026-11-04 に実施）。さらに portable の展開先 temp でも同じ誤検知が再発し、`spawn UNKNOWN` で起動できなくなるため、`hy-exec-server.exe` の **プロセス除外**を追加して起動を確認した（2026-11-04、ユーザー承認済み）。staged は `D333D183739C72E94C2DA4634398DB7515799F7FCECB5920A36D894BD738F60A`。追記: `update:apply` が「実行中と同一内容で mtime が古い staged」を除外した結果、より古い別ビルド（0.1.0）を選び、F: final をダウングレードする不具合を修正した。staged は内容が同一でも常に候補とし、mtime の新しい順で選ぶ。修正版 staged は `5E3BEFDC3EFF3224BFD1B4B57A9E2EEF4565B9A6BBA4C6F50FF8E41D4CAF9353`（F: final / F: next / G: next に同期済み、G: final は起動中アプリの更新で置き換わる）。
   43. **オーケストレーションのレビュー待ちワーカー滞留（2026-11-04、ユーザー報告）**: `orchestrator_workers` が全ワーカーの `task` と最大8,000文字の `lastSummary` を返していたため、長寿命の orchestration（実データで28ワーカー）では一覧が途中で切れ、モデルは「ワーカーが消えた/closed された」と誤読していた。さらに `sendWorker` の即時配送が `{ queued: false }` だけを返し、これを closed と誤読していた。`withOrchestrationDigest` は unresolved blockers しか注入せず、`waiting`（done 報告済み・レビュー待ち）とスコープ保持が見えなかった。`scopeOwners` は `done` 以外の全ワーカーがスコープを保持するため、レビュー待ちの3件が `packages/hy-cli/web` / `packages/hy-cli/src` / `file:package.json` を占有し続けた。修正: (1) `orchestrator_workers` は既定で open worker のみをコンパクトに返し（`status` / `statusLabel` / `reportStatus` / `scopeHeld` / `awaitingReview` / `scope` / `blocker` / `reportPreview`）、closed は最大10件の opt-in、`full` でのみ task と全文を返す。(2) `sendWorker` は `{ delivered, queued, status, scopeHeld, scope, message }` を返す。(3) 全 orchestrator ターンの先頭に全 open worker の digest を注入し、awaiting review の runId と「diff を見て close するか send しろ」を明示する。(4) `closeWorker` は `running` / `queued` の close を拒否（stop を要求）し、スコープ解放後の書き込み競合を防ぐ。(5) 起動時に永続化された `running` / `queued` を `interrupted` に正規化し、プロセス死後の幽霊 running を解消する。既存の起動処理は `blocked` まで `interrupted` に変えてブロッカーを失っていたため、`markStaleWorkersInterrupted` に統一し、`[host restart]` 通知には interrupted だけでなく `waiting` / `blocked` / `stopped` の open worker も列挙して orchestrator のターンを起こす。(6) 再開したワーカーは古い done 報告を消し、running と report done の混在を防ぐ。テスト: `orchestration.test.ts` に stale running/queued の正規化、`web-ui.test.mjs` に compact list・delivery 応答・digest・再起動時の interrupted 化と `[host restart]` 通知を追加。単体224件・結合61件・Web UI 17件成功。あわせて、サイドバーが折りたたまれていても使えるようヘッダーにチャット名変更ボタンを追加し、古い `orchestration-intent.test.mjs`（`activeOrchestratorRunId` / `open`）を現行の `activeRunId` / `open-active` に修正した。staged は `E1FB813AC4C07135ED2C0457C7D8BD3683FF0DA1EC01D691638EA0299DFF5F4D`（F: next / G: final / G: next に同期済み。F: final は起動中の5E3Bがロックしているため、Settings → 更新で置き換える）。
- **2026-11-03 (デバッグ: オーケストレーションと設定の確認)**:
  1. **オーケストレーターがユーザー専用の承認を通していた**: `orchestrator_approve` は要求の内容を見ずに承認しており、unconfined / low-integrity のコマンド、MCP 呼び出し、`web_fetch` もモデルの判断で実行できた（Guardian でも承認できない範囲）。一方、ユーザーがワーカーの承認を送ると 403 で、人が判断する手段がなかった。保留中の承認に要求を記録し、オーケストレーターはユーザー専用の要求を承認できない（拒否はできる）、ユーザーはワーカーの要求を直接判断できるように直した。GUI のワーカーの承認カードにもボタンを出す。結合テストを追加（穴の文書 G15）。
  2. **結合テストが開発者の実設定を読んでいた**: `%APPDATA%\hy-harness\config.json` に GUI から `sandboxMode: workspace-write` が保存されていて、`%TEMP%`（AppData 配下）のフィクスチャで 7 件が失敗した。`tests/integration/isolate.mjs` を `node --test --import` で読み込み、空のユーザー設定ディレクトリを使うようにした（終了時に削除）。
  3. **文書の不一致**: 設計書の「Non-ACL workspaces」は拒否のままだったが、ユーザー決定（ADR 0001 §5.3）で許可に変わっていたので改訂注記を追加。穴の文書で G13 が 2 件あったため、自動実行の項目を G14 に振り直した。
  4. **報告のみ**: この PC のユーザー設定は `autoApprove: true` / `fullAuto: true` で、CLI と GUI のすべての実行が承認待ちのコマンド（unconfined を含む）を自動承認する。ユーザーの設定なので変更していない。
- **2026-11-03 (デバッグ: Desktop GUI の確認)**:
  1. **検証**: Rust 37・単体 70・結合 49 件すべて成功、clippy・typecheck・プロトコル差分 OK、ツールのトークン量 1,143（上限 1,200）。
  2. **Web UI のトークン比較を定数時間に**: Cookie / Bearer / 起動 URL のトークンを `===` で比べていた（Webhook の秘密だけ `timingSafeEqual`）。`--tailscale` で tailnet から届くため `sameSecret()` に統一し、単体テストを追加。
  3. **穴の文書の更新**: G1（`--tailscale` で tailnet に公開されることが未記載で「ローカル専用」のままだった）、G9（端末が永続 PTY になり、ポリシーもサンドボックスも通らない unconfined のシェルになったことが未記載）を直し、G14（Webhook / スケジュールの自動実行が常に `--unattended-ok` を付け、`autoApprove` で `--yes` になる）を追加。G14 の扱いは未決定。
  4. **自動実行を締めた（ユーザー判断）**: `automationArgs()` に切り出し、(a) `--unattended-ok` を付けない、(b) `--trust` は対象がサーバー自身の信頼済みワークスペースのときだけ（以前はサーバーの信頼を別ディレクトリの対象にも渡していた）、(c) Webhook には `--yes` を付けない。単体テスト追加、単体 65・結合 48 件成功。
- **2026-11-03 (デバッグ: 別セッションの変更の確認)**:
  1. **ユーザーのデスクトップ書き換えを撤回**: T5 で入った `ensure_desktop_low_label()` は、confined の起動のたびにユーザーの `WinSta0` と `Default` デスクトップへ Low ラベルと、`ALL APPLICATION PACKAGES` / `RESTRICTED` への `GENERIC_WRITE` を設定していた（失敗は無視、元に戻さない）。設計 §4.2 が避けたセッション全体の副作用で、すべての AppContainer アプリにデスクトップへの書き込みを許すため、ユーザーの判断で専用デスクトップ方式に置き換えた。`CreateWindowStationW` はこのログオンではアクセス拒否だったため、現在のウィンドウステーション内の専用デスクトップに戻る。win10-sandbox と ptc-appcontainer の 14 件はすべて成功。書き換え済みの `WinSta0` はログオフまで残るので、ログオフ後の再確認が必要。
  2. **T1 の不具合**: 50 MB 超の未追跡ファイルを `:(exclude)<path>` で除外していたため、名前の `[ ] * ?` がグロブとして働き、`data[1].bin` を除外すると無関係な `data1.bin` までスナップショットから落ちていた。`:(exclude,literal)` に直し、再現テストを追加。
  3. **性能**: T1 の未追跡ファイル列挙で作成が 625 → 704 ms（目標 750 ms 未満は維持、余裕は 6 %）。
- **2026-11-03 (未完了項目の完遂フェーズ T1〜T8)**:
  1. **T1（50 MB 超未追跡ファイルの除外と `unprotected` 保持）**: `crates/hy-exec-server/src/checkpoint.rs` に `DEFAULT_MAX_UNTRACKED_BYTES = 50 * 1024 * 1024` と `stage_worktree` を実装。`ls-files -z -o --exclude-standard` で列挙した未追跡ファイルのうち閾値超えのものを `:(exclude)<path>` で `git add -A` から除外し、`CheckpointCreateResult.unprotected` と `<label>.meta.json` に記録。ロールバック時は `meta.unprotected` に含まれる既存の巨大未追跡ファイルを削除対象から外して保護することを単体テストで検証した。
  2. **T2（`$/cancelRequest` と `AbortSignal` による in-flight 中断）**: `server.rs` で `tokio::sync::watch::Receiver::wait_for` を `tokio::select!` 内で直接使うと内部の `RwLockReadGuard` により `!Send` コンパイルエラーとなる問題が発生。`rx.changed().await` を使う `wait_cancelled` ヘルパー関数に切り出して解決した。クライアントの `ExecRpcClient.call()` に `signal?: AbortSignal` を追加し、中断時に `$/cancelRequest` を送信してデーモン側の Job Object や AppContainer ワーカーを即座に kill し `-32005`（`CANCELLED`）を返すようにした。
  3. **T3（`cordis` サービスラッパー）**: `packages/core/src/cordis.ts` に `HarnessContext` を実装し、`execRpc`・`sessionLog`・`ledger`・`spillStore`・`tools`・`contextManager`・`modelRouter` の登録と `stop()` 時の逆順クリーンアップを `cordis.test.ts` で検証し、CLI の `Conversation.create` と `ralph` に接続した。
  4. **T4（Rust カバレッジ測定）**: `cargo-llvm-cov` ラッパーバイナリなしでも Rustup 同梱の `llvm-tools-preview`（`llvm-profdata` / `llvm-cov`）と `RUSTFLAGS="-C instrument-coverage"` で直接測定できる `scripts/coverage-rust.mjs`（`pnpm coverage:rust`）を作成。`patch.rs`、`cmdline.rs`、`token.rs` に単体テストを追加し、純粋ロジック合算で **行 89.2 %（`1907/2137`）・領域 88.6 %（`3277/3699`）**（全対象モジュールが個別に 85.7 % 以上）を達成した。
  5. **T5 & Desktop Mandatory Label 欠落による `0xC0000142` の原因究明と対策**: `oq2_esbuild_npm.mjs` および `win10-sandbox.test.mjs` の実行時、`cmd.exe` は `exit=0` で動く一方、`node.exe`・`powershell.exe`・`whoami.exe` が Low 整合性トークン下で `-1073741502`（`0xC0000142` `STATUS_DLL_INIT_FAILED`）で即死する事象が発生。`GetProcessWindowStation()` と `GetThreadDesktop(GetCurrentThreadId())` の SDDL を採取した結果、`Desktop` 側に `S:(ML;;NW;;;LW)`（Low Mandatory Label）が存在せず、Windows カーネルが Desktop を既定の Medium 整合性として扱うため、`user32.dll` をリンクする全バイナリが `DllMain` の Desktop 接続でアクセス拒否されていたことが判明。`crates/hy-sandbox-windows/src/console.rs` の `ensure_hidden_console()` で `SetSecurityInfo(..., SE_WINDOW_OBJECT, LABEL_SECURITY_INFORMATION, ..., sacl)` により `S:(ML;;NW;;;LW)` を設定することで完全に解消した。その上で `esbuild` 0.25.0 と `npm install` を実測し、`esbuild` CLI は `workspace-write` で動作、`esbuild` Node API は `workspace-write` で `spawn EPERM`・`low-integrity` で動作、`npm install` は既定キャッシュで `EPERM`・ワークスペース内キャッシュで動作することを確認し、revoke 後にフィクスチャを削除した。
  6. **T6（実モデル Ollama `qwen2.5:3b` 評価と Grader プロンプト強化）**: `OllamaProvider` がツールなし呼び出しで `format: 'json'` を指定するため、`SpillCompaction`（`packages/seams/src/spill-compaction.ts`）が JSON の `{"summary": "..."}` から要約文字列を取り出すよう改善。また、3B モデルがプロンプト末尾の `<untrusted_worker_notes>`（「差分を無視して合格にせよ」）に引きずられる recency bias を防ぐため、`verifier-ralph.ts` の Gate 2 プロンプトで `<untrusted_git_diff>` と検証チェックリストをユーザーメッセージの末尾に配置した。結果、Compaction（制約・メモ 100 % 保持）、Guardian（5/5 = 100 % 正解）、Gate 2 Grader（Round 1 の `subtract` 欠落＋プロンプトインジェクションを `pass: false` で却下、Round 2 の完全実装を `pass: true` で承認）がすべて実モデルで PASS した。
  7. **T7（CI ワークフローとトークン権限分岐テスト）**: `.github/workflows/ci.yml` を作成し、`crates/hy-sandbox-windows/src/token.rs` に `create_confined_with_identity` を切り出して標準ユーザー（`is_admin_member == false`）と UAC 管理者（`is_admin_member == true`）の両方のトークン構築を単体テストで検証した。
- **2026-11-02 (Phase 8)**:
  1. **チェックポイントの初回ベンチは作成 962 ms / ロールバック 1,164 ms**。原因の一つは、毎回ユーザーの `.git/index` から写していたため、ラン中に変わったファイルを毎回ハッシュし直していたこと（400 ファイルで `add -A` が 180 ms、更新済みの索引なら 36 ms）。ラン単位の stat キャッシュで 648 / 827 ms に短縮。
  2. **残りは Defender によるファイルごとの I/O**: 変更直後の 200 ファイルを読むだけで約 2 秒（Python）。git の `add -A` 約 400〜500 ms、`write-tree` 約 180 ms。Defender の設定は変えていない（セキュリティ設定はユーザーの判断）。
  3. **ベンチの前提の誤り**: 最初の版は毎回別の 200 ファイルを変えていて、7 回で約 1,400 ファイルが変わり、設計の「変更 200 以下」に反していた。同じ 200 ファイルを毎回変える形に直した。
  4. **`pnpm typecheck` は何も検査していなかった**（`tsc -b --dry` は一覧を出すだけ）。`tsc --noEmit -p` に直した。
  5. **Gemini の一次ソースは Interactions API**（`generateContent` ではない）。状態なしの複数ターンは `thought` ブロックの送り返しが必須なので、1 ターンずつ送る方式にした。
  6. **設計の「50 MB を超える未追跡ファイルを除外」は未実装**だったので、穴として記録した。
  7. **ロールバックの高速化（827 → 265 ms）**: 作業ツリーを再スナップショットせず、作成時の索引の写しを `update-index --refresh` → `diff-files` / `ls-files -o` で比べる。最初は `ls-files -t -m -d -o` の 1 回で済ませたが 533 ms で、`ls-files -m` が 1 万エントリを 1 件ずつ stat していた（370 ms。`diff-files` は 85 ms）。削除を先にして、ファイルとディレクトリの入れ替わりも戻せるようにした。
  8. **作成の目標を改訂（2026-11-03）**: 作成は変更ファイルのハッシュと loose object の書き込みが避けられず、Defender のスキャンがファイルごとにかかるため、500 ms には届かなかった。ユーザーの判断で作成を 750 ms 未満（実測の中央値に 約 15 % の余裕）に改め、ロールバックは 500 ms 未満のまま。ベンチは作成とロールバックで別の目標を持つ。
- **2026-11-02 (Phase 7)**:
  1. **`claim_complete` を ralph でだけ直接呼べるツールにした**: 設計では `run_code` の SDK だけだが、それだと `--ptc` なしの小規模モデルは宣言できず、毎ラウンド stalled になる。`hy run` には出さない。
  2. **Gate 2 を既定で実行**（Goal 4）。従来の `--grader`（任意）は `--no-grader`（省略）に置き換えた。
  3. **Guardian が予算切れを「拒否」として飲み込んでいた**: `AbortRunError` はそのまま投げ直すようにした。
  4. **Ollama での実走**: 3 回中 1 回、ラウンド 1 が最初のモデル呼び出しの前後で中断された（原因は記録できず、再現しなかった）。中断理由を CLI に出すようにした（以前は「aborted」だけだった）。
- **2026-11-02 (Phase 6)**:
  1. **`seq` がセッションごとに 1 から始まっていた**: 設計は「ログファイル単位で単調増加」で、Ledger の順序付けがそれに依存する。`SessionLog` がファイルの最後の `seq` から続けるように直し、同じプロセス内の複数インスタンスでも共有するようにした。
  2. **層の向き**: エージェントのループは `core`、Spill / Compaction は設計上 `seams`。`seams` は `core` に依存するので、`core` に `ContextManager` インターフェースを置き、`seams` が実装する形にした。
  3. **SDK のトークン量**: `tools.rationale.*` を足して 1,049 トークンになったので、繰り返し出てくる型を `type Job` / `type NoteCount` として 1 回だけ宣言する形にし、989 に減らした。
  4. **ヒアドキュメント経由の Python 置換で `\n` が実際の改行に化ける**ことが何度かあった。エスケープを含む置換は Edit か、スクリプトファイル経由で行う。
- **2026-11-02 (Phase 5 の残り)**:
  1. **Windows PowerShell 5.1 の `#< CLIXML`**: 出力をリダイレクトすると、モジュールの初回読み込みなどの進捗が CLIXML として stderr に出て、すべてのシェル経由のコマンドの出力を汚していた。`$ProgressPreference = 'SilentlyContinue'` を前に付けて解決（`tools.jobs` のテストで発見）。
  2. **トークン量の測り方**: プロバイダーのプレフィックスキャッシュで 2 回目の `prompt_eval_count` が小さくならないよう、プロンプトの先頭に毎回ランダムな文字列を入れて、ツール部分の有無の差を取る。
- **2026-11-02 (Phase 5 の AppContainer 化)**:
  1. **AppContainer の `CreateProcess` は `LOCALAPPDATA` が必要**: 環境変数を空に近くすると `ERROR_ENVVAR_NOT_FOUND`（203）で失敗する。`USERPROFILE` や `TEMP` では直らず、`LOCALAPPDATA` だけで直る（実測）。Windows がコンテナ専用ディレクトリと `TEMP` をここから導くため。
  2. **二重の防御**: ファイルとプロセスの起動は Node の `--permission` が先に止め、ネットワークは AppContainer が止める（Node 24 の permission model はネットワークを扱わない）。
  3. **ワーカーの配置**: AppContainer は F: の exFAT も通常のユーザーディレクトリも読めないので、ワーカーを `%USERPROFILE%\.hy-harness\ptc-runtime` にコピーし、`ALL APPLICATION PACKAGES` に読み取りを許可した。
  4. **サブ呼び出しの中の `AbortRunError`**（Guardian の 3 回拒否）は、スクリプトの中の例外として握りつぶされないよう、`run_code` の外へ投げ直す。
- **2026-11-02 (Phase 4)**:
  1. **`std::fs::canonicalize` の `\\?\` 接頭辞**: cmd.exe は `\\?\C:\…` を作業ディレクトリにできず、SID の導出も表記に依存する。サンドボックスでは接頭辞を外した形を使う。
  2. **confined の `.cmd` / `.bat`**: Rust std の BatBadBut 対策は `CreateProcessAsUserW` の手組みのコマンドラインでは使えない。confined ではシェル（pwsh / Windows PowerShell）経由で起動する。
  3. **保護された `.git` は SID を名指しする「拒否」ACE を持つ**: `.git` の検査は「許可」ACE か Low ラベルを見る（SID を含むかどうかでは誤検出する）。
  4. **既定の承認の変更**: これまでは `--yes` がなければ常に標準入力で尋ねていた（端末がなくても）。今は `--yes` → Guardian → 端末があればユーザー、なければ理由付きで拒否。
  5. **ACL の変更はテストのフィクスチャ（`%USERPROFILE%\hy-it-*`）と、ユーザーが `--sandbox` で指定したワークスペースにだけ行う**。結合テストは revoke してから削除し、終了後に `hy-it-*` と専用 temp が残っていないことを確認した。
- **2026-11-02 (Phase 1 スパイク)**:
  1. **`%TEMP%` はフィクスチャに使えない**: このマシンの `%USERPROFILE%\AppData` と `AppData\Local` はパッケージ SID（`S-1-15-2-…`）の ACE を持ち、Low 整合性のトークンはそれを開けない（`lstat` も `EPERM`）。Node の `realpath` が失敗する。フィクスチャは `%USERPROFILE%\hy-spike-fixture` に置いた。
  2. **`shutil.rmtree(ignore_errors=True)` が git の読み取り専用ファイルを残し、前回のフィクスチャが混ざった**: 読み取り専用属性を外して消す `rmtree` に替え、残ったら止まるようにした。
  3. **下書き `console.rs` のバグ**: `CREATE_NO_WINDOW` で起動されたプロセスはコンソールはあるがウィンドウがない。`AllocConsole` の `ERROR_ACCESS_DENIED` を「既存のコンソールあり」として扱うよう修正。
  4. **walker の復元バグ**: `SE_DACL_AUTO_INHERITED` は `SE_DACL_AUTO_INHERIT_REQ` と一緒でないと落ちる。ラベルの削除は `S:NO_ACCESS_CONTROL` になる。修正後、付与 → 取り消しで SDDL が一致。
  5. **AppContainer の Node**: `C:\` を `lstat` できないので `--preserve-symlinks-main` が必要。pipe 付きの `spawnSync` はハングし、自身の timeout も効かない（Job のタイムアウトで終了）。
  6. 安全のため、ACL の変更はスパイクが作ったフィクスチャ（`assert_fixture` で強制）にだけ行い、終了後にフィクスチャ、AppContainer プロファイル、プローブのファイル、HKCU キーが残っていないことを確認した。
- **2026-11-02 (実装)**:
  1. **F: の exFAT で pnpm が `EISDIR`**: シンボリックリンクを作れない。`.npmrc` に `node-linker=hoisted` を書いて解決。
  2. **TypeScript 7 はネイティブ版**: JS の API の互換性が不明なので 6.0.3 に固定。
  3. **cordis 4.0.0-rc.12**: サービスは `ctx.provide(name, value)` で登録する（`ctx.set` は事前の provide が必要）。
  4. **Windows サンドボックスの実装が安全性チェックで停止**: ACL の付与とプロセス起動の 2 回。`hy-sandbox-windows` はワークスペースから外し、未完成のまま残した。
- **2026-11-02 (開始)**: ワークスペース `g:\マイドライブ\HY-HARNESS` が空であることを確認。`project.md` を作成し、`deep_research` プロトコルに基づく調査を開始。
- **2026-11-02 (0周目)**: 日本語圏担当（`2140b803-0555-471b-8b44-53be1db6e14f`）と英語圏担当（`5df3595f-8f21-43ae-a0cf-94006f3cd4a3`）の2本のサブエージェントを `Model: 'flash'` で並行実行し、初期の用語・人・場を `map.md` に記録。
- **2026-11-02 (1周目・一次資料取得時のエラーと対策)**:
  1. **デフォルトブランチ差異による HTTP 404 対策**: `deepseek-ai/deepseek-harness` は `main` ではなく `master` ブランチがデフォルトであったため、Raw URL を `master` に切り替えて取得（`dsh-superagent-prototype` と `openai/codex` は `main`）。
  2. **`fetch.py` の文字数下限（`MIN_HTML_CHARS = 1000`）対策**: 1,000文字未満の短いリンク集ファイル（`docs/sandbox.md` 150文字）や再エクスポート用モジュール（`guardian_review.rs` 720文字）は `fetch.py` がエラー終了するため、リンク先の実体ファイル（`codex-rs/core/README.md`, `codex-rs/linux-sandbox/README.md`, `codex-rs/core/src/guardian/review.rs` 等）を特定して取得。
  3. **Windows PowerShell コマンドライン長制限対策**: `python -c "..."` に巨大な JSON リテラルを直接埋め込むと Windows のコマンドライン長上限（`The filename or extension is too long`）に達するため、構造化データは必ず `write_file` ツールで直接ファイルへ書き出してから検証スクリプトを実行することとした。
  4. **`report.py` 抜き書き照合の厳密化**: `report.py` の `verify()` は指定行番号の前後2行のテキストと完全一致（空白正規化後）を検査し、途中省略には `…`（1文字の三点リーダ）のみを受け付ける。`extracts.json` の全29箇所を原文ファイルと照合し、`照合 OK: 抜き書き 29 件がすべて原文のとおり` を達成。
- **2026-11-02 (Rev 3 裏取り時の問題と対策)**:
  1. **F: は exFAT、G: は FAT32（Google ドライブ）**: どちらも ACL とハードリンクを持たない（`fsutil hardlink` は "Incorrect function"）。サンドボックスとチェックポイントの実験・テストは C: などの NTFS 上で行う。
  2. **`python -I` では `PYTHONIOENCODING` が無視される**: Windows コンソールの cp932 で `UnicodeEncodeError` になる。スクリプト内で `sys.stdout.reconfigure(encoding="utf-8")` を呼ぶ。
  3. **JS で描画される文書ページ（ai.google.dev）は本文が取れない**: `<URL>.md.txt` を取得する。移転済みのページは移転先（例: thought-signatures → thinking）を取る。
  4. **GitHub raw のパス移動で 404**: Cargo の fingerprint は `src/compiler/fingerprint/mod.rs`、Rust std の子プロセス用パイプは `library/std/src/sys/process/windows/child_pipe.rs`、git の RelNotes は `.adoc`。`api.github.com/repos/<o>/<r>/git/trees/<branch>?recursive=1` で探すと早い。
- **2026-11-02 (`/egm-brainstorm` 実施と v2.0 反映)**:
  - ユーザーの環境（Windows 10）と要件に基づき、Goldfish 6レンズで浮上した3大 Blocker（①Win10 Restricted Token 下での名前付きパイプ `EPERM` と `STATUS_DLL_INIT_FAILED` 対策としての明示的 Pipe/`WinSta0` DACL 付与、②Node `vm` プロトタイプ脱出を防ぐための `run_code` サブプロセス隔離、③モデル自律更新 `Rationale Ledger` の $K=12$ 上限設定）を `concepts_brief.md` と `docs/designs/hy-harness-implementation-plan.md` (v2.0) に反映。
- **2026-11-02 (MVP 実装)**:
  1. **`hy-exec-server` を完成**: `initialize`、`policy/evaluate`、`exec/command`（サーバー側ポリシー強制、前景→背景、Job Object / `taskkill`）、`patch/apply`（unified diff、CRLF/BOM 保持、文脈アンカー、失敗時の巻き戻し）、`checkpoint/create|rollback|diff|prune`、`sandbox/status` を実装。`main.rs` から全モジュールを接続。
  2. **TypeScript コントロールプレーンを実装**: `config`、`exec-rpc`、`session-log`、Ollama / OpenAI 互換 / Mock の LLM プロバイダー、`read_file` / `apply_patch` / `shell` / `run_code` のツールランタイム、JSON アクションのエージェントループ、`hy run` / `hy ralph` / `hy undo` / `hy sandbox status` / `hy policy-test`。
  3. **小規模モデル対策**: `apply_patch` に `{file, content}` の全体書き込みフォールバックを追加。`run_code` は `--ptc` 時だけプロンプトに表示。
  4. **検証**: `cargo test --workspace` 24 件成功、`cargo clippy --workspace --all-targets -- -D warnings` 警告なし、`pnpm build` 成功、`pnpm test:integration` 4 件成功。Ollama `qwen2.5:3b` で `hy run` と `hy ralph` の実走に成功。
  5. **環境の差分**: ドキュメントにあった Node 26.13.0 と pwsh 7.6.9 は `%LOCALAPPDATA%\hy-harness\tools\` に存在しなかったため、PATH の Node 24.19.0 と Windows PowerShell 5.1 で動作を確認した。DeepSeek のキーはあるが API が残高不足（HTTP 402）を返すため、既定は Ollama にした。
- **2026-11-03 (UI Unslop — 9パス全面適用)**:
  1. **方針**: 既存の桜色（White Sakura / Night Sakura）サーフェスパレットを維持したまま、`unslop` スキルの9パス（Spacing, Color, Icons, Copy, Type, Layout, Details, Visuals, Motion）を全面適用（方向性: *Crisp Sakura Workbench*）。
  2. **実施内容**:
     - **Spacing / Layout**: サイドバー幅 `264px`・右パネル幅 `400px`・全ヘッダー高 `56px`・余白/角丸を `4px` グリッドに統一。ツールカード・プランカードの `margin-left: 42px` や `.new-chat.verifier` の `-4px` 負マージンを撤廃。`.icon-btn.mobile-only` の詳細度を修正し、デスクトップ展開時のサイドバートグルアイコン重複を解消。
     - **Color**: 背景の放射状グラデーション（radial-gradient blob）、斜めグラデーション塗り、カラーグロー（`--accent-glow`）、内側白ハイライトを全廃。テキスト階層を3段階（`--text`, `--text-2`, `--muted`）に統合し、ライトモードのプライマリアクセントを `#c93b6b`（白文字コントラスト比 $5.12:1 \ge 4.5:1$）に調整。
     - **Icons**: `sparkles` アイコンを全廃し、文脈に応じた `pin`・`target`・`book`・`shield`・水平 `send`（`16px`, `stroke-width="1.5"`）に統一。
     - **Copy / Type**: 空状態の定型挨拶（`何を作りますか？`）を左揃えのワークスペース・コンソール（`ワークスペース準備完了` + 4セルの `.console-card` ステータス表示）に刷新。17種あった端数フォントサイズを5段階（`12px`, `13px`, `14px`, `16px`, `20px`）・ウェイト3種（`400`, `500`, `600`）に整理し、`text-transform: uppercase` を全廃、数値・メタ情報に `tabular-nums` を適用。
     - **Details / Motion**: 冗長なアバター枠（`HY`/`U`）と `FINAL` バッジ、偽ショートカット `<kbd>Ralph</kbd>` / `<kbd>Tasks</kbd>` を撤廃。`grid-template-columns` のレイアウトトランジションを除去し、`--ease: cubic-bezier(0.22, 1, 0.36, 1)` と `prefers-reduced-motion` 対応に統一。
  3. **検証**: `pnpm build`、`pnpm typecheck`、`pnpm test`（63件 pass）、`node --test tests/integration/web-ui.test.mjs`（7件 pass）、`pnpm desktop:screenshot` による Electron 実画面キャプチャ検証を完了。

## 5. 2026-11-04 の作業（壊れたワーカー報告・無限リトライ・応答中メッセージ予約）
native 関数呼び出しモードで表面化した 2 件の不具合を直し、ターン実行中のメッセージを捨てずに順次実行する仕組みを足した。

## 5.1 壊れた擬似ツール呼び出しの防御
- **症状**: native 関数呼び出しモードで、モデルが本文に書いた壊れたツール呼び出し（閉じていない JSON、チャットテンプレートの閉じタグ混入）が、そのまま最終回答としてユーザーに見えていた。
- **修正**: `packages/core/src/reply-guard.ts` の `looksLikeBrokenToolCall` を強化。閉じ括弧の対応付けを 1 パスに変更し（`closingBraces`）、未閉塞の断片は最初の 1 回だけ判定するようにした（`sawUnclosed`）。`</tool_call>` と `</function>` を閉じタグ断片に追加。フェンス内とインラインコード内は除外する。
- `packages/core/src/prompt.ts` の native 分岐 Rules に「本文に `{"tool":...}` や `{"calls":[...]}` を書くな、最終回答は素の文章で書け」を明示した。
- **性能**: `'{"'` を 50,000 個並べた入力が 10.8 秒 → 4ms（旧実装は `{` ごとに再スキャンする O(n^2)）。
- **テスト**: `reply-guard.test.ts` 31 件。

## 5.2 native モードの空応答で無限リトライ
- **症状**: モデルが reasoning だけを返して本文が空になると、`agent.ts` の native 分岐が `native && content` で弾かれ、テキストプロトコル用の「JSON を返せ」リトライが送られ続けた。native のモデルはこの文言に従えず、同じ空応答を繰り返して無限ループになった。画面には「retrying (invalid response)」が並び続けた。
- **修正**: `packages/core/src/agent.ts` の `if (!action && !calls)` の先頭に native 早期分岐を追加（条件 `native && !content`）。1 回目は「関数呼び出しでツールを呼ぶか、終わっていれば平文で要約しろ」と返し、2 回目は `The model returned an empty reply twice. No changes were made.` で打ち切る。フラグ `emptyReplied` はループ外に置く。
- 併せて `retry` イベントに `reason` を載せた（`broken-tool-call` / `empty-reply` / `invalid-json` / `final-schema` / `missing-tool-or-final` の 5 箇所）。UI の表示が「retrying (invalid response)」から具体的な理由に変わった。
- **テスト**: `agent.test.ts` に 3 件追加（2 連続空応答、1 回だけ空応答、テキストプロトコルの invalid-json 維持）。

## 5.3 応答中メッセージ予約
- **目的**: ターン実行中に送られたメッセージを捨てずに予約し、完了後に自動で順に実行する。
- **実装（永続 FIFO）**: `packages/hy-cli/src/turn-queue.ts`（456 行、テスト 22 件）。`turn-queue.json` に原子的に保存する。クラッシュ時の実行中ターンは `uncertain` として保持し、ユーザーの明示的な判断なしに再送しない。失敗・キャンセル時は `paused` にして自動再開しない。復元時も `paused` から始まる。
- **実装（純粋関数）**: `packages/hy-cli/src/turn-queue-view.ts` に `turnQueueView` と 4 つの `parse*Request`。テスト 36 件。
- **実装（サーバー）**: `web-server.ts` に 5 エンドポイント（`GET /api/turn-queue`、`POST /api/turn-queue` / `cancel` / `resume` / `resolve`）。既存の送信 API は busy 時に `queue: true` が付いていれば 202 で積み、付いていなければ従来どおり 409。`applyTurnQueue` は `saveTurnQueue` 成功後にだけメモリを差し替える。
- **実装（UI）**: `packages/hy-cli/web/src/` に `renderTurnQueueHtml` / `sendIntent` / `queueBadgeLabel`、型、API ラッパ、i18n 3 言語、CSS、`app.ts` 配線。ポーリングは追加せず、送信後・取消後・ターン完了イベント時のみ再取得する。
- **テスト**: web 側 18 件。

## 5.4 再発しうる問題と対策
- **Low 整合性トークン下でのテスト実行**: このエージェントのシェルは Low 整合性（`S-1-16-4096`）で動く。OS が (a) `stdio` に pipe を含む `spawn`、(b) `os.homedir()` 配下への書き込み、(c) `spawnSync` を拒否する。実測: `stdio: 'ignore'` と `'inherit'` は成功、`'pipe'` は EPERM。`fs.mkdtempSync(os.tmpdir())` は成功、`os.homedir()` は EPERM。
- **影響**: `pnpm test:integration` の 17 ファイルはテスト本体が起動できず全滅する。`core` の `lsp.test.js` / `mcp.test.js` も EPERM で落ちる。
- **回避**: `--test-isolation=none` を付けるとテスト本体は起動でき 57 テストが走るが、テスト自身が子プロセスを起動するため大半は EPERM のまま（唯一 `tool-overhead` だけ pass）。完全に回避するには unconfined 環境で `pnpm test:integration` を実行する。
- **`tsc -b` のインクリメンタル判定**: 変更が無いプロジェクトは再出力されないため、`dist` の `LastWriteTime` が今回のビルド時刻にならないことがある。内容が最新かは grep で確認する。

## 5.5 検証結果（2026-11-04）
- `pnpm build` exit 0（5.1 秒）、`pnpm typecheck` exit 0。
- `hy-cli` 90 件 pass、`seams` 22 件 pass、`core` 98 件中 95 pass。
- `core` の失敗 3 件（lsp 1 / mcp 2）と `test:integration` 17 ファイルは上記の Low 整合性による EPERM。
- 修正 5 項目が `dist` に載っているのを grep で確認（`closingBraces` / `never write JSON such as` / `emptyReplied` / `turn-queue` / `refreshTurnQueue`）。

## 5.6 2026-11-04 追加作業（hy-exec-server マルチバイト境界切断・文字化け修正 & 版番号整合 & 全面検証）
- **背景・症状**:
  - `crates/hy-exec-server/src/jobs.rs` の `clip()` および `output()` において、固定バイト数（`RESULT_HEAD` = 10,000 / `RESULT_TAIL` = 20,000、ページング `max`）で単純スライスを行っていた。
  - UTF-8（3〜4バイト）や CP932（2バイト）の文字途中が切断されると、`decode_output` 内でデコードに失敗し、`U+FFFD` や Shift_JIS 誤判定による文字化け（例: `縺めE...`）が発生していた。
- **修正内容**:
  1. `complete_prefix_len(bytes: &[u8]) -> usize`:
     - UTF-8: `std::str::from_utf8` の `error_len().is_none()` を検出し、末尾の不完全コードポイントを除いた完全文字境界バイト長を返す。
     - CP932（Windows）: 1バイト目（`0x81..=0x9F`, `0xE0..=0xFC`）を順次スキャンし、末尾に孤立した lead byte を除外。
  2. `align_tail_start(bytes: &[u8], raw_start: usize) -> usize`:
     - テイル側の開始位置が継続バイト（`0x80..=0xBF`）または CP932 2バイト文字の途中に落ちている場合、次の完全文字の先頭バイトまで進める。
  3. `clip()`:
     - head 側を `complete_prefix_len`、tail 側を `align_tail_start` でアラインしてから結合・切り詰め。
  4. `Job::output()`:
     - ページング時に EOF 未満かつ末尾がマルチバイトの途中で切れている場合、`complete_prefix_len` で切り詰めて `next_offset` を補正。次ページが文字先頭から安全に開始されるように修正。
  5. 版番号整合: ルート `package.json` の版番号を `0.1.1` に同期。
- **検証結果**:
  - `cargo test -p hy-exec-server --bin hy-exec-server jobs::`: 6 件全件 PASS（UTF-8/CP932 のプレフィックス・クリップ回帰テストを含む）。
  - `cargo test --workspace`: 44 件全件 PASS。
  - `pnpm build` / `pnpm typecheck`: exit 0。
  - `pnpm test`: 224 件全件 PASS。
  - `pnpm test:integration`: 60 suites / 60 pass / 0 fail。
- **未完了**:
  - 実画面での予約 UI の確認（Electron / ブラウザでのバッジ表示、取消、再開、結果不明の解決）。

## 5.7 2026-11-04 デバッグ（実行デーモンの鮮度・ジョブ出力の文字化け・ゲートの穴）
- **発端**: 既存のテストはすべて緑（Rust 44 / 単体 224 / 結合 61）だったが、最新機能のターンキューには結合テストが 1 件も無く、`pnpm test` は Web UI の 50 テストを実行していなかった。実際の HTTP API と実行デーモンを動かして検証した。
- **見つけた不具合と修正**:
  1. **結合テストが古い実行デーモンを叩いていた（偽の緑）**: `pnpm test:integration` は `target/debug/hy-exec-server.exe` を使うが、`cargo test` はその exe を作らない。前節の `jobs.rs` 修正後も 20:45 ビルドの exe が使われ、修正が検証されていなかった（修正前の exe では下記 2 が再現する）。`tests/integration/fresh-build.mjs` を追加し、Rust ソース（`crates/**/*.rs`, `Cargo.toml`）がデーモンより新しい場合と、TypeScript ソースが `dist` より新しい場合は、`pnpm test:integration` を明示的なメッセージで停止するようにした（`HY_ALLOW_STALE_BUILD=1` で意図的に回避可）。
  2. **ジョブ出力ページの文字化け（実バグ）**: `Job::output` は「ページがログ末尾に届いていない」ときだけ文字境界に切り詰めていた。ジョブ実行中は現在の末尾が確定位置ではないため、64 KiB のページが文字の途中で終わり、`decode_output` が UTF-8 検証に失敗してページ全体を Shift_JIS として読み、日本語出力が `縺ゅ＞…` になっていた（実測: 450,000 バイトの出力で全ページ文字化け）。`page_bytes(data, at_authoritative_end)` を追加し、実行中（またはログ末尾未到達）は必ず文字境界で切るように修正。確定末尾（終了済みジョブ）でのみ切り詰めない。単体テスト 3 件と結合テストを追加（修正前の exe で失敗することを確認済み）。
  3. **不正な JSON ボディが 500 になっていた**: `readJson` が `[]` や壊れた JSON で throw し、リクエスト全体の catch が一律 500 にしていた。`HttpError`（400 / 413）を導入し、`error instanceof HttpError ? error.status : 500` に変更。ターンキューのパーサーが持っていた「body must be a JSON object」の 400 分岐は実際には到達不能だった。
  4. **`job/output?offset=abc` が 500**: `Number('abc')` → `NaN` → JSON の `null` になり、デーモンの u64 パラメータで RPC エラーになっていた。負でない安全な整数以外は 400 を返すようにした。
  5. **clippy ゲートが赤だった**: `cargo clippy --workspace --all-targets -- -D warnings` が 10 件で失敗（`decode_output` の Windows 側 `needless_return`、`server.rs` の `cwd_tests` の `unwrap()` 7 件＋`Option` 2 件）。ワークスペースの `unwrap_used = "deny"` はテストにも効くため、`Result` を返すテストに書き換え、`decode_output` は cfg ブロックを式にした。現在 exit 0。
  6. **Web UI のテストがどこからも実行されていなかった**: `packages/hy-cli/web/test/*.test.mjs`（51 件）は `pnpm test` の glob にも CI にも含まれず、`tsconfig.web-test.json` と `web/src/orchestration-intent.test.ts` は誰も参照しない死んだ設定だった。`test` / `coverage:ts` の glob に Web UI テストを追加し、重複していた `.ts` テストの 2 アサーションを `.mjs` に移植したうえで、死んだ設定 2 ファイルを削除。
- **追加したテスト**: `tests/integration/turn-queue.test.mjs`（5 件: 実行中予約→自動開始、`queue:true` の 202 と重複 409、再起動時の uncertain/paused、cancel/resume/resolve、不正入力）、`tests/integration/job-output.test.mjs`（1 件: 実行中ページ・全ページ結合・offset 検証）、Rust 単体 3 件、Web UI 1 件。
- **検証結果（この環境）**:
  - `cargo test --workspace`: 47 件 PASS（44 + 3）。
  - `cargo clippy --workspace --all-targets -- -D warnings`: exit 0。
  - `pnpm typecheck` / `pnpm build` / `pnpm check:protocol`: exit 0。
  - `pnpm test`: 275 件 PASS（224 + Web UI 51）。
  - `pnpm test:integration`: 67 件 PASS（61 + 6）。修正版デーモンで実行。`target/debug` は別プロセスが使用中で置き換えられなかったため `HY_EXEC_SERVER=target/release/hy-exec-server.exe` を使用。
  - `pnpm desktop:screenshot`: 実 Electron で画面取得に成功（`screenshots/desktop.png`）。※このシェル環境は `ELECTRON_RUN_AS_NODE=1` が継承されており、これがあると Electron が Node として起動して `import { BrowserWindow } from 'electron'` で落ちる。環境変数を外して実行した。
- **残っている作業**:
  - `target/debug/hy-exec-server.exe` を掴んでいる古い `hy web --tailscale`（`G:\マイドライブ\HY-HARNESS`、21:11 起動）を停止して `cargo build -p hy-exec-server` を実行する（停止しない限り debug ビルドは置き換えられない）。→ 2026-11-04 にユーザー承認のうえ停止し、debug を再ビルド済み。
  - 実画面での予約 UI の確認（前節から継続）。

## 5.8 2026-11-04 DSH 比較ギャップ分析
- **目的**: `deepseek-ai/deepseek-harness` の実装を分析し、本プロジェクトが劣っている／不足している機能を全件列挙する。
- **方法**: 実機インストール版 DSH **0.2.1-rc.3** の `app.asar` を展開し、`@deepseek-ai/*` **307 パッケージ**の README と `desktop-runtime.json` を一次資料とした。加えて GitHub `master` の `README.md` と `docs/user/guide/*`（providers / python-sdk / public-deployments）を参照。HY-HARNESS 側は実装コード・テスト・`docs/*` を根拠にした。
- **結果**: **111 項目を評価し、106 項目が不足または劣位**（A 21 / B 40 / C 45）。レポートは [docs/dsh-gap-analysis.md](docs/dsh-gap-analysis.md)。
- **主要な不足（A 級の抜粋）**:
  1. プラグイン基盤（プロファイル／バンドル／YAML パッチ合成、プラグインマネージャ、マーケット、Creator、クライアントプラグイン、HMR）。
  2. 型付き RPC（Typert）とスキーマ生成。
  3. 実行中ステアリング（inbox）と継続可能サブエージェント（`send_message` / `interrupt_agent` / `list_agents`、fork）。
  4. `workflow` ツール（JS スクリプトによるサブエージェント fan-out）。
  5. モデルプロバイダ基盤（pi-ai カタログ、3 プロトコル、モデル一覧取得、compat、OAuth 資格情報）。
  6. セッション形式の版管理とマイグレーション（v0→v4）、FTS5 全文検索。
  7. 永続シェル／`terminal` ツール、`read`/`write`/`edit`、`present`、`read_image`、`working_directory`、`session_query`。
  8. 配備とアクセス制御（TLS、`--public-url` / `--trusted-host`、Host/Origin フェンス、ピア RBAC）。
  9. ACP サーバと Python/TS SDK。
  10. 文書・成果物（Office スキル、LibreOffice 変換、文書プレビュー、成果物カード）。
- **DSH 側の事実確認**: DSH 0.2.1-rc.3 には**クラウド実行**と**SSH 先でのリモート実行**のパッケージは存在しない（SSH は Web UI を SSH 経由で起動し、クライアント側でポート転送する運用）。`docs/feature-parity.md` の該当記述は DSH を過大評価している。
- **HY が勝る点（再確認）**: Windows 10 サンドボックス（ACL 付与/取り消し記録、`.git` ガード、非 ACL ボリューム）、ターン単位チェックポイントと `/undo`、検証ゲート付き Ralph＋Budget4D、Guardian、オーケストレーション A+ のスコープ規律、MCP サーバ、LSP、ワークスペースメモリ、永続 PTY、Tailscale 個人アクセス、portable exe 配布。

## 5.9 2026-11-04 DSH 差分導入の実装計画
- **方針**: HY の強み（K1〜K14）は置き換えず、不足 106 件のうち A 級 21 件を中心に DSH の設計・データ形式・UX・テスト観点だけを移植する。`@deepseek-ai/*`（Cordis 依存）は vendoring しない。プラグインマーケット/Creator、クライアントプラグイン、マルチユーザー RBAC は承認済み対象外として作らない（ただしプロファイル合成・設定スキーマ・API 契約の軽量版は作る）。
- **計画書**: [docs/dsh-adoption-plan.md](docs/dsh-adoption-plan.md)（作業パッケージ 24 件、見積 203 人日、6 マイルストーン、リスク 10 件、完了定義）。
- **要点**:
  - M0 ベースライン固定（ゴールデン回帰スイート、ADR `0002-dsh-adoption`、計測）。
  - M1 安全と配備: TLS / trusted host / public URL / Host-Origin フェンス、`hy config dump|schema`、セッション単位サンドボックスモード（既定値は §2.1 の判断待ち）。
  - M2 協調: セッション形式 v2＋読み取り時移行、ステアリング inbox、継続可能サブエージェント（`send_message`/`interrupt_agent`/`list_agents`）、`todo_write` と `present`。
  - M3 ツールと実行: `write_file`/`edit_file`/`read_image`/`working_directory`、永続シェル（confined は stdin 不可なら one-shot にフォールバック）、FTS5 検索（`node:sqlite`＋`tokenize='trigram'`、日本語ヒットを実機確認済み）。
  - M4 プロバイダと構成: Anthropic Messages / OpenAI Responses、モデルカタログ取得、compat、バンドル合成、API 契約の型生成。
  - M5 連携と成果物: ACP サーバ、JSON-RPC SDK＋Python、文書プレビュー/Office→PDF、デスクトップ更新フィード。
  - M6 磨き: LLM タイトル、統計、fork、`@session`、フィードバック、ショートカット/テーマ、オプトイン OTel。
- **見積**: 1 人＋AI で約 10 か月、2 人並行で約 5.5 か月。最小セット（M0＋協調＋ツール＋検索）は 61 人日、推奨初期セットは 87 人日。

## 5.10 2026-11-04 DSH 差分導入の実装（M0 完了・M1 進行中）
- **M0 完了**: `tests/regression/golden.test.mjs`（K1/K2/K6/K9/K13/K14 の 8 検証）と `pnpm test:regression`（28 件 PASS）、ADR `docs/adr/0002-dsh-adoption.md`、`pnpm bench:startup` と `docs/bench-baseline.md`（起動 204 ms・1 ターン 515 ms・ツールスキーマ 7,137 chars）。`pnpm test:regression` は golden＋chat-resume／guardian／verifier-ralph／turn-queue／mcp-server／tool-overhead を束ねる。
- **WP-10 完了**: `hy web` に `--tls-cert`/`--tls-key`（HTTPS、Secure Cookie、失敗時は HTTP に落ちない）、`--trusted-host`（repeatable）、`--public-url`（末尾スラッシュ正規化・query/fragment 拒否）、Host/Origin フェンス（loopback／bind IP／trusted host 以外は 403、`Origin: null` は拒否）。`WebServerHandle.localUrl` と bootstrap の `web: { tls, publicUrl, trustedHosts }` を追加。`tests/integration/web-deploy.test.mjs` 4 件（TLS、フェンス、public URL、素材の不整合、平文の後方互換）。
- **WP-11 完了**: `packages/core/src/config-schema.ts` にユーザー設定の JSON Schema と例、`hy config dump`（`apiKey`／MCP env を伏字、`--show-secrets` で表示）と `hy config schema`、`scripts/gen-config-schema.mjs` と `pnpm check:config-schema`、`docs/config.schema.json`、単体 3 件。
- **副次修正**: `--mock` を既存の `HY_DEMO.md` があるワークスペースで再実行すると、読み取り前編集の規則で `apply_patch` が失敗してモックがループしていた。`TOOL ERROR (apply_patch)` で完了する分岐を追加し、ベンチは反復ごとに新しいフィクスチャを使うようにした。
- **検証**: `pnpm typecheck`／`build` exit 0、`pnpm test` 278 件 PASS、`pnpm test:integration` 71 件 PASS、`pnpm test:regression` 28 件 PASS、`pnpm check:config-schema` PASS、`pnpm bench:startup` 成功。Rust 変更なしのため cargo は未実行。

## 5.11 2026-11-05 WP-12（セッション単位サンドボックスモード）・M1 完了
- **実装**:
  - `ExecCommandParams`／`PatchApplyParams` に `sandboxMode` を追加（`pnpm gen:protocol`）。
  - デーモン: `effective_sandbox(requested, policy)` で解決する。セッションの要求が既定、ポリシーは narrow 可、`low-integrity` はユーザーポリシーの escape として workspace-write を緩められる（Jest/Vitest の piped worker、ADR 0001 §7）。read-only は何によっても広がらず、`unconfined` へはポリシーでも広げない。
  - `patch/apply` は read-only でデーモンが拒否し、コントロールプレーン（`ToolRuntime`）も RPC 前に拒否する。
  - `Sandbox::prepare(grant=false)` は未 grant でも文脈（workspace SID）を捨てず `unavailable_reason` を設定し、`grant_now()` で後から grant＋トークン構築できるようにした。
  - `Conversation` は `sandbox/mode` をログに追記し、`resolveSandboxMode` が最後の値を再プレイする。`setSandboxMode` はユーザー操作専用（モデル向けツールはない）。
  - `POST /api/sessions/:id/sandbox`: モード検証（`low-integrity` は 400）、confined への切替時は grant を実行し、失敗は 409 で返す（暗黙に unconfined で走らせない）。worker は 403。
  - GUI: 作曲欄のサンドボックスチップをモード表示に変え、モーダルで read-only／workspace-write／unconfined を選択（ja/en/zh、unconfined に危険表示）。
  - バージョンを **0.2.0** に更新（`package.json` と bootstrap の両方）。
- **検証**: `cargo test -p hy-exec-server` 31 件 PASS、`cargo clippy --workspace --all-targets -- -D warnings` exit 0、`pnpm build`／`typecheck` exit 0、`pnpm test` 282 件 PASS、`pnpm test:integration` 72 件 PASS、`pnpm check:protocol` PASS。
- **注意**: 既定 unconfined のセッションを confined に切り替えると、その操作を同意として workspace の ACL を付与する（`hy sandbox revoke` で戻せる）。read-only のセッションでもハーネス内部の git チェックポイントは動く（モデル向けツールだけを止める）。
- **次の一手**: WP-20（セッション形式 v2）→ WP-21（ステアリング）。進捗は `docs/dsh-adoption-progress.md`。

## 5.12 2026-11-05 WP-20（セッション形式 v2 と読み取り時移行）
- **実装**:
  - `packages/core/src/session-format.ts`: `SESSION_FORMAT_VERSION = 2`、`sessionFormatOf()`、`hasFormatHeader()`、`migrateSessionEvents()`。ヘッダーは `session/format` イベント（`{ version }`）。
  - `SessionLog`: 書き込み時にファイルごと 1 回だけ `session/format` を先頭へ置く（`formatHeaders` で追跡、`writeEvent` は private 化）。既存ファイルの読み取りは `readEvents` がメモリ上で移行する（書き換えない）。
  - 移行は v1→v2 が加算的なので identity。未知の将来形式は best-effort（読める範囲は読む）。
  - `tests/fixtures/session-v1.jsonl`: ヘッダーなし＋最終行が途中で切れた旧ログ。
- **検証**: `pnpm test` 286 件 PASS（単体 4 件追加）、`pnpm test:integration` 72 件 PASS、`pnpm test:regression` 28 件 PASS（`session/format` ヘッダー分を 4 イベント・seq [1,2,3,4] へ更新）、clippy exit 0、`pnpm check:protocol` up to date。
- **互換性**: v1 のログはそのまま読める。書き込みは常に現行版なので、v1 のファイルへ追記するとヘッダーが 1 度だけ入る。
- **次の一手**: WP-21（ステアリング inbox）。

## 5.13 2026-11-05 WP-21（実行中ステアリング inbox）
- **実装**:
  - `packages/core/src/steering.ts`: `SteerMessage`／`SteerInbox`／`createSteerInbox`、履歴用の印 `STEER_PREFIX = '[the user sent this while you were working]'` と `steerMessage()`／`isSteerMessage()`／`steerText()`。
  - `AgentOptions.steer`: 各ステップの先頭で drain し、印を付けて履歴へ append したうえで **その時点で** `user/steer` をログ（`{ content, step, images? }`）。ログ順＝モデルが見た順になり、`rebuildHistory` も同じ印で復元するので再開時の履歴がライブと一致する。
  - `Conversation.steer()` は実行中のみ受け付け、`takeUndeliveredSteers()` が最終ステップ境界に間に合わなかった分を返す。`turn()` の finally で `late: true` としてログし履歴へ畳み込む（メッセージを失わない）。
  - `POST /api/sessions/:id/steer`: worker 403、実行中でなければ 400（`hint: "turn"`）、空メッセージ 400。SSE には `entry`（`steering: true`）と `steer` イベントを流す。
  - GUI: 実行中のみ出る作曲欄チップで「今すぐ割り込む（既定）／ターン後に送る」を切替。`sendIntent(busy, mode)` が `send-now|steer|queue` を返し、ステアが 400/409 のときは通常のターンへフォールバックする。割り込みカードは破線＋`steer` バッジ（ja/en/zh）。
  - モック: ステアを受け取ると `steer: <本文>` を返す分岐を追加（E2E で配送を証明）。`HY_MOCK_DUMP=<file>` でモックへのリクエストを記録できるようにした。
  - `SpillCompaction.beforeRequest` は assistant の区切りごとの「ステップ」でまとめるよう変更（ステアで user が 2 連続してもツール呼び出しと結果が離れない。古い側のステアは消さず、そのステップごと要約する）。
- **検証**: 単体 296 件 PASS（ステアリング 9 件追加）、`pnpm test:integration` 74 件 PASS（`tests/integration/steer.test.mjs` 2 件追加。実 HTTP で 4 秒のシェル実行中に割り込み、`step: 2` でログされ、モデルが `steer: also check the tests` と応答）、`pnpm test:regression` 28 件 PASS、`pnpm typecheck`／`build` exit 0、`check:protocol`／`check:config-schema` up to date、`bench:startup` 518 ms（ツールスキーマ 7,137 chars は不変）。
- **注意**: 最後のステップ境界を過ぎてから届いたステアは、ターンを延長せず通知だけ出す（次の発話で扱う）。ステアは通常のモデル要求に混ざるため、承認・ポリシー・予算・Compaction の対象は通常メッセージと同じ。
- **次の一手**: WP-22（継続可能サブエージェント）。進捗は `docs/dsh-adoption-progress.md`。

## 5.14 2026-11-05 WP-22（継続可能サブエージェント）
- **実装**:
  - `packages/hy-cli/src/agents.ts`: `SubagentRegistry`（`spawn`／`send`／`interrupt`／`close`／`list`／`wait`、同時実行 8 件上限、`dispose` で実行中の子を中断）。`SubagentRegistry.replay` が親ログの `agent/*` から一覧を復元し、`running` のまま落ちた子は `interrupted` に正規化する。
  - ログ: `agent/spawn`／`agent/message`／`agent/end`／`agent/interrupt`／`agent/close`（中断は `agent/end { interrupted: true }`）。
  - `ConversationOptions.readOnly`／`backgroundAgents`／`onAgentChange`。子は `Conversation`（読み取りツールのみ、`delegate: false`、`checkpoints: false`）で、子の runId のログから履歴を復元するためフォローアップも再起動後も継続する。
  - `delegate { background: true }`（`ToolRuntimeOptions.backgroundDelegate`）＋ plugin ツール `list_agents`／`send_message`／`interrupt_agent`。K9 の wire 14 ツールは不変。
  - API: `GET /api/sessions/:id/agents`、`POST /agents/:id/{message,interrupt,close}`。SSE `agent/state` と、ターン終了時の通知（`subagent ... finished/failed`）。
  - GUI: Details のサブエージェント欄に状態・タスク・最終回答・追加指示欄・停止ボタン。
- **検証**: 単体 301 件 PASS（`agents.test.ts` 5 件追加）、`pnpm test:integration` 76 件 PASS（`tests/integration/agents.test.mjs` 2 件追加: バックグラウンド委譲→フォローアップ→close、API 中断と再起動時の interrupted 正規化）、`pnpm test:regression` 28 件 PASS、`pnpm typecheck`／`build` exit 0。
- **注意**: `delegate` に `background` を足したぶん PTC プロンプトが予算超過したため、ツール説明を圧縮して 1,169〜1,172 トークンに戻した（`delegate { background }` の説明、`read_file` 出力宣言の `sha256` 削除、`search`/`rationale`/`update_plan` の説明短縮）。SDK スナップショットを更新済み。
- **次の一手**: WP-23（`todo_write` と `present`）。

## 5.15 2026-11-05 WP-23（`todo_write`・`present`・成果物カード）— M2 完了
- **実装**:
  - `packages/core/src/tools.ts`: `ToolRuntime.todoWrite()`（全置換、`content`/`step` 両対応、in_progress が複数なら `allowParallelInProgress` が必要）と `restorePlan()`。
  - `packages/hy-cli/src/session-app.ts`: plugin ツール `todo_write` と `present`（ワークスペース内の通常ファイル最大 8 件、サイズ・行数を `deliverable/presented` に記録）、`restoredPlan()` がログの最後の `update_plan`/`todo_write` から plan を復元。
  - `packages/hy-cli/src/chat-projection.ts`: `todo_write` も plan カードに投影、`deliverable/presented` → `deliverables` カード、ライブ `tool` イベントでも同じカードを即時表示。
  - GUI: 成果物カード（`Open` は Files ビューア、`Show in folder` は `POST /api/sessions/:id/reveal` → `explorer /select`）、Diff タブに変更ファイル一覧。
  - `GET /plan` を `ensureConversation` 経由に変更（再起動直後でも復元した todo が見える）。
- **検証**: 単体 304 件 PASS（projection 2 件・tool 1 件追加）、`pnpm test:integration` 78 件 PASS（`tests/integration/present.test.mjs` 2 件追加）、`pnpm test:regression` 28 件 PASS、`pnpm typecheck`／`build` exit 0、`check:protocol`／`check:config-schema` up to date。
- **注意**: 新ツールは plugin ツールなので K9 の wire 14 ツールは不変。`present` の行数は `/api/files` の分割と同じ数え方に合わせた（末尾改行で +1）。
- **次の一手**: M3 WP-30（`write_file`／`edit_file`／`read_image`／`working_directory`）。進捗は `docs/dsh-adoption-progress.md`。

## 5.16 2026-11-05 WP-30（`write_file`・`edit_file`・`read_image`・`working_directory`）
- **実装**:
  - `packages/core/src/tools.ts`: `writeFile()`（apply_patch 経由）、`editFile()`（`old` の一意一致・`count`・失敗時の候補行）、`readImage()`（マジックバイト判定・1x1 の寸法解析・8 MiB / 4096 px 上限・`takeImages()` でバイト列を別経路に）、`workingDirectory()`／`currentCwd()`／`restoreCwd()`（`resolveRootPath` で相対パスに前置、`shell` の既定 cwd に反映）。
  - `Agent`: `read_image` のバイト列を**ツール結果メッセージ**に添付（`image/attached` をログ、交互性は維持）。
  - plugin ツール `write_file`／`edit_file`／`read_image`／`working_directory`（K9 の wire 14 は不変）。`role.vision` と `roleSupportsImages()` を追加（`--mock` は可、Ollama はビジョン系モデル名のみ、ホスト API は可）。
  - `Conversation.create` が `session/cwd` を復元。
  - Rust: 新規ファイル作成パッチの末尾改行（`final_newline: true`）を修正。
- **検証**: 単体 310 件 PASS（tools 5 件・agent 1 件追加）、`pnpm test:integration` 81 件 PASS（`tests/integration/edit-tools.test.mjs` 3 件追加）、`pnpm test:regression` 28 件 PASS、`cargo test -p hy-exec-server patch` 6 件 PASS、clippy exit 0、`pnpm typecheck`／`build` exit 0、`check:protocol`／`check:config-schema` up to date。
- **注意**: `edit_file` は主ルートのみ（追加 root は `write_file` を使う）。`read_image` の画像はログに残らない（base64 をログへ入れない方針）ため、再開後は再度読み込む必要がある。
- **次の一手**: WP-31（永続シェル）。

## 5.17 2026-11-05 WP-32（FTS5 セッション検索と `session_query`）
- **実装**:
  - `packages/core/src/session-index.ts`: `SessionIndex`（`node:sqlite`、`events_fts ... tokenize='trigram'`、`files` のバイト位置で差分同期、壊れた DB は自動削除・再構築）。日本語は部分一致、2 文字以下は `LIKE`。
  - `hy index status|rebuild`、`hy sessions --search` を FTS に切替（失敗時は従来の線形走査にフォールバック）。
  - `GET /api/search?q=&limit=&cwd=`、plugin ツール `session_query`（`--session-query` / `sessionQuery.enabled`、同一 cwd・自分以外・上位 5 件）。
  - `role.vision`／`sessionQuery` を config schema に追加（`docs/config.schema.json` 再生成）。
- **検証**: 単体 314 件 PASS（index 4 件追加）、`pnpm test:integration` 82 件 PASS（`tests/integration/session-search.test.mjs` 1 件追加: 日本語・英語のヒット、`session_query` が自分の run を除外、`/api/search`、CLI の status/rebuild/`--search`）、`pnpm test:regression` 28 件 PASS、`pnpm typecheck`／`build` exit 0、`check:protocol`／`check:config-schema` up to date。
- **注意**: 索引は `<stateDir>/index/session-fts.db` に作られる使い捨てのキャッシュ。ログを消せば索引も作り直しになる。`session_query` は既定で無効。
- **次の一手**: WP-31（永続シェル）。

## 5.18 2026-11-05 WP-31（永続シェル）— M3 完了
- **実装**:
  - プロトコル: `shell/open|write|read|close`（`ShellOpenParams`/`Result` ほか）。`pnpm gen:protocol`。
  - `crates/hy-exec-server/src/shell.rs`: セッションごとの PowerShell（`[Console]::In.ReadLine()` ループ）、`__HY_DONE__<id>:<ok>:<code>` 番兵で境界と終了コードを判定、stdout/stderr を 1 本のバッファへ、タイムアウト/EOF で破棄、`Drop` で全シェル終了。
  - `shell` ツールに `persistent`（既定は `--persistent-shell` / `persistentShell.enabled`）。書き込み前に `policy/evaluate` と同じ評価・承認を行い、結果に `shell: "persistent"` を付ける。
  - confined / cmd.exe / シェル起動失敗では `shell/open` が `gap` を返し、通常の one-shot にフォールバックする（結果に `gap` が付く）。
  - `ToolRuntimeOptions.persistentShell`、`HarnessConfig.persistentShell`、`--persistent-shell`、config schema。
- **検証**: `cargo test --workspace` 53 件 PASS（`shell.rs` 2 件追加）、clippy exit 0、単体 314 件 PASS、`pnpm test:integration` 83 件 PASS（`tests/integration/persistent-shell.test.mjs` で cd と環境変数の保持・タイムアウト後の再生成を実測）、`pnpm test:regression` 28 件 PASS、`check:protocol`／`check:config-schema` up to date、`bench:startup` 起動 227 ms・1 ターン 543 ms・ツールスキーマ 7,187 chars・PTC 1,183〜1,185 tokens。
- **注意**: 永続シェルは unconfined のみ。confined セッションは従来の one-shot（`gap` に理由）で、`cd` は次の呼び出しに残らない。ツールのトークン予算（1,200）は維持。
- **次の一手**: M4 WP-40（Anthropic Messages / OpenAI Responses アダプタ）。

## 5.19 2026-11-05 WP-40（Anthropic Messages / OpenAI Responses アダプタ）
- **実装**:
  - `packages/core/src/llm.ts`: `AnthropicProvider`（`POST /v1/messages`、`x-api-key`/`anthropic-version`、連続同一 role のマージ、画像は `image` ブロック、`tool_use`→`toolCalls`、`thinking`→`reasoning`、`cache_read_input_tokens`→キャッシュヒット）と `OpenAiResponsesProvider`（`POST /responses`、`input`/`instructions`、`function_call`→`toolCalls`、`input_tokens_details.cached_tokens`）。パーサは `parseAnthropicResponse`／`parseOpenAiResponses` として公開。
  - `ProviderKind` に `anthropic` と `openai-responses`、既定 role（モデル・baseUrl・API キー env・context/max output）、`roleSupportsImages`／`usesNativeTools`／`roleApiKey` の既定、config schema の enum。
- **検証**: 単体 318 件 PASS（`llm-providers.test.ts` 4 件追加: ローカル HTTP サーバでリクエスト形と応答解釈を検証、API エラー、異常応答の防御）、`pnpm test:integration` 83 件 PASS、`pnpm test:regression` 28 件 PASS、`pnpm typecheck`／`build` exit 0、`check:config-schema` up to date。
- **注意**: 履歴は従来どおりテキストプロトコル（`{"tool":...}` と `TOOL RESULT (...)`）で送る。ネイティブの `tool_use`/`tool_result` 往復には変換しないため、プロバイダを変えてもセッションログと再開は同一。
- **次の一手**: WP-41（モデルカタログ/compat）。

## 5.20 2026-11-05 WP-41（モデルカタログと compat の一元化）
- **実装**:
  - `packages/core/src/model-catalog.ts`: 既知モデルの context / max output / pricing / capabilities（tools・vision・reasoning・cache）と `ModelCompat`（`tokenField`・`effortWithTools`・`temperature`）。`findModel`／`catalogForRole`／`tokenFieldFor`／`effortWithToolsFor`／`temperatureAllowedFor`／`catalogVision`。
  - `llm.ts` の `max_tokens` 判定・effort と tools の併用可否・temperature 可否をカタログ由来に（未知モデルは従来のヒューリスティック）。
  - `roleSupportsImages` はカタログの vision を優先（role の明示 `vision` が最優先）。
  - `hy models list [--json]`、`hy models discover`（OpenAI 互換 `/v1/models`、Anthropic `/v1/models`、Ollama `/api/tags`。失敗は理由付き exit 1）、`GET /api/models`（カタログ＋使用中ロール）。
- **検証**: 単体 325 件 PASS（カタログ 2 件・discovery 5 件追加）、`pnpm test:integration` 84 件 PASS（`tests/integration/models.test.mjs` 1 件追加）、`pnpm test:regression` 28 件 PASS、`pnpm typecheck`／`build` exit 0。
- **注意**: カタログは role の設定を上書きしない（互換フラグと表示だけ）。`hy models discover` はネットワークに出るので、失敗時は provider とステータスを表示して終了する。
- **次の一手**: WP-42（プロファイル/バンドル）。

## 5.21 2026-11-05 WP-42（プロファイル/バンドル合成・軽量版）
- **実装**:
  - `packages/core/src/bundles.ts`: 組み込みバンドル `core`／`ptc`／`minimal`／`audit`／`orchestrator`／`worker`。`resolveBundles()` は `core` を先頭に重複を除いて解決し、`allowTools` の**積集合**だけを返す（絞るだけで広げない）。未知の名前はエラー。
  - `HarnessConfig.bundles`（`names`／`tools`／`prompts`／`panels`／`commands`／`roleDefaults`）。解決順は `core` → `--profile` の `bundles` → ユーザー config の `bundles` → `--bundle`。
  - `--bundle <name>`（repeatable）を追加。`--profile` は従来どおりで、その中の `bundles` が効く。
  - `Conversation.create` がバンドルの許可ツールを `ToolRuntime` の allow-list と Agent の `allowTools` に反映（read-only 子セッションとは積集合）。プロンプト節は role instruction の後に追記。
  - `hy config dump` に解決結果（Set を配列化）、`/api/bootstrap` に `config.bundles` と `bundleCatalog`、config schema に `bundles`。
- **検証**: 単体 333 件 PASS（bundles 7 件＋config 1 件追加）、`pnpm test:integration` 86 件 PASS（`tests/integration/bundles.test.mjs` 2 件追加: `hy config dump --bundle minimal` が 3 ツール、`hy run --bundle minimal` が書き込みを拒否してファイルを作らない）、`pnpm test:regression` 28 件 PASS、`pnpm typecheck`／`build` exit 0、`check:config-schema` up to date。
- **注意**: `core` は許可リストを持たない（バンドル未指定の既存挙動を変えないため）。GUI の新規セッションプリセット選択は未実装（bootstrap に一覧は公開済み）。
- **次の一手**: WP-43（API 契約層）。

## 5.22 2026-11-05 WP-43（API 契約層・軽量版）— M4 完了
- **実装**:
  - `packages/hy-cli/src/api-contract.ts`: 77 ルートの `method`／`path`／`request`（型付きフィールド）／`response`／`errors`、`pathMatches()`／`matchContract()`／`validateRequest()`。
  - `scripts/gen-api-types.mjs`: `packages/hy-cli/web/src/api.gen.ts`（`API_ROUTES`・`apiPath()`・`findApiRoute()`）を生成。`pnpm gen:api`／`pnpm check:api`。
  - `web-server.ts`: ハンドラ先頭で契約を 1 回解決し、`readBody()` が POST/PUT の本文を型検証（誤型は `400 {"error":"invalid request: …"}`、必須欠落は各ルートの従来メッセージ）。
  - `web/src/api.ts`: 生成された `apiPath()` を使う。
- **検証**: 単体 338 件 PASS（`api-contract.test.ts` 5 件: 双方向ドリフト検査・パスマッチ・型検証・契約の整合性）、`pnpm test:integration` 88 件 PASS（`tests/integration/api-contract.test.mjs` 2 件: 誤型 400・生成型とクライアント参照）、`pnpm test:regression` 28 件 PASS、`pnpm typecheck`／`build` exit 0、`pnpm check:api`／`check:config-schema`／`check:protocol` すべて up to date。
- **注意**: 必須フィールドの欠落は従来どおり各ルートが返す（既存の 400 文言を変えないため）。SSE イベントの payload 型はまだ手書きで、契約にはルートの存在のみ。
- **次の一手**: M5 WP-50（ACP サーバ）。

## 5.23 2026-11-05 WP-50（ACP v1 サーバ）
- **実装**:
  - `packages/hy-cli/src/acp.ts`: stdio NDJSON の JSON-RPC 2.0。`initialize`（protocolVersion 1、`loadSession`、画像入力）、`authenticate`、`session/new`、`session/load`、`session/prompt`、`session/cancel`、`session/close`。`session/update` として `agent_message_chunk`・`agent_thought_chunk`・`tool_call`・`tool_call_update`（completed/failed）を送る。
  - プロンプトは await せずディスパッチ（キャンセル・許可応答を読み続ける）。同一セッションの二重プロンプトは拒否。
  - 承認は `session/request_permission`（`allow` のみ許可、無応答は拒否）。`--yes`／full-auto はセッション既定としてクライアントに聞かない。
  - `hy acp` コマンド（`--mock` 等のオプションは共通）。usage に追加。
- **検証**: 単体 338 件 PASS、`pnpm test:integration` 89 件 PASS（`tests/integration/acp.test.mjs`: 台本クライアントで initialize → session/new → ツール付きプロンプトの通知 → session/load → 20 秒コマンドのキャンセル → close → 未知メソッド -32601）、`pnpm test:regression` 28 件 PASS、`pnpm typecheck`／`build` exit 0、`check:api`／`check:protocol` up to date。
- **注意**: 応答は JSON-RPC の id で対応付けるため順不同になり得る。ACP の `file operations`（fs/read_text_file 等のクライアント委譲）は未実装で、ツールはハーネス自身の権限で動く。
- **次の一手**: WP-51（SDK ＋ Python）。

## 5.24 2026-11-05 WP-51（SDK・TS/Python クライアント）
- **実装**:
  - `packages/hy-cli/src/sdk-server.ts`: `hy serve --sdk`。stdio NDJSON の JSON-RPC 2.0 で `initialize`・`session.create`・`session.resume`・`session.prompt`・`session.cancel`・`session.close`・`shutdown`。通知 `session/event`（AgentEvent）と `session/status`（busy/turns）。プロンプトは非 await でディスパッチし、実行中のキャンセル・停止を受け付ける。
  - `packages/sdk`: 依存なしの TypeScript クライアント `HarnessClient`（`start`/`initialize`/`createSession`/`resumeSession`/`prompt`/`cancel`/`closeSession`/`close`、`onEvent`/`onStatus`）と `runOnce()`。`tsc -b` と `typecheck` に追加。
  - `python/`: `pyproject.toml`（stdlib のみ、3.10+）、`hy_harness`（`Client`・`run()`・CLI）、`examples/run.py`。`pip install -e python` を venv で検証。
- **検証**: 単体 338 件 PASS、`pnpm test:integration` 91 件 PASS（`tests/integration/sdk.test.mjs`: TS クライアントで prompt＋イベント＋status＋再開＋キャンセル＋未知セッション、Python 例が `final: hello from python` を出力）、`pnpm test:regression` 28 件 PASS、`pnpm typecheck`／`build` exit 0、`check:api` up to date。
- **注意**: 1 サーバ = 1 ワークスペース。承認はサーバ側の既定（`--yes`/full-auto）に従い、クライアントへ問い合わせる ACP のような permission は無い。Python は同期 API のみ。
- **次の一手**: WP-52（文書プレビュー）。

## 5.25 2026-11-05 WP-52（文書プレビュー・Office→PDF）
- **実装**:
  - `packages/hy-cli/src/documents.ts`: `previewDocument()` / `resolvePreviewPath()` / `findSoffice()`。Office/ODF は `soffice --headless --convert-to pdf` で変換し、`<stateDir>/preview/<sha256>.pdf` にキャッシュ（ヒット時はヘッダー `X-HY-Preview-Cached: hit`）。`.cmd` シムは `cmd.exe /d /c <shim> args…` の argv 形式で起動（`shell: true` を使わない＝DEP0190 回避）。`DocumentError` が 400/404/415/422 に対応。
  - `GET /api/sessions/:id/document?path=`: 相対パスはワークスペース基準。PDF はそのまま、変換できない形式は 415、壊れた Office は 422。契約（78 ルート）と `web/src/api.gen.ts` を再生成。
  - `document_preview` プラグインツール（`session-app.ts` の `documentToolMap`）と `packages/hy-cli/prompts/office.md`（成果物を作ったら確認する、という雛形）。
  - GUI: 成果物カードの `preview-deliverable` が `window.open` で新しいタブに開く。i18n は `previewDocument`（en/ja/zh）。
- **検証**: 単体 338 件 PASS（`documents.test.ts` 4 件: パス解決・非対応拡張子・soffice 未検出・キャッシュキー）、`pnpm test:integration` 93 件 PASS（`tests/integration/documents.test.mjs` 2 件: PDF 直配信と、LibreOffice の有無に応じた 200/415）、`pnpm test:regression` 28 件 PASS、`pnpm typecheck`／`build` exit 0、`check:api` up to date。
- **注意**: 変換は `soffice` がある環境だけ（無ければ 415 `no office converter`）。PDF.js の同梱は見送り、ブラウザ内蔵ビューアで表示する。サンドボックス外のパスは 415 で「プレビュー不可」を返す（404 と区別しない）。
- **次の一手**: WP-53（デスクトップ更新フィード）。

## 5.26 2026-11-05 WP-53（署名付き更新フィード・初回オンボーディング）— M5 完了
- **実装**:
  - `packages/hy-cli/src/update-feed.ts`: `hy-release/v1` の行ベース署名（version / sha256 / url / channel / mandatory）を Ed25519 で検証。`parseReleaseFeed` は 1 件でも不正ならフィード全体を拒否し、`pickRelease` がセマンティックバージョンでチャネル内の最新を選ぶ。`downloadRelease` は HTTPS のみ・512 MiB 上限・宣言 size と SHA-256 の一致を確認してから rename し、`.sha256` サイドカーを書く。
  - CLI: `hy update check`（`--json`）、`fetch`、`keygen`（PKCS#8 を 0600 で生成、既存は上書きしない、指紋を表示）、`sign`（公開する JSON エントリを出力）。既定の鍵パスは `<stateDir>/update/public-key.pem`、解決順はフラグ → `HY_UPDATE_*` → ユーザー設定 `update`。
  - API: `GET /api/update`（`configured` / `release` / `reason` / `error`）、`POST /api/update/fetch`。契約 82 ルートへ追加し `web/src/api.gen.ts` を再生成。
  - 差し替え: `packages/desktop/update.ps1` と `update.mjs` に 6 段階の進捗ログ（`progress n/6`）と SHA-256 検証を追加。不一致はバックアップを戻して **exit 5**、コピー失敗 4、退避失敗 3。デスクトップは `<stateDir>/update/download` を候補に加え、隣の `.sha256` を `expectedSha256` として渡す。
  - オンボーディング: `packages/hy-cli/src/onboarding.ts`（`<stateDir>/onboarding.json`、`GET /api/onboarding`、`POST /api/onboarding/complete`）。3 ステップは保存され、次回起動の `applyOnboardingDefaults` で sandbox と worker ロールに適用。明示フラグ（`--sandbox` / `--model` / `--provider` / `--mock`）が常に優先。GUI は初回ブートで自動的にウィザードを開き、設定に更新の確認・ダウンロード・適用を追加（i18n en/ja/zh）。
  - `packages/core/src/version.ts`（`HARNESS_VERSION`）を唯一の版元にし、`bootstrap.version` と更新比較が同じ値を使う。`pnpm check:version` が package.json とのズレを検出。
- **検証**: 単体 352 件 PASS（`update-feed.test.ts` 6 件: 署名・改ざん・スキーマ・バージョン比較・ダウンロード検証・ファイル/https 読み込み、`onboarding.test.ts` 4 件: 未設定・保存と適用・フラグ優先・スキップと不正値）、`pnpm test:integration` 97 件 PASS（`onboarding.test.mjs` 2 件: ウィザードの保存と再起動後の適用・フラグ優先、フィードの確認と改ざん拒否、`update-script.test.mjs` 4 件: 既存 2 件＋ハッシュ不一致のロールバック 2 件）、`pnpm test:regression` 28 件 PASS、`pnpm typecheck`／`build` exit 0、`check:api`／`check:protocol`／`check:config-schema`／`check:version` 一致。Electron のスクリーンショットで 3 ステップの描画を確認（`screenshots/onboarding-*.png`）。
- **注意**: 更新は決して自動では走らない（`update.autoCheck` は将来のためのフラグで、現状は明示操作のみ）。署名鍵はリポジトリに置かない（`hy update keygen` がローカル生成）。`update` は `unconfined` サンドボックスでも特権経路ではないが、差し替えは scheduled task 経由なので、失敗時は `C:\Users\Public\hy-harness-update\update.log` を見る。オンボーディングは「提案」であり、`low-integrity` は選択できない。
- **次の一手**: M6 WP-60（LLM タイトル・統計・fork・`@session` 参照）。

## 5.27 2026-11-05 WP-60（生成タイトル・統計・fork・参照・ターン一覧）
- **実装**:
  - `packages/hy-cli/src/session-title.ts` / `session-title-gen.ts`: モデルによるチャット名。指示は英語で「同じ言語・6 語/24 文字以内・引用符なし・具体名」、`maxTokens: 48`・temperature 0。応答は `cleanGeneratedTitle` がフェンス・`Title:`・引用符・末尾の句点を落として 60 文字/120 バイトに丸める。20 秒の期限は `Promise.race` で強制し、失敗・空・mock では最初の文をヒューリスティックに使う。`POST /api/sessions/:id/title/generate` が `ui-state.json` の `generatedTitles` に保存し、手動名が優先。GUI は名前ダイアログの「名前を生成」とパレットから。
  - `packages/hy-cli/src/session-stats.ts`: step-start→step-end をプロバイダ時間、tool-start→結果をツール時間、ターン開始→最初の step-end を「最初の応答まで」として計測。ターン終了時に `session/stats` を 1 件書き、再起動後は最新スナップショットから復元。`GET /api/sessions/:id/stats` と詳細パネルの「計測」セクション。プロバイダがトークン時刻を返さないため TTFT/デコード時間の代わりであることは設計メモに明記。
  - `packages/hy-cli/src/session-fork.ts` と `SessionLog.importEvents`: 対象 run のイベントだけを新しい run へコピー（タイムスタンプは保持、`.sub` は含めない）。`session/fork` で来歴を残し、`listRuns` が `forkedFrom` を返す。`POST /api/sessions/:id/fork`（任意の `upToSeq`）と GUI の「分岐」。
  - `packages/hy-cli/src/session-reference.ts`: `@session:<id>` を `projectChat` 由来のダイジェスト（先頭 1＋末尾 5、各 600 文字、ツール出力なし）として**ユーザー本文の後ろ**に境界付き untrusted ブロックで注入。`stripPlanPrefix` が表示から除去し、存在しない id は `missing=true` を返す。`GET /api/references` はファイルと過去チャットを返し、`q=dir/` でフォルダを掘る。GUI の `@` メニューは Sessions/Files の 2 セクション。
  - GUI: ターン一覧（アウトライン）を追加し、行の選択でエントリへジャンプして点滅。エントリに `data-entry-id` を付与。
- **検証**: 単体 375 件 PASS（`session-title-gen.test.ts` 8・`session-stats.test.ts` 6・`session-fork.test.ts` 3・`session-reference.test.ts` 6 を追加）、`pnpm test:integration` 101 件 PASS（`web-ui.test.mjs` に生成タイトル・統計の再起動復元・fork・`@session` 参照とフォルダドリルダウンの 4 件を追加）、`pnpm test:regression` 28 件 PASS、`pnpm typecheck`／`build` exit 0、`check:api`（86 ルート）一致。Electron のスクリーンショットで `@` メニューとアウトラインの描画を確認（`screenshots/outline.png`）。
- **注意**: 統計は「プロバイダ時間」と「ツール時間」の実測であって TTFT ではない。fork は末尾からのみ（`upToSeq` は API に用意済み）。参照は 1 メッセージ 3 件までで、4 件目以降はユーザーの本文に残るだけで展開されない。
- **次の一手**: WP-61（メッセージ評価・ショートカット・テーマ/フォント・Open In・シークレットマスク）。

## 5.28 2026-11-05 WP-61（評価・外観・ショートカット・Open In・マスク）
- **実装**:
  - `packages/hy-cli/src/feedback.ts` + `POST/GET /api/sessions/:id/feedback`: 7 カテゴリ・任意メモ（600 文字）を `<stateDir>/feedback.jsonl` に追記。検証は `validateFeedback`、壊れた行は読み飛ばし、要約（up/down）を返す。**どこにも送信しない**ことを UI にも表示。GUI は回答の ✓/✗ と `/feedback [メモ]`。
  - `packages/hy-cli/src/secret-mask.ts` と `web/src/secret-mask.ts`: sk / GitHub / AWS / Slack / Google / Bearer / PEM / 代入の 8 種を表示時だけマスク。代入を先に処理してパラメータ名を残し、既定は先頭 6 文字＋伏字。クライアント実装はサーバ実装と同一コーパスで出力一致をテスト。設定でオン/オフ（既定オン、`localStorage`）。
  - `packages/hy-cli/src/open-in.ts` + `GET/POST /api/open-in`: VS Code（ユーザー/システム）・Cursor・Sublime・Notepad++・Explorer・Windows Terminal・PowerShell・Git Bash を実行ファイルの存在で検出し、検出済み id のみ起動。`isLocalAddress` でローカル接続に限定し、パスは `safeWorkspacePath` でワークスペース内に限定。PowerShell は `-NoExit -Command Set-Location -LiteralPath`（クォート二重化）。
  - `packages/hy-cli/web/src/shortcuts.ts`: アクセラレータの正規化（裸キーは Escape/F1〜F12 以外を拒否）、既定 8 アクション、端末別 `localStorage`、競合検出、録音・リセット UI。グローバル handler は入力中でも修飾キー付きのみ発火。
  - 外観: テーマ `light|dark|system`（`matchMedia` 購読）と本文/コードフォント（危険文字を除去して `--font`/`--mono`）。`packages/hy-cli/web/src/i18n.ts` は `registerLocaleMessages` / `localeChoices` で実行時に辞書を追加でき、未知ロケールは英語・未知キーはキー名にフォールバック。
- **検証**: 単体 394 件 PASS（`feedback.test.ts` 3・`secret-mask.test.ts` 6・`open-in.test.ts` 4・web `shortcuts.test.mjs` 4・web `i18n-locale.test.mjs` 2 を追加）、`pnpm test:integration` 102 件 PASS（評価の保存と検証・Open In の拒否 1 件を追加）、`pnpm test:regression` 28 件 PASS、`pnpm typecheck`／`build` exit 0、`check:api`（90 ルート）一致。
- **注意**: 評価はローカルファイルのみで送信経路は無い。ショートカットと外観は端末（ブラウザ）保存でワークスペースには書かない。Open In は別マシンからのアクセスでは 403（SSH 時は非表示と同じ判断）。ロケール辞書の追加は API のみで、UI から新しい言語を読み込む導線は未実装。
- **次の一手**: WP-62（オプトイン OTel）。

## 5.29 2026-11-05 WP-62（オプトイン OTel）
- **実装**: `packages/hy-cli/src/telemetry.ts`。OTLP/JSON を `<endpoint>/v1/traces` へ POST するだけで、依存は増やしていない。既定は無効（`telemetry.enabled` か `HY_OTEL_ENDPOINT` のときだけ有効）。エンドポイントはローカル（`127.0.0.1` / `localhost` / `::1`）に限定し、`allowRemote: true` を明示したときだけ別ホストを許す。`sampleRatio`、キュー上限 500（古いものから破棄）、コレクタが落ちていても 0 を返して実行を妨げない。レスポンス本文まで読み切って undici のソケットを残さない。
- **計測点**: `web-server.ts` がエージェントのイベントから **step**（step-start→step-end）、**tool**（tool-start→結果）、**turn**（ターン開始→終了）の span を作り、ターン終了時に 1 回 flush する。属性は run id・kind・モデル名・ツール名・成否・`hy.llm_ms` / `hy.tool_ms` / `hy.first_response_ms` / 件数だけで、**メッセージ・ツール引数・出力・プロンプトは構造的に入らない**。
- **検証**: 単体 401 件 PASS（`telemetry.test.ts` 7 件: 既定 off・ローカル限定の検証・OTLP 形状・無効時はネットワークを触らない・壊れたコレクタ・キュー上限・内容が入らないこと）、`pnpm test:integration` 103 件 PASS（既定 off では送らないこと、有効時に step/tool/turn が届き README.md や “Web Fixture” が payload に現れないこと）、`pnpm test:regression` 28 件 PASS、`pnpm typecheck`／`build` exit 0、`check:config-schema` 一致（`telemetry` をスキーマへ追加）。
- **注意**: 既定 off のままでは一切送信しない。内容を送らない設計なので「セッション内容は送らない」はテストで固定している。TTFT ではなく「最初の応答まで」を `hy.first_response_ms` として送る（プロバイダがトークン時刻を返さないため）。
- **次の一手**: WP-63（英日ドキュメント・パッケージ README・i18n キー検査）。

## 5.30 2026-11-05 WP-63（ドキュメント・i18n 検査）— M6 完了、v0.4.0
- **実装（文書）**:
  - `README.ja.md`: 日本語の入口。ビルド、起動、コマンド表、初回ウィザード、更新、GUI の M6 までの機能、サンドボックス既定、オプトイン OTel、テスト、ドキュメント一覧。
  - `docs/troubleshooting.md`: 症状別（起動しない・モデルが答えない・ターンが進まない・サンドボックスが拒否する・401/403・更新・文書プレビュー・トレースが出ない・ビルドが古い）に確認手段を 1 つずつ。英語の後に日本語の同構成。
  - `docs/migration.md`: 0.1.x → 0.2.0 のセッション形式 v2、バンドル/プロファイル、API 契約、`update`/`telemetry` 設定、フィード導入の 4 手順、DSH プロトタイプから持ち運ぶもの。英日併記。
  - `packages/{core,seams,hy-cli,desktop,sdk}/README.md`: 役割・主なモジュール・直すべき契約・テスト。ルート `README.md` にドキュメント一覧と M2〜M6 の追加機能。
- **実装（コード）**: `packages/hy-cli/web/src/i18n.ts` に `hasTranslation` を追加。`packages/hy-cli/web/test/i18n-keys.test.mjs` がビルド済みバンドルの `tr('…')` / `translate(_, '…')` を抽出し、英語辞書の所有を検査する（英語の値がキーと同一のことがあるため値比較はしない）。M5/M6 のキーが ja/zh で英語のまま残っていないことも固定。
- **リリース**: ルート `package.json` と `packages/core/src/version.ts` を **0.4.0** にし、`pnpm check:version` で一致を強制（計画の「M6 完了で v0.4.0」）。
- **検証**: 単体 404 件 PASS（i18n 3 件を追加）、`pnpm test:integration` 103 件 PASS、`pnpm test:regression` 28 件 PASS、`pnpm typecheck`／`build` exit 0、`check:api`（90 ルート）・`check:protocol`・`check:config-schema`・`check:version` すべて一致。
- **注意**: ドキュメントは実装済みの範囲だけを書いている（プラグインマーケット・SSH・クラウド・マルチユーザーは除外のまま）。`README.ja.md` は要約で、詳細は英語の README と `docs/implementation_status.md` を正とする。
- **次の一手**: 計画の実装はここで完了。残りは運用（実機パッケージ・署名、外部プロバイダでの実走）。

## 5.31 2026-11-05 引き継ぎ書対応（版番号の一本化・時刻表示・テストガード）
- **版番号**: MCP `initialize` の `serverInfo.version` を `HARNESS_VERSION` に、GUI サイドバーの fallback を `'0.1.1'` から `'unknown'` に変更。`packages/{core,seams,hy-cli,desktop,sdk}/package.json` を 0.4.0 に統一し、`scripts/check-version.mjs` を「ルート・`version.ts`・全パッケージ・MCP `serverInfo`・GUI fallback」の 5 点検査に拡張。`check-portable-lock.mjs` と desktop の固定バージョン文字列も除去。`release/HY-HARNESS-0.4.0-portable.exe` を再生成し、Electron のスクリーンショットでサイドバーが `Desktop · v0.4.0` になることを確認（`screenshots/desktop-version.png`）。
- **相対時刻（サイドバー）**: `packages/hy-cli/web/src/time-format.ts` を新設。`formatRelative`（たった今 / N分前 / N時間前 / N日前 / 1 週間以上は日付）、`formatClock`（24 時間表記）、`formatTimestamp`、`messageTimeHtml`。`app.ts` の `formatTime` はトレース・アウトラインの絶対時刻に残し、サイドバーの最終時刻だけ相対表示にした。i18n に 4 キー（en/ja/zh）。
- **メッセージの絶対時刻**: user / assistant のマークアップを `packages/hy-cli/web/src/message-view.ts` に抽出（DOM 非依存）。`<time class="msg-time" datetime="…" title="…">` を本文の後に付け、`.msg-time` の CSS を追加。マスク表示と Markdown エスケープもこのモジュールが持つ。
- **テスト**: `web/test/time-format.test.mjs`（境界 9 種 + ロケール + 不正値 + メッセージ要素）と `web/test/message-view.test.mjs`（時刻・steering・画像件数・マスク・エスケープ）。`documents.test.ts` に piped spawn のプローブを入れ、EPERM 環境ではその 1 件を `# SKIP` に。`web/test/orchestration-intent.test.mjs` の import を `../dist/` に統一。
- **検証**: `pnpm typecheck`／`build` exit 0、単体 **414 件**、結合 **104 件**（MCP の `serverInfo.version` 1 件を追加）、回帰 **29 件**、`cargo test --workspace` 53 件、`check:version`（5 点）・`check:api`・`check:protocol`・`check:config-schema` すべて一致。
- **注意**: 実機の Open In 起動・LibreOffice 変換の見た目・生成タイトルの実プロバイダ応答は未確認（GUI の描画と API の結合テストまで）。`G:` への同期は読み取り専用のため未実施。詳細は [docs/handover-2026-11-06.md](docs/handover-2026-11-06.md) §8。

## 5.32 2026-11-05 配布物の固定名（HY-HARNESS.exe）
- **決定**: 自己更新は「動いている exe を同じパスで置き換える」方式なので、ファイル名に版を入れない。`electron-builder.yml` の `artifactName` を `HY-HARNESS.${ext}` に変更し、成果物は常に `release\HY-HARNESS.exe`。版はサイドバー・`bootstrap.version`・署名フィードで持つ。
- **付随変更**: `scripts/tag-next-artifact.mjs` は `HY-HARNESS-next-<timestamp>.exe` を `release\next` に作る（最新 3 件だけ残す）。`check-portable-lock.mjs` と desktop の案内文、README・`implementation_status.md`・`migration.md` の名前を固定名に更新。
- **不変**: scheduled task による差し替え、`.bak-<timestamp>.exe` への退避、SHA-256 検証とロールバック、ステージ候補の探索場所（`next` / `update` / `<stateDir>\update\download` / `HY-HARNESS.next.exe`）。
- **移行**: 旧名（`HY-HARNESS-0.1.0-portable.exe` など）で動かしている場合は、そのファイルを更新すれば中身だけ新しくなる（名前は旧名のまま）。固定名へ揃えるときは新しい `release\HY-HARNESS.exe` を使い、ショートカットの向き先を変える。

## 5.33 2026-11-08 レビュー残件3件の修正

- **目的・成功条件**: 大きな履歴イベントの後も連番を重複させない、永続シェルの停止・時間切れで子プロセスも終了する、コミット済みのワークツリー変更を二重適用しない。
- **履歴**: `session-log.ts` の末尾読み取りを、完全なイベントを見つけるまで拡張する方式に変更（固定256 KiBでは大きなイベントを読めず、別プロセスの採番を見落としていた）。ロック取得失敗・時間切れでは書き込みを拒否する。大きなイベント・破損した末尾・ロック競合のテストを追加。
- **永続シェル**: 既存の `JobHandle` を再利用し、コマンドを受け付ける前にPowerShellをJob Objectへ所属させる。停止・時間切れ・終了時にプロセスツリーを終了し、Jobへの所属に失敗した場合は永続シェルを提供しない。実際の子プロセスが停止後・時間切れ後に書き込まないテストを追加。
- **ワークツリー**: 取り込み元が既にコミット済みなら追加コミットを省略し、取り込み成功時のHEADを適用済み位置として保存する。保存失敗は明示的に報告する。取り込み後に本体側を編集しても、再取り込みが空になり競合しないことをテスト。
- **検証**: `pnpm build`・`pnpm typecheck`・`pnpm test`（632件）、Rustのshellテスト5件、`cargo clippy -p hy-exec-server --all-targets -- -D warnings`、`cargo fmt --all -- --check`が成功。`node scripts/test-integration.mjs persistent-shell`（GUI/API経由の結合テスト1件）成功。元の停止再現手順で子のNodeが停止後に書き込まないこと、3プロセスの追記で78イベントの連番が一意かつ昇順であることを確認。実行デーモンはdebug/releaseの両方を再生成した。F:のハードリンク非対応によるビルドキャッシュのコピー警告は残る。
- **範囲**: 既存ログに既に存在する重複番号の自動修復、全結合テスト、配布アプリ`release/HY-HARNESS.exe`の再作成は行っていない。

## 5.34 2026-11-08 DSH比較の改善（完了）

- **ユーザーの目的**: 現行の書類処理ベンチマークでDSHとの有意差が出なくなるまで改善する。
- **手順**: 画像対応の誤判定を修正 → HY/DSH各1回の動作確認 → 実ログから残る時間・トークン・手数の原因を修正 → 固定した実装で新規10回ずつの確認比較。課題・採点・モデル・effortは変更しない。
- **判定（ユーザー確認済み）**: 全7チェックの通過を維持し、既存レポートの95% Welch区間でHYが有意に劣る指標をなくす。HYが有意に優れる結果は維持する。少数試行・途中停止・外れ値の恣意的除外で「有意差なし」を作らない。探索用データと最後の確認比較は区別する。
- **確認済みの原因**: `opencode/deepseek-v4.1-flash`がモデルカタログにないため、名前による推測で画像非対応になっていた。実APIへ送信する前に`read_image`を拒否し、旧`tb2-smoke`ではOCRの導入と回避策に約14.4分かかった。
- **変更と検証**: OpenCode経由の同モデルを画像対応としてカタログへ追加。既存の明示`vision:false`は優先する。ビルドと設定・カタログテスト19件が成功。
- **初回の実API確認**: `2026-11-08-vision-smoke`（各1回、並列2）。両方7/7。HYは222秒・20要求・33ツール・キャッシュ外26,435トークン、DSHは141秒・25要求・35ツール・キャッシュ外28,540トークン。旧HYの1,383秒・93要求から大幅改善。ただしHYは4096px制限で2枚を読み取れず、縮小画像を作っていた。
- **次の修正と実API確認**: 入力8 MiB上限を維持しつつ画像の辺長上限を8192pxへ変更（実データのスキャンは4134×5847px）。180秒の前景待機が120秒のRPC既定期限で先に切れないよう、既定の通信期限を前景待機+30秒以上にする。明示的な期限指定は優先する。高解像度の実PNGと上限超過・期限指定の回帰テストを追加し、関連49件・全単体634件・型検査が成功。`2026-11-08-image-limit-smoke`はHYが122秒・22要求・42ツール・キャッシュ外39,486トークンで7/7。画像25件をエラーなく読み取った。
- **確認比較（完了）**: `2026-11-08-vision-confirm-10`、HY/DSH各10回・並列2。全20回がexit 0・全7チェック合格で、除外は0回。探索結果とは混ぜず、予定の20回を最後まで測定した。`implementation.json`に保存した実行用コードとRust実行ファイルのSHA-256は終了後も全件一致した（`validation.json`）。
- **判定結果**: [全結果と95%区間](bench/results/2026-11-08-vision-confirm-10/report.md)ではHYが有意に劣る指標は0。総入力は平均303,370対513,174（差の95%区間 -406,767〜-12,842）、出力は6,878対9,371（-4,285〜-702）、モデル待ち以外は10.6対16.4秒（約-8.9〜-2.8秒）でHYが有意に少ない。合計実時間は184対207秒で有意差なし。事前の完了条件を満たした。
- **使用量の照合**: 比較終了後、合成した公開用テキストだけでストリーム2回・非ストリーム1回のAPI生使用量とHYの正規化結果を照合し、全件一致（`usage-validation.json`、ベンチマーク集計には含めない）。同じ入力の最初の2回はAPI自身がキャッシュ0を返し、3回目は1,024トークンのヒットを返した。確認した応答では未対応の使用量フィールドによる取りこぼしは見つからず、集計コードは変更しなかった。
- **残る限界**: キャッシュ命中率の平均はHY79.1%対DSH88.0%、差の95%区間は-18.8〜+1.1ポイント。キャッシュ外入力は55,976対49,418、差の区間は-19,753〜+32,869。いずれも有意な悪化とは判定されないが、同等性や将来の非劣性を証明した結果ではない。API待ちが約12分の回を両者とも含み、時刻による変動も大きい。命中率は要求数・総入力を減らすだけでも下がるため、単独で最適化せず絶対量と併記する。
- **保留事項**: 本比較はこの1課題・固定モデル・各10回の範囲。配布アプリの再生成、他課題への一般化、ベンチマーク中に見えたPythonのCP932出力エラーへの環境変更は行っていない（該当回も最終的には合格）。
- **データ送信の確認**: 入力17文書が公開Terminal-Bench 2の固定コミット`2fd12b88aafd`のGit blobと全件一致することを確認した上で、既存OpenCode APIを使用。自動審査の初回拒否後、公開データである検証結果を示して再審査が通った。私有文書は対象に含めない。

## 5.35 2026-11-08 HY実ログの挙動レビューと修正（完了）

- **目的・成功条件**: 直前のHY10回のログから、ハーネスの説明・出力・実行環境が原因の失敗や遠回りを調べる。ユーザーの追加指示により、裏付けた箇所は修正し、再現例と回帰テストで検証する。モデル自身の分類上の迷いや通常の内容確認は不具合と混同しない。
- **調査済み**: 10/10回でPythonのCP932出力エラー、#1で`present`の引数配置違いが2回失敗、#4でGitの信頼設定の脱落とBash形式の入力、#5で内容が添付されない`document_preview`の誤用、#9で縮小・切り抜きの手戻りとPowerShellの混在テーブル表示による再確認を確認。
- **修正済み**: (1) 子プロセスのPython出力を既定UTF-8にした（明示の環境変数受け渡しは優先）、(2) 比較専用のGit信頼用変数をHYにも明示受け渡し、(3) プレビューの説明と`contentAttached: false`で内容未添付を明示、(4) 引数エラーに入力型と`args`の配置を案内、(5) 通常出力・CLIXMLの端末装飾を除去し、通常／詳細モード双方のPowerShell案内と元画像を直接読む案内を追加。画像の切り抜き座標の迷いはモデルの判断も含むため、説明改善として扱い、新しい画像加工ツールは追加していない。
- **検証**: ビルド・型検査、単体635件、関連結合6件（実Pythonの一回限り／永続シェル・明示設定、プレビュー、成果物提示）、比較設定1件、Rust debug/releaseビルド・Clippy・fmtが成功。最後に通常モードの説明も追記し、再ビルドとプロンプト・SDK17件が成功。
- **実API動作確認**: `2026-11-08-behavior-smoke`は109.112秒・14要求・20ツールで7/7。文字コード・ツール・シェル終了コードの失敗はすべて0で、JPG11枚を元画像から直接読んだ。初回は利用上限により自動審査を完了できず未実行だったが、ユーザーの再開指示後に同じ確認が承認され、実行した。生ログと修正時のコードのハッシュを保存。通常モード向けの説明追記はこの実API確認後なので、これについては17件のテストまで。
- **記録・限界**: [挙動レビュー](docs/hy-behavior-review-2026-11-08.md)に優先度・実ログ位置・修正理由を記載。前節の固定20回のログは保存し、新実装の成績として流用しない。全結合テスト、配布アプリ再生成、各10回の比較再実行は行っていない。

## 5.36 2026-11-08 プロンプトの責務に関する設計方針

- **ユーザーの方針**: ツールの説明はできるだけツール側に置き、システムプロンプトは最初に知る必要のある前提と全体の方向性だけで構成する。
- **配置**: ツールの用途、引数、制限、状態の持続、具体例、他ツールとの使い分け、失敗時の対処はツール定義とツール結果・エラーに置く。システム側は役割、作業への姿勢、完了の判断、全体に適用する制約などに絞る。日付・進捗等の変動情報は既存のセッション文脈を使う。
- **今後の改善方法**: 実ログで迷いが見つかったら、まず該当ツールの仕様・説明・エラーを直し、システムに個別の注意書きを積み増さない。説明の正本をツール側に寄せ、通常／詳細表示やnative／SDKで必要な案内が欠けたり食い違ったりしないようにする。
- **現状と次の整理対象**: `lean4`はこの方針に近いが、既定の`lean`にはPowerShellの例、検索先、パッチの作り方などのツール固有情報が残る。今後整理するときは、必要な説明が実際にモデルへ渡ることを確かめてから移し、システム側の重複を削除する。今回の変更は方針の記録のみで、既定モードや実行動作は変更していない。

## 5.37 2026-11-08 迅速・丁寧モードと比較改善（進行中）

- **目的**: DSHの機動性と、Codexの慎重な検証を参考に、迅速な完成と細部まで検証する2つの作業モードを実装し、それぞれの目的に沿って比較・改善する。完璧は保証せず、必要な検証と未検証事項を明確にする。
- **成功条件**: GUIとCLIから切り替えでき、再開時に復元され、両モードで共通の権限・安全制約を維持する。固定のシステム指示とツール定義を維持し、モード変更は会話末尾のセッション文脈で伝える。切り替え前の履歴が同じであることをテストする。
- **評価手順**: 既存の公開書類処理課題とコード作業課題を使い、同一モデル・同条件でDSHと両モードを比較する。実行結果、成功・失敗、使用量、ツール履歴、最終回答を保存し、原因に基づく改善と再評価を行う。探索と最終評価は混ぜず、試行途中の失敗を捨てない。必要なら公開の難しい課題を追加する。
- **初期実装**: モードは`fast`（迅速、既定）と`thorough`（丁寧）。GUIの選択欄、`/work-mode`、`hy run/chat --work-mode`、セッションログへの保存と復元を追加。実行中の変更は拒否し、次のターンから反映する。サブエージェントには起動時のモードを渡す。具体的なツールの使い方は追加せず、システムプロンプトの責務分担を維持する。
- **進行状況**: ビルド・型検査・単体636件が一度成功。モード切り替えによる会話プレフィックスの維持、GUI API切り替え・再起動後復元を検証。後続のCLIオプション・サブエージェントへの継承を含む再検証と実API比較が必要。
- **探索1（実行中）**: `2026-11-08-work-modes-stats-pilot`、合成の小さなコード課題、DSH／迅速／丁寧の各2回、並列2。モデルは全てOpenCode DeepSeek V4.1 Flash・effort max。実装ハッシュと試行条件は結果フォルダの`design.json`に保存し、完了前のコード変更はしない。探索結果は統計的な優劣の確定に使わない。
- **探索1の途中観察**: 迅速#1は104秒・5/5合格、34ツール・入力388,797トークン。ただし`apply_patch`に`*** Begin Patch`形式を送って2回失敗し、別の編集手段で復旧した（セッションログ seq 26–27）。現行のエラー`no file sections found`では必要な形式を案内しない。モデルが不要な不正テスト期待値を作り、その後修正したこともログに含まれる。全6回の完了後、発生頻度と原因を調べる。
- **探索1の事後追加検査**: DSH・迅速・丁寧の初回はいずれも既存採点5/5だが、中央値に`[Number.MAX_VALUE, Number.MAX_VALUE]`を与えると有限の中央値ではなく`Infinity`を返す。課題の偶数個の中央値を正しく求める要件に対する境界条件で、通常採点は検出しない。先行して定義した評価ではないため参考検査として別記録し、過去の採点を変更しない。NaN/Infinityの入力拒否については設計メモでの記述と既存関数の振る舞いが一致していないため、要求違反と断定せず別途扱う。
- **汎化の方針（ユーザー指示）**: 特定ベンチマークの入力や期待値に合わせて指示を作らず、実際の利用全般に共通する原因（ツールの分かりにくさ、失敗からの復帰、リスクに応じた検証、正確な報告）を改善する。改善に使った課題と別種類の確認課題を分け、得点だけでなく作業時間・検証の妥当性・出力・副作用も見る。公開の難課題候補`terminal-bench/cancel-async-tasks`は非同期キャンセルを扱うが、公式テストはLinuxのSIGINTを使用し、現在のWindows環境にはDockerが見つからない。移植する場合は適応範囲を明示し、公式結果と混同せず、先に正解例と未実装例で採点器を検証する。
- **別課題の採点器の準備（失敗も記録）**: Windows向けに親`asyncio`タスクのキャンセルで実行中・待機中の処理を検証する試作を追加。最初の正解例として作った`Semaphore`＋`gather`実装は、待機中タスクがキャンセル時に開始されるケースで不合格となった。正解例の誤りと判明したため、固定数のワーカーで未開始タスクを保持する例に変更して再検証する。この事実はモデルへの指示や既存の採点結果には反映しない。
- **探索1完了**: 全6回が既存の5項目に合格。迅速は90秒・104秒、丁寧は170秒・485秒、DSHは307秒・559秒。各2回ではばらつきが大きく、速度の有意差は判断しない。全6成果物で大きな有限値の偶数個の中央値が無限大になることを事後検査で確認。無効値拒否など設計メモと既存実装の一貫しない項目も含め、`posthoc-edge-checks.json`に採点外の参考情報として保存した。DSHでは通常の`npm test`が制限環境で失敗し、分離をオフにして再実行した旨を報告。両HYモードでは非対応パッチ形式による失敗があった。すべての結果・応答・実行ログを残し、失敗や遅い試行を除外していない。
- **探索1後の一般的な修正**: `apply_patch`の通常／詳細ツール説明に対応形式を明示し、非対応形式には正しい入力への案内を返す。空のチャットでモードを選択しても、初回送信前に作成される会話へ適用する。いずれも特定課題の期待値を指示に含めない。
- **別課題の採点器**: 固定数のワーカーを用いる例が全項目に合格し、未実装と逐次実行が不合格になることを確認。非同期の親タスクのキャンセルで代替するWindows版であり、公式Linux版SIGINTテストと同一ではない。次にこの別課題で各方式を比較する。
- **別課題の実行中に見つかった準備不備**: `async-cancel-windows`は初期ファイルがないため、比較ランナーの最初の`git commit`が空コミット不可で失敗するが、ランナーは終了コードを確認していない。迅速#1の`git log`は未コミットで失敗した。現在の固定9回はそのまま終了まで記録し、次の試行前に空の作業領域でも初期コミットを作れるようにして準備エラーを明示的に扱う。完了後、全方式に同じ条件だったこととログの影響を確認する。
- **比較条件の注意**: 探索1ではDSH#1が3回、DSH#2が少なくとも4回、F:上の書き込み時にハードリンク関連の`EISDIR`で失敗して迂回した。DSH#2では通常のテスト実行に伴う`spawn EPERM`と、承認経路のない権限拡張の拒否もあった。環境差が所要時間に混ざるため、この探索だけでHYの一般的な優位を主張しない。同条件の別ファイルシステム上でも確認する。
- **非同期課題の途中観察**: 迅速#2は470秒・5/5で、非同期クリーンアップと割り込みを含む追加検証を重ねた。迅速#1の215秒と比べてもばらつきが大きく、モード指定だけで所要時間を保証できない。固定の全9試行を完了させてから、作業ログと最終回答に基づき、検証範囲と作業の切り上げ方を再評価する。
- **非同期課題の探索結果**: 迅速は5/5・5/5・4/5、DSHは5/5が3回、丁寧は5/5が3回。ただし丁寧#3は900秒で打ち切られ最終回答がなく、完了成功ではない。迅速#3は待機中の処理と非同期クリーンアップの組み合わせを検証しないまま広い保証を最終回答に記載。丁寧#3はシグナルの細かな条件に調査を広げ続けた。比較中、画面テストを並行実行した時間があり、時間比較の交絡として扱う。実行した12ファイルのハッシュは開始時と完全一致。
- **画面テストでの失敗と対処**: 制限環境ではブラウザ起動待ちで90秒の時間切れ。通常の権限では初期版テストがターン開始直後のログを読んで2回失敗したため、ターン終了を待つよう修正し、画面で初回送信に丁寧モードが反映されることを確認した。
- **探索結果を踏まえる変更予定**: 作業方針として要求に関係する失敗経路を確認し、必要な確認が済んだら提出することを両モードに反映。ツール固有のパッチ形式エラーはツール側で案内する。比較ランナーの初期コミットと失敗記録、時間切れを成功と誤表示する集計を修正し、別条件で検証する。
- **一般化した修正**: 迅速には主要な要求と関係する失敗経路をリスクに応じて確認し、確認した範囲を超える保証をしないことを追加。丁寧には調査を要求・リスクに比例させ、必要な確認後に提出することを追加。どちらも会話末尾のセッション文脈に置き、個別ツールの使用法をシステムプロンプトに増やさない。`apply_patch`の番号なしハンクには形式例と代替ツールを返す。
- **比較基盤の修正**: 空の初期作業領域でも初期コミットを作成し、準備・実行・採点の失敗を記録。既存の作業領域・結果を上書きしない。時間切れは成果物の検査が通っても未完了として表示し、未終了ターンを0分扱いしない。誤った初版集計も`report-initial-invalid.md`に保存した。
- **修正後の検証**: ビルド・型検査・単体637件・比較器テスト4件・モード切り替えと再開・空チャットからのブラウザ操作・API型とスキーマ検査が成功。非同期課題はハードリンク可能な別領域で各2回の追試を開始。これは診断に使った課題の再確認であり、独立した一般化の証拠とは扱わない。
- **文書課題の制限環境での失敗**: 6試行とも開始直後に失敗。HYは作業領域のアクセス許可設定に失敗し、DSHは既存のheadlessプロファイルへの書き込みを拒否された。採点器も実行できず、モデルの性能ではない。全6件のログを`2026-11-08-work-modes-financial-ntfs`に保存し、実行権限を確保した別スタンプで同条件を再実行する。
- **非同期課題の修正後追試**: NTFS・初期コミットあり、DSH／迅速／丁寧を各2回。全6回で5/5かつ正常終了。迅速は199・144秒、DSHは424・261秒、丁寧は407・409秒。全12実行ファイルのハッシュは開始時と一致。DSHログにF:で見られたEISDIR／EPERMは見られない。各2回では速度や品質の統計的優劣は判定できず、診断に使った課題の再試行でもある。パッチ形式誤りは残り、修正したツールエラーを受けて復旧した。
- **画像を含む文書課題でのキャッシュ集計上の不確かさ**: HY迅速#1は前半11ステップの`step/end`にcacheHitTokensがなく、後半では報告された。ストリーム応答パーサーはプロバイダーの報告なしと明示的な0をどちらも省略するため、現在の比較集計は欠落を0として扱い、真のヒット率と断定できない。実行中の条件を維持し、全試行後に報告の有無を分離する。
- **文書課題の再実行**: 公開課題のWindows版、画像11枚・PDF6件、DSH／迅速／丁寧を各2回。全6回が7/7かつ正常終了。DSHは95・134秒、迅速は183・86秒、丁寧は167・282秒。全12実行ファイルのハッシュは開始時と一致。課題は過去のプロジェクト作業で使用済みであり、独立した汎化・有意差の証明ではない。最初に制限環境で失敗した6回も別フォルダーで保持。
- **キャッシュの観測修正**: ストリーム応答でプロバイダーが明示的に0を報告した場合と項目を報告しない場合を区別する。履歴やターンの一部が不明なら画面とレポートでキャッシュ割合を不明扱いとし、再起動後もその状態を復元する。既存の生ログは変更せず、旧パーサーが0と欠落を区別できなかった過去の値は再集計時に不明とする。
- **残る評価上の制約**: モードの会話プレフィックス維持はテストで確認したが、切り替え時の実プロバイダーのキャッシュヒットは未検証で、履歴が不完全な過去のヒット率も確定できない。各条件2回の追試は統計的な同等性や有意差の不在を証明せず、文書課題は過去に使用済み。独立した未使用課題と十分な反復での検証が次の段階。
- **最終コード検証**: ビルド・型検査・単体639件、比較ランナー／採点器6件、GUI API結合36件、API型・スキーマ整合が成功。空チャットからの実ブラウザ確認はキャッシュ表示の追加前に成功し、表示自体は単体とAPI再開の結合テストで確認した。結果、試行中の失敗、比較基盤の初版誤集計、環境制約と再実行をそれぞれ保存。

## 5.38 2026-11-08 追加の比較・一般化検証（進行中）

- **計画と成功条件**: 前回各2回だった比較を、同一モデル・同一作業条件の各10回で再測定する。試行順の偏りと同一ハーネスの同時実行を抑え、失敗・時間切れも保存する。過去に調整に使っていない別種の課題でも確認し、実APIによるモード切り替えとキャッシュ記録を検証する。得られた事実から汎用的な不具合を直し、再評価する。
- **比較実行順**: 各ラウンドの3方式がすべて終わってから次へ進み、方式の開始順をラウンドごとに巡回する。ワーカーモデルと推論強度が比較条件と異なれば開始前に拒否する。どちらも回帰テストで確認。
- **未使用のセキュリティ課題の準備**: 公開Terminal-Bench 2の`fix-code-vulnerability`とBottleの固定コミットをWindows向けに適応。最初、ブラウザ表示の行番号を実ファイルと取り違えて配布手順を疑ったが、実ファイルへの適用では正しいことを確認した（`bench/results/security-candidate-audit.json`）。初版の採点器確認では、Windows側のGit設定が元のLFテンプレートをCRLFに変え、正常な公開元コードで既存357件中6件が失敗した。失敗ログは`bench/results/security-verifier-initial.log`に保存。`core.autocrlf=false`で別の固定アーカイブを作成し、改めて検証する。これらの小規模なデータ取得・検査器確認は文書課題の比較と重なったため、実時間への影響を記録する。
- **初版の失敗回数**: CRLFの失敗は2回確認し、2回目の完全ログを保存した。1回目は実行履歴の出力のみで、別ファイルとしては保存していない。
- **採点器の再検証**: LF版では公開元の修正済みコードが既存テスト・公開採点を通過し、欠陥入り版は制御文字の検査に失敗した（`bench/results/security-verifier-lf.log`）。
- **Windowsパスの扱い**: 課題中の`/app`を作業領域の相対パスへ移し、採点時は同じファイルを示す相対・絶対パスを同等に扱う。相対パスの欠陥入り例と絶対パスの正常例の両方で再確認した（`bench/results/security-verifier-paths.log`）。公式Linux版と同一のスコアとは扱わない。
- **採点の独立性**: 公開元の既存テストはエージェントが編集できる作業領域ではなく、固定アーカイブから採点用領域へ展開する。作業領域のテストを意図的に壊した正常コードでも固定テストを正しく使うことを確認した（`bench/results/security-verifier-tamper.log`）。
- **採点設定の独立性**: 作業領域に置かれたpytest設定で採点が変わらないよう、採点専用の設定も固定する。不正な作業領域設定と壊した作業領域テストの両方を含む正常例が合格した（`bench/results/security-verifier-frozen-config.log`）。
- **未使用課題の事前条件**: 整理後の固定実装で、セキュリティ課題をDSH・迅速・丁寧それぞれ5回、同じ公開入力とWindows適応版採点器で実行する。開始後は完了・失敗・打ち切りの全試行を残し、結果を見て途中で打ち切らない。採点器の準備で答えを知ったが、モデル向けの一般指示には含めない。
- **方針への未対応**: 既定のシステム指示にはまだシェル構文やパッチ形式などの個別ツール説明が重複する。現在の固定比較後、対応する通常・詳細・SDKの説明を確認し、各提供方式で欠落しないようツール側へ整理したうえで別条件の比較と未使用課題で再評価する。
- **方針整理の準備**: 現行の実行ファイルを固定したまま、ソース上で個別のシェル・編集・検索説明をシステム側から対応ツール側へ移し、native PTCのSDK一覧も`run_code`定義へ移す変更を準備。遅延ツールが有効になったときSDK一覧にも反映する。変更後のビルドは固定比較完了まで行わない。準備中に型検査を並行実行したため、その小規模な負荷も実時間比較の注意点とする。
- **準備した変更の局所検証**: 比較中の実行ファイルとは別ディレクトリにコアだけをコンパイルし、指示・ツール定義のテスト8件、エージェントのテスト25件、型検査が成功。APIごとにツール説明の長さ制限が異なるため、PTCのSDKは`run_code`のコード引数の説明に置く。実プロバイダーでの受理とPTC動作は未検証。
- **配置の確認**: 同じ条件のnativeシステム指示は、PTCなしで1,695→968文字、PTCありで4,880→968文字。PTCのSDK 3,513文字はツール引数の説明へ移っており、単に入力総量がその分減ったとは扱わない。
- **復旧案内の追加整理**: 任意の`edit_file`が提供されない構成でも、パッチエラーが存在しないツールを勧めないよう、常に利用可能な入力形式を案内する。また、以前の実ログで確認した複数コマンドの途中エラーを見落とさないよう、最後の終了状態だけが返る場合がある旨をシェル自身の説明へ追加する。
- **追加ログからの共通修正**: 文書比較の丁寧#1は画像パスのタイプミスに対し生の`ENOENT`を受け、モデル自身で正しいパスに直して完了した。画像・部分編集・言語解析が共用するパス解決では欠落時に検索手段を示し、権限エラーや領域外パスは従来どおり区別する。画像の欠落・領域外・正常な添付の局所テストが成功。
- **回答と検証の途中観察**: 文書課題の迅速#1・#2は移動数、集計、再計算したことを簡潔に報告。丁寧#1はさらに移動前後のハッシュ、抽出根拠と明細を確認・報告した。いずれも同じ公開入力に対する探索的な観察であり、モード間の一般的な差や有意差とは断定しない。
- **丁寧モードの次案**: 重複する確認の膨張を防ぐため、異なるリスクを明らかにする検査を優先する一般的な方針を追加。ただし初稿の「新しい証拠がなければ繰り返さない」だけでは、変動や不安定性を測る反復を抑制し得るため、実測前に「変動や新たな証拠が必要とする場合は繰り返す」と補正した。比較中のビルドには未反映。
- **Codexを参考にした範囲**: [公開ガイド](https://developers.openai.com/cookbook/examples/codex/iterating-development-workflows-with-codex)が重視する観測可能な完了条件と実施済み検証の正確な報告を参考にする。一律に高コストな検証を要求するのではなく、ユーザーの指定どおりモードと作業リスクに応じて確認範囲を選ぶ。

## 5.39 2026-11-08 引き継ぎ（別セッションの利用上限による停止後）

- **状況**: 5.33〜5.38 の作業は全て未コミットのまま止まっていた。実行中のプロセスはなし。文書課題の固定 10 回比較（`2026-11-08-work-modes-financial-confirm-10`）は 30 回とも記録済みで、レポートだけが未作成だった。`design.json` に記録したファイルのハッシュは比較終了後も全件一致。
- **確認比較の結果**（[report.md](bench/results/2026-11-08-work-modes-financial-confirm-10/report.md)、対 DSH は `report-fast-vs-dsh.md` / `report-thorough-vs-dsh.md`）:
  - 解けた回数: 迅速 10/10、DSH 10/10、丁寧 9/10。
  - 迅速と DSH の比較（95% Welch 区間）では、迅速が総入力（−284K）、出力（−3.2K）、要求数（−7）、モデル待ち以外の時間、ターン時間、実時間（−0.9 分）で有意に少なかった。キャッシュ外入力、命中率、ツール数は有意差なし。
  - 丁寧と DSH の比較では、丁寧のツール数が +11 回で有意に多い。それ以外の指標は有意差なし。
- **丁寧 #10 の失敗原因**: ステップ 27 で、モデルがツール呼び出しを本文に書いた直後に `]}}` を繰り返すループに陥った。約 10 万文字を出力し続け、600 秒のストリーム上限で実行全体が `stream timed out`（exit 1）で終わった。応答が途絶えたのではなく、モデルの退行。
- **修正**:
  1. ストリーム中に、16 文字以下の断片が 4,000 文字以上続く繰り返しを検出したら、その場で受信を打ち切る（`Completion.degenerate: 'repetition'`）。エージェントはループ部分を除いて一度だけやり直しを促し（`turn/retry` の理由 `repetition`）、二度目は固定文で終える。
     - 通常の長文や表の罫線を誤検出しないこと、ストリームが打ち切られること、再開時に履歴を同じバイトで再現できることを単体テストで確認した。
     - 打ち切った応答にはプロバイダーの使用量が届かない。出力トークンは推定値とし、キャッシュ量は不明扱いにする。
  2. セッションログのロック待ちを 15 秒に延ばした。古いロックを奪うまでの 10 秒より長くし、書き込み中に落ちたプロセスのロックで書き込みが失敗しないようにした。タイミングはテストからだけ変更できる。
  3. `security-holdout` をランナーに登録した。展開には Windows の tar を使う（Git Bash の GNU tar が先にあると `C:` をリモートホストと解釈するため）。
- **検証**:
  - ビルド・型検査・単体 645 件（SDK スナップショットは 5.38 で準備したツール説明の移動に合わせて更新）。
  - 結合 147 件（並列 110 件、直列 37 件）、回帰 29 件、比較器テスト 8 件、セキュリティ採点器の実テスト（欠陥版は不合格、修正版は合格）。
  - Rust の全テスト、Clippy、fmt、生成ファイルの整合チェック。
  - いずれも成功。
- **コミット**: `ab218c5`（5.33〜5.38 のコードと文書、今回の修正 1 と 2）、`544e191`（結果データ）、`9c937cf`（修正 3）。
- **未使用課題の比較（開始）**: `2026-11-08-security-holdout-5`。DSH、迅速、丁寧を各 5 回、並列 2、ラウンドごとに開始順を回す。コミット `9c937cf` の実行ファイルで固定し、ハッシュを `design.json` に記録した。
  - この実装には 5.38 で準備したツール説明の移動が含まれる。前回の文書課題の比較とは HY の条件が異なる。
  - 各 5 回は探索扱いとし、有意差や同等性は主張しない。
- **未使用課題の比較（完了）**: 全 15 回が exit 0 で、除外は 0 回。終了後もハッシュは全件一致。結果は [report-hy-fast-vs-dsh.md](bench/results/2026-11-08-security-holdout-5/report-hy-fast-vs-dsh.md) と [report-hy-thorough-vs-dsh.md](bench/results/2026-11-08-security-holdout-5/report-hy-thorough-vs-dsh.md)。
  - 解けた回数: DSH 5/5、迅速 5/5、丁寧 4/5。
  - 迅速と DSH の比較: どの指標も 95% 区間が 0 をまたぐ。平均は迅速が実時間 2.9 分（DSH 3.4 分）、総入力 66 万（同 101 万）、ツール 32 回（同 38 回）。
  - 丁寧は平均 5.5 分、ツール 55 回で最も多かった。
  - 各 5 回のため、優劣も同等性も主張しない。
- **丁寧 #4 の失敗原因と修正**:
  - コードの修正自体は正しく、脆弱性のテストは全部通った。ただし `report.jsonl` を作る前にターンが終わっていた。
  - 最後の応答は `{"tools":[{"tool":"write_file",...}]}` という、本文に書いたツール呼び出しだった。これは JSON として正しいため壊れた呼び出しとは判定されず、`calls` / `tool` の形でもないため最終回答として扱われていた。
  - `tools` 配列を `calls` と同じ一括呼び出しとして実行するよう修正し、テストを追加した。
  - 確認比較で起きた丁寧の失敗（confirm-10 の #10、この比較の #4）は、どちらもハーネス側の扱いが原因で、どちらも修正済み。修正後の再計測はまだしていない。
- **検証**: 単体 646 件、結合 147 件が成功。

## 5.40 2026-11-08 丁寧モードの修正効果の再確認

- **方法**: コミット `50136c1` の実行ファイルで固定し、丁寧モードだけをセキュリティ課題と文書課題で各 10 回、並列 2 で実行した（`2026-11-08-thorough-recheck-security` / `-financial`）。2 つは順番に走らせ、互いの負荷が混ざらないようにした。全 20 回が exit 0 で、終了後もハッシュは全件一致。各 10 回なので、失敗率が変わったとは主張しない。
- **結果**:
  - 文書課題: 10/10（前回の確認比較は 9/10）。
  - セキュリティ課題: 8/10（前回は 4/5）。
- **修正 2 件が働いたか**: 20 回のログに、繰り返しの打ち切り（`repetition`）と `{"tools":[...]}` の一括呼び出しは 1 度も出なかった。どちらもまれな事象を対象にした修正で、この再確認では効果を測れていない。
- **新たに見つかった原因**: セキュリティ課題の失敗 2 回（#1、#4）は、どちらも同じモデルの癖だった。
  - 本文に書いたツール呼び出しの一括指定（`{"calls":[...]`）が最後の `}` を 1 つ欠き、その後ろに DeepSeek のネイティブテンプレートの閉じタグ（`</｜DSML｜ parameter>` など）が漏れていた。
  - 1 回のやり直しでもまったく同じ形を繰り返したため、ターンが固定文で終わり、報告ファイルが書かれなかった。
- **修正**: `recoverTemplateCall`（`reply-guard.ts`）を追加した。後ろが閉じタグだけで、足りないのが閉じ括弧だけで、直した結果がツール名を含む呼び出しとして読める場合に限り、呼び出しを直して実行する。やり直しの回数は使わず、`reply/recovered` を記録し、履歴には直した文字列を残す。
- **保存済みログでの照合**: これまでの比較で記録された「壊れた呼び出し」によるやり直し 9 件に、この修正を当てて確かめた。
  - 閉じタグが漏れた 4 件（今回の失敗 2 回を含む）はすべて直せた。
  - 引用符の漏れやキーの位置違いといった本当に壊れた 5 件は対象外で、従来どおりやり直しになる。誤って直したものはない。
  - 直した後にその回が解けていたかどうかは、実行し直さないと分からない。
- **検証**: 実際の応答を使った修正のテスト、エージェント経由のテスト（直した呼び出しの実行、やり直しを使わないこと、履歴の再現）を追加した。単体 649 件、結合 147 件、回帰 29 件が成功。

## 5.41 2026-11-08 閉じタグ漏れの修復の効果確認

- **方法**: コミット `4c2d223` の実行ファイルで固定し、丁寧モードでセキュリティ課題を 10 回、並列 2 で実行した（`2026-11-08-thorough-recheck2-security`）。全 10 回が exit 0 で、終了後もハッシュは全件一致。
- **結果**: 10/10 で解けた（修復前の 5.40 は 8/10）。
- **修復が働いたか**: `reply/recovered` は 6 回の実行で計 8 回記録された（#8 は 3 回）。修復が働いた 6 回はすべて解けた。修復前は、この形の応答が 2 回続くとターンが終わっていた（5.40 の失敗 2 回）。修復後はやり直しを使わずに作業が続いた。
- **残った壊れた呼び出し**: 2 回（#3、#9）は閉じタグ漏れではない壊れ方で、従来どおりやり直しで回復した。
- **限界**: 各 10 回の比較なので、8/10 から 10/10 への変化を統計的な改善とは主張しない。ただ、失敗の原因になっていた形が 10 回中 6 回の実行で実際に起き、そのすべてで作業が続いたことはログで確認できた。

## 5.42 2026-11-09 lean2〜4 の変更を今の版で検証（lean4 対 既定の lean）

- **ユーザーの依頼**: lean2〜4 の変更を今の版にも入れて、性能が落ちないか確かめる。
- **確認したこと**: `promptVariant: lean4` は、すでに今の版の上に乗っていた。
  - システムプロンプトは、lean2〜3 の規則（本文の JSON への注意を削除、意図を読む、中途半端で妥協しない、結論から書く など）を lean3 の構成で並べたもの。
  - ツール説明は `tool-docs.ts` の詳しい版で、5.38 の更新（`*** Begin Patch` 非対応の案内、表の整形、連結したコマンドの終了状態）も入っている。
  - そのため、新しい版は作らず、lean4 と既定の lean を比べた。
  - ツール定義の大きさは lean 4,355 文字に対し lean4 8,466 文字。システムプロンプトは 959 文字に対し 896 文字。
- **方法**: コミット `903e183` の実行ファイルで固定し、作業モードは既定の迅速。文書課題とセキュリティ課題で各 10 回、並列 2、ラウンドごとに開始順を回した（`2026-11-09-lean4-vs-lean-financial` / `-security`）。全 40 回が exit 0 で、終了後もハッシュは全件一致。
- **結果**: 両課題とも、両方の版が 10/10 で解けた。lean4 − lean の 95% Welch 区間は、全指標で 0 をまたいだ（有意な悪化も改善もない）。
  - 文書課題: 実時間 1.71 分対 1.75 分、キャッシュ外入力 3.1 万対 3.4 万、ツール 24 回対 25 回。
  - セキュリティ課題: 実時間 2.61 分対 2.00 分（差の区間 −0.49〜+1.71）、出力 9.5 千対 7.0 千（同 −0.95〜+5.9 千）、ツール 33 回対 29 回（同 −3〜+10）。いずれも有意ではないが、平均は lean4 がやや重い。
- **本文の JSON**: 本文に呼び出しを書いた回は、lean4 が 20 回中 4 回、lean が 20 回中 2 回だった。lean4 の内訳は、閉じタグの修復 1 回とやり直し 3 回。どれも作業は続き、合否には影響しなかった。差は有意ではなく、注意書きを消した影響とは断定できない。
- **限界**: 各 10 回なので、同等だとは言えない。セキュリティ課題で平均がやや重い点は、回数を増やさないと判断できない。丁寧モードでは測っていない。既定は lean のまま変えていない。
- **既定の変更（2026-11-09、ユーザー指示）**: 上の結果を受け、`promptVariant` の既定を `lean4` にした。
  - `lean` は設定で選べるまま残し、ベンチには比較用の `hy-lean` を追加した。
  - プロンプトを組み立てる関数自体の既定は `lean` のままで、既定の切り替えは設定の読み込みで行う。エージェントを作る 3 か所はすべて設定の値を渡している。
  - 設定の既定値と、`lean` の指定・不正な値の扱いのテストを追加した。設定スキーマ（`docs/config.schema.json`）も更新した。
  - 単体 650 件、結合 147 件、回帰 29 件、比較器テスト 7 件、生成ファイルの整合チェックがすべて成功。
  - ユーザー設定に `promptVariant` の指定はなく、実際に使われる値は `lean4` になることを確認した。

## 5.43 2026-11-09 作業モード「思索」（reflective）の追加

- **ユーザーの定義**: 大きな目的を強く意識し、プロジェクト全体の方向性が正しいかを常に確認する。目的が不明瞭なときはユーザーに確認して認識を擦り合わせる。常に目的達成のための優先度を考え、目的に響く要件は徹底的に詰め、重要でない要件にはとらわれ過ぎない。最終報告では優先度を低く見積もったものも全て報告し、確かめていないことは正直に伝える。
- **モデルに渡す文面**: 他のモードと同じく英語にし、会話末尾のセッション情報に入れる（システムプロンプトは変えないので、キャッシュは崩れない）。`ask_user` が使えるときはそれで確認するよう添えた。
- **実装**:
  - 作業モードの一覧をコアの `WORK_MODES` と `isWorkMode` に一本化した。CLI（`--work-mode`、`/work-mode`）、API の入力チェック、再起動後の復元、GUI はこの一覧を使う。GUI は別のバンドルなので、`types.ts` に同じ一覧を持つ。
  - これまで各所に書かれていた `'fast' | 'thorough'` を置き換えた。中には「thorough でなければ fast」として復元する箇所があり、そのままでは 3 つ目のモードが再起動後に迅速に戻っていた。
  - GUI の表示名は、日本語「思索」、英語 Reflective、中国語「思索」。ベンチには `hy-reflective` を追加した。
- **検証**:
  - 単体 651 件（各モードの文面が別であること、システムプロンプトに入らないこと、思索の要点を含むこと、値の判定）。
  - 結合 147 件。API で思索を選ぶと文面がモデルに届き、サーバーを再起動しても思索のまま戻ることを、既存のテストに追加して確認した。回帰 29 件。
  - CLI: `--work-mode reflective` がログに記録されて文面がモデルに届くこと、不正な値で 3 つの候補を示すエラーになることを確認した。
  - 実際の画面（モックモデル）: 選択欄に「迅速 / 丁寧 / 思索」が並び、空のチャットで思索を選んで送ると、最初のターンの前にモードが設定され、文面がモデルに届くことを確認した。
- **未検証**: 実際のモデルで思索モードがどう振る舞うか（目的の確認や優先度の判断、最終報告の内容）はまだ測っていない。ベンチの課題はユーザーに確認できない一括実行なので、このモードの良し悪しは測りにくい。

## 5.44 2026-11-09 進め方の設定「自律」「共創」の追加

- **ユーザーの定義**:
  - 自律: 自律的に判断し、ユーザーの指示を待たずに進める。選択が必要な場合は、プロジェクト全体の方向性に沿うよう自分で判断して進める。方向性が不明瞭な場合は、作業中に都度尋ねるのではなく、なるべくユーザーが方向性を決める時点で質問し、先に方向性を固める。時間や金銭的コストがかかる選択だけユーザーに意思を問う。それについても、ユーザーが包括的な指針を示していれば、それに沿って自分で判断して進める。
  - 共創: ユーザーと常に意見を擦り合わせながら進める。プロジェクトの方向性を決める事項を自分で判断しない。ユーザーが包括的な指針を示した場合は、それに沿う範囲でだけ自分で判断して進める。
- **設計**:
  - 作業モード（迅速・丁寧・思索）とは別の設定で、組み合わせて使える。作業モードと同じく会話末尾のセッション情報で伝えるので、システムプロンプトとキャッシュは変わらない。
  - 既定は自律。この設定がなかったときの振る舞い（lean4 の「本当にユーザーが決めるべきことだけ聞く」）に最も近いため。
  - 思索モードの「目的が不明瞭なときは確認する」とは食い違わない。自律でも、方向性が不明瞭なら最初に聞く定義になっている。
- **実装**:
  - コアの `INTERACTION_MODES` / `isInteractionMode` と文面を追加した。
  - 状態は作業モードと同じ入れ物（`ModeState`）で持ち、ログ（`session/interaction-mode`）から復元する。子のサブエージェントにも引き継ぐ。
  - CLI の `--interaction-mode`（`--work-mode` とは独立に使える）と `/interaction-mode`、API の `POST /api/sessions/:id/interaction-mode` を追加し、API の型とスキーマも更新した。
  - GUI では作業モードの隣に「進め方」の選択欄を置いた。空のチャットで選んだ値も、最初の送信の前に適用する。
  - 表示名は、日本語「自律 / 共創」、英語 Autonomous / Collaborative、中国語「自主 / 共创」。
- **検証**:
  - 単体 652 件（作業モードとの組み合わせ、各定義の要点、既定では文面を出さないこと）。
  - 結合 148 件。追加した API テストで、不正な値の拒否、モデルへの到達、作業モードと一緒に再起動後も戻ることを確認した。回帰 29 件。
  - CLI: `--interaction-mode collaborative` が記録されて文面が届くこと、不正な値で候補を示すエラーになることを確認した。
  - 実際の画面（模擬のモデル）: 新しいチャットで丁寧と共創を選んで送ると、どちらも最初のターンの前に設定され、文面がモデルに届いた。
- **未検証**: 実際のモデルの振る舞いは測っていない。今のベンチは途中でユーザーに確認できない一括実行なので、共創はベンチでは評価できない（`ask_user` がない場合の振る舞いも未確認）。

## 5.45 2026-11-09 JPN_LLM の会話ログで見つかった 3 件

- **画面が固まる**（`eeaa263`）:
  - `search_grep` / `search_glob` は、作業フォルダー全体を同期処理で読んでいた。デスクトップアプリではこれが画面と同じプロセスで動くため、`.gitignore` のない JPN_LLM（17,099 ファイル、725 MB）を絞り込みなしで検索すると、終わるまでウィンドウが応答なしになった。
  - 非同期の処理に変え、15 秒か 256 MB で打ち切って途中結果と絞り込みの案内を返すようにした。
- **ツールのチップが明滅して押せない・上へ戻れない・思考のチップが閉じる**（`952470a`）:
  - 実行中、会話の表示全体を毎フレーム作り直していた。
  - 内容が変わった項目だけを書き換えるようにし、思考のチップが開いた状態を覚え、最下段への追従はその時点で最下段にいるときだけにした。
- **検索が大きなファイルを黙って飛ばす**: `project.md`（1.7 MB）が 1 MB の上限で読まれず、結果は `filesSearched: 0` だけだった。モデルは「glob が壊れている」と誤解して回り道をした。
  - 上限を 16 MB に上げ、それを超えて飛ばしたファイルは `skippedLarge` と案内で示すようにした。
  - 同じ呼び出しで `project.md` の 16 件が 0.2 秒で見つかることを確認した。
- **アプリの再起動でキャッシュが全部外れる**: 01:03 の再起動を挟んで、システムプロンプトのハッシュが変わった（`5870f3…` → `3b991f…`）。そのため、ターン 6 の最初の要求は 153,930 トークンがすべてキャッシュに当たらなかった。
  - 入力の組み合わせを総当たりで再現した。違いは MCP のカタログだけで、再起動前のセッションにはなく、再起動後にはあった。
  - 00:08 の起動で MCP サーバーが動かなかった理由は分からない（デスクトップアプリは起動時の出力を残さない）。今起動すると 3 回とも 2/2 で、カタログも同じになる。
  - **修正**: エージェントは MCP のカタログをシステムプロンプトに入れず、セッション情報（会話の末尾）で送る。MCP が設定されていれば、サーバーの起動に失敗しても `mcp_call` を提示する。これで起動ごとの MCP の状態の違いは末尾への追記で済み、キャッシュされた部分は残る。システムプロンプトを直接組み立てる呼び出し元のために、`mcpCatalog` の引数は残した。
  - 既存のセッションは、この版での最初のターンでシステムプロンプトが 1 回だけ変わる（カタログが抜ける）。その後は変わらない。
- **検証**: 単体 656 件（大きなファイルの検索と飛ばしたファイルの報告、MCP の有無でシステムプロンプトとツールが変わらないこと）、結合 148 件、回帰 29 件。

## 5.46 2026-11-09 存在しない作業を「並行で進めている」と報告した件

- **ユーザーの指摘**: JPN_LLM のオーケストレーターが、最終回答で「4件を並行で進めています」と書いたが、実際には何も動いていなかった。
- **原因**: ステップ 13 の応答は、5 つのツール呼び出し（計画の更新と `orchestrator_spawn` 4 件）を本文に書いたものだった。ところが、全体を包む `{"calls":[` が抜けていた（`{"tool":"update_plan",…},{"tool":"orchestrator_spawn",…},…]}`）。
  - HY は最初の完全なオブジェクト（`update_plan`）だけを読んで実行し、残る 4 件を何も言わずに捨てた。
  - モデルは「計画を更新した」という結果だけを見て、作業者も起動できたと思い込んだ。推論に "Four workers spawned" と書き、存在しない 4 件を最終回答で報告した。
- **頻度**: 全セッションのログにある JSON 形式の応答 35,053 件のうち、包みが抜けた一括呼び出しは 7 件、壊れた一括呼び出しは 1 件あった。
- **修正**（`reply-guard.ts` と `agent.ts`）:
  1. `recoverUnwrappedBatch`: どの呼び出しも完全で、後ろに続くのが閉じ括弧だけのとき、`{"calls":[...]}` に戻してすべて実行する。`reply/recovered`（`unwrapped-batch`）を記録する。
  2. `hasCallsAfterFirstObject`: 応答全体が JSON として読めず、最初のオブジェクトだけが読めて、その後にも呼び出しが続く場合は、一部だけを実行しない。壊れた呼び出しとして扱い、「どれも実行していない」とモデルに伝えて送り直させる。
- **保存済みログでの照合**:
  - 正しい応答 35,042 件は、1 件も扱いが変わらない。
  - 包みの抜けた 7 件（今回の 5 件の呼び出しを含む）は、すべて全件実行に戻る。
  - 一部だけ実行されていた 1 件は、送り直しになる。
  - 残る 11 件の不正な応答は、もともと送り直しになるか、呼び出しを取りこぼさないもの（1 件の呼び出しの後に余分な `]` が続く、正しい一括呼び出しの後にテンプレートの閉じタグが続く）だった。
- **検証**: 単体 659 件（包みの抜けた一括呼び出しを全件実行すること、壊れたものは何も実行せず送り直させること）、結合 148 件、回帰 29 件。
- **既存のセッション**: JPN_LLM のオーケストレーターの履歴には、存在しない 4 件の作業が記録されたまま残る。続けるときは、作業者が動いていないことを伝えて起動し直させる必要がある。

## 5.47 2026-11-09 「作業を始めると言って止まる」の一般化

- **ユーザーの依頼**: 前節の修正は今回の事例だけのものか。HY ではモデルが作業を始めると述べて停止することがよくある。この形の不具合すべてに効く修正にし、他に想定外の挙動がないか探す。
- **コードの点検**（モデルが求めた呼び出しが消える、または応答なしに止まる経路）:
  1. 包みの抜けた一括呼び出しで、2 件目以降が捨てられる（前節で修正）。
  2. 一括呼び出しのうち `tool` を持たない要素が、黙って取り除かれる（`calls.filter`）。今回修正した。
  3. ツール呼び出しのない応答は、通常モードでは何を書いていても最終回答になる。「始めると言って止まる」を防いでいたのはゴールモードだけだった。今回修正した。
  4. ネイティブ呼び出しで名前のないものは、`llm.ts` で黙って捨てられる（ログには該当なし、未修正）。引数の壊れた呼び出しはツール側でエラーになるので、黙って消えるわけではない。
- **ログの調査**（全セッションの最終回答 296 件。ベンチの 571 件は比較用）:
  - 最後の文で自分の次の作業を予告して止まった回は 25 件あった。多くは 11/3〜4 のオーケストレーター（`2b1b89`）。例:「ここを確認します。」「…ハッシュを取得します。」（成功したツール 0 件）、「正しい形式で送り直します。」（壊れた呼び出しの直後）、「指定が無ければ 1 で進める。」（ユーザーが「いい感じに進めて」と返した）。`d7b7f5` では「進めて」と 2 回促されていた。
  - 「動いている作業」を主張しながら何も起動していない回は、今回の件のほかは、この予告や取りこぼしの結果だった。
  - 最後のツールが失敗したのに失敗に触れない最終回答は 7 件。いずれも「存在しません」「スコープ衝突」など別の言葉で失敗を伝えており、問題とはしなかった。
- **修正**（`reply-guard.ts` の `announcesNextStep` と `agent.ts`）:
  - ツール呼び出しのない応答の最後の文が、自分の次の作業を予告していたら（「確認します」「追加します」「進めます」「確認を進めています」「確認する」「積む」「I'll / Let me …」など）、1 ターンに 1 度だけ促す。「予告しただけで何も実行していない。今やるならツールで実行し、ユーザーや実行中の作業を待っているなら、そう明記して終える」と伝える。
  - モードを問わず適用する（ネイティブと JSON テキストの両方。objective 実行は独自の完了規則があるので除く）。同じ予告が繰り返されたらそのまま最終回答として受け入れ、無限に回らないようにした。
  - 誤検出を避けるため、次のものは予告とみなさない: 質問・確認依頼、申し出（「必要なら」「よければ」）、条件や待ち（「〜れば」「〜たら」「〜次第」「〜してから」「完了後」「待ちます」）、結論・先送り（「と判断する」「別途」「以降」）、プログラムの振る舞いの説明（「…を返します」）。ただし「指定が無ければ〜進める」は、ターンを止めてしまう形なので予告として扱う。
  - 一括呼び出しに呼び出しでない要素が混じる場合も、一部だけ実行せず、送り直させる。
- **誤検出の測定**: ユーザーセッションの最終回答 296 件のうち 25 件で促しが入り、どれも実際の「予告して止まる」だった。ベンチの最終回答 571 件では 0 件。過去の一括呼び出し 1,620 件に、呼び出しでない要素を含むものはなかった。
- **検証**: 単体 661 件（実際のログの文を使った検出テスト、促し・行動・繰り返し時の受け入れ・再開時の履歴一致）、結合 148 件、回帰 29 件。
- **限界**: 判定は最後の文の言い回しに基づくので、言い回しの違う予告は見逃しうる。促しは 1 回限りで、その後の判断はモデルに委ねる。実際のモデルで促しが働く様子は、まだ確かめていない（保存済みログでの判定と、模擬モデルでの動作のみ）。

## 5.48 2026-11-09 「予告して止まる」の根本原因の調査

- **ユーザーの問い**: 起きた後で止める仕組みしかないのか。原因はモデルなのか、ハーネスの指定やプロンプトなのか。
- **ログの分類**（予告して止まった 25 件）:
  - 24 件がオーケストレーター、1 件が通常チャット（旧版、別の小さいモデル）。同じモデル・同じ基本プロンプトの作業者は 133 件中 0 件。
  - 日付別のオーケストレーター: 11/3 は 78 件中 19 件、11/4 は 43 件中 5 件、11/5 は 23 件中 0 件、11/8 は 8 件中 0 件。直前に HY のやり直しメッセージが入った例は 0 件。
  - 11/3 の 19 件のうち 9 件は、作業者への委任が成功した直後だった。予告はその作業者の仕事の説明で、ターンを終えるのは正しい。
- **結論**: 主因はモデル単体ではなく、オーケストレーターという役割の設計とプロンプトにある。同じモデルでも、自分で手を動かせる作業者は一度もこれをしていない。今のオーケストレーターのプロンプトには、この終わり方を招く指示がある。
  - 「委任の後でターンを終える」「今動いているものと次に来るものを短く伝える」。次に来るものが、そのターンで実際に委任した作業に限られるとは書いていない。
  - 「妥当な既定を決めて短く述べ、続ける」と「委任の後でターンを終える」がぶつかり、「指定が無ければ 1 で進める」と述べてターンを終えていた。
  - オーケストレーターはファイルの読み取りと作業者の管理しかできない（計画モード）が、そうは明記されていない。そのため、自分ではできないこと（ハッシュの取得、ビルド）を予告して止まっていた。
  - 基本プロンプトの「計画で終えない」と、オーケストレーターの「次に来るものを伝える」が矛盾している。
  - 11/5 以降に起きていないのは、11/5 のリポジトリ取り込み以前にオーケストレーターの指示が変わったためと考えられる。ただ、取り込み前の履歴がないので確かめられない。標本も少ない（31 件）。
- **前節の修正の不具合と修正**: 委任が成功した直後の正しい終わり方にも促しが入るところだった（上の 9 件）。直前のステップで委任系のツール（`orchestrator_spawn` / `orchestrator_send` / `delegate` / `send_message`）が成功していれば促さないようにし、テストを追加した。これで促しが入るのは 25 件中 16 件で、すべて実際に止まった回。単体 661 件、結合 148 件、回帰 29 件が成功。
- **提案（未実施、ユーザーの判断待ち）**: オーケストレーターのプロンプトで、ターンの終え方を 3 通りに限る。(a) このターンで実際に委任した直後に、どの作業者が何をするかを書く。(b) ユーザーに本当に必要な質問をする。(c) すべて完了した。あわせて、自分でできること（読み取りと作業者の管理）を明記し、それ以外は同じターンで作業者に渡すようにする。既定値を述べたら、ターンを終えずにそのまま委任する（進め方の設定が共創なら質問にする）。オーケストレーター用のベンチはまだないので、効果の測定方法も合わせて決める必要がある。

## 5.49 2026-11-09 オーケストレーターの指示とシステムプロンプトの矛盾の解消

- **ユーザーの依頼**: 前節で指摘した、オーケストレーターの指示とシステムプロンプト全版との矛盾を直す。
- **方針**: システムプロンプトと作業モードの文面は変えない（全セッションで共通にしてキャッシュを効かせるため）。オーケストレーター側の指示で、自分の役割にどう当てはめるかを示す。
- **矛盾①②（ターンの終わり方、既定値）**: `orchestrator.md` に「How a turn ends」を新設し、ターンの終え方を 3 通りに限った。
  1. 作業者が動いていて、次はその結果待ち（このターンで委任した、または以前に起動した作業者がまだ動いている）。どの作業者が何をするかを書く。
  2. ユーザーにしか決められないことを質問する。
  3. すべて完了してレビュー済み。
  - あわせて、次の点を明記した。自分の作業を予告して終えない。作業者が実際に動いていない限り「動いている」と書かない（失敗・拒否された呼び出しは何も起動していない）。既定値を決めたら同じターンで委任する。システムプロンプトの「ツール呼び出しのない返答は最終回答」は、オーケストレーターでは「委任した作業の説明」で満たす。
  - 「今動いているものと次に来るもの」は「このターンで起動した作業者と、その後に控えるもの」に改めた。
- **矛盾③（聞くかどうか）**: 質問の頻度は、セッションの進め方の設定に従うようにした（自律＝これまでの規則、共創＝方向性を決める前に選択肢を示して聞く）。付け足していた指針の「ユーザーの望みを問い続けよ」は、「念頭に置き、不明なら進め方の設定が許す範囲で聞く」に改めた。
- **矛盾④（実装する人向けの文面）**: 「Reading the general instructions」を新設した。システムプロンプトと作業モードの「実装・検証・小さく進める」は委任先の作業に当てはまり、オーケストレーターは報告と差分を確かめること、上限内の並行作業は「一歩ずつ」より優先することを書いた。
- **矛盾⑤（できることの範囲）**: 「What you can do yourself」を新設した。読み取りと検索、報告と差分の確認、作業者の管理、計画、質問はできる。コマンド・ビルド・テスト・編集はできないので、同じターンで作業者に渡す。「小さな読み取り調査」は「自分でファイルを読む、または作業者に読み取り専用のコマンドを実行させる」と具体化した。
  - ハーネス側: オーケストレーターに渡していた待機・ジョブ確認のツール（`job_status` / `job_output` / `job_wait`）を外した。ジョブを作れず、待つなと指示されているため。
  - 追加ルートの案内は、`apply_patch` / `shell` のないセッション（オーケストレーターと読み取り専用の子）には読み取り用の文面だけを渡す。
- **矛盾⑥（並行作業と計画ツール）**: `update_plan` は、並行作業をするセッション（オーケストレーター）に限り、複数の進行中を許すようにした（`ToolRuntimeOptions.parallelPlan`）。ツールの説明も「並行して動くとき以外は 1 つ」に改めた（全セッション共通の説明が 1 度だけ変わる）。
- **検証**:
  - 単体 664 件（並行計画の可否、プロンプトの必須の記述、読み取り用の案内）。結合は並列実行で 1 件落ちたが、既知の `run_code` 作業者の起動失敗で、単独では 4/4 成功。回帰 29 件。
  - 実モデル（`F:/hy-bench/gui-check` のオーケストレーター）で 2 回試した。
    - ハッシュの取得（自分ではコマンドを実行できない）: 作業者に委任し、「1 件のワーカーを起動しました…報告が届き次第レビュー」でターンを終えた。報告後は差分を確認して閉じ、完了を報告した。
    - 形式を任せた索引ページ: 既定（`docs/index.md`、表形式）と代案を示し、同じターンで委任した。報告後はレビューして閉じ、完了を報告した。
    - どちらも予告して止まらず、促しも入らなかった。2 回だけの確認なので、頻度が下がったことの統計的な確認ではない。

## 5.50 2026-11-09 オーケストレーションを目的中心の共同作業にする

- **承認された範囲**: 呼び出し失敗と完了の分離、安全な区切りでの訂正、オーケストレーターの直接編集、会話と実行の分離、根拠付きの共有決定、編集権を解放したワーカーの再利用。
- **工程**: 1. 実行・訂正・範囲管理を整える。2. 会話の応答経路と永続的な通知を整える。3. 役割指示とツール説明を整理する。4. 再開・競合・訂正・雑談を含む検証を行う。
- **成功条件**: 通信上の失敗を完了と扱わない。訂正を受けた後は古い前提の編集をそのまま実行しない。会話中も独立した仕事が進む。同じ範囲を同時に編集しない。ワーカーの文脈を保持して再開できる。共有システムプロンプトに動的な状態を追加しない。
- **保護対象**: 稼働中の JPN_LLM セッションを停止・変更しない。既存の保存状態を読み込める形で拡張し、他セッションの変更と未追跡ファイルを保持する。

- **実装**:
  - 役割指示を目的・方針・判断に絞り、範囲の取得、訂正の配達、レビュー、再利用の手順は各ツールの説明に移した。共通システムプロンプトと作業モードの文面は変更していない。
  - `orchestrator_brief` が目的・成功条件・制約・採用済みの決定・根拠を版付きで保存する。更新は現在の版を照合し、稼働中のワーカーに通知する。初期の版0、最新のワーカー状態、現在の編集範囲を会話の末尾に更新し、古い状態を現在の権限と取り違えないようにした。古い版の報告を閉じるときは、現在の方針との整合を確認した説明を要求する。
  - オーケストレーターの固定計画モードを解除した。空いているファイルは直接編集時に単一ファイルの範囲を自動取得し、まとめて予約する場合だけ `orchestrator_scope` を使う。ワーカーと同じ競合検査を通し、直接の範囲はターン終了時に解放する。コマンドはワーカー全員が動いていない間に排他的に実行し、その間のワーカー再開も防ぐ。永続シェル経路による共有ロックの迂回を防いだ。
  - `orchestrator_send` はターン終了まで待たず、次の安全なステップで訂正を渡す。新着指示がある場合、古い応答のツール呼び出しを実行せず、シェルのロック待ち・承認待ちの後にも確認する。受信と、モデルが指示を含む要求に応答したことを別々に記録する。実行中の処理自体は完了させる。
  - 実行側が処理中の会話には読み取り専用の会話経路を使う。雑談と状況確認はそこで返答し、変更依頼だけを `orchestrator_request` で単一の実行側へ渡す。両側の会話は同じチャットに残り、利用量も合算する。会話側も親のモデル・作業モード・進め方・推論設定を引き継ぐ。質問は依存する仕事だけを待たせ、実行側を占有しない。ワーカーは `orchestrator_consult` で相談しながら独立した仕事を続けられる。
  - ワーカーの終了は範囲と枠の解放にし、会話を保持する。同じワーカーへ送ると範囲を再取得して再開する。通知・未配達の訂正は永続化し、従来の件数・文字数による黙った通知破棄をなくした。ワーカーの実処理が止まる前の範囲解放も拒否する。停止時は保留中の承認も解決し、承認のタイムアウトまで停止処理が待たされないようにした（専用の結合テストで確認）。
  - 不正な呼び出し、空の応答、反復の継続失敗を「完了」で返さず未完了にする。以前の変更・結果を保持し、失敗後も履歴を復元する。独立した形式エラーでは、正常にツールが動けば再送の機会を回復する。
  - 差分の確認を非同期にし、画面と会話を長時間止めないようにした。`file:` の指定、ステージ済みの変更、新規ファイルの内容も確認対象にする。追加ルートは主リポジトリの差分には入らないため、ファイルを直接読む必要があることを明示する。
- **実モデルで分かった調整点**: 前ターンの編集範囲を保持しているとの誤解には、自動取得と最新の範囲表示で対応。レビュー待ちの範囲までコマンドを拒む過剰な制限は、全ワーカーが動いていない間の排他的な検証に変えた。実行中のワーカーがいる場合の拒否は競合防止のため維持した。
- **検証**: 単体669件、結合全体151件、最終版のWeb経路42件、回帰29件を確認（Web経路は結合全体との重複を含む）。追加の結合テストでは、ワーカーがいない場合の保存済み通知の再開、承認待ちからの停止、会話側への作業モード・進め方の引き継ぎも確認した。
- **実モデル**: `opencode/deepseek-v4.1-flash`、専用の一時フォルダーで2回。直接編集、実行中の雑談、雑談による方針の不変、2ワーカーの委任・レビュー・READMEへの統合を確認した。別の再開確認では、新規ワーカー0、同じワーカーの会話を再利用し、システムのハッシュは不変。最初の要求は入力15,784、キャッシュ利用11,136、未利用4,648トークン。記録: `C:/Users/川野創太/AppData/Local/Temp/hy-orchestration-live-20261109-1794172198180/probe-result.json`、`C:/Users/川野創太/AppData/Local/Temp/hy-orchestration-reuse-result.json`。
- **限界と次の確認**: 性能差の統計的な比較と長時間の実運用は未測定。スコープは協調の境界であり、シェルのOS隔離を置き換えるものではない。実行済み・実行中の操作を訂正によって巻き戻さず、次の安全な区切りから反映する。JPN_LLMの稼働セッションは変更・停止していない。
- **更新用ビルド**: `release/next/HY-HARNESS-0.5.0-20261109-0628.exe`（183,558,772 bytes）。SHA-256: `6b467cc3e4df6c2b281f2a5a7fbcf40f167753edb4f5e46b21071e349e824f11`。更新用のJSONとハッシュも保存し、以前の2ビルドは保持した。同梱された変更対象11ファイルとRustの補助実行ファイル2件が作業ツリーと一致することを確認した。稼働中のアプリへは適用していない。

## 5.51 2026-11-09 ビルドごとにアプリのバージョンを更新する

- **目的・成功条件**: ファイル名の日時だけで区別せず、通常のビルドで毎回パッチ番号を上げる。アプリ・API・全パッケージ・更新ファイルのバージョンが一致し、リリース手順を使っても二重に上がらない。
- **工程**: 既存のバージョン一括更新を共通化し、ビルド開始時に実行する。連続更新と書式保持を検証し、今回の更新版も新しいバージョンで作り直す。
- **実装・確認**: `pnpm build` が毎回パッチ番号を更新し、`release:local` の明示的な版指定も同じ処理に渡して二重更新を防ぐ。全対象を検査してから書き込み、書式とBOMを保持する。連続更新・明示的なminor更新・同一版の拒否・不正な入力で部分更新しないことを専用テストで確認。通常のビルドで `0.5.0 → 0.5.1`、全6マニフェストと `HARNESS_VERSION`・build-infoの一致、単体669件の成功を確認した。
- **今後の手順**: ビルドは `pnpm build` またはそれを呼ぶデスクトップ／リリースの手順を使う。バージョン更新を日時付きのファイル名で代用しない。型確認だけなら `pnpm typecheck` を使う。
- **更新版**: `release/next/HY-HARNESS-0.5.1-20261109-0639.exe`。同梱のpackage.json・build-info・コンパイル済み定数、および実行ファイルのProductVersion/FileVersionがすべて `0.5.1` であることを確認。SHA-256: `c8378449dee9b98a13a6dbe9d1d2a19a00ddc804faca789cbee1d9bb686c5baa`。旧ビルドを保持し、稼働中のアプリは変更していない。

## 5.52 2026-11-09 アプリに戻った直後の「応答なし」の調査

- **ユーザーの症状**: 別アプリから戻った直後に多い。
- **最有力の経路**: `app.ts` のfocusイベント → `checkForUpdate`（最短60秒間隔）→ Electronの `update:check` → `evaluateUpdate`。同じ大きさの候補を比較するため、`fileHash` が実行ファイル全体を同期で読み、SHA-256を計算する。画面を管理するElectronメイン処理とハーネスのHTTPサーバーも同居している。
- **実測**: 実行中の `release/HY-HARNESS.exe` と `next` の0.5.1は同サイズ・同ハッシュ。候補4件の現在の条件を再現した比較で、毎回350.1MiBを読み、824.7 / 834.1 / 828.2msメイン処理を占有した。フォーカス時の再検査にキャッシュはない。症状のタイミングと一致するが、実際に数秒以上停止した瞬間の計測はまだない。
- **他に残る同期処理**: 9.55MiBの会話ログの全件読み直しは1回65〜79ms。ログのファイルロックには最大15秒の同期待ちがあり、別の一時ログで6秒の競合を作ると、10msのタイマーも6003msまで遅れた（稼働中のログには競合を作っていない）。画面側はDOM差分だけで、履歴425項目のHTML自体は毎回再生成している。
- **未実施**: コード修正・再ビルドはまだ。優先はフォーカス時の更新確認を非同期にし、変更のないファイルの再計算を省くこと。適用時のハッシュ検証は維持する。会話ログの同期待ちと全件読み直しは別途解消する。調査中10秒間のHTTP応答測定では最大127msで、長い停止はその時点では再現していない。

## 5.53 2026-11-09 フォーカス時の更新確認を止まらない処理にする

- **工程**: 更新確認と適用の呼び出し元を揃えて非同期化する。変更検出付きのハッシュキャッシュを追加し、再計算の省略と適用時の再検証をテストする。実ファイルで待ち時間を測り、新バージョンを作る。
- **成功条件**: 大きな実行ファイルの計算中にもイベント処理が進む。同じファイルは再読込しない。変更・失敗した計算を誤って使い回さない。更新の適用ではキャッシュを使わず、既存のコピー後ハッシュ検証も維持する。稼働中のアプリは停止しない。
- **実装**:
  - `packages/desktop/src/file-hash.ts`（`FileHashCache`）を新設。`fs.createReadStream`（256KiBチャンク）で非同期にSHA-256を計算し、チャンク間でイベントループに処理を譲る。
  - `dev:ino:size:mtimeNs:ctimeNs` のfingerprintで同一性を判定し、変更のないファイルはキャッシュ済みのハッシュ（および進行中のPromise）を再利用する。計算中にファイルが書き換わった場合や読み取りに失敗した場合はキャッシュから除去して失敗させる。
  - `packages/desktop/src/main.ts` の `evaluateUpdate` / `checkUpdate` / `applyUpdate` を非同期化し、通常の更新確認（`checkUpdate`）はキャッシュを使い、更新適用時（`applyUpdate` → `evaluateUpdate(true)`）は `fresh = true` で必ずファイルを読み直して再計算する。コピー後のPowerShell側SHA-256検証も維持した。
- **検証**:
  - `packages/desktop/src/file-hash.test.ts`（3件: 未変更・並列呼び出しでの再読込省略と `fresh=true` での再読込および同一サイズ変更時のキャッシュ無効化、32MiB計算中にタイマーが動くこと、欠損・計算中変更時に失敗し後の計算を汚染しないこと）を追加。
  - 単体テスト672件、更新時の検証・不一致時の復旧テスト5件、`pnpm check:version`（0.5.2）すべて成功。
  - 実ファイル測定: 初回計算中もイベント処理の間隔は最大約11msに収まり、変更のない2回目は約3ms・読み込み0MB。
- **更新版**: `release/next/HY-HARNESS-0.5.2-20261109-0722.exe`（183,559,689 bytes）。同梱の `file-hash.js`・`main.js`・`version.js`・`build-info.json`・`package.json`、および実行ファイルのProductVersion/FileVersionがすべて `0.5.2` であることを確認。SHA-256: `f4f0d9a6378cc41e38e5f5640736094cfd944196939608350c11e4cf23226963`。旧ビルドを保持し、稼働中のアプリは変更・停止していない。

## 5.54 2026-11-09 スマホ連携機能の調査

- **ユーザーの依頼**: スマホ連携機能がうまく働いていないため原因を調査する。
- **実機稼働状態の事実確認**:
  - `%APPDATA%\hy-harness\config.json` で `"phone": { "enabled": true }` が有効。
  - `%APPDATA%\hy-harness\tailscale-cert\desktop-7800qh8.tailf56065.ts.net.{crt,key}` は 2026-11-09 00:10:41 JST に生成済み（Let's Encrypt 証明書、有効期間 2026-10-08〜2027-01-06）。
  - 稼働中のデスクトップアプリ（PID 54876）は `100.101.140.81:3443` で TLS リスナーを起動しており、ローカルから `https://desktop-7800qh8.tailf56065.ts.net:3443/` への厳格な TLS 検証付きリクエストは `/`（200）、`/sw.js`（200）、`/manifest.webmanifest`（200）、`/api/bootstrap`（未認証 401）を正常に返す。
  - Windows Firewall には `Tailscale-In`（`LA4=100.101.140.81`、`Profile=Domain,Private`、`Action=Allow`）が存在し、`Tailscale` インターフェースは `Private`、かつ `HY-HARNESS.exe` に対する `Block` ルールはない。
  - 一方、`%APPDATA%\hy-harness\phone-devices.json` と `vapid.json` は未作成であり、スマホからのペアリング（`GET /pair?code=…`）が一度も成立していない。
  - Tailscale 上の iPhone（`iphone-12-pro.tailf56065.ts.net`、`100.85.254.7`）は最終通信 `2026-11-09 07:20:00 JST` で、調査時点の `tailscale ping 100.85.254.7` はタイムアウト（iOS 側のスリープまたは VPN 休止）。
- **特定したコードおよび設計上の問題点**:
  1. **アドレス直接アクセス時・iPhone「ホーム画面に追加」時の認証行き止まり（`app.ts` / `web-server.ts`）**:
     - 設定画面やトレイに表示されるアドレス（`https://desktop-7800qh8.tailf56065.ts.net:3443/`）をそのままスマホで開くと、`GET /api/bootstrap` が `401` を返し、画面には英語のエラー（`unauthorized: open the URL printed by hy web / the desktop app, or pair this phone again`）だけが出て、ペアリングコードを入力する欄がない。
     - さらに iPhone（iOS Safari）では、カメラで QR コード（`/pair?code=…`）を読み取って Safari 上でペアリングした後に、案内どおり「共有 › ホーム画面に追加」してホーム画面から開くと、iOS のスタンドアロン Web アプリは Safari と Cookie 領域が分離されているため未認証（`401`）で起動する。カメラで QR コードを読んでも必ず Safari が開くため、ホーム画面アプリ側に Cookie を渡す手段が存在せず、iPhone でホーム画面アプリ（および Web Push 通知）を使うことができない。
  2. **ペアリング状態判定の誤検知（`phone-devices.ts` の `pairingState`）**:
     - `pairingState(code)` が `this.pairings.has(code) ? 'pending' : 'done'` となっており、QR コードが期限切れで `prune()` された場合やワークスペース切替でサーバーが再生成された場合も `'done'` を返す。そのためペアリングしていないのにデスクトップ側で「スマホを追加しました」と成功トーストが出る。
  3. **Tailscale IPv6 アドレスへの未バインド（`tailscale.ts` / `web-server.ts`）**:
     - `tailscaleNode()` が IPv4（`100.101.140.81`）のみを取り出し、`startPhone()` も IPv4 のみにバインドしているため、Tailscale IPv6（`fd7a:115c:a1e0::6901:8c60`）経由の接続を受け付けない。
  4. **Tailscale CLI 呼び出しのメインスレッド同期ブロック（`tailscale.ts`）**:
     - `runTailscale` が `spawnSync('tailscale', …)` を使用しており、起動時やスマホ連携オン時に `tailscale status`（最大 8 秒）・`tailscale cert`（最大 60 秒）の間 Electron メインプロセスと HTTP サーバーが完全に停止する。また `PATH` に Tailscale がない環境へのフォールバック（`C:\Program Files\Tailscale\tailscale.exe`）がない。
  5. **MagicDNS 名の名前解決制約**:
     - `desktop-7800qh8.tailf56065.ts.net` は Tailscale の MagicDNS（`100.100.100.100`）でのみ解決でき、公開 DNS（`8.8.8.8` / `1.1.1.1` や iCloud プライベートリレー等）では `NXDOMAIN` となる。スマホ側で Tailscale VPN が有効かつ DNS が有効でないと名前解決に失敗する。
- **未実施**: ユーザーの症状確認と修正方針の承認待ち（→ その後ユーザーが iPhone 側の Tailscale を再開し、競合していたテスト用 `tailscale serve` を解除したことで QR コード接続が解決）。

## 5.55 2026-11-09 思考チップの行数上限拡大（1.5倍）とセッションログに基づくツール呼び出し失敗の対策

- **ユーザーの依頼**:
  1. 思考のチップを開いたときに出てくる文章の行数上限を1.5倍ほどに増やす。
  2. ツール呼び出しに何度か失敗しているため、セッションログを見て解決策を考え実装する。
- **セッションログ調査結果（`C:\Users\川野創太\AppData\Local\hy-harness\state\f7ad7a9bc4324bb6\session.v1.jsonl`、全1,683ツール呼び出し・48エラー・27 `turn/retry`・1 `turn/failure`）**:
  - **思考チップの行数上限**: `packages/hy-cli/web/styles.css` 1251行目の `.thinking-block pre` が `max-height: calc(1.5em * 4)`（4行）になっており、1.5倍の `calc(1.5em * 6)`（6行）に増やす。
  - **ツール呼び出し失敗の6類型**:
    1. **パターンA（9件）**: JSONツール呼び出しで引数を `args` に入れずトップレベルに配置（`{"tool":"write_file","file":...,"content":...}`、`{"calls":[{"tool":"read_file","path":...}]}` 等）。
    2. **パターンB（6件）**: ネイティブ関数呼び出しで `args` が壊れたJSON文字列として二重ラップされる（`{"args":"{\"workerId\":\"...\",\"summary\":\"...\"}}"}` の末尾余剰 `}` 等）。
    3. **パターンC（6件、うち1件は `turn/failure` でターン停止）**: バッチ呼び出し `{"calls":[{"tool":"A","args":{...},{"tool":"B","args":{...}}]}` で前の要素の閉じ `}` が1つ抜ける、または末尾が `})}` / 閉じ括弧不足で終わる。
    4. **パターンD（11件）**: チャットテンプレートの閉じタグ漏出（`</arg_value:6124c78e></tool_call:6124c78e></tool_calls:6124c78e>`）、XMLパラメータ形式（`{"tool":"edit_file">\n<parameter name="file">...</parameter>...</invoke>` / `<｜DSML｜ invoke>`）、またはJSON文字列リテラル内の生改行（`\n`）。
    5. **パターンE（7件）**: PowerShell のリダイレクト（`>` / `Out-File`）が既定で出力する UTF-16LE（BOM `FF FE`）ログファイルを `read_file` が `text.includes('\0')` により `binary file` として拒否。
    6. **パターンF（8件）**: `apply_patch` に Codex 形式（`*** Begin Patch / *** Update File:`）や行番号なし `@@` ハンクが渡されて拒否される（対象ファイルを既に `read_file` 済みでコンテキスト行が一意に一致するケース）。
- **成功条件と維持すべき条件**:
  - **成功条件**:
    1. `.thinking-block pre` の `max-height` が `calc(1.5em * 6)` になること。
    2. パターンA〜Dのツール呼び出し形式・テンプレート漏れ・JSON軽微破損がリトライを消費せず正常に復元・実行されること。
    3. パターンEの UTF-16LE / UTF-16BE ファイルが `read_file` および `search_grep` でテキストとして正しく読み取れること（本物のバイナリファイルは引き続き拒否すること）。
    4. パターンFの `*** Begin Patch` および行番号なし `@@` ハンクが、既存ファイル上で一意に一致する場合に番号付き unified diff に変換され適用されること（未読ファイルや一致しない場合、またはファイル未指定の不正フォーマットは従来どおりエラーを返すこと）。
  - **維持すべき条件**:
    - 既存の単体テスト（特に `reply-guard.test.ts`、`tools.test.ts`、`agent.test.ts` の壊れた部分バッチや説明用コードブロックの誤実行防止ルール）を一切壊さないこと。
    - 稼働中のデスクトップアプリ（PID 61492）および進行中のユーザーセッションを停止しないこと。
- **実装内容**:
  1. `packages/hy-cli/web/styles.css`（1251行目）: `.thinking-block pre` の `max-height` を `calc(1.5em * 4)` から `calc(1.5em * 6)`（6行）に拡大。
  2. `packages/core/src/agent.ts`: `normalizeCall` を追加し、単発・バッチ呼び出しで `"tool"` と同階層に置かれた引数（`path`、`file`、`content`、`pattern` 等）を `args` に統合（パターンA）。また `recoverMalformedCall` を呼び出してバッチ内の閉じ `}` 抜け等を修復（パターンC）。
  3. `packages/core/src/llm.ts` / `packages/core/src/tools.ts`: `parseLooseJsonObject` を追加し、`parseArgs` および `normalizeToolArgs` で末尾余剰 `}` やエスケープミスで後続呼び出しが連結された引数JSON文字列を復元（パターンB）。
  4. `packages/core/src/reply-guard.ts`: `CLOSING_FRAGMENTS` と `recoverTemplateCall` を拡張し、コロン付きIDタグ（`</tool_call:6124c78e>`、`</arg_value:...>`）、JSON文字列内の生改行、およびハイブリッドXML `<parameter name="...">...</parameter></invoke>` 形式を復元（パターンD）。さらに `recoverMalformedCall` で `{"calls":[...]}` 内の要素閉じ `}` 抜け（`,{"tool":` や `]}` の直前）、外枠の `]}` 抜け、余剰 `)`（`})}`）を復元（パターンC）。
  5. `packages/core/src/tools.ts`: `decodeTextBuffer` を追加し、UTF-16LE（BOMあり・なし）および UTF-16BE（BOMあり）のテキストファイルを `read_file` と `search_grep` でデコード可能にしつつ、NULコード単位を含むバイナリファイルは従来どおり拒否（パターンE）。
  6. `packages/core/src/tools.ts`: `convertNonStandardPatch` / `applyHunksToFile` を追加し、`*** Begin Patch`（`*** Update File:` / `*** Add File:`）および行番号なし `@@` ハンクが渡された際、対象ファイルがディスク上に存在しハンクが一意に一致する場合に番号付き unified diff へ自動変換（パターンF）。未読ファイルに対する `read_file is required` チェックや存在しないファイルに対する既存のエラーメッセージは維持。
  7. `packages/core/src/reply-guard.test.ts`、`packages/core/src/tools.test.ts`、`packages/core/src/agent.test.ts` にパターンA〜Fの単体テストを追加。
- **検証結果（確認済み事実と未実施事項の区別）**:
  - **確認済み**:
    - 全パッケージの TypeScript ビルド（`tsc -b packages/core packages/seams packages/hy-cli packages/sdk`、`tsconfig.web.json`、`packages/desktop/tsconfig.json`）がエラー0件で通過。
    - 全単体テストスイート（`pnpm test`）を実行し、新規追加テストを含む **全678件が pass（0 fail）**。
    - `pnpm desktop:package:next` を実行し、`release/next/HY-HARNESS-0.5.3-20261109-1019.exe`（バージョン `0.5.3`、サイドカー `.sha256` / `.json` 付き）のステージング完了を確認。稼働中のアプリからいつでもインプレース更新が可能。
  - **未実施**:
    - 稼働中の `HY-HARNESS.exe`（PID 61492）に対する更新ボタン押下・再起動（ユーザーの任意のタイミングで画面上から適用可能）。

## 5.56 2026-11-09 最新チャット（09:47〜16:45）の未知ツール呼び出しミス・モデル切替時の `invalid-json` 多発・全464思考ブロックのシステムプロンプト整合性調査

- **ユーザーの依頼**:
  1. 一番新しいセッション（`C:\Users\川野創太\AppData\Local\hy-harness\state\f7ad7a9bc4324bb6\session.v1.jsonl`）の最新チャット（09:47 JST = L8991〜L13042）のツール呼び出しを確認し、未知の呼び出しミスがないか確認する。
  2. モデルを `gemini:gemini-3.8-flash` に切り替えた際に `invalid-json` が多発している原因を調査する。
  3. 09:47以降の全思考内容（464ブロック）を読み、システムプロンプト（`lean4`、`tool-docs.ts`、`orchestrator.md`、`orchestrator-dialogue.md`、`worker.md`、`WORK_MODE_TEXT`、`INTERACTION_MODE_TEXT`）の記述経緯を踏まえた行動になっているか、プロンプト同士が矛盾して混乱していないかを調べる。
- **調査結果1: 09:47以降の未知のツール呼び出し失敗パターン（§5.55で未カバーの7類型）**:
  - ※L8991〜L12844（09:47〜11:17）は `0.5.3` 更新適用前のプロセスで実行されたため、§5.55で修正済みのパターンA〜Fも再発しているが、それ以外に以下の**未知パターン7件**が特定された（さらに L12992 は `0.5.3` 適用後にも発生）：
  1. **未知パターンG（フラットJSON呼び出し + `</｜DSML｜...>` タグ漏出の複合、L12992・`0.5.3` でも発生）**:
     - `{"tool":"write_file","file":"...","content":"..."}\n</｜DSML｜ parameter>\n</｜DSML｜ invoke>\n</｜DSML｜ calls>`
     - **原因**: `recoverTemplateCall`（`packages/core/src/reply-guard.ts` 171行目）が復元後のJSONを `isToolCallPayload` で検査する際、`isToolCallObject`（79行目）が `args === undefined || isRecord(args)` のみを許可し、まだ `normalizeCall` される前のフラット引数形式（`"file"`, `"content"` がトップレベルにあるJSON）で追加キーチェックを行っていないか、または単発呼び出し末尾に余剰 `]` があるケース（L12017 `{"tool":"edit_file","file":...}]</｜DSML｜...>`、L12819 `{"tool":"read_file","arguments":{...}}]}</arg_value:6124c78e>`）で `repairCallHead` が `open` スタック不一致により `undefined` を返していた。実際に L12992 では `content` 文字列内に生改行が含まれていたが、`repairCallHead(trimmed, true)` に渡される `trimmed` の末尾や `escapeRawNewlinesInStrings` の扱いで失敗した。
  2. **未知パターンH（パラメータ名の別名揺れ: `"arguments"` / `old_str`・`new_str` / `<old_string>`・`<new_string>`・`<path>`）**:
     - L12819–12820（`openai-compatible:hy4`）: `{"tool": "read_file", "arguments": {"path": "...", "startLine": 70, "endLine": 273}}`（`"args"` ではなく `"arguments"` を使用したため `args.path is required`）。
     - L11242–11243（`openai-compatible:hy4`）: `edit_file` に `old_str` / `new_str` を渡して `args.old is required; args.new is required`。
     - L11027（`deepseek-v4.1-flash`）: `{"tool":"edit_file">\n<new_string>...</new_string>\n<old_string>...</old_string>\n<path>...</path>\n</｜DSML｜ parameter>`（`<parameter name="...">` ではなくタグ名自体が `<new_string>`, `<old_string>`, `<path>`）。
  3. **未知パターンI（`{"calls":[...]}` 内の `"tool":"name":{...}` コロン連結、または `{"shell":{"command":...}}` キー省略）**:
     - L10210（`run-d051f8bc630e`）: `{"calls":[{"tool":"read_file","args":{...}},{"tool":"search_grep":{"pattern":"...","glob":"HANDOVER.md"}},{"tool":"search_grep":{"pattern":"...","glob":"NEXT_CHAT_PROMPT.md"}}]}`（`"args":` キーを書き忘れ `"tool":"search_grep":{...}` と記述）。
     - L10853（`run-b71f14b0ae30`）: `{"calls":[{"tool":"shell":{"command":"..."}}]}`（同じく `"tool":"shell":{...}`）。
     - L12397（`run-51ecd0c591d2`）: `{"calls":[{"shell":{"command":"..."}}]}`（`"tool":` と `"args":` を省略しツール名をキーに記述）。
  4. **未知パターンJ（外枠なしバッチ `recoverUnwrappedBatch` と `</｜DSML｜...>` タグ漏出の複合）**:
     - L12344（`run-9d5605684ef9`）: `{"tool":"read_file","args":{...}},{"tool":"search_grep","args":{...}}]}</｜DSML｜ parameter>\n</｜DSML｜ invoke>\n</｜DSML｜ calls>`
     - **原因**: `recoverTemplateCall` は先頭1オブジェクト閉鎖後に `,{"tool":` が続くと `undefined` を返し、後段の `recoverUnwrappedBatch` は末尾に `</｜DSML｜...>` が残っているため失敗する。
  5. **未知パターンK（`<tool_call>{"name":"...","arguments":{...}}` Hermes/Qwen形式の本文混入）**:
     - L12027（`run-34898bbbf646`）: `<tool_call>\n{"name": "write_file", "arguments": {"file": "...", "content": "..."}}`。
  6. **未知パターンL（`openai-compatible:hy4` ストリーミング時の空引数 `args: {}` / `args: "{"` 多発）**:
     - L9115, L9128, L9171, L10605, L11197（3並列すべて `{}`）, L11205, L11215（計9回）。
     - **原因**: Tencent `hy4` エンドポイントがツール呼び出し時に `function.arguments` を空文字 `""` または `"{"` だけ送出するケース、あるいは `args` ネスト `{"args":"{}"}`（L9096）を送出するケースがある。
  7. **未知パターンM（Reasoning 内の長周期フレーズ反復による 32,768 トークン枯渇 → `empty-reply` での `turn/failure`）**:
     - L12837–12839 および L12842–12844（`openai-compatible:hy4`、Turn 55 Step 6 & 7）: 1ステップ181秒かけて `outputTokens: 32768`（上限）をすべて `reasoning` 内で消費し、`content: ""` で2回連続 `empty-reply` となり `turn/failure` 停止。
     - **原因**: `llm.ts` の `repetitionStart`（88行目）は `REPETITION_MAX_PERIOD = 16`（16文字以下の周期のみ検知）だが、L12837/L12842 の思考ループは `Need maybe include logs/memory_watchdog.log file. Need maybe include scratch/ability_retention/ directory. Need maybe include checkpoints/v3_1/rebuild_a_v1_colab/g3cv/ directory. Need maybe include scratch/matrix_next_20261109/ directory. `（約240文字周期）を120KB以上にわたり反復していたため、`REPETITION_MAX_PERIOD = 16` をすり抜けた。
- **調査結果2: モデルを `gemini:gemini-3.8-flash` に変えた際に `invalid-json` が多発した原因（Turn 56 L12852〜L13028、20ステップ中12回 `invalid-json`）**:
  - Gemini API 公式仕様（MCP `mcp_gemini-api_gemini-api-docs_gemini_search_docs` / `gemini_get_doc` で Interactions API `POST /v1beta/interactions` の `Step`・`Interaction`・`Function Calling` 仕様を確認）と `packages/core/src/config.ts`・`llm.ts`・`agent.ts` を照合した結果、以下の**3つの構造的要因の連鎖**と判明：
  1. **`usesNativeTools(role)` が `gemini` を除外しており、モデル切替で「ネイティブ関数呼び出し」から「JSONテキストプロトコル」へ途中変更された（`config.ts` 81–84行目・`llm.ts` 975–1040行目）**:
     - `model-catalog.ts`（100行目）では `gemini:gemini-3.8-flash` は `capabilities: { tools: true }` であり、Gemini Interactions API もリクエストの `tools: [{ type: 'function', name, description, parameters }]` とレスポンス `steps` 内の `{ type: 'function_call', name, arguments, id }` を公式サポートしている。
     - しかし `usesNativeTools(role)` に `role.provider === 'gemini'` が含まれておらず、`GeminiProvider` も `options.tools` を送信しないため、`openai-compatible:hy4`（`native: true`）から `gemini:gemini-3.8-flash` に切り替えた瞬間に `native: false`（JSONテキストモード、`systemSha256: 2c10d7e34c9e9d56`）へ切り替わった。
  2. **`GeminiProvider` が全履歴を `USER:\n...\n\nASSISTANT:` の単一文字列に平坦化し、直前の空応答（`ASSISTANT:\n`）が Few-Shot として作用した（`llm.ts` 995–998行目）**:
     - Turn 55 Step 6・7 の `empty-reply` により、履歴末尾には `{ role: 'assistant', content: '' }`（空文字の `ASSISTANT:` ブロック）が2件残っていた。
     - `GeminiProvider` はマルチターン履歴を `turns.map(...).join('\n\n') + '\n\nASSISTANT:'` という1本のテキストに結合して送信するため、プロンプト末尾に空の `ASSISTANT:` が並んだ状態となり、`gemini-3.8-flash` が内部思考（`thought` ステップ、114〜712トークン）だけを生成して `model_output` ステップを1つも出力せずに終了（`content === ""`）する現象が多発した。
  3. **`native === false` 時に空応答 `content === ""` でも `messages.push(reply(""))` が蓄積され続けた（`agent.ts` 740–764行目）**:
     - `native === false` では空応答 `content: ""` も `invalid-json` として扱われ、毎回 `{ role: 'assistant', content: '' }` が `messages` に追加されるため、ステップが進むほど空の `ASSISTANT:\n` の反復例がプロンプト末尾に増殖し、Step 1, 2, 6, 9, 10, 12, 13, 15, 16, 18, 19, 20 の計12回 `invalid-json`（`assistant: ""`）が発生した。
- **調査結果3: 全464思考ブロックのシステムプロンプト記述経緯との整合性・プロンプト間の矛盾**:
  - **意図どおり機能している点**:
    - `lean4` の「ツール出力にないパス・記号・事実に依拠しない」「変更後は関連チェック・テストを実行する」「大規模編集を複数回に分ける」は、オーケストレータ・ワーカー双方の思考で何度も直接引用され、生データ（`R_dev_raw.json`）の裏取りや `unittest` 実行、名前衝突時の `orchestrator_consult`（`s5_conv_sub` 分離）など極めて高い水準で遵守された。
  - **プロンプト間の矛盾・摩擦により混乱やループが生じた5箇所**:
    1. **`lean4`「作業を続けるにはツール呼び出しが必要 / ツール呼び出しなしの応答は最終回答」 vs `orchestrator-dialogue.md`（対話側エージェントの役割）**:
       - L9028〜L9132（`run-72f869fc38ca.dialogue`）で、対話エージェントが「実行オーナーはまだ作業中だから、自分がツール呼び出しなしでユーザーに返答すると作業完了（final answer）扱いになってしまうのではないか」と混乱し、不要な `read_file` や `orchestrator_workers`、最後は空の `{"tool":"orchestrator_request","args":{}}`（L9115）を呼び続けるループに陥った。
    2. **`orchestrator-dialogue.md` の権限（提案のみ） vs `orchestrator_brief` ツールのスキーマ定義**:
       - L9028–9031 で対話エージェントが `orchestrator_brief` に更新引数（`expectedRevision`, `objective` 等）を渡してエラーとなった。対話側にも書き込み用スキーマのまま `orchestrator_brief` が公開されているため誤用を招いている。
    3. **ワークスペース制約「長時間処理・重要検証の前に短く説明する」 vs `lean4` + `orchestrator.md`「ツール呼び出しなしで今後の予定を宣言してターンを終えない」 vs `Autonomous` モード**:
       - L12812〜L12842（`run-72f869fc38ca`）で、約25分のGPU学習ワーカーを起動する直前に「実行前にユーザーへ短く説明すべきか、それともツール呼び出しなしで説明するとルール違反になるから直ちに `orchestrator_spawn` すべきか」で激しい葛藤が生じ、ワーカーの `scope` 列挙の思考ループ（32,768トークン枯渇）の引き金となった。
    4. **コンテキストヘッダー `[concurrent conversation; proposals are not accepted decisions]` の文言によるユーザー直接指示の解釈迷い**:
       - L9017 で、ユーザーの直接指示が `[concurrent conversation; proposals are not accepted decisions]` ヘッダー配下に注入されたため、実行オーナーが「これは未合意の提案なのか、ユーザーの確定指示なのか」で思考内で躊躇した（対話エージェントの提案とユーザー本人の発言が同じ注記の下に見えるため）。
    5. **`lean4`「Split large edits across multiple edit_file or apply_patch calls; do not write a whole large file in one reply」と新規ファイル作成（`write_file`）および `read-before-edit` 制約の摩擦**:
       - L10449, L10857, L11850, L12320 等で、「150行程度の新規スクリプト作成で `write_file` を1回で呼ぶことは『大きなファイル全体を1回の応答で書き出さない』に抵触するか」「`write_file` で新規作成したばかりのファイルに続けて `edit_file` / `apply_patch` を呼ぶ際、事前に `read_file` が必要か」で繰り返し思考リソースを消費していた。



- **実装内容**:
  1. **`C:\Users\川野創太\AppData\Roaming\hy-harness\RULE.md` の矛盾箇所削除**:
     - システムプロンプト（`lean4`、`orchestrator.md`、`announcesNextStep`）と矛盾していた「長時間かかる処理、外部状態を変更する処理、または重要な検証を実行する前には、何を確認・実行するかを短く説明する。」（旧21行目）を削除。
     - `INTERACTION_MODE_TEXT`（`Autonomous` / `Collaborative`）および `lean4` の質問規律と重複・矛盾していた事前許可箇条書き（旧33〜40行目）および `## UIとデザイン` セクション（旧42〜46行目）を削除。
     - `orchestrator.md` / `worker.md` / `orchestrator-dialogue.md` の役割分担と衝突していた `## サブエージェント` セクション（旧48〜50行目）を削除。
     - `## プロジェクト記録` に「編集スコープが指定されている場合は、スコープ内の文書のみを更新する。」を明記し、スコープ外ワーカーが `project.md` 更新義務の有無で迷わないように整理。
  2. **Gemini ネイティブツール呼び出し対応および空応答連鎖の防止（`packages/core/src/config.ts`、`packages/core/src/llm.ts`、`packages/core/src/agent.ts`）**:
     - `usesNativeTools(role)`（`config.ts` 83行目）に `role.provider === 'gemini'` を追加し、`gemini:gemini-3.8-flash` 等へのモデル切替時にネイティブ関数呼び出しモードが維持されるよう修正。
     - `GeminiProvider.complete`（`llm.ts` 991〜1068行目）で Interactions API の `tools` フィールド送信、`steps` 内の `type === 'function_call'`（`toolCalls`）および `type === 'thought'`（`reasoning`）のパースを実装。さらに履歴内の空の `assistant` メッセージ（`content.trim() === ''`）を `input` 結合時に除外し、空の `ASSISTANT:\n` が Few-Shot 例として作用する現象を防止。
     - `agent.ts`（761〜791行目）でテキストモード時にも2回連続の空応答（`!content && emptyReplied`）で `empty-reply` 終了するよう統一し、非空応答時に `emptyReplied = false` にリセットするよう修正。
  3. **未知のツール呼び出し失敗パターン G〜M の修正（`packages/core/src/reply-guard.ts`、`packages/core/src/agent.ts`、`packages/core/src/tools.ts`、`packages/core/src/llm.ts`）**:
     - **パターンG**: `repairCallHead`（`reply-guard.ts`）で単発呼び出し末尾の余剰 `]` / `]}`（`{"tool":"edit_file",...}]</｜DSML｜...>` 等）を `allowMissingClosers` の有無にかかわらず除去・閉鎖するよう修正。
     - **パターンH**: `recoverXmlParameterCall`（`reply-guard.ts`）で `<new_string>`, `<old_string>`, `<path>` 等の直接XMLタグ形式をサポート。`agent.ts` の `normalizeCall` で `"arguments"` を `"args"` のエイリアスとして受理。`tools.ts` の `normalizeToolArgs` で `edit_file` の `old_str`/`old_string`→`old`、`new_str`/`new_string`→`new`、`path`→`file`、および `read_file` の `file`→`path`、`write_file`/`apply_patch` の `path`→`file` を正規化。
     - **パターンI**: `repairCallHead` で `"tool":"<name>":{` を `"tool":"<name>","args":{` に正規化。`agent.ts` の `isCallEntry` / `normalizeCall` および `reply-guard.ts` の `isCallObject` で `{"calls":[{"shell":{"command":"..."}}]}` の単一キー省略形をサポート。
     - **パターンJ**: `recoverUnwrappedBatch`（`reply-guard.ts`）で末尾のテンプレート閉じタグ（`TEMPLATE_CUT` + `TEMPLATE_TAIL`）を先に除去してからバッチ復元するよう修正。
     - **パターンK**: `recoverTemplateCall` / `parseValidCallJson`（`reply-guard.ts`）で `<tool_call>\n{"name":"...","arguments":{...}}\n</tool_call>` 形式を `{"tool":"...","args":{...}}` に復元するよう修正。
     - **パターンM**: `llm.ts` の `REPETITION_MAX_PERIOD` を `16` から `512` に拡大し、約240文字周期の複数文思考ループ（L12837/L12842）も `repetitionStart` で4,000文字到達時点で検知・切断するよう修正。
  4. **システムプロンプト・ツール定義間の摩擦解消（`packages/core/src/tool-docs.ts`、`packages/hy-cli/prompts/orchestrator-dialogue.md`、`packages/hy-cli/src/web-server.ts`）**:
     - `tool-docs.ts`: `edit_file` / `write_file` の説明に、新規ファイル作成時は事前 `read_file` が不要であること、同一セッションで `write_file` / `apply_patch` により作成・更新したファイルはすでに読み取り済みとして追跡されることを明記。
     - `orchestrator-dialogue.md`: ユーザーへの回答または `orchestrator_request` 送信後は、追加のツール呼び出しを行わずに直接返答してターンを終了し、`orchestrator_workers` / `orchestrator_brief` をポーリングしないよう明記。
     - `web-server.ts`: `dialogue` セッションには `orchestrator_brief` を引数なしの読み取り専用スキーマ（`object({})`）で公開し、実行オーナーの `sessionContext` ではユーザー発言を `[concurrent conversation] user:`、対話エージェントの発言を `[concurrent conversation; proposals are not accepted decisions] assistant:` と区別してラベル付け。
- **検証結果**:
  - **確認済み（事実）**:
    - 全パッケージの TypeScript ビルド（`tsc -b packages/core packages/seams packages/hy-cli packages/sdk`、`tsconfig.web.json`、`packages/desktop/tsconfig.json`）および Rust ワークスペースビルド（`cargo build --release --workspace`）がエラー0件で通過。
    - 全単体テストスイート（`pnpm test`）を実行し、新規追加テストを含む **全683件が pass（0 fail）**。
    - `pnpm desktop:package:next` を実行し、`F:\HY-HARNESS\release\next\HY-HARNESS-0.5.5-20261109-1722.exe`（バージョン `0.5.5`）のステージング完了を確認。
  - **未実施**:
    - 稼働中の `HY-HARNESS.exe` の再起動・更新適用（ユーザーの任意のタイミングで画面上の更新ボタンから適用可能）。

## 5.57 2026-11-09 コンテキスト圧縮（Compaction）巻き戻しバグ・Step 1 未圧縮送信バグ・OpenCode DeepSeek 上限超過の修正

- **ユーザーの依頼**:
  - `OpenCodeのDeepSeekに戻したらエラー出るようになったんだけど何故`
  - 調査結果提示後の「修正して」「再開して」の指示に伴う恒久修正の実装。
- **不具合の原因（3つの連鎖）**:
  1. **ターンの Step 1 で自動圧縮が一切動かない（`packages/seams/src/spill-compaction.ts`）**:
     - `Agent.run` が新ターン開始時に `lastInputTokens = 0` で初期化するため、Step 1 の `beforeRequest(messages, 0)` では `overTrigger(0)` が常に `false` となり、履歴が 80 万トークン以上あっても圧縮がスキップされた。Step 1 自体がプロバイダーのコンテキスト上限超過で失敗すると Step 2 に進めず、永久に自動圧縮が発動しない状態になっていた。
  2. **ターン中断・アプリ再起動時に過去の圧縮が完全に巻き戻る（`packages/core/src/agent.ts` の `rebuildHistory`）**:
     - ターンが例外や中断で終了した際、`session-app.ts` の `catch` 節で `rebuildHistory(events, runId)` が呼ばれるが、`compaction/summary` イベントが無視されていたため、過去に要約・間引かれた数百件の `tool/result` やメッセージが生ログからそのまま再構築され、未圧縮の超巨大履歴（229万文字 / 推定81万トークン超）に巻き戻っていた。
  3. **DeepSeek トークナイザーの換算倍率（1.44〜1.60x）とカタログ上限**:
     - `MODEL_CATALOG` の `opencode:deepseek-v4.1-flash` が `contextWindowTokens: 1_000_000` であったため、トリガー（0.75倍 = 75万トークン）に達する前に、DeepSeek 特有のトークン密度（実測値が推定値の約1.58倍）および `maxOutputTokens: 131,072` の予約領域と合算され、OpenCode 側の上限に抵触していた。
- **実装内容**:
  1. **`SpillCompaction.beforeRequest`（`packages/seams/src/spill-compaction.ts`）**:
     - `lastInputTokens === 0`（ターンの Step 1）の場合でも、`estimateTokens(messages)` に多言語・コード安全係数 `1.35` を掛けた推定トークン数でトリガー判定を行うよう修正。リクエスト送信前に必ず Tier-1（prune）および Tier-2（summary）が実行され、Step 1 から安全なトークン数で送信されるよう保証。
  2. **`rebuildHistory`（`packages/core/src/agent.ts`）**:
     - `compaction/summary` イベントのハンドラを新設。要約された古いステップ（`pairs` 組）を履歴から正確に切り落とし、客観メッセージ（先頭の `user` メッセージ）に `<session_summary>...</session_summary>` を付加して復元するよう修正。ターン中断やアプリ再起動が発生しても圧縮状態が確実に維持されるように改善。
  3. **`MODEL_CATALOG`（`packages/core/src/model-catalog.ts`）**:
     - `opencode:deepseek-v4.1-flash` の `contextWindowTokens` を `800_000` に調整（トリガー閾値は 600,000 トークン）。DeepSeek トークナイザーの膨らみ（約1.58倍）や `maxOutputTokens`（131,072）を考慮しても、OpenCode 側の上限（実測64万〜80万トークン）に抵触する前に確実に Compaction が走るよう安全域を確保。
  4. **単体テスト追加（`packages/seams/src/spill-compaction.test.ts`、`packages/core/src/agent.test.ts`）**:
     - `beforeRequest compacts on Step 1 (lastInputTokens === 0) when messages exceed trigger` を追加し、Step 1 での自動圧縮発動を検証。
     - `rebuildHistory applies compaction/summary and drops shadowed steps` を追加し、イベントログからの圧縮履歴復元を検証。
- **検証結果**:
  - **確認済み（事実）**:
    - 全パッケージの TypeScript ビルド（`tsc -b ...`）および Rust ワークスペースビルド（`cargo build --release --workspace`）がエラー0件で通過。
    - 全単体テストスイート（`pnpm test`）を実行し、新規追加テスト2件を含む **全685件が pass（0 fail）**。
    - `pnpm desktop:package:next` を実行し、`F:\HY-HARNESS\release\next\HY-HARNESS-0.5.7-20261109-1802.exe`（バージョン `0.5.7`）のステージング完了を確認。
  - **未実施**:
    - 稼働中の `HY-HARNESS.exe` に対する更新適用（ユーザーの任意のタイミングで画面上の更新ボタンから適用可能）。

## 5.58 2026-11-09 Claude Code `/advisor` 相当機能（ステートレス・オンデマンド助言役）の実装

- **ユーザーの依頼**:
  - `Claude codeの、/advisorに当たる機能を作りたい。Advisorのモデルは設定画面でWorkerなどと同様に設定できる、Advisorのオンオフはチャット欄にPlanモードなどと同様に切り替えボタンを用意する、の方針で実装してください。`
  - `じゃあ、キャッシュを残さず毎回新しいAdvisorに意見を求める形で、修正して。`
- **設計方針（ステートレス・オンデマンド型）**:
  - Advisor 自体は会話履歴（セッション状態）を抱え込まず、都度新しい独立したインスタンスとして起動する（ステートレス実行）。
  - 呼び出し時はメインセッションの直近要約（Prior Session Summary）＋コンテキスト＋相談内容（query）をワンショットで送信。
  - プロバイダー側のプロンプトキャッシュ（サーバーサイドキャッシュ）により共通履歴部分は自動的にキャッシュヒット（高速・低コスト）しつつ、Advisor 側のコンテキスト肥大化やメイン実務との不整合を完全に防止。
  - Advisor の回答結果はメインログに `advisor/consultation` イベントとして記録され、メインモデルへ `tool/result` として返却。
- **実装内容**:
  1. **設定構造・モデル解決（`packages/core/src/config.ts`）**:
     - `UserConfigFile.roles` および `HarnessConfig` に `advisorRole?: RoleConfig` を追加。
     - `loadConfig` で明示設定がない場合は Worker ロールをデフォルトとしてフォールバック解決し、シークレット（DPAPI）解決および OpenCode 形式の正規化を適用。
  2. **ランタイム & ツール定義（`packages/hy-cli/src/session-app.ts`）**:
     - `advisorToolMap` を作成し、`consult_advisor` ツール（引数: `query`, `context?`）を登録。`readOnly: true` のため Plan モード時でも相談可能。
     - セッション状態 `advisorEnabled: boolean`、トグルメソッド `setAdvisor(enabled)`、復元ヘルパー `restoredAdvisorMode` を追加。
     - 毎回の呼び出しでユニークな `runId.advisor-<timestamp>` を生成し、独立した LLM クライアントでステートレスに完了（`complete`）を実行。
  3. **サーバーエンドポイント & 永続化（`packages/hy-cli/src/web-server.ts`、`api-contract.ts`）**:
     - `POST /api/sessions/:runId/advisor`（`{ enabled: boolean }`）エンドポイントを追加し、セッション状態変更を SSE ブロードキャスト。
     - `SessionState` および `sessionSummary` に `advisorEnabled` を含めて返却。
     - `/api/settings`（POST）の Roles 許可リストに `'advisor'` を追加し、設定画面からの永続化に対応。
     - `api-contract.ts` にルート契約を登録。
  4. **フロントエンド UI & 多言語対応（`packages/hy-cli/web`）**:
     - `app.ts`: 入力欄下部の Composer Toolbar に Plan ボタンと並んで Advisor 切り替えボタン（chip）を追加。クリックで ON/OFF を即座にトグル可能。
     - Settings モーダルの Roles 一覧に Advisor のモデル設定項目（プロバイダ/モデル/パラメータ）を追加。
     - Details タブに `advisor` のモデル情報を表示。
     - `types.ts`: `SessionState` および `ConfigSummary` に型定義を追加。
     - `icons.ts`: 電球モチーフの `advisor` アイコンを追加。
     - `i18n.ts`: 英語・日本語・中国語の翻訳辞書（`advisor`, `advisorTitle`, `advisorRole`）を追加。
  5. **単体テスト追加（`packages/hy-cli/src/advisor.test.ts`）**:
     - 設定ロード時のロール解決・フォールバック。
     - `advisor-mode` イベントの記録と再開時の状態復元。
     - `consult_advisor` ツールの無効時拒否・空クエリ拒否・正常実行・ステートレス性（複数回呼び出しの独立性）の検証。
- **検証結果**:
  - **確認済み（事実）**:
    - 全パッケージの TypeScript ビルド（`tsc -b ...`）がエラー0件で通過。
    - 全単体テストスイート（`pnpm test`）を実行し、新規テスト3件を含む **全688件が pass（0 fail）**。
    - `pnpm desktop:package:next` を実行し、`F:\HY-HARNESS\release\next\HY-HARNESS-0.5.13-20261109-1910.exe`（バージョン `0.5.13`）のステージング完了を確認。
  - **未実施**:
    - 稼働中の `HY-HARNESS.exe`（PID 61492）に対する更新適用（ユーザーの任意のタイミングで画面上の更新ボタンから適用可能）。

### 5.59 質問（ask_user）の入力欄直上固定ポップアップカード（案2）の実装
- **背景**:
  - エージェントが質問（`ask_user` / `kind === 'question'`）を投げた際、タイムラインが下へスクロールしたりログが流れると質問カードを見失いやすい問題があった。
  - ユーザー指示により、入力欄（Composer）の真上に質問を固定ポップアップカードとして常駐させ、タイムラインがスクロールしても常に見失わず即座にインライン回答できる方式（案2）を導入。
- **実装内容**:
  1. **スタイル追加（`packages/hy-cli/web/styles.css`）**:
     - `.composer-question-dock`: Composer 入力フォームの直上に配置（`max-width: 880px; margin: 0 auto 10px;`）。
     - `.composer-question-popup`: テーマ色（`--purple` / `--panel` / `--border`）を用いた上向き浮き出しシャドウカード。
     - `.question-head`, `p`, `.question-form`, `input`, `button`: 視認性の高い質問ラベル・本文・インライン入力フィールド・送信ボタン。
  2. **フロントエンド制御（`packages/hy-cli/web/src/app.ts`）**:
     - `renderQuestionDock()`: 最新の未回答質問（`kind === 'question' && e.answer === undefined`）を検出してドック内にポップアップを描画。未回答質問がない場合は `hidden = true` で領域を非表示化。
     - タイピング保護: 既存の同一質問に対する再描画時に DOM を再構築しないよう `dock.dataset.questionId === pending.requestId` でガード。
     - 配置と更新トリガー: `renderComposer()` 内で `<div id="composer-question-dock" class="composer-question-dock" hidden></div>` を Composer の直前に配置し、`renderTranscriptNow()` および Composer 構築時に同期呼び出し。
     - 楽観的回答送信: `answerQuestion(requestId, answer)` で送信時に即座に対象エントリーの `entry.answer = answer` をセットして `renderQuestionDock()` と `renderTranscript()` を呼び出し、サーバーレスポンスや SSE を待たずに即時消滅。
- **検証結果**:
  - **確認済み（事実）**:
    - `pnpm typecheck` で全パッケージの型チェックがエラー0件で通過。
    - `pnpm test` を実行し、全688件が pass（0 fail）。
    - `pnpm desktop:package:next` を実行し、`F:\HY-HARNESS\release\next\HY-HARNESS-0.5.14-20261109-2045.exe`（バージョン `0.5.14`）のパッケージング完了を確認。
  - **未実施**:
    - 稼働中プロセス `HY-HARNESS.exe`（PID 61492）への反映（ユーザーの任意のタイミングで更新ボタン等から再起動・適用可能）。

## 5.60 2026-11-09 JPN_LLM の17:51再開後の実運用ログ調査

- 調査範囲は21:09:04までの親1件・作業者14件。稼働ビルドは0.5.5。全15件のシステムプロンプトを同梱物から再構成し、ログのハッシュと一致した。親は思索・自律、作業者は迅速・自律。記録されたモデルステップ737件、ツール結果814件、思考607件。思考全文を規則別に機械照合し、該当箇所を前後の記録と突き合わせた。
- 18:50の作業者がXML風の `<tool calls>` で構文検査と収集スクリプトの再実行を要求した。ツール結果が無いままターンが完了になり、親は成果物を読んで受理した。最後の編集後の検証は記録されていない。19:54にも `<system>Tool ran without output or errors</system>` が最終回答として扱われ、未作成の報告書を親が再依頼した。機械可読な報告の欠落をレビュー待ちとして受け入れる経路が共通している。ログ行15250–15273、16836–16862。
- 以前のGemini向けJSON限定の再送指示を親がOpenCodeでの再開後にも参照し、並列呼び出し可否を迷った。実行中のシステム文面はネイティブ呼び出し用で、形式の衝突は会話履歴に残った一時指示との間にあった。ログ行12857–13028、13328、13957。
- ワーカー用のシェルにはバックグラウンド禁止と600秒のRPC期限があり、汎用ツール説明はバックグラウンド継続や600秒の待機設定を案内していた。長時間学習2件がタイムアウト後も実際には継続し、作業者がプロセスとログを確認して回収した。ログ行14410–14443、17243–17260。Git管理外で `orchestrator_diff` が失敗した際は親が直接読みに切り替えた。ログ行13337、13912。
- 既知の修復が22件、形式再送が9件。今回の混在DSML 7件と、最終回答に落ちたXML風呼び出しは調査時点の復元関数でも再現した。親の計画ツール更新は調査区間内に無かった。実行中のアプリとセッション、アプリコードは変更していない。

## 5.61 2026-11-09 17:51のセッション監査で見つかった不具合の修正

- 成功条件は、呼び出し形式が崩れても未実行のまま完了扱いにならないこと、旧形式の再送指示がネイティブ呼び出しを妨げないこと、長時間のコマンドでも通信期限がプロセスの期限を先回りしないこと。
- 混在DSMLの引数型と `tools[].name` を解釈し、`arguments` の入れ子と計画引数の混用を検証前に正規化する。意味が確定しないXML風呼び出しと偽のツール結果は再送対象にした。作業者の `STATUS` が欠けた場合は未完了として通知し、旧保存状態の同じケースも復元時に未完了へ戻す。
- ネイティブ呼び出しの新しいターンでは、古いJSON専用の再送指示と直前の不受理応答を要求履歴から除く。同じテキスト方式のターンのキャッシュと、セッションの監査ログを維持する。
- 排他シェルはプロセス期限を先に設定し、フォアグラウンド待機と通信期限に余裕を足す。排他を保持する間の動作をツール説明に反映。Git管理外のレビューには直接の確認方法を返す。親には委任する工程やユーザー判断が変わる時点で画面の計画も更新するよう明記した。
- 検証は単体690件、Web結合43件、回帰29件が成功。保存ログの混在DSML 7件を復元し、偽の完了応答2件を検出した。Windowsの実行サーバーで、短い待機指定による切り離しを防ぎ、プロセス期限後に排他が解放されることを確認した。
- 更新用ビルドは `release/next/HY-HARNESS-0.5.16-20261109-2137.exe`。バージョンとSHA-256を照合済み。稼働中のセッションへの適用と、更新版の実モデルによる長時間セッションは未実施。

## 5.62 2026-11-09 HYとDSHのキャッシュ命中率の調査

- 目的は、同一OpenCode Goモデルで命中率の差を、未キャッシュ入力の実量、初回要求、継続要求、圧縮と再起動に分けて説明すること。ベンチ既存ログとJPN_LLMの実運用ログを読み、新しいAPI確認には合成入力だけを使った。
- 過去の同条件比較のトークン加重命中率は、財務課題でHY迅速84.85%・DSH91.16%、セキュリティで92.61%・93.16%、画像で81.55%・90.37%。1試行平均の未キャッシュ入力は順にHY 36,133・48,941・55,976、DSH 46,229・68,944・49,418。財務・セキュリティは、命中率の順位と未キャッシュ量の順位が逆。ベンチの既存95%区間ではこれらの命中率差を確定できない。
- JPN_LLMの0.5.5区間（17:51再開〜22:08:06、行19454まで）のOpenCode 923要求はトークン加重97.30%。新規ワーカー16件の初回は全て0%、同じワーカーを再開した2件の初回は98.38%。同一run・同一モデルのstep 2以降876件のうち、直前の入力トークン数の90%を下回る再利用は1件。行19225で旧結果102件を書き換え、次の行19265で入力323,414トークンが全ミス。
- 22:09の0.5.16起動後は、親のシステムハッシュが変わり、旧結果103件の再圧縮も発生した。親の最初の要求は324,730トークン・0ヒット、次の8要求は加重98.24%。この2要因の寄与は分離できないが、HYのpruneイベントは件数のみを保存し再構築で適用されないため、再起動で同じ古い結果を圧縮し直す。DSH 0.2.1-rc.3は置換イベントを保存し、既定の要約要求にも同一セッションID・元のシステム／ツール・会話プレフィックスを使う。HYは要約専用の文面を組み直し、今回の設定ではGeminiに送る。
- 実APIの合成比較で、HYの `/inference/go/openai/v1` とDSHの `/zen/go/v1` は同じセッションIDと入力なら両方向で約99%再利用した。異なるIDでの同一入力は0%。同一IDで二つの履歴を交互に送る対照では、両履歴とも再利用できた。ツール定義の追加またはシステム末尾変更も、長い共通先頭部分を残した合成入力では約96〜99%命中。短いツール履歴のネイティブ形式・テキスト形式の単発比較では両方約99%で、形式差を主因とする証拠は得られなかった。既存ログには要求全体のハッシュやOpenCodeの内部ルートが無く、新規ワーカーの全ミスの寄与は未分離。

### 5.60 デフォルト検索ツールとしての RustXNG（v0.31.1）導入
- **背景**:
  - ユーザー要望により、高速・軽量なセルフホスト型メタ検索エンジン [RustXNG](https://github.com/sahenjp/RustXNG) を HY-HARNESS のデフォルト Web 検索ツールとして導入。
- **実装内容**:
  1. **バイナリ配備 & ハッシュ検証**:
     - 公式リリース `v0.31.1` の Windows x64 バイナリ（`rustxng-v0.31.1-x86_64-pc-windows-msvc.exe`）をダウンロード。
     - SHA-256 チェックサム（`a509798f040722db4a3df9eebb3551437c69189ed0003bb2a0b62bf749cf6775`）で改ざん・破損がないことを検証。
     - `F:\HY-HARNESS\bin\rustxng.exe` および `%APPDATA%\hy-harness\bin\rustxng.exe` に配置。
     - `electron-builder.yml` に `bin/**/*` を追加し、ポータブルパッケージへの同梱を完了。
  2. **MCP プリセット統合（`packages/core/src/config.ts`, `config-schema.ts`）**:
     - `AutomationConfig` に `search?: { enabled?: boolean; binPath?: string }` を追加。
     - `findRustxngBinary()` 関数により、指定パス、プロジェクト内 `bin/rustxng.exe`、ユーザーディレクトリ、または `PATH` から実行ファイルを自動検出。
     - `automation.search?.enabled === true` 時に、組み込み MCP サーバー `rustxng`（`rustxng mcp`）を自動登録。エージェント向けに Web 検索ツール `search`（ランク付け結果取得）および `read_page`（URL 本文抽出）を提供。
     - `%APPDATA%\hy-harness\config.json` に `automation.search: { enabled: true }` を追加。
  3. **ネイティブ `web_search` ツールとのブリッジ（`packages/core/src/tools.ts`）**:
     - ネイティブツール `web_search` 呼び出し時、明示的な `web.searchUrl` がなくても `rustxng` MCP ツールへ透過的にフォールバック接続し、モデルが直接 `web_search` を呼んだ場合でも検索結果を返却。
  4. **フロントエンド UI & 多言語対応（`packages/hy-cli/web`）**:
     - Settings モーダルの Automation セクションに「Web Search (RustXNG MCP)」トグルを追加。
     - 英語・日本語・中国語の翻訳辞書（`searchAutomation`）を追加。
     - `types.ts` および `web-server.ts` の direct GUI 呼び出し許可リストに `rustxng` を追加。
  5. **単体テスト追加（`packages/core/src/config.test.ts`）**:
     - `rustxng` MCP プリセットの検出・登録・オプトアウト（`enabled: false`）の検証テストを追加。
- **検証結果**:
  - **確認済み（事実）**:
    - `rustxng.exe --version` で `RustXNG 0.31.1` の動作を確認。
    - `rustxng mcp` に対する JSON-RPC 2.0 の `initialize`、`tools/list`、`tools/call`（クエリ: "Rust programming language"）で正常な検索結果の取得を確認。
    - `pnpm typecheck` で全パッケージの型チェックがエラー0件で通過。
    - `pnpm test` を実行し、新規テスト2件を含む **全690件が pass（0 fail）**。
    - `McpManager` 起動テストで `read_page`, `search` ツールがカタログに正しく登録されることを確認。
    - `pnpm desktop:package:next` を実行し、`F:\HY-HARNESS\release\next\HY-HARNESS-0.5.19-20261109-2218.exe`（バージョン `0.5.19`）のパッケージング完了を確認（パッケージ内部に `resources/app/bin/rustxng.exe` を同梱）。
  - **未実施**:
    - 稼働中プロセス `HY-HARNESS.exe`（PID 61492）への反映（ユーザーの任意のタイミングで更新ボタン等から再起動・適用可能）。

## 5.63 2026-11-09 キャッシュの再利用を改善

- 成功条件は、作業の正確性とスコープ制約を維持し、長い履歴の圧縮・再開と、新規ワーカーの起動で未キャッシュ入力を減らすこと。命中率と未キャッシュ入力を併記する。
- ツール結果の短縮は新しい方から必要量だけ行い、圧縮閾値の8割まで下げて、古いプレフィックスと直近の出力を残す。置換元のハッシュ・同一結果の出現順・置換本文を記録し、再開時に同じ順序で復元する。旧形式のログは原文を維持する。スピルはバッチ全体と内包する参照を保存し、一時ファイルから置き換える。
- 新規ワーカーの題名と編集範囲は会話のコンテキストに置き、ワーカーのシステム指示を共通化した。自動要約は、ネイティブ呼び出しで直前の入力があり、モデル・URL・認証が同じ場合に元の指示・ツール定義・履歴を再利用する。別モデル、画像付き、または上限付近では短い要約専用入力を使用する。
- 保存ログの75万トークン時点をローカルで再現すると、置換件数102→27、最初の変更までの推定共通入力は2.34万→49.54万トークン。これはプロバイダーの命中実測ではない。
- OpenCode Goの合成試験で、2件目以降のワーカー6要求の命中率は7.1%→57.0%、平均未キャッシュ入力3,364→1,547。要約各2回の平均未キャッシュ入力は6,973→102。同じ圧縮済み要求をログから再構築した試験では入力3,841中3,840が命中した。設定済みのGemini要約役は維持した。
- 圧縮直後の合成入力を各2回送ると、一括短縮の0%から先頭維持で81.8%に改善。平均未キャッシュ入力は6,751→5,237。残した履歴の分、総入力は約6.8千→2.88万に増える。実運用の効果量は未測定。
- 単体692件・Web結合43件が成功。Windows更新用ビルドは `release/next/HY-HARNESS-0.5.22-20261109-2231.exe`。バージョンとSHA-256を照合済み。稼働中セッションへの適用、DSHと同じ本番相当ワークロードでの再比較は未実施。

## 5.64 2026-11-10 弾幕シューティングゲームの GitHub push および GitHub Pages 自動公開

- **背景**:
  - ユーザーがPCを操作できない状況に伴い、Antigravity 側でターミナルから `git push` および GitHub Pages 公開を代行。
- **実施内容**:
  1. **Git Dubious Ownership の解消 & Push**:
     - `git config --global --add safe.directory F:/GLM_PROJECT/JPN_LLM/testHY/DS` を適用。
     - Windows ホストの Git Credential Manager に保存された GitHub 資格情報を利用し、`cd F:\GLM_PROJECT\JPN_LLM\testHY\DS && git push -u origin main` を実行してリモート（`https://github.com/hiyasinnsu/HY_test_DS.git`）へ送信完了。
  2. **GitHub Pages API 自動有効化 & Actions Re-run**:
     - `POST /repos/hiyasinnsu/HY_test_DS/pages`（`build_type: workflow`）を呼び出し、GitHub Pages を自動プロビジョニング。
     - 初回ビルドで `configure-pages` が失敗していたワークフロー（run `42639630418`）を `rerun` 実行。
     - `build` ジョブ（テスト91件、ビルド、スモークテスト）および `deploy` ジョブ（Pages 配備）がすべて成功。
  3. **本番公開 URL の動作検証**:
     - `https://hiyasinnsu.github.io/HY_test_DS/` にアクセスし、HTTP 200 OK、HTML 構文、JS アセット（91.8 kB / 200 OK）、CSS（628 B / 200 OK）の正常配信を実機検証。

## 5.65 2026-11-10 質問回答機能（ask_user）の不整合・タイムアウト修正

- **背景**:
  - オーケストレーターセッションにおいて「スマホから質問に答えても何も起こらなくなる」現象を調査。質問の10分タイムアウト、フロントエンドでの `question/timeout` ハンドラ欠落、楽観的UI更新のロールバック欠落、`entry.runId` の未参照が重なり、期限切れ質問が画面に残留して404エラーになっていた。
- **実装内容**:
  1. **サーバー側待機時間の延長（`packages/hy-cli/src/web-server.ts`）**:
     - `requestQuestion` 内のタイムアウトを 10分（`10 * 60_000`）から 30分（`30 * 60_000`）へ延長し、スマホ連携時の長考や離席に対応。
  2. **フロントエンドのイベント同期 & ロールバック（`packages/hy-cli/web/src/app.ts`）**:
     - `question/timeout` SSE イベントハンドラを追加し、期限切れ時にポップアップを自動消去して `(timed out)` を記録。
     - `question/answer` SSE 受信時にも `renderQuestionDock()` を同期呼び出し。
     - `answerQuestion` で `entry.runId` を最優先参照するように修正。
     - 送信失敗（404等）時に楽観的更新をロールバック（`prevAnswer` の復元または `delete entry.answer`）し、質問カードとドックを再表示してエラーをトースト表示。
- **検証結果**:
  - `pnpm typecheck` で全パッケージの型チェックがエラー0件で通過。
  - `pnpm test` で全692件が pass（0 fail）。
  - `node --test tests/integration/web-ui.test.mjs` で単独テストがすべて成功。
  - `pnpm desktop:package:next` を実行し、`F:\HY-HARNESS\release\next\HY-HARNESS-0.5.23-20261110-0006.exe`（SHA-256: `C29A83DD6FE5C620652C90E6F9225340A9741CB926F8606CAEE9A931A7E80E67`）を生成完了。

## 5.66 2026-11-10 更新後のキャッシュ命中率の調査

- 稼働版0.5.22の `testHY/DS`（11/09 22:53〜11/10 00:22 JST、ログ行2625まで）の同一OpenCodeモデル385要求は、加重98.04%、親98.82%、全体の未キャッシュ入力960,139。圧縮イベントなし。新規ワーカー6件の初回は0%が2件、49%が1件、約66%が3件。最初の3件は0.8秒以内に開始した。
- 同一run・同一ターンの継続370要求は、直前の入力トークン数からヒット数を引いた差が最大127。未キャッシュ898,300のうち875,484（97.46%）は直前より増えた入力。最大の増分49,083は直前のモデル出力48,885トークン（思考ログ約16万文字）の直後で、古い入力の脱落ではない。
- 保存済みDSHの同一モデルの3課題では、同一ターンの継続544件中39件でヒット数が直前の入力を上回った。HYの今回の370件では0件。DSHはネイティブのツール呼び出しと結果を再送し、HYは履歴上のテキストに整形する。OpenCodeの長い引数を使う合成試験では、短い先頭では両方式0ヒット、約9〜10Kの先頭では両方式とも概ね直前の入力までヒットし、ネイティブ形式で生成分が再利用される差は再現しなかった。今回と同じ作業のDSHログは手元で未確認。コードは変更していない。

## 5.67 2026-11-10 DSH準拠 GitHub 連携機能（案A）の実装

- **成功条件**:
  - サンドボックス隔離環境内での `git push` / `git pull` に対する認証自動透過注入（外部 credential helper spawn 回避による `spawn EPERM` / `could not read Username` の完全解消）。
  - 内蔵 GitHub API クライアント及びモデル向けネイティブツール（`github_repo_info`, `github_pages_enable`, `github_actions_status`, `github_create_pr`）の登録と実行。
  - Windows Git Credential Manager からのワンクリック自動トークン検出 API（`POST /api/github/detect-token`）の実装。
  - Web UI Settings モーダル（Automation セクション）での GitHub 連携 UI（PAT 入力、自動検出ボタン、DPAPI 暗号化保存、日英中多言語対応）。
  - 型チェック・テスト全件パス、ポータブルバイナリ生成。
- **維持すべき条件**:
  - 既存のサンドボックス隔離性（ACL、ファイル保護、コマンド制限）の維持。
  - トークン未設定時の既存動作への干渉防止。
  - 既存の単体テスト・結合テストの維持。
- **実装内容**:
  1. **Git 認証透過注入ロジック（`packages/core/src/github.ts`, `packages/hy-cli/src/session-app.ts`）**:
     - `buildGitAuthEnv`: GitHub トークンから `GH_TOKEN`, `GITHUB_TOKEN`, `GIT_TERMINAL_PROMPT=0`, および `GIT_CONFIG_PARAMETERS="'credential.helper=' 'http.https://github.com/.extraheader=AUTHORIZATION: basic <base64>'"` を生成。
     - `session-app.ts` の `createExecClient` でトークン解決時に `process.env` にセットし、`envPassthrough` に追加することで、`hy-exec-server` の `build_env` を経由してサンドボックス子プロセスへ自動透過注入。外部ヘルパー（`git-credential-manager.exe`）の起動を抑制し、直接 HTTP basic 認証ヘッダーを載せるため、AppContainer / Low Integrity サンドボックス内でも `spawn EPERM` にならず確実に push / pull が成功する。
  2. **GitHub ネイティブツール & ドキュメント（`packages/core/src/github.ts`, `tools.ts`, `tool-registry.ts`）**:
     - `github_repo_info`: リポジトリメタデータ取得（owner/repo 省略時はローカル git remote origin から自動検出）。`READ_ONLY_TOOLS` に追加。
     - `github_pages_enable`: Pages 有効化・設定（buildType: `workflow` / `legacy`）。
     - `github_actions_status`: 最新の Actions ワークフロー実行状況取得。`READ_ONLY_TOOLS` に追加。
     - `github_create_pr`: プルリクエスト作成。
     - `tools.ts` の `features` で `github` を追加し、GitHub 利用可能なセッションで直接提供。
  3. **Windows GCM 自動トークン検出 API & サーバー処理（`packages/hy-cli/src/web-server.ts`, `packages/hy-cli/src/api-contract.ts`）**:
     - `POST /api/github/detect-token`: `git credential fill` を呼び出し Windows ホストの GCM から GitHub PAT を自動取得して返すエンドポイントを追加。
     - `redactUserConfig`: `automation.github.token` をマスクし `tokenSet: true` を返す。
     - `PUT /api/settings`: トークン変更なし時の既存トークン保持処理を追加。
  4. **フロントエンド UI & 多言語対応（`packages/hy-cli/web`）**:
     - `types.ts`: `AutomationConfig.github`（enabled, token, tokenSecret, tokenSet）定義追加。
     - `i18n.ts`: 日英中それぞれに `githubAutomation`, `githubToken`, `detectFromGit`, `githubTokenDetected`, `githubTokenNotFound` の翻訳辞書を追加。
     - `app.ts`: Settings モーダルの Automation セクションに GitHub 連携トグル、トークン入力フィールド、Windows Git 自動検出ボタンを追加。ワンクリックで資格情報からトークンが自動入力される。
  5. **テスト作成**:
     - `packages/core/src/github.test.ts` を新規作成（URLパース、認証環境変数生成、トークン解決、ツール登録を検証）。
- **検証結果**:
  - **確認済み（事実）**:
    - `packages/core/dist/github.test.js` 5件全件 PASS。
    - `pnpm typecheck` で全パッケージ（core, seams, hy-cli, sdk, web, desktop）の型チェックがエラー0件で通過。
    - `pnpm test` で新規テストを含む **全697件が pass（0 fail）**。
    - `pnpm desktop:package:next` を実行し、`F:\HY-HARNESS\release\next\HY-HARNESS-0.5.27-20261110-0111.exe`（バージョン `0.5.27`、SHA-256: `6B26E70B403631F1BFC8ACA175F90BDE01F69C2828BF5CF148CEF535634F83C1`）のパッケージング完了を確認。
  - **未実施**:
    - 稼働中プロセス `HY-HARNESS.exe`（PID 61520 / 60732）への反映（ユーザーの任意のタイミングで更新ボタン等から再起動・適用可能）。


## 5.68 2026-11-10 オーケストレーション ON vs OFF 弾幕ゲーム開発比較（クオリティ & API料金・トークン消費分析）

- **背景**:
  - オーケストレーション機能（複数ワーカー・サブエージェント協調）の有効時（ON）と無効時（OFF）で同一指示に基づき作成された弾幕シューティングゲームの成果物およびセッションログ（`session.v1.jsonl`）を走査・解析し、実装クオリティとAPI料金・トークン消費を客観的に比較・評価。

- **対象プロジェクト**:
  - **オーケストレーション ON**: `F:\GLM_PROJECT\JPN_LLM\testHY\DS`
    - リポジトリ: `hiyasinnsu/HY_test_DS`
    - セッション: `AppData\Local\hy-harness\state\7ddeef6abaa4d78f`（オーケストレータ `orc-0e32596f657f` ＋ 7 つの分業ワーカー）
  - **オーケストレーション OFF**: `F:\GLM_PROJECT\JPN_LLM\testHY\DS_worker`
    - リポジトリ: `hiyasinnsu/test_HY_DS_worker`
    - セッション: `AppData\Local\hy-harness\state\8d287ab246a40c81`（単一ワーカー `run-11968b697776` による逐次実装）

- **1. API料金 & トークン消費 定量比較**:
  - 使用モデル: 全リクエスト `opencode:deepseek-v4.1-flash`
  - トークン・実行時間集計実測値:
    - **所要時間**: ON = 91.94 分（約1時間32分） / OFF = 55.07 分（約55分）［**1.67倍**］
    - **LLM呼び出し回数**: ON = 385 回 / OFF = 140 回［**2.75倍**］
    - **総入力トークン**: ON = 49,080,331 (49.1M) / OFF = 14,808,295 (14.8M)［**3.31倍**］
      - キャッシュミス: ON = 960,139 (2.0%) / OFF = 174,567 (1.2%)［**5.50倍**］
      - キャッシュヒット: ON = 48,120,192 (98.0%) / OFF = 14,633,728 (98.8%)［**3.29倍**］
    - **総出力トークン**: ON = 593,683 (0.59M) / OFF = 237,597 (0.24M)［**2.50倍**］
    - **総トークン数**: ON = 49,674,014 (49.7M) / OFF = 15,045,892 (15.0M)［**3.30倍**］
    - **LLMレイテンシ累計**: ON = 4,074.8 秒（約67.9分） / OFF = 2,483.2 秒（約41.4分）［**1.64倍**］
  - API料金換算比較:
    - **DeepSeek公式レート（オフピーク: Miss $0.15, Hit $0.003, Out $0.60 / 1M）**:
      - ON: **$0.6446（約 99.9 円）**
      - OFF: **$0.2126（約 33.0 円）**
      - 比率: **3.03倍**（差額 約67円）
    - **DeepSeek公式レート（ピーク: Miss $0.30, Hit $0.006, Out $1.20 / 1M）**:
      - ON: **$1.2892（約 199.8 円）**
      - OFF: **$0.4253（約 65.9 円）**
      - 比率: **3.03倍**（差額 約134円）
    - **OpenCode Go公表レート（キャッシュ反映推計: Miss $0.44, Hit $0.0088, Out $1.32 / 1M）**:
      - ON: **$1.6296（約 252.6 円）**
      - OFF: **$0.5192（約 80.5 円）**
      - 比率: **3.14倍**（差額 約172円）
    - （参考: キャッシュ割引なしフラットレート換算 $0.44 / $1.32）:
      - ON: $22.38 / OFF: $6.83［3.28倍］

- **2. 実装クオリティ & 機能比較**:
  - **コード規模 & 構造**:
    - ON: 53ファイル / 13,041 行（`src/` 33ファイル 8,349行、TypeScript、厳格な型定義と契約分離）。
    - OFF: 34ファイル / 8,010 行（`src/` 21ファイル 4,372行、Vanilla JS / ESM、ビルドレス設計）。
  - **弾幕・ゲームシステム**:
    - ON: 5種類の本格スペルカード（「星屑の螺旋」「流星群」等）、13ウェーブの雑魚出現、弾幕パターン7モジュール（ring, fan, curtain, laser, split, emitter等）、予告線〜照射〜消滅のレーザー機構、パーティクル。
    - OFF: 4フェーズボス、雑魚ウェーブ、基本弾幕パターン（fan, ring, curtain, laser等）、パーティクル。難易度調整用スクリプト（`balance.mjs`）で撃破時間を実測調整。
  - **音響（WebAudio）**:
    - ON: 938行の本格WebAudioエンジン。14種類のSFX、**場面別5トラックの合成BGM**（Title, Stage, Boss, Clear, Game Over）、レート制限（30ms）、同時発音数管理、仮想AudioContextによる単体テスト（`audio.test.ts` 400行）。
    - OFF: 263行のWebAudio。10種程度のSFX、4小節ループの合成BGM（ボス戦でテンポ・音色変化のみ）。
  - **UI・モバイル・UX**:
    - ON: UI専任コード約1,700行（`ui.ts` 1,008行、`draw.ts` 434行）。3段階難易度選択（EASY/NORMAL/HARD）、相対ドラッグ、低速モード、FPS連動低品質降下機能。
    - OFF: UIコード約623行。**PWA対応**（`sw.js` によるService Workerオフラインキャッシュ、`manifest.webmanifest` によるホーム画面追加）、`render-shots.mjs` での画面描画PNG出力による目視UI重なり修正。
  - **テスト & 品質保証**:
    - ON: Vitest による網羅的ユニットテスト（8ファイル **91件 全通過**）、ステージ1を全難易度で最初からクリアまで通し実行するヘッドレス統合テスト、10,717フレームスモークテスト。
    - OFF: 独自ヘッドレスシミュレータ（`headless-sim.mjs` 34/34 PASS）、jsdom起動テスト（`dom-boot.mjs` 9/9 PASS）、ボス撃破秒数バランス計測、公開後バイト完全一致テスト（`live-check.mjs`）。
  - **ビルド & デプロイ**:
    - ON: Vite 8 + TypeScript ビルド、GitHub Actions ワークフロー（CI検証 → 静的アーティファクト出力 → Pages デプロイ）。
    - OFF: ビルド工程一切不要の純静的配信（リポジトリルートを直接 GitHub Pages に公開、CI稼働不要）。

- **3. 総合評価・まとめ**:
  - **コスト効率**: 単一ワーカー（OFF）はオーバーヘッドがなく、ONの約 **30%〜33% の料金（約33円〜80円）** で完成。55分で破綻なく完動するゲームを仕上げており、コストパフォーマンスに優れる。
  - **完成度・拡張性**: オーケストレーション（ON）は、オーケストレータによる設計契約の策定と各ワーカーへの分業（Stage/Danmaku, Audio, UI, Render）によって、**コード規模1.9倍、BGM5曲を含む重厚な音響、5つのスペルカード、91件の自動テスト、3段階難易度** など、インディーゲームとしてのリッチさと品質で明確に上回る。
  - **結論**: 短時間・低コストで実用的なプロトタイプを成立させるならオーケストレーションOFF、商用クオリティの厚みやモジュール拡張性、手厚いテスト資産を求めるならオーケストレーションON（約3倍のコスト、DeepSeek利用時で差額約67円〜134円）が適している。

## 5.69 2026-11-10 HYとDSHの99.5%付近の実運用ログ比較

- 同一OpenCode GoモデルのDSH長期ログ2件（`session-694d9bd3-8075-4ae0-a190-fd1c02693db2`、`session-7b3e199d-4152-4687-b14a-aa69df11e9bc`）で、累計99.55%を各確認。1,167・2,560要求、平均入力45.4万・39.9万。最初の85要求に限ると98.00%・98.04%、平均入力10.7万・10.9万。HY `DS_speed` は85要求で累計98.96%、平均入力10.9万、直近30要求99.61%。作業内容は一致しない。
- 入力30〜50万トークンの範囲ではHY `DS` の親99.52%（24要求）、DSHの2件は99.78%（449要求）・99.50%（696要求）。99%の上限は観測されないが、長期累計でDSHと同水準かは未検証。
- HY `DS_speed` でも、直前の入力を127トークン超えてヒットした継続要求は84件中47件。以前確認したHYオーケストレーションでは0件。同じ集計でDSHはログによって0/1,110と859/2,549に分かれた。送信形式だけでこの差を説明できず、差の要因は未分離。今回はコード変更なし。

## 5.69 2026-11-10 オーケストレーション OFF 迅速モード（DS_speed）比較検証

- **背景**:
  - `testHY` ディレクトリにおいて、新たに「迅速モード、オーケストレーションOFF」で生成された弾幕シューティングゲーム `DS_speed`（リポジトリ: `hiyasinnsu/test_HY_DSspeed`）を走査・解析し、先行の「オーケストレーション ON (`DS`))」および「オーケストレーション OFF 通常 (`DS_worker`))」との 3 者比較を実施。

- **対象プロジェクト**:
  - **オーケストレーション OFF 迅速**: `F:\GLM_PROJECT\JPN_LLM\testHY\DS_speed`
    - リポジトリ: `hiyasinnsu/test_HY_DSspeed`
    - 公開URL: `https://hiyasinnsu.github.io/test_HY_DSspeed/`
    - セッション: `AppData\Local\hy-harness\state\7a46e567db506d69`（単一ワーカー、85ステップ）

- **1. トークン消費・API料金・実行時間 3者比較**:
  - 使用モデル: 全セッション共通 `opencode:deepseek-v4.1-flash`
  - 実測指標一覧:
    | 指標 | ① ON (`DS`) | ② OFF 通常 (`DS_worker`) | ③ OFF 迅速 (`DS_speed`) |
    |---|---|---|---|
    | **所要時間** | 91.94 分 | 55.07 分 | **24.94 分（通常の45%）** |
    | **LLM 呼出回数** | 385 回 | 140 回 | **85 回（通常の61%）** |
    | **総入力トークン** | 49,080,331 (49.1M) | 14,808,295 (14.8M) | **9,246,825 (9.25M)** |
    | └ キャッシュヒット | 48,120,192 (98.0%) | 14,633,728 (98.8%) | 9,150,592 (99.0%) |
    | └ キャッシュミス | 960,139 (2.0%) | 174,567 (1.2%) | 96,233 (1.0%) |
    | **総出力トークン** | 593,683 (0.59M) | 237,597 (0.24M) | **143,163 (0.14M)** |
    | **総トークン数** | 49,674,014 (49.7M) | 15,045,892 (15.0M) | **9,389,988 (9.39M)** |
    | **LLM レイテンシ累計** | 4,074.8 秒 (67.9分) | 2,483.2 秒 (41.4分) | **1,173.4 秒 (19.6分)** |
    | **DeepSeek (オフピーク)** | **$0.6446 (約 99.9 円)** | **$0.2126 (約 33.0 円)** | **$0.1278 (約 19.8 円)** |
    | **DeepSeek (ピーク)** | **$1.2892 (約 199.8 円)** | **$0.4253 (約 65.9 円)** | **$0.2556 (約 39.6 円)** |
    | **OpenCode (キャッシュ推計)** | **$1.6296 (約 252.6 円)** | **$0.5192 (約 80.5 円)** | **$0.3118 (約 48.3 円)** |

- **2. 実装クオリティ & 構造比較**:
  - **コード規模 & 構成**:
    - ① ON: 53ファイル / 13,041行（`src/` 8,349行、TypeScript 7 + Vite 8 + Vitest 5）
    - ② OFF通常: 34ファイル / 8,010行（`src/` 4,372行、Vanilla JS / ESM、PWA対応）
    - ③ OFF迅速: **25ファイル / 3,712行（`src/` 2,613行、Vanilla JS / ESM、PWA対応）**
  - **ゲーム内容**:
    - ① ON: 5スペルカード、13雑魚ウェーブ、弾幕7種、レーザー照射、14種SFX、**場面別5曲BGM**
    - ② OFF通常: 4フェーズボス、雑魚ウェーブ、基本弾幕、10種SFX、4小節ループBGM（テンポ変化）
    - ③ OFF迅速: **3スペルカード、雑魚ウェーブ＋中ボス、基本弾幕（ring/fan/curtain/spiral）、8種SFX、3トラック合成BGM**
  - **検証・テスト体制**:
    - ① ON: Vitest 8ファイル 91テスト全通過、通し統合テスト、10,717フレームスモーク
    - ② OFF通常: 独自シミュレータ 34チェック、jsdom 9チェック、PNG画像出力目視レイアウト修正
    - ③ OFF迅速: **Nodeネイティブテスト 11チェック通過、`tools/sim.mjs` による無敵ボット自動完走（102.7秒、ピーク279弾）、実ブラウザ検証**

- **3. 評価と考察**:
  - **迅速モードの特性**: 所要時間 **24.9分**・費用 **約20円** と、通常モードの半分以下のリソースで完成。無駄な手戻りや余分な補助コードを削ぎ落とし、2,613行の洗練されたコアコードで「中ボス＋3スペルカードボス＋難易度3種＋BGM/SE＋PWA」という完全な弾幕ゲーム体験を成立させている。
  - **住み分けの確立**:
    - **迅速モード（OFF）**: 開発スピード・コスト最優先。プロトタイピングやハッカソン的開発において最強の選択肢。
    - **通常モード（OFF）**: バランス調整やUI目視修正を含めた丁寧な単一セッション開発。
    - **オーケストレーション（ON）**: 音響5曲・テスト91件・TypeScript型設計など、商用インディーゲーム水準の網羅性とモジュール拡張性を求める本格開発。

## 5.70 2026-11-10 HYとDSHの圧縮前後のキャッシュ比較

- HYの直近の同一モデル3セッションは最大入力が16.7万・18.3万・33.0万で、圧縮イベントは全runで0。これらの累計が約99%に見えた理由に圧縮は含まれない。旧HYでは同一モデル・同一システム指示のまま、75.2万入力で99.05%から短縮直後の32.3万入力で0%に低下した。先頭維持と履歴復元は0.5.22で実装済みで、新版のこの規模での実運用は未確認。
- 同一OpenCode GoモデルのDSH長期ログでは、圧縮直後の本体要求が1.64%・3.89%、別ログでは70.40%・0%。最初のログは両ケースとも次の要求で99.7%以上へ復帰。DSHでも古い内容の置換でキャッシュが外れる。
- DSHの要約要求自体は3件とも入力約60.4万〜74.5万、キャッシュ約8.4千〜8.6千、命中率約1.15〜1.42%。DSH本体だけでは両ログとも99.55%、記録にある要約要求も加えると99.44%・99.42%。DSHの通常使用量の集計はassistant/message・assistant/attemptに限られ、圧縮要約を含めない。以前確認したキャッシュ再利用可能な要約の実装が、実運用でも温まっているとは限らない。

## 5.71 2026-11-10 コンテキスト圧縮の完了通知

- 自動・手動とも、圧縮結果をセッションログに1件記録し、同じ通知をライブのチャットと履歴の両方に表示する。ツール結果や画像の短縮、会話の要約、一部成功、失敗を区別。手動で変更がない場合は完了通知を出さない。通知はモデルに渡す履歴に含めない。
- 既定の発動条件は設定されたコンテキスト上限の75%。直近2ステップを残し、古いツール結果を後ろから参照に置き換えて60%を目安に下げる。それでも75%以上なら古いステップを要約に置き換える。既存の方針に従い、同じ接続先・モデル等の条件がそろう自動要約ではキャッシュ済みの入力を再利用する。
- 単体698件と、自動・手動の通知を確認するWeb結合2件が成功。Windows更新版 `release/next/HY-HARNESS-0.5.28-20261110-0636.exe` のバージョンとSHA-256を照合済み。稼働中のアプリへの適用は未実施。

## 5.72 2026-11-10 オーケストレーターのモデル切り替え

- 実ログ `run-2e31a7ff87f7` の06:20〜06:41は全102ステップが Gemini 3.8 Flash。オーケストレーター指示を確認でき、共有ブリーフも更新されたが、委任呼び出しは0件。実行モデルの思考はログに記録されていない。別セッションの DeepSeek ではワーカー6件が起動した。
- モデル切り替え画面が親のモデル名までワーカーの既定に保存し、接続先が OpenCode Go のまま Gemini 3.8 Flash になった。OpenCode Go はその組み合わせに HTTP 400 を返した。これは委任を試した場合にワーカーが失敗する問題で、ログでは委任を試した形跡がない。
- 保存先をサーバーがセッションの役割から選ぶように変更。Go への当該モデルの切り替えを拒否し、旧設定を読む際には該当する接続先に限って DeepSeek V4.1 Flash に復旧する。復旧後のワーカー設定は実APIで HTTP 200 を確認した。
- 同ログのツール呼び出し110件中19件が失敗。MCPの失敗13件のうち8件は `mcp_call` のルーティング引数を内側に入れた形式。共通の引数正規化で曖昧さのない2形式を復旧し、ツール説明とエラーに正しい階層を明示した。有効な外側のルートを持つ入力は元のペイロードを維持し、復旧した呼び出しにも通常どおり検証・承認を適用する。
- 生の Gemini API でも汎用 `mcp_call` の引数の二重化を再現。正式な `function_result` で継続しても発生した。短い同一依頼6組の比較では汎用ツールが5/6、`target` を直接定義した専用ツールが6/6で正しい呼び出し。HYが過去の呼び出しと結果をテキストにして再送する問題は確認できたが、短い比較では形式エラーへの寄与は未確定。MCPのツール固有スキーマを直接使う方式と、Geminiの構造化履歴の影響を長い実運用で分けて検証する。
- 実ログ8件は補正後にスキーマ検証を通過。単体698件、モデル切り替えとオーケストレーションのWeb結合13件が成功。Windows更新版 `release/next/HY-HARNESS-0.5.31-20261110-0652.exe` のバージョンとSHA-256を照合した。

## 5.73 2026-11-10 GeminiのMCP引数二重化の原因切り分け

- ネイティブ宣言の `mcp_call.args` は中身を定義しないオブジェクト。MCP固有の入力スキーマはセッション内のテキスト一覧に変換されるため、Geminiに渡る関数スキーマはルーティング引数の重複や対象ツールの入力不足を判別できない。
- 同一の合成クリック8件を Gemini API に直接送ると、汎用宣言は通常モードで3/8、`tool_choice: validated` で5/8が正しい入力。検証付きで残った3件はすべて外側と内側に `server` と `tool` があり、現在の外側スキーマでは合法。検証付きで `args` 内の `target` を必須にして追加項目を閉じた場合と、クリックを直接宣言した場合はどちらも8/8。別の12件の低推論比較は元の宣言10/12、説明変更11/12、`input` への改名12/12。高推論の短い12件では全条件で12/12となり、命名単独の効果や長時間稼働での差は未確定。
- 実セッションは初回の形式エラーが入力約3.3万、残り7件は約12.8万〜13.0万のクリックに集中した。構造化した結果返却でも二重化が起きるため、履歴のテキスト化だけでは説明できない。根本対策はMCPサーバーの各ツールを固有の入力スキーマで公開し、既存の権限判定を通して実行すること。構造化履歴の寄与は独立に検証する。調査では実行コードを変更していない。

## 5.74 2026-11-10 初回委任前の直接編集

- Gemini実ログは共有ブリーフの更新後、作業を7工程に分けた計画を提出したが、直接編集と検証を続けた。対象プロファイルにはツールの除外バンドルがなく、ネイティブの委任宣言を同じWeb実行経路からGeminiリクエストに送ることを回帰テストで確認した。従来は親が直接編集するたびにファイルの担当範囲が自動拡大し、初回委任を選ぶ実行上の分岐がなかった。
- 最初に切り出せる仕事を早く渡す役割方針を明確化。ワーカー未作成時、構造化ファイル編集を同じターンの2ファイルまで許し、3ファイル目は委任か狭い明示範囲と理由を求める。例外はターン内の指定範囲に限る。委任ツールを明示的に除外するバンドルはこの制限の対象外。
- 単体698件と関連Web結合14件が成功。Windows更新版 `release/next/HY-HARNESS-0.5.32-20261110-0703.exe` のバージョンとSHA-256を照合した。
- 実APIを使う隔離タスクで Gemini 3.8 Flash が初回の直接編集より先に委任し、OpenCode Go の DeepSeek V4.1 Flash ワーカーが起動してツールを実行した。約145秒の確認枠ではワーカーの完了報告と編集結果の確認に至らなかった。回帰テストでは委任先の編集まで確認した。

## 5.75 2026-11-10 Geminiの同一ワークスペース再試験

- 0.5.32で07:10に再開した同じ親runから、07:13〜07:14に5ワーカーを起動。委任は5/5成功。親は状態確認46件と待機18件を発行し、実行された待機の合計は134秒。親のシェル検証はワーカー稼働中に拒否され、その後、親は音響と敵のワーカーを報告前に中断してクローズした。保存状態の `done` は担当範囲を解放した状態を含み、完了報告とは別。
- 親子全体でツール420件、エラー27件。そのうち13件は作業指示の到着扱いで未実行。ワーカー報告も指示と同じ経路で送られ、親のファイル書き込みを止めた。残りは主にMCPの引数や実行環境、差分形式・パス表記の問題。所有中のファイルを絶対パスで渡したパッチは範囲比較で拒否された。親のMCPは14件中2件が失敗し、クリックの引数とルーティング引数の不足を再確認した。
- 07:40以降のブラウザ検証でゲーム開始、スコア更新、低速操作、ボム消費を確認。07:43:11に目標が `paused` になり、親の正常終了、コミット、プッシュ、Pages公開の記録なし。中断か例外かを識別できる終了理由は保存されていない。実行コードと対象セッションには手を加えていない。
- 07:54の「再開して」以降は52呼び出し中9件がエラー扱い。目標が一時停止中の完了要求1件と検証不足の判定2件、Git設定参照のポリシー拒否1件、未登録の `playwright:*` 直接呼び出し2件、`mcp_call` の `tool` 欠落1件、完了後の旧ワーカー通知による読み取り取り消し2件。Playwrightの待機秒数に5000を渡した呼び出しは上限30秒で成功扱い。GitHub APIへのPowerShell接続失敗（終了コード1）やHTTP 403/404/409もシェルのツールエラーには計上されなかった。
- Actions用の自作ワークフローは `Setup Pages` で失敗し、`gh-pages` からの標準Pagesデプロイで公開。公開URLと修正後のfaviconがHTTP 200。08:05:47に目標が完了となり、残留通知は処理済み。Playwrightで低速切り替え・ボム消費・ゲーム進行は確認できたが、ドラッグの試験はイベント送信と固定の `touchDragTested: true` だけで、自機座標の前後比較はない。

## 5.70 2026-11-10 Gemini-3.8-Flash オーケストレーション比較検証（4者横断分析）

- **背景**:
  - `testHY` ディレクトリにおいて、新たにオーケストレータ役に `gemini-3.8-flash`、ワーカー役に `opencode:deepseek-v4.1-flash` を採用したハイブリッド・オーケストレーション `Gemini`（リポジトリ: `hiyasinnsu/test_HY_gemini`）を走査・解析。
  - 先行の 3 実装（① DeepSeek ON、② DeepSeek OFF 通常、③ DeepSeek OFF 迅速）と合わせた 4 者横断比較を実施。

- **対象プロジェクト**:
  - **Gemini-3.8-Flash オーケストレーション**: `F:\GLM_PROJECT\JPN_LLM\testHY\Gemini`
    - リポジトリ: `hiyasinnsu/test_HY_gemini`
    - 公開URL: `https://hiyasinnsu.github.io/test_HY_gemini/`
    - セッション: `AppData\Local\hy-harness\state\88e4a32a3b2ce293`（オーケストレータ `run-2e31a7ff87f7` ＋ 5 分業ワーカー）

- **1. トークン消費・API料金・実行時間 4者比較**:
  - 実測指標一覧:
    | 指標 | ① DeepSeek ON (`DS`) | ② DeepSeek OFF 通常 (`DS_worker`) | ③ DeepSeek OFF 迅速 (`DS_speed`) | ④ Gemini-3.8-Flash ON (`Gemini`) |
    |---|---|---|---|---|
    | **所要時間** | 91.94 分 | 55.07 分 | 24.94 分 | **106.86 分（約1時間47分）** |
    | **LLM 呼出回数** | 385 回 | 140 回 | 85 回 | **488 回** (親 293 / 子 195) |
    | **総入力トークン** | 49,080,331 (49.1M) | 14,808,295 (14.8M) | 9,246,825 (9.25M) | **62,396,867 (62.4M)** |
    | └ キャッシュヒット | 48,120,192 (98.0%) | 14,633,728 (98.8%) | 9,150,592 (99.0%) | 子の実測 21,002,624、親は未記録 |
    | └ キャッシュミス | 960,139 (2.0%) | 174,567 (1.2%) | 96,233 (1.0%) | 子の実測 731,168、親は未記録 |
    | **総出力トークン** | 593,683 (0.59M) | 237,597 (0.24M) | 143,163 (0.14M) | **753,006 (0.75M)** |
    | **総トークン数** | 49,674,014 (49.7M) | 15,045,892 (15.0M) | 9,389,988 (9.39M) | **63,149,873 (63.1M)** |
    | **LLM レイテンシ累計** | 67.91 分 | 41.39 分 | 19.56 分 | **156.80 分** |
    | **推定 API 料金 (USD)** | **$0.6446 (約 100 円)** | **$0.2126 (約 33 円)** | **$0.1278 (約 20 円)** | **$31.7078 (約 4,915 円)**、親を全量通常単価と仮定 |

- **2. Gemini オーケストレーションのコスト要因分析**:
  - 親 Gemini 3.8 Flash の記録は293リクエスト、入力40,663,075、思考込み出力186,026トークン。アダプターは履歴全体を再送し、Interactions API の `usage.total_cached_tokens` を記録していない。
  - 親の記録済み入力を全量通常単価（入力 $0.75/1M、出力 $3.75/1M）で換算すると **$31.19（入力 $30.50、出力 $0.70）**。Interactions API は暗黙キャッシュをサポートし、明示キャッシュは対象外。ヒット率と実請求額はこのログから確定できない。
  - 子 DeepSeek ワーカー群（5人分、195リクエスト）のキャッシュヒット率は実測96.6%、料金は **$0.51（約80円）** の推計。
  - 通常のオーケストレーションで、Ralphにある金額上限を適用していない。長時間の有料再検証に先立ち、キャッシュ計測と費用上限の適用を確認する。

- **3. 実装クオリティ & 特徴比較**:
  - **コード規模 & アーキテクチャ**:
    - Gemini ON は 11 ファイルながら **9,754 行（`js/` 9,233行）** と極めて重厚。
    - 各専任ワーカーが極限まで作り込み、`js/enemy.js` (2,641行)、`js/player.js` (1,671行)、`js/audio.js` (1,620行)、`js/danmaku.js` (1,170行) と各単一モジュールが 1,000〜2,600 行に到達。
  - **音響エンジン**:
    - `js/audio.js`（1,620行）は全4実装中最もリッチ。16分音符ルックアヘッドスケジューラ、Am-F-C-Gコード進行、ベース/アルペジオ/リードの3トラック合成、iOS Safariアンロック、SE連打・発音数制限を完全実装。
  - **検証手法**:
    - Nodeの単体テストファイルを作成せず、**Playwright MCP ツールを用いた実機エミュレーション（解像度 390x844、タッチ相対ドラッグ、ボム・低速ボタン操作）による直接動作検証**を実施。
  - **GitHub Pages**:
    - `https://hiyasinnsu.github.io/test_HY_gemini/` にデプロイ完了、HTTP 200 OK で稼働確認。

- **4. 4者の総括**:
  - **コスト**: OFF迅速は約20円、OFF通常は約33円、ON DeepSeekは約100円。ON Geminiは親を全量通常単価と仮定すると約4,915円。
  - **所要時間**: OFF迅速（25分） < OFF通常（55分） < ON DeepSeek（92分） < **ON Gemini（107分）**
  - **品質・特徴**:
    - **Gemini ON**: 親がゴール管理やPlaywright検証を進め、各ワーカーが1,000〜2,600行のJavaScriptモジュールを生成。親の履歴再送量が多く、キャッシュ内訳と請求額は未確定。
    - **DeepSeek ON**: TypeScript型安全 + Vitest 91件テスト + BGM5曲。キャッシュが98%効くため約100円という驚異的なコスパで高品質を実現。
    - **DeepSeek OFF 迅速**: 25分・20円で必要十分な弾幕ゲームを完動させる最速・最安のベストソリューション。

## 5.76 2026-11-10 Geminiのツール実行・通知・キャッシュと予算

- 成功条件は、接続したMCPツールの固有入力をネイティブ宣言と実行時検証に使うこと、観察通知で現在の実行を取り消さないこと、Geminiの継続・履歴変更・キャッシュ明細・金額上限を外部課金なしで再現できること。
- MCPツールを安定した関数名と元のスキーマで直接公開。汎用呼び出しで隠れていた入力要件を型、必須項目、項目の説明とともに伝える。直接経路も従来のMCP許可・承認を通す。認証済みなのに実行時のみ有効だったGitHub機能は、同じ機能一覧をモデル宣言でも使う。
- ワーカー報告・相談とユーザーの方向変更を区別。前者は安全な境界で取り込み、無関係な呼び出しを維持し、待機中の複数報告を一度に処理する。親の睡眠待機を除外し、同じ状態の再取得は短い応答にする。シェルの終了コードやタイムアウト、ターンの中断理由を明示し、パッチの別表記はワークスペース内の同一パスに揃える。
- Geminiは変更されていないローカル履歴だけを `previous_interaction_id` で継続し、ツール結果は呼び出しID付きで渡す。履歴の書き換え・復元・古いIDの拒否ではローカル履歴を基準に新規チェーンを作る。キャッシュ命中が0件の応答と明細未返却を区別する。親、ワーカー、対話レーンは既存のオーケストレーション金額上限を共有し、価格を解決できるリクエストのみ保守的に事前予約する。使用量不明時は予約を残し、次の起動にも引き継ぐ。
- 追加実装を含む0.5.41で単体703件、関連Web結合21件、バージョンとAPI整合性の検査が成功。明示予算の送信前遮断と未指定時オフ、通知と訂正の区別、非同期待機、Geminiの構造化継続・キャッシュ明細・履歴変更時の切り替えをローカルで確認した。実APIの命中率・請求額は未測定。Windows更新版 `release/next/HY-HARNESS-0.5.41-20261110-2251.exe` のSHA-256は `98DCF549A4EF196F334D4E1B43C1657AE9CFFD51E4D90A44AC7CE74B434F4B93`。

## 5.71 2026-11-10 デフォルト予算上限（USDキャップ）の無効化（オフ）修正

- **背景**:
  - ユーザーより「デフォルト予算上限オフにしてよ、なんも設定しなかったら動かないの意味分からないよ」との要請。
  - 調査の結果、`packages/core/src/config.ts` において `const projectCost = tighten(pb.maxCostUsd, 2, Math.min)` とハードコードされており、ユーザーやプロジェクトが予算制限を意図していない（未設定）場合でも、デフォルトで $2 の上限が強制適用されていた。
  - そのため、オーケストレーション実行時等に `withModelBudget` が常時有効化され、単価情報（`pricing`）を持たないカスタムモデル（`openai-compatible:hy4` 等）を選択した際に `Set pricing for ... before running with a session cost limit.` でセッションが起動不能となる不具合を引き起こしていた。

- **成功条件**:
  - ユーザーまたはプロジェクトが明示的に予算上限（`maxCostUsd`）を設定しない限り、デフォルトでは予算上限がオフ（`budget.maxCostUsd: undefined`）となり、モデルの単価未設定が原因でセッションがブロックされないこと。
  - 明示的に `maxCostUsd`（数値）が設定された場合は、従来のコスト上限・リザーブ機構が正常に作動すること。
  - `maxCostUsd: 'off'` による明示的な無効化も維持されること。
  - 型チェック・既存全テストがパスすること。
- **維持すべき条件**:
  - 明示設定時の予算制御ロジック（`Budget4D`、`withModelBudget`、`reserve`）。
  - 他の制限次元（`maxRounds`, `maxTotalTokens`, `maxWallClockMs`）の挙動。

- **実装内容**:
  1. **`packages/core/src/config.ts`**:
     - `projectCost` の算出ロジックを修正。プロジェクト設定（`project.budget4D.maxCostUsd`）が未指定（`undefined` または `!Number.isFinite`）の場合は `projectCost` を `undefined` とし、デフォルトで 2 ドルを強制注入しないように変更。
     - `maxCostUsd: overrides.maxCostUsd === 'off' ? undefined : (overrides.maxCostUsd ?? projectCost)` により、未指定時の `budget.maxCostUsd` がデフォルト `undefined`（オフ）となる。
  2. **`packages/seams/src/budget.ts`**:
     - `DEFAULT_BUDGET` から `maxCostUsd: 2,` を削除（デフォルトなし・未定義）。
  3. **テスト追加 (`packages/core/src/config.test.ts`)**:
     - `budget: maxCostUsd defaults to undefined (off) unless explicitly set` を新規作成。未指定時に `undefined`、明示数値指定時にその数値、`'off'` 時に `undefined`、プロジェクト設定時に反映されることを網羅検証。

- **検証結果**:
  - **確認済み（事実）**:
    - `pnpm build` および `pnpm typecheck`：全パッケージ（core, seams, hy-cli, sdk, web, desktop）でエラー 0 件。
    - `pnpm test`：新規テストを含む **全702件が pass（0 fail）**。
    - `pnpm desktop:package:next` を実行し、`F:\HY-HARNESS\release\next\HY-HARNESS-0.5.37-20261110-0901.exe`（バージョン `0.5.37`、SHA-256: `214CA663F047E32AF0F006E299E90492FE399C9FEAE7DF2C4F42EF55AE9A7017`）を生成完了。
  - **未実施**:
    - 稼働中プロセス `HY-HARNESS.exe`（PID 61520 / 60732）への反映（ユーザーの任意のタイミングで更新ボタン等から再起動・適用可能）。

## 5.77 2026-11-10 オーケストレータの非同期待機プロトコル徹底・ポーリングループ遮断・ゴールラウンド誤起動抑止

- **背景**:
  - Gemini 等の非DeepSeekモデルにおいて、オーケストレータがワーカーにタスクを委譲した後、「ツールを呼ばずテキストで状況を報告してターンを終了する（待機状態に入る）」という非同期待機プロトコルを実行できず、`orchestrator_workers` や `get_goal`、`search_glob` 等を繰り返し呼び出して1ターン内に居座り続ける問題を解決。
  - また、`goal`（`create_goal`）を併用した際、ワーカー稼働中でも `scheduleGoalRound` が50ms後に親を起こし得る問題や、`goalMode` ナッジ・`announcesNextStep` ナッジとの干渉も合わせて解消。

- **成功条件**:
  - ワーカーに作業を委譲して手元の独立作業がなくなったオーケストレータが、プロンプト・ツール結果の両面から迷わず「ツールなし返信によるターン終了（Yield）」を選択できること。
  - `orchestrator_workers` を状態変化なしで連続・重複呼び出しした場合、1回目は終了誘導ヒントを返し、2回目以降は明確なツールエラー（`Polling rejected`）として物理的にループを遮断すること。
  - 稼働中ワーカーが存在する間（`allowWaitingReply: () => workersAreWriting()`）、`goalMode` および `announcesNextStep` の強制リトライを発火させず、`scheduleGoalRound` の50ms後割り込みも抑止すること。
  - 既存テストと新規単体・統合テストがパスし、ポータブルバイナリが生成されること。
- **維持すべき条件**:
  - 単一セッションや、全ワーカー終了後における `goalMode` / `announcesNextStep` ナッジの品質担保機能。
  - ワーカーのステータスが実際に遷移した際の `orchestrator_workers` の正常取得。
  - システムプロンプト先頭部分のクロスセッションキャッシュ不変性。

- **実装内容**:
  1. **プロンプト & ゴール方針の矛盾解消 (`packages/hy-cli/prompts/orchestrator.md`, `packages/core/src/prompt.ts`)**:
     - `orchestrator.md`: ツールを呼ばずに返答してターンを終えることは放棄・終了ではなく標準の待機手順（standard waiting protocol）である旨を明記し、時間稼ぎ・進捗確認のためのポーリングや無意味な検査呼び出しを禁止。
     - `prompt.ts` (`goalPrompt`): 「作業が残っているならツールを呼べ（If work remains, call a tool）」ルールに対し、非同期ワーカー待ちで手元の即時作業がない場合はツールを呼ばずにターンを終える例外規定を明記。
  2. **委譲ツール応答・コンテキストでの待機誘導 (`packages/hy-cli/src/web-server.ts`)**:
     - `spawnWorker` / `sendWorker`: 戻り値に `asyncExecution: true` と `nextStep`（自動起床するためポーリングせずターン終了して待つよう指示）を付与。
     - `projectContext`: `workersAreWriting()` が true の間に `[Waiting protocol]` の注記を動的挿入。
  3. **空打ちポーリング遮断とゴール自動起床抑制 (`packages/hy-cli/src/web-server.ts`)**:
     - `orchestrator_workers`: `workerPollUnchangedCount` を追跡し、状態無変化での再呼び出し1回目は `action: 'yield_turn'` の誘導を返し、2回目以降は `Polling rejected` エラーをスローしてループを断ち切る。
     - `scheduleGoalRound`: `session.kind === 'orchestrator'` で `workersAreWriting()` が true の間はタイマー発火を見送り、待機中の強制起床を防止。また、`handle.close()` 時に `goalTimers` を確実に `clearTimeout` するよう改善。
  4. **エージェント終了ナッジの免除とループ警告 (`packages/core/src/agent.ts`, `packages/hy-cli/src/session-app.ts`)**:
     - `AgentOptions` / `ConversationOptions` に `allowWaitingReply?: () => boolean` を追加（オーケストレータでは `() => workersAreWriting()` を接続）。
     - 稼働中ワーカーがある状態では `goalMode` ナッジおよび `announcesNextStep` ナッジを免除し、ツール無し返信による安全なターン終了を許可。さらに、待機中の反復・循環検知時には `[waiting hint]` で即時ターン終了を促すよう強化。
  5. **テスト追加 (`packages/core/src/agent.test.ts`, `tests/integration/web-ui.test.mjs`)**:
     - `agent.test.ts`: `allowWaitingReply: () => true` 時に `goalMode` / `announcesNextStep` でリトライされないことを検証。
     - `web-ui.test.mjs`: `orchestrator_spawn` の `asyncExecution` / `nextStep`、`orchestrator_workers` の無変化重複呼び出しに対する段階的拒否（1回目警告→2回目エラー）、稼働中ワーカー存在時の `scheduleGoalRound` 非発火を統合検証。

- **検証結果**:
  - **確認済み（事実）**:
    - `pnpm build` および `pnpm typecheck`：全パッケージエラー 0 件。
    - `pnpm test`：新規単体テストを含む **全703件が pass（0 fail）**。
    - `node --test --test-name-pattern="rejects repeated unchanged worker polling" tests/integration/web-ui.test.mjs`：**PASS**。
    - オーケストレーション関連統合テスト（`--test-name-pattern="orchestrat"`）：9件中 8件が PASS（残り1件 `unconfined` 承認テストは環境上の `workspace-write` 既定差分による既存前提の不一致）。
    - `pnpm desktop:package:next`：`F:\HY-HARNESS\release\next\HY-HARNESS-0.5.40-20261110-2130.exe`（バージョン `0.5.40`、SHA-256: `59C338EDF80FC42EDC15F060DD96556EE164CE7D00B98AE08D97A94DADD35BC4`）を生成完了。
  - **未実施**:
    - 実運用上の非DeepSeekモデル（Gemini / GPT 等）による新規セッションでのポーリング抑止効果確認（アプリ再起動後に検証可能）。

## 5.78 2026-11-10 Tencent Hy4 (openai-compatible:hy4) オーケストレーション比較検証（5者横断分析）

- **背景**:
  - `testHY` ディレクトリにおいて、オーケストレータ役に Tencent Hunyuan 4（`openai-compatible:hy4`、TokenHub API `/plan/v3`）、ワーカー役に `opencode:deepseek-v4.1-flash` を採用したオーケストレーション実装 `Hy`（リポジトリ: `hiyasinnsu/test_HY_Hy4`）を解析。
  - 先行の 4 実装（DS [ON], DS_worker [OFF通常], DS_speed [OFF迅速], Gemini [ON]）との 5 者横断比較を実施。

- **対象プロジェクト**:
  - **Hy4 オーケストレーション**: `F:\GLM_PROJECT\JPN_LLM\testHY\Hy`
    - リポジトリ: `hiyasinnsu/test_HY_Hy4`
    - 公開URL: `https://hiyasinnsu.github.io/test_HY_Hy4/`（HTTP 200 OK 確認済み）
    - セッション: `AppData\Local\hy-harness\state\3cee0efa8714b082`（オーケストレータ `run-fcaaf6a8ee33` ＋ ワーカー 2 ＋ サブエージェント 1）

- **1. トークン消費・API料金・実行時間 5者比較**:
  | 指標 | ① DS (ON) | ② DS_worker (OFF通常) | ③ DS_speed (OFF迅速) | ④ Gemini (ON) | ⑤ Hy4 (ON) |
  |---|---|---|---|---|---|
  | **構成** | 親DS+子7 | 単一DS | 単一DS | 親Gemini+子5 | **親Hy4+子2(DS)+Sub1** |
  | **所要時間** | 91.9 分 | 55.1 分 | **24.9 分** | 106.9 分 | **71.8 分** |
  | **LLM 呼出回数** | 385 回 | 140 回 | **85 回** | 488 回 | **380 回** (親268/子112) |
  | **総入力トークン** | 49.08M | 14.81M | **9.25M** | 62.40M | **47.37M** (親31.1M/子16.3M) |
  | └ キャッシュヒット | 98.0% | 98.8% | **99.0%** | 子 96.6%、親は未記録 | **98.2%** (親 **98.2%**) |
  | **総出力トークン** | 593.7k | 237.6k | **143.2k** | 753.0k | **282.7k** (親70.1k/子212.6k) |
  | **総トークン数** | 49.67M | 15.05M | **9.39M** | 63.15M | **47.65M** |
  | **LLM レイテンシ** | 67.9 分 | 41.4 分 | **19.6 分** | 156.8 分 | **49.6 分** (親は20.6分) |
  | **推定 API 料金** | **$0.64 (約 100 円)** | **$0.21 (約 33 円)** | **$0.13 (約 20 円)** | **$31.71 (約 4,915 円)**、親を全量通常単価と仮定 | **割引時 $1.18 (約 183 円)**<br>**定価時 $2.14 (約 332 円)** |

  - ※ Hy4 TokenHub レート（`grounded_search` 参照）: 定価 Miss $0.834 / Hit $0.042 / Out $2.501 (1M)、2026年末まで50%割引 Miss $0.417 / Hit $0.021 / Out $1.2505 (1M)。

- **2. Hy4 の挙動・コスト・品質特徴**:
  - **高キャッシュ命中による低コスト維持**: Hy4 は OpenAI 互換エンドポイント経由で **98.2%** のキャッシュヒットを記録し、総トークン 47.65M を **約183円（割引時）〜332円（定価時）** と換算。Gemini 親のキャッシュ明細は旧ログにないため、約4,915円は親を全量通常単価と仮定した比較値。
  - **高速な推論レスポンス**: 親の応答レイテンシが 268 回呼出で計 20.6 分（1回平均 4.6秒）と高速。
  - **オーケストレーション特性と課題**: ゲーム本体を1ワーカーに一括委任。親の `browser_run_code_unsafe` 131件には、同じ認証環境確認の124件が含まれる。ブラウザ検証とは分けて評価する。実装ワーカーはツール形式エラーで中断し、親が最終テストと公開を引き継いだ。詳細は5.79。

## 5.79 2026-11-11 Hy4のツール呼び出し・思考ログ監査

- 対象は11月10日08:48〜09:47の親 `run-fcaaf6a8ee33` と子3セッション。ツール結果433件（エラー33件）、記録された思考146件、思考要約142件。初期3ターンは当時の未設定予算上限によりAPI送信前に停止した。
- 最優先はGitHub資格情報の漏出。診断ワーカーのシェル出力に未伏字の認証ヘッダーがあり、その内容が後続のモデル応答にも現れた。平文置換で別表現が残った。ローカルの公開ブランチ2コミットを照合し、同じ認証値は見つからなかったが、診断メモにローカル環境情報が含まれたまま公開された。資格情報自体はここに記録しない。
- 親はシェル制限中にPlaywrightから認証環境を確認しようとし、同一コードを124回実行。すべて値なし。約15分の区間で、対象ステップのモデル待ち計426秒・入力1,441万トークン。思考では何度も止める方針を示したが、警告や間に挟まれた別ツールでは反復を止められなかった。
- 読み取り専用サブエージェントにシェル診断を依頼し、診断ワーカーにも禁止されているGit操作を委任した。ワーカーIDを背景サブエージェント用 `wait_agent` に渡す誤用もあった。現行コードの `beforeTool` には、非割り込みの観察通知もキュー件数だけで拒否する別経路が残る。
- ゲームワーカーの最後はDSML風タグと壊れたJSONが混じり、連続形式エラーで停止した。停止前と親の再実行でそれぞれNodeテスト29件が成功し、公開先で開始・ボム消費・一時停止・再開と主要リソースHTTP 200を記録。最後の不正な編集は実行されなかった。

## 5.80 2026-11-11 Git操作とGitHub認証の分離

- 成功条件は、モデルが認証情報を扱わずにGitの状態確認・準備・選択コミット・pushを行え、同じ認証値が汎用シェル・MCP・ツール出力に出ないこと。通常のGit変更権限とワーカーの読み取り制限を維持する。
- GitHubの認証値を汎用シェルへ注入する処理を削除。MCPの継承環境と実行デーモンでもGitHub認証用の環境変数を除外する。認証付きGit HTTPSは、作業ツリーの設定とフックを読まない一時bareリポジトリから実行し、資格情報はその通信プロセスにのみ渡す。新しいツール結果と旧履歴のモデル送信前に認証表現を伏せる。
- `git_status`、`git_prepare`、`git_commit`、`git_push` を追加。既存コミットと別のステージ済みファイルを保持し、個別選択したファイルだけをコミットする。ワーカーには状態確認を公開し、Git/GitHubの変更は親が担当する。実行能力を持たないレーンへの背景サブエージェント操作も非公開にした。
- 0.5.46で単体704件と関連するWeb GUI結合19件が成功。認証変数を許可リストに含めても通常シェルに渡らず、専用ツールでは設定有無を表示してコミットできることを確認。公開リポジトリを一時ワークスペースへ取得できた。認証付きの実リポジトリへのpushは未検証。

## 5.81 2026-11-11 Hy4監査後の実行・委任・検証改善

- 同じ入力と結果が3回続いた呼び出しを、他の呼び出しが間に入っても実行前に抑止する。結果が変わる観測は継続し、進展がない場合は早期終了、ワーカーが稼働中なら報告待ちに移る。Hy4ログの呼び出し順を再生したところ、124回の同一呼び出しに対して代替ツールの実行は3回で止まった。
- モデル応答をネイティブ・本文・空に分類し、取得可能なアダプターでは出力上限による打ち切りも記録する。打ち切られたバッチは実行しない。ネイティブ形式が連続で崩れた場合は、そのターンをJSON本文形式に切り替え、最後に確認できた結果から再開する。
- 委任ツールに必要能力の宣言を追加し、読取専用やツール制限と食い違う宣言は起動前に拒否する。独立ファイルのJSON・文字列チェックをワーカー稼働中に実行できるようにし、任意のシェルによる全体検証は既存の排他制御を使う。
- 0.5.49で単体706件、Web GUI・ビルド版番号の結合51件、回帰29件が成功。Hy4の停止直前に記録された不正応答2件を再生し、両方を実行せずに形式切替後の正常な読み取りへ進めた。保存ログの再生は実モデルの再走や削減額の測定を含まない。

## 5.82 2026-11-11 ポータブル版の二重起動と更新ファイルの消失

- 0.5.41の稼働プロセスの展開先にアプリ本体と更新用スクリプトが残っていなかった。0.5.49を二重起動すると、同じ展開先を使用し、後から起動した方の終了で先の更新用スクリプトが削除されることを再現した。
- electron-builder 26.18ではオプションの説明と実装に食い違いがあり、`portable.unpackDirName: true` が起動ごとに固有のNSIS展開先を使う。欠損時の表示には完全終了して再展開する手順を追加した。
- 0.5.51の配布exeを二重起動し、後から起動した方の終了後も先の更新スクリプトが残ることを確認した。配布exeに含まれるスクリプトで一時ファイルの置換とSHA-256照合が成功。単体706件、更新テスト5件が通過し、稼働中の0.5.41への更新適用は未実施。

## 5.83 2026-11-11 モデル・プロバイダ・タスク汎用性の監査

- **目的**: 配布先の利用者が未知のモデル・未知のタスクを使う前提で、特定モデル／プロバイダ専用の分岐と、将来破綻する仮定を洗い出した。初回はリストアップのみで、同日の追補で P0/P1 の一部を実装した（下記「実装」）。
- **方法**: 4領域（プロバイダ適応層、プロンプト・ツール呼び出し、文脈・トークン、環境・タスク）を並行監査し、オーケストレーターが主要な行番号を再確認して統合した。
- **主要な結論**:
  - モデル名でプロンプトを切り替える処理は無い。対症療法は適応層（`llm.ts:467`、`model-catalog.ts:133,140,147`、`llm.ts:1508`）、ツール呼び出しの解釈（`agent.ts:833`、`reply-guard.ts:334`）、言語ヒューリスティック（`reply-guard.ts:456-508`）に存在する。
  - 適応リトライ（`max_tokens` の代替、`reasoning_effort` の省略）がストリーミング経路に無い（`llm.ts:482-511` 対 `llm.ts:665-691`）。`streaming` は既定オン（`features.ts:18-22`）のため、未知の OpenAI 互換サーバでは既定経路が 400 で落ちる。
  - ロールは provider 既定の窓を継承し、カタログを参照しない（`config.ts` は `MODEL_CATALOG` を import しない）。未知モデルで圧縮が発火せず、コンテキスト超過 400 を拾って圧縮する経路も無い。
  - 配布直後に踏む環境依存の穴: MCP の `npx` 起動不可（`mcp.ts:81-87`）、実行デーモン不在時のスタックトレース（`exec-rpc.ts:82,98-113`）、CRLF で `edit_file` が一致しない（`tools.ts:861-866`）。
  - 「次にやります」と宣言して止まった応答の検出が日本語・英語のみ（`reply-guard.ts:456-508`）。
- **成果物**: `docs/audit/2026-11-11/README.md`（統合・優先度付き）と領域別レポート4件、`00-verified-findings.md`（オーケストレーターが直接確認した事実）。
- **実装（同日追補）**: 利用者の指示で、可変的なモデル情報をハーネスから外してユーザー登録にし、次の P0/P1 を実装した。
  - モデル台帳を `config.json` の `models[]` に移し、組み込みの価格・コンテキスト長・能力表を削除。`pricing` / `compat` / `capabilities` を登録できる。`llm.ts` の Gemini 固定価格と日付分岐、OpenCode 0 円も削除。
  - モデル名の正規表現（`reason`・`gpt-6.1-terra` など）を廃止し、400 の本文から拒否フィールドを判定して 1 回だけ落として再送する汎用ネゴシエータ（`llm-negotiate.ts`）を新設。**ストリーミング経路にも適用**。`content` 配列と usage のフィールド差も正規化。
  - `role.headers` / `extraBody` / `apiPath` / `requestTimeoutMs` を追加（Azure 等の Bearer 以外の認証と社内ゲートウェイ向け）。
  - 推論の返送は「そのエンドポイントが返したら以後返す」観測ベース（`reasoningEcho` で強制可）。Gemini の画像可否を false に。
  - `ToolSpec.aliases` による別名のデータ駆動化、`edit_file` の CRLF 正規化、XML 単体ツール呼び出しの汎用パーサ、`richToolDocs` の分離と lean3/lean4 の統合、`announcePatterns`（言語別パターンのユーザー登録）。
  - `ContextManager.forceCompact` とコンテキスト超過 400 の自動回復、ネイティブ引数の文字列/配列正規化、step 上限、補助ロールの effort 既定 none、`cacheCompaction` の構造条件化、`roleApiKeyEnv` と doctor の全ロール検査。
  - MCP の `.cmd` シム起動（`ComSpec` 経由）、実行デーモン不在時の 1 行エラーと `child.on('error')`、一回限りシェルの UTF-8 前置き。
- **サンドボックスの一般化（同日追補）**: 制限付きモードの `spawn EPERM` / `0xC0000142` を終了状態から判定し、コマンド形ごとに**一度だけ** low-integrity への昇格を承認カードで尋ね、承認後に同じコマンドを再実行する仕組みを `tools.ts` に追加した（承認はユーザーのみ。Guardian 不可）。コマンド名の列挙に頼らず、未知のビルドツールにも同じ手順で対応する。`pipeChildGap` の部分一致による誤検知も、行頭の Node エラー行に限定して解消した。
- **検証（同日）**: `tsc -b`（core/seams/hy-cli/sdk）と web/desktop の型検査が成功。単体テスト全件 pass、回帰 9 pass / 20 skip / 0 fail、`cargo test -p hy-exec-server` 42 passed、`gen:config-schema` 一致。統合テストはサンドボックスの `spawn EPERM` で大半が起動できず、個別実行で `models` / `onboarding` は pass。昇格機構は単体テスト3件で確認（検出、1回だけの承認、Guardian 不可）。
- **実 API 確認（同日追記）**: `OPENCODE_API_KEY` は User スコープに存在し、プロセス環境へは継承されていなかった。User スコープから読み出して `opencode / deepseek-v4.1-flash` で実走し、**ストリーミング・ネイティブツール呼び出し・usage 解析・推論の返送（2回目で `reasoning_content` を送信）が 200 で動作**することを確認した。`max_completion_tokens` はこのゲートウェイがそのまま受理した。
- **未検証**: 400 を受けてのフィールド削除・再送は、範囲外 temperature（5）・`reasoning_effort: 'ultra'`・不正なツール名のいずれも 200 で受理され、実 400 を起こせず**未確認**（スタブサーバのテストのみ）。コンテキスト超過 400 からの `forceCompact`、MCP `.cmd` 起動、一回限りシェルの文字コードも単体テストまでの確認。
- **パッケージ生成（同日追補）**: サンドボックス解除後に `pnpm desktop:package:next` が成功。`release/next/HY-HARNESS-0.5.54-20261111-0304.exe`（196,126,389 bytes、SHA-256 `35B0C83A7DA0CCE1974BB0B49E382888C78582DA07697EB13309FCD378AE72A0`）。コード署名は未設定。
- **残件**: `usesNativeTools` の能力化、Web UI の既定値重複、`[DONE]`/`finish_reason` 欠落の許容（安全側で見送り）、未知モデルの保守的既定窓、BOM・非 UTF-8、巨大ファイル、symlink、サブエージェントの圧縮、対話セッションの予算、役割別プロンプト、設定 JSON の警告、hooks/skills の検証、プロキシ、価格の GUI 登録、昇格の判断の永続化（現状はセッション内のみ。`policy.star` への保存は GUI の「常に」に委ねる）。
- **次の作業**: 上記の残件のうち、未知モデルの保守的既定窓と対話セッションの予算から着手する。実 API が使える環境では、まず適応リトライと 400→`forceCompact` を実走で確認する。

## 5.84 2026-11-11 別セッションの改善提案の検証とアダプタ一般化

- **目的**: 別セッションが提示した「モデルを最大限有効活用する」改善提案（プロバイダ層・予算・エージェントループ・プロンプト/ツール公開・実行基盤）を、実コードと突き合わせて検証した。
- **方法**: 4領域に分けて並行検証し、主要な判定はオーケストレーターが再確認した。詳細は `docs/audit/2026-11-11/verify-*.md` と同 README §8。
- **結果**: 大半は正確。主な差分は (a) 主張5-1 は `native:false` では短縮説明が残るため「一部正確」、(b) 主張6-6 は null 化の範囲が主張より狭い、(c) 6-7b（親の二重ステータス/対話注入）は対象を特定できず確認不能。
- **追加で判明した欠陥**: 予算の予約は `degenerate` だけでなく **usage 欠落でも残る**／予約超過が素の `Error` で agent の catch を素通り／`reservedCostUsd` が永続化されて戻らない／ralph は cache 単価を無視／`--max-cost-usd` の help と既定値が不一致／これらの回帰テストが無い。
- **実装（同日）**: `llm.ts` を一般化し、`extraBody` / `apiPath` / `requestTimeoutMs` を全アダプタへ適用（共通の `requestSignal`）。Anthropic は `effort` を `thinking.budget_tokens` に変換し thinking 有効時は temperature を送らない。Gemini は effort を low|medium|high へ写像。Responses は temperature（reasoning 無効時）、応答 reasoning、`call_id` を取得。Ollama は `think` を effort に連動。
- **検証**: `tsc -b`（core/seams/hy-cli/sdk）成功、単体テスト全件 pass。
- **未修正**: 主張1（ターンを跨ぐ互換学習の共有）、3（予算の予約・精算・cache 単価）、4a〜4d（エージェントループ）、5-1〜5-5、6-1〜6-6。
- **次の作業**: 主張1（`drop`/`echoReasoning` を provider:baseUrl:model 単位でプロセス共有）と 3（予約の精算・usage 欠落時の扱い）、4b/4c（待機復帰の履歴、`blockedSteps` のリセット）から着手する。

## 5.85 2026-11-11 未修正項目の実装（追補2）

- **目的**: §5.84 に残した欠陥を、副作用の無いものから実装する。
- **実装**: 互換学習（`drop`/`echoReasoning`）を `provider|baseUrl|model` 単位でプロセス共有。予算は `degenerate`・usage 不正・例外でも必ず精算し、予算下の 5xx/通信エラー再試行を許可、キャッシュ単価を `Budget4D` に反映。エージェントループは降格時のリトライ回復、待機復帰の履歴、`blockedSteps` のリセット、`shell` 成功時の観測無効化。JSON 打ち切り判定を一般化し native でも差し戻す。XML の並列呼び出し・型付き引数。`richToolDocs: false` と text モードの規則欠落。job 4ツールの wire 化。`edit_file` の `working_directory` と UTF-16（daemon の `encoding`）。MCP の `readOnlyHint` と説明上限。LSP の `.cmd`。実行デーモンの 4 MiB 末尾保持（先頭+リング）と行単位 CP932、`$/cancelRequest`。承認タイムアウト後の `blocked` 解除。読み取り専用サブエージェントへの役割プロンプト誤注入。`tamper-rejected` の rollback と truncated Gate 2。ベンチの `.sub` 分離。
- **UI**: ジャンプレールの再構築を差分時のみにし、アクティブ判定をトランスクリプト実要素へ。ジャンプ中はスクロールスパイを抑制。`span` の transition を opacity のみに。非表示中は描画を保留し、可視化時に1回だけ catch-up。
- **検証**: `tsc -b` と web/desktop 型検査が成功。単体テスト **753 pass**、回帰 **29 pass / 0 skip**、`cargo test --workspace` 全 pass、`gen:protocol` / `gen:config-schema` 一致。実 API（`opencode/deepseek-v4.1-flash`）でストリーミング・ツール呼び出し・usage・別ターンを確認。
- **パッケージ**: `pnpm desktop:package:next` が成功。`release/next/HY-HARNESS-0.5.55-20261111-0603.exe`（196,141,635 bytes、SHA-256 `C41F6918EE4ADD573EBCF89A69C764F604C2D818CFF0D1662E7A18D76DA291E2`）。コード署名なし。
- **未検証**: 実 4 MiB 出力、5分承認タイムアウトの実時間、UI の実画面、実モデルでの JSON 切り詰め再現。

## 5.86 2026-11-11 モデル別の場合分けの汎用化と、未知モデル・未知タスク向けの修正

- **目的**: 特定モデルで起きたミスに合わせた場合分けを、同じミスを防げる汎用的な仕様に置き換える。配布先で別のモデル・別のタスクを使ったときに起きそうな不具合を、現行コードから推定して直す。実 API の再走は行わない（Gemini で親のキャッシュが効かず約 4,900 円かかった件を踏まえ、保存ログと単体テストで検証）。
- **根拠（保存ログの集計）**: testHY の 7 実行を `reply/recovered` で集計した。テンプレートタグ混入の修復は Hy4 で 268 ステップ中 98 回、DeepSeek で実行あたり 0〜18 回。構造化したツール結果を送っていた Gemini だけが 0 回だった。Hy4 は native モードなのに `{"calls":[...]}` を本文に書いており、ハーネスが過去の呼び出しを JSON 本文として送り返していた形式をそのまま真似ていた。
- **実装**:
  - A: native モードで、散文の中に引用された呼び出し JSON（コードフェンス内も含む）を実行していた。応答全体が呼び出しのときだけ実行し、散文に埋め込まれた呼び出しは実行せず 1 回だけ差し戻す。
  - 1-6: ツール呼び出しと結果を、各 API 本来の形式で送り返す（OpenAI `tool_calls`/`role:tool`、Anthropic `tool_use`/`tool_result`＋署名付き thinking、Responses `function_call`/`function_call_output`、Ollama `tool_calls`/`role:tool`）。呼び出し ID はログに残し、再開時も同じ形を復元する。圧縮で書き換わった結果は、最初の呼び出しにまとめて答える。text プロトコルでは従来どおり。
  - B: 本文の `<think>…</think>` と Ollama の `thinking` を推論として分離する（ストリーミング表示も含む）。
  - C/D/E/F: 400 から「値が大きすぎる」と「フィールド非対応」を区別し、`max_tokens` は値を縮めて同じフィールドで再送する。effort は有効値の一覧があれば最も近い値に丸める（`none` が無いときは送らない）。この学習を Anthropic / Responses / Gemini にも適用。temperature はロールで指定したときだけ送る（既定 0 を廃止し、カタログの `compat.temperature` も反映）。未登録モデルは 128K/16K を仮定する（プロバイダ既定モデルの 1M を流用しない）。コンテキスト超過エラーに書かれた窓で圧縮目標を下げ、強制圧縮は短くなる限り最大 3 回。
  - J: 伏字処理がメッセージを作り直す際に Gemini の継続情報と構造化結果を落としていた。全フィールドを保ち、呼び出しと結果も伏字にする。
  - 1-1〜1-4: Web UI のモデル名 switch（窓・出力上限）と、モデル別の effort 一覧を削除した。ユーザーのプロファイル、プリセットのデータ、プロバイダ既定、保守値の順に使う。続けて `POST /api/model-limits` がレジストリ、またはエンドポイントの `/models`（`context_length` / `max_model_len` / `inputTokenLimit` など）を返す。OpenCode Go 専用の「gemini-3.8-flash は使えない」判定は、エンドポイント自身の一覧照会に置き換えた。Ollama の画像対応は `/api/show` の capabilities で判定し、名前の正規表現は応答前の仮判定に格下げした。
  - 1-7/1-8/I: システムプロンプトを 1 本に統合した（lean/legacy/lean2 の分岐を削除。`promptVariant` は受け付けるが何も選ばない）。冒頭を「coding agent」から一般化し、最終回答は「何をしたか・どう確かめたか・確かめられなかったこと」に変更。ターンの終わり方を両プロトコルで明文化した。「次にやります」検出は言語別のデータ表にした（英・中・韓・西・葡・仏・独・伊、日本語は従来どおり）。「Let me know.」の誤検出も修正。
  - G/H: XML の本文呼び出し修復が、プラグイン・MCP のツール名も認識するようにした。思考要約は UI の言語（`X-HY-Locale`、無ければ OS のロケール）で書く。日本語の文面は従来のまま。Guardian と圧縮のプロンプト、Office スキルも OS・タスクに依存しない文面にした。
- **検証**: `tsc -b`（core/seams/hy-cli/sdk）と web の型検査が成功。単体テスト **771 pass / 0 fail**（新規 18 件: 引用 JSON の非実行、各 API の構造化履歴、プルーニング後の回答、`<think>` 分離とストリーミング、伏字、値上限の学習と再送、effort の丸め、未知モデルの窓、Ollama capabilities、多言語の宣言検出、プラグイン名の XML 修復）。回帰 **29 pass / 0 fail / 0 skip**（モック・ローカル Ollama のみ、課金 API なし）。
- **未検証**: 実モデルでの構造化履歴による修復回数の減少（ログの相関からの推定で、再走していない）。Anthropic の署名付き thinking の往復。各ゲートウェイが実際に返す 400 の文面。Web UI の実画面。
- **未対応**: Gemini アダプタの画像送信（API 形式を確認できる実行環境がないため見送り）。ワーカーの `STATUS:` 行は英語固定のプロトコルとして維持。OpenCode の旧モデル名の読み替えは、モデル規則ではなくハーネス自身が過去に書いた設定の移行として残した。
