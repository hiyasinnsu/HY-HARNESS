//! Wire contract between the HY-HARNESS control plane and `hy-exec-server`.
//!
//! Framing: one UTF-8 JSON-RPC 2.0 object per line, at most [`MAX_MESSAGE_BYTES`].
//! These types are the single source of truth; `hy-protocol-schema` emits their
//! JSON Schema, from which `packages/core/src/protocol.gen.ts` is generated.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u32 = 1;
pub const JSONRPC_VERSION: &str = "2.0";
pub const MAX_MESSAGE_BYTES: usize = 16 * 1024 * 1024;

/// Error codes (design §3).
pub mod error_code {
    pub const PARSE_ERROR: i64 = -32700;
    pub const INVALID_REQUEST: i64 = -32600;
    pub const METHOD_NOT_FOUND: i64 = -32601;
    pub const INVALID_PARAMS: i64 = -32602;
    pub const INTERNAL_ERROR: i64 = -32603;
    pub const POLICY_DENIED: i64 = -32001;
    pub const SANDBOX_VIOLATION: i64 = -32002;
    pub const PATCH_CONFLICT: i64 = -32003;
    pub const CHECKPOINT_ERROR: i64 = -32004;
    pub const CANCELLED: i64 = -32005;
    pub const SANDBOX_UNAVAILABLE: i64 = -32006;
}

/// Method names.
pub mod method {
    pub const INITIALIZE: &str = "initialize";
    pub const SHUTDOWN: &str = "shutdown";
    pub const EXIT: &str = "exit";
    pub const CANCEL_REQUEST: &str = "$/cancelRequest";
    pub const EXEC_COMMAND: &str = "exec/command";
    pub const JOB_LIST: &str = "job/list";
    pub const JOB_STATUS: &str = "job/status";
    pub const JOB_OUTPUT: &str = "job/output";
    pub const JOB_WAIT: &str = "job/wait";
    pub const JOB_KILL: &str = "job/kill";
    pub const JOB_EXITED: &str = "job/exited";
    pub const PATCH_APPLY: &str = "patch/apply";
    pub const POLICY_EVALUATE: &str = "policy/evaluate";
    pub const CHECKPOINT_CREATE: &str = "checkpoint/create";
    pub const CHECKPOINT_ROLLBACK: &str = "checkpoint/rollback";
    pub const CHECKPOINT_DIFF: &str = "checkpoint/diff";
    pub const CHECKPOINT_PRUNE: &str = "checkpoint/prune";
    pub const PTC_RUN: &str = "ptc/run";
    pub const PTC_TOOL_CALL: &str = "ptc/toolCall";
    pub const PTC_LOG: &str = "ptc/log";
    pub const JOB_WRITE: &str = "job/write";
    pub const SANDBOX_STATUS: &str = "sandbox/status";
    pub const SANDBOX_GRANT: &str = "sandbox/grant";
    pub const SANDBOX_REVOKE: &str = "sandbox/revoke";
    pub const SANDBOX_ADD_ROOT: &str = "sandbox/add-root";
    pub const SANDBOX_REMOVE_ROOT: &str = "sandbox/remove-root";
    pub const SHELL_OPEN: &str = "shell/open";
    pub const SHELL_WRITE: &str = "shell/write";
    pub const SHELL_READ: &str = "shell/read";
    pub const SHELL_CLOSE: &str = "shell/close";
}

// ---------------------------------------------------------------------------
// JSON-RPC envelope
// ---------------------------------------------------------------------------

/// Client IDs are integers; server-initiated IDs are strings prefixed `s:`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum RequestId {
    Int(i64),
    Str(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl RpcError {
    pub fn new(code: i64, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
        }
    }
    pub fn with_data(mut self, data: Value) -> Self {
        self.data = Some(data);
        self
    }
}

/// Any incoming line. Requests have `id` + `method`, notifications only `method`,
/// responses only `id` plus `result` or `error`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct RpcMessage {
    pub jsonrpc: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<RequestId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

