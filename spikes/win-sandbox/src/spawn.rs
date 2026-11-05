//! Confined spawn (design §4.2 items 4, 5; spike items S-2, S-4).
//!
//! `CreateProcessAsUserW` with `STARTUPINFOEX`: the Job Object is assigned at
//! creation through `PROC_THREAD_ATTRIBUTE_JOB_LIST`, and inheritance is limited
//! to the three stdio handles through `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`.

use std::ffi::c_void;
use std::io::Read as _;
use std::os::windows::io::FromRawHandle as _;
use std::path::PathBuf;
use std::time::Instant;

use serde_json::json;
use windows_sys::Win32::Foundation::{
    GENERIC_READ, HANDLE, HANDLE_FLAG_INHERIT, SetHandleInformation, WAIT_TIMEOUT,
};
use windows_sys::Win32::Security::{
    ACL, GetTokenInformation, SECURITY_ATTRIBUTES, SECURITY_CAPABILITIES, SetTokenInformation, TOKEN_DEFAULT_DACL,
    TokenDefaultDacl,
};
use windows_sys::Win32::Storage::FileSystem::{CreateFileW, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING};
use windows_sys::Win32::System::Console::{COORD, ClosePseudoConsole, CreatePseudoConsole, HPCON};
use windows_sys::Win32::System::JobObjects::{
    CreateJobObjectW, JOB_OBJECT_LIMIT_ACTIVE_PROCESS, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JobObjectExtendedLimitInformation, SetInformationJobObject, TerminateJobObject,
};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::{
    CREATE_NEW_CONSOLE, CREATE_NO_WINDOW, CREATE_UNICODE_ENVIRONMENT, CreateProcessAsUserW, CreateProcessW,
    DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT, GetExitCodeProcess, InitializeProcThreadAttributeList,
    LPPROC_THREAD_ATTRIBUTE_LIST, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROC_THREAD_ATTRIBUTE_JOB_LIST,
    PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, PROCESS_INFORMATION, STARTF_USESHOWWINDOW,
    STARTF_USESTDHANDLES, STARTUPINFOEXW, UpdateProcThreadAttribute, WaitForSingleObject,
};
use windows_sys::Win32::UI::WindowsAndMessaging::SW_HIDE;

use crate::sid::{self, Sid};
use crate::token;
use crate::util::{OwnedHandle, Result, SandboxError, check, wide};
use crate::{Args, Mode, canonical};

/// How the child gets a console (S-4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConsoleMode {
    /// Inherit this process's (hidden) console. The design's default.
    Inherit,
    /// `CREATE_NEW_CONSOLE` + `SW_HIDE`.
    Hidden,
    /// `CREATE_NO_WINDOW` (expected to reproduce `0xC0000142` under the token).
    NoWindow,
    /// A ConPTY; stdout/stderr arrive merged through the pseudo console.
    ConPty,
}

impl ConsoleMode {
    pub fn parse(s: &str) -> Result<Self> {
        match s {
            "inherit" => Ok(Self::Inherit),
            "hidden" => Ok(Self::Hidden),
            "nowindow" => Ok(Self::NoWindow),
            "conpty" => Ok(Self::ConPty),
            _ => Err(SandboxError::Other(format!("unknown --console {s}"))),
        }
    }
}

pub struct Launch {
    pub token: Option<HANDLE>,
    pub cmdline: String,
    pub cwd: Option<PathBuf>,
    pub env: Vec<(String, String)>,
    pub console: ConsoleMode,
    pub timeout_ms: u32,
    pub security_capabilities: Option<*const SECURITY_CAPABILITIES>,
    pub single_process_job: bool,
}

pub struct Outcome {
    pub exit_code: u32,
    pub timed_out: bool,
    pub ms: u128,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

const ENV_ALLOW: &[&str] = &[
    "SystemRoot",
    "windir",
    "ComSpec",
    "PATHEXT",
    "PATH",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "ProgramW6432",
    "ProgramData",
    "NUMBER_OF_PROCESSORS",
    "OS",
];

/// Design §4.2 item 5: allowlist + passthrough, TEMP/TMP to the private temp.
pub fn env_allowlist(passthrough: &[&str], temp: Option<&std::path::Path>, extra: &[(String, String)]) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = std::env::vars()
        .filter(|(k, _)| {
            ENV_ALLOW.iter().any(|a| a.eq_ignore_ascii_case(k))
                || k.to_ascii_uppercase().starts_with("PROCESSOR_")
                || passthrough.iter().any(|a| a.eq_ignore_ascii_case(k))
        })
        .collect();
    if let Some(t) = temp {
        out.push(("TEMP".into(), t.to_string_lossy().into()));
        out.push(("TMP".into(), t.to_string_lossy().into()));
    } else {
        out.extend(std::env::vars().filter(|(k, _)| k.eq_ignore_ascii_case("TEMP") || k.eq_ignore_ascii_case("TMP")));
    }
    for (k, v) in extra {
        out.retain(|(n, _)| !n.eq_ignore_ascii_case(k));
        out.push((k.clone(), v.clone()));
    }
    out.sort_by_key(|(k, _)| k.to_ascii_uppercase());
    out
}

