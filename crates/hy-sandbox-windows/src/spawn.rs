//! Confined process creation (design §4.2 items 4, 5).
//!
//! `CreateProcessAsUserW` with `STARTUPINFOEX`: the caller's Job Object is
//! assigned at creation through `PROC_THREAD_ATTRIBUTE_JOB_LIST`, inheritance is
//! limited to the three stdio handles through `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`,
//! and the child inherits this process's (hidden) console: no
//! `CREATE_NO_WINDOW` / `CREATE_NEW_CONSOLE` (ADR 0001 S-4).
//!
//! The same path launches the `hy-ptc-worker` in an AppContainer
//! (`PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`, no token, design §2 / ADR 0001 F)
//! with a stdin pipe for its JSON-line bridge.

use std::ffi::c_void;
use std::os::windows::io::FromRawHandle as _;
use std::path::Path;

use windows_sys::Win32::Foundation::{
    GENERIC_READ, HANDLE, HANDLE_FLAG_INHERIT, SetHandleInformation, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::Security::{SECURITY_ATTRIBUTES, SECURITY_CAPABILITIES};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::{
    CREATE_UNICODE_ENVIRONMENT, CreateProcessAsUserW, CreateProcessW,
    DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT, GetExitCodeProcess,
    InitializeProcThreadAttributeList, LPPROC_THREAD_ATTRIBUTE_LIST,
    PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROC_THREAD_ATTRIBUTE_JOB_LIST,
    PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
    PROCESS_INFORMATION, STARTF_USESTDHANDLES, STARTUPINFOEXW, UpdateProcThreadAttribute,
    WaitForSingleObject,
};

use crate::console;
use crate::sid::Sid;
use crate::util::{OwnedHandle, Result, SandboxError, check, wide};

pub struct SpawnRequest<'a> {
    /// Primary token from `token::create_confined`; `None` runs as this
    /// process's user (used together with `app_container`).
    pub token: Option<HANDLE>,
    /// Runs the process in this AppContainer with no capabilities.
    pub app_container: Option<&'a Sid>,
    /// Gives the child a stdin pipe (returned as `ConfinedChild::stdin`)
    /// instead of `NUL`.
    pub stdin_pipe: bool,
    /// Job Object the process is created in (owned by the caller).
    pub job: HANDLE,
    pub command_line: &'a str,
    pub cwd: &'a Path,
    pub env: &'a [(String, String)],
}

pub struct ConfinedChild {
    pub process: OwnedHandle,
    pub pid: u32,
    pub stdin: Option<std::fs::File>,
    pub stdout: std::fs::File,
    pub stderr: std::fs::File,
}

/// Quotes one argument for the MSVCRT/`CommandLineToArgvW` rules.
pub fn quote_arg(arg: &str) -> String {
    if !arg.is_empty() && !arg.contains([' ', '\t', '\n', '\x0b', '"']) {
        return arg.to_string();
    }
    let mut out = String::from("\"");
    let mut backslashes = 0usize;
    for c in arg.chars() {
        match c {
            '\\' => backslashes += 1,
            '"' => {
                out.extend(std::iter::repeat_n('\\', backslashes * 2 + 1));
                out.push('"');
                backslashes = 0;
            }
            _ => {
                out.extend(std::iter::repeat_n('\\', backslashes));
                out.push(c);
                backslashes = 0;
            }
        }
    }
    out.extend(std::iter::repeat_n('\\', backslashes * 2));
    out.push('"');
    out
}

/// Builds a command line from a program and argv[1..].
pub fn command_line(program: &Path, args: &[String]) -> String {
    let mut s = quote_arg(&program.to_string_lossy());
    for a in args {
        s.push(' ');
        s.push_str(&quote_arg(a));
    }
    s
}

