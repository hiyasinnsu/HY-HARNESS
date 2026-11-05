//! Console and desktop readiness (design §4.2 item 4): children inherit our
//! console and are never created with `CREATE_NO_WINDOW` / `CREATE_NEW_CONSOLE`.
//!
//! Confined children start on a private window station and desktop that this
//! process creates (`hy-harness-<pid>\hy-harness`), as the Chromium sandbox
//! does. Their security descriptors are ours: a Low mandatory label and ACEs
//! for the caller, the logon SID, `RESTRICTED` and the AppContainer package
//! groups, so Low-integrity, restricted and AppContainer children can finish
//! `user32.dll` initialization (no `0xC0000142`). The user's interactive
//! `WinSta0\Default` is never modified (design §4.2: editing it would be a
//! session-wide side effect), and children cannot reach the user's windows.

use std::ffi::c_void;
use std::sync::OnceLock;

use windows_sys::Win32::Foundation::{ERROR_ACCESS_DENIED, GENERIC_ALL, HANDLE, HLOCAL, LocalFree};
use windows_sys::Win32::Security::Authorization::{
    ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows_sys::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};
use windows_sys::Win32::System::Console::{AllocConsole, GetConsoleWindow};
use windows_sys::Win32::UI::WindowsAndMessaging::{SW_HIDE, ShowWindow};

use crate::token;
use crate::util::{Result, SandboxError, wide};

#[link(name = "user32")]
unsafe extern "system" {
    fn GetProcessWindowStation() -> HANDLE;
    fn SetProcessWindowStation(hWinSta: HANDLE) -> i32;
    fn CreateWindowStationW(
        lpwinsta: *const u16,
        dwFlags: u32,
        dwDesiredAccess: u32,
        lpsa: *const SECURITY_ATTRIBUTES,
    ) -> HANDLE;
    fn GetUserObjectInformationW(
        hObj: HANDLE,
        nIndex: i32,
        pvInfo: *mut c_void,
        nLength: u32,
        lpnLengthNeeded: *mut u32,
    ) -> i32;
    fn CreateDesktopW(
        lpszDesktop: *const u16,
        lpszDevice: *const u16,
        pDevmode: *const c_void,
        dwFlags: u32,
        dwDesiredAccess: u32,
        lpsa: *const SECURITY_ATTRIBUTES,
    ) -> HANDLE;
}

/// `GetUserObjectInformationW` index for the object's name.
const UOI_NAME: i32 = 2;

/// The private window station and desktop, created once per process. The
/// handles stay open for the life of the process (the objects disappear with
/// it); the value is the `lpDesktop` string, NUL-terminated.
static PRIVATE_DESKTOP: OnceLock<std::result::Result<Vec<u16>, String>> = OnceLock::new();

/// `winsta\desktop` for `STARTUPINFO.lpDesktop` (NUL-terminated UTF-16).
pub fn private_desktop() -> Result<&'static [u16]> {
    PRIVATE_DESKTOP
        .get_or_init(|| create_private_desktop().map_err(|e| e.to_string()))
        .as_deref()
        .map_err(|e| SandboxError::Other(format!("private desktop unavailable: {e}")))
}

/// The security descriptor of both objects: full access for SYSTEM, the
/// caller, the caller's logon session, `RESTRICTED` (S-1-5-12) and both
/// AppContainer package groups (S-1-15-2-1, S-1-15-2-2); a Low mandatory label
/// so Low-integrity children can write to them. Nothing else gets in.
fn private_sddl() -> Result<String> {
    let base = token::open_process_token()?;
    let id = token::caller_identity(base.raw())?;
    let user = id.user.to_string_sid()?;
    let logon = id.logon.to_string_sid()?;
    Ok(format!(
        "D:P(A;;GA;;;S-1-5-18)(A;;GA;;;{user})(A;;GA;;;{logon})(A;;GA;;;S-1-5-12)(A;;GA;;;S-1-15-2-1)(A;;GA;;;S-1-15-2-2)S:(ML;;NW;;;LW)"
    ))
}

