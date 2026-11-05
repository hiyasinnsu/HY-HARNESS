# Stage 7: Critic Review Report (`critic_report.md`)

* **Target Document:** [design_draft.md](file:///g:/マイドライブ/HY-HARNESS/design_draft.md) (`FeatureRange: 1..197`)
* **Standard:** `feature-spec-standard.md`
* **Reviewers:**
  * `egm-design` (`cad2bda3-a768-4518-a70c-8ea5a5615ef2`)
  * `egm-structural` (`1b7c10e9-64bd-4e07-9ab1-0bb135a3ed82`)
  * `egm-style` (`7cae5acb-35f1-43d0-8b6d-6bae4adb75ad`)

---

## 1. Design Critic Findings (`egm-design`)

### DES-1: Missing Dedicated `## Risks & Mitigations` Section
* **Severity:** Blocker
* **Affected Scope:** [design_draft.md#L1-L197](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L1-L197).
* **Finding & Recommendation:**
  `feature-spec-standard.md` mandates an explicit evaluation of risks, failure modes, security limits, and scalability constraints. While `## Non-Functional Requirements` lists target metrics, there is no dedicated `## Risks & Mitigations` section addressing Windows NTFS file-locking failure modes, Low-Integrity read confinement limits, shell command chaining escapes, IPC deadlocks, and Grader prompt injection.

### DES-2: NTFS Directory Junction (`IO_REPARSE_TAG_MOUNT_POINT`) Bypass of Hard-Link Check
* **Severity:** Major
* **Affected Scope:** [design_draft.md#L27](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L27), [L128](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L128) (`crates/hy-sandbox-windows`).
* **Finding & Recommendation:**
  Auditing `nNumberOfLinks > 1` catches file hard links, but non-elevated Windows 10 users can create NTFS Directory Junctions (`mklink /J`). A file accessed through a junction has `nNumberOfLinks == 1` yet resolves outside `workspaceRoot`. `hy-sandbox-windows` must also call `GetFinalPathNameByHandleW(h, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS)` on opened file handles and verify that the canonicalized target path starts with the canonicalized `workspaceRoot`.

### DES-3: Windows 10 Low-Integrity Ambient Read Access & Network Exfiltration Boundary
* **Severity:** Major
* **Affected Scope:** [design_draft.md#L17](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L17), [L27](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L27), [L124-L128](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L124-L128).
* **Finding & Recommendation:**
  On Windows 10, Low Integrity (`S-1-16-4096`) blocks writes to Medium Integrity objects, but retains read access to world-readable/user-readable files (e.g., `~/.ssh`, `~/.aws`, `~/.gitconfig`) and does not block outbound TCP sockets at the kernel level. The specification must document this Windows 10 architectural boundary, mandate host-side environment variable sanitization (stripping all API keys/tokens before spawning child processes), and enforce Starlark rules blocking network exfiltration binaries (`curl`, `Invoke-WebRequest`, `ssh`, `scp`) unless explicitly approved.

### DES-4: Windows NTFS File Locking (`ERROR_SHARING_VIOLATION`) During Checkpoint Rollback
* **Severity:** Major
* **Affected Scope:** [design_draft.md#L31](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L31), [L118](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L118), [L133](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L133), [L176](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L176).
* **Finding & Recommendation:**
  If a 5-second auto-backgrounded command or LSP server holds an open handle to a workspace file when a round rolls back, NTFS rejects file replacement/deletion with `ERROR_SHARING_VIOLATION` (`0x20`). Before executing checkpoint rollback, `hy-exec-server` must terminate all active background jobs in the current round's Job Object and retry file restoration with exponential backoff (e.g., up to 3 attempts over 1,000 ms) to clear transient Windows Defender locks.

### DES-5: Shell Command Chaining / Subshell Bypass in `execpolicy` `prefix_rule`
* **Severity:** Major
* **Affected Scope:** [design_draft.md#L88](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L88), [L123](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L123) (`crates/hy-execpolicy`).
* **Finding & Recommendation:**
  Raw string prefix matching on shell commands can be bypassed via compound operators (`&&`, `||`, `;`, `|`, `` ` ``, `$()`, `&`). `crates/hy-execpolicy` must split compound shell commands into individual simple command segments (tokenizing argv per segment) and evaluate every segment against the Starlark rule set—taking the most restrictive decision (`deny > prompt > allow`), and failing closed (`prompt` or `deny`) on unparseable subshell expansions.

### DES-6: Rationale Ledger Contamination Across Rejected/Crashed `verifier-ralph` Rounds
* **Severity:** Major
* **Affected Scope:** [design_draft.md#L29](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L29), [L60-L63](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L60-L63), [L111](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L111), [L136](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L136).
* **Finding & Recommendation:**
  If a worker in Round 1 writes a faulty or hallucinated constraint into the Rationale Ledger and then fails verification, keeping that entry as a permanent rule in Round 2 can poison subsequent rounds or bias the `Grader`. Entries written during an unverified child round should be tagged as `status: "provisional"` (visible to the next round as round observations) and promoted to `status: "verified"` only when the round passes verification (or explicitly confirmed).

### DES-7: Indirect Prompt Injection Against the Stage 2 `Grader` Model
* **Severity:** Major
* **Affected Scope:** [design_draft.md#L30](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L30), [L62](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L62), [L136](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L136).
* **Finding & Recommendation:**
  A worker or external file could embed prompt injection strings inside a modified file or test output inspected by `Grader`. `verifier-ralph` must isolate `git diff` and test logs inside explicit untrusted delimiters (`<untrusted_git_diff>`, `<untrusted_test_output>`), supply only the user's immutable Objective and `verified` Rationale Ledger entries as trusted criteria, and parse the Grader's output against a strict JSON schema (`{ pass: boolean, unmetCriteria: string[], reasoning: string }`).

### DES-8: Reader-Writer Synchronization for Concurrent PTC Sub-Calls
* **Severity:** Nit
* **Affected Scope:** [design_draft.md#L119](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L119).
* **Finding & Recommendation:**
  Specify an async Reader-Writer lock (`RwLock`, up to 10 concurrent readers, exclusive single writer) in `ToolRuntime` when dispatching sub-calls from `run_code`.

### DES-9: Node.js `--permission` Boot Flags and Host-Side TypeScript Stripping
* **Severity:** Nit
* **Affected Scope:** [design_draft.md#L119](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L119), [L172](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L172), [L279](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L279).
* **Finding & Recommendation:**
  Specify that TypeScript type-stripping happens on the host before spawning `hy-ptc-worker`, and specify the exact Node permission flags (`--permission --allow-fs-read=<worker_script_path>`).

---

## 2. Structural Critic Findings (`egm-structural`)

### STR-1: Missing `## Risks & Mitigations` Section
* **Severity:** Major
* **Affected Scope:** [design_draft.md#L168-L181](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L168-L181).
* **Discrepancy Description & Rationale:**
  Duplicate of `DES-1`: `feature-spec-standard.md` requires an explicit `## Risks & Mitigations` section.

### STR-2: Missing `Rollout & Rollback` Category Under `## Non-Functional Requirements`
* **Severity:** Major
* **Affected Scope:** [design_draft.md#L168-L180](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L168-L180).
* **Discrepancy Description & Rationale:**
  `design_doc.md` specifies three NFR categories: Security & Privacy, Performance & Latency, and Rollout & Rollback. Add `Rollout & Operational Recovery` under `## Non-Functional Requirements`.

### STR-3: Heading Hierarchy Violation on `### Additional Resources` and `### Future Improvements`
* **Severity:** Major
* **Affected Scope:** [design_draft.md#L183](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L183), [L190](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L190).
* **Discrepancy Description & Rationale:**
  Using `###` after `## Non-Functional Requirements` subordinates those two sections under NFRs in the Markdown AST. Promote both to `## Additional Resources` and `## Future Improvements`.

### STR-4: Inconsistent URI Formatting in `Additional Resources`
* **Severity:** Nit
* **Affected Scope:** [design_draft.md#L185-L188](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L185-L188).
* **Discrepancy Description & Rationale:**
  Use consistent canonical `file:///` links for all items in `Additional Resources`.

---

## 3. Style Critic Findings (`egm-style`, FeatureRange)

### STY-1: Academic Jargon ("Spatiotemporal Composability")
* **Severity:** Major
* **Affected Scope:** [design_draft.md#L151](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L151).
* **Style Rationale:**
  Replace *"Cordis's spatiotemporal composability (hot-swappable plugins with revertible effects)"* with *"Cordis's dynamic plugin lifecycle and revertible cleanup effects (`ctx.effect`)"*.

### STY-2: Unprovable Hyperbole ("Instant Rollback", "Zero Context Rationale Erosion")
* **Severity:** Major
* **Affected Scope:** [design_draft.md#L23](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L23), [L29](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L29), [L31](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L31), [L158](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L158).
* **Style Rationale:**
  Replace *"Instant"* with *"Sub-500ms"* or *"Fast In-Tree Rollback (< 500 ms)"*, and replace *"Zero Context Rationale Erosion"* with *"Deterministic Rationale Preservation Across Compactions"*.

### STY-3: Subjective Adjectives in `Alternatives Considered`
* **Severity:** Major
* **Affected Scope:** [design_draft.md#L145-L146](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L145-L146), [L151-L152](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L151-L152).
* **Style Rationale:**
  Replace subjective descriptors (*"brittle C++ native addons"*, *"slow PowerShell wrappers"*, *"high-assurance"*, *"cumbersome"*, *"significantly higher"*) with neutral technical descriptions.

### STY-4: Undefined Tier Labels & Slogans ("Tier-1 Sandbox", "Tier-0 Auto-Upgrade", "Attention-Minimizing Principle")
* **Severity:** Nit
* **Affected Scope:** [design_draft.md#L98](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L98), [L121](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L121), [L193-L194](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L193-L194).
* **Style Rationale:**
  Use descriptive names (*"Windows 10 Restricted-Token Sandbox"*, *"Windows 11 MXC Process Container Backend"*) or explicitly define the tier labels, and replace *"Attention-Minimizing Principle"* with concrete behavior.

### STY-5: Informal Diction ("cuts", "modern", "suffers from", "severe", "Locked-Down")
* **Severity:** Nit
* **Affected Scope:** [design_draft.md#L11](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L11), [L17](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L17), [L21](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L21), [L90](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L90), [L132](file:///g:/マイドライブ/HY-HARNESS/design_draft.md#L132).
* **Style Rationale:**
  Replace with objective technical diction (*"reduces"*, *"exhibits"*, *"high disk I/O overhead"*, *"Read-Only Guardian Reviewer"*).
