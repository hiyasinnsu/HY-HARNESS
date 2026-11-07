# システムプロンプト調整の引き継ぎ（2026-11-07）

HY-HARNESS の system prompt を、ベンチマークで 1 か所ずつ効果を測りながら詰めていく作業の引き継ぎ。これまでの経緯、比較の材料、ベンチの中身と使い方、結果、決まったこと、残っている候補をまとめる。

- 説明は日本語で。コミットは確認なしでしてよいが、push は必ず確認を取る。
- git は exFAT のため `git -c safe.directory='*' …` で使う。

---

## 1. 目的と進め方

- **目的**: 性能の上限ではなく、**安定性**を高める。課題は易しいまま（今のベンチは両ハーネスとも毎回全課題に成功する）にして、回数を増やして精度を上げる。
- **進め方**: 今の版から「1 か所だけ」変えた版を作り、ベンチで 10 回ずつ比べる。予想どおり差がなければ、その簡素な版を土台にして、さらに削るか効きそうな文を足す。
- **判断の基準**:
  - 成功率が同じで、トークンや手数が悪化していなければ採用してよい。
  - 「有意差なし」は「同じ」ではない。10 回ずつで見分けられる差の目安は、ツール呼び出し ±5〜6、出力トークン ±2,000、プロンプトトークン ±10 万。
  - 成功率や上限性能に効く文（失敗の扱い、確認のし方、粘り強さなど）は、今の易しい課題では差が出にくい。必要になったら難しめの課題を足す。

## 2. プロンプトの現在地

実装は `packages/core/src/prompt.ts` の `buildSystemPrompt`。設定 `promptVariant`（ユーザー設定 `config.json`）で切り替える。

| 版 | 状態 | 内容 |
|---|---|---|
| `legacy` | 旧既定 | 冒頭に「ワークスペースと役割は末尾に書く」の案内。推論は日本語でぶっきらぼうに、丁寧語・つなぎ言葉・言い直しなし、最初に次の行動を一文で |
| `lean` | **現在の既定**（2026-11-07〜） | 冒頭 2 行だけを短くした版（下記）。それ以外は legacy と同じ |
| `lean2` | **評価中** | ユーザーが下書きしたルール一式（下記）。関数呼び出し（native）モードのときだけ適用。目標モードと出力形式指定のモードは終わり方の 1 文だけ従来どおり |

どの版でも、末尾に `This session:` 以下（ワークスペースのパス、日付、スキル/MCP 一覧、役割の説明、ゴール）が付く。変わる部分を末尾に寄せたのは、セッションをまたいでキャッシュを共有するため（§6）。日付・AGENTS.md・メモ・メモリーは system prompt ではなく、会話の末尾の `<hy_session_context>` ブロックで渡す。

### lean（現在の既定、native モード）

```text
You are HY-HARNESS, a careful autonomous coding agent.
Private reasoning style: use a concise tone.
Shell environment: Windows PowerShell. Use PowerShell syntax (Get-ChildItem, Select-String, Get-Content, Get-ChildItem -Recurse). Do not use Unix grep/head/find. The shell cwd is the workspace root; use a relative cwd or an absolute path inside the workspace, and quote paths with spaces.
Rules:
Use the provided tools through function calls; call several at once when they are independent.
Call tools only through function calls; never write JSON such as {"tool":...} or {"calls":[...]} in the body. Write plain prose in the body, and only for the final answer.
Such JSON, especially a truncated fragment, is never a final answer: emit a real function call, or plain prose only when the work is done.
If work remains, your reply must contain a tool call. Do not end with a plan, a promise, or a confirmation request; prose without a tool call is treated as the final answer.
When the work is done, reply without a tool call: a short summary of what changed and what you verified.
Read a file before editing it. apply_patch rejects stale or unread files.
Prefer small, verifiable steps. Inspect shell output before continuing.
Never claim success without checking the result.
Do not try to read or write outside the workspace.
If a path is missing, locate it with search_glob / search_grep instead of guessing similar paths.
For a large edit, split it into several apply_patch calls; do not emit an entire large file in one response.
To create or replace a whole file, give apply_patch file + content; to edit part of a file, a unified diff in patch.

This session:
Workspace root: …
```

