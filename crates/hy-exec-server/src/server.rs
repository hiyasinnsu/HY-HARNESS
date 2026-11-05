//! JSON-RPC request handling for `hy-exec-server`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use hy_execpolicy::PolicySet;
use hy_protocol::*;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::{RwLock, watch};

use crate::checkpoint::{CheckpointEngine, CheckpointError};
use crate::cmdline::{self, Shell};
use crate::fs_guard::FsGuard;
use crate::jobs::{JobManager, SpawnSpec};
use crate::patch::{self, PatchError};
use crate::ptc::{self, PtcRuntime};
use crate::rpc::Peer;
use crate::sandbox::Sandbox;

pub struct State {
    pub workspace: PathBuf,
    pub canonical_workspace: PathBuf,
    /// Canonical extra writable roots (plain spelling) for shell cwd checks.
    pub extra_roots: parking_lot::RwLock<Vec<PathBuf>>,
    pub state_dir: PathBuf,
    pub sandbox: SandboxMode,
    pub policy: PolicySet,
    pub shell: Shell,
    pub fs_guard: FsGuard,
    pub jobs: JobManager,
    pub checkpoints: CheckpointEngine,
    pub env_passthrough: Vec<String>,
    /// The confined-token backend (design §4.2); may be unavailable.
    pub sandbox_ctx: parking_lot::RwLock<Sandbox>,
    /// `ptcNodePath` / `ptcWorkerPath` from `initialize`.
    pub ptc_paths: (Option<String>, Option<String>),
    /// Prepared on the first `ptc/run` (creates the AppContainer profile).
    pub ptc: parking_lot::Mutex<Option<Arc<PtcRuntime>>>,
    /// Persistent shells (WP-31): one per session, unconfined only.
    pub shells: crate::shell::ShellManager,
}

pub struct Server {
    peer: Peer,
    state: RwLock<Option<Arc<State>>>,
    shutdown_tx: watch::Sender<bool>,
    /// In-flight client requests keyed by request id (`$/cancelRequest`).
    in_flight: parking_lot::Mutex<HashMap<RequestId, watch::Sender<bool>>>,
}

impl Server {
    pub fn new(peer: Peer, shutdown_tx: watch::Sender<bool>) -> Self {
        Self {
            peer,
            state: RwLock::new(None),
            shutdown_tx,
            in_flight: parking_lot::Mutex::new(HashMap::new()),
        }
    }

