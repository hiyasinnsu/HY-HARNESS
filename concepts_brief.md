# HY-HARNESS

* **Author:** Antigravity & User
* **Date:** 2026-11-02

## Overview

HY-HARNESS is a Windows 10-first autonomous coding agent harness that pairs a TypeScript control plane (built on the Cordis microkernel) with a Rust execution daemon (`hy-exec-server`). It targets developers and teams who want an extensible agent runtime that does not leak side effects, burn unnecessary context tokens on multi-step tool calls, forget project constraints during context compaction, or exit long-running tasks based on unverified worker self-declarations.

The control plane manages dynamic plugin loading and unloading via revertible effects (`ctx.effect`), routes model requests by role (Planner/Worker, Guardian, Grader, Compactor) across DeepSeek, Gemini, and OpenAI-compatible APIs, records all model-visible context in an append-only JSONL session log, maintains a model-updatable capped Rationale Ledger ($K=12$), and drives a Verifier-Gated Ralph objective loop. The Rust execution daemon enforces Starlark command policies with load-time unit tests (`match` / `not_match`), confines subprocesses on Windows 10 using Restricted Tokens, Job Objects, explicit pipe and desktop DACLs, and NTFS hard-link checks, automatically backgrounds shell commands after 5 seconds, and manages fast Git ref checkpoints (`refs/hy/checkpoints/`) for atomic rollback.

## Analysis

### 1. Contrarian & YAGNI Lens (`egm-zoom-out`)
* **Windows 10 Focus without Admin Overhead:** Many enterprise and personal Windows 10 environments lack Windows 11 24H2+ Microsoft xContainers (MXC) or unrestricted Hyper-V/WSL2 privileges. Making the non-elevated Windows 10 Restricted Token + Job Object backend a first-class citizen solves a real deployment bottleneck.
* **Complexity Cuts:**
  * Do not write a custom Starlark parser; use the `starlark-rust` crate directly.
  * Keep the initial JSON Schema tool surface strictly limited to 4 atomic tools (`read_file`, `apply_patch`, `bash`, `run_code`). All higher-order operations (LSP queries, multi-file search, batch edits, subagent fan-out) are exposed only as compact TypeScript type declarations (`.d.ts`) inside `run_code`.
  * Defer Web UI and external webhook daemons (`hy-superagent`) out of the initial implementation; ship a clean CLI and JSON-RPC 2.0 server first.

### 2. Deep Systems & Windows 10 Sandbox Feasibility Lens (`egm-codebase-details`)
* **Eliminating DeepSeek Harness's Windows 10 Sandbox Failures:**
  * *Pipe `EPERM` Fix:* Node.js (`libuv`) grandchild processes fail with `EPERM` under Restricted Tokens when named pipes lack explicit access entries. `hy-exec-server` must pre-create stdio pipes with an explicit `SECURITY_DESCRIPTOR` granting `GENERIC_READ | GENERIC_WRITE` to the restricted capability/logon SID and Low Integrity level (`S-1-16-4096`).
  * *`STATUS_DLL_INIT_FAILED` (0xC0000142) Fix:* Child processes crash during `user32.dll` / `kernel32.dll` initialization if their restricted token cannot read the window station or desktop. `hy-exec-server` must grant `WINSTA_READATTRIBUTES | WINSTA_ACCESSGLOBALATOMS` on `WinSta0` and read access on the active desktop to the restricted SID.
  * *NTFS Hard-Link Escape Prevention:* Because NTFS hard links share a single security descriptor across directory boundaries, `hy-exec-server` must inspect target files via `GetFileInformationByHandle` before granting write ACEs or applying patches. If `nNumberOfLinks > 1` and any link resolves outside the workspace root, the operation fails closed.
* **Hardening `run_code` Against VM Escapes:**
  * Node's built-in `vm` module is not a security boundary against prototype-chain escapes (`this.constructor.constructor("return process")()`). Therefore, `run_code` must execute inside a separate worker process spawned by `hy-exec-server` under the Windows 10 Restricted Token and Job Object, with direct filesystem/network access disabled and only an IPC channel bridged back to the host's governed tool pipeline.

### 3. Cost, Quota & Token Economics Lens (`egm-design` & `egm-zoom-out`)
* **Tiered PTC Token Savings:** Advertising dozens of JSON Schema tools on every turn wastes thousands of prompt tokens. Exposing only 4 core JSON Schema tools while placing extended capabilities into a concise `.d.ts` prompt section (`tools:sdk`) cuts per-turn schema overhead and prevents intermediate tool outputs from entering conversation history.
* **Capped Rationale Ledger ($K=12$, Max 1,500 Tokens):** Allowing the model to autonomously record learned project rules (`upsert_rationale`, `supersede_rationale`) prevents `Context Rationale Erosion` across compactions. However, an unbounded ledger would bloat the system prompt and accumulate stale rules. Enforcing a strict cap of $K=12$ active entries (with explicit key replacement and LRU eviction into the shadowed log) bounds token cost.
* **Role-Based Model Tiering:** Running a frontier reasoning model for every Guardian check, Compaction summary, and Inferential Grader pass multiplies API costs. The LLM router must allow mapping `worker`, `guardian`, `grader`, and `compactor` roles to separate model configurations (e.g., reasoning models for `worker`/`grader` and fast, low-cost models with Trunk Prompt-Cache reuse for `guardian`/`compactor`).