### lean2（評価中、native モード）

```text
You are HY-HARNESS, an autonomous coding agent.
Private reasoning style: use a concise tone. Do not state uncertain points as certain; present them as possibilities.
Shell environment: （lean と同じ）
Rules:
Use the provided tools through function calls; call several at once when they are independent.
Read the user's intent and its background before acting.
Do not settle for a partial solution.
To continue working, your reply must contain a tool call. A reply without a tool call is your final answer: make it self-contained, and do not end it with a plan or an offer. Ask the user only when a decision is genuinely theirs; say what you need decided and why (use ask_user when available).
In the final answer, lead with the conclusion; if you did work, summarize clearly what changed and what you verified.
Read a file before editing it. apply_patch rejects stale or unread files.
Prefer small, verifiable steps. Inspect shell output before continuing.
Do not try to read or write outside the workspace.
If a path is missing, locate it with search_glob / search_grep.
For a large edit, split it into several apply_patch calls; do not emit an entire large file in one response.
To create or replace a whole file, give apply_patch file + content; to edit part of a file, a unified diff in patch.
```

lean からの変更点:

| 区分 | 変更 | 理由（ユーザーの判断） |
|---|---|---|
| 削除 | 「careful（慎重な）」 | 「中途半端で妥協しない」などの文で補えると推測 |
| 削除 | 本文 JSON を書くなという 2 文 | 一時期のツール呼び出しミスへの一時対処。実ログで本文 JSON の差し戻しは全体で 2 回（11/4・11/5）、ベンチ 56 セッションで 0 回。コード側に差し戻しの安全策がある（`looksLikeBrokenToolCall` → 1 回差し戻し → 定型文で停止） |
| 削除 | 「結果を確かめずに成功と主張しない」 | 理由が記録に残っていない（最初の取り込み時からある）。DSH・Codex には同じ文がない |
| 削除 | 「似たパスを推測せず」 | 11/4 に実際の失敗（read_file の見つからない率 13〜16%）への対策として追加した。ただし同時に入れたルート名二重付けの修正と、エラー文の「search で探して」案内のほうが主因とみられ、11/6 は 1.2%。DSH にも同じ文はない |
| 追加 | 推論に「自信のないことは断定せず、可能性として述べる」 | 「簡潔に」で疑わしい事実まで言い切るのを防ぐため（ユーザーの憶測、未検証） |
| 追加 | 意図と背景を読み取る／中途半端で妥協しない | Codex を参考に |
| 変更 | 終わり方: 最終回答は自己完結、計画や申し出で終わらない。本当にユーザーの判断が必要なときだけ、何をなぜ決めてほしいかを明確に尋ねる（ask_user） | 旧文は確認の依頼まで一律に禁じていて強すぎた |
| 変更 | 最終回答: 結論を先に、作業をしたなら変更と確認を分かりやすく要約 | 旧文は作業前提で、質問への回答に合わなかった |

## 3. 比較の材料

- **DSH**（DeepSeek Harness 0.2.1-rc.3、`%LOCALAPPDATA%\Programs\DeepSeek Harness`）の、ベンチ実行時に実際に送られたもの（HY の作業フォルダー外、git 対象外）:
  - `.bench/prompts/dsh-system.txt`: system prompt
  - `.bench/prompts/dsh-tools.json`: ツール定義 25 個（約 20,800 文字）
  - `.bench/prompts/dsh-injected.txt`: 会話に足すメッセージ（AGENTS.md、実行環境、スキル一覧）
- **Codex**: この PC の `~/.codex/sessions/**/rollout-*.jsonl` の先頭行（`session_meta.payload.base_instructions`）から取り出したもの。`.bench/prompts/` に置いた（git 対象外）。
  - `codex-gpt-6.1-sol-76db213c.md`（本体の原文、21,769 文字）
  - `codex-gpt-6.1-sol-ja.md`（日本語訳）
  - ほかにモデル違い、自動レビュー（`custom`）、コードレビュー用、旧 CLI 汎用プロンプトがある
