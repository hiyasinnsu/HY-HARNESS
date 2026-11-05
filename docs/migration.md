# Migration guide / 移行ガイド

What changed for an existing HY-HARNESS workspace, oldest first. Nothing here
rewrites your files; the actions are opt-in.

## From 0.2.0 to 0.4.0 (the DSH-adoption milestones)

Nothing is required; every new surface is opt-in or additive.

**New files in the state directory** (`%LOCALAPPDATA%\hy-harness\state\<id>`):

| File | Written by | Safe to delete? |
| :-- | :-- | :-- |
| `onboarding.json` | the first-run wizard | yes; the wizard reappears |
| `feedback.jsonl` | ✓/✗ ratings | yes; only the ratings are lost |
| `ui-state.json` | pins, archives, names | losing it forgets names and pins |
| `index.sqlite` | `hy index` / `session_query` | yes; `hy index rebuild` recreates it |

**New optional config keys**: `update` (feed + public key), `telemetry`
(enabled + endpoint), `bundles`, `sessionQuery`, `persistentShell`. All default
to off/empty, and `hy config dump` shows the resolved values.

**New endpoints**: `/api/sessions/:id/{stats,fork,feedback,document}`,
`/api/onboarding`, `/api/update`, `/api/references`, `/api/open-in`,
`/api/search`, `/api/models`. The contract is generated, so `pnpm check:api`
names any drift.

**Behaviour changes to know about**:

- The version is now `0.4.0`; `bootstrap.version` and `hy update` compare
  against it.
- A generated chat name is a fallback: a manual name still wins.
- `@session:<id>` in a message injects a bounded context block; the transcript
  shows only your words.
- Optional telemetry never includes message content.

**0.2.0 → 0.4.0（DSH 導入マイルストーン）**: 必須の作業はありません。新しい機能は
すべて任意か追加のみです。状態ディレクトリに `onboarding.json`・`feedback.jsonl`・
`index.sqlite` が増えます（消しても再生成できます）。新しい任意設定は `update`・
`telemetry`・`bundles`・`sessionQuery`・`persistentShell` で、既定は無効または空です。
新しいエンドポイントは `stats`/`fork`/`feedback`/`document`/`onboarding`/`update`/
`references`/`open-in`/`search`/`models` で、契約は生成物なので `pnpm check:api` が
ズレを検出します。版は `0.4.0` になりました。

## From 0.1.x to 0.2.0

**Session logs are format v2.** A log now starts with a `session/format` event.
Old logs are read in memory and migrated on read (`migrateSessionEvents`); a new
log always writes the header. No action is needed, and the old file is never
rewritten.

**Profiles and bundles.** A user config may name typed bundles
(`bundles: ["ptc"]`) or a `--profile`. Bundles can only narrow the tool set; a
profile is an overlay of the same config file. Existing configs keep working
unchanged (`bundles` is empty by default).

**API contract.** Every route is declared in
`packages/hy-cli/src/api-contract.ts`; `web/src/api.gen.ts` is generated from it.
A client that hard-codes a route still works, but `pnpm check:api` is the
supported way to notice drift.

**New commands:** `hy index status|rebuild`, `hy models list|discover`,
`hy acp`, `hy serve --sdk`, `hy update check|fetch|keygen|sign`.

**New optional config sections:**

```json
{
  "update": { "feed": "https://…/stable.json", "publicKey": "-----BEGIN PUBLIC KEY-----…" },
  "telemetry": { "enabled": false }
}
```

Both default to "off": no feed is read and no span is sent unless you say so.

## Adopting the update feed

1. Generate a key on the release machine: `hy update keygen --out <dir>`.
   Keep `update-key.pem` offline; publish `update-public.pem`.
