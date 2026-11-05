# Migration guide / 移行ガイド

What changed for an existing HY-HARNESS workspace, oldest first. Nothing here
rewrites your files; the actions are opt-in.

## Codex adoption, C0–C5 (2026-11) / Codex 採用（C0〜C5）

Codex 採用計画で既定や操作が変わった点と、他のツールからの移り方です。

### 1. サンドボックスの既定が `workspace-write` に（CP-01）

| 以前 | 今 |
| :--- | :--- |
| 既定は `unconfined`（制限なし） | 既定は **`workspace-write`**：ワークスペースの外には書けない。読み取りは `denyRead` 以外は従来どおり |

- 従来の動作に戻すには、1 回だけなら `--unsafe-unconfined`、恒久的には設定の `"sandbox": { "legacyUnconfined": true }` を使います。
- 秘密のフォルダを読ませないなら `"sandbox": { "denyRead": ["~/.ssh", "~/.aws"] }`。Low 整合性の閉じ込めトークンに対して Medium の NO_READ_UP ラベルで拒否します。ユーザー自身は読めます。
- 書かせたくないサブフォルダは `"sandbox": { "readOnly": ["vendor"] }`。
- 権限の組み合わせは `permissions` / `defaultPermissions` の名前付きプロファイルにまとめられます（`extends` 可）。
- ワークスペースが `%TEMP%` の下にあると、環境によっては閉じ込めが使えません（`%LOCALAPPDATA%` に AppContainer の ACE があるため。ADR 0001 §5.2）。`hy doctor` が `sandbox` の行で知らせます。

### 2. 承認

- 承認ポリシーは `untrusted`（既定）/`on-request`/`on-failure`/`never` です。
- GUI の承認カードは cwd・影響するパス・接続先の可能性を表示します。「今回だけ」「このセッション中」「常に」を選べます。「常に」はユーザーの `policy.star` に `prefix_rule` を追記しますが、`unconfined` と `low-integrity` のコマンドでは選べません。キーボードでは Y / S / A / N、どこからでも Alt+Y / S / A / N です。
- 拒否理由はエージェントに届きます。

### 3. Claude Code・DSH から取り込む（CP-31）

```powershell
hy import claude            # 計画と差分を表示（何も書かない）
hy import claude --yes      # 書き込む
hy import claude --only agents,mcp --yes
hy import dsh --yes         # このワークスペースの DSH セッションをスレッドとして取り込む
```

GUI では `/import`（またはパレットの「Import from Claude Code / DSH」）から、チェックした種類だけを取り込めます。

| 取り込み元 | 取り込み先 |
| :--- | :--- |
| `CLAUDE.md`（プロジェクト・`~/.claude`） | `AGENTS.md`（無ければ作成、あれば印付きの節を 1 回だけ追記） |
| `.mcp.json`、`~/.claude.json` の `mcpServers` | 設定の `mcpServers`（既存の名前は上書きしない。`env` はそのままコピー） |
| `.claude/settings*.json` の hooks | HY のフック（イベント名・ツール名を対応表で変換。対応の無いものは報告） |
| `.claude/skills/<名前>/` | HY の skills |
| `.claude/commands/*.md` | `prompts/*.md`（`$ARGUMENTS` は共通） |
| `~/.claude/projects/<ws>/memory/*.md` | ワークスペースメモリ（上限に達したら失敗として報告） |
| `~/.dsh/sessions/…/session.v4.jsonl.zstd` | このワークスペースのスレッド（ユーザー・アシスタント・ツールの往復、元の時刻） |

資格情報（DSH の `.credentials.yaml`、Claude のログイン情報）は読みません。取り込みは冪等で、2 回目は全部 `skip` になります。

### 4. CLI・GUI の新しい操作

- コマンドは GUI と CLI で揃えました（`/help` が一覧）。`/usage /mcp /plugins /memories /hooks /doctor /config /rename /fork /archive /resume /rewind /find /raw /worktree /import` など。
- Ctrl+K のパレットはコマンド・チャット・ファイル・設定を検索します。入力欄の `/` で補完、`@` でファイル・チャット・スキル（`@skill:名前`）を参照できます。
- Esc Esc で任意のターンまで巻き戻せます（ファイルも会話も）。
- ステータスライン・コードの配色・Vim モード・ショートカットは `ui-state.json` に保存され、再起動後も残ります。

### 5. プロトコル・SDK

旧 `hy serve --sdk`（WP-51 の `session.*` メソッド）は残していますが、新しいクライアントは hy-protocol/1 を使ってください（[protocol.md](protocol.md)）。違いは次のとおりです。

| 旧（`hy serve --sdk`） | 新（hy-protocol/1） |
| :--- | :--- |
| `session.create` / `session.prompt` | `turn/start`（`threadId` で継続） |
| `session/event` 通知 | `turn/event`（`threadId`・`tag` 付き） |
| stdio のみ | stdio・名前付きパイプ（デーモン）・WebSocket |
| `HarnessClient`（TS）/`Client`（Python） | `ProtocolClient` / `connectDaemon`（TS）、`ProtocolClient`（Python） |

### 6. 配布

- 署名と検証の手順は [release-signing.md](release-signing.md) を参照してください。winget/Scoop のマニフェストはリリースごとに生成します。
- Node を入れずに CLI だけを使う場合の単一 exe（Node SEA）は任意の配布物です（[ADR 0003](adr/0003-single-binary.md)）。

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
