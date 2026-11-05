use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;

use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, HANDLE, INVALID_HANDLE_VALUE, LocalFree,
};

#[derive(Debug, thiserror::Error)]
pub enum SandboxError {
    #[error("{api} failed: Win32 error {code} ({message})")]
    Win32 {
        api: &'static str,
        code: u32,
        message: String,
    },
    #[error("{0}")]
    Other(String),
}

pub type Result<T> = std::result::Result<T, SandboxError>;

impl SandboxError {
    pub fn last(api: &'static str) -> Self {
        // SAFETY: GetLastError has no preconditions.
        let code = unsafe { GetLastError() };
        Self::code(api, code)
    }
    pub fn code(api: &'static str, code: u32) -> Self {
        Self::Win32 {
            api,
            code,
            message: std::io::Error::from_raw_os_error(code as i32).to_string(),
        }
    }
    pub fn win32_code(&self) -> Option<u32> {
        match self {
            Self::Win32 { code, .. } => Some(*code),
            Self::Other(_) => None,
        }
    }
}

/// NUL-terminated UTF-16.
pub fn wide(s: impl AsRef<OsStr>) -> Vec<u16> {
    s.as_ref().encode_wide().chain(std::iter::once(0)).collect()
}

pub(crate) fn from_wide_ptr(p: *const u16) -> String {
    if p.is_null() {
        return String::new();
    }
    let mut len = 0usize;
    // SAFETY: caller passes a NUL-terminated UTF-16 string.
    unsafe {
        while *p.add(len) != 0 {
            len += 1;
        }
        String::from_utf16_lossy(std::slice::from_raw_parts(p, len))
    }
}

/// Owned kernel handle, closed on drop.
#[derive(Debug)]
pub struct OwnedHandle(pub HANDLE);

// SAFETY: kernel handles may be used from any thread.
unsafe impl Send for OwnedHandle {}
unsafe impl Sync for OwnedHandle {}

impl OwnedHandle {
    pub fn new(h: HANDLE, api: &'static str) -> Result<Self> {
        if h.is_null() || h == INVALID_HANDLE_VALUE {
            Err(SandboxError::last(api))
        } else {
            Ok(Self(h))
        }
    }
    pub fn raw(&self) -> HANDLE {
        self.0
    }
    /// Gives up ownership without closing.
    pub fn into_raw(self) -> HANDLE {
        let h = self.0;
        std::mem::forget(self);
        h
    }
}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
            // SAFETY: we own the handle.
            unsafe { CloseHandle(self.0) };
        }
    }
}

/// Memory returned by `LocalAlloc`-style APIs.
pub struct LocalBox(pub *mut core::ffi::c_void);

impl Drop for LocalBox {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: allocated by the system with LocalAlloc.
            unsafe { LocalFree(self.0) };
        }
    }
}

pub fn check(ok: i32, api: &'static str) -> Result<()> {
    if ok == 0 {
        Err(SandboxError::last(api))
    } else {
        Ok(())
    }
}

pub fn check_status(code: u32, api: &'static str) -> Result<()> {
    if code == 0 {
        Ok(())
    } else {
        Err(SandboxError::code(api, code))
    }
}
