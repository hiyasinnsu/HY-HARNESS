//! Process and job manager (design §4.3).
//!
//! Every command becomes a job. The caller waits up to `foregroundWaitMs`; after
//! that the call returns `backgrounded` and the job keeps running. Output goes
//! to an in-memory buffer (for the result) and a per-job log file (for paging
//! with `job/output`). Unconfined processes run with the caller's rights;
//! confined ones are created by `hy-sandbox-windows` under a restricted token,
//! inside their Job Object from the first instruction. Both get an allowlisted
//! environment and `stdin = NUL`.

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use hy_protocol::{ExecResult, ExecStatus, JobInfo, JobOutputResult, JobState, SandboxMode};
use parking_lot::Mutex;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::{Child, Command};
use tokio::sync::watch;

use crate::job_object::JobHandle;

/// Windows tools (cmd.exe / Windows PowerShell 5.1) often emit CP932/ANSI
/// bytes when their stdout is a pipe. Prefer UTF-8 and fall back to the local
/// Japanese ANSI code page; non-Windows keeps lossy UTF-8.
fn decode_output(bytes: &[u8]) -> String {
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.to_owned();
    }
    #[cfg(windows)]
    {
        let (text, _, _) = encoding_rs::SHIFT_JIS.decode(bytes);
        text.into_owned()
    }
    #[cfg(not(windows))]
    {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

/// Length of the longest prefix of `bytes` that does not end inside a multibyte
/// character, so a page cut at a byte offset can resume on a character boundary.
fn complete_prefix_len(bytes: &[u8]) -> usize {
    match std::str::from_utf8(bytes) {
        Ok(_) => bytes.len(),
        Err(e) => {
            if e.error_len().is_none() {
                // Valid UTF-8 up to valid_up_to(), ending with an incomplete code point.
                e.valid_up_to()
            } else {
                #[cfg(windows)]
                {
                    cp932_complete_prefix_len(bytes)
                }
                #[cfg(not(windows))]
                {
                    e.valid_up_to()
                }
            }
        }
    }
}

#[cfg(windows)]
fn cp932_complete_prefix_len(bytes: &[u8]) -> usize {
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if matches!(b, 0x81..=0x9F | 0xE0..=0xFC) {
            if i + 1 < bytes.len() {
                i += 2;
            } else {
                return i;
            }
        } else {
            i += 1;
        }
    }
    bytes.len()
}

fn is_utf8_prefix_or_complete(bytes: &[u8]) -> bool {
    match std::str::from_utf8(bytes) {
        Ok(_) => true,
        Err(e) => e.error_len().is_none(),
    }
}

fn align_tail_start(bytes: &[u8], raw_start: usize) -> usize {
    if raw_start >= bytes.len() {
        return bytes.len();
    }
    if std::str::from_utf8(bytes).is_ok() || is_utf8_prefix_or_complete(&bytes[..raw_start]) {
        let mut start = raw_start;
        while start < bytes.len() && (bytes[start] & 0xC0) == 0x80 {
            start += 1;
        }
        start
    } else {
        #[cfg(windows)]
        {
            cp932_align_start(bytes, raw_start)
        }
        #[cfg(not(windows))]
        {
            let mut start = raw_start;
            while start < bytes.len() && (bytes[start] & 0xC0) == 0x80 {
                start += 1;
            }
            start
        }
    }
}

#[cfg(windows)]
fn cp932_align_start(bytes: &[u8], target: usize) -> usize {
    let mut i = 0;
    while i < target && i < bytes.len() {
        let b = bytes[i];
        if matches!(b, 0x81..=0x9F | 0xE0..=0xFC) {
            if i + 1 >= target {
                return (i + 2).min(bytes.len());
            }
            i += 2;
        } else {
            i += 1;
        }
    }
    i.min(bytes.len())
}

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const RESULT_HEAD: usize = 10_000;
const RESULT_TAIL: usize = 20_000;
const MEM_CAP: usize = 4 * 1024 * 1024;

