# Stage 5: Initial Zoom Out Review Report (`zoom_out_report.md`)

* **Target Document:** [design_draft.md](file:///g:/マイドライブ/HY-HARNESS/design_draft.md) (Lines 1..325)
* **Standard:** `zoom-out-standard.md`
* **Reviewer:** `egm-zoom-out` (`ad8d2e94-d144-4c45-b7f1-d6c484849553`)

---

## Executive Summary

The document clearly articulates the root problems (Windows 10 sandbox failures, multi-step token bloat, context rationale erosion, unverified worker completion, and side-effect leakage) and proposes targeted core primitives (Windows 10 Restricted Token + explicit DACLs, in-tree Git ref checkpoints, tiered PTC, and capped rationale ledger).

However, the architecture exhibits monorepo over-fragmentation, wheel reinvention, premature multi-platform generalization, and over-engineered sub-mechanisms that violate YAGNI and the Zoom-Out simplicity standard.

---

## Findings

### ZO-1: Reinventing the Cordis Microkernel from Scratch
* **Severity:** Major
* **Affected Scope:** [design_draft.md#L70](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L70), [L77](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L77), [L109](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L109), and Detailed Implementation Plan Item 9 ([L246-L250](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L246-L250)).
* **Simplicity Rationale:**
  Line 249 specifies creating `packages/core/cordis-kernel` to implement `Context`, `Service`, `ctx.effect(setup)`, reactive `inject`, and 5 event dispatchers (`emit`, `waterfall`, `parallel`, `serial`, `bail`) from scratch. The Cordis microkernel (`cordis` / `@cordisjs/core`) is an existing open-source package on npm. Re-implementing a dependency-injection microkernel with effect reversal and reactive coeffects introduces maintenance debt and disposal ordering bugs, violating Section 4 of the Zoom-Out Standard (*Platform Standards & Reinventing the Wheel*). HY-HARNESS should import the existing `cordis` package or use a minimal thin wrapper rather than re-implementing the kernel from scratch.

### ZO-2: Extreme Monorepo Over-Fragmentation (18 Subprojects in Greenfield v1)
* **Severity:** Major
* **Affected Scope:** [design_draft.md#L73-L100](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L73-L100) and Detailed Implementation Plan Items 1–20 ([L202-L306](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L202-L306)).
* **Simplicity Rationale:**
  The plan divides a greenfield codebase into 12 TypeScript packages (`packages/core/*`, `packages/seams/*`, `packages/apps/*`) and 6 Rust crates (`crates/*`), totaling 18 separate build manifests (`package.json`, `Cargo.toml`). This introduces tooling overhead (cross-package linking, tsconfig project references, cargo workspace lint synchronization) before end-to-end functionality is proven.
  * **Rust Execution Daemon:** All 6 crates serve `hy-exec-server`. Consolidating into fewer crates or internal modules reduces workspace boilerplate.
  * **TypeScript Control Plane:** Core and seam modules can be organized as directory modules inside a consolidated package (`packages/core` and `packages/cli`), splitting into independent npm packages only when external consumption requires it.

### ZO-3: Premature Multi-Platform Generalization in a Windows 10-First Harness (YAGNI)
* **Severity:** Major
* **Affected Scope:** [design_draft.md#L99](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L99) and Detailed Implementation Plan Item 6 ([L231-L235](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L231-L235)).
* **Simplicity Rationale:**
  The problem statement and core goals justify HY-HARNESS as a Windows 10-first autonomous coding agent harness. Allocating a separate crate and implementation step to build Linux `bwrap` wrappers and macOS Seatbelt profile generators in v1 dilutes focus and violates YAGNI. POSIX sandboxing should be deferred or kept as a pass-through stub until the Windows 10 implementation is verified.

### ZO-4: Over-Engineered Autonomous `Guardian` with Trunk Cache & Ephemeral Forking
* **Severity:** Major
* **Affected Scope:** [design_draft.md#L90](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L90), [L130-L132](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L130-L132), and Detailed Implementation Plan Item 18 ([L291-L295](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L291-L295)).
* **Simplicity Rationale:**
  Orchestrating an autonomous trunk-cache state machine with ephemeral forks for `Guardian` in v1 is premature optimization before measuring approval latency or frequency. A stateless single-turn read-only classification call (with standard provider prefix caching on the static system prompt) achieves the same safety review without complex trunk-fork state management.

### ZO-5: Premature Complexity — In-House Multi-Language Stdio LSP Client in v1
* **Severity:** Major
* **Affected Scope:** Detailed Implementation Plan Item 17 ([design_draft.md#L286-L290](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L286-L290)).
* **Simplicity Rationale:**
  Managing stdio language server daemons (`typescript-language-server`, `rust-analyzer`, `pyright`) requires full LSP JSON-RPC handshakes, document synchronization, workspace root resolution, and indexing delay handling. Search tools (`grep`, `glob`, `read_file`) inside PTC deliver core navigation with zero daemon lifecycle overhead; multi-language LSP management can be deferred or scoped to a single optional plugin after the core loop is proven.

### ZO-6: Speculative `ImageOffload` Step in Compaction (YAGNI)
* **Severity:** Nit
* **Affected Scope:** [design_draft.md#L81](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L81) and Detailed Implementation Plan Item 16 ([L284](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L284)).
* **Simplicity Rationale:**
  The document specifies 3-tier Compaction including `(2) ImageOffload`, yet the 4 core tools (`read_file`, `apply_patch`, `bash`, `run_code`) have no screenshot or image intake tool and browser/GUI is a Non-Goal.

### ZO-7: Speculative Worktree Backend in `crates/hy-checkpoint` (YAGNI)
* **Severity:** Nit
* **Affected Scope:** [design_draft.md#L97](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L97), [L133](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L133), [L158](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L158), and Item 7 ([L239](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L239)).
* **Simplicity Rationale:**
  Alternative C rejects `git worktree` for sequential rounds on Windows NTFS, adopting Git ref checkpoints (`refs/hy/checkpoints/`) instead. Implementing `create_isolated_worktree()` in v1 when concurrent multi-agent execution is deferred is unnecessary flexibility.

### ZO-8: Rigid Hardcoding of Magic Numbers in Core Architecture
* **Severity:** Nit
* **Affected Scope:** [design_draft.md#L29](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L29), [L111](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L111), [L118](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L118), [L120](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L120), [L254](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L254), [L279](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L279).
* **Simplicity Rationale:**
  Constants ($K=12$ entries / 1,500 tokens for Rationale Ledger, 5,000 ms foreground deadline, 32 KB / 8,000 tokens for SpillStore, `maxParallelSubCalls = 10`) should be documented as configurable defaults rather than hardcoded architectural invariants.