    /// Reads JSON-RPC lines until EOF, `shutdown` or `exit`.
    pub async fn run(self: Arc<Self>) {
        let stdin = tokio::io::stdin();
        let mut lines = BufReader::new(stdin).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    if line.trim().is_empty() {
                        continue;
                    }
                    let msg = match serde_json::from_str::<RpcMessage>(&line) {
                        Ok(m) => m,
                        Err(e) => {
                            self.peer.send(RpcMessage::error_response(
                                None,
                                RpcError::new(
                                    error_code::PARSE_ERROR,
                                    format!("invalid JSON: {e}"),
                                ),
                            ));
                            continue;
                        }
                    };
                    if !self.handle_message(msg) {
                        break;
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    tracing::error!(error = %e, "stdin read failed");
                    break;
                }
            }
        }
        self.peer.fail_all("stdin closed");
    }

    fn handle_message(self: &Arc<Self>, msg: RpcMessage) -> bool {
        if let Some(method) = msg.method.clone() {
            if method == method::EXIT && msg.id.is_none() {
                let _ = self.shutdown_tx.send(true);
                return false;
            }
            if method == method::SHUTDOWN {
                if let Some(id) = msg.id.clone() {
                    self.peer.respond(id, Ok(Value::Null));
                }
                let _ = self.shutdown_tx.send(true);
                return false;
            }
            if method == method::CANCEL_REQUEST {
                if let Some(params) = msg.params
                    && let Ok(p) = serde_json::from_value::<CancelParams>(params)
                    && let Some(tx) = self.in_flight.lock().get(&p.id)
                {
                    let _ = tx.send(true);
                }
                return true;
            }
            if let Some(id) = msg.id.clone() {
                let params = msg.params.unwrap_or(Value::Null);
                let (cancel_tx, cancel_rx) = watch::channel(false);
                self.in_flight.lock().insert(id.clone(), cancel_tx);
                let this = self.clone();
                tokio::spawn(async move {
                    // `ptc/run` needs its own id: sub-calls name it in `ptc/toolCall`.
                    let result = if method == method::PTC_RUN {
                        this.ptc_run(id.clone(), params, cancel_rx).await
                    } else {
                        this.dispatch(&method, params, cancel_rx).await
                    };
                    this.in_flight.lock().remove(&id);
                    this.peer.respond(id, result);
                });
                return true;
            }
            return true;
        }
        if let Some(id) = msg.id {
            let result = match msg.error {
                Some(e) => Err(e),
                None => Ok(msg.result.unwrap_or(Value::Null)),
            };
            self.peer.resolve(&id, result);
        }
        true
    }

    async fn dispatch(
        self: &Arc<Self>,
        method: &str,
        params: Value,
        cancel: watch::Receiver<bool>,
    ) -> Result<Value, RpcError> {
        match method {
            method::INITIALIZE => self.initialize(params).await,
            _ => {
                let state = self.state.read().await.clone();
                let Some(state) = state else {
                    return Err(RpcError::new(
                        error_code::INVALID_REQUEST,
                        "server is not initialized",
                    ));
                };
                match method {
                    method::EXEC_COMMAND => self.exec_command(&state, params, cancel).await,
                    method::PATCH_APPLY => self.patch_apply(&state, params),
                    method::POLICY_EVALUATE => self.policy_evaluate(&state, params),
                    method::JOB_LIST => to_value(JobListResult {
                        jobs: state.jobs.list(),
                    }),
                    method::JOB_STATUS => self.job_status(&state, params),
                    method::JOB_OUTPUT => self.job_output(&state, params),
                    method::JOB_WAIT => self.job_wait(&state, params, cancel).await,
                    method::JOB_KILL => self.job_kill(&state, params),
                    method::JOB_WRITE => self.job_write(&state, params),
                    method::CHECKPOINT_CREATE => self.checkpoint_create(&state, params),
                    method::CHECKPOINT_ROLLBACK => self.checkpoint_rollback(&state, params),
                    method::CHECKPOINT_DIFF => self.checkpoint_diff(&state, params),
                    method::CHECKPOINT_PRUNE => self.checkpoint_prune(&state, params),
                    method::SANDBOX_STATUS => self.sandbox_status(&state),
                    // WP-31: one persistent PowerShell per session.
                    method::SHELL_OPEN => self.shell_open(&state, params),
                    method::SHELL_WRITE => {
                        let p: hy_protocol::ShellWriteParams = from_value(params)?;
                        state
                            .shells
                            .write(&p.shell_id, &p.data)
                            .map_err(|e| RpcError::new(error_code::INVALID_PARAMS, e))
                            .and_then(to_value)
                    }
                    method::SHELL_READ => self.shell_read(&state, params),
                    method::SHELL_CLOSE => {
                        let p: hy_protocol::ShellCloseParams = from_value(params)?;
                        to_value(state.shells.close(&p.shell_id))
                    }
                    method::SANDBOX_GRANT => {
                        let r = state.sandbox_ctx.write().grant_now();
                        r.map_err(|e| RpcError::new(error_code::SANDBOX_UNAVAILABLE, e))
                            .and_then(to_value)
                    }
                    method::SANDBOX_REVOKE => {
                        let r = state.sandbox_ctx.write().revoke();
                        // The PTC worker's AppContainer profile goes too (design §4.2 item 8).
                        state.ptc.lock().take();
                        hy_sandbox_windows::appcontainer::delete_profile(ptc::PROFILE);
                        r.map_err(|e| RpcError::new(error_code::SANDBOX_UNAVAILABLE, e))
                            .and_then(to_value)
                    }
                    method::SANDBOX_ADD_ROOT => {
                        let p: SandboxRootParams = from_value(params)?;
                        let canon = std::fs::canonicalize(&p.root).map_err(|e| {
                            RpcError::new(
                                error_code::INVALID_PARAMS,
                                format!("root {}: {e}", p.root),
                            )
                        })?;
                        let plain = plain_path(&canon);
                        state
                            .sandbox_ctx
                            .write()
                            .add_extra_root(&plain)
                            .map_err(|e| RpcError::new(error_code::SANDBOX_UNAVAILABLE, e))?;
                        let mut roots = state.extra_roots.write();
                        if !roots.iter().any(|root| root == &plain) {
                            roots.push(plain);
                        }
                        to_value(SandboxRootsResult {
                            roots: roots
                                .iter()
                                .map(|root| root.to_string_lossy().into_owned())
                                .collect(),
                        })
                    }
                    method::SANDBOX_REMOVE_ROOT => {
                        let p: SandboxRootParams = from_value(params)?;
                        let canon = std::fs::canonicalize(&p.root).map_err(|e| {
                            RpcError::new(
                                error_code::INVALID_PARAMS,
                                format!("root {}: {e}", p.root),
                            )
                        })?;
                        let plain = plain_path(&canon);
                        state
                            .sandbox_ctx
                            .write()
                            .remove_extra_root(&plain)
                            .map_err(|e| RpcError::new(error_code::SANDBOX_UNAVAILABLE, e))?;
                        let mut roots = state.extra_roots.write();
                        roots.retain(|root| root != &plain);
                        to_value(SandboxRootsResult {
                            roots: roots
                                .iter()
                                .map(|root| root.to_string_lossy().into_owned())
                                .collect(),
                        })
                    }
                    _ => Err(RpcError::new(
                        error_code::METHOD_NOT_FOUND,
                        format!("unknown method {method}"),
                    )),
                }
            }
        }
    }

    async fn initialize(&self, params: Value) -> Result<Value, RpcError> {
        let p: InitializeParams = from_value(params)?;
        let workspace = PathBuf::from(&p.workspace_root);
        let canonical_workspace = std::fs::canonicalize(&workspace).map_err(|e| {
            RpcError::new(error_code::INVALID_PARAMS, format!("workspace root: {e}"))
        })?;
        let state_dir = PathBuf::from(&p.state_dir);
        std::fs::create_dir_all(&state_dir)
            .map_err(|e| RpcError::new(error_code::INTERNAL_ERROR, format!("state dir: {e}")))?;
        std::fs::create_dir_all(state_dir.join("temp"))
            .map_err(|e| RpcError::new(error_code::INTERNAL_ERROR, format!("state temp: {e}")))?;

        let user_text = match &p.user_policy_path {
            Some(path) => Some((
                path.clone(),
                std::fs::read_to_string(path).map_err(|e| {
                    RpcError::new(
                        error_code::INVALID_PARAMS,
                        format!("user policy {path}: {e}"),
                    )
                })?,
            )),
            None => None,
        };
        let project_text = match &p.project_policy_path {
            Some(path) => match std::fs::read_to_string(path) {
                Ok(text) => Some((path.clone(), text)),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
                Err(e) => {
                    return Err(RpcError::new(
                        error_code::INVALID_PARAMS,
                        format!("project policy {path}: {e}"),
                    ));
                }
            },
            None => None,
        };
        let policy = PolicySet::load_layers(
            user_text.as_ref().map(|(p, t)| (p.as_str(), t.as_str())),
            project_text
                .as_ref()
                .map(|(path, text)| (path.as_str(), text.as_str(), p.project_trusted)),
        )
        .map_err(|e| RpcError::new(error_code::INVALID_PARAMS, format!("policy: {e}")))?;

        let shell = match &p.shell {
            Some(s) => Shell {
                dialect: s.dialect,
                executable: PathBuf::from(&s.executable),
            },
            None => Shell::detect(&std::env::var("PATH").unwrap_or_default()),
        };
        let fs_guard = FsGuard::new(&canonical_workspace, &p.protected_paths)
            .map_err(|e| RpcError::new(error_code::INTERNAL_ERROR, format!("fs guard: {e}")))?;
        let jobs = JobManager::new(state_dir.clone());
        // Confined modes need the grant; an unconfined session only inspects.
        let sandbox_root = plain_path(&canonical_workspace);
        let mut extra_roots = Vec::new();
        for r in &p.extra_writable_roots {
            let canon = std::fs::canonicalize(r).map_err(|e| {
                RpcError::new(
                    error_code::INVALID_PARAMS,
                    format!("extra writable root {r}: {e}"),
                )
            })?;
            extra_roots.push(plain_path(&canon));
        }
        // CP-02: `denyRead` paths are resolved here; a path that does not exist
        // is reported in `sandbox/status` rather than rejecting the session.
        let deny_read: Vec<PathBuf> = p.deny_read.iter().map(PathBuf::from).collect();
        let read_only: Vec<PathBuf> = p.read_only.iter().map(PathBuf::from).collect();
        let sandbox_ctx = Sandbox::prepare(
            &sandbox_root,
            &state_dir,
            p.sandbox != SandboxMode::Unconfined,
            &extra_roots,
            &deny_read,
            &read_only,
        );
        let guard_root = sandbox_root.clone();
        let mut checkpoints = CheckpointEngine::new(canonical_workspace.clone(), state_dir.clone())
            .with_git_guard(Box::new(move || Sandbox::check_git(&guard_root)));
        if let Ok(raw) = std::env::var("HY_MAX_UNTRACKED_FILE_BYTES")
            && let Ok(max_bytes) = raw.parse::<u64>()
        {
            checkpoints = checkpoints.with_max_untracked_bytes(max_bytes);
        }
        let state = Arc::new(State {
            workspace: canonical_workspace.clone(),
            canonical_workspace,
            extra_roots: parking_lot::RwLock::new(extra_roots.clone()),
            state_dir,
            sandbox: p.sandbox,
            policy,
            shell,
            fs_guard,
            jobs,
            checkpoints,
            env_passthrough: p.env_passthrough,
            sandbox_ctx: parking_lot::RwLock::new(sandbox_ctx),
            ptc_paths: (p.ptc_node_path.clone(), p.ptc_worker_path.clone()),
            ptc: parking_lot::Mutex::new(None),
            shells: crate::shell::ShellManager::new(),
        });
        let (enforcement, gaps, available) = {
            let sb = state.sandbox_ctx.read();
            (enforcement_of(&sb), gaps_of(&sb), sb.available)
        };
        *self.state.write().await = Some(state);
        to_value(InitializeResult {
            server_version: env!("CARGO_PKG_VERSION").into(),
            protocol_version: PROTOCOL_VERSION,
            capabilities: ServerCapabilities {
                sandbox_backends: if available {
                    vec!["none".into(), "restricted-token".into()]
                } else {
                    vec!["none".into()]
                },
                enforcement,
                gaps,
            },
        })
    }

    /// `ptc/run`: the `run_code` worker in its AppContainer (design §2).
    async fn ptc_run(
        self: &Arc<Self>,
        id: RequestId,
        params: Value,
        cancel: watch::Receiver<bool>,
    ) -> Result<Value, RpcError> {
        let Some(state) = self.state.read().await.clone() else {
            return Err(RpcError::new(
                error_code::INVALID_REQUEST,
                "server is not initialized",
            ));
        };
        let p: PtcRunParams = from_value(params)?;
        let runtime = {
            let mut slot = state.ptc.lock();
            match slot.as_ref() {
                Some(rt) => rt.clone(),
                None => {
                    let rt = Arc::new(
                        PtcRuntime::prepare(
                            state.ptc_paths.0.as_deref(),
                            state.ptc_paths.1.as_deref(),
                        )
                        .map_err(|e| {
                            RpcError::new(
                                error_code::SANDBOX_UNAVAILABLE,
                                format!("the run_code worker is unavailable: {e}"),
                            )
                        })?,
                    );
                    *slot = Some(rt.clone());
                    rt
                }
            }
        };
        let res = ptc::run(&runtime, &self.peer, id, p, cancel.clone()).await;
        if *cancel.borrow() {
            return Err(RpcError::new(error_code::CANCELLED, "request cancelled"));
        }
        to_value(res)
    }

    async fn exec_command(
        &self,
        state: &Arc<State>,
        params: Value,
        mut cancel: watch::Receiver<bool>,
    ) -> Result<Value, RpcError> {
        let p: ExecCommandParams = from_value(params)?;
        let dialect = state.shell.policy_dialect();
        let eval = state.policy.evaluate(&p.command, dialect);
        if eval.decision == Decision::Deny {
            return Err(
                RpcError::new(error_code::POLICY_DENIED, "command denied by policy").with_data(
                    json!({
                        "decision": "deny",
                        "justification": eval.justification,
                        "matchedRule": eval.matched_rule,
                    }),
                ),
            );
        }
        if eval.decision == Decision::Prompt
            && p.approval.is_none()
            && !(p.mode == ExecMode::Gate && p.user_supplied)
        {
            // The approver needs the mode: Guardian may not approve
            // `unconfined` or `low-integrity` (design §5).
            let requested = p.sandbox_mode.unwrap_or(state.sandbox);
            let would_run = effective_sandbox(requested, eval.sandbox);
            return Err(
                RpcError::new(error_code::POLICY_DENIED, "command requires approval").with_data(
                    json!({
                        "decision": "prompt",
                        "justification": eval.justification,
                        "matchedRule": eval.matched_rule,
                        "sandbox": mode_name(would_run),
                    }),
                ),
            );
        }

        let mode = if p.mode == ExecMode::Gate && p.user_supplied {
            SandboxMode::Unconfined
        } else {
            let requested = p.sandbox_mode.unwrap_or(state.sandbox);
            effective_sandbox(requested, eval.sandbox)
        };
        let (token, temp) = if mode == SandboxMode::Unconfined {
            (None, None)
        } else {
            let sb = state.sandbox_ctx.read();
            match sb.token(mode) {
                Some(t) => (Some(t as usize), sb.temp_dir().map(Path::to_path_buf)),
                None => {
                    return Err(RpcError::new(
                        error_code::SANDBOX_UNAVAILABLE,
                        format!(
                            "sandbox mode {} is unavailable: {}",
                            mode_name(mode),
                            sb.unavailable_reason.clone().unwrap_or_default()
                        ),
                    ));
                }
            }
        };

        let extra_roots = state.extra_roots.read().clone();
        let cwd = resolve_cwd(&state.canonical_workspace, &extra_roots, p.cwd.as_deref())?;
        let env = build_env(state, temp.as_deref());
        let path_var = env_value(&env, "PATH").unwrap_or_default();
        let pathext = env_value(&env, "PATHEXT").unwrap_or_else(|| ".COM;.EXE;.BAT;.CMD".into());
        let tokens = hy_execpolicy::tokenize(&p.command, dialect);
        let mut invocation =
            cmdline::plan(&p.command, &tokens, &state.shell, &path_var, &pathext, &cwd);
        // Rust std's BatBadBut-safe batch quoting is not available to a hand-built
        // CreateProcessAsUserW command line, so confined batch targets go through
        // the dialect shell, like compound commands.
        if token.is_some()
            && let cmdline::Invocation::Direct { program, .. } = &invocation
            && program
                .extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"))
        {
            invocation = cmdline::shell_invocation(&state.shell, &p.command);
        }
        tracing::debug!(kind = invocation.describe(), command = %p.command, "exec/command");
        let (program, args, raw_arg) = match invocation {
            cmdline::Invocation::Direct { program, args } => (program, args, None),
            cmdline::Invocation::Shell {
                program,
                args,
                raw_arg,
            } => (program, args, raw_arg),
        };
        let confined = token.map(|token| {
            let command_line = match &raw_arg {
                Some(raw) => format!(
                    "{} {raw}",
                    hy_sandbox_windows::spawn::quote_arg(&program.to_string_lossy())
                ),
                None => hy_sandbox_windows::spawn::command_line(&program, &args),
            };
            crate::jobs::Confined {
                token,
                command_line,
            }
        });
        let cwd = if confined.is_some() {
            plain_path(&cwd)
        } else {
            cwd
        };

        let hard_timeout = if p.mode == ExecMode::Gate {
            Some(p.hard_timeout_ms.unwrap_or(600_000))
        } else {
            p.hard_timeout_ms
        };
        let job = state
            .jobs
            .start(SpawnSpec {
                command: p.command.clone(),
                program,
                args,
                raw_arg,
                cwd,
                env,
                sandbox: mode,
                run_id: p.run_id,
                hard_timeout_ms: hard_timeout,
                confined,
                stdin_pipe: p.stdin_pipe,
            })
            .await
            .map_err(|e| RpcError::new(error_code::INTERNAL_ERROR, format!("spawn: {e}")))?;

        if p.mode == ExecMode::Gate {
            let timeout = Duration::from_millis(hard_timeout.unwrap_or(600_000));
            let finished = tokio::select! {
                f = job.wait(Some(timeout)) => f,
                () = wait_cancelled(&mut cancel) => {
                    job.kill();
                    let _ = job.wait(Some(Duration::from_secs(2))).await;
                    return Err(RpcError::new(error_code::CANCELLED, "request cancelled"));
                }
            };
            if !finished {
                job.kill();
                let _ = job.wait(Some(Duration::from_secs(5))).await;
            }
            return to_value(job.result(ExecStatus::Completed, !finished));
        }

        let wait = Duration::from_millis(p.foreground_wait_ms.unwrap_or(5_000));
        let finished = tokio::select! {
            f = job.wait(Some(wait)) => f,
            () = wait_cancelled(&mut cancel) => {
                job.kill();
                let _ = job.wait(Some(Duration::from_secs(2))).await;
                return Err(RpcError::new(error_code::CANCELLED, "request cancelled"));
            }
        };
        let status = if finished {
            ExecStatus::Completed
        } else {
            ExecStatus::Backgrounded
        };
        to_value(job.result(status, false))
    }

    fn patch_apply(&self, state: &Arc<State>, params: Value) -> Result<Value, RpcError> {
        let p: PatchApplyParams = from_value(params)?;
        // WP-12: a session that switched to read-only must not mutate files even
        // though the daemon owns a workspace-write token for the patcher.
        if p.sandbox_mode == Some(SandboxMode::ReadOnly) && !p.dry_run {
            return Err(RpcError::new(
                error_code::POLICY_DENIED,
                "read-only sandbox forbids file writes",
            )
            .with_data(json!({ "decision": "deny", "sandbox": "read-only" })));
        }
        let apply = || {
            patch::apply(
                &state.fs_guard,
                &p.patch,
                p.dry_run,
                p.enforce_protected_paths,
            )
        };
        // Writes run as the workspace-write token when the sandbox is available,
        // so the OS enforces the boundary even against a racing junction (§4.4).
        let patch_token = state.sandbox_ctx.read().patch_token();
        let result = match patch_token {
            Some(token) => hy_sandbox_windows::impersonate::run_as(token, apply).map_err(|e| {
                RpcError::new(
                    error_code::SANDBOX_UNAVAILABLE,
                    format!("impersonation: {e}"),
                )
            })?,
            None => apply(),
        }
        .map_err(patch_error)?;
        to_value(result)
    }

    fn policy_evaluate(&self, state: &Arc<State>, params: Value) -> Result<Value, RpcError> {
        let p: PolicyEvaluateParams = from_value(params)?;
        let eval = state
            .policy
            .evaluate(&p.command, state.shell.policy_dialect());
        to_value(eval)
    }

    fn job_status(&self, state: &Arc<State>, params: Value) -> Result<Value, RpcError> {
        let p: JobIdParams = from_value(params)?;
        let job = state
            .jobs
            .get(&p.job_id)
            .ok_or_else(|| RpcError::new(error_code::INVALID_PARAMS, "unknown job"))?;
        to_value(job.info())
    }

    fn job_output(&self, state: &Arc<State>, params: Value) -> Result<Value, RpcError> {
        let p: JobOutputParams = from_value(params)?;
        let job = state
            .jobs
            .get(&p.job_id)
            .ok_or_else(|| RpcError::new(error_code::INVALID_PARAMS, "unknown job"))?;
        to_value(job.output(p.offset, p.max_bytes))
    }

    async fn job_wait(
        &self,
        state: &Arc<State>,
        params: Value,
        mut cancel: watch::Receiver<bool>,
    ) -> Result<Value, RpcError> {
        let p: JobWaitParams = from_value(params)?;
        let job = state
            .jobs
            .get(&p.job_id)
            .ok_or_else(|| RpcError::new(error_code::INVALID_PARAMS, "unknown job"))?;
        tokio::select! {
            _ = job.wait(p.timeout_ms.map(Duration::from_millis)) => {}
            () = wait_cancelled(&mut cancel) => {
                return Err(RpcError::new(error_code::CANCELLED, "request cancelled"));
            }
        }
        to_value(job.info())
    }

    /// CP-09: `job/write` feeds a job started with `stdinPipe: true`.
    fn job_write(&self, state: &Arc<State>, params: Value) -> Result<Value, RpcError> {
        let p: JobWriteParams = from_value(params)?;
        let written = state
            .jobs
            .write(&p.job_id, p.data.as_bytes())
            .map_err(|e| RpcError::new(error_code::INVALID_PARAMS, e))?;
        to_value(JobWriteResult { written })
    }
    fn job_kill(&self, state: &Arc<State>, params: Value) -> Result<Value, RpcError> {
        let p: JobIdParams = from_value(params)?;
        let job = state
            .jobs
            .get(&p.job_id)
            .ok_or_else(|| RpcError::new(error_code::INVALID_PARAMS, "unknown job"))?;
        job.kill();
        to_value(job.info())
    }

    fn checkpoint_create(&self, state: &Arc<State>, params: Value) -> Result<Value, RpcError> {
        let p: CheckpointParams = from_value(params)?;
        let r = state
            .checkpoints
            .create(&p.run_id, &p.label)
            .map_err(checkpoint_error)?;
        to_value(r)
    }

    fn checkpoint_rollback(&self, state: &Arc<State>, params: Value) -> Result<Value, RpcError> {
        let p: CheckpointParams = from_value(params)?;
        // Release NTFS locks held by the run's jobs before restoring files.
        state.jobs.kill_run(&p.run_id);
        let r = state
            .checkpoints
            .rollback(&p.run_id, &p.label)
            .map_err(checkpoint_error)?;
        to_value(r)
    }

    fn checkpoint_diff(&self, state: &Arc<State>, params: Value) -> Result<Value, RpcError> {
        let p: CheckpointDiffParams = from_value(params)?;
        let r = state
            .checkpoints
            .diff(&p.run_id, &p.from_label, p.max_bytes)
            .map_err(checkpoint_error)?;
        to_value(r)
    }

    fn checkpoint_prune(&self, state: &Arc<State>, params: Value) -> Result<Value, RpcError> {
        let p: CheckpointPruneParams = from_value(params)?;
        let r = state
            .checkpoints
            .prune(&p.run_id, &p.keep)
            .map_err(checkpoint_error)?;
        to_value(r)
    }

    /// WP-31: starts the session's persistent shell (or explains the gap).
    fn shell_open(&self, state: &Arc<State>, params: Value) -> Result<Value, RpcError> {
        let p: hy_protocol::ShellOpenParams = from_value(params)?;
        let extra_roots = state.extra_roots.read().clone();
        let cwd = resolve_cwd(&state.canonical_workspace, &extra_roots, p.cwd.as_deref())?;
        let requested = p
            .sandbox_mode
            .as_deref()
            .and_then(parse_sandbox_mode)
            .unwrap_or(state.sandbox);
        if requested != SandboxMode::Unconfined {
            return to_value(hy_protocol::ShellOpenResult {
                shell_id: None,
                persistent: false,
                shell: state.shell.executable.to_string_lossy().into_owned(),
                cwd: plain_path(&cwd).to_string_lossy().into_owned(),
                gap: Some(format!(
                    "the persistent shell needs an unconfined session; this one is {}",
                    mode_name(requested)
                )),
            });
        }
        if state.shell.dialect == hy_protocol::ShellDialect::Cmd {
            return to_value(hy_protocol::ShellOpenResult {
                shell_id: None,
                persistent: false,
                shell: state.shell.executable.to_string_lossy().into_owned(),
                cwd: plain_path(&cwd).to_string_lossy().into_owned(),
                gap: Some(
                    "the persistent shell needs PowerShell (the configured shell is cmd.exe)"
                        .into(),
                ),
            });
        }
        let env = build_env(state, None);
        to_value(state.shells.open(
            &p,
            crate::shell::ShellSpec {
                program: state.shell.executable.clone(),
                cwd,
                env,
            },
        ))
    }

    fn shell_read(&self, state: &Arc<State>, params: Value) -> Result<Value, RpcError> {
        let p: hy_protocol::ShellReadParams = from_value(params)?;
        state
            .shells
            .read(&p.shell_id, p.timeout_ms, p.max_bytes)
            .map_err(|e| RpcError::new(error_code::INVALID_PARAMS, e))
            .and_then(to_value)
    }
    fn sandbox_status(&self, state: &Arc<State>) -> Result<Value, RpcError> {
        let sb = state.sandbox_ctx.read();
        let mut granted_roots = Vec::new();
        if sb.granted() {
            granted_roots.push(plain_path(&state.workspace).to_string_lossy().into_owned());
            granted_roots.extend(
                sb.extra_roots()
                    .iter()
                    .map(|r| r.to_string_lossy().into_owned()),
            );
        }
        if let Some(t) = sb.temp_dir() {
            granted_roots.push(t.to_string_lossy().into_owned());
        }
        to_value(SandboxStatusResult {
            enforcement: enforcement_of(&sb),
            gaps: gaps_of(&sb),
            workspace_write_available: sb.available,
            unavailable_reason: sb.unavailable_reason.clone(),
            granted_roots,
            unprotected_hard_links: sb.unprotected_hard_links,
            workspace_sid: sb.workspace_sid(),
            private_temp: sb.temp_dir().map(|t| t.to_string_lossy().into_owned()),
            notices: sb.notices.clone(),
            grant: sb.grant.clone(),
            deny_read: sb.deny_read.clone(),
            deny_read_missing: sb.deny_read_missing.clone(),
            deny_read_failed: sb.deny_read_failed.clone(),
            read_only: sb.read_only.clone(),
            read_only_missing: sb.read_only_missing.clone(),
            read_only_failed: sb.read_only_failed.clone(),
        })
    }

    pub async fn shutdown(&self) {
        if let Some(state) = self.state.read().await.clone() {
            state.jobs.kill_all();
            state.sandbox_ctx.read().cleanup();
        }
    }
}