2. For each build, sign an entry:

   ```powershell
   hy update sign --key update-key.pem --version 0.3.0 `
     --url https://example/HY-HARNESS.exe `
     --sha256 <hex of the exe> --notes "what changed"
   ```

   The local file name is fixed (`release/HY-HARNESS.exe`); the feed carries the
   release `version`, so the URL may name the file however the server serves it.

3. Publish a feed with those entries (`{ "schema": 1, "releases": [ … ] }`) over
   HTTPS, and add its URL and public key to `update` in your `config.json`.
4. Check with `hy update check`; install with `hy update fetch`, then use
   **Apply update** in the desktop app. The swap verifies the SHA-256 again and
   rolls back on a mismatch.

## First-run wizard

A fresh state directory opens the three-step wizard (workspace, sandbox, model)
and saves the answers in `<stateDir>/onboarding.json`. Existing installations
show it once after upgrading only if that file is missing; clicking **Skip for
now** records the skip and changes nothing. Command-line flags (`--sandbox`,
`--model`, `--provider`, `--mock`) always win over the saved values.

## Feedback and appearance data

Feedback is a new file: `<stateDir>/feedback.jsonl`, one JSON object per rating.
Appearance (theme, fonts, shortcuts, key masking) and the `@` reference
preferences live in the browser's `localStorage`; they are per device and never
written to the workspace. Deleting them loses nothing else.

## Workspaces from the DSH prototype

DSH's session store is not read by HY-HARNESS. Use `hy import`-free migration:
run the workspace once, and the harness builds its own state directory
(`%LOCALAPPDATA%\hy-harness\state\<id>`). `AGENTS.md`, `.hy-harness/` policy and
the user config are the portable parts; copy those, not the state directory.

---

# 移行ガイド（日本語）

## 0.1.x から 0.2.0 へ

- **セッションログは形式 v2**。先頭に `session/format` が入ります。古いログは
  読み取り時にメモリ上で移行され、ファイルは書き換えません。作業は不要です。
- **プロファイルとバンドル**: `bundles: ["ptc"]` や `--profile` を使えます。
  バンドルはツールを**絞るだけ**で、既存の設定はそのまま動きます（既定は空）。
- **API 契約**: ルートは `api-contract.ts` が唯一の正で、`web/src/api.gen.ts` は
  生成物です。`pnpm check:api` でズレを検出できます。
- **新しいコマンド**: `hy index`、`hy models`、`hy acp`、`hy serve --sdk`、
  `hy update`。
- **新しい設定（任意）**: `update`（フィードと公開鍵）と `telemetry`
  （既定は無効）。どちらも明示するまで何も起きません。

## 更新フィードの導入

1. リリース機で `hy update keygen --out <dir>`。`update-key.pem` はオフライン保管、
   `update-public.pem` を公開します。
2. ビルドごとに `hy update sign --key update-key.pem --version … --url … --sha256 …`
   でエントリを作ります。
3. `{ "schema": 1, "releases": [ … ] }` を HTTPS で公開し、`config.json` の
   `update.feed` と `update.publicKey` に設定します。
4. `hy update check` で確認、`hy update fetch` で取得、デスクトップの
   「更新を適用」で差し替え。SHA-256 を再検証し、不一致ならロールバックします。

## 初回ウィザード

新しい状態ディレクトリでは 3 ステップ（ワークスペース → サンドボックス → モデル）が
開き、`<stateDir>/onboarding.json` に保存されます。既存環境ではこのファイルが
無いときだけ表示され、「あとで設定する」を押すとスキップとして記録され、設定は
変わりません。`--sandbox` / `--model` / `--provider` / `--mock` は常に優先です。

## フィードバックと外観

評価は `<stateDir>/feedback.jsonl`（1 行 1 評価）に保存されます。外観（テーマ・
フォント・ショートカット・キーのマスク）はブラウザの `localStorage` に保存され、
端末ごとです。ワークスペースには書きません。削除しても他に影響はありません。

## DSH プロトタイプからの移行

DSH のセッションストアは読みません。ワークスペースで一度実行すると、ハーネスが
独自の状態ディレクトリ（`%LOCALAPPDATA%\hy-harness\state\<id>`）を作ります。
持ち運べるのは `AGENTS.md`、`.hy-harness/` のポリシー、ユーザー設定です。
状態ディレクトリはコピーしないでください。