fn env_block(env: &[(String, String)]) -> Vec<u16> {
    let mut b = Vec::new();
    for (k, v) in env {
        b.extend(format!("{k}={v}").encode_utf16());
        b.push(0);
    }
    b.push(0);
    b
}

fn inheritable_sa() -> SECURITY_ATTRIBUTES {
    SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: std::ptr::null_mut(),
        bInheritHandle: 1,
    }
}

/// (read end, write end); `inherit_write` marks which end the child gets.
fn pipe(child_gets_write: bool) -> Result<(OwnedHandle, OwnedHandle)> {
    let sa = inheritable_sa();
    let mut r: HANDLE = std::ptr::null_mut();
    let mut w: HANDLE = std::ptr::null_mut();
    check(unsafe { CreatePipe(&mut r, &mut w, &sa, 0) }, "CreatePipe")?;
    let (r, w) = (OwnedHandle::new(r, "CreatePipe")?, OwnedHandle::new(w, "CreatePipe")?);
    let ours = if child_gets_write { r.raw() } else { w.raw() };
    check(unsafe { SetHandleInformation(ours, HANDLE_FLAG_INHERIT, 0) }, "SetHandleInformation")?;
    Ok((r, w))
}

fn reader(h: OwnedHandle) -> std::thread::JoinHandle<Vec<u8>> {
    let raw = h.into_raw();
    // The File takes ownership and closes the handle when the thread ends.
    let raw_usize = raw as usize;
    std::thread::spawn(move || {
        let mut f = unsafe { std::fs::File::from_raw_handle(raw_usize as *mut c_void) };
        let mut buf = Vec::new();
        let _ = f.read_to_end(&mut buf);
        buf
    })
}

struct AttrList {
    buf: Vec<u64>,
}

impl AttrList {
    fn new(count: u32) -> Result<Self> {
        let mut size = 0usize;
        unsafe { InitializeProcThreadAttributeList(std::ptr::null_mut(), count, 0, &mut size) };
        let mut buf = vec![0u64; size.div_ceil(8)];
        check(
            unsafe { InitializeProcThreadAttributeList(buf.as_mut_ptr().cast(), count, 0, &mut size) },
            "InitializeProcThreadAttributeList",
        )?;
        Ok(Self { buf })
    }
    fn ptr(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.buf.as_mut_ptr().cast()
    }
    fn set(&mut self, attr: u32, value: *const c_void, size: usize) -> Result<()> {
        check(
            unsafe { UpdateProcThreadAttribute(self.ptr(), 0, attr as usize, value, size, std::ptr::null_mut(), std::ptr::null()) },
            "UpdateProcThreadAttribute",
        )
    }
}

impl Drop for AttrList {
    fn drop(&mut self) {
        unsafe { DeleteProcThreadAttributeList(self.ptr()) };
    }
}

