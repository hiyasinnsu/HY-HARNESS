# Stage 8: Intermediate Zoom Out Review Report (`intermediate_zoom_out_report.md`)

* **Target Document:** [design_draft.md](file:///g:/マイドライブ/HY-HARNESS/design_draft.md) (Lines 1..325)
* **Standard:** `zoom-out-standard.md`
* **Prior Reports:**
  * [zoom_out_report.md](file:///g:/マイドライブ/HY-HARNESS/zoom_out_report.md) (Stage 5 Initial Zoom Out)
  * [comprehension_report.md](file:///g:/マイドライブ/HY-HARNESS/comprehension_report.md) (Stage 6 Comprehension Test)
  * [critic_report.md](file:///g:/マイドライブ/HY-HARNESS/critic_report.md) (Stage 7 Critic Review)
* **Reviewer:** `egm-zoom-out` (`03004bc4-0855-48e6-a4de-755eb66bdb65`)

---

## Executive Summary

The Stage 8 Intermediate Zoom Out audit evaluated the remedies and mitigations proposed during the Comprehension (Stage 6) and Critic (Stage 7) reviews against the Zoom-Out Standard. While several critic findings identify valid Windows-specific edge cases and lifecycle ambiguities, unconstrained adoption of their proposed fixes risks introducing unnecessary complexity: specifically, building a full shell AST parser in Rust, constructing a two-phase transactional ledger with promotion state machines, and embedding multi-language AST syntax checkers inside `hy-exec-server`.

This report establishes simplicity boundaries for resolving Stage 6 and Stage 7 findings.

---

## Findings: Guarding Remedies Against Bloat & Over-Engineering

### IZO-1: Fail-Closed Gate on Compound Shell Operators Instead of Bespoke Shell AST Parser
* **Severity:** Major
* **Affected Scope:** [critic_report.md](file:///g:/マイドライブ/HY-HARNESS/critic_report.md) (`DES-5`), [design_draft.md#L88](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L88), [L123](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L123).
* **Simplicity Rationale:**
  * **Over-Engineering Risk:** `DES-5` suggests parsing compound shell commands (`&&`, `||`, `;`, `|`, `$()`, backticks) into an AST in Rust. Writing a shell parser that accurately handles `cmd.exe`, PowerShell, and `bash` escaping and subshells is high-risk and complex.
  * **Minimalist Solution:** Enforce a **Fail-Closed Gate on Compound Operators**: if a shell command string contains compound or redirection operators (`&`, `|`, `;`, `` ` ``, `$(`, `>`, `<`), `hy-execpolicy` immediately classifies the command as `decision = "prompt"` (requiring `Guardian` or user approval) unless matched by an explicit full-command rule, while evaluating simple single-command `argv` prefixes directly.

### IZO-2: Round-Scoped Event Rollback Instead of Multi-State Rationale Promotion Tags
* **Severity:** Major
* **Affected Scope:** [critic_report.md](file:///g:/マイドライブ/HY-HARNESS/critic_report.md) (`DES-6`), [design_draft.md#L29](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L29), [L80](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L80), [L111](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L111).
* **Simplicity Rationale:**
  * **Over-Engineering Risk:** `DES-6` proposes a two-phase commit state machine (`provisional` vs `verified` status tags and promotion protocols) for the Rationale Ledger.
  * **Minimalist Solution:** Keep the Capped Rationale Ledger ($K=12$) as a flat key-value map. If a child round crashes or times out and is rolled back, discard its uncommitted session events; if a round finishes and fails a verification gate, prefix its ledger entries with `[Round N]` and allow Round $N+1$ or the user to overwrite invalid entries via `tools.rationale.supersede()`.

### IZO-3: Defer Native Multi-Language AST Parsers in `apply_patch` to the Computational Gate
* **Severity:** Major
* **Affected Scope:** [comprehension_report.md](file:///g:/マイドライブ/HY-HARNESS/comprehension_report.md) (`COMP-4`), [design_draft.md#L117](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L117), [L244](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L244).
* **Simplicity Rationale:**
  * **Over-Engineering Risk:** Embedding `tree-sitter` grammars for every language inside `hy-exec-server` bloats the Rust binary and C toolchain requirements.
  * **Minimalist Solution:** Keep `apply_patch` focused on atomic unified-diff application, UTF-8/line-offset validation, and built-in `.json`/`.toml` parse checks, while delegating full compiler syntax and type checking (`tsc --noEmit`, `cargo check`, `python -m py_compile`) to the Stage 1 Computational Gate.

### IZO-4: Use `std::fs::canonicalize` for NTFS Junction Containment
* **Severity:** Nit
* **Affected Scope:** [critic_report.md](file:///g:/マイドライブ/HY-HARNESS/critic_report.md) (`DES-2`), [design_draft.md#L27](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L27), [L128](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L128).
* **Simplicity Rationale:**
  * In Rust on Windows, `std::fs::canonicalize(path)` invokes `GetFinalPathNameByHandleW` in the standard library. Use `std::fs::canonicalize` to verify that resolved target paths remain inside `canonical_workspace_root` (blocking NTFS directory junctions `mklink /J`), and reserve raw Win32 handle calls strictly for `GetFileInformationByHandle` (`nNumberOfLinks > 1`) + `FindFirstFileNameW`.

### IZO-5: Terminate Job Object First + Fixed 3x100ms Retry on Rollback
* **Severity:** Nit
* **Affected Scope:** [critic_report.md](file:///g:/マイドライブ/HY-HARNESS/critic_report.md) (`DES-4`), [design_draft.md#L31](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L31), [L133](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L133).
* **Simplicity Rationale:**
  * Terminate the round's Windows Job Object (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`) before running checkpoint rollback to release child file handles immediately, followed by a simple 3-attempt loop with a 100 ms sleep for lingering Windows Defender scan locks.

### IZO-6: Remove Undefined `WorldStateSnapshot`
* **Severity:** Nit
* **Affected Scope:** [comprehension_report.md](file:///g:/マイドライブ/HY-HARNESS/comprehension_report.md) (`COMP-5`), [design_draft.md#L285](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L285).
* **Simplicity Rationale:**
  * Delete the undefined `WorldStateSnapshot` reference in Line 285 rather than inventing a new state serialization structure; the event-sourced session log and active Rationale Ledger ($K \le 12$) already preserve required context.