#[derive(Default)]
struct Captured {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    total: u64,
    truncated: bool,
}

impl Captured {
    fn append(&mut self, stream: Stream, data: &[u8]) {
        self.total += data.len() as u64;
        let buf = match stream {
            Stream::Stdout => &mut self.stdout,
            Stream::Stderr => &mut self.stderr,
        };
        if buf.len() >= MEM_CAP {
            self.truncated = true;
            return;
        }
        let take = data.len().min(MEM_CAP - buf.len());
        buf.extend_from_slice(&data[..take]);
        if take < data.len() {
            self.truncated = true;
        }
    }
}

#[derive(Clone, Copy)]
enum Stream {
    Stdout,
    Stderr,
}

/// CP-09: how `job/write` reaches a running child's stdin.
enum StdinSink {
    Tokio(tokio::sync::mpsc::UnboundedSender<Vec<u8>>),
    Std(std::sync::mpsc::Sender<Vec<u8>>),
}

pub struct Job {
    pub id: String,
    pub command: String,
    pub run_id: Option<String>,
    pub sandbox: SandboxMode,
    pid: Option<u32>,
    job_object: Option<JobHandle>,
    killed: AtomicBool,
    log_path: PathBuf,
    captured: Arc<Mutex<Captured>>,
    state: watch::Sender<Option<(JobState, Option<i64>)>>,
    started: Instant,
    /// Present only when the job was started with `stdinPipe: true`.
    stdin: std::sync::Mutex<Option<StdinSink>>,
}

impl Job {
    /// CP-09: writes bytes to the child's stdin; errors when the pipe is gone.
    pub fn write_stdin(&self, data: &[u8]) -> Result<u64, String> {
        let guard = self
            .stdin
            .lock()
            .map_err(|_| "stdin lock poisoned".to_string())?;
        match guard.as_ref() {
            Some(StdinSink::Tokio(tx)) => tx
                .send(data.to_vec())
                .map_err(|_| "the process has exited (stdin is closed)".to_string())?,
            Some(StdinSink::Std(tx)) => tx
                .send(data.to_vec())
                .map_err(|_| "the process has exited (stdin is closed)".to_string())?,
            None => {
                return Err(
                    "this job has no stdin pipe; start it with `shell { stdinPipe: true }`"
                        .to_string(),
                );
            }
        }
        Ok(data.len() as u64)
    }

    pub fn info(&self) -> JobInfo {
        let (state, exit_code) = self.state.borrow().unwrap_or((JobState::Running, None));
        let total = self.captured.lock().total;
        JobInfo {
            job_id: self.id.clone(),
            command: self.command.clone(),
            state,
            exit_code,
            output_bytes: total,
            sandbox: self.sandbox,
            run_id: self.run_id.clone(),
        }
    }

    pub fn is_running(&self) -> bool {
        self.state.borrow().is_none()
    }

    /// Waits until exit or `timeout`; true when the job has exited.
    pub async fn wait(&self, timeout: Option<Duration>) -> bool {
        let mut rx = self.state.subscribe();
        let fut = rx.wait_for(|s| s.is_some());
        match timeout {
            Some(t) => tokio::time::timeout(t, fut).await.is_ok(),
            None => fut.await.is_ok(),
        }
    }

    /// Kills the whole process tree.
    pub fn kill(&self) {
        if !self.is_running() {
            return;
        }
        self.killed.store(true, Ordering::SeqCst);
        if let Some(job) = &self.job_object {
            job.terminate();
        } else if let Some(pid) = self.pid {
            kill_tree(pid);
        }
        self.state.send_if_modified(|s| {
            if s.is_none() {
                *s = Some((JobState::Killed, None));
                true
            } else {
                false
            }
        });
    }

