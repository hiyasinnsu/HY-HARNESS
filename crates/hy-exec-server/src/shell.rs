//! WP-31: one persistent PowerShell per session.
//!
//! The shell is a long-lived child with piped stdio. Commands are written as
//! lines; after each one the wrapper loop prints `__HY_DONE__<id>:<ok>:<code>`,
//! which is how the reader finds the command boundary and its exit code without
//! guessing from prompts. Confined sessions cannot keep stdin open through
//! `CreateProcessAsUser`, so they answer with a `gap` and the control plane
//! falls back to the one-shot path.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use hy_protocol::{
    ShellCloseResult, ShellOpenParams, ShellOpenResult, ShellReadResult, ShellWriteResult,
};

/// The wrapper loop: read one line, evaluate it, print the sentinel.
const POWERSHELL_LOOP: &str = r#"
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line -eq '__HY_EXIT__') { break }
  try { Invoke-Expression $line } catch { Write-Output ('ERROR: ' + $_.Exception.Message) }
  $ok = $?
  Write-Output ('__HY_DONE__' + $__hyId + ':' + $ok + ':' + $LASTEXITCODE)
}
"#;

const SENTINEL: &str = "__HY_DONE__";

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

struct Shell {
    child: Child,
    stdin: ChildStdin,
    buffer: Arc<Mutex<Vec<u8>>>,
    eof: Arc<AtomicBool>,
    /// The sentinel of the command whose output the next read waits for.
    pending: Option<String>,
    /// Buffer length when the command was written (everything before is old).
    from: usize,
    seq: u64,
}

pub struct ShellSpec {
    pub program: std::path::PathBuf,
    pub cwd: std::path::PathBuf,
    pub env: Vec<(String, String)>,
}

pub struct ShellManager {
    shells: Mutex<HashMap<String, Arc<Mutex<Shell>>>>,
    next: AtomicU64,
}

impl Drop for ShellManager {
    fn drop(&mut self) {
        self.close_all();
    }
}

impl ShellManager {
    pub fn new() -> Self {
        Self {
            shells: Mutex::new(HashMap::new()),
            next: AtomicU64::new(1),
        }
    }

