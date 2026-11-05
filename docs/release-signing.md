# リリースの署名と配布（CP-40）

HY-HARNESS の配布物は 2 段階で守ります。

| 層 | 何を守るか | 鍵 | 検証する人 |
| :--- | :--- | :--- | :--- |
| Authenticode（exe のコード署名） | Windows が「誰が作った exe か」を示す。SmartScreen の警告を減らす | コード署名証明書（.pfx） | Windows、ユーザー |
| リリースフィード（Ed25519） | アプリ内更新（`hy update`）が「本物の新版か」を確かめる | Ed25519 秘密鍵（`hy update keygen`） | アプリ自身 |

証明書が無くても、フィード署名と SHA-256 による更新の検証は働きます（未署名の exe は SmartScreen で警告されるだけ）。

## 1. 鍵の用意

```powershell
# Ed25519 鍵ペア（初回のみ）。公開鍵はアプリに同梱・設定し、秘密鍵は厳重に保管する
node packages/hy-cli/dist/main.js update keygen --out .\release-keys
```

- 秘密鍵（PEM）は GitHub の Secret `HY_RELEASE_KEY` に登録します。リポジトリやディスクに残しません。
- Authenticode 証明書がある場合は、.pfx を base64 化して `CSC_LINK`、パスワードを `CSC_KEY_PASSWORD` に登録します。

## 2. リリース（GitHub Actions）

`v*` タグを push すると `.github/workflows/release.yml` が次を行います。

1. `cargo build --release` と `pnpm verify`（全ゲート）。
2. `pnpm desktop:package` で portable exe を作る。`CSC_LINK` があれば electron-builder が SHA-256 + RFC 3161 タイムスタンプで署名します（`electron-builder.yml` の `signtoolOptions`）。
3. 署名があれば `Get-AuthenticodeSignature` が `Valid` であることを確認します（失敗ならリリースを止める）。
4. `HY_RELEASE_KEY` があれば `hy update sign` でフィードのエントリ（`feed-entry.json`）を作ります。
5. `scripts/gen-package-manifests.mjs` で winget と Scoop のマニフェストを作ります。
6. exe・フィードエントリ・マニフェストをリリースに添付します。

## 3. 利用者側の検証手順

```powershell
# (a) コード署名（証明書付きのリリース）
Get-AuthenticodeSignature .\HY-HARNESS.exe | Format-List Status, SignerCertificate, TimeStamperCertificate

# (b) ハッシュ（フィードエントリ・winget/Scoop マニフェストの値と一致すること）
(Get-FileHash -Algorithm SHA256 .\HY-HARNESS.exe).Hash.ToLower()

# (c) フィード署名（アプリが自動で行う。手動確認は公開鍵を指定して）
node packages/hy-cli/dist/main.js update check --feed <feed.json の URL かパス>
```

`hy update check|fetch` は Ed25519 署名の無いエントリ、署名不一致、SHA-256 不一致、サイズ超過を拒否します（`packages/hy-cli/src/update-feed.ts`、統合テスト `onboarding.test.mjs` の「the release feed is checked on demand and a bad signature is refused」と単体テスト `update-feed.test.ts`）。

## 4. 更新とロールバック

アプリ内更新は `packages/desktop/update.mjs`（と PowerShell 版 `update.ps1`）が行います。

1. 実行中の exe をタイムスタンプ付きのバックアップ（`HY-HARNESS.exe.bak-<時刻>.exe`）に移す。
2. 新しい exe を所定の名前にコピーし、**期待する SHA-256 と照合**する。
3. コピー失敗・ハッシュ不一致のときは**バックアップを書き戻して旧版に戻る**。ログは `update.log`。

この挙動は `tests/integration/update-script.test.mjs`（4 件：Node 版と PowerShell 版の入れ替え・バックアップ、SHA-256 不一致でのロールバック）で検証しています。

## 5. パッケージマネージャ

```powershell
node scripts/gen-package-manifests.mjs --version 0.5.0 `
  --url https://github.com/hiyasinnsu/HY-HARNESS/releases/download/v0.5.0/HY-HARNESS.exe `
  --file release\HY-HARNESS.exe
```

`release/manifests/<version>/` に次ができます。

- `winget/`：`HYHarness.HYHarness.yaml`・`.installer.yaml`（`InstallerType: portable`）・`.locale.en-US.yaml`。`winget validate` の後、`microsoft/winget-pkgs` に PR を出します。
- `scoop/hy-harness.json`：自前の bucket に置きます（`checkver` と `autoupdate` 付き）。

## 6. この環境で確認できていないこと

- 実際の証明書による署名と SmartScreen の評価（証明書が無いため）。設定とワークフローの手順までを用意しています。
- winget-pkgs への提出と `winget validate`（winget CLI が無いため）。マニフェストの形はユニットテスト（`package-manifests.test.ts`）で確認しています。