fn create_private_desktop() -> Result<Vec<u16>> {
    let sddl = wide(&private_sddl()?);
    let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    // SAFETY: valid NUL-terminated UTF-16 SDDL; `sd` receives a LocalAlloc'ed descriptor.
    let ok = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut sd,
            std::ptr::null_mut(),
        )
    };
    if ok == 0 || sd.is_null() {
        return Err(SandboxError::last(
            "ConvertStringSecurityDescriptorToSecurityDescriptorW",
        ));
    }
    let sa = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: sd,
        bInheritHandle: 0,
    };
    let station_name = format!("hy-harness-{}", std::process::id());
    let result = (|| {
        let station = wide(&station_name);
        // SAFETY: valid name and attributes; flag 0 opens an existing station of
        // the same name only if we could create it (names are per-process).
        let winsta = unsafe { CreateWindowStationW(station.as_ptr(), 0, GENERIC_ALL, &sa) };
        if winsta.is_null() {
            // Some logon sessions may not create window stations (access
            // denied). Then the private desktop goes into our current window
            // station; the user's own desktops are still never modified.
            return desktop_in_current_station(&sa);
        }
        // CreateDesktopW creates the desktop in the calling process's window
        // station, so switch to ours for the call and switch back at once.
        // SAFETY: plain handle queries/switches; `previous` is restored below.
        let previous = unsafe { GetProcessWindowStation() };
        if previous.is_null() || unsafe { SetProcessWindowStation(winsta) } == 0 {
            return Err(SandboxError::last("SetProcessWindowStation"));
        }
        let desktop_name = wide("hy-harness");
        // SAFETY: valid name and attributes; no device or mode.
        let desktop = unsafe {
            CreateDesktopW(
                desktop_name.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                GENERIC_ALL,
                &sa,
            )
        };
        let created = if desktop.is_null() {
            Err(SandboxError::last("CreateDesktopW"))
        } else {
            Ok(())
        };
        // SAFETY: restores the station we had before.
        if unsafe { SetProcessWindowStation(previous) } == 0 {
            return Err(SandboxError::last("SetProcessWindowStation (restore)"));
        }
        created?;
        // Both handles are intentionally kept open until the process exits.
        Ok(wide(format!("{station_name}\\hy-harness")))
    })();
    // SAFETY: `sd` came from ConvertStringSecurityDescriptorToSecurityDescriptorW.
    unsafe { LocalFree(sd as HLOCAL) };
    result
}

/// A private desktop in the process's own window station (the fallback when no
/// window station can be created): `<current station>\hy-harness-<pid>`.
fn desktop_in_current_station(sa: &SECURITY_ATTRIBUTES) -> Result<Vec<u16>> {
    // SAFETY: plain handle query.
    let station = unsafe { GetProcessWindowStation() };
    if station.is_null() {
        return Err(SandboxError::last("GetProcessWindowStation"));
    }
    let mut buf = [0u16; 256];
    let mut needed = 0u32;
    // SAFETY: `buf` is writable for its byte length; UOI_NAME returns a NUL-terminated name.
    let ok = unsafe {
        GetUserObjectInformationW(
            station,
            UOI_NAME,
            buf.as_mut_ptr().cast(),
            std::mem::size_of_val(&buf) as u32,
            &mut needed,
        )
    };
    if ok == 0 {
        return Err(SandboxError::last("GetUserObjectInformationW"));
    }
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    let station_name = String::from_utf16_lossy(&buf[..len]);
    let desktop = format!("hy-harness-{}", std::process::id());
    let desktop_w = wide(&desktop);
    // SAFETY: valid name and attributes; no device or mode.
    let handle = unsafe {
        CreateDesktopW(
            desktop_w.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            GENERIC_ALL,
            sa,
        )
    };
    if handle.is_null() {
        return Err(SandboxError::last("CreateDesktopW"));
    }
    // The handle is intentionally kept open until the process exits.
    Ok(wide(format!("{station_name}\\{desktop}")))
}

/// Ensures this process has a console; allocates a hidden one when it has none.
/// Returns true when a console was allocated.
pub fn ensure_hidden_console() -> Result<bool> {
    // SAFETY: no preconditions.
    if !unsafe { GetConsoleWindow() }.is_null() {
        return Ok(false);
    }
    // A process started with CREATE_NO_WINDOW already has a console (just no
    // window), so AllocConsole fails with ERROR_ACCESS_DENIED. That existing
    // console is already hidden and inheritable, which is what we want.
    if unsafe { AllocConsole() } == 0 {
        let err = SandboxError::last("AllocConsole");
        if err.win32_code() == Some(ERROR_ACCESS_DENIED) {
            return Ok(false);
        }
        return Err(err);
    }
    let hwnd = unsafe { GetConsoleWindow() };
    if !hwnd.is_null() {
        unsafe { ShowWindow(hwnd, SW_HIDE) };
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_desktop_is_named_per_process_and_created_once() {
        let first = private_desktop().unwrap_or_else(|e| panic!("{e}"));
        let name = String::from_utf16_lossy(&first[..first.len() - 1]);
        let pid = std::process::id();
        // Our own window station, or (where none can be created) our own
        // desktop in the current one; never the user's `Default`.
        assert!(
            name == format!("hy-harness-{pid}\\hy-harness")
                || name.ends_with(&format!("\\hy-harness-{pid}")),
            "{name}"
        );
        assert!(!name.ends_with("\\Default"), "{name}");
        let again = private_desktop().unwrap_or_else(|e| panic!("{e}"));
        assert!(std::ptr::eq(first, again), "created once and reused");
    }
}