    /// Starts a shell, or explains why this session cannot have one.
    pub fn open(&self, params: &ShellOpenParams, spec: ShellSpec) -> ShellOpenResult {
        let shell_name = spec
            .program
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| spec.program.to_string_lossy().to_string());
        let cwd = spec.cwd.to_string_lossy().to_string();
        if params
            .sandbox_mode
            .as_deref()
            .is_some_and(|m| m != "unconfined")
        {
            return ShellOpenResult {
                shell_id: None,
                persistent: false,
                shell: shell_name,
                cwd,
                gap: Some("confined sessions cannot keep a persistent shell: stdin cannot be piped through the sandbox token".into()),
            };
        }
        let mut cmd = Command::new(&spec.program);
        cmd.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            POWERSHELL_LOOP,
        ])
        .current_dir(&spec.cwd)
        .env_clear()
        .envs(spec.env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = match cmd.spawn() {
            Ok(child) => child,
            Err(error) => {
                return ShellOpenResult {
                    shell_id: None,
                    persistent: false,
                    shell: shell_name,
                    cwd,
                    gap: Some(format!("could not start the persistent shell: {error}")),
                };
            }
        };
        let stdin = match child.stdin.take() {
            Some(stdin) => stdin,
            None => {
                let _ = child.kill();
                return ShellOpenResult {
                    shell_id: None,
                    persistent: false,
                    shell: shell_name,
                    cwd,
                    gap: Some("the shell has no stdin".into()),
                };
            }
        };
        let buffer = Arc::new(Mutex::new(Vec::new()));
        let eof = Arc::new(AtomicBool::new(false));
        for stream in [
            child
                .stdout
                .take()
                .map(|s| Box::new(s) as Box<dyn Read + Send>),
            child
                .stderr
                .take()
                .map(|s| Box::new(s) as Box<dyn Read + Send>),
        ]
        .into_iter()
        .flatten()
        {
            let buffer = Arc::clone(&buffer);
            let eof = Arc::clone(&eof);
            std::thread::spawn(move || {
                let mut stream = stream;
                let mut chunk = [0u8; 4096];
                loop {
                    match stream.read(&mut chunk) {
                        Ok(0) => break,
                        Ok(n) => {
                            if let Ok(mut guard) = buffer.lock() {
                                guard.extend_from_slice(&chunk[..n]);
                            }
                        }
                        Err(_) => break,
                    }
                }
                eof.store(true, Ordering::SeqCst);
            });
        }
        let id = format!("shell-{}", self.next.fetch_add(1, Ordering::Relaxed));
        let shell = Shell {
            child,
            stdin,
            buffer,
            eof,
            pending: None,
            from: 0,
            seq: 0,
        };
        if let Ok(mut shells) = self.shells.lock() {
            shells.insert(id.clone(), Arc::new(Mutex::new(shell)));
        }
        ShellOpenResult {
            shell_id: Some(id),
            persistent: true,
            shell: shell_name,
            cwd,
            gap: None,
        }
    }

    /// Writes one command; the sentinel it returns is what `read` waits for.
    pub fn write(&self, shell_id: &str, data: &str) -> Result<ShellWriteResult, String> {
        let shell = self.get(shell_id)?;
        let mut shell = shell
            .lock()
            .map_err(|_| "the shell is poisoned".to_string())?;
        shell.seq += 1;
        let sentinel = format!("hy{}", shell.seq);
        shell.from = shell.buffer.lock().map(|b| b.len()).unwrap_or(0);
        let line = format!("$__hyId = '{sentinel}'; {data}\n");
        shell
            .stdin
            .write_all(line.as_bytes())
            .and_then(|()| shell.stdin.flush())
            .map_err(|error| format!("could not write to the shell: {error}"))?;
        shell.pending = Some(sentinel.clone());
        Ok(ShellWriteResult {
            sentinel: format!("{SENTINEL}{sentinel}"),
        })
    }

    /// Waits for the sentinel of the last command and returns its output.
    pub fn read(
        &self,
        shell_id: &str,
        timeout_ms: Option<u64>,
        max_bytes: Option<u64>,
    ) -> Result<ShellReadResult, String> {
        let shell = self.get(shell_id)?;
        let deadline = Instant::now() + Duration::from_millis(timeout_ms.unwrap_or(30_000));
        let limit = max_bytes.unwrap_or(256 * 1024) as usize;
        loop {
            {
                let mut shell = shell
                    .lock()
                    .map_err(|_| "the shell is poisoned".to_string())?;
                let sentinel = match shell.pending.clone() {
                    Some(sentinel) => sentinel,
                    None => {
                        return Ok(ShellReadResult {
                            data: String::new(),
                            eof: shell.eof.load(Ordering::SeqCst),
                            timed_out: false,
                            truncated: false,
                            exit_code: None,
                        });
                    }
                };
                let eof = shell.eof.load(Ordering::SeqCst);
                let buffer = shell
                    .buffer
                    .lock()
                    .map_err(|_| "the shell buffer is poisoned".to_string())?;
                let text =
                    String::from_utf8_lossy(&buffer[shell.from.min(buffer.len())..]).to_string();
                drop(buffer);
                if let Some(found) = find_sentinel(&text, &sentinel) {
                    let (body, exit_code, consumed) = found;
                    let mut truncated = false;
                    let body = if body.len() > limit {
                        truncated = true;
                        // Keep the tail: the last lines are usually the answer.
                        body[body.len() - limit..].to_string()
                    } else {
                        body
                    };
                    shell.from = (shell.from + consumed)
                        .min(shell.buffer.lock().map(|b| b.len()).unwrap_or(shell.from));
                    shell.pending = None;
                    return Ok(ShellReadResult {
                        data: body,
                        eof,
                        timed_out: false,
                        truncated,
                        exit_code,
                    });
                }
                if eof {
                    let buffer = shell
                        .buffer
                        .lock()
                        .map_err(|_| "the shell buffer is poisoned".to_string())?;
                    let body = String::from_utf8_lossy(&buffer[shell.from.min(buffer.len())..])
                        .to_string();
                    drop(buffer);
                    shell.pending = None;
                    return Ok(ShellReadResult {
                        data: body,
                        eof: true,
                        timed_out: false,
                        truncated: false,
                        exit_code: None,
                    });
                }
            }
            if Instant::now() >= deadline {
                let mut shell = shell
                    .lock()
                    .map_err(|_| "the shell is poisoned".to_string())?;
                let buffer = shell
                    .buffer
                    .lock()
                    .map_err(|_| "the shell buffer is poisoned".to_string())?;
                let body =
                    String::from_utf8_lossy(&buffer[shell.from.min(buffer.len())..]).to_string();
                drop(buffer);
                shell.pending = None;
                let _ = shell.child.kill();
                shell.eof.store(true, Ordering::SeqCst);
                return Ok(ShellReadResult {
                    data: body,
                    eof: true,
                    timed_out: true,
                    truncated: false,
                    exit_code: None,
                });
            }
            std::thread::sleep(Duration::from_millis(15));
        }
    }

    pub fn close(&self, shell_id: &str) -> ShellCloseResult {
        let removed = self
            .shells
            .lock()
            .ok()
            .and_then(|mut shells| shells.remove(shell_id));
        match removed {
            Some(shell) => {
                if let Ok(mut shell) = shell.lock() {
                    let _ = shell.stdin.write_all(b"__HY_EXIT__\n");
                    let _ = shell.stdin.flush();
                    let _ = shell.child.kill();
                    let _ = shell.child.wait();
                }
                ShellCloseResult { closed: true }
            }
            None => ShellCloseResult { closed: false },
        }
    }

    /// Kills every shell of a run (server shutdown, cancellation).
    pub fn close_all(&self) {
        let ids: Vec<String> = self
            .shells
            .lock()
            .map(|shells| shells.keys().cloned().collect())
            .unwrap_or_default();
        for id in ids {
            self.close(&id);
        }
    }

    fn get(&self, shell_id: &str) -> Result<Arc<Mutex<Shell>>, String> {
        self.shells
            .lock()
            .map_err(|_| "the shell table is poisoned".to_string())?
            .get(shell_id)
            .cloned()
            .ok_or_else(|| format!("unknown shell {shell_id}"))
    }
}