### 4. UX, Ergonomics & Operational Clarity Lens (`egm-comprehension` & `egm-structural`)
* **Clear Tool Selection Heuristics:** To prevent the model from hesitating between direct tools and `run_code`, the system prompt defines a strict rule: use `read_file`, `apply_patch`, or `bash` for single-step atomic operations; use `run_code` whenever a task requires 2 or more chained calls, loops, filtering, LSP navigation, or subagent delegation.
* **Deterministic 5-Second Auto-Backgrounding Contract:** When a foreground `bash` command exceeds 5 seconds, `hy-exec-server` moves it to a background job and returns a structured payload (`status: "backgrounded"`, `jobId`, `initialOutput`, and explicit instructions not to re-run the command), preventing duplicate process spawns.
* **Fast In-Tree Git Ref Checkpoints vs Worktrees:** On Windows NTFS, creating full `git worktree` directories on every Ralph round triggers slow file indexing and breaks untracked `node_modules` or `target` caches. Sequential Ralph rounds use lightweight Git ref checkpoints (`refs/hy/checkpoints/<run-id>/r<N>`) via `git write-tree` / `git commit-tree` in the existing workspace, enabling instant rollback while keeping build caches intact.

## Goals vs. Non-Goals

* **In-Scope Goals:**
  * TypeScript Cordis microkernel (`ctx.effect`, `inject`, 5 event dispatch modes, 3-part Capability Seams).
  * Append-only JSONL Session Log (`Model-visible <=> logged`), `SpillStore` for oversized outputs, 3-tier Compaction, and model-updatable Capped Rationale Ledger ($K=12$).
  * Role-based LLM Router supporting DeepSeek, Gemini, and OpenAI-compatible endpoints.
  * Rust execution daemon (`hy-exec-server`) communicating over JSON-RPC 2.0 stdio/named pipe, enforcing `#![deny(clippy::unwrap_used, clippy::expect_used, clippy::print_stdout, clippy::print_stderr)]`.
  * Windows 10 Tier-1 Sandbox (Restricted Token + Low Integrity + Job Object + explicit Pipe/`WinSta0` DACLs + NTFS hard-link check + fail-closed policy enforcement) alongside Linux (`bwrap` + Seccomp) and macOS (`Seatbelt`) adapters.
  * Starlark `execpolicy` engine (`prefix_rule`, `host_executable`) with mandatory load-time `match` / `not_match` test validation.
  * Tiered PTC (`run_code` running in a sandboxed subprocess with IPC tool bindings and `.d.ts` SDK generation) + 4 core JSON Schema tools + syntax/read-before-edit guardrails.
  * Verifier-Gated Ralph loop with 4D budget enforcement (rounds, tokens, cost USD, wall-clock time), structural recursion ban, Git ref checkpoint rollback, Computational Gate (tests/linter/typecheck), and Inferential Gate (read-only Guardian/Grader).
  * Extensible CLI and JSON-RPC server (`hy-cli`).
* **Out-of-Scope Non-Goals (Deferred for Initial Implementation):**
  * Browser-based Web GUI (`client/` slots and React/Vite frontend).
  * Always-on external webhook daemon (`hy-superagent` for GitHub/Feishu polling).
  * Windows 11-exclusive MXC container setup as a required dependency (supported only as an optional capability when detected on Win11 24H2+).

## Key Decisions & Staging for Next Steps

1. **Hybrid Control/Execution Split:** Keep the TypeScript (Cordis) + Rust (`hy-exec-server`) architecture over a single JSON-RPC 2.0 stdio transport.
2. **Windows 10 Sandbox Hardening:** Implement explicit pipe/desktop DACLs, Job Object termination, and `nNumberOfLinks > 1` hard-link rejection in `crates/hy-sandbox-windows` to fix the exact Windows 10 failure modes documented in DeepSeek Harness.
3. **Sandboxed Process Isolation for `run_code`:** Execute PTC `run_code` scripts in a Restricted-Token subprocess rather than an in-process Node `vm` to prevent prototype-escape attacks.
4. **Capped Self-Updating Rationale Ledger:** Provide `upsert_rationale` and `supersede_rationale` operations with a hard limit of $K=12$ active rules (1,500 tokens max) projected below the system prompt across compactions.
5. **In-Tree Git Ref Checkpoints:** Use `refs/hy/checkpoints/` shadow commits for sequential Ralph round rollbacks on Windows NTFS to preserve `node_modules` and `target` build caches without copying directories.
