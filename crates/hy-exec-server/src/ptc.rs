//! `ptc/run` (design §2, Rev 3.1 decision F): the `run_code` worker in a
//! capability-less AppContainer.
//!
//! The worker speaks newline-delimited JSON on its own stdin/stdout:
//! `run` → worker, `toolCall` ← worker, `toolResult`/`toolError` → worker,
//! `complete`/`error` ← worker. Each `toolCall` is relayed to the client as a
//! `ptc/toolCall` request, so sub-calls pass the client's guards, policy and
//! approvals exactly like direct calls. The worker cannot read or write the
//! workspace, open connections or create processes (Job Object with
//! `ActiveProcessLimit = 1`); the wall-clock limit is enforced here by
//! terminating the job, because a hung script inside the container may never
//! answer (ADR 0001 S-5).

use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use hy_protocol::{PtcRunParams, PtcRunResult, PtcStatus, RequestId};
use hy_sandbox_windows::appcontainer;
use hy_sandbox_windows::sid::Sid;
use hy_sandbox_windows::spawn::{self, SpawnRequest, quote_arg};
use serde_json::{Value, json};

use crate::cmdline;
use crate::job_object::JobHandle;
use crate::rpc::Peer;

/// One profile per installation; `hy sandbox revoke` deletes it.
pub const PROFILE: &str = "hy-harness.ptc-worker";
const MAX_TIMEOUT_MS: u64 = 30 * 60_000;
const STDERR_TAIL: usize = 4_000;

pub struct PtcRuntime {
    node: PathBuf,
    runtime_dir: PathBuf,
    worker: PathBuf,
    ac_sid: Sid,
}

impl PtcRuntime {
    /// Copies the worker into `%USERPROFILE%\.hy-harness\ptc-runtime` (readable by
    /// `ALL APPLICATION PACKAGES`; AppContainers cannot read exFAT or ordinary
    /// user directories) and creates the AppContainer profile.
    pub fn prepare(node: Option<&str>, worker_src: Option<&str>) -> Result<Self, String> {
        let worker_src = worker_src.ok_or("the client did not pass ptcWorkerPath")?;
        let node = match node {
            Some(n) => PathBuf::from(n),
            None => {
                let path = std::env::var("PATH").unwrap_or_default();
                let pathext = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE".into());
                cmdline::resolve_program("node", &path, &pathext, Path::new("."))
                    .ok_or("node was not found on PATH")?
            }
        };
        let profile = std::env::var_os("USERPROFILE").ok_or("USERPROFILE is not set")?;
        let runtime_dir = PathBuf::from(profile)
            .join(".hy-harness")
            .join("ptc-runtime");
        std::fs::create_dir_all(&runtime_dir)
            .map_err(|e| format!("create {}: {e}", runtime_dir.display()))?;
        let worker = runtime_dir.join("ptc-worker.mjs");
        let src = std::fs::read(worker_src).map_err(|e| format!("read {worker_src}: {e}"))?;
        if std::fs::read(&worker).ok().as_deref() != Some(src.as_slice()) {
            std::fs::write(&worker, &src)
                .map_err(|e| format!("write {}: {e}", worker.display()))?;
        }
        appcontainer::grant_app_packages_read(&runtime_dir)
            .map_err(|e| format!("runtime ACL: {e}"))?;
        let ac_sid = appcontainer::ensure_profile(PROFILE)
            .map_err(|e| format!("AppContainer profile: {e}"))?;
        Ok(Self {
            node,
            runtime_dir,
            worker,
            ac_sid,
        })
    }

    fn command_line(&self) -> String {
        [
            quote_arg(&self.node.to_string_lossy()),
            // An AppContainer cannot lstat C:\, so the main-module realpath fails.
            "--preserve-symlinks".into(),
            "--preserve-symlinks-main".into(),
            // Defense in depth inside the container (design §2).
            "--permission".into(),
            quote_arg(&format!("--allow-fs-read={}", self.runtime_dir.display())),
            quote_arg(&self.worker.to_string_lossy()),
        ]
        .join(" ")
    }
}

fn error_result(error: String, logs: Vec<String>, sub_calls: u32) -> PtcRunResult {
    PtcRunResult {
        status: PtcStatus::Error,
        value: None,
        error: Some(error),
        logs,
        sub_calls,
    }
}