/// Finds `__HY_DONE__<sentinel>:<ok>:<code>` in `text`; returns the output
/// before it, the exit code, and how many bytes of `text` were consumed.
fn find_sentinel(text: &str, sentinel: &str) -> Option<(String, Option<i32>, usize)> {
    let marker = format!("{SENTINEL}{sentinel}");
    let at = text.find(&marker)?;
    let after = &text[at + marker.len()..];
    let line_end = after.find('\n').unwrap_or(after.len());
    let line = after[..line_end].trim_end_matches('\r');
    let exit_code = line
        .rsplit(':')
        .next()
        .and_then(|value| value.trim().parse::<i32>().ok());
    let consumed = text
        .len()
        .min(at + marker.len() + line_end + usize::from(line_end < after.len()));
    Some((
        text[..at].trim_end_matches(['\r', '\n']).to_string(),
        exit_code,
        consumed,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sentinels_are_found_and_stripped() {
        let text = "line one\r\nline two\r\n__HY_DONE__hy3:True:0\r\n";
        let found = match find_sentinel(text, "hy3") {
            Some(found) => found,
            None => panic!("sentinel"),
        };
        let (body, code, consumed) = found;
        assert_eq!(body, "line one\r\nline two");
        assert_eq!(code, Some(0));
        assert_eq!(consumed, text.len());
    }

    #[test]
    fn a_missing_sentinel_is_not_a_match() {
        assert!(find_sentinel("output only\r\n", "hy4").is_none());
        let found = match find_sentinel("before __HY_DONE__hy5:False:1\r\n", "hy5") {
            Some(found) => found,
            None => panic!("sentinel"),
        };
        let (_, code, _) = found;
        assert_eq!(code, Some(1));
    }
}