- **DSH の system prompt の要点**:
  - 推論・回答言語の指示はない。
  - 0 以外の終了コードは原因を調べてから進む。
  - 読むのは read、探すのは glob / grep（シェルの cat / find / grep は使わない）。
  - 部分変更は edit を優先。
  - ほかにバックグラウンドの作業、Web の内容を信用しない、ゴール、ワークフロー、サブエージェントの並列起動の注意がある。
  - 細かい使い方は各ツールの説明側に書く（`pwsh` だけで約 3,500 文字）。
  - 推論を会話に残し、`reasoning_content` として送り返す（pi-ai）。
- **Codex の要点**:
  - 推論・回答言語の指示はない。
  - 自律性と粘り強さの指示が厚い（「できる？」は実行、計画や申し出で止まらない、中途半端で妥協しない、許可が要るのは取り返しのつかない操作だけ）。
  - 途中経過は 60 秒以上空けない。最終回答は自己完結させる。
  - 作業中の新しいメッセージは舵取りとして扱う。圧縮されてもやり直さない。
  - テストは「変更に見合ったものを走らせ、通ったら理由がない限り広げたり繰り返したりしない」。
  - 文章のスタイル指示（結論から、平易に、決まり文句を避ける）はすべて出力向け。

## 4. ベンチマーク（`bench/harness/`）

詳細は `bench/harness/README.md`。

- **条件**: 両方とも OpenCode Go の `deepseek-v4.1-flash`、effort `max`。
  - **HY**: `hy chat --full-auto`（1 プロセスで 4 ターン）。実行のたびに新しい設定フォルダーを作り、ユーザーの `config.json` から MCP（`mcpServers`、`automation`）と追加ルートを除いて `HY_CONFIG_DIR` に渡す。RULE.md とスキルはコピーしない。
  - **DSH**: `dsh --profile headless --patch bench/harness/dsh.patch.yml`。課題ごとに起動し、`--session-id` で続ける。API キーは環境変数 `OPENCODE_API_KEY` の参照のみ。DSH のプロファイル（`~/.dsh/profiles`）は読まない・変えない。資格情報を含みうるので、読み取りは止められる。
- **課題**（`suites/stats-fixture.mjs`、`suites/stats-tasks.mjs`。`--suite stats` で実行）: 小さな統計ライブラリ（`formatTable` にバグを 1 つ仕込み済み）に、1 セッションで次の 4 つを順に指示する。
  1. median / mode の実装とテスト
  2. 落ちているテストの修正（テストファイルは変えない）
  3. CLI（`bin/stats.js`）の追加とテスト
  4. README の更新と報告
- **採点**: 終了後に、エージェントから見えない隠しチェックを 5 つ（4 課題＋`node --test` 全体）実行する。
- **計測**（各ハーネスのセッションログから。`logs.mjs`）:
  - プロンプトトークン（キャッシュ分を含む）、キャッシュに当たらなかったトークン、出力トークン、ヒット率
  - ツール呼び出し回数、リクエスト回数
  - 応答待ちを除いた時間、応答待ち時間（HY は `step/end` の `latencyMs`、古いログは推定。DSH は `step/start` からアシスタントメッセージまで）
  - ターン中の時間、全体時間
  - 本文 JSON の差し戻し回数、存在しないパスの読み取り回数
  - DSH の `inputTokens` はキャッシュ外分だけなので、`cacheReadTokens` と `cacheWriteTokens` を足して揃えている。
- **実行**:
  ```bash
  node bench/harness/run.mjs --suite stats --harness hy,hy-lean2 --runs 10 --parallel 2 --stamp <名前>
  node bench/harness/report.mjs bench/results/<名前> --pair hy-lean2,hy
  ```
  - HY の比較用バリエーションは `run.mjs` の `HY_VARIANTS` にある（`hy` / `hy-full` / `hy-none` / `hy-legacy` / `hy-lean2`）。新しい版を試すときは、設定値を 1 つ変えた行を足す。
  - `report.mjs` は平均・95% 信頼区間（t 分布）と、Welch の差の区間（`*` は 0 を含まない＝有意）を出す。`report.md` を最初のフォルダーに書き出すので、過去の結果フォルダーで実行したら `git checkout` で元に戻す。
  - 作業フォルダーは F:（exFAT）の `F:/hy-bench/harness`。C: のユーザー配下では HY のサンドボックスが起動しないため。