pub(crate) async fn wait_cancelled(rx: &mut watch::Receiver<bool>) {
    if *rx.borrow() {
        return;
    }
    while rx.changed().await.is_ok() {
        if *rx.borrow() {
            return;
        }
    }
    std::future::pending::<()>().await;
}

fn from_value<T: serde::de::DeserializeOwned>(v: Value) -> Result<T, RpcError> {
    serde_json::from_value(v).map_err(|e| RpcError::new(error_code::INVALID_PARAMS, e.to_string()))
}

fn to_value<T: serde::Serialize>(v: T) -> Result<Value, RpcError> {
    serde_json::to_value(v).map_err(|e| RpcError::new(error_code::INTERNAL_ERROR, e.to_string()))
}

fn enforcement_of(sb: &Sandbox) -> Enforcement {
    // Reads and network are never confined (Non-Goals), so "full" is not claimed.
    if sb.available {
        Enforcement::Partial
    } else {
        Enforcement::None
    }
}

fn gaps_of(sb: &Sandbox) -> Vec<String> {
    let mut gaps = sb.gaps.clone();
    if !sb.available {
        gaps.push(format!(
            "sandbox-unavailable: {}; commands can only run unconfined and apply_patch relies on path checks only",
            sb.unavailable_reason.clone().unwrap_or_default()
        ));
    }
    gaps
}