fn env_block(env: &[(String, String)]) -> Vec<u16> {
    let mut sorted: Vec<&(String, String)> = env.iter().collect();
    sorted.sort_by_key(|(k, _)| k.to_uppercase());
    let mut b = Vec::new();
    for (k, v) in sorted {
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

/// An output pipe: (our read end, the child's inheritable write end).
fn output_pipe() -> Result<(OwnedHandle, OwnedHandle)> {
    let sa = inheritable_sa();
    let mut r: HANDLE = std::ptr::null_mut();
    let mut w: HANDLE = std::ptr::null_mut();
    // SAFETY: valid out-pointers.
    check(unsafe { CreatePipe(&mut r, &mut w, &sa, 0) }, "CreatePipe")?;
    let (r, w) = (
        OwnedHandle::new(r, "CreatePipe")?,
        OwnedHandle::new(w, "CreatePipe")?,
    );
    // SAFETY: valid handle.
    check(
        unsafe { SetHandleInformation(r.raw(), HANDLE_FLAG_INHERIT, 0) },
        "SetHandleInformation",
    )?;
    Ok((r, w))
}

/// An input pipe: (the child's inheritable read end, our write end).
fn input_pipe() -> Result<(OwnedHandle, OwnedHandle)> {
    let sa = inheritable_sa();
    let mut r: HANDLE = std::ptr::null_mut();
    let mut w: HANDLE = std::ptr::null_mut();
    // SAFETY: valid out-pointers.
    check(unsafe { CreatePipe(&mut r, &mut w, &sa, 0) }, "CreatePipe")?;
    let (r, w) = (
        OwnedHandle::new(r, "CreatePipe")?,
        OwnedHandle::new(w, "CreatePipe")?,
    );
    // SAFETY: valid handle.
    check(
        unsafe { SetHandleInformation(w.raw(), HANDLE_FLAG_INHERIT, 0) },
        "SetHandleInformation",
    )?;
    Ok((r, w))
}

struct AttrList {
    buf: Vec<u64>,
}

// PROCESS_CREATION_MITIGATION_POLICY_* (winnt.h). These are not exported by
// windows-sys, so the two 64-bit words are spelled out here (CP-07).
const MITIGATION_DEP_ENABLE: u64 = 0x0000_0001;
const MITIGATION_SEHOP_ENABLE: u64 = 0x0000_0004;
const MITIGATION_HEAP_TERMINATE_ALWAYS_ON: u64 = 0x0000_1000;
const MITIGATION_BOTTOM_UP_ASLR_ALWAYS_ON: u64 = 0x0001_0000;
const MITIGATION_HIGH_ENTROPY_ASLR_ALWAYS_ON: u64 = 0x0010_0000;

/// The mitigation policy words passed at process creation (CP-07). Word 2 is
/// left zero on purpose: extension-point/dynamic-code restrictions break JITs
/// and some toolchains, and this layer must not make ordinary commands fail.
fn mitigation_policy() -> [u64; 2] {
    [
        MITIGATION_DEP_ENABLE
            | MITIGATION_SEHOP_ENABLE
            | MITIGATION_HEAP_TERMINATE_ALWAYS_ON
            | MITIGATION_BOTTOM_UP_ASLR_ALWAYS_ON
            | MITIGATION_HIGH_ENTROPY_ASLR_ALWAYS_ON,
        0,
    ]
}

impl AttrList {
    fn new(count: u32) -> Result<Self> {
        let mut size = 0usize;
        // SAFETY: size query.
        unsafe { InitializeProcThreadAttributeList(std::ptr::null_mut(), count, 0, &mut size) };
        let mut buf = vec![0u64; size.div_ceil(8)];
        // SAFETY: buffer of at least `size` bytes.
        check(
            unsafe {
                InitializeProcThreadAttributeList(buf.as_mut_ptr().cast(), count, 0, &mut size)
            },
            "InitializeProcThreadAttributeList",
        )?;
        Ok(Self { buf })
    }
    fn ptr(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.buf.as_mut_ptr().cast()
    }
    fn set(&mut self, attr: u32, value: *const c_void, size: usize) -> Result<()> {
        // SAFETY: `value` outlives the process creation (callers keep it on the stack).
        check(
            unsafe {
                UpdateProcThreadAttribute(
                    self.ptr(),
                    0,
                    attr as usize,
                    value,
                    size,
                    std::ptr::null_mut(),
                    std::ptr::null(),
                )
            },
            "UpdateProcThreadAttribute",
        )
    }
}

impl Drop for AttrList {
    fn drop(&mut self) {
        // SAFETY: initialized in `new`.
        unsafe { DeleteProcThreadAttributeList(self.ptr()) };
    }
}

pub fn spawn(req: &SpawnRequest<'_>) -> Result<ConfinedChild> {
    console::ensure_hidden_console()?;
    // Confined children never share the user's interactive desktop.
    let desktop = console::private_desktop()?;
    let sa = inheritable_sa();
    let (stdin, stdin_ours) = if req.stdin_pipe {
        let (r, w) = input_pipe()?;
        (r, Some(w))
    } else {
        let nul = wide("NUL");
        // SAFETY: valid path; inheritable handle owned below.
        let h = OwnedHandle::new(
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
        (h, None)
    };
    let (out_r, out_w) = output_pipe()?;
    let (err_r, err_w) = output_pipe()?;
    let stdio: [HANDLE; 3] = [stdin.raw(), out_w.raw(), err_w.raw()];

    let mut attrs = AttrList::new(if req.app_container.is_some() { 4 } else { 3 })?;
    let job = req.job;
    attrs.set(
        PROC_THREAD_ATTRIBUTE_JOB_LIST,
        (&job as *const HANDLE).cast(),
        std::mem::size_of::<HANDLE>(),
    )?;
    attrs.set(
        PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
        stdio.as_ptr().cast(),
        std::mem::size_of_val(&stdio),
    )?;
    // CP-07: mitigation policies the child cannot lower (DEP, SEHOP, heap
    // termination, bottom-up/high-entropy ASLR). Word 2 stays zero so no
    // extension-point or dynamic-code restriction breaks ordinary tools.
    let mitigation = mitigation_policy();
    attrs.set(
        PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY,
        mitigation.as_ptr().cast(),
        std::mem::size_of_val(&mitigation),
    )?;
    // Kept alive on this frame until CreateProcess returns.
    let caps = req.app_container.map(|sid| SECURITY_CAPABILITIES {
        AppContainerSid: sid.as_psid(),
        Capabilities: std::ptr::null_mut(),
        CapabilityCount: 0,
        Reserved: 0,
    });
    if let Some(c) = &caps {
        attrs.set(
            PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
            (c as *const SECURITY_CAPABILITIES).cast(),
            std::mem::size_of::<SECURITY_CAPABILITIES>(),
        )?;
    }

    // SAFETY: plain-old-data; filled below.
    let mut si: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
    si.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
    si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    si.StartupInfo.hStdInput = stdio[0];
    si.StartupInfo.hStdOutput = stdio[1];
    si.StartupInfo.hStdError = stdio[2];
    // CreateProcess*W does not write through lpDesktop; the static buffer outlives the call.
    si.StartupInfo.lpDesktop = desktop.as_ptr().cast_mut();
    si.lpAttributeList = attrs.ptr();

    let env = env_block(req.env);
    let mut cmd = wide(req.command_line);
    let cwd = wide(req.cwd);
    // SAFETY: plain-old-data output.
    let mut pi: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    let flags = EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT;
    // SAFETY: every buffer outlives the call; the token is a primary token.
    let ok = unsafe {
        match req.token {
            Some(token) => CreateProcessAsUserW(
                token,
                std::ptr::null(),
                cmd.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                1,
                flags,
                env.as_ptr().cast(),
                cwd.as_ptr(),
                &si.StartupInfo,
                &mut pi,
            ),
            None => CreateProcessW(
                std::ptr::null(),
                cmd.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                1,
                flags,
                env.as_ptr().cast(),
                cwd.as_ptr(),
                &si.StartupInfo,
                &mut pi,
            ),
        }
    };
    check(
        ok,
        if req.token.is_some() {
            "CreateProcessAsUserW"
        } else {
            "CreateProcessW"
        },
    )?;
    let process = OwnedHandle::new(pi.hProcess, "CreateProcessAsUserW")?;
    drop(OwnedHandle::new(pi.hThread, "CreateProcessAsUserW")?);
    // The child holds its own copies; ours must close so EOF arrives.
    drop((stdin, out_w, err_w));
    // SAFETY: the Files take ownership of our read ends.
    let stdout = unsafe { std::fs::File::from_raw_handle(out_r.into_raw()) };
    // SAFETY: as above.
    let stderr = unsafe { std::fs::File::from_raw_handle(err_r.into_raw()) };
    // SAFETY: as above, for our write end of stdin.
    let stdin = stdin_ours.map(|w| unsafe { std::fs::File::from_raw_handle(w.into_raw()) });
    Ok(ConfinedChild {
        process,
        pid: pi.dwProcessId,
        stdin,
        stdout,
        stderr,
    })
}

/// Waits up to `timeout_ms` (`u32::MAX` = forever). `Ok(Some(code))` when the
/// process exited, `Ok(None)` on timeout.
pub fn wait(process: &OwnedHandle, timeout_ms: u32) -> Result<Option<u32>> {
    // SAFETY: valid process handle.
    match unsafe { WaitForSingleObject(process.raw(), timeout_ms) } {
        WAIT_OBJECT_0 => {
            let mut code = 0u32;
            // SAFETY: valid process handle.
            check(
                unsafe { GetExitCodeProcess(process.raw(), &mut code) },
                "GetExitCodeProcess",
            )?;
            Ok(Some(code))
        }
        WAIT_TIMEOUT => Ok(None),
        _ => Err(SandboxError::last("WaitForSingleObject")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoting_follows_commandlinetoargvw() {
        assert_eq!(quote_arg("plain"), "plain");
        assert_eq!(quote_arg(""), "\"\"");
        assert_eq!(quote_arg("a b"), "\"a b\"");
        assert_eq!(quote_arg("say \"hi\""), "\"say \\\"hi\\\"\"");
        assert_eq!(
            quote_arg("C:\\dir with space\\"),
            "\"C:\\dir with space\\\\\""
        );
        assert_eq!(quote_arg("a\\\\b"), "a\\\\b");
    }
}
#[test]
fn cp07_mitigation_policy_sets_only_known_bits() {
    let [first, second] = mitigation_policy();
    assert_eq!(second, 0, "word 2 must stay zero to keep tools working");
    assert_eq!(first & 0x1, 0x1, "DEP");
    assert_eq!(first & 0x4, 0x4, "SEHOP");
    assert_eq!(first & 0x1000, 0x1000, "terminate on heap corruption");
    assert_eq!(first & 0x10000, 0x10000, "bottom-up ASLR");
    assert_eq!(first & 0x100000, 0x100000, "high-entropy ASLR");
}