    pub fn result(&self, status: ExecStatus, timed_out: bool) -> ExecResult {
        let (state, exit_code) = self.state.borrow().unwrap_or((JobState::Running, None));
        let _ = state;
        let (stdout, so_trunc, stderr, se_trunc) = {
            let c = self.captured.lock();
            let (a, t1) = clip(&c.stdout);
            let (b, t2) = clip(&c.stderr);
            (a, t1, b, t2)
        };
        ExecResult {
            status,
            exit_code: if status == ExecStatus::Completed {
                exit_code
            } else {
                None
            },
            stdout,
            stderr,
            job_id: Some(self.id.clone()),
            sandbox: self.sandbox,
            truncated: so_trunc || se_trunc,
            timed_out,
            duration_ms: self.started.elapsed().as_millis() as u64,
        }
    }

    pub fn output(&self, offset: u64, max_bytes: Option<u64>) -> JobOutputResult {
        let max = max_bytes.unwrap_or(64 * 1024).min(4 * 1024 * 1024) as usize;
        let (total, mut data) = match std::fs::File::open(&self.log_path) {
            Ok(mut f) => {
                let total = f.metadata().map(|m| m.len()).unwrap_or(0);
                if offset < total {
                    let _ = f.seek(SeekFrom::Start(offset));
                    let mut buf = vec![0u8; max];
                    match f.read(&mut buf) {
                        Ok(n) => {
                            buf.truncate(n);
                            (total, buf)
                        }
                        Err(_) => (total, Vec::new()),
                    }
                } else {
                    (total, Vec::new())
                }
            }
            Err(_) => (0, Vec::new()),
        };
        if data.len() > max {
            data.truncate(max);
        }
        // A page that does not end at the authoritative end of the log must not
        // expose half of a character: `decode_output` would fail UTF-8
        // validation and re-read the whole page as Shift_JIS, turning Japanese
        // output into mojibake.
        let at_authoritative_end = (offset + data.len() as u64) >= total && !self.is_running();
        let len = page_bytes(&data, at_authoritative_end);
        data.truncate(len);
        let next = offset.saturating_add(data.len() as u64);
        let eof = !self.is_running() && next >= total;
        JobOutputResult {
            data: decode_output(&data),
            next_offset: next,
            total_bytes: total,
            eof,
        }
    }
}

fn page_bytes(data: &[u8], at_authoritative_end: bool) -> usize {
    if at_authoritative_end {
        return data.len();
    }
    let valid = complete_prefix_len(data);
    // A page smaller than one character cannot be aligned; returning 0 would
    // make `next_offset` stand still and livelock the caller.
    if valid > 0 { valid } else { data.len() }
}

fn clip(bytes: &[u8]) -> (String, bool) {
    if bytes.len() <= RESULT_HEAD + RESULT_TAIL {
        return (decode_output(bytes), false);
    }
    let head_len = complete_prefix_len(&bytes[..RESULT_HEAD]);
    let mut out = decode_output(&bytes[..head_len]);
    out.push_str("\n… [truncated] …\n");
    let tail_start = align_tail_start(bytes, bytes.len() - RESULT_TAIL);
    out.push_str(&decode_output(&bytes[tail_start..]));
    (out, true)
}