fn logs_of(msg: &Value) -> Vec<String> {
    msg["logs"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|v| v.as_str().map_or_else(|| v.to_string(), str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

/// Runs one script. Never returns an RPC error: failures are `status: "error"`.
pub async fn run(
    rt: &PtcRuntime,
    peer: &Peer,
    run_id: RequestId,
    p: PtcRunParams,
    mut cancel: tokio::sync::watch::Receiver<bool>,
) -> PtcRunResult {
    let job = match JobHandle::new().and_then(|j| j.limit_active_processes(1).map(|()| j)) {
        Ok(j) => j,
        Err(e) => return error_result(format!("job object: {e}"), vec![], 0),
    };
    // Near-empty environment. CreateProcess fails with ERROR_ENVVAR_NOT_FOUND
    // (203) for an AppContainer without LOCALAPPDATA, from which Windows derives
    // the container's own directories (and its TEMP); the container cannot
    // read the user's LOCALAPPDATA itself.
    let env: Vec<(String, String)> = [
        "SystemRoot",
        "windir",
        "NUMBER_OF_PROCESSORS",
        "OS",
        "PROCESSOR_ARCHITECTURE",
        "LOCALAPPDATA",
    ]
    .iter()
    .filter_map(|k| std::env::var(k).ok().map(|v| ((*k).to_string(), v)))
    .collect();
    let command_line = rt.command_line();
    let child = match spawn::spawn(&SpawnRequest {
        token: None,
        app_container: Some(&rt.ac_sid),
        stdin_pipe: true,
        pty: None,
        job: job.raw(),
        command_line: &command_line,
        cwd: &rt.runtime_dir,
        env: &env,
    }) {
        Ok(c) => c,
        Err(e) => return error_result(format!("starting the AppContainer worker: {e}"), vec![], 0),
    };
    let Some(mut stdin) = child.stdin else {
        return error_result("worker has no stdin".into(), vec![], 0);
    };

    // Ordered writes on a dedicated thread: a large tool result must not block
    // the async runtime while the worker drains its pipe.
    let (to_worker, writer_rx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        for line in writer_rx {
            if stdin
                .write_all(line.as_bytes())
                .and_then(|()| stdin.write_all(b"\n"))
                .is_err()
            {
                break;
            }
        }
    });
    let (line_tx, mut lines) = tokio::sync::mpsc::unbounded_channel::<String>();
    let stdout = child.stdout;
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if line_tx.send(line).is_err() {
                break;
            }
        }
    });
    let stderr_tail = Arc::new(parking_lot::Mutex::new(String::new()));
    {
        let tail = stderr_tail.clone();
        let mut stderr = child.stderr;
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while let Ok(n) = stderr.read(&mut buf) {
                if n == 0 {
                    break;
                }
                let mut t = tail.lock();
                t.push_str(&String::from_utf8_lossy(&buf[..n]));
                let excess = t.len().saturating_sub(STDERR_TAIL);
                if excess > 0 {
                    let cut = (excess..t.len())
                        .find(|&i| t.is_char_boundary(i))
                        .unwrap_or(t.len());
                    t.drain(..cut);
                }
            }
        });
    }

    let _ = to_worker.send(json!({"type": "run", "code": p.js_code}).to_string());
    let sub_calls = Arc::new(AtomicU32::new(0));
    let deadline = tokio::time::sleep(Duration::from_millis(p.timeout_ms.clamp(1, MAX_TIMEOUT_MS)));
    tokio::pin!(deadline);

    let result = loop {
        tokio::select! {
            line = lines.recv() => {
                let Some(line) = line else {
                    let code = spawn::wait(&child.process, 5_000).ok().flatten();
                    let tail = stderr_tail.lock().clone();
                    break error_result(
                        format!("the worker exited before completing (exit code {code:?}): {}", tail.trim()),
                        vec![],
                        sub_calls.load(Ordering::SeqCst),
                    );
                };
                let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
                match msg["type"].as_str() {
                    Some("toolCall") => {
                        let id = msg["id"].clone();
                        let name = msg["name"].as_str().unwrap_or_default().to_string();
                        let n = sub_calls.fetch_add(1, Ordering::SeqCst) + 1;
                        let reject = if n > p.max_sub_calls {
                            Some(format!("too many sub-calls (limit {})", p.max_sub_calls))
                        } else if name == "runCode" || name == "run_code" {
                            Some("run_code cannot nest".to_string())
                        } else {
                            None
                        };
                        if let Some(error) = reject {
                            let _ = to_worker.send(json!({"type": "toolError", "id": id, "error": error}).to_string());
                            continue;
                        }
                        let (peer, tx, run_id, args) = (peer.clone(), to_worker.clone(), run_id.clone(), msg["args"].clone());
                        tokio::spawn(async move {
                            let reply = match peer
                                .request("ptc/toolCall", json!({"runRequestId": run_id, "name": name, "args": args}))
                                .await
                            {
                                Ok(result) => json!({"type": "toolResult", "id": id, "result": result}),
                                Err(e) => json!({"type": "toolError", "id": id, "error": e.message}),
                            };
                            let _ = tx.send(reply.to_string());
                        });
                    }
                    Some("complete") => {
                        break PtcRunResult {
                            status: PtcStatus::Ok,
                            value: Some(msg["value"].clone()),
                            error: None,
                            logs: logs_of(&msg),
                            sub_calls: sub_calls.load(Ordering::SeqCst),
                        };
                    }
                    Some("error") => {
                        break error_result(
                            msg["error"].as_str().unwrap_or("run_code failed").to_string(),
                            logs_of(&msg),
                            sub_calls.load(Ordering::SeqCst),
                        );
                    }
                    _ => {}
                }
            }
            () = &mut deadline => {
                break error_result(
                    format!("run_code timed out after {} ms; the worker was terminated", p.timeout_ms),
                    vec![],
                    sub_calls.load(Ordering::SeqCst),
                );
            }
            _ = crate::server::wait_cancelled(&mut cancel) => {
                break error_result(
                    "run_code was cancelled; the worker was terminated".to_string(),
                    vec![],
                    sub_calls.load(Ordering::SeqCst),
                );
            }
        }
    };
    // The worker never outlives its run.
    job.terminate();
    result
}
