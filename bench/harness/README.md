# ハーネス比較ベンチマーク（HY-HARNESS 対 DeepSeek Harness）

機能を改善するたびに実行して、同じモデル・同じ課題での実装力とコストを比べるためのベンチマーク。

## 条件

- モデル: OpenCode Go の `deepseek-v4.1-flash`、effort `max`（両方とも）
  - HY: ユーザー設定の `opencode` ロール（effort は `max`）。
  - DSH: `dsh --profile headless --patch bench/harness/dsh.patch.yml`。pi-ai の `opencode-go` ルートを使い、モデルと effort をこの重ね合わせファイルで指定する。API キーは環境変数 `OPENCODE_API_KEY` を参照するだけで、ファイルには書かない。ユーザーのプロファイルは変更しない。
- 課題: `fixture.mjs` が作る小さな統計ライブラリ（`formatTable` にバグが 1 つ仕込んである）に対して、`tasks.mjs` の 4 つの指示を 1 つのセッションで順番に与える。
  1. `median` / `mode` の実装とテスト
  2. 落ちているテストの原因を直す（テストファイルは変えない）
  3. CLI（`bin/stats.js`）の追加とテスト
  4. README の更新と報告
- 採点: セッション終了後に、エージェントからは見えない隠しチェックを 5 つ実行する（各課題 ＋ `node --test` 全体）。
- 実行: HY は `hy chat --full-auto`（1 プロセスで 4 ターン）。DSH は `dsh headless` を課題ごとに起動し、`--session-id` で同じセッションを続ける。
- 計測（各ハーネスのセッションログから）:
  - プロンプトトークン（キャッシュ分を含む）、キャッシュに当たらなかった分、出力トークン、キャッシュヒット率
  - ツール呼び出し回数、モデルへのリクエスト回数
  - ターン中の時間、全体の所要時間
  - DSH の `inputTokens` はキャッシュに当たらなかった分だけなので、`cacheReadTokens` と `cacheWriteTokens` を足してプロンプト全体に直している。
  - サブエージェントの分も含める。

## 実行

```bash
pnpm bench:harness -- --parallel 2
node bench/harness/report.mjs bench/results/<stamp>
```

- `--runs`: ハーネスごとの回数（既定 10。安定性を見るのが目的なので、課題は易しいまま回数で精度を上げる）
- `--parallel`: 同時に走らせる数（2 なら HY と DSH を 1 本ずつ並べ、同じ時間帯の混み具合で比べる）
- `--harness hy` / `--harness dsh`: 片方だけ実行する
- `--workdir`: 作業フォルダー（既定は `F:/hy-bench/harness`）
- `--stamp`: 結果フォルダーの名前

結果は `bench/results/<stamp>/` に出る。

- `runs.jsonl`: 1 回ごとの数値
- `report.md`: 平均と 95% 信頼区間（t 分布）、HY − DSH の差（Welch の区間）、隠しチェックの成功率
- 生ログ（`*.stdout.jsonl` / `*.stderr.log`）: git には入れない

複数回の結果をまとめて集計するときは、`report.mjs` にフォルダーを複数渡す。

## 注意

- 作業フォルダーは exFAT の F: にある。git は所有者を確認できないため、子プロセスにだけ `safe.directory=*` を渡している。
- C: のユーザープロファイル配下では、HY のサンドボックスが AppContainer の ACE で起動できない。そのため既定の作業フォルダーを F: にしている。
- 同じモデルでも 1 回ごとのばらつきが大きいので、比較は信頼区間で行う。区間が重なる差は「差がある」とは言えない。