- **注意**:
  - OpenCode の応答速度は大きくばらつく。時間は「応答待ちを除いた時間」で比べる。
  - 同じ版でも回ごとのばらつきが大きいので、必ず信頼区間で判断する。
  - 課題が易しく、成功率は常に 5/5。

## 5. これまでの結果（`bench/results/` に各回の `runs.jsonl` と `report.md`）

| 回 | 比較 | 主な結果 |
|---|---|---|
| `2026-11-07-13b8ecd`＋`smoke1` | HY 対 DSH（各 6 回） | 両方 5/5。ツール呼び出し HY 64 対 DSH 48（有意）。HY は `node --test` がサンドボックスで `spawn EPERM` になり、テストを何度もやり直していた |
| `2026-11-07-6b4a9e6` | HY 対 DSH（各 10 回、EPERM 修正・ベンチ条件統一後） | ツール呼び出しは同等（44 対 45）。HY はプロンプトトークン −34 万、出力 −7,500、リクエスト −6、時間 −1.4 分（いずれも有意）。キャッシュ外トークンは差なし。応答待ちを除いた時間は HY 約 10 秒、DSH 約 16 秒 |
| `2026-11-07-reasoning` | 推論を会話に残す（full）対 残さない（none） | full でツール呼び出し −9、リクエスト −4、出力 −3,100（有意）。プロンプト・キャッシュ外は差なし → **full を既定に**（`reasoningHistory`） |
| `2026-11-07-lean` | lean 対 legacy | どの項目も有意差なし（予想どおり）→ **lean を既定に** |
| `2026-11-07-lean2` | lean2 対 lean（各 10 回） | 両方 5/5。lean2 は**出力トークン +2,852 [+1,202, +4,502]、ツール呼び出し +5 [0, +9]（有意）**。プロンプト、キャッシュ外、リクエスト、時間は有意差なし。増えたのはシェル（10.7→14.1 回、確認の実行が増えたとみられる）と `present`（0.2→1.0 回）、推論（1 リクエスト 625→810 文字）と最終回答（2,274→3,681 文字）。**既定は lean のまま**。どの文が効いたかは、lean2 の変更を 1 つずつ lean に入れて確かめる必要がある（候補: 「中途半端で妥協しない」→確認の増加、「結論を先に分かりやすく要約」→回答の長さ、「断定しない」→推論の長さ） |

ほかに分かったこと:
- **出力トークンが DSH の半分程度な理由**: 1 リクエストあたりの推論が DSH の約半分（628 対 1,256 文字）、リクエストが少ない（25 対 36）、ツールの引数が短い（DSH は `pwsh` に説明文必須でフルパス、`edit` は置換前後の文字列）。推論が短い原因は未確定。旧版の「簡潔な口調」は口調の指定で、長さを減らせとは書いていない。
- **legacy の「推論は日本語で」はほとんど守られていなかった**（推論中の日本語 0.5〜10%）。推論の言語は指定しない方針（英語か中国語で一貫させる）。回答の言語も、DSH に指定がないので指定しない。
- **プロンプトトークンが DSH より少ない理由**: 最初のリクエストが小さい（約 3,200 対 6,400）、1 ステップの増加が小さい（760 対 924、DSH は推論を送り返していた）、リクエストが少ない。

## 6. 関連して入れた変更（プロンプト以外）

- **キャッシュ**:
  - system prompt とツール一覧をセッション中に変えない（日付・ルール・メモ・ゴールは会話の末尾に追記、プランモードはツール一覧を変えず実行時に拒否、`tool_search` は既定で無効）。
  - 変わる部分を system prompt の末尾に寄せる。
  - OpenCode のセッション ID をワークスペース単位にする。
  - 詳細は `docs/implementation_status.md` §2.16。
- **サンドボックス**: 既定ポリシーで、単独の Node テストランナーのコマンド（`node --test`、`npm test` など）を `low-integrity` で動かす（EPERM 対策）。パイプ付きで失敗したときは、shell の結果にヒントを付ける。
- **推論の送り返し**: `reasoningHistory: full`（既定）。DeepSeek には `reasoning_content` で返す。
- **テスト**: `pnpm test:integration` は並列実行で約 100 秒（`scripts/test-integration.mjs`）。

