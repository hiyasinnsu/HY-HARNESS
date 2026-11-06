# Troubleshooting / トラブルシュート

Symptoms first, then the check that names the cause. Every command assumes the
repository root (`F:\HY-HARNESS` here) and Node 24.

## The app does not start

**`hy-exec-server.exe` is missing or stale.** `pnpm build` does not build Rust.

```powershell
cargo build -p hy-exec-server
```

**Port already in use.** `hy web` answers with `EADDRINUSE`. Use `--port 0` to
pick a free port, or stop the other server.

**The desktop exe does nothing.** The portable build needs the Electron binary:

```powershell
pnpm desktop:install
pnpm desktop
```

## The model never answers

**No provider reachable.** `hy models discover` asks the configured provider for
its list; a failure prints the reason. For Ollama:

```powershell
curl http://127.0.0.1:11434/api/tags
```

**Missing key.** The error names the variable (`missing API key: set
OPENAI_API_KEY`). Settings → Models → Advanced lets a role carry a direct key
(stored in `%APPDATA%\hy-harness\config.json`) or an environment variable name.

**Reasoning eats the answer.** A reasoning model can spend the whole
`maxOutputTokens` before the tool call. Lower `effort` for that role, or use a
model preset that keeps a larger output budget.

## A turn does nothing / the GUI looks stuck

- **Goal rounds wait for an explicit resume after a restart.** `/goal resume`.
- **A paused turn queue** asks for *Resume* in the badge above the composer; it
  pauses after a failure or an unknown outcome instead of retrying.
- **A worker chat is read-only** by design: the orchestrator sends the work and
  reviews the report.
- **Plan mode** blocks tools that write. Toggle `/plan` or the plan chip.

## The sandbox refuses to start

`--sandbox workspace-write` needs an ACL grant on the workspace. The first
confined session grants it (about 4 s per 100k files). If a parent directory
carries AppContainer package ACEs (`%USERPROFILE%\AppData` is one), the harness
refuses and names the directory — move the workspace.

On a volume without ACL support (exFAT/FAT32) `workspace-write` runs volume-wide,
which the startup banner reports. `hy sandbox status` shows the grant, `hy
sandbox revoke` removes every ACL change.

## `/api/...` answers 401 or 403

The web server exchanges the launch token (`?token=…`) for an HttpOnly cookie.
A bare URL without the token is 401; a request from another host is 403 unless
`--trusted-host` names it. `--public-url` only changes the advertised URL.

## Updates

- **`hy update check` says "no release feed configured"** — pass `--feed`, set
  `HY_UPDATE_FEED`, or add `update.feed` to `config.json`.
- **`signature verification failed`** — the feed is not signed by the configured
  key, or the entry was edited. Re-sign with `hy update sign`.
- **"the staged build is identical to the running one"** — run
  `pnpm release:local` to stage a new build. **"the staged build is older … it was not applied"** means the staged version is lower than the running one (downgrades are refused); bump the version or delete the old staged exe.
- **The swap failed** — read
  `C:\Users\Public\hy-harness-update\update.log`: `progress n/6` shows the last
  step, and `rollback:` explains a restored backup (exit code 5 is a checksum
  mismatch).

## A document will not preview

PDFs and images are served as they are; Office files need LibreOffice
(`soffice`). Without it the API answers 415 `no office converter`. Point
`HY_SOFFICE` at `soffice.exe` if it is installed somewhere unusual.

## Nothing is traced

Telemetry is off unless asked for. Set `telemetry.enabled: true` and a **local**
endpoint (`http://127.0.0.1:4318` by default), or `HY_OTEL_ENDPOINT`. A remote
endpoint is refused unless `allowRemote: true` is set. Spans carry identifiers
and timings only — no prompts or tool output.

## Tests fail on a stale build

`pnpm test:integration` refuses to run when `packages/*/dist` is older than the
sources:

```powershell
pnpm build
```

The Rust daemon has the same rule — rebuild it after changing `crates/**`.

---

# トラブルシュート（日本語）

## 起動しない

- **`hy-exec-server.exe` が無い/古い**: `pnpm build` は Rust をビルドしません。
  `cargo build -p hy-exec-server` を実行してください。
- **ポートが使用中**: `--port 0` で空きポートを選ぶか、他のサーバーを止めます。
- **デスクトップ exe が何もしない**: `pnpm desktop:install`（Electron の取得）→
  `pnpm desktop`。

## モデルが答えない

- `hy models discover` でプロバイダの一覧を確認（失敗理由が出ます）。Ollama は
  `curl http://127.0.0.1:11434/api/tags`。
- `missing API key: set …` は環境変数名を教えてくれます。設定 → モデル → 詳細で
  直接キーか環境変数名を指定できます。
- 推論で出力枠を使い切る場合は、そのロールの `effort` を下げるか、出力上限の
  大きいプリセットを選びます。

## ターンが進まない

- 再起動後のゴールは**解除された状態**です。`/goal resume` で再開します。
- 一時停止したターンキューは、入力欄上のバッジから再開します（失敗や結果不明の
  ときに自動再試行しないため）。
- ワーカーのチャットは仕様上読み取り専用です（指示とレビューはオーケストレーター）。
- プランモードでは書き込み系ツールが止まります。`/plan` かチップで解除します。

## サンドボックスが起動しない

`--sandbox workspace-write` は初回に ACL を付与します（10 万ファイルで約 4 秒）。
`%USERPROFILE%\AppData` のような AppContainer の ACE を持つディレクトリの下では
起動を拒否して名前を表示します。ワークスペースを移してください。

ACL のないボリューム（exFAT/FAT32）ではボリューム全体が書き込み可能になり、
起動時に表示されます。`hy sandbox status` で状態、`hy sandbox revoke` で ACL を
すべて削除できます。

## 401 / 403

起動トークン（`?token=…`）を HttpOnly Cookie に交換して認証します。トークンの無い
URL は 401、別ホストからのリクエストは 403 です（`--trusted-host` で許可）。

## 更新

- `no release feed configured`: `--feed`、`HY_UPDATE_FEED`、`update.feed` のいずれか。
- `signature verification failed`: 鍵が違うか、エントリが編集されています。
- `the staged build is identical…`: `pnpm release:local` で新しいビルドを作ります。`the staged build is older…` は置いてあるビルドの版が動いている版より古いという意味で、ダウングレードは拒否されます（版を上げるか、古いビルドを消します）。
- 差し替え失敗: `C:\Users\Public\hy-harness-update\update.log` を見ます。
  `progress n/6` が最後の段階、`rollback:` が復元の理由（終了コード 5 は
  ハッシュ不一致）。

## 文書がプレビューできない

PDF と画像はそのまま、Office は LibreOffice（`soffice`）が必要です。無い場合は
415 `no office converter` を返します。通常と違う場所にある場合は `HY_SOFFICE` で
パスを指定してください。

## トレースが出ない

既定は無効です。`telemetry.enabled: true` と**ローカル**のエンドポイント
（既定 `http://127.0.0.1:4318`）か `HY_OTEL_ENDPOINT` を設定します。別ホストは
`allowRemote: true` を明示しない限り拒否されます。内容（プロンプトやツール出力）は
送りません。

## テストが「ビルドが古い」で止まる

`pnpm test:integration` は `packages/*/dist` がソースより古いと実行を拒否します。
`pnpm build` を実行してください。`crates/**` を変えたら Rust デーモンも再ビルドします。