fn mode_name(mode: SandboxMode) -> &'static str {
    match mode {
        SandboxMode::ReadOnly => "read-only",
        SandboxMode::WorkspaceWrite => "workspace-write",
        SandboxMode::LowIntegrity => "low-integrity",
        SandboxMode::Unconfined => "unconfined",
    }
}

/// The inverse of `mode_name`; an unknown name falls back to the policy default.
fn parse_sandbox_mode(name: &str) -> Option<SandboxMode> {
    match name {
        "read-only" => Some(SandboxMode::ReadOnly),
        "workspace-write" => Some(SandboxMode::WorkspaceWrite),
        "low-integrity" => Some(SandboxMode::LowIntegrity),
        "unconfined" => Some(SandboxMode::Unconfined),
        _ => None,
    }
}

/// How wide a mode is. A policy rule may narrow the session's mode but never
/// widen it (WP-12), so ranking is the only comparison needed.
fn sandbox_rank(mode: SandboxMode) -> u8 {
    match mode {
        SandboxMode::ReadOnly => 0,
        SandboxMode::WorkspaceWrite => 1,
        SandboxMode::LowIntegrity => 2,
        SandboxMode::Unconfined => 3,
    }
}

/// The mode a command actually runs in.
///
/// The session's requested mode is the default. A policy rule may narrow it,
/// and `low-integrity` is a user-authored escape hatch for tools that need a
/// Low IL token (piped Node children, test runners), so it may loosen a
/// workspace-write session. Nothing widens to `unconfined` and a read-only
/// session stays read-only.
fn effective_sandbox(requested: SandboxMode, policy: Option<SandboxMode>) -> SandboxMode {
    match policy {
        Some(SandboxMode::LowIntegrity) if requested != SandboxMode::ReadOnly => {
            SandboxMode::LowIntegrity
        }
        Some(mode) if sandbox_rank(mode) <= sandbox_rank(requested) => mode,
        _ => requested,
    }
}