fn kill_tree(pid: u32) {
    let _ = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// What a confined spawn needs beyond the plain spec.
pub struct Confined {
    /// Primary token (`HANDLE` as an integer so the spec stays `Send`).
    pub token: usize,
    /// Fully quoted command line for `CreateProcessAsUserW`.
    pub command_line: String,
}

pub struct SpawnSpec {
    pub command: String,
    pub program: PathBuf,
    pub args: Vec<String>,
    pub raw_arg: Option<String>,
    pub cwd: PathBuf,
    pub env: Vec<(String, String)>,
    pub sandbox: SandboxMode,
    pub run_id: Option<String>,
    pub hard_timeout_ms: Option<u64>,
    pub confined: Option<Confined>,
    /// CP-09: keep stdin open and writable (`job/write`).
    pub stdin_pipe: bool,
    /// CP-09: run in a pseudo console (Windows ConPTY).
    pub tty: bool,
}

pub struct JobManager {
    jobs: Mutex<HashMap<String, Arc<Job>>>,
    next: AtomicU64,
    state_dir: PathBuf,
}

impl JobManager {
    pub fn new(state_dir: PathBuf) -> Self {
        Self {
            jobs: Mutex::new(HashMap::new()),
            next: AtomicU64::new(1),
            state_dir,
        }
    }

    pub async fn start(&self, spec: SpawnSpec) -> std::io::Result<Arc<Job>> {
        let id = format!("job-{}", self.next.fetch_add(1, Ordering::Relaxed));
        let log_dir = self.state_dir.join("jobs");
        std::fs::create_dir_all(&log_dir)?;
        let log_path = log_dir.join(format!("{id}.log"));
        // A pseudo console needs the Win32 spawn path, confined or not.
        if spec.confined.is_some() || spec.tty {
            return self.start_confined(id, log_path, spec);
        }

        let mut cmd = Command::new(&spec.program);
        if let Some(raw) = &spec.raw_arg {
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                cmd.as_std_mut().raw_arg(raw);
            }
        } else {
            cmd.args(&spec.args);
        }
        cmd.current_dir(&spec.cwd)
            .env_clear()
            .envs(spec.env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            .stdin(if spec.stdin_pipe {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.as_std_mut().creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = cmd.spawn()?;
        let pid = child.id();
        let mut job_object = JobHandle::new().ok();
        if let Some(job) = &job_object
            && let Err(e) = job.assign(&child)
        {
            tracing::warn!(job = %id, error = %e, "could not assign process to Job Object; falling back to taskkill");
            job_object = None;
        }

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let stdin = child.stdin.take().map(|mut pipe| {
            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
            tokio::spawn(async move {
                use tokio::io::AsyncWriteExt;
                while let Some(bytes) = rx.recv().await {
                    if pipe.write_all(&bytes).await.is_err() {
                        break;
                    }
                    let _ = pipe.flush().await;
                }
            });
            StdinSink::Tokio(tx)
        });
        let (state_tx, _state_rx) = watch::channel(None);
        let job = Arc::new(Job {
            id: id.clone(),
            command: spec.command,
            run_id: spec.run_id,
            sandbox: spec.sandbox,
            pid,
            job_object,
            killed: AtomicBool::new(false),
            log_path,
            captured: Arc::new(Mutex::new(Captured::default())),
            state: state_tx,
            started: Instant::now(),
            stdin: std::sync::Mutex::new(stdin),
        });
        self.jobs.lock().insert(id.clone(), job.clone());

        let out_task = spawn_reader(job.clone(), stdout, Stream::Stdout);
        let err_task = spawn_reader(job.clone(), stderr, Stream::Stderr);
        let waiter_job = job.clone();
        let hard_timeout = spec.hard_timeout_ms;
        tokio::spawn(async move {
            let status = wait_child(&mut child, hard_timeout, &waiter_job).await;
            let _ = out_task.await;
            let _ = err_task.await;
            let code = status.and_then(|s| s.code()).map(i64::from);
            let state = if waiter_job.killed.load(Ordering::SeqCst) {
                JobState::Killed
            } else {
                JobState::Exited
            };
            waiter_job.state.send_replace(Some((state, code)));
        });

        Ok(job)
    }

    fn start_confined(
        &self,
        id: String,
        log_path: PathBuf,
        spec: SpawnSpec,
    ) -> std::io::Result<Arc<Job>> {
        use hy_sandbox_windows::spawn::{self, SpawnRequest};
        // Unconfined tty jobs run as this process's user (no token).
        let (token, command_line) = match spec.confined {
            Some(c) => (
                Some(c.token as windows_sys::Win32::Foundation::HANDLE),
                c.command_line,
            ),
            None if spec.tty => {
                let mut line = spawn::quote_arg(&spec.program.to_string_lossy());
                match &spec.raw_arg {
                    Some(raw) => {
                        line.push(' ');
                        line.push_str(raw);
                    }
                    None => {
                        for arg in &spec.args {
                            line.push(' ');
                            line.push_str(&spawn::quote_arg(arg));
                        }
                    }
                }
                (None, line)
            }
            None => return Err(std::io::Error::other("not a confined spawn")),
        };
        let job_object = JobHandle::new()?;
        let child = spawn::spawn(&SpawnRequest {
            token,
            app_container: None,
            stdin_pipe: spec.stdin_pipe,
            pty: spec.tty.then_some((120, 30)),
            job: job_object.raw(),
            command_line: &command_line,
            cwd: &spec.cwd,
            env: &spec.env,
        })
        .map_err(|e| std::io::Error::other(e.to_string()))?;
        // CP-09: keep a writer thread for a stdin-pipe child.
        let stdin = child.stdin.map(|mut file| {
            let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
            std::thread::spawn(move || {
                use std::io::Write;
                for bytes in rx {
                    if file.write_all(&bytes).is_err() {
                        break;
                    }
                    let _ = file.flush();
                }
            });
            StdinSink::Std(tx)
        });
        let (state_tx, _state_rx) = watch::channel(None);
        let job = Arc::new(Job {
            id: id.clone(),
            command: spec.command,
            run_id: spec.run_id,
            sandbox: spec.sandbox,
            pid: Some(child.pid),
            job_object: Some(job_object),
            killed: AtomicBool::new(false),
            log_path,
            captured: Arc::new(Mutex::new(Captured::default())),
            state: state_tx,
            started: Instant::now(),
            stdin: std::sync::Mutex::new(stdin),
        });
        self.jobs.lock().insert(id, job.clone());

        let out_task = spawn_blocking_reader(job.clone(), child.stdout, Stream::Stdout, spec.tty);
        let err_task = spawn_blocking_reader(job.clone(), child.stderr, Stream::Stderr, false);
        let process = child.process;
        // The console must close after the process exits, or its output pipe
        // never reaches EOF and the reader (and this job) would hang.
        let pty = child.pty;
        let waiter_job = job.clone();
        // INFINITE is u32::MAX; longer timeouts are clamped just below it.
        let timeout = spec
            .hard_timeout_ms
            .map_or(u32::MAX, |ms| ms.min(u64::from(u32::MAX - 1)) as u32);
        tokio::spawn(async move {
            let kill_job = waiter_job.clone();
            let code = tokio::task::spawn_blocking(move || match spawn::wait(&process, timeout) {
                Ok(Some(code)) => Some(code),
                Ok(None) => {
                    kill_job.kill();
                    spawn::wait(&process, u32::MAX).ok().flatten()
                }
                Err(_) => None,
            })
            .await
            .ok()
            .flatten();
            drop(pty);
            let _ = out_task.await;
            let _ = err_task.await;
            let state = if waiter_job.killed.load(Ordering::SeqCst) {
                JobState::Killed
            } else {
                JobState::Exited
            };
            // Same sign convention as `ExitStatus::code()` (NTSTATUS codes are negative).
            waiter_job
                .state
                .send_replace(Some((state, code.map(|c| i64::from(c as i32)))));
        });
        Ok(job)
    }

    /// CP-09: writes bytes to a job's stdin (started with `stdinPipe: true`).
    pub fn write(&self, id: &str, data: &[u8]) -> Result<u64, String> {
        let job = self
            .jobs
            .lock()
            .get(id)
            .cloned()
            .ok_or_else(|| format!("unknown job {id}"))?;
        job.write_stdin(data)
    }
    pub fn get(&self, id: &str) -> Option<Arc<Job>> {
        self.jobs.lock().get(id).cloned()
    }

    pub fn list(&self) -> Vec<JobInfo> {
        self.jobs.lock().values().map(|j| j.info()).collect()
    }

    pub fn kill_run(&self, run_id: &str) {
        for job in self.jobs.lock().values() {
            if job.run_id.as_deref() == Some(run_id) {
                job.kill();
            }
        }
    }

    pub fn kill_all(&self) {
        for job in self.jobs.lock().values() {
            job.kill();
        }
    }
}

async fn wait_child(
    child: &mut Child,
    hard_timeout_ms: Option<u64>,
    job: &Job,
) -> Option<std::process::ExitStatus> {
    match hard_timeout_ms {
        Some(ms) => match tokio::time::timeout(Duration::from_millis(ms), child.wait()).await {
            Ok(status) => status.ok(),
            Err(_) => {
                job.kill();
                child.wait().await.ok()
            }
        },
        None => child.wait().await.ok(),
    }
}

fn spawn_reader<R>(job: Arc<Job>, stream: Option<R>, kind: Stream) -> tokio::task::JoinHandle<()>
where
    R: AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let Some(mut reader) = stream else { return };
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let data = &buf[..n];
                    job.captured.lock().append(kind, data);
                    append_log(&job.log_path, data);
                }
            }
        }
    })
}

