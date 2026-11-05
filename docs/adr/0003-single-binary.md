# ADR 0003: 単一バイナリ配布（CP-41）

- 状態: 決定（2026-11-06）
- 関連: `docs/codex-adoption-plan.md` CP-41、`scripts/sea/`

## 背景

CLI 単体の配布には Node.js の導入が必要で、デスクトップ版は Electron の portable exe です。計画では次の 2 案を試作・比較し、判断することにしていました。

- (a) 制御プレーンを Node SEA（Single Executable Application）で包む。
- (b) 重要部分を Rust に移す。

目標の候補は「起動 100 ms 以内、配布 60 MB 以下」でした。

## 試作

`scripts/sea/` に (a) の試作を置きました。

- `launcher.cjs`: SEA の入口。埋め込みアセット `app.bin`（`packages/*/dist`、実行時依存の `node_modules`、`hy-exec-server.exe`）を初回だけ `%LOCALAPPDATA%\hy-harness\sea\<hash>\` に展開し、`main.js` を読み込みます。
- `build-sea.mjs`: アセットを作り、`node --experimental-sea-config` と `postject` で `release/sea/hy.exe` を作ります。
- `bench-sea.mjs`: SEA と `node main.js` の起動時間を比べます。

試作は動作します。`hy.exe version` と `hy.exe run "SAY …" --mock` が、Node を別に入れていない状態と同じ形で完了しました。

## 計測（Windows 10、Node 24.19、release ビルドの exec server、中央値）

| 項目 | SEA `hy.exe` | `node main.js` | Electron portable |
| :--- | --: | --: | --: |
| 配布サイズ | 101.3 MB（うち Node 本体 88.5 MB、アセット 12.7 MB） | Node の導入が別途必要 | 182.7 MB |
| `version`（暖機後） | 約 173 ms | 約 170 ms | — |
| 初回起動（展開を含む） | 約 0.4〜1.0 s | — | — |
| `run --mock`（1 ターン） | 430〜690 ms | 約 440 ms | — |

## 判断

1. **目標（60 MB・100 ms）は SEA では達成できない。** Node 本体だけで 88.5 MB あり、起動時間は Node のモジュール読み込みが支配的で、`node main.js` と同等です。
2. **(b) Rust への移植も採らない。** 60 MB・100 ms を満たすには制御プレーン（エージェントループ、プロバイダ、GUI サーバー）全体の書き直しが必要で、効果に対して工数（計画の 20 日を大きく超える）が見合いません。exec server とサンドボックスは既に Rust です。
3. **SEA は「Node なしで CLI を使いたい人向けの任意の配布物」として残す。** デスクトップ版より 81 MB 小さく、Node の導入が不要です。リリースの既定（Electron portable）は変えません。`node-pty` を使う GUI の端末機能は SEA の CLI では使いません。
4. 計測は `node scripts/sea/bench-sea.mjs` で再現できます。Node の更新時に再計測し、目標が現実的になったら見直します。

## 影響

- 配布物の既定・更新手順（`docs/release-signing.md`）は変わりません。
- `scripts/sea/` は CI の必須ゲートに入れません（`postject` の注入で Node 本体の署名が無効になるため、配布する場合は再署名が必要）。