/// Strips the `\\?\` prefix `canonicalize` adds to drive paths: cmd.exe
/// refuses such a current directory, and capability SIDs derive from the
/// plain spelling.
pub(crate) fn plain_path(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) if rest.as_bytes().get(1) == Some(&b':') => PathBuf::from(rest),
        _ => p.to_path_buf(),
    }
}

fn resolve_cwd(
    root: &Path,
    extra_roots: &[PathBuf],
    cwd: Option<&str>,
) -> Result<PathBuf, RpcError> {
    let Some(value) = cwd else {
        return Ok(root.to_path_buf());
    };
    let requested = Path::new(value);
    let full = if requested.is_absolute() || value.contains(':') {
        requested.to_path_buf()
    } else {
        root.join(requested)
    };
    let canon = std::fs::canonicalize(&full)
        .map_err(|e| RpcError::new(error_code::INVALID_PARAMS, format!("cwd {value}: {e}")))?;
    let canon_plain = plain_path(&canon);
    if !canon.starts_with(root)
        && !extra_roots
            .iter()
            .any(|allowed| canon_plain.starts_with(allowed))
    {
        return Err(RpcError::new(
            error_code::SANDBOX_VIOLATION,
            "cwd escapes the workspace and extra roots",
        ));
    }
    Ok(canon)
}

