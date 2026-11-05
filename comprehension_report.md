# Stage 6: Comprehension Test Report (`comprehension_report.md`)

* **Target Document:** [design_draft.md](file:///g:/マイドライブ/HY-HARNESS/design_draft.md) (`FeatureRange: 1..197`, `DetailedRange: 198..325`)
* **Standard:** `re-implementation-standard.md`
* **Reviewer:** `egm-comprehension` (`db52ef0b-9d13-4f38-93d5-a98fc39c54f3`)

---

## Findings

### COMP-1: Contradiction on State Transitions When Verification Gate Rejects Completion
* **Severity:** Blocker
* **Affected Scope:** [design_draft.md#L61-L63](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L61-L63), [L133](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L133), [L300](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L300) (`verifier-ralph` loop lifecycle & rollback).
* **Discrepancy Description & Rationale:**
  * Line 133 specifies: *"If a round times out, crashes, **or is rejected**, rolling back executes `git reset --hard refs/hy/checkpoints/<run-id>/r<N>`"*.
  * Lines 61–63 state: *"If either gate fails, completion is rejected and the failure digest is passed to Round 2's fresh child worker."* Line 300 reinforces: *"Merge only when both gates pass; otherwise pass structured failure diagnostics into Round $N+1$."*
  If a gate rejection triggers an immediate rollback to `r<N>`, all code edits made by Round $N$'s worker are wiped out, leaving Round $N+1$ with test failure diagnostics referring to code that no longer exists in the working tree. Conversely, if edits are retained across gate rejection (so Round $N+1$ can fix the failing test), only timeouts/crashes should roll back to `r<N>`, while gate rejection snapshots `r<N+1>` before spawning Round $N+1$. This transition rule must be explicitly disambiguated.

### COMP-2: Undefined `claim_complete` Signal Mechanism in 4-Tool Schema
* **Severity:** Blocker
* **Affected Scope:** [design_draft.md#L28](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L28), [L61](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L61), [L116-L120](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L116-L120), [L134](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L134), [L268-L270](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L268-L270), [L299](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L299).
* **Discrepancy Description & Rationale:**
  The verification loop triggers *"When a fresh child worker returns `status: "claim_complete"`"*. However, wire-level JSON Schema tools are strictly limited to `read_file`, `apply_patch`, `bash`, and `run_code`. The document does not define how the worker signals `claim_complete` (e.g., whether stopping tool calls with a final assistant message automatically transitions the turn to `claim_complete` evaluation in `verifier-ralph`, or whether `tools.objective.claimComplete()` is called inside `run_code`).

### COMP-3: Conflicting Git Plumbing Commands for Checkpoint Rollback (`git reset --hard` vs `git read-tree`)
* **Severity:** Blocker
* **Affected Scope:** [design_draft.md#L133](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L133) vs [L239](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L239) (`crates/hy-checkpoint`).
* **Discrepancy Description & Rationale:**
  Line 133 states that rollback executes `git reset --hard refs/hy/checkpoints/<run-id>/r<N>`, which moves the repository's `HEAD` and current branch pointer to the synthetic checkpoint commit. Line 239 states that `rollback_to_checkpoint` restores tracked files via `git read-tree` / `git checkout-index -f -a`, which updates the index and working tree without moving `HEAD`. These two mechanisms have incompatible effects on the user's branch state and must be unified (using `git read-tree` + `git checkout-index -f -a` so `HEAD` is never mutated).

### COMP-4: Missing Parameter Schemas for the 4 Core Tools and Undefined Syntax Check Engine
* **Severity:** Blocker
* **Affected Scope:** [design_draft.md#L28](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L28), [L116-L120](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L116-L120), [L244](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L244), [L268-L270](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L268-L270).
* **Discrepancy Description & Rationale:**
  The parameter schemas and return types for `read_file`, `apply_patch`, `bash`, and `run_code` are not defined inline. Furthermore, Lines 117 and 244 state that `apply_patch` runs an *"automatic Post-Edit Syntax Check via `hy-exec-server`"*, without specifying what parser/engine performs this check (e.g., `tree-sitter` crates in Rust or external CLI syntax checkers) or what languages are supported.

### COMP-5: Undefined `WorldStateSnapshot` Concept
* **Severity:** Major
* **Affected Scope:** [design_draft.md#L285](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L285) (`packages/seams/spill-compaction`).
* **Discrepancy Description & Rationale:**
  Line 285 states that 3-tier Compaction preserves *"the active `Rationale Ledger` ($K \le 12$) and `WorldStateSnapshot`"*, but `WorldStateSnapshot` is not defined anywhere else in `design_draft.md`. Its fields, producer, and prompt injection format must be specified.

### COMP-6: Mermaid 3-Plane Topology vs 2-Plane Process Architecture
* **Severity:** Major
* **Affected Scope:** [design_draft.md#L68-L105](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L68-L105).
* **Discrepancy Description & Rationale:**
  Lines 68–72 define two physical planes (TypeScript Control Plane and Rust Execution Plane), whereas the Mermaid diagram (Lines 73–105) depicts a third middle box ("Governance & Evaluation Plane (GOV)") between `CP` and `EP` with `JSON-RPC 2.0 over Stdio` pointing to `GOV`. Because `Starlark ExecPolicy` lives in Rust (`EP`) while `Guards`, `Guardian`, and `Verifier` live in TypeScript (`CP`), the diagram should accurately group components inside their actual physical planes (`CP` vs `EP`) to avoid implying a third process.

### COMP-7: Unspecified IPC Conduit Between `hy-ptc-worker` and Host `ToolRuntime`
* **Severity:** Major
* **Affected Scope:** [design_draft.md#L50](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L50), [L119](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L119), [L279](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L279).
* **Discrepancy Description & Rationale:**
  Line 119 states that `hy-exec-server` spawns `hy-ptc-worker` under a Restricted Token and routes `tools.*` sub-calls over a dedicated IPC pipe back to the host's `ToolRuntime` pipeline. It does not clarify whether `hy-ptc-worker` communicates over its DACL-configured `stdio` pipes through `hy-exec-server` (which multiplexes JSON-RPC notifications/requests back to the TypeScript Control Plane) or opens a separate Windows Named Pipe directly to the TypeScript process.

### COMP-8: Unspecified Configuration File Schema and `.star` Policy Lookup Path
* **Severity:** Major
* **Affected Scope:** [design_draft.md#L112](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L112), [L123](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L123), [L220](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L220), [L259](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L259), [L304](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L304).
* **Discrepancy Description & Rationale:**
  The file path and schema for configuring LLM roles (`worker`, `guardian`, `grader`, `compactor`), 4D budgets, and default `.star` policy files (e.g., `.hy-harness/config.json` and `.hy-harness/policies/default.star`) are not defined.

### COMP-9: Unspecified `Guardian` Decision Schema and `TooManyDenials` Action
* **Severity:** Major
* **Affected Scope:** [design_draft.md#L90](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L90), [L132](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L132), [L294](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L294).
* **Discrepancy Description & Rationale:**
  The structured output schema of `Guardian` (e.g., `{ riskScore: number, approved: boolean, rationale: string }`, threshold $< 80$) and the exact fallback behavior when `TooManyDenials` trips after 3 consecutive denials (escalating to human prompt in interactive mode or aborting the round in headless `ralph` mode) are omitted.

### COMP-10: Unspecified `SpillStore` Directory Layout, `SpillRef` Format, and Compaction Trigger Threshold
* **Severity:** Major
* **Affected Scope:** [design_draft.md#L55](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L55), [L81](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L81), [L284](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L284).
* **Discrepancy Description & Rationale:**
  The compaction context-window trigger threshold (e.g., 75% of model context limit), the local directory for spilled tool outputs (e.g., `.hy-harness/spill/<session-id>/<call-id>.txt`), and how the model reads a spilled file (via `read_file` with `path` + `startLine`/`endLine`) are not explicitly stated.

### COMP-11: Unspecified Windows 10 Low-Integrity Write-Grant Mechanism for `WorkspaceWrite`
* **Severity:** Major
* **Affected Scope:** [design_draft.md#L125-L129](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L125-L129), [L225-L230](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L225-L230).
* **Discrepancy Description & Rationale:**
  A Low Integrity (`S-1-16-4096`) + `WRITE_RESTRICTED` token can only write to filesystem objects whose DACL contains the restricted SID and whose Mandatory Label allows Low Integrity writes (or when writes are brokered by `hy-exec-server` via `apply_patch`). The spec must clarify how `WorkspaceWrite` allows child processes to write inside `workspaceRoot` (or a scratch/temp dir) without eager O(N) ACL traversal across `node_modules/`.

### COMP-12: Unexpanded Acronyms (`PTC` and `ACI`)
* **Severity:** Nit
* **Affected Scope:** [design_draft.md#L28](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L28), [L46](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L46), [L82](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L82), [L114](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L114).
* **Discrepancy Description & Rationale:**
  Expand `PTC` (Programmatic Tool Calling) and `ACI` (Agent-Computer Interface) on first use.

### COMP-13: Windows 11 MXC OS Version Discrepancy (`24H2+` vs `25H2+`)
* **Severity:** Nit
* **Affected Scope:** [design_draft.md#L17](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L17), [L38](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L38) vs [L194](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L194).
* **Discrepancy Description & Rationale:**
  Standardize the Windows 11 MXC version reference across all sections.

### COMP-14: Missing CLI Subcommand Argument Signatures
* **Severity:** Nit
* **Affected Scope:** [design_draft.md#L304](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L304).
* **Discrepancy Description & Rationale:**
  Specify positional arguments and flags for `hy run`, `hy ralph`, `hy rpc-server`, and `hy policy-test`.
