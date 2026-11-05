//! Running a closure under an impersonation token (design §4.4: the patcher
//! writes as the `workspace-write` token; §4.2 item 6: ancestor checks).

use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::Security::RevertToSelf;
use windows_sys::Win32::System::Threading::SetThreadToken;

use crate::util::{Result, SandboxError, check};

/// Runs `f` on a scoped thread that impersonates `token`, then reverts.
/// The calling thread never impersonates, so a panic or early return cannot
/// leave it running with the confined token.
pub fn run_as<T: Send>(token: HANDLE, f: impl FnOnce() -> T + Send) -> Result<T> {
    let raw = token as usize;
    std::thread::scope(|s| {
        s.spawn(move || -> Result<T> {
            // SAFETY: `raw` is a live impersonation token owned by the caller.
            check(
                unsafe { SetThreadToken(std::ptr::null(), raw as HANDLE) },
                "SetThreadToken",
            )?;
            let r = f();
            // SAFETY: no preconditions; drops the impersonation.
            unsafe { RevertToSelf() };
            Ok(r)
        })
        .join()
        .map_err(|_| SandboxError::Other("impersonating thread panicked".into()))?
    })
}
