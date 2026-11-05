# Startup / one-turn benchmark baseline

WP-01 of [dsh-adoption-plan.md](dsh-adoption-plan.md). Run `pnpm bench:startup` before and after an
adoption work package; the gate is **±10%** on `webStartupMs` and `mockRunMs`.

## How it is measured

- `scripts/bench-startup.mjs`, 3 runs, median, fresh fixture per run (git repo with one README).
- `webStartupMs`: spawn `hy web --mock --port 0 --no-open` and stop when the URL line appears.
- `mockRunMs`: spawn `hy run "Create BENCH.md" --mock --yes` to completion.
- `toolSchemaChars`: JSON size of the 14 wire tool specs (a proxy for the prompt tool section).
- Provider: local mock (no network). Node version is recorded in the output.

## 2026-11-04 — v0.1.1 (before adoption work)

| Metric | Median | Samples |
| :--- | --: | :--- |
| web startup | **204 ms** | 204, 202, 207 |
| one mock turn | **515 ms** | 523, 484, 515 |
| wire tool schema | 7,137 chars | 14 tools |

Environment: Windows 10 22H2, Node v24.19.0, F: (exFAT), Defender on.

## 2026-11-05 — after WP-22 (`delegate { background }`)

| Metric | Median | Samples |
| :--- | --: | :--- |
| web startup | **278 ms** | 422, 278, 277 |
| one mock turn | **824 ms** | 824, 606, 869 |
| wire tool schema | 7,131 chars | 14 tools |
| tool + SDK prompt | **1,169–1,172 tokens** | measured with Ollama `qwen2.5:3b` |

The tool schema shrank slightly (descriptions were tightened to keep the PTC prompt under the
1,200-token budget after `delegate` gained `background`); `wireTools` is still 14, so K9 holds.
The startup and mock-turn samples were taken while the machine was running the full test suites,
so treat them as an upper bound until a quiet re-measure.

## 2026-11-05 — after WP-31 (`shell { persistent }`)

| Metric | Median | Samples |
| :--- | --: | :--- |
| web startup | **227 ms** | 227, 215, 233 |
| one mock turn | **543 ms** | 529, 565, 543 |
| wire tool schema | 7,187 chars | 14 tools |
| tool + SDK prompt | **1,183–1,185 tokens** | measured with Ollama `qwen2.5:3b` |

`shell` gained `persistent` and an optional `gap` in its result, so the schema grew by ~56 chars;
`wireTools` is still 14 and the PTC prompt stays under the 1,200-token budget (K9).

## Re-baselining

Re-record this table only when a change intentionally moves the numbers (for example a new
tool in the wire set). Otherwise treat a ±10% move as a regression and fix it before merging.