fn build_env(state: &State, private_temp: Option<&Path>) -> Vec<(String, String)> {
    const ALLOWED: &[&str] = &[
        "SystemRoot",
        "windir",
        "ComSpec",
        "PATHEXT",
        "PATH",
        "PSModulePath",
        "USERPROFILE",
        "HOMEDRIVE",
        "HOMEPATH",
        "APPDATA",
        "LOCALAPPDATA",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramW6432",
        "ProgramData",
        "ALLUSERSPROFILE",
        "NUMBER_OF_PROCESSORS",
        "PROCESSOR_ARCHITECTURE",
        "PROCESSOR_IDENTIFIER",
        "PROCESSOR_LEVEL",
        "PROCESSOR_REVISION",
        "OS",
    ];
    let mut keys: Vec<String> = ALLOWED.iter().map(|s| (*s).to_string()).collect();
    keys.extend(state.env_passthrough.iter().cloned());
    let mut env = Vec::new();
    for key in keys {
        if let Ok(v) = std::env::var(&key) {
            env.push((key, v));
        }
    }
    // Confined commands get the session's granted private temp.
    let temp = match private_temp {
        Some(t) => t.to_path_buf(),
        None => state.state_dir.join("temp"),
    };
    let _ = std::fs::create_dir_all(&temp);
    let temp = temp.to_string_lossy().into_owned();
    env.retain(|(k, _)| !k.eq_ignore_ascii_case("TEMP") && !k.eq_ignore_ascii_case("TMP"));
    env.push(("TEMP".into(), temp.clone()));
    env.push(("TMP".into(), temp));
    env
}