fn spawn_blocking_reader(
    job: Arc<Job>,
    mut file: std::fs::File,
    kind: Stream,
    strip_vt: bool,
) -> tokio::task::JoinHandle<()> {
    tokio::task::spawn_blocking(move || {
        let mut buf = [0u8; 8192];
        let mut vt = VtStripper::default();
        loop {
            match file.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let raw = &buf[..n];
                    let cleaned;
                    let data: &[u8] = if strip_vt {
                        cleaned = vt.feed(raw);
                        &cleaned
                    } else {
                        raw
                    };
                    job.captured.lock().append(kind, data);
                    append_log(&job.log_path, data);
                }
            }
        }
    })
}

/// CP-09: removes terminal escape sequences from pseudo-console output, so
/// the model reads text. Keeps state across reads (a sequence may be split).
#[derive(Default)]
pub struct VtStripper {
    state: VtState,
}

#[derive(Default, Clone, Copy, PartialEq, Eq)]
enum VtState {
    #[default]
    Text,
    Esc,
    Csi,
    Osc,
    OscEsc,
}

impl VtStripper {
    pub fn feed(&mut self, input: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(input.len());
        for &b in input {
            self.state = match (self.state, b) {
                (VtState::Text, 0x1b) => VtState::Esc,
                (VtState::Text, b'\r') => VtState::Text,
                (VtState::Text, _) => {
                    out.push(b);
                    VtState::Text
                }
                (VtState::Esc, b'[') => VtState::Csi,
                (VtState::Esc, b']') => VtState::Osc,
                (VtState::Esc, _) => VtState::Text,
                // CSI ends with a byte in 0x40..=0x7E.
                (VtState::Csi, 0x40..=0x7e) => VtState::Text,
                (VtState::Csi, _) => VtState::Csi,
                // OSC ends with BEL or ESC \.
                (VtState::Osc, 0x07) => VtState::Text,
                (VtState::Osc, 0x1b) => VtState::OscEsc,
                (VtState::Osc, _) => VtState::Osc,
                (VtState::OscEsc, _) => VtState::Text,
            };
        }
        out
    }
}

