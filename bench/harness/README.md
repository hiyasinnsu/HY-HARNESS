# ハーネス比較ベンチマーク（HY-HARNESS 対 DeepSeek Harness）

機能を改善するたびに実行して、同じモデル・同じ課題での実装力とコストを比べるためのベンチマーク。

## 条件

- モデル: OpenCode Go の `deepseek-v4.1-flash`、effort `max`（両方とも）
  - HY: ユーザー設定の `opencode` ロール（effort は `max`）。実行のたびに新しい設定フォルダー（`<workdir>/<stamp>-hy-config`）を作り、ユーザーの `config.json` から MCP（`mcpServers`、`automation`）と追加ルートを除いたものを置いて `HY_CONFIG_DIR` に渡す。RULE.md とスキルはコピーしないので、ユーザーの全体ルールは使わない。DSH 側には MCP も全体ルールもないので、条件をこれで揃える。
  - DSH: `dsh --profile headless --patch bench/harness/dsh.patch.yml`。pi-ai の `opencode-go` ルートを使い、モデルと effort をこの重ね合わせファイルで指定する。API キーは環境変数 `OPENCODE_API_KEY` を参照するだけで、ファイルには書かない。ユーザーのプロファイルは変更しない。
- 課題（`--suite` で選ぶ。既定は `tb2-financial`）:
  - `tb2-financial`（`suites/tb2-financial.mjs`）: [Terminal-Bench 2.0 の financial-document-processor](https://github.com/harbor-framework/terminal-bench-2/tree/main/financial-document-processor)（Apache-2.0）。JPG と PDF の書類 17 枚を OCR で読み、請求書とそれ以外に仕分け、請求書の合計額と税額を `invoices/summary.csv` にまとめる。1 セッションに 1 指示。
    - 課題の中身はリポジトリに入れない。固定したコミット（`2fd12b88aafd`）から書類・指示・公式テストを `<workdir>/../cache` に一度だけ取得して使う。
    - Docker の `/app` の代わりに作業フォルダーを使う。指示の `/app/x` は `x`（作業フォルダーからの相対パス）に、公式テストの `"/app/` は作業フォルダーの絶対パスに置き換える。それ以外の文面は変えない。
    - 書類のファイル名は、課題の Dockerfile と同じく実行ごとにランダムにする。
    - ホストは Ubuntu ではなく Windows。OCR はどちらのハーネスにも入っていないので、エージェントが自分で用意する（課題と同じくネットワークは使える）。
    - 採点: 公式の `test_outputs.py` を `uvx`（Python 3.13、pytest 8.4.1、pandas 2.3.2。`tests/test.sh` と同じ版）でそのまま実行し、テスト関数 7 つをそれぞれ 1 つのチェックとして記録する。全部通れば `reward` が真（ベンチマークの reward.txt と同じ）。
    - 制限時間: 課題の 1,200 秒に、応答の遅いターンの分として半分を足した 1,800 秒。
  - `stats`（`suites/stats.mjs`。以前の既定）: 小さな統計ライブラリ（`formatTable` にバグが 1 つ仕込んである）に、4 つの指示を 1 つのセッションで順番に与える（実装、バグ修正、CLI、README）。隠しチェックは 5 つ。
- 実行: 指示が 1 つなら HY は `hy run --full-auto`（複数行の指示を引数で渡す。DSH と同じ形）、複数なら `hy chat --full-auto`（1 行 1 指示）。DSH は `dsh headless` を指示ごとに起動し、`--session-id` で同じセッションを続ける。
- 計測（各ハーネスのセッションログから）:
  - プロンプトトークン（キャッシュ分を含む）、キャッシュに当たらなかった分、出力トークン、キャッシュヒット率
  - ツール呼び出し回数、モデルへのリクエスト回数
  - ターン中の時間、全体の所要時間
  - DSH の `inputTokens` はキャッシュに当たらなかった分だけなので、`cacheReadTokens` と `cacheWriteTokens` を足してプロンプト全体に直している。
  - サブエージェントの分も含める。

## 実行

```bash
pnpm bench:harness -- --parallel 2                 # tb2-financial
pnpm bench:harness -- --suite stats --parallel 2   # 以前の課題
node bench/harness/report.mjs bench/results/<stamp>
```

- `--suite`: 課題（`tb2-financial` か `stats`）
- `--runs`: ハーネスごとの回数（既定 10。安定性を見るのが目的なので、課題は易しいまま回数で精度を上げる）
- `--parallel`: 同時に走らせる数（2 なら HY と DSH を 1 本ずつ並べ、同じ時間帯の混み具合で比べる）
- `--harness hy` / `--harness dsh`: 片方だけ実行する
- `--workdir`: 作業フォルダー（既定は `F:/hy-bench/harness`）
- `--stamp`: 結果フォルダーの名前

結果は `bench/results/<stamp>/` に出る。

- `runs.jsonl`: 1 回ごとの数値
- `report.md`: 平均と 95% 信頼区間（t 分布）、HY − DSH の差（Welch の区間）、解けた割合（全チェック通過）、隠しチェックごとの成功率
- 生ログ（`*.stdout.jsonl` / `*.stderr.log`）: git には入れない

複数回の結果をまとめて集計するときは、`report.mjs` にフォルダーを複数渡す。

## 注意

- 作業フォルダーは exFAT の F: にある。git は所有者を確認できないため、子プロセスにだけ `safe.directory=*` を渡している。
- C: のユーザープロファイル配下では、HY のサンドボックスが AppContainer の ACE で起動できない。そのため既定の作業フォルダーを F: にしている。
- 同じモデルでも 1 回ごとのばらつきが大きいので、比較は信頼区間で行う。区間が重なる差は「差がある」とは言えない。
