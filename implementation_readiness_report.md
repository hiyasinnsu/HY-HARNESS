# Stage 9: Implementation Readiness Test Report (`implementation_readiness_report.md`)

* **Target Document:** [design_draft.md](file:///g:/マイドライブ/HY-HARNESS/design_draft.md) (`DetailedRange: 198..325`)
* **Standard:** `implementation-readiness-standard.md`
* **Reviewers:**
  * `egm-implementation-readiness` (`b0c7b703-a84e-4fce-9266-56f22eb2ce6e`)
  * `egm-codebase-details` (`6e699833-3912-4050-9825-fb05aff7df8e`)
  * `egm-style` (`e59b6ef7-66d2-4289-83ab-6c07e5e3346a`)

---

## 1. Implementation Readiness Findings (`egm-implementation-readiness`)

### IR-1: Missing Chronological Phasing & Incremental Build Checkpoints
* **Severity:** Blocker
* **Affected Scope:** [design_draft.md#L198-L320](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L198-L320).
* **Finding & Guidance:**
  `implementation-readiness-standard.md` ("Phasing & Checkpoints") mandates partitioning work into logical, incremental phases where each phase leaves the codebase in a stable, buildable, and testable state. `design_draft.md` lists 21 files as a flat checklist without grouping them into sequential phases (Phase 0 through Phase 5) or defining phase-exit verification commands.

### IR-2: Undefined JSON-RPC 2.0 Wire Contract Between TypeScript and `hy-exec-server`
* **Severity:** Blocker
* **Affected Scope:** Item 3 ([design_draft.md#L212-L216](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L212-L216)) and Item 8 ([L241-L245](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L241-L245)).
* **Finding & Guidance:**
  The plan names Rust types (`ExecCommandRequest`, `ExecCommandResult`, `ApplyPatchRequest`, `CheckpointCreateRequest`, `CheckpointRollbackRequest`, `PolicyEvalRequest`) in prose without specifying exact JSON-RPC method strings (e.g., `exec/command`, `job/status`, `job/wait`, `job/kill`, `patch/apply`, `checkpoint/create`, `checkpoint/rollback`, `policy/evaluate`), field types, or numeric JSON-RPC error codes.

### IR-3: Undefined IPC Framing Protocol for `hy-ptc-worker`
* **Severity:** Major
* **Affected Scope:** Item 15 ([design_draft.md#L276-L280](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L276-L280)) and Item 8 ([L241-L245](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L241-L245)).
* **Finding & Guidance:**
  Specify the exact IPC framing format (newline-delimited JSON-RPC over the worker's `stdin`/`stdout` pipes created with explicit DACLs by `hy-exec-server`), request/response envelope schemas for `tools.*` sub-calls, and the final completion payload (`{ status: "ok" | "error", value?: unknown, error?: string, logs: string[] }`).

### IR-4: Missing TypeScript `SessionEvent` Payloads & Eviction Tie-Breaking Rule
* **Severity:** Major
* **Affected Scope:** Item 10 ([design_draft.md#L251-L255](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L251-L255), cross-referencing [L111](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L111)).
* **Finding & Guidance:**
  Define explicit TypeScript interfaces for `SessionEventMap` payloads and unify the Rationale Ledger eviction wording to strictly evict the entry with the oldest `updatedAtStep` (`least-recently-updated`).

### IR-5: Underspecified Untracked File Snapshot Storage & Locked-File Rollback Retry
* **Severity:** Major
* **Affected Scope:** Item 7 ([design_draft.md#L236-L240](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L236-L240)).
* **Finding & Guidance:**
  Specify where the pre-round untracked file manifest (`git ls-files --others --exclude-standard`) is stored (e.g., `.git/hy-checkpoints/<run-id>/r<round>-untracked.json`) and how locked files on Windows NTFS are handled during rollback (terminate round Job Object first, then retry deletion with backoff).

### IR-6: Undefined `ExecPolicy` Rust Evaluation API and Tokenization Rules
* **Severity:** Major
* **Affected Scope:** Item 4 ([design_draft.md#L217-L221](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L217-L221)).
* **Finding & Guidance:**
  Define the Rust signature `pub fn evaluate_command(&self, argv: &[String]) -> PolicyDecision` (`Allow`, `Prompt`, `Deny`) and how compound shell strings are split on operators (`&&`, `||`, `;`, `|`) before matching `prefix_rule` patterns.

### IR-7: Ambiguity Between Importing `cordis` vs Custom Kernel Implementation
* **Severity:** Nit
* **Affected Scope:** Item 9 ([design_draft.md#L246-L250](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L246-L250)).
* **Finding & Guidance:**
  Clarify whether `packages/core/cordis-kernel` wraps the `cordis` npm package or implements a lightweight zero-dependency lifecycle kernel.

### IR-8: Unspecified CLI Flags and Configuration File Precedence
* **Severity:** Nit
* **Affected Scope:** Item 20 ([design_draft.md#L301-L305](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L301-L305)).
* **Finding & Guidance:**
  Specify CLI flags (`--objective`, `--verify-cmd`, `--max-rounds`, `--max-cost-usd`, `--config`) and config precedence (CLI flags > environment variables > `.hy-harness/config.json`).

---

## 2. Codebase & Technical Details Auditor Findings (`egm-codebase-details`)

### CBD-1: Missing Phasing Roadmap in `design_draft.md`
* **Severity:** Blocker
* **Affected Scope:** [design_draft.md#L198-L325](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L198-L325).
* **Discrepancy Description & Rationale:**
  Duplicate of `IR-1`: bring the Phase 0–Phase 5 structure and verification gates from `docs/designs/hy-harness-implementation-plan.md` into `design_draft.md`.

### CBD-2: Git Ref Checkpoint `GIT_INDEX_FILE` Initialization Defect & `HEAD` Preservation
* **Severity:** Blocker
* **Affected Scope:** [design_draft.md#L239](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L239) vs [L133](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L133) (`crates/hy-checkpoint`).
* **Discrepancy Description & Rationale:**
  1. In Git plumbing, pointing `GIT_INDEX_FILE` to a non-existent temporary path starts with an empty index; running `git add -u` against an empty index stages zero files and writes an empty tree (`4b825dc...`). `create_ref_checkpoint` MUST first copy `.git/index` to the temporary `GIT_INDEX_FILE` (or run `git read-tree HEAD`) before running `git add -u` + `git write-tree` + `git commit-tree`.
  2. Unify Line 133 and Line 239 so rollback uses `git read-tree refs/hy/checkpoints/<run-id>/r<N>` + `git checkout-index -f -a` (preserving `HEAD` and current branch state) instead of `git reset --hard`.

### CBD-3: Windows IPC & Node.js `--permission` Incompatibility (`fd 3` and Named Pipes)
* **Severity:** Blocker
* **Affected Scope:** [design_draft.md#L279](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L279) (`packages/seams/ptc-runtime`).
* **Discrepancy Description & Rationale:**
  1. Win32 `CreateProcessAsUserW` does not pass arbitrary POSIX file descriptors like `fd 3` to Node.js without constructing undocumented MSVC CRT `lpReserved2` buffers.
  2. Under Node.js `--permission`, connecting to a Windows Named Pipe (`\\.\pipe\...`) via `node:net` is blocked unless `--allow-net` is granted (which would defeat network isolation!).
  3. Therefore, `hy-ptc-worker` MUST communicate over its standard `stdin`/`stdout` handles (created with explicit DACLs by `hy-exec-server`), framing `tools.*` sub-calls and console output as newline-delimited JSON-RPC 2.0 messages over `stdin`/`stdout`, with `--permission --allow-fs-read=<worker_bundle_dir>` and pre-stripped JavaScript (`worker.mjs`).

### CBD-4: Omitted Win32 API Specifics (`CreateProcessAsUserW`, `CREATE_SUSPENDED`, Drive-Letter Prefix on `FindFirstFileNameW`, `windows-sys` Features)
* **Severity:** Major
* **Affected Scope:** [design_draft.md#L226-L230](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L226-L230) (`crates/hy-sandbox-windows`).
* **Discrepancy Description & Rationale:**
  1. `FindFirstFileNameW` returns volume-relative paths (`\path\to\file`) without a drive letter (`C:`); the drive root from `GetVolumePathNameW` must be prepended before comparing with `workspace_root`, alongside `GetFinalPathNameByHandleW` to block NTFS directory junctions.
  2. Spawn restricted tokens via `CreateProcessAsUserW` with `CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT`, bind to the Job Object via `AssignProcessToJobObject`, and then call `ResumeThread` so no child process can fork before Job Object assignment.
  3. Specify required `windows-sys` Cargo features (`Win32_Foundation`, `Win32_Security`, `Win32_Security_Authorization`, `Win32_Storage_FileSystem`, `Win32_System_JobObjects`, `Win32_System_Threading`, `Win32_System_StationsAndDesktops`).

### CBD-5: Missing TypeScript JSON-RPC Client Module and Background Job Protocol Types
* **Severity:** Major
* **Affected Scope:** [design_draft.md#L215](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L215), [L243-L245](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L243-L245), [L269](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L269).
* **Discrepancy Description & Rationale:**
  Add `JobStatusRequest`, `JobWaitRequest`, and `JobKillRequest` to `crates/hy-protocol`, and explicitly include the TypeScript `ExecRpcClient` service (`ctx.execRpc`) for communicating with `hy-exec-server` over stdio.

### CBD-6: `tracing` Logging to `stderr` in Stdio JSON-RPC Daemon
* **Severity:** Major
* **Affected Scope:** [design_draft.md#L205](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L205), [L243](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L243).
* **Discrepancy Description & Rationale:**
  Include `tracing` and `tracing-subscriber` in `Cargo.toml` configured to write structured logs strictly to `std::io::stderr` so `stdout` remains pure JSON-RPC while respecting `deny(clippy::print_stdout, clippy::print_stderr)`.

### CBD-7: Concrete Guard Rules (New-File Exception in `ReadBeforeEditGuard`, Token Counting, Syntax Check Commands)
* **Severity:** Major
* **Affected Scope:** [design_draft.md#L244](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L244), [L254](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L254), [L269](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L269).
* **Discrepancy Description & Rationale:**
  Specify that `ReadBeforeEditGuard` exempts non-existent (newly created) target paths, specify the token estimator (`Math.ceil(byteLength / 4)`), and specify the syntax check behavior in `apply_patch`.

### CBD-8: In-Tree Finalization Wording vs "Merge" in `verifier-ralph`
* **Severity:** Major
* **Affected Scope:** [design_draft.md#L299](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L299).
* **Discrepancy Description & Rationale:**
  Because sequential rounds operate in-tree with Git ref checkpoints (`refs/hy/checkpoints/`), passing both verification gates finalizes the working tree state and cleans up temporary checkpoint refs rather than executing a Git branch merge.

### CBD-9: `starlark` Crate Naming Consistency
* **Severity:** Nit
* **Affected Scope:** [design_draft.md#L205](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L205), [L220](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L220).
* **Discrepancy Description & Rationale:**
  Refer consistently to the `starlark` crate on crates.io.

### CBD-10: Deterministic `MockLlmAdapter` for Offline Unit & Integration Tests
* **Severity:** Nit
* **Affected Scope:** [design_draft.md#L259](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L259), [L316](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L316).
* **Discrepancy Description & Rationale:**
  Include a deterministic `MockLlmProvider` in `packages/core/llm-router` so unit and integration tests run offline without external API keys.

---

## 3. Style Critic Findings (`egm-style`, DetailedRange)

### STY-6: Academic Jargon in Item 9 ("Spatiotemporal Microkernel", "reactive coeffects")
* **Severity:** Major
* **Affected Scope:** [design_draft.md#L248-L249](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L248-L249).
* **Style Rationale:**
  Replace *"Spatiotemporal Microkernel"* and *"reactive coeffects"* with *"Plugin Lifecycle & Dependency Injection Kernel"* and *"service dependency injection"*.

### STY-7: Benchmark Latency Assertion Inside Functional Integration Test Item
* **Severity:** Major
* **Affected Scope:** [design_draft.md#L311](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L311).
* **Style Rationale:**
  Separate functional correctness in `verifier-ralph.test.ts` (restoring tracked files while preserving `node_modules`) from the `< 500 ms` benchmark target to prevent CI flakiness on loaded runners.

### STY-8: Informal Terms & Run-On Sentences Across Items 4, 8, 11, 13, 15, 16, 17, 18, and Footer
* **Severity:** Nit
* **Affected Scope:** [design_draft.md#L220](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L220), [L244](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L244), [L258](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L258), [L269](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L269), [L279](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L279), [L293](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L293).
* **Style Rationale:**
  Replace *"Monotonic Guards"* with *"Pre-Execution Validation Guards"*, *"Locked-Down"* with *"Read-Only"*, *"returns a Fail-Closed error"* with *"fails closed by returning an error"*, and split the compound sentence in Item 8 into distinct bullet points.