fn job(single_process: bool) -> Result<OwnedHandle> {
    let h = OwnedHandle::new(unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) }, "CreateJobObjectW")?;
    let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if single_process {
        info.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
        info.BasicLimitInformation.ActiveProcessLimit = 1;
    }
    check(
        unsafe {
            SetInformationJobObject(
                h.raw(),
                JobObjectExtendedLimitInformation,
                (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        },
        "SetInformationJobObject",
    )?;
    Ok(h)
}

pub fn launch(l: &Launch) -> Result<Outcome> {
    if l.console == ConsoleMode::Inherit {
        crate::console::ensure_hidden_console()?;
    }
    let job = job(l.single_process_job)?;

    let mut conpty: Option<HPCON> = None;
    let mut child_ends: Vec<OwnedHandle> = Vec::new();
    let (out_r, err_r);
    let mut _conpty_in_w: Option<OwnedHandle> = None;
    let stdio: [HANDLE; 3];
    if l.console == ConsoleMode::ConPty {
        let (in_r, in_w) = pipe(false)?;
        let (o_r, o_w) = pipe(true)?;
        let mut hpc: HPCON = 0;
        let hr = unsafe { CreatePseudoConsole(COORD { X: 160, Y: 50 }, in_r.raw(), o_w.raw(), 0, &mut hpc) };
        if hr < 0 {
            return Err(SandboxError::Other(format!("CreatePseudoConsole failed: HRESULT {hr:#x}")));
        }
        conpty = Some(hpc);
        child_ends.push(in_r);
        child_ends.push(o_w);
        _conpty_in_w = Some(in_w);
        out_r = Some(o_r);
        err_r = None;
        stdio = [std::ptr::null_mut(); 3];
    } else {
        let sa = inheritable_sa();
        let nul = wide("NUL");
        let stdin = OwnedHandle::new(
            unsafe {
                CreateFileW(
                    nul.as_ptr(),
                    GENERIC_READ,
                    FILE_SHARE_READ | FILE_SHARE_WRITE,
                    &sa,
                    OPEN_EXISTING,
                    0,
                    std::ptr::null_mut(),
                )
            },
            "CreateFileW(NUL)",
        )?;
        let (o_r, o_w) = pipe(true)?;
        let (e_r, e_w) = pipe(true)?;
        stdio = [stdin.raw(), o_w.raw(), e_w.raw()];
        child_ends.extend([stdin, o_w, e_w]);
        out_r = Some(o_r);
        err_r = Some(e_r);
    }

    let mut attrs = AttrList::new(3)?;
    let job_raw = job.raw();
    attrs.set(PROC_THREAD_ATTRIBUTE_JOB_LIST, (&job_raw as *const HANDLE).cast(), std::mem::size_of::<HANDLE>())?;
    if let Some(hpc) = conpty {
        attrs.set(PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, hpc as *const c_void, std::mem::size_of::<HPCON>())?;
    } else {
        attrs.set(PROC_THREAD_ATTRIBUTE_HANDLE_LIST, stdio.as_ptr().cast(), std::mem::size_of_val(&stdio))?;
    }
    if let Some(sc) = l.security_capabilities {
        attrs.set(PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, sc.cast(), std::mem::size_of::<SECURITY_CAPABILITIES>())?;
    }

    let mut si: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
    si.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
    si.lpAttributeList = attrs.ptr();
    if conpty.is_none() {
        si.StartupInfo.dwFlags |= STARTF_USESTDHANDLES;
        si.StartupInfo.hStdInput = stdio[0];
        si.StartupInfo.hStdOutput = stdio[1];
        si.StartupInfo.hStdError = stdio[2];
    }
    let mut flags = EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT;
    match l.console {
        ConsoleMode::Hidden => {
            flags |= CREATE_NEW_CONSOLE;
            si.StartupInfo.dwFlags |= STARTF_USESHOWWINDOW;
            si.StartupInfo.wShowWindow = SW_HIDE as u16;
        }
        ConsoleMode::NoWindow => flags |= CREATE_NO_WINDOW,
        ConsoleMode::Inherit | ConsoleMode::ConPty => {}
    }
    let inherit = if conpty.is_some() { 0 } else { 1 };
    let env = env_block(&l.env);
    let mut cmd = wide(&l.cmdline);
    let cwd = l.cwd.as_ref().map(wide);
    let cwd_ptr = cwd.as_ref().map_or(std::ptr::null(), |c| c.as_ptr());
    let mut pi: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };

    let t0 = Instant::now();
    let ok = unsafe {
        match l.token {
            Some(tok) => CreateProcessAsUserW(
                tok,
                std::ptr::null(),
                cmd.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                inherit,
                flags,
                env.as_ptr().cast(),
                cwd_ptr,
                &si.StartupInfo,
                &mut pi,
            ),
            None => CreateProcessW(
                std::ptr::null(),
                cmd.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                inherit,
                flags,
                env.as_ptr().cast(),
                cwd_ptr,
                &si.StartupInfo,
                &mut pi,
            ),
        }
    };
    check(ok, if l.token.is_some() { "CreateProcessAsUserW" } else { "CreateProcessW" })?;
    let process = OwnedHandle::new(pi.hProcess, "CreateProcess")?;
    drop(OwnedHandle::new(pi.hThread, "CreateProcess")?);
    drop(child_ends);

    let out_t = out_r.map(reader);
    let err_t = err_r.map(reader);

    let w = unsafe { WaitForSingleObject(process.raw(), l.timeout_ms) };
    let timed_out = w == WAIT_TIMEOUT;
    let mut exit_code = 0u32;
    if timed_out {
        unsafe { TerminateJobObject(job.raw(), 0xDEAD) };
        unsafe { WaitForSingleObject(process.raw(), 5000) };
    }
    check(unsafe { GetExitCodeProcess(process.raw(), &mut exit_code) }, "GetExitCodeProcess")?;
    let ms = t0.elapsed().as_millis();
    // Kill leftover grandchildren so the pipes close.
    unsafe { TerminateJobObject(job.raw(), 0) };
    if let Some(hpc) = conpty {
        drop(_conpty_in_w.take());
        unsafe { ClosePseudoConsole(hpc) };
    }
    let stdout = out_t.and_then(|t| t.join().ok()).unwrap_or_default();
    let stderr = err_t.and_then(|t| t.join().ok()).unwrap_or_default();
    Ok(Outcome { exit_code, timed_out, ms, stdout, stderr })
}