## 6.5 参考にした記事と、そこから入れたもの（2026-11-07）

記事: 「Harness Engineering in Five Popular OSS Projects, Compared by AI Trust」（https://gibberishlab.com/blog/oss-ai-agent-harness-philosophy）。Zed、Sentry、OpenClaw、Bun、PostHog の AGENTS.md・ルール・スキル・フックを比べ、「AI をどこまで信頼するかで、書く量と機械で強制する量が変わる」と論じる。

- **プロンプト調整の方針（PostHog）**: 強制力の強い仕組みを優先し、文章は最後の手段にする。ツールやガードで強制できることは文章にしない（本文 JSON の禁止、読んでから編集、を消せたのはこの考え方）。
- **入れたもの**:
  - **規則の `instead`（Bun）**: 拒否や確認の理由に、代わりのコマンドを付ける（`docs/implementation_status.md` に書き方）。
  - **AGENTS.md の生成指示（Zed / Sentry）**: 地図ではなく、目次と罠を 60 行以内で書かせる（`/init` と GUI のボタン）。
  - **質問に返事がないとき（OpenClaw「沈黙は承認ではない」）**: `ask_user` の結果に「返事なし。承認ではない」と明記する。承認は以前から、5 分で時間切れになると拒否になる。
- **まだのもの（候補）**:
  - サブフォルダーの AGENTS.md を、そのフォルダーを初めて触ったときに会話へ追記する（Sentry）。`hy_session_context` と同じ追記の仕組みに乗せられる。
  - エージェントが自分で書く永続的なメモ（`rationale_upsert`、自動のメモリー抽出）に、Zed の 3 条件（慣れた人でも間違える、2 回以上起きた、行動できるほど具体的）か、人の確認を挟む。

## 7. 残っている候補と注意

- **OpenClaw のやめどき条件（プロンプトかガードで試す）**:
  - 同じ失敗が新しい手がかりなしに 2 回続いたら方針を変える（HY のループ検出に近い）。
  - 一定時間（OpenClaw は 10 分）進展がなければ方針を変える（HY には未実装。ガードとして足せる）。
  - 動作が証明され必要な検査が通ったら、頼まれていない磨き込みをせずに終える（Codex の「テストが通ったら理由なく広げない」と同じ。lean2 で確認の実行が増えた件への対策候補）。

- **次に測る候補**（1 つずつ）:
  - シェル環境の行（「Select-String / Get-Content を使え」とシェルでの読み取り・検索を勧めている。DSH は逆に専用ツールへ誘導）
  - 「作業が残っているなら必ずツールを呼べ」の強さ
  - `update_plan` と `todo_write` の重複
  - 普段使わないツール（`current_time`、`sleep`、`get_context_remaining` など）
  - 並列実行のルール（HY は全部読み取りのときだけ並列）
- **計測の追加候補**:
  - 「最終回答で成功と言ったのに隠しチェックに落ちた」回数（言い過ぎの検出）
  - 難しめの課題（原因が分かりにくいバグ、仕様を読み違えやすい修正、曖昧な依頼）。lean2 で足した文（意図、妥協しない、断定しない）は、これがないと効果が見えない。
- **保留**: `win10-sandbox` のハードリンクのテストが、サンドボックス系テストの後に続けて走るとときどき落ちる（`apply_patch` がハードリンクへの書き込みを拒否しない）。一時ファイル→改名の書き方で名前だけ置き換わり、外のファイルは無事という推測だが未確認。ユーザーの指示で一旦キープ。
- **ビルドと実行の注意**:
  - 変更後は `pnpm build`。Rust を触ったら `cargo build --release -p hy-exec-server`（ベンチは `target/release`）と `cargo build -p hy-exec-server`（結合テストは debug）。
  - スキーマを触ったら `pnpm gen:config-schema`。
  - 実際に送られるリクエストを確かめるには、ローカルの受け口サーバーに `--base-url` で向けて捕まえる（今回は一時スクリプトで行った）。