impl RpcMessage {
    pub fn request(id: RequestId, method: &str, params: Value) -> Self {
        Self {
            jsonrpc: JSONRPC_VERSION.into(),
            id: Some(id),
            method: Some(method.into()),
            params: Some(params),
            result: None,
            error: None,
        }
    }
    pub fn notification(method: &str, params: Value) -> Self {
        Self {
            jsonrpc: JSONRPC_VERSION.into(),
            id: None,
            method: Some(method.into()),
            params: Some(params),
            result: None,
            error: None,
        }
    }
    pub fn response(id: RequestId, result: Value) -> Self {
        Self {
            jsonrpc: JSONRPC_VERSION.into(),
            id: Some(id),
            method: None,
            params: None,
            result: Some(result),
            error: None,
        }
    }
    pub fn error_response(id: Option<RequestId>, error: RpcError) -> Self {
        Self {
            jsonrpc: JSONRPC_VERSION.into(),
            id,
            method: None,
            params: None,
            result: None,
            error: Some(error),
        }
    }
}

// ---------------------------------------------------------------------------
// Shared enums
// ---------------------------------------------------------------------------

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "kebab-case")]
/// Ordered from strictest to loosest; the policy picks the minimum.
pub enum SandboxMode {
    ReadOnly,
    WorkspaceWrite,
    /// Low label only, no restricting SIDs (ADR 0001 C). User policy only.
    LowIntegrity,
    Unconfined,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum Enforcement {
    Full,
    Partial,
    None,
}

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "kebab-case")]
pub enum Decision {
    Allow,
    Prompt,
    Deny,
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct InitializeParams {
    pub protocol_version: u32,
    /// Fixed for the lifetime of the server; later requests carry no root.
    pub workspace_root: String,
    /// `%LOCALAPPDATA%\hy-harness\state\<workspace-id>`.
    pub state_dir: String,
    /// Default mode for `exec/command` when the policy does not override it.
    pub sandbox: SandboxMode,
    /// Extra writable roots from user config (granted in `workspace-write`).
    #[serde(default)]
    pub extra_writable_roots: Vec<String>,
    /// Env names added to the built-in allowlist.
    #[serde(default)]
    pub env_passthrough: Vec<String>,
    /// Policy files in layering order after the embedded default.
    #[serde(default)]
    pub user_policy_path: Option<String>,
    #[serde(default)]
    pub project_policy_path: Option<String>,
    /// Whether the project is trusted (project policy may then add `allow` rules).
    #[serde(default)]
    pub project_trusted: bool,
    /// Globs `patch/apply` treats as tamper-sensitive.
    #[serde(default)]
    pub protected_paths: Vec<String>,
    /// Absolute paths the confined token must not read (CP-02). The deny ACE
    /// names the workspace SID, so the user keeps access.
    #[serde(default)]
    pub deny_read: Vec<String>,
    /// Subdirectories of the workspace that stay readable but not writable
    /// (CP-02 carve-outs).
    #[serde(default)]
    pub read_only: Vec<String>,
    /// Shell dialect for compound commands and builtins (OQ-1).
    #[serde(default)]
    pub shell: Option<ShellConfig>,
    /// Node executable used for `ptc/run` workers.
    #[serde(default)]
    pub ptc_node_path: Option<String>,
    /// `ptc-worker.mjs` script run by `ptc/run`.
    #[serde(default)]
    pub ptc_worker_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ShellConfig {
    /// `pwsh` (PowerShell 7) or `powershell` (Windows PowerShell 5.1).
    pub dialect: ShellDialect,
    pub executable: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum ShellDialect {
    Pwsh,
    Powershell,
    Cmd,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct InitializeResult {
    pub server_version: String,
    pub protocol_version: u32,
    pub capabilities: ServerCapabilities,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ServerCapabilities {
    pub sandbox_backends: Vec<String>,
    pub enforcement: Enforcement,
    pub gaps: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CancelParams {
    pub id: RequestId,
}

// ---------------------------------------------------------------------------
// exec/command and jobs
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum ExecMode {
    Agent,
    Gate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum ApprovalBy {
    User,
    Guardian,
    Policy,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Approval {
    pub by: ApprovalBy,
    pub call_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExecCommandParams {
    pub command: String,
    /// Relative to the workspace root; must stay inside it.
    #[serde(default)]
    pub cwd: Option<String>,
    pub mode: ExecMode,
    #[serde(default)]
    pub foreground_wait_ms: Option<u64>,
    #[serde(default)]
    pub hard_timeout_ms: Option<u64>,
    #[serde(default)]
    pub approval: Option<Approval>,
    /// Run that owns the job (rollback kills all jobs of a run).
    #[serde(default)]
    pub run_id: Option<String>,
    /// Gate commands from the user's command line may run unconfined (OQ-2).
    #[serde(default)]
    pub user_supplied: bool,
    /// The session's sandbox mode for this call (WP-12). Absent keeps the mode
    /// fixed at `initialize`. A policy rule may tighten it but never widen it.
    #[serde(default)]
    pub sandbox_mode: Option<SandboxMode>,
    /// CP-09: keep stdin open so `job/write` can feed the process.
    #[serde(default)]
    pub stdin_pipe: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum ExecStatus {
    Completed,
    Backgrounded,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    pub status: ExecStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i64>,
    pub stdout: String,
    pub stderr: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub job_id: Option<String>,
    pub sandbox: SandboxMode,
    /// True when stdout/stderr were cut; the full output is in `job/output`.
    pub truncated: bool,
    pub timed_out: bool,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum JobState {
    Running,
    Exited,
    Killed,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct JobInfo {
    pub job_id: String,
    pub command: String,
    pub state: JobState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i64>,
    pub output_bytes: u64,
    pub sandbox: SandboxMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct JobWriteParams {
    pub job_id: String,
    /// Bytes to write (UTF-8 from the tool, but arbitrary bytes are fine).
    pub data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct JobWriteResult {
    pub written: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct JobIdParams {
    pub job_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct JobListResult {
    pub jobs: Vec<JobInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct JobOutputParams {
    pub job_id: String,
    /// Byte offset into the combined output stream.
    #[serde(default)]
    pub offset: u64,
    #[serde(default)]
    pub max_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct JobOutputResult {
    pub data: String,
    pub next_offset: u64,
    pub total_bytes: u64,
    pub eof: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct JobWaitParams {
    pub job_id: String,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

// ---------------------------------------------------------------------------
// shell/* (WP-31: one persistent shell per session)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ShellOpenParams {
    #[serde(default)]
    pub run_id: Option<String>,
    /// Workspace-relative or absolute directory the shell starts in.
    #[serde(default)]
    pub cwd: Option<String>,
    /// `unconfined` keeps one PowerShell alive; confined modes answer `gap`.
    #[serde(default)]
    pub sandbox_mode: Option<String>,
    /// Environment overrides for the shell (the daemon filters these).
    #[serde(default)]
    pub env: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ShellOpenResult {
    /// Present when the shell is persistent; absent when the host fell back.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shell_id: Option<String>,
    pub persistent: bool,
    pub shell: String,
    pub cwd: String,
    /// Why persistence is unavailable (confined sandbox, no PowerShell, ...).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gap: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ShellWriteParams {
    pub shell_id: String,
    /// The command text; the daemon appends its own sentinel.
    pub data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ShellWriteResult {
    /// The sentinel the next `shell/read` waits for.
    pub sentinel: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ShellReadParams {
    pub shell_id: String,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    #[serde(default)]
    pub max_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ShellReadResult {
    pub data: String,
    pub eof: bool,
    pub timed_out: bool,
    pub truncated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ShellCloseParams {
    pub shell_id: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ShellCloseResult {
    pub closed: bool,
}

// ---------------------------------------------------------------------------
// patch/apply
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PatchApplyParams {
    /// Unified diff.
    pub patch: String,
    #[serde(default)]
    pub dry_run: bool,
    /// Set by the control plane in `hy ralph` (protected paths are rejected unless true).
    #[serde(default)]
    pub enforce_protected_paths: bool,
    /// The session's sandbox mode for this call (WP-12). `read-only` refuses
    /// every non-dry-run mutation; absent keeps `initialize`'s behavior.
    #[serde(default)]
    pub sandbox_mode: Option<SandboxMode>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PatchApplyResult {
    pub applied_files: Vec<String>,
    pub created: Vec<String>,
    pub deleted: Vec<String>,
    pub warnings: Vec<String>,
    /// SHA-256 (hex) of each written file, keyed by workspace-relative path.
    pub hashes: std::collections::BTreeMap<String, String>,
}

/// `data` of a `-32003 PatchConflict` error.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PatchConflictData {
    pub file: String,
    pub hunk: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nearest_match: Option<NearestMatch>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NearestMatch {
    pub start_line: usize,
    pub text: String,
}

// ---------------------------------------------------------------------------
// policy/evaluate
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PolicyEvaluateParams {
    pub command: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PolicyEval {
    pub decision: Decision,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox: Option<SandboxMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub justification: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub matched_rule: Option<String>,
    pub compound: bool,
}

// ---------------------------------------------------------------------------
// checkpoints
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointParams {
    pub run_id: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointCreateResult {
    #[serde(rename = "ref")]
    pub reference: String,
    pub tree_oid: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head_oid: Option<String>,
    pub unprotected: Vec<String>,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointRollbackResult {
    pub restored: Vec<String>,
    pub deleted: Vec<String>,
    pub skipped: Vec<String>,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointDiffParams {
    pub run_id: String,
    pub from_label: String,
    pub max_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointDiffResult {
    pub stat: String,
    pub patch: String,
    pub truncated: bool,
    pub files_changed: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointPruneParams {
    pub run_id: String,
    #[serde(default)]
    pub keep: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointPruneResult {
    pub deleted_refs: Vec<String>,
}

/// `data` of a `-32004 CheckpointError`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointErrorData {
    /// e.g. `HeadMoved`, `NotARepository`, `GitTooOld`, `UnknownLabel`.
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rollback: Option<CheckpointRollbackResult>,
}

// ---------------------------------------------------------------------------
// ptc
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PtcRunParams {
    /// Plain JavaScript: the body of an async function (types already stripped).
    pub js_code: String,
    pub timeout_ms: u64,
    pub max_sub_calls: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum PtcStatus {
    Ok,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PtcRunResult {
    pub status: PtcStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub logs: Vec<String>,
    pub sub_calls: u32,
}

/// Server → client request while `ptc/run` is pending.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PtcToolCallParams {
    /// The `ptc/run` request this sub-call belongs to.
    pub run_request_id: RequestId,
    pub name: String,
    pub args: Value,
}

// ---------------------------------------------------------------------------
// sandbox
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SandboxStatusResult {
    pub enforcement: Enforcement,
    pub gaps: Vec<String>,
    pub workspace_write_available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
    pub granted_roots: Vec<String>,
    /// Files skipped by the ACL walker because they have more than one hard link.
    pub unprotected_hard_links: u64,
    pub workspace_sid: String,
    /// This session's private temp directory (`TEMP`/`TMP` of confined commands).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub private_temp: Option<String>,
    /// One-time actions taken while preparing the sandbox (e.g. `git init`).
    #[serde(default)]
    pub notices: Vec<String>,
    /// The grant made at initialize, when one was made in this session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grant: Option<SandboxGrantResult>,
    /// CP-02: paths that now carry a deny-read ACE for the workspace SID.
    #[serde(default)]
    pub deny_read: Vec<String>,
    /// `denyRead` paths that do not exist on this machine.
    #[serde(default)]
    pub deny_read_missing: Vec<String>,
    /// `denyRead` paths whose ACE could not be applied.
    #[serde(default)]
    pub deny_read_failed: Vec<String>,
    /// CP-02 carve-outs: paths that now carry a deny-write ACE.
    #[serde(default)]
    pub read_only: Vec<String>,
    /// `readOnly` paths that do not exist on this machine.
    #[serde(default)]
    pub read_only_missing: Vec<String>,
    /// `readOnly` paths whose ACE could not be applied (or were outside the workspace).
    #[serde(default)]
    pub read_only_failed: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SandboxRootParams {
    pub root: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SandboxRootsResult {
    pub roots: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SandboxGrantResult {
    /// The root already carried the grant; nothing was walked.
    pub already_granted: bool,
    pub objects: u64,
    pub objects_changed: u64,
    pub skipped_hard_links: u64,
    pub skipped_reparse_points: u64,
    pub protected: Vec<String>,
    pub failed: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_failure: Option<String>,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SandboxRevokeResult {
    /// Objects restored from the grant record.
    pub restored: u64,
    /// Objects created after the grant from which the SID was stripped.
    pub stripped: u64,
    pub failed: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_failure: Option<String>,
    pub duration_ms: u64,
}

/// Every type that crosses the wire, for schema emission.
pub fn schema_bundle() -> Value {
    let settings = schemars::generate::SchemaSettings::draft07();
    let mut generator = settings.into_generator();
    macro_rules! add {
        ($($t:ty),* $(,)?) => { $( let _ = generator.subschema_for::<$t>(); )* };
    }
    add!(
        RequestId,
        RpcError,
        RpcMessage,
        SandboxMode,
        Enforcement,
        Decision,
        InitializeParams,
        ShellConfig,
        ShellDialect,
        InitializeResult,
        ServerCapabilities,
        CancelParams,
        ExecMode,
        ApprovalBy,
        Approval,
        ExecCommandParams,
        ExecStatus,
        ExecResult,
        JobState,
        JobInfo,
        JobIdParams,
        JobListResult,
        JobOutputParams,
        JobOutputResult,
        JobWaitParams,
        JobWriteParams,
        JobWriteResult,
        PatchApplyParams,
        PatchApplyResult,
        PatchConflictData,
        NearestMatch,
        PolicyEvaluateParams,
        PolicyEval,
        CheckpointParams,
        CheckpointCreateResult,
        CheckpointRollbackResult,
        CheckpointDiffParams,
        CheckpointDiffResult,
        CheckpointPruneParams,
        CheckpointPruneResult,
        CheckpointErrorData,
        PtcRunParams,
        PtcStatus,
        PtcRunResult,
        PtcToolCallParams,
        SandboxStatusResult,
        SandboxGrantResult,
        SandboxRevokeResult,
        SandboxRootParams,
        SandboxRootsResult,
        ShellOpenParams,
        ShellOpenResult,
        ShellWriteParams,
        ShellWriteResult,
        ShellReadParams,
        ShellReadResult,
        ShellCloseParams,
        ShellCloseResult,
    );
    let defs: serde_json::Map<String, Value> = generator
        .definitions()
        .iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    serde_json::json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "title": "HyProtocol",
        "description": format!("hy-protocol v{PROTOCOL_VERSION}"),
        "type": "object",
        "definitions": defs,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_id_untagged() -> Result<(), serde_json::Error> {
        let a: RequestId = serde_json::from_str("7")?;
        let b: RequestId = serde_json::from_str("\"s:3\"")?;
        assert_eq!(a, RequestId::Int(7));
        assert_eq!(b, RequestId::Str("s:3".into()));
        Ok(())
    }

    #[test]
    fn sandbox_mode_kebab() -> Result<(), serde_json::Error> {
        assert_eq!(
            serde_json::to_string(&SandboxMode::WorkspaceWrite)?,
            "\"workspace-write\""
        );
        Ok(())
    }

    #[test]
    fn checkpoint_ref_field_named_ref() -> Result<(), serde_json::Error> {
        let r = CheckpointCreateResult {
            reference: "refs/hy/checkpoints/a/base".into(),
            tree_oid: "t".into(),
            head_oid: None,
            unprotected: vec![],
            duration_ms: 1,
        };
        let v = serde_json::to_value(&r)?;
        assert!(v.get("ref").is_some());
        assert!(v.get("headOid").is_none());
        Ok(())
    }

    #[test]
    fn bundle_has_all_definitions() {
        let b = schema_bundle();
        let defs = b
            .get("definitions")
            .and_then(Value::as_object)
            .map(|m| m.len())
            .unwrap_or(0);
        assert!(defs >= 44, "only {defs} definitions");
    }
}