fn env_value(env: &[(String, String)], key: &str) -> Option<String> {
    env.iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(key))
        .map(|(_, v)| v.clone())
}

fn patch_error(e: PatchError) -> RpcError {
    match e {
        PatchError::Guard(g) => RpcError::new(error_code::SANDBOX_VIOLATION, g.to_string()),
        PatchError::Conflict {
            file,
            hunk,
            nearest,
        } => RpcError::new(
            error_code::PATCH_CONFLICT,
            format!("hunk {hunk} does not apply to {file}"),
        )
        .with_data(json!(PatchConflictData {
            file,
            hunk,
            nearest_match: nearest
        })),
        PatchError::Parse(m) => RpcError::new(error_code::INVALID_PARAMS, m),
        PatchError::Invalid { file, message } => {
            RpcError::new(error_code::PATCH_CONFLICT, format!("{file}: {message}")).with_data(
                json!(PatchConflictData {
                    file,
                    hunk: 0,
                    nearest_match: None
                }),
            )
        }
        PatchError::Io { file, source } => {
            RpcError::new(error_code::INTERNAL_ERROR, format!("{file}: {source}"))
        }
    }
}

fn checkpoint_error(e: CheckpointError) -> RpcError {
    match e {
        CheckpointError::HeadMoved {
            expected,
            actual,
            rollback,
        } => RpcError::new(error_code::CHECKPOINT_ERROR, "HEAD moved during the run").with_data(
            json!(CheckpointErrorData {
                kind: "HeadMoved".into(),
                detail: Some(format!("expected {expected:?}, actual {actual:?}")),
                rollback: Some(*rollback),
            }),
        ),
        CheckpointError::InvalidName(n) => {
            RpcError::new(error_code::INVALID_PARAMS, format!("invalid name: {n}"))
        }
        CheckpointError::Git(m) => {
            RpcError::new(error_code::CHECKPOINT_ERROR, m).with_data(json!(CheckpointErrorData {
                kind: "GitError".into(),
                detail: None,
                rollback: None
            }))
        }
        CheckpointError::Io(m) => {
            RpcError::new(error_code::CHECKPOINT_ERROR, m).with_data(json!(CheckpointErrorData {
                kind: "IoError".into(),
                detail: None,
                rollback: None
            }))
        }
    }
}

