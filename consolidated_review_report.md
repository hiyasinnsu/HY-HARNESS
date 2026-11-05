# HY-HARNESS Consolidated Goldfish Review Report (`consolidated_review_report.md`)

* **Target Document:** [design_draft.md](file:///g:/マイドライブ/HY-HARNESS/design_draft.md) (`FeatureRange: 1..197`, `DetailedRange: 198..325`)
* **Execution Preset:** Consolidated report with all review rubrics (Uninterrupted Full Flow: Stages 5, 6, 7, 8, 9)
* **Stage Reports:**
  1. **Stage 5 (Initial Zoom Out):** [zoom_out_report.md](file:///g:/マイドライブ/HY-HARNESS/zoom_out_report.md) (`egm-zoom-out`: `ad8d2e94-d144-4c45-b7f1-d6c484849553`)
  2. **Stage 6 (Comprehension Test):** [comprehension_report.md](file:///g:/マイドライブ/HY-HARNESS/comprehension_report.md) (`egm-comprehension`: `db52ef0b-9d13-4f38-93d5-a98fc39c54f3`)
  3. **Stage 7 (Critic Review):** [critic_report.md](file:///g:/マイドライブ/HY-HARNESS/critic_report.md) (`egm-design`: `cad2bda3-a768-4518-a70c-8ea5a5615ef2`, `egm-structural`: `1b7c10e9-64bd-4e07-9ab1-0bb135a3ed82`, `egm-style`: `7cae5acb-35f1-43d0-8b6d-6bae4adb75ad`)
  4. **Stage 8 (Intermediate Zoom Out):** [intermediate_zoom_out_report.md](file:///g:/マイドライブ/HY-HARNESS/intermediate_zoom_out_report.md) (`egm-zoom-out`: `03004bc4-0855-48e6-a4de-755eb66bdb65`)
  5. **Stage 9 (Implementation Readiness Test):** [implementation_readiness_report.md](file:///g:/マイドライブ/HY-HARNESS/implementation_readiness_report.md) (`egm-implementation-readiness`: `b0c7b703-a84e-4fce-9266-56f22eb2ce6e`, `egm-codebase-details`: `6e699833-3912-4050-9825-fb05aff7df8e`, `egm-style`: `e59b6ef7-66d2-4289-83ab-6c07e5e3346a`)

---

## 1. Executive Summary

Across all five review stages (9 Goldfish reviewer runs), 67 raw findings were collected, cross-checked against the Stage 8 Intermediate Zoom Out simplicity bounds, and deduplicated into **24 consolidated action items**:
* **🔴 7 Blockers** (must be resolved before implementation begins)
* **🟡 11 Major Issues** (architectural edge cases, YAGNI simplifications, and protocol completeness)
* **🟢 6 Nits** (terminology, formatting, and minor conventions)

---

## 2. Consolidated Action Items by Priority

### 🔴 Blockers (7 Items)

#### ACT-B1: Reconcile Git Ref Checkpoint Creation (`GIT_INDEX_FILE` Initialization) & Rollback Plumbing (`git read-tree` vs `git reset --hard`)
* **Source Findings:** `COMP-3`, `CBD-2`, `IR-5`, `CBD-8`
* **Affected Lines:** [design_draft.md#L133](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L133), [L239](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L239), [L299](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L299)
* **Problem:**
  1. Line 239 points `GIT_INDEX_FILE` to a temporary file and runs `git add -u`. In Git plumbing, an uninitialized temporary index file is empty, so `git add -u` stages zero files and writes an empty tree (`4b825dc...`).
  2. Line 133 uses `git reset --hard refs/hy/checkpoints/<run-id>/r<N>` (which clobbers the user's branch `HEAD`), whereas Line 239 uses `git read-tree` + `git checkout-index -f -a` (which restores tracked files without moving `HEAD`).
  3. Line 299 says *"Merge only when both gates pass"*, which contradicts in-tree sequential execution where there is no separate worktree branch to merge.
* **Required Fix:**
  * Specify that `create_ref_checkpoint` copies `.git/index` to `.git/hy-checkpoints/<run-id>/r<N>.index` (or runs `git read-tree HEAD` into `GIT_INDEX_FILE`), runs `git add -u` + `git write-tree` + `git commit-tree`, updates `refs/hy/checkpoints/<run-id>/r<N>`, and writes pre-existing untracked paths (`git ls-files --others --exclude-standard`) to `.git/hy-checkpoints/<run-id>/r<N>.untracked.json`.
  * Standardize rollback across all sections on `git read-tree refs/hy/checkpoints/<run-id>/r<N>` + `git checkout-index -f -a`, followed by deleting only newly created untracked files (diffing `git ls-files --others --exclude-standard` against `r<N>.untracked.json`), leaving `HEAD` and `node_modules/`/`target/` untouched.
  * Replace *"Merge only when both gates pass"* in Line 299 with *"Finalize the in-tree state and prune `refs/hy/checkpoints/<run-id>/*` when both gates pass"*.

#### ACT-B2: Resolve `verifier-ralph` State Transition on Gate Rejection vs Timeout/Crash
* **Source Findings:** `COMP-1`, `DES-6`, `IZO-2`
* **Affected Lines:** [design_draft.md#L61-L63](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L61-L63), [L133-L136](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L133-L136), [L299-L300](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L299-L300)
* **Problem:**
  Line 133 states that rollback to `r<N>` runs when a round *"times out, crashes, or is rejected"*, whereas Lines 61–63 and 300 pass test failure diagnostics to Round $N+1$ to fix the issues. Rolling back on gate rejection wipes out the edits whose test failures Round $N+1$ is asked to fix.
* **Required Fix:**
  * **On Timeout, Crash, or Abort:** Roll back working tree to `refs/hy/checkpoints/<run-id>/r<N>` and discard uncommitted session log events from Round $N$.
  * **On Verification Gate Rejection (Stage 1 or Stage 2 Failure):** Keep Round $N$'s file edits in the working tree (unless the worker broke syntax/build beyond recovery and the Grader flags `rollbackRecommended: true`), snapshot `refs/hy/checkpoints/<run-id>/r<N+1>` before spawning Round $N+1$, prefix Round $N$'s Rationale Ledger additions with `[Round N]`, and pass the failure digest to Round $N+1$.

#### ACT-B3: Specify `hy-ptc-worker` IPC Conduit Over DACL-Configured `stdio` (Avoiding Win32 `fd 3` and `--permission` Named Pipe Block)
* **Source Findings:** `CBD-3`, `IR-3`, `COMP-7`, `DES-9`
* **Affected Lines:** [design_draft.md#L50](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L50), [L119](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L119), [L279](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L279)
* **Problem:**
  Win32 `CreateProcessAsUserW` does not pass POSIX `fd 3` handles to Node.js without undocumented MSVC CRT `lpReserved2` structures, and Node.js `--permission` blocks `net.connect()` to Windows Named Pipes (`\\.\pipe\...`) with `ERR_ACCESS_DENIED` unless `--allow-net` is enabled (which breaks network confinement).
* **Required Fix:**
  * Specify that `hy-ptc-worker` communicates over its standard `stdin` and `stdout` pipes (created by `hy-exec-server` with explicit Restricted-SID DACLs) using newline-delimited JSON-RPC 2.0 (`ptc/toolCall`, `ptc/toolResult`, `ptc/log`, `ptc/complete`).
  * Specify that the TypeScript control plane strips TypeScript types (`ts.transpileModule` or Node `stripTypeScriptTypes`) before sending the JS payload, and `hy-exec-server` spawns `node --permission --allow-fs-read=<worker_runtime_dir> worker.mjs` with zero network or child-process permissions.

#### ACT-B4: Define Explicit Phased Implementation Roadmap & Verification Checkpoints (Phase 0–Phase 5)
* **Source Findings:** `IR-1`, `CBD-1`
* **Affected Lines:** [design_draft.md#L198-L320](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L198-L320)
* **Problem:**
  `design_draft.md` presents a flat list of 21 file items without chronological phases or phase-exit build/test gates, violating the Implementation Readiness Standard.
* **Required Fix:**
  * Organize the Detailed Implementation Plan into explicit sequential phases (Phase 0: Workspace & JSON-RPC Protocol, Phase 1: Rust Execution Daemon & Win10 Restricted Sandbox, Phase 2: Cordis Control Plane & Session Log/Rationale Ledger, Phase 3: Tiered ACI & Isolated PTC Runtime, Phase 4: SpillStore, Compaction & Guardian, Phase 5: Verifier-Gated Ralph & CLI) with explicit build/test checkpoint commands per phase.

#### ACT-B5: Define Complete JSON-RPC 2.0 Wire Contract & TypeScript `ExecRpcClient`
* **Source Findings:** `IR-2`, `CBD-5`
* **Affected Lines:** [design_draft.md#L212-L216](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L212-L216), [L241-L245](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L241-L245)
* **Problem:**
  Exact JSON-RPC 2.0 method strings, request/response field schemas (including background job operations), error codes, and the TypeScript client module (`ctx.execRpc`) are omitted.
* **Required Fix:**
  * Define the exact JSON-RPC methods (`exec/command`, `job/status`, `job/wait`, `job/kill`, `patch/apply`, `checkpoint/create`, `checkpoint/rollback`, `policy/evaluate`, `ptc/run`), their request/response types in `crates/hy-protocol`, standard error codes (`-32001` PolicyDenied, `-32002` SandboxViolation, `-32003` PatchConflict, `-32004` CheckpointError), and the TypeScript `ExecRpcClient` in `packages/core`.

#### ACT-B6: Define 4 Core Tool Schemas & `claim_complete` Completion Protocol
* **Source Findings:** `COMP-2`, `COMP-4`, `IZO-3`
* **Affected Lines:** [design_draft.md#L28](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L28), [L61](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L61), [L116-L120](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L116-L120), [L134](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L134), [L244](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L244)
* **Problem:**
  The exact parameter schemas for `read_file`, `apply_patch`, `bash`, and `run_code` are missing; how a child worker signals `claim_complete` is undefined; and the `apply_patch` post-edit syntax check engine is unspecified.
* **Required Fix:**
  * Define the exact input/output schemas for `read_file({ path, startLine?, endLine? })`, `apply_patch({ patch })`, `bash({ command, cwd?, timeoutMs? })`, and `run_code({ code, description })`.
  * Specify that a child worker signals `claim_complete` either by returning a final assistant response with zero tool calls (natural turn completion) or by calling `tools.objective.claimComplete({ summary })` inside `run_code`.
  * Following `IZO-3`, scope `apply_patch` validation in `hy-exec-server` to unified-diff hunk application, UTF-8 validity, and native JSON/TOML parse checks, delegating compiler syntax/type checks to the Stage 1 Computational Gate.

#### ACT-B7: Add Dedicated `## Risks & Mitigations` Section
* **Source Findings:** `DES-1`, `STR-1`
* **Affected Lines:** [design_draft.md#L166-L181](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L166-L181)
* **Problem:**
  `feature-spec-standard.md` requires a dedicated `## Risks & Mitigations` section covering architectural limits and failure modes.
* **Required Fix:**
  * Add `## Risks & Mitigations` detailing: (1) Windows 10 Low-Integrity ambient read access & host environment sanitization (`DES-3`), (2) NTFS directory junction and hard-link escapes (`DES-2`, `IZO-4`), (3) Windows NTFS file locking (`ERROR_SHARING_VIOLATION`) during rollback (`DES-4`, `IZO-5`), (4) Shell command chaining bypasses in `execpolicy` (`DES-5`, `IZO-1`), and (5) Indirect prompt injection against the Stage 2 `Grader` (`DES-7`).

---

### 🟡 Major Issues (11 Items)

#### ACT-M1: Consolidate Monorepo Packages & Reuse Existing `cordis` Library (Zoom-Out Simplification)
* **Source Findings:** `ZO-1`, `ZO-2`, `ZO-3`, `ZO-5`, `ZO-6`, `ZO-7`, `IR-7`, `IZO-6`
* **Affected Lines:** [design_draft.md#L70-L105](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L70-L105), [L200-L305](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L200-L305)
* **Required Fix:**
  * Import `cordis` from npm (with a thin typed wrapper) rather than re-implementing `cordis-kernel` from scratch (`ZO-1`, `IR-7`).
  * Consolidate the 18 subprojects into a cleaner layout: 4 Rust crates (`hy-protocol`, `hy-execpolicy`, `hy-sandbox-windows`, `hy-exec-server` containing `checkpoint` module) and 3 TypeScript packages (`packages/core`, `packages/seams`, `packages/hy-cli`) (`ZO-2`).
  * Defer Linux/macOS sandboxing (`hy-sandbox-posix`) and multi-language LSP daemon management (`packages/seams/lsp`) to Future Improvements, keeping v1 focused on the Windows 10 critical path (`ZO-3`, `ZO-5`).
  * Remove the speculative `ImageOffload` step, `create_isolated_worktree()`, and undefined `WorldStateSnapshot` (`ZO-6`, `ZO-7`, `COMP-5`, `IZO-6`).

#### ACT-M2: Simplify `Guardian` to a Stateless Classification Call & Define Decision Schema
* **Source Findings:** `ZO-4`, `COMP-9`, `CBD-7`
* **Affected Lines:** [design_draft.md#L90](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L90), [L132](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L132), [L291-L295](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L291-L295)
* **Required Fix:**
  * Replace the complex trunk-fork state machine in `Guardian` with a stateless single-turn read-only classification request returning `{ approved: boolean, riskScore: number, reason: string }` (approving when `riskScore < 80`). When `TooManyDenials` (3 consecutive denials) trips, escalate to an interactive user prompt in CLI mode or abort the round in headless `ralph` mode.

#### ACT-M3: Specify Windows 10 Sandbox Win32 APIs, `WorkspaceWrite` Mechanics, Junction Canonicalization & Env Sanitization
* **Source Findings:** `DES-2`, `DES-3`, `COMP-11`, `CBD-4`, `IZO-4`
* **Affected Lines:** [design_draft.md#L124-L129](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L124-L129), [L222-L230](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L222-L230)
* **Required Fix:**
  * Specify spawning via `CreateProcessAsUserW` with `CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT`, assigning the Job Object (`AssignProcessToJobObject`), and resuming (`ResumeThread`).
  * Specify how `WorkspaceWrite` works without O(N) recursive ACL traversal: all file edits via `apply_patch` are brokered by `hy-exec-server` after checking `std::fs::canonicalize(target).starts_with(canonical_workspace_root)` (blocking NTFS directory junctions) and `GetFileInformationByHandle` (`nNumberOfLinks > 1`) + `FindFirstFileNameW` (prepending volume drive root from `GetVolumePathNameW`), while shell commands in `bash` receive write DACL + Low Mandatory Integrity ACE only on a dedicated `.hy-harness/tmp` scratch directory (or opt-in target subdirectories).
  * Strip host secret environment variables (`*_API_KEY`, `*_TOKEN`, `*_SECRET`, `AWS_*`, `GITHUB_TOKEN`) before spawning child processes, and list the required `windows-sys` Cargo features.

#### ACT-M4: Terminate Round Job Object Before Rollback + 3x100ms Retry for NTFS File Locks
* **Source Findings:** `DES-4`, `IZO-5`
* **Affected Lines:** [design_draft.md#L133](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L133), [L239](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L239)
* **Required Fix:**
  * Before running checkpoint rollback, terminate all background jobs belonging to the round's Job Object to release open Windows file handles, then execute `git read-tree` + `git checkout-index -f -a` in a 3-attempt loop with a 100 ms sleep to clear transient Windows Defender locks.

#### ACT-M5: Enforce Fail-Closed Compound Operator Gate in `hy-execpolicy`
* **Source Findings:** `DES-5`, `IR-6`, `IZO-1`
* **Affected Lines:** [design_draft.md#L123](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L123), [L217-L221](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L217-L221)
* **Required Fix:**
  * Define `pub fn evaluate(&self, command: &str) -> PolicyDecision` (`Allow`, `Prompt`, `Deny`). If `command` contains shell chaining or subshell characters (`&`, `|`, `;`, `` ` ``, `$(`, `>`, `<`), immediately return `PolicyDecision::Prompt` (or `Deny` if matched by a deny rule) rather than building a complex shell parser; otherwise tokenize simple whitespace/quoted `argv` and match against `prefix_rule` patterns (`Deny > Prompt > Allow`, defaulting unmatched commands to `Prompt`).

#### ACT-M6: Defensive XML Delimiters & JSON Schema for Stage 2 `Grader`
* **Source Findings:** `DES-7`
* **Affected Lines:** [design_draft.md#L136](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L136), [L299](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L299)
* **Required Fix:**
  * Wrap `git diff` and test output in `<untrusted_git_diff>` and `<untrusted_test_output>` tags in the `Grader` prompt with explicit instructions to ignore embedded directives, and validate the response against `{ pass: boolean, unmetCriteria: string[], rollbackRecommended: boolean, reasoning: string }`.

#### ACT-M7: Align Mermaid Architecture Diagram with Two-Plane Process Topology
* **Source Findings:** `COMP-6`
* **Affected Lines:** [design_draft.md#L73-L105](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L73-L105)
* **Required Fix:**
  * Update the Mermaid diagram to show the two physical planes—TypeScript Control Plane (`CP`) and Rust Execution Plane (`EP`) connected via `JSON-RPC 2.0 over Stdio`—placing `Guards`, `Guardian`, and `Verifier` inside `CP` and `Starlark ExecPolicy` inside `EP`.

#### ACT-M8: Define `SessionEventMap` Interfaces, `SpillStore` Layout, Compaction Threshold & `ReadBeforeEditGuard` Exception
* **Source Findings:** `IR-4`, `COMP-10`, `CBD-7`
* **Affected Lines:** [design_draft.md#L110-L111](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L110-L111), [L251-L255](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L251-L255), [L269](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L269), [L281-L285](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L281-L285)
* **Required Fix:**
  * Define `SessionEventMap` payload interfaces, specify `updatedAtStep` (`least-recently-updated`) eviction for the Rationale Ledger using `Math.ceil(byteLength / 4)` token estimation, specify `.hy-harness/spill/<session-id>/<call-id>.txt` and the 75% context window trigger for compaction, and state that `ReadBeforeEditGuard` exempts newly created files that do not yet exist on disk.

#### ACT-M9: Specify Configuration File Schema (`.hy-harness/config.json`) & `tracing` Stderr Logger
* **Source Findings:** `COMP-8`, `CBD-6`
* **Affected Lines:** [design_draft.md#L112](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L112), [L205](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L205), [L243](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L243), [L304](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L304)
* **Required Fix:**
  * Define `.hy-harness/config.json` (storing role-to-provider model mappings, 4D budgets, and policy path `.hy-harness/policies/default.star`) and configure `tracing-subscriber` in `hy-exec-server` to write exclusively to `std::io::stderr`.

#### ACT-M10: Fix Structural Heading Hierarchy & Add `Rollout & Operational Recovery` to NFRs
* **Source Findings:** `STR-2`, `STR-3`
* **Affected Lines:** [design_draft.md#L168-L195](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L168-L195)
* **Required Fix:**
  * Add `Rollout & Operational Recovery` under `## Non-Functional Requirements`, and promote `### Additional Resources` and `### Future Improvements` to H2 (`##`).

#### ACT-M11: Eliminate Academic Jargon, Hyperbole & Subjective Phrasing
* **Source Findings:** `STY-1`, `STY-2`, `STY-3`, `STY-6`, `STY-7`
* **Affected Lines:** [design_draft.md#L23](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L23), [L29](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L29), [L31](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L31), [L145-L158](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L145-L158), [L248-L249](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L248-L249), [L311](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L311)
* **Required Fix:**
  * Replace *"spatiotemporal composability"* / *"reactive coeffects"* with *"dynamic plugin lifecycle and revertible cleanup effects (`ctx.effect`)"* / *"service dependency injection"*.
  * Replace *"Instant"* with *"Fast (< 500 ms)"*, *"Zero Context Rationale Erosion"* with *"Deterministic Rationale Preservation"*, and replace subjective descriptors in `Alternatives Considered` with objective engineering statements.
  * Separate functional rollback assertions in `verifier-ralph.test.ts` from the `< 500 ms` benchmark target.

---

### 🟢 Nits (6 Items)

* **ACT-N1 (`ZO-8`):** Clarify that $K=12$ / 1,500 tokens, 5,000 ms foreground timeout, 32 KB spill threshold, and `maxParallelSubCalls = 10` are configurable defaults in `.hy-harness/config.json`.
* **ACT-N2 (`COMP-12`, `COMP-13`, `STY-4`):** Expand `PTC` (Programmatic Tool Calling) and `ACI` (Agent-Computer Interface) on first use, standardize Windows 11 MXC version references to `Windows 11 24H2+`, and use descriptive sandbox backend names.
* **ACT-N3 (`COMP-14`, `IR-8`):** Document CLI flags for `hy run`, `hy ralph`, `hy rpc-server`, and `hy policy-test`.
* **ACT-N4 (`DES-8`, `CBD-9`, `CBD-10`):** Specify an async Reader-Writer lock (`RwLock`) for concurrent PTC sub-calls, use `starlark` consistently as the crate name, and include `MockLlmProvider` for offline unit tests.
* **ACT-N5 (`STR-4`):** Use uniform `file:///` links in `## Additional Resources`.
* **ACT-N6 (`STY-5`, `STY-8`):** Replace informal wording (*"cuts"*, *"suffers from"*, *"Locked-Down"*, *"Monotonic Guards"*, *"asks `hy-exec-server`"*) and split the compound sentence in the `hy-exec-server` item.

---

## 3. Cross-Stage Traceability Matrix

| Stage | Raw Finding ID | Reviewer | Severity | Consolidated Action ID | Summary |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Stage 5 | `ZO-1` | `egm-zoom-out` | Major | `ACT-M1` | Reuse `cordis` npm package instead of re-implementing kernel |
| Stage 5 | `ZO-2` | `egm-zoom-out` | Major | `ACT-M1` | Consolidate 18 subprojects into 4 Rust crates + 3 TS packages |
| Stage 5 | `ZO-3` | `egm-zoom-out` | Major | `ACT-M1` | Defer `hy-sandbox-posix` to Future Improvements |
| Stage 5 | `ZO-4` | `egm-zoom-out` | Major | `ACT-M2` | Simplify `Guardian` to stateless classification call |
| Stage 5 | `ZO-5` | `egm-zoom-out` | Major | `ACT-M1` | Defer multi-language stdio LSP daemon to Future Improvements |
| Stage 5 | `ZO-6` | `egm-zoom-out` | Nit | `ACT-M1` | Remove speculative `ImageOffload` compaction step |
| Stage 5 | `ZO-7` | `egm-zoom-out` | Nit | `ACT-M1` | Defer `create_isolated_worktree()` in `hy-checkpoint` |
| Stage 5 | `ZO-8` | `egm-zoom-out` | Nit | `ACT-N1` | Document magic numbers as configurable defaults |
| Stage 6 | `COMP-1` | `egm-comprehension` | Blocker | `ACT-B2` | Disambiguate rollback on timeout/crash vs gate rejection |
| Stage 6 | `COMP-2` | `egm-comprehension` | Blocker | `ACT-B6` | Define `claim_complete` signaling protocol |
| Stage 6 | `COMP-3` | `egm-comprehension` | Blocker | `ACT-B1` | Unify rollback on `git read-tree` + `git checkout-index` |
| Stage 6 | `COMP-4` | `egm-comprehension` | Blocker | `ACT-B6` | Define 4 core tool schemas and `apply_patch` validation scope |
| Stage 6 | `COMP-5` | `egm-comprehension` | Major | `ACT-M1` | Remove undefined `WorldStateSnapshot` |
| Stage 6 | `COMP-6` | `egm-comprehension` | Major | `ACT-M7` | Align Mermaid diagram with 2-plane physical architecture |
| Stage 6 | `COMP-7` | `egm-comprehension` | Major | `ACT-B3` | Specify `hy-ptc-worker` stdio JSON-RPC IPC conduit |
| Stage 6 | `COMP-8` | `egm-comprehension` | Major | `ACT-M9` | Specify `.hy-harness/config.json` and `.star` policy path |
| Stage 6 | `COMP-9` | `egm-comprehension` | Major | `ACT-M2` | Specify `Guardian` response schema and `TooManyDenials` action |
| Stage 6 | `COMP-10` | `egm-comprehension` | Major | `ACT-M8` | Specify `SpillStore` path, `SpillRef`, and 75% compaction threshold |
| Stage 6 | `COMP-11` | `egm-comprehension` | Major | `ACT-M3` | Specify Windows 10 Low-Integrity `WorkspaceWrite` mechanism |
| Stage 6 | `COMP-12` | `egm-comprehension` | Nit | `ACT-N2` | Expand `PTC` and `ACI` acronyms on first use |
| Stage 6 | `COMP-13` | `egm-comprehension` | Nit | `ACT-N2` | Standardize Windows 11 MXC version to `24H2+` |
| Stage 6 | `COMP-14` | `egm-comprehension` | Nit | `ACT-N3` | Specify CLI subcommand arguments and flags |
| Stage 7 | `DES-1` | `egm-design` | Blocker | `ACT-B7` | Add dedicated `## Risks & Mitigations` section |
| Stage 7 | `DES-2` | `egm-design` | Major | `ACT-M3` | Block NTFS directory junctions via canonical path containment |
| Stage 7 | `DES-3` | `egm-design` | Major | `ACT-M3` | Document Win10 read/network boundary & sanitize host env vars |
| Stage 7 | `DES-4` | `egm-design` | Major | `ACT-M4` | Terminate Job Object before rollback + 3x100ms retry |
| Stage 7 | `DES-5` | `egm-design` | Major | `ACT-M5` | Prevent shell command chaining bypasses in `execpolicy` |
| Stage 7 | `DES-6` | `egm-design` | Major | `ACT-B2` | Prevent Rationale Ledger contamination across failed rounds |
| Stage 7 | `DES-7` | `egm-design` | Major | `ACT-M6` | Isolate `Grader` inputs in `<untrusted_*>` XML tags + JSON schema |
| Stage 7 | `DES-8` | `egm-design` | Nit | `ACT-N4` | Specify async `RwLock` for concurrent PTC sub-calls |
| Stage 7 | `DES-9` | `egm-design` | Nit | `ACT-B3` | Specify Node `--permission --allow-fs-read` & host TS stripping |
| Stage 7 | `STR-1` | `egm-structural` | Major | `ACT-B7` | Add `## Risks & Mitigations` section |
| Stage 7 | `STR-2` | `egm-structural` | Major | `ACT-M10` | Add `Rollout & Operational Recovery` to NFRs |
| Stage 7 | `STR-3` | `egm-structural` | Major | `ACT-M10` | Promote `Additional Resources` and `Future Improvements` to H2 |
| Stage 7 | `STR-4` | `egm-structural` | Nit | `ACT-N5` | Standardize `file:///` links in `Additional Resources` |
| Stage 7 | `STY-1` | `egm-style` | Major | `ACT-M11` | Replace "spatiotemporal composability" with concrete mechanism |
| Stage 7 | `STY-2` | `egm-style` | Major | `ACT-M11` | Replace "Instant" and "Zero Erosion" hyperbole |
| Stage 7 | `STY-3` | `egm-style` | Major | `ACT-M11` | Replace subjective adjectives in `Alternatives Considered` |
| Stage 7 | `STY-4` | `egm-style` | Nit | `ACT-N2` | Clarify sandbox tier labels and remove undefined slogans |
| Stage 7 | `STY-5` | `egm-style` | Nit | `ACT-N6` | Replace informal diction ("cuts", "suffers from", "Locked-Down") |
| Stage 8 | `IZO-1` | `egm-zoom-out` | Major | `ACT-M5` | Fail-closed gate on compound operators (`[&|;`$()<>]`) instead of AST parser |
| Stage 8 | `IZO-2` | `egm-zoom-out` | Major | `ACT-B2` | Round-scoped event rollback & `[Round N]` prefix instead of 2PC state machine |
| Stage 8 | `IZO-3` | `egm-zoom-out` | Major | `ACT-B6` | Keep `apply_patch` validation lightweight; run compilers in Stage 1 gate |
| Stage 8 | `IZO-4` | `egm-zoom-out` | Nit | `ACT-M3` | Use `std::fs::canonicalize` for NTFS junction containment |
| Stage 8 | `IZO-5` | `egm-zoom-out` | Nit | `ACT-M4` | Kill Job Object + fixed 3x100ms retry on rollback |
| Stage 8 | `IZO-6` | `egm-zoom-out` | Nit | `ACT-M1` | Delete undefined `WorldStateSnapshot` |
| Stage 9 | `IR-1` | `egm-implementation-readiness` | Blocker | `ACT-B4` | Partition Detailed Implementation Plan into sequential phases |
| Stage 9 | `IR-2` | `egm-implementation-readiness` | Blocker | `ACT-B5` | Define JSON-RPC 2.0 methods, payload schemas, and error codes |
| Stage 9 | `IR-3` | `egm-implementation-readiness` | Major | `ACT-B3` | Define `hy-ptc-worker` stdio JSON-RPC framing |
| Stage 9 | `IR-4` | `egm-implementation-readiness` | Major | `ACT-M8` | Define `SessionEventMap` interfaces & `updatedAtStep` eviction |
| Stage 9 | `IR-5` | `egm-implementation-readiness` | Major | `ACT-B1` | Define untracked file manifest storage & rollback cleanup |
| Stage 9 | `IR-6` | `egm-implementation-readiness` | Major | `ACT-M5` | Define `ExecPolicy::evaluate` signature and operator gate |
| Stage 9 | `IR-7` | `egm-implementation-readiness` | Nit | `ACT-M1` | Clarify importing `cordis` npm package |
| Stage 9 | `IR-8` | `egm-implementation-readiness` | Nit | `ACT-N3` | Specify CLI flags and config precedence |
| Stage 9 | `CBD-1` | `egm-codebase-details` | Blocker | `ACT-B4` | Add Phase 0–Phase 5 execution order and checkpoints |
| Stage 9 | `CBD-2` | `egm-codebase-details` | Blocker | `ACT-B1` | Initialize `GIT_INDEX_FILE` from `.git/index` before `git add -u` |
| Stage 9 | `CBD-3` | `egm-codebase-details` | Blocker | `ACT-B3` | Use DACL-configured stdio JSON-RPC for `hy-ptc-worker` |
| Stage 9 | `CBD-4` | `egm-codebase-details` | Major | `ACT-M3` | Specify `CreateProcessAsUserW`, `CREATE_SUSPENDED`, drive prefix on `FindFirstFileNameW` |
| Stage 9 | `CBD-5` | `egm-codebase-details` | Major | `ACT-B5` | Add `Job*Request` payloads and TypeScript `ExecRpcClient` |
| Stage 9 | `CBD-6` | `egm-codebase-details` | Major | `ACT-M9` | Configure `tracing-subscriber` to write to `stderr` |
| Stage 9 | `CBD-7` | `egm-codebase-details` | Major | `ACT-M8` | Exempt new files in `ReadBeforeEditGuard` & define token heuristic |
| Stage 9 | `CBD-8` | `egm-codebase-details` | Major | `ACT-B1` | Replace "Merge" wording with in-tree finalization |
| Stage 9 | `CBD-9` | `egm-codebase-details` | Nit | `ACT-N4` | Use `starlark` crate name consistently |
| Stage 9 | `CBD-10` | `egm-codebase-details` | Nit | `ACT-N4` | Add `MockLlmProvider` for offline testing |
| Stage 9 | `STY-6` | `egm-style` | Major | `ACT-M11` | Replace "Spatiotemporal Microkernel" and "reactive coeffects" |
| Stage 9 | `STY-7` | `egm-style` | Major | `ACT-M11` | Separate `< 500 ms` benchmark from functional integration test |
| Stage 9 | `STY-8` | `egm-style` | Nit | `ACT-N6` | Fix informal terms and compound sentence in Detailed Plan |