#[cfg(test)]
mod vt_tests {
    use super::VtStripper;

    #[test]
    fn strips_csi_osc_and_carriage_returns_across_reads() {
        let mut vt = VtStripper::default();
        let mut out = vt.feed(b"\x1b[?25l\x1b]0;title\x07hel");
        out.extend(vt.feed(b"lo\x1b[3"));
        out.extend(vt.feed(b"2mX\x1b[0m\r\n"));
        assert_eq!(String::from_utf8_lossy(&out), "helloX\n");
    }
}

fn append_log(path: &Path, data: &[u8]) {
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = f.write_all(data);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_output_prefers_utf8() {
        assert_eq!(decode_output("日本語".as_bytes()), "日本語");
    }

    #[test]
    fn clip_keeps_utf8_when_the_cut_lands_inside_a_character() {
        // 60,000 bytes of 3-byte characters: 10,000 and 60,000 - 20,000 are not
        // multiples of 3, so a byte-wise cut splits a character at both ends.
        let bytes = "あ".repeat(20_000).into_bytes();
        let (out, truncated) = clip(&bytes);
        assert!(truncated);
        let Some((head, tail)) = out.split_once("[truncated]") else {
            panic!("no truncation marker in {} bytes of output", out.len());
        };
        for part in [head, tail] {
            assert!(
                part.chars().all(|c| matches!(c, 'あ' | '\n' | '…' | ' ')),
                "mojibake in a clipped part: {:?}",
                part.chars()
                    .filter(|c| !matches!(c, 'あ' | '\n' | '…' | ' '))
                    .take(5)
                    .collect::<String>()
            );
        }
    }

    #[test]
    fn complete_prefix_len_stops_before_a_cut_utf8_character() {
        let bytes = "あい".as_bytes(); // 6 bytes
        assert_eq!(complete_prefix_len(bytes), 6);
        assert_eq!(complete_prefix_len(&bytes[..5]), 3);
        assert_eq!(complete_prefix_len(&bytes[..4]), 3);
        assert_eq!(complete_prefix_len(&bytes[..3]), 3);
        assert_eq!(complete_prefix_len(&bytes[..2]), 0);
        assert_eq!(complete_prefix_len(b"plain ascii"), 11);
    }

    #[cfg(windows)]
    #[test]
    fn complete_prefix_len_stops_before_a_cut_cp932_character() {
        // "日本" in CP932 followed by a lone lead byte.
        let bytes = [0x93, 0xFA, 0x96, 0x7B, 0x8C];
        assert_eq!(complete_prefix_len(&bytes), 4);
        assert_eq!(complete_prefix_len(&bytes[..4]), 4);
        assert_eq!(complete_prefix_len(&bytes[..3]), 2);
    }

    #[cfg(windows)]
    #[test]
    fn decode_output_reads_cp932_japanese() {
        // "日本語" in CP932.
        let bytes = [0x93, 0xFA, 0x96, 0x7B, 0x8C, 0xEA];
        assert_eq!(decode_output(&bytes), "日本語");
    }

    #[cfg(windows)]
    #[test]
    fn clip_keeps_cp932_when_the_cut_lands_inside_a_character() {
        // "あ" in CP932 is [0x82, 0xA0] (2 bytes).
        // Prepending 1 byte of ASCII 'x' makes odd byte indices cut through characters.
        let mut bytes = vec![b'x'];
        for _ in 0..30_000 {
            bytes.extend_from_slice(&[0x82, 0xA0]);
        }
        let (out, truncated) = clip(&bytes);
        assert!(truncated);
        let Some((head, tail)) = out.split_once("[truncated]") else {
            panic!("no truncation marker");
        };
        for part in [head, tail] {
            assert!(
                part.chars()
                    .all(|c| matches!(c, 'あ' | 'x' | '\n' | '…' | ' ')),
                "mojibake in a clipped CP932 part: {:?}",
                part.chars()
                    .filter(|c| !matches!(c, 'あ' | 'x' | '\n' | '…' | ' '))
                    .take(5)
                    .collect::<String>()
            );
        }
    }

    #[test]
    fn page_bytes_keeps_a_finished_page_whole() {
        // A finished job's end is authoritative even if it looks truncated.
        let bytes = [0xE3, 0x81];
        assert_eq!(page_bytes(&bytes, true), 2);
        assert_eq!(page_bytes("あい".as_bytes(), true), 6);
        assert_eq!(page_bytes("あい".as_bytes(), false), 6);
    }

    #[test]
    fn page_bytes_trims_a_live_utf8_tail() {
        let bytes = "あい".as_bytes(); // 6 bytes
        assert_eq!(page_bytes(&bytes[..5], false), 3);
        assert_eq!(page_bytes(&bytes[..4], false), 3);
        assert_eq!(
            page_bytes(&bytes[..2], false),
            2,
            "a page shorter than one character still advances"
        );
    }

    #[cfg(windows)]
    #[test]
    fn page_bytes_trims_a_live_cp932_tail() {
        // "あ" in CP932 plus a lone lead byte at the end of the chunk.
        let bytes = [0x82, 0xA0, 0x82];
        assert_eq!(page_bytes(&bytes, false), 2);
        assert_eq!(page_bytes(&bytes, true), 3);
    }
}
