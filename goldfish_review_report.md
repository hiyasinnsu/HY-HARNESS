# Goldfish Annotated Review Report

**Status:** resolved
**Target:** `g:\マイドライブ\HY-HARNESS\design_draft.md` (`1..325`)

## Prioritized Findings & AI Suggestions

### [Issue 1: ACT-B1] [`egm-comprehension` / `egm-codebase-details` / `egm-implementation-readiness`] - Severity: High (Blocker)
*   **Affected Scope:** [Lines 133, 236-240, 299](./design_draft.md#L133) (`Technical Plan Section 4`, `Detailed Implementation Plan Items 7 & 19`)
*   **Discrepancy Description:**
    1. Pointing `GIT_INDEX_FILE` to a non-existent temporary file starts with an empty index, causing `git add -u` to stage zero files and `git write-tree` to write an empty tree (`4b825dc...`).
    2. Line 133 specifies `git reset --hard refs/hy/checkpoints/<run-id>/r<N>` (which clobbers the active branch `HEAD`), whereas Line 239 specifies `git read-tree` + `git checkout-index -f -a` (which preserves `HEAD`).
    3. Line 299 states *"Merge only when both gates pass"*, conflicting with in-tree sequential execution where there is no separate worktree branch to merge.
*   **Rationale:** Uninitialized temporary Git indexes silently lose all tracked files during checkpoint creation, and `git reset --hard` corrupts user branch state.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Both the Git index initialization bug and the `git reset --hard` vs `git read-tree` discrepancy are critical implementation blockers. Initializing `GIT_INDEX_FILE` by copying `.git/index` (or running `git read-tree HEAD`) before `git add -u` and using `git read-tree <ref>` + `git checkout-index -f -a` during rollback ensures sub-500ms in-tree restoration without mutating `HEAD`.
*   ***Proposed Edit:***
    *   Location: Lines 133, 236–240, 299
    *   Change: Specify that `create_ref_checkpoint` copies `.git/index` to `.git/hy-checkpoints/<run-id>/r<N>.index`, runs `git add -u` + `git write-tree` + `git commit-tree` stored at `refs/hy/checkpoints/<run-id>/r<N>`, and writes untracked paths (`git ls-files --others --exclude-standard`) to `.git/hy-checkpoints/<run-id>/r<N>.untracked.json`. Standardize rollback on `git read-tree refs/hy/checkpoints/<run-id>/r<N>` + `git checkout-index -f -a` + pruning newly created untracked files. Replace *"Merge only when both gates pass"* with *"Finalize the in-tree working state and prune `refs/hy/checkpoints/<run-id>/*` when both gates pass"*.

---

### [Issue 2: ACT-B2] [`egm-comprehension` / `egm-design` / `egm-zoom-out`] - Severity: High (Blocker)
*   **Affected Scope:** [Lines 61-63, 133-136, 299-300](./design_draft.md#L61-L63) (`CUJ 3`, `Technical Plan Section 4`, `Detailed Implementation Plan Item 19`)
*   **Discrepancy Description:** Line 133 states that rollback to `r<N>` occurs when a round *"times out, crashes, or is rejected"*, while Lines 61–63 and 300 pass test failure diagnostics to Round $N+1$ so the next worker can fix the failing tests. Rolling back on gate rejection deletes the code modifications that produced the test failures. Additionally, unverified Rationale Ledger rules from failed rounds could contaminate subsequent rounds.
*   **Rationale:** An implementer cannot write the `verifier-ralph` transition state machine without knowing whether gate rejection rolls back or preserves edits.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Following Stage 8 (`IZO-2`) simplicity bounds, timeout/crash must roll back immediately to `r<N>` and discard uncommitted round session events; gate rejection (Stage 1 or Stage 2 failure) preserves the working tree by default so Round $N+1$ can fix the failing test (unless `Grader` sets `rollbackRecommended: true`), snapshots `r<N+1>`, and prefixes Round $N$'s Rationale Ledger additions with `[Round N]`.
*   ***Proposed Edit:***
    *   Location: Lines 61–63, 133–136, 299–300
    *   Change: Explicitly separate **Timeout/Crash Rollback** (restore `r<N>` and discard Round $N$ uncommitted events) from **Gate Rejection Hand-off** (keep working tree edits unless `rollbackRecommended: true`, create checkpoint `r<N+1>`, prefix Round $N$ ledger entries with `[Round N]`, and pass the failure digest to Round $N+1$).

---

### [Issue 3: ACT-B3] [`egm-codebase-details` / `egm-implementation-readiness` / `egm-comprehension`] - Severity: High (Blocker)
*   **Affected Scope:** [Lines 50, 119, 276-280](./design_draft.md#L119) (`CUJ 1`, `Technical Plan Section 2`, `Detailed Implementation Plan Item 15`)
*   **Discrepancy Description:** Win32 `CreateProcessAsUserW` does not pass POSIX `fd 3` handles to Node.js without undocumented MSVC CRT structures, and Node.js `--permission` blocks `net.connect()` to Windows Named Pipes (`\\.\pipe\...`) with `ERR_ACCESS_DENIED` unless `--allow-net` is passed.
*   **Rationale:** `hy-ptc-worker` will fail to communicate on Windows 10 if it relies on `fd 3` or Named Pipes under `--permission`.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Using the worker's standard `stdin` and `stdout` handles (already configured with explicit Restricted-SID DACLs by `hy-exec-server`) with newline-delimited JSON-RPC 2.0 framing works on Windows 10 without granting `--allow-net`.
*   ***Proposed Edit:***
    *   Location: Lines 50, 119, 276–280
    *   Change: Specify that the host transpiles the TypeScript snippet (`ts.transpileModule` / `stripTypeScriptTypes`) before execution, spawns `node --permission --allow-fs-read=<worker_runtime_dir> worker.mjs` via `hy-exec-server`, and multiplexes `ptc/toolCall`, `ptc/toolResult`, `ptc/log`, and `ptc/complete` messages as newline-delimited JSON-RPC 2.0 over DACL-configured `stdin`/`stdout`.

---

### [Issue 4: ACT-B4] [`egm-implementation-readiness` / `egm-codebase-details`] - Severity: High (Blocker)
*   **Affected Scope:** [Lines 198-320](./design_draft.md#L198-L320) (`Detailed Implementation Plan`)
*   **Discrepancy Description:** `design_draft.md` lists implementation items as a flat checklist without chronological phases or intermediate verification gates, violating the Implementation Readiness Standard ("Phasing & Checkpoints").
*   **Rationale:** Implementers need a topological build order where each phase leaves the workspace buildable and testable.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Partitioning the implementation plan into sequential phases (Phase 0 through Phase 5) with explicit exit criteria and verification commands aligns `design_draft.md` with `docs/designs/hy-harness-implementation-plan.md` and satisfies the standard.
*   ***Proposed Edit:***
    *   Location: Lines 198–320
    *   Change: Group all target files under sequential phases (`Phase 0: Monorepo & JSON-RPC Protocol`, `Phase 1: Rust Execution Daemon, Starlark Policy & Win10 Sandbox`, `Phase 2: Cordis Control Plane, Session Log & Rationale Ledger`, `Phase 3: Tiered ACI & Isolated PTC Runtime`, `Phase 4: SpillStore, Compaction & Stateless Guardian`, `Phase 5: Verifier-Gated Ralph, CLI & Integration Tests`) with phase-exit verification commands.

---

### [Issue 5: ACT-B5] [`egm-implementation-readiness` / `egm-codebase-details`] - Severity: High (Blocker)
*   **Affected Scope:** [Lines 212-216, 241-245](./design_draft.md#L212-L216) (`crates/hy-protocol`, `crates/hy-exec-server`)
*   **Discrepancy Description:** Exact JSON-RPC 2.0 method strings, request/response struct schemas (including background job operations), numeric error codes, and the TypeScript `ExecRpcClient` module are omitted.
*   **Rationale:** Leaving wire method names and payload fields to the implementer violates the Zero-Decision Rule.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Specifying the complete JSON-RPC 2.0 method table (`exec/command`, `job/status`, `job/wait`, `job/kill`, `patch/apply`, `checkpoint/create`, `checkpoint/rollback`, `policy/evaluate`, `ptc/run`), error codes (`-32001`..`-32004`), and `ExecRpcClient` (`ctx.execRpc`) eliminates ambiguity between Rust and TypeScript.
*   ***Proposed Edit:***
    *   Location: Technical Plan & Detailed Implementation Plan (`crates/hy-protocol`, `packages/core`)
    *   Change: Add the explicit JSON-RPC 2.0 wire specification, error codes, `JobStatusRequest`/`JobWaitRequest`/`JobKillRequest` types, and the TypeScript `ExecRpcClient` service.

---

### [Issue 6: ACT-B6] [`egm-comprehension` / `egm-zoom-out`] - Severity: High (Blocker)
*   **Affected Scope:** [Lines 28, 61, 116-120, 134, 244](./design_draft.md#L116-L120) (`Technical Plan Section 2`, `Detailed Implementation Plan`)
*   **Discrepancy Description:** Parameter schemas for the 4 core tools (`read_file`, `apply_patch`, `bash`, `run_code`), the mechanism by which a worker signals `claim_complete`, and the scope of `apply_patch` syntax validation are undefined.
*   **Rationale:** Implementers need exact tool schemas and completion signaling rules.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Define the 4 core tool schemas inline, specify that `claim_complete` triggers when the child worker finishes a turn with zero tool calls (or calls `tools.objective.claimComplete({ summary })` inside `run_code`), and follow `IZO-3` by keeping `apply_patch` validation focused on unified-diff hunk application, UTF-8 validity, and built-in JSON/TOML parse checks (leaving compiler checks to the Stage 1 Computational Gate).
*   ***Proposed Edit:***
    *   Location: Lines 116–120, 134, 244
    *   Change: Add exact input/output types for the 4 core tools, define the `claim_complete` detection rule, and scope `apply_patch` post-edit validation to diff integrity, UTF-8, and JSON/TOML parsing.

---

### [Issue 7: ACT-B7] [`egm-design` / `egm-structural`] - Severity: High (Blocker)
*   **Affected Scope:** [Lines 166-181](./design_draft.md#L166-L181) (`Risks & Mitigations`)
*   **Discrepancy Description:** Missing dedicated `## Risks & Mitigations` section required by `feature-spec-standard.md`.
*   **Rationale:** Every feature specification must explicitly document security boundaries, failure modes, and mitigations.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Adding `## Risks & Mitigations` captures the Windows 10 Low-Integrity read/network boundary, NTFS junction/hard-link escapes, `ERROR_SHARING_VIOLATION` file locks, shell command chaining, and Grader prompt injection in one structured table.
*   ***Proposed Edit:***
    *   Location: Before `## Non-Functional Requirements`
    *   Change: Insert `## Risks & Mitigations` covering the 5 core risk vectors and their concrete mitigations.

---

### [Issue 8: ACT-M1] [`egm-zoom-out` / `egm-implementation-readiness` / `egm-comprehension`] - Severity: Medium (Major)
*   **Affected Scope:** [Lines 70-105, 200-305](./design_draft.md#L200-L305) (`Technical Plan` & `Detailed Implementation Plan`)
*   **Discrepancy Description:**
    1. Item 9 re-implements `cordis-kernel` from scratch instead of importing the published `cordis` npm package (`ZO-1`, `IR-7`).
    2. 18 subprojects (12 TS packages + 6 Rust crates) in greenfield v1 create excessive build manifest overhead (`ZO-2`).
    3. Speculative `ImageOffload` compaction step (`ZO-6`), `create_isolated_worktree()` (`ZO-7`), and undefined `WorldStateSnapshot` (`COMP-5`, `IZO-6`) are included without active consumers.
*   **Rationale:** Over-fragmentation and reinventing `cordis` violate the Zoom-Out Standard and the user's instruction for a concise, extensible initial implementation (`"初回実装は拡張性が高い状態で簡潔に実装して"`).
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Importing `cordis` from npm (wrapped with HY-HARNESS service declarations), consolidating the workspace into **4 Rust crates** (`hy-protocol`, `hy-execpolicy`, `hy-sandbox-windows`, `hy-exec-server` with `checkpoint` module) and **3 TypeScript packages** (`packages/core`, `packages/seams`, `packages/hy-cli`) while preserving clean Cordis plugin seams, and removing `ImageOffload`, `create_isolated_worktree()`, and `WorldStateSnapshot` reduces boilerplate while maintaining full plugin extensibility.
*   ***Proposed Edit:***
    *   Location: Technical Plan & Detailed Implementation Plan
    *   Change: Use `cordis` npm package in `packages/core`, consolidate workspace packages into 4 Rust crates and 3 TypeScript packages, defer POSIX sandbox (`hy-sandbox-posix`) and full multi-language LSP server management to Future Improvements (providing lightweight `grep`/`glob` search tools in v1), and remove `ImageOffload`, `create_isolated_worktree()`, and `WorldStateSnapshot`.

---

### [Issue 9: ACT-M2] [`egm-zoom-out` / `egm-comprehension` / `egm-codebase-details`] - Severity: Medium (Major)
*   **Affected Scope:** [Lines 90, 132, 291-295](./design_draft.md#L132) (`Guardian Auto-Reviewer`)
*   **Discrepancy Description:** Orchestrating a stateful trunk-conversation cache with ephemeral forking for `Guardian` is premature optimization (`ZO-4`), and the structured response schema and `TooManyDenials` fallback behavior are undefined (`COMP-9`, `CBD-7`).
*   **Rationale:** Stateless classification with standard provider prefix caching is simpler and deterministic.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Replace the trunk-fork state machine with a stateless read-only classification call returning `{ approved: boolean, riskScore: number, reason: string }` (approving when `riskScore < 80`), and specify that 3 consecutive denials (`TooManyDenials`) escalate to a terminal prompt in interactive CLI mode or abort the round in headless `ralph` mode.
*   ***Proposed Edit:***
    *   Location: Lines 90, 132, and Guardian implementation item
    *   Change: Specify stateless single-turn Guardian evaluation, the `{ approved, riskScore, reason }` schema, and the `TooManyDenials` fallback rule.

---

### [Issue 10: ACT-M3] [`egm-design` / `egm-comprehension` / `egm-codebase-details` / `egm-zoom-out`] - Severity: Medium (Major)
*   **Affected Scope:** [Lines 124-129, 222-230](./design_draft.md#L124-L129) (`crates/hy-sandbox-windows`)
*   **Discrepancy Description:**
    1. Missing `std::fs::canonicalize` check to block NTFS Directory Junctions (`mklink /J`) (`DES-2`, `IZO-4`).
    2. Missing host environment variable sanitization and documentation of Windows 10 Low-Integrity read/network boundaries (`DES-3`).
    3. Unspecified `WorkspaceWrite` mechanism under Low Integrity (`COMP-11`).
    4. Missing Win32 API details: `CreateProcessAsUserW` with `CREATE_SUSPENDED`, prepending drive letter from `GetVolumePathNameW` to `FindFirstFileNameW`, and `windows-sys` Cargo features (`CBD-4`).
*   **Rationale:** Without these details, the Windows 10 sandbox either fails to compile, blocks legitimate workspace writes, or allows junction/hard-link escapes.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Incorporate all four concrete Win32 specifications into Section 3 and the `crates/hy-sandbox-windows` implementation plan.
*   ***Proposed Edit:***
    *   Location: Lines 124–129 and `crates/hy-sandbox-windows` item
    *   Change: Add `std::fs::canonicalize` junction check, volume drive-letter resolution (`GetVolumePathNameW`) for `FindFirstFileNameW`, `CreateProcessAsUserW` + `CREATE_SUSPENDED` + `AssignProcessToJobObject` + `ResumeThread`, host secret env sanitization (`*_API_KEY`, `*_TOKEN`, `*_SECRET`), `WorkspaceWrite` brokering via `apply_patch` + `.hy-harness/tmp` Low-Integrity scratch directory, and the exact `windows-sys` features.

---

### [Issue 11: ACT-M4] [`egm-design` / `egm-zoom-out`] - Severity: Medium (Major)
*   **Affected Scope:** [Lines 133, 239](./design_draft.md#L133) (`Checkpoint Rollback`)
*   **Discrepancy Description:** Active background jobs holding open file handles on Windows NTFS cause `ERROR_SHARING_VIOLATION` (`0x20`) during rollback.
*   **Rationale:** Windows NTFS locks open files against deletion or overwrite.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Terminate all processes in the round's Job Object before rollback, followed by a 3-attempt loop with a 100 ms sleep (`IZO-5`).
*   ***Proposed Edit:***
    *   Location: Lines 133 and `checkpoint` implementation item
    *   Change: Specify pre-rollback Job Object termination and a 3x100ms retry loop on file restoration.

---

### [Issue 12: ACT-M5] [`egm-design` / `egm-implementation-readiness` / `egm-zoom-out`] - Severity: Medium (Major)
*   **Affected Scope:** [Lines 123, 217-221](./design_draft.md#L123) (`crates/hy-execpolicy`)
*   **Discrepancy Description:** Raw string prefix matching in `execpolicy` can be bypassed by shell chaining operators (`&&`, `||`, `;`, `|`, `$()`, backticks), and the Rust evaluation signature is undefined.
*   **Rationale:** Security policy evaluation must be unambiguous and immune to trivial command chaining.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Following `IZO-1`, define `pub fn evaluate(&self, command: &str) -> PolicyDecision` (`Allow`, `Prompt`, `Deny`) with a **Fail-Closed Compound Operator Gate**: any command string containing `[&|;`$()<>]` returns `PolicyDecision::Prompt` (unless matched by an explicit `Deny` rule), while simple single commands are tokenized into `argv` and matched against `prefix_rule` patterns (`Deny > Prompt > Allow`, defaulting unmatched commands to `Prompt`).
*   ***Proposed Edit:***
    *   Location: Lines 123 and `crates/hy-execpolicy` item
    *   Change: Add `PolicyDecision` enum, `evaluate(&self, command: &str) -> PolicyDecision`, and the fail-closed compound operator check.

---

### [Issue 13: ACT-M6] [`egm-design`] - Severity: Medium (Major)
*   **Affected Scope:** [Lines 136, 299](./design_draft.md#L136) (`Stage 2 Inferential Gate`)
*   **Discrepancy Description:** Untrusted diffs or test outputs could inject prompt instructions into the `Grader` model.
*   **Rationale:** The Inferential Gate must be hardened against indirect prompt injection.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Fence untrusted inputs inside `<untrusted_git_diff>` and `<untrusted_test_output>` tags and enforce a strict JSON response schema (`{ pass: boolean, unmetCriteria: string[], rollbackRecommended: boolean, reasoning: string }`).
*   ***Proposed Edit:***
    *   Location: Lines 136 and `verifier-ralph` item
    *   Change: Specify XML input fencing and the JSON output schema for `Grader`.

---

### [Issue 14: ACT-M7] [`egm-comprehension`] - Severity: Medium (Major)
*   **Affected Scope:** [Lines 73-105](./design_draft.md#L73-L105) (`Mermaid Architecture Diagram`)
*   **Discrepancy Description:** The Mermaid diagram depicts 3 planes (`CP`, `GOV`, `EP`) whereas the text defines 2 physical planes (`CP` in TypeScript and `EP` in Rust).
*   **Rationale:** Diagrams must match the physical process architecture.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Reorganize the Mermaid diagram into the two physical process planes (`Control Plane` and `Execution Plane`) connected by `JSON-RPC 2.0 over Stdio`.
*   ***Proposed Edit:***
    *   Location: Lines 73–105
    *   Change: Place `Guards`, `Guardian`, and `Verifier` inside `CP` and `Starlark ExecPolicy` inside `EP`.

---

### [Issue 15: ACT-M8] [`egm-implementation-readiness` / `egm-comprehension` / `egm-codebase-details`] - Severity: Medium (Major)
*   **Affected Scope:** [Lines 110-111, 251-255, 269, 281-285](./design_draft.md#L110-L111) (`SessionLog`, `SpillStore`, `ReadBeforeEditGuard`)
*   **Discrepancy Description:** Missing TypeScript interfaces for `SessionEventMap`, inconsistent eviction wording (`least-recently-updated` vs `LRU`), unspecified token estimation formula, unspecified `SpillStore` file layout and compaction trigger threshold, and missing new-file exception for `ReadBeforeEditGuard`.
*   **Rationale:** Implementers need deterministic rules for each state reducer and guard.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Define `SessionEventMap` payloads, standardize eviction on `updatedAtStep` (`least-recently-updated`) with `Math.ceil(byteLength / 4)` token estimation, specify `.hy-harness/spill/<session-id>/<call-id>.txt` and the 75% context window compaction trigger, and exempt non-existent target files in `ReadBeforeEditGuard`.
*   ***Proposed Edit:***
    *   Location: Technical Plan Sections 1 & 2 and `packages/core` / `packages/seams` items
    *   Change: Add the exact TypeScript interfaces, token estimator, spill path, 75% compaction threshold, and new-file guard exemption.

---

### [Issue 16: ACT-M9] [`egm-comprehension` / `egm-codebase-details`] - Severity: Medium (Major)
*   **Affected Scope:** [Lines 112, 205, 243, 304](./design_draft.md#L112) (`Configuration & Daemon Logging`)
*   **Discrepancy Description:** Missing `.hy-harness/config.json` schema/lookup order and missing `tracing` stderr logger setup in `hy-exec-server` (where `print_stdout` and `print_stderr` are denied by Clippy).
*   **Rationale:** The daemon needs a non-stdio logging channel and the CLI needs a defined config file contract.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Define `.hy-harness/config.json` (and `.hy-harness/policies/default.star`) and add `tracing` + `tracing-subscriber` writing exclusively to `std::io::stderr`.
*   ***Proposed Edit:***
    *   Location: Lines 112, 205, 243, 304
    *   Change: Add `.hy-harness/config.json` schema and `tracing-subscriber` stderr configuration.

---

### [Issue 17: ACT-M10] [`egm-structural`] - Severity: Medium (Major)
*   **Affected Scope:** [Lines 168-195](./design_draft.md#L168-L195) (`Non-Functional Requirements`, `Additional Resources`, `Future Improvements`)
*   **Discrepancy Description:** Missing `Rollout & Operational Recovery` under `## Non-Functional Requirements`, and `### Additional Resources` / `### Future Improvements` use H3 instead of H2.
*   **Rationale:** Template compliance and Markdown AST hierarchy.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Add `Rollout & Operational Recovery` under NFRs and promote both headings to H2 (`##`).
*   ***Proposed Edit:***
    *   Location: Lines 168–195
    *   Change: Add `Rollout & Operational Recovery` bullet group and change `### Additional Resources` / `### Future Improvements` to `##`.

---

### [Issue 18: ACT-M11] [`egm-style`] - Severity: Medium (Major)
*   **Affected Scope:** [Lines 23, 29, 31, 145-158, 248-249, 311](./design_draft.md#L145-L158) (`Goals`, `Alternatives Considered`, `Detailed Implementation Plan`)
*   **Discrepancy Description:** Presence of academic jargon (*"spatiotemporal composability"*, *"reactive coeffects"*), hyperbole (*"Instant"*, *"Zero Context Rationale Erosion"*), subjective adjectives (*"brittle"*, *"slow"*, *"cumbersome"*), and a `< 500 ms` latency threshold inside a functional integration test description.
*   **Rationale:** Engineering specifications must use objective, verifiable terminology.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Replace all flagged phrases with direct technical descriptions and move the `< 500 ms` assertion to a dedicated benchmark check.
*   ***Proposed Edit:***
    *   Location: Lines 23, 29, 31, 145–158, 248–249, 311
    *   Change: Replace jargon/hyperbole with objective phrasing and separate functional rollback testing from latency benchmarking.

---

### [Issue 19: ACT-N1] [`egm-zoom-out`] - Severity: Low (Nit)
*   **Affected Scope:** [Lines 29, 111, 118, 120](./design_draft.md#L111) (`Default Constants`)
*   **Discrepancy Description:** Constants ($K=12$, 1,500 tokens, 5,000 ms, 32 KB, `maxParallelSubCalls = 10`) are presented as hardcoded numbers rather than configurable defaults.
*   **Rationale:** Clarifying that these are configurable defaults in `.hy-harness/config.json` improves operational flexibility.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** State that these values are the default configuration parameters in `.hy-harness/config.json`.
*   ***Proposed Edit:***
    *   Location: Lines 111, 118, 120
    *   Change: Note that each threshold is a configurable default in `.hy-harness/config.json`.

---

### [Issue 20: ACT-N2] [`egm-comprehension` / `egm-style`] - Severity: Low (Nit)
*   **Affected Scope:** [Lines 17, 28, 38, 46, 82, 98, 114, 121, 193-194](./design_draft.md#L17) (`Acronyms & Version Numbers`)
*   **Discrepancy Description:** Unexpanded `PTC` and `ACI` on first use, `24H2+` vs `25H2+` inconsistency for Windows 11 MXC, and undefined tier labels/slogans.
*   **Rationale:** Consistency and self-containment for fresh readers.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Expand `Programmatic Tool Calling (PTC)` and `Agent-Computer Interface (ACI)` on first use, standardize on `Windows 11 24H2+`, and use descriptive sandbox backend names.
*   ***Proposed Edit:***
    *   Location: Lines 17, 28, 38, 46, 82, 98, 114, 121, 193–194
    *   Change: Expand acronyms on first use, standardize `Windows 11 24H2+`, and replace undefined tier labels.

---

### [Issue 21: ACT-N3] [`egm-comprehension` / `egm-implementation-readiness`] - Severity: Low (Nit)
*   **Affected Scope:** [Line 304](./design_draft.md#L304) (`packages/hy-cli`)
*   **Discrepancy Description:** CLI subcommands (`hy run`, `hy ralph`, `hy rpc-server`, `hy policy-test`) lack argument and flag signatures.
*   **Rationale:** Explicit CLI signatures prevent guesswork during implementation.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Add the exact positional arguments and flags for all 4 CLI subcommands.
*   ***Proposed Edit:***
    *   Location: `packages/hy-cli` implementation item
    *   Change: Specify `hy run "<prompt>" [--model <role=id>]`, `hy ralph "<objective>" --verify-cmd "<cmd>" [--max-rounds <N>] [--max-cost-usd <F>]`, `hy rpc-server`, and `hy policy-test <path.star>`.

---

### [Issue 22: ACT-N4] [`egm-design` / `egm-codebase-details`] - Severity: Low (Nit)
*   **Affected Scope:** [Lines 119, 205, 220, 259, 316](./design_draft.md#L119) (`PTC RwLock`, `starlark` Crate, `MockLlmProvider`)
*   **Discrepancy Description:** Specify async `RwLock` for concurrent PTC sub-calls, use `starlark` consistently as the crate name, and include `MockLlmProvider` for offline tests.
*   **Rationale:** Ensures deterministic concurrency and offline CI testability.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Trivial textual additions that directly improve implementation accuracy.
*   ***Proposed Edit:***
    *   Location: Lines 119, 205, 220, 259, 316
    *   Change: Add async `RwLock` specification, standardize crate name to `starlark`, and include `MockLlmProvider`.

---

### [Issue 23: ACT-N5] [`egm-structural`] - Severity: Low (Nit)
*   **Affected Scope:** [Lines 185-188](./design_draft.md#L185-L188) (`Additional Resources`)
*   **Discrepancy Description:** Mixed `file:///` and relative `./` links in `Additional Resources`.
*   **Rationale:** Uniform link formatting.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Convert all resource links to canonical `file:///` URIs.
*   ***Proposed Edit:***
    *   Location: Lines 185–188
    *   Change: Format all four links as `file:///` URIs.

---

### [Issue 24: ACT-N6] [`egm-style`] - Severity: Low (Nit)
*   **Affected Scope:** [Lines 11, 17, 21, 90, 132, 220, 244, 269, 279, 293, 323-325](./design_draft.md#L11) (`Diction & Sentence Structure`)
*   **Discrepancy Description:** Informal wording (*"cuts"*, *"suffers from"*, *"Locked-Down"*, *"Monotonic Guards"*, *"asks `hy-exec-server`"*), compound sentence in Item 8, and footer attribution.
*   **Rationale:** Clean, objective technical prose.
*   ***AI Suggestion:*** PROPOSE FIX
*   ***Justification:*** Replace informal verbs/adjectives and split the compound sentence in the `hy-exec-server` item.
*   ***Proposed Edit:***
    *   Location: Lines 11, 17, 21, 90, 132, 220, 244, 269, 279, 293
    *   Change: Apply objective technical wording across all listed lines.
