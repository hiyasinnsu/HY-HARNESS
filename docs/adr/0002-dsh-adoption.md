# ADR 0002: DSH 差分導入（選択的移植）

- **Status**: Accepted
- **Date**: 2026-11-04
- **Related**: [dsh-gap-analysis.md](../dsh-gap-analysis.md), [dsh-adoption-plan.md](../dsh-adoption-plan.md)

## Context

HY-HARNESS は Codex/DSH の機能を Windows 10 向けに実装し、Windows サンドボックス、ターン単位チェックポイント、検証ゲート付き Ralph、Guardian、オーケストレーション A+、MCP サーバ、LSP、永続 PTY などで DSH を上回る部分を持つ。一方、DSH 0.2.1-rc.3（307 パッケージ）との比較で **111 項目中 106 項目が不足または劣位**（A 21 / B 40 / C 45）と判明した。特に拡張基盤、実行中ステアリング、継続可能サブエージェント、プロバイダ基盤、セッション形式の進化、配備（TLS/アクセス制御）、SDK/ACP が構造的に不足している。

## Decision

1. **HY の中核実装は置き換えない。** K1〜K14（サンドボックス、チェックポイント/undo、Ralph、Guardian、オーケストレーション、ターンキュー、MCP サーバ、LSP、メモリ、PTC、PTY、portable exe、Tailscale、i18n）は変更対象外とし、回帰テストで固定する（`tests/regression/golden.test.mjs`）。
2. **DSH からは設計・データ形式・UX・テスト観点のみを移植する。** `@deepseek-ai/*` パッケージは Cordis 依存のため vendoring しない。MIT のため文言・スキーマのコピーは可能だが、その場合は `THIRD_PARTY_NOTICES.md` に出所を記す。
3. **プラグインマーケット、Creator、クライアントプラグイン、マルチユーザー RBAC／ライブ共有は作らない**（2026-11-03 の承認済み対象外）。代わりに、プロファイル/バンドル合成、設定スキーマ、API 契約という軽量な土台を作る。
4. **サンドボックスの既定値は変えない**（2026-11-02 の判断）。セッション単位の切替と、GUI 初回の「Confined（推奨）」提示を追加する。既定を `workspace-write` に変える場合は別 ADR とする。
5. **新設するゲート**: `pnpm test:regression`、`pnpm check:config-schema`、`pnpm check:api`（WP-43）。既存の `check:protocol` / `test:integration` / `desktop:screenshot` は維持する。

## Consequences

- 実装は 6 マイルストーン・24 作業パッケージ・約 203 人日。M1 完了で v0.2.0、M3 で v0.3.0、M6 で v0.4.0。
- セッションログは v2 へ読み取り時移行を導入する。書き込みは常に現行版。
- 永続シェルは confined で stdin が使えない場合 one-shot にフォールバックし、`gap:` として報告する（権限を広げない）。
- 文書変換は LibreOffice を同梱せず、検出時のみ有効化する。
- スコープ膨張を防ぐため、A 級 21 件のうち不採用 5 件（P2/P3/P4/P5/D3）と保留 1 件（E4 workflow）を明示する。

## Alternatives considered

- **Cordis へ全面移行**: DSH の思想は得られるが、HY の型安全なビルド時構成と Windows 実装を作り直すことになり、K1〜K14 を失うリスクが高い。却下。
- **DSH パッケージを vendoring**: Cordis ランタイムと多数の依存を抱え、配布サイズ・起動時間・監査性が悪化する。却下。
- **現状維持**: 拡張性・協調・配備の不足が残り、DSH との差が広がる。却下。