#[cfg(test)]
mod cwd_tests {
    use super::*;

    type TestResult = Result<(), Box<dyn std::error::Error>>;

    /// `unwrap_used` is denied for the whole workspace, tests included.
    #[test]
    fn cwd_accepts_absolute_paths_under_extra_roots() -> TestResult {
        let base = tempfile::tempdir()?;
        let main = base.path().join("main");
        let extra = base.path().join("extra");
        let sub = extra.join("sub");
        let outside = base.path().join("outside");
        for dir in [&main, &sub, &outside] {
            std::fs::create_dir_all(dir)?;
        }
        let main = std::fs::canonicalize(&main)?;
        let extra = std::fs::canonicalize(&extra)?;
        let allowed = vec![plain_path(&extra)];
        let abs = std::fs::canonicalize(&sub)?;
        let abs_str = abs
            .to_str()
            .ok_or("the temporary directory is not valid UTF-8")?;
        assert_eq!(
            resolve_cwd(&main, &allowed, Some(abs_str)).map_err(|error| format!("{error:?}"))?,
            abs
        );
        let outside_str = outside
            .to_str()
            .ok_or("the temporary directory is not valid UTF-8")?;
        assert!(resolve_cwd(&main, &allowed, Some(outside_str)).is_err());
        assert_eq!(
            resolve_cwd(&main, &allowed, Some(".")).map_err(|error| format!("{error:?}"))?,
            main
        );
        Ok(())
    }
}

#[cfg(test)]
mod sandbox_mode_tests {
    use super::*;

    #[test]
    fn a_policy_rule_may_narrow_the_session_mode() {
        // The default policy tightens unconfined sessions to workspace-write.
        assert_eq!(
            effective_sandbox(SandboxMode::Unconfined, Some(SandboxMode::WorkspaceWrite)),
            SandboxMode::WorkspaceWrite
        );
        assert_eq!(
            effective_sandbox(SandboxMode::WorkspaceWrite, Some(SandboxMode::ReadOnly)),
            SandboxMode::ReadOnly
        );
    }

    #[test]
    fn a_policy_rule_never_widens_the_session_mode() {
        // Nothing widens a read-only session, not even the low-integrity escape.
        assert_eq!(
            effective_sandbox(SandboxMode::ReadOnly, Some(SandboxMode::WorkspaceWrite)),
            SandboxMode::ReadOnly
        );
        assert_eq!(
            effective_sandbox(SandboxMode::ReadOnly, Some(SandboxMode::LowIntegrity)),
            SandboxMode::ReadOnly
        );
        assert_eq!(
            effective_sandbox(SandboxMode::ReadOnly, Some(SandboxMode::Unconfined)),
            SandboxMode::ReadOnly
        );
        // A policy rule never escalates to an unconfined token.
        assert_eq!(
            effective_sandbox(SandboxMode::WorkspaceWrite, Some(SandboxMode::Unconfined)),
            SandboxMode::WorkspaceWrite
        );
    }

    #[test]
    fn the_low_integrity_policy_escape_loosens_workspace_write() {
        // Jest/Vitest need a Low IL token for their piped workers (ADR 0001 §7).
        assert_eq!(
            effective_sandbox(SandboxMode::WorkspaceWrite, Some(SandboxMode::LowIntegrity)),
            SandboxMode::LowIntegrity
        );
        assert_eq!(
            effective_sandbox(SandboxMode::Unconfined, Some(SandboxMode::LowIntegrity)),
            SandboxMode::LowIntegrity
        );
    }

    #[test]
    fn without_a_policy_rule_the_session_mode_wins() {
        for mode in [
            SandboxMode::ReadOnly,
            SandboxMode::WorkspaceWrite,
            SandboxMode::LowIntegrity,
            SandboxMode::Unconfined,
        ] {
            assert_eq!(effective_sandbox(mode, None), mode);
        }
    }
}