/// Replaces the token's default DACL with the caller's original one (S-2 baseline).
fn restore_caller_default_dacl(confined: HANDLE) -> Result<()> {
    let base = token::open_process_token()?;
    let mut len = 0u32;
    unsafe { GetTokenInformation(base.raw(), TokenDefaultDacl, std::ptr::null_mut(), 0, &mut len) };
    let mut buf = vec![0u64; (len as usize).div_ceil(8)];
    check(
        unsafe { GetTokenInformation(base.raw(), TokenDefaultDacl, buf.as_mut_ptr().cast(), len, &mut len) },
        "GetTokenInformation(TokenDefaultDacl)",
    )?;
    let info = buf.as_ptr() as *const TOKEN_DEFAULT_DACL;
    let _: *mut ACL = unsafe { (*info).DefaultDacl };
    check(
        unsafe { SetTokenInformation(confined, TokenDefaultDacl, info.cast(), std::mem::size_of::<TOKEN_DEFAULT_DACL>() as u32) },
        "SetTokenInformation(TokenDefaultDacl)",
    )
}

fn tail(b: &[u8], n: usize) -> String {
    let s = String::from_utf8_lossy(b);
    let chars: Vec<char> = s.chars().collect();
    chars[chars.len().saturating_sub(n)..].iter().collect()
}

pub fn outcome_json(o: &Outcome) -> serde_json::Value {
    json!({
        "exitCode": o.exit_code as i32,
        "exitHex": format!("{:#010x}", o.exit_code),
        "timedOut": o.timed_out,
        "ms": o.ms,
        "stdout": tail(&o.stdout, 3000),
        "stderr": tail(&o.stderr, 3000),
    })
}

pub fn run_cmd(a: &Args) -> Result<serde_json::Value> {
    let mode = Mode::parse(a.get("mode").unwrap_or("ww"))?;
    let ws = a.get("workspace").map(canonical).transpose()?;
    let temp = a.get("temp").map(canonical).transpose()?;
    let ws_sid: Option<Sid> = ws.as_ref().map(|p| sid::workspace_sid(&p.to_string_lossy())).transpose()?;
    let temp_sid: Option<Sid> = temp.as_ref().map(|p| sid::temp_sid(&p.to_string_lossy())).transpose()?;
    let dacl_variant = a.get("dacl").unwrap_or("draft");

    let confined = if mode == Mode::Unconfined || a.get("variant").is_some() {
        None
    } else {
        let t = token::create_confined(mode, ws_sid.as_ref(), temp_sid.as_ref())?;
        if dacl_variant == "orig" {
            restore_caller_default_dacl(t.handle.raw())?;
        }
        Some(t)
    };
    let variant = match a.get("variant") {
        Some(spec) => Some(crate::variant::create(spec, ws_sid.as_ref(), temp_sid.as_ref())?),
        None => None,
    };

    let extra: Vec<(String, String)> =
        a.all("env").iter().filter_map(|kv| kv.split_once('=').map(|(k, v)| (k.to_string(), v.to_string()))).collect();
    let env = env_allowlist(&a.all("env-pass"), temp.as_deref(), &extra);
    let cmdline = a.rest.join(" ");
    let launch_spec = Launch {
        token: variant.as_ref().map(|v| v.handle.raw()).or(confined.as_ref().map(|t| t.handle.raw())),
        cmdline: cmdline.clone(),
        cwd: a.get("cwd").map(PathBuf::from).or(ws.clone()),
        env,
        console: ConsoleMode::parse(a.get("console").unwrap_or("inherit"))?,
        timeout_ms: a.get("timeout").and_then(|t| t.parse::<u32>().ok()).unwrap_or(600) * 1000,
        security_capabilities: None,
        single_process_job: false,
    };
    let o = launch(&launch_spec)?;
    let mut v = outcome_json(&o);
    v["mode"] = json!(format!("{mode:?}"));
    v["console"] = json!(a.get("console").unwrap_or("inherit"));
    v["dacl"] = json!(dacl_variant);
    v["cmd"] = json!(cmdline);
    v["restrictingSids"] = json!(confined.as_ref().map(|t| t.restricting_sids.clone()).or(variant.as_ref().map(|v| v.restricting.clone())));
    v["variant"] = json!(variant.as_ref().map(|v| v.flags.clone()));
    v["disabledSids"] = json!(confined.as_ref().map(|t| t.disabled_sids.clone()));
    Ok(v)
}
