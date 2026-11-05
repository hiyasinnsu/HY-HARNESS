//! AppContainer for `hy-ptc-worker` (design §2, ADR 0001 S-5 / F).
//!
//! One capability-less profile per installation. A process in it cannot read or
//! write the workspace, open network connections, create processes, or touch
//! volumes without ACLs; Windows points its `TEMP` at the container's own
//! directory. The worker script therefore lives in a directory that grants
//! `ALL APPLICATION PACKAGES` read/execute.

use std::path::Path;

use windows_sys::Win32::Foundation::ERROR_ALREADY_EXISTS;
use windows_sys::Win32::Security::Authorization::{EXPLICIT_ACCESS_W, GRANT_ACCESS};
use windows_sys::Win32::Security::Isolation::{
    CreateAppContainerProfile, DeleteAppContainerProfile, DeriveAppContainerSidFromAppContainerName,
};
use windows_sys::Win32::Security::{
    FreeSid, NO_INHERITANCE, PSID, SUB_CONTAINERS_AND_OBJECTS_INHERIT,
};
use windows_sys::Win32::Storage::FileSystem::{FILE_GENERIC_EXECUTE, FILE_GENERIC_READ};

use crate::grants;
use crate::sid::Sid;
use crate::util::{Result, SandboxError, wide};

/// `ALL APPLICATION PACKAGES`.
pub const ALL_APP_PACKAGES: &str = "S-1-15-2-1";

/// Creates the profile, or derives its SID when it already exists.
pub fn ensure_profile(name: &str) -> Result<Sid> {
    let w = wide(name);
    let mut psid: PSID = std::ptr::null_mut();
    // SAFETY: valid strings; the SID is freed below.
    let hr = unsafe {
        CreateAppContainerProfile(
            w.as_ptr(),
            w.as_ptr(),
            w.as_ptr(),
            std::ptr::null(),
            0,
            &mut psid,
        )
    };
    if hr < 0 {
        // HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS)
        if hr as u32 != (0x8007_0000 | ERROR_ALREADY_EXISTS) {
            return Err(SandboxError::Other(format!(
                "CreateAppContainerProfile failed: HRESULT {hr:#x}"
            )));
        }
        // SAFETY: valid string; the SID is freed below.
        let hr2 = unsafe { DeriveAppContainerSidFromAppContainerName(w.as_ptr(), &mut psid) };
        if hr2 < 0 {
            return Err(SandboxError::Other(format!(
                "DeriveAppContainerSidFromAppContainerName failed: HRESULT {hr2:#x}"
            )));
        }
    }
    // SAFETY: psid is a valid SID returned above.
    let sid = unsafe { Sid::from_psid(psid) };
    // SAFETY: allocated by the calls above.
    unsafe { FreeSid(psid) };
    sid
}

/// Deletes the profile (and its per-container directory). True when it existed.
pub fn delete_profile(name: &str) -> bool {
    let w = wide(name);
    // SAFETY: valid string.
    unsafe { DeleteAppContainerProfile(w.as_ptr()) >= 0 }
}

/// Grants `ALL APPLICATION PACKAGES` read/execute on `dir` (inheritable) and
/// on the files directly in it. Idempotent.
pub fn grant_app_packages_read(dir: &Path) -> Result<()> {
    let sid = Sid::parse(ALL_APP_PACKAGES)?;
    let mut targets = vec![(dir.to_path_buf(), true)];
    let rd = std::fs::read_dir(dir)
        .map_err(|e| SandboxError::Other(format!("read_dir {}: {e}", dir.display())))?;
    for entry in rd.flatten() {
        if entry.file_type().is_ok_and(|t| t.is_file()) {
            targets.push((entry.path(), false));
        }
    }
    for (path, is_dir) in targets {
        let entry = EXPLICIT_ACCESS_W {
            grfAccessPermissions: FILE_GENERIC_READ | FILE_GENERIC_EXECUTE,
            grfAccessMode: GRANT_ACCESS,
            grfInheritance: if is_dir {
                SUB_CONTAINERS_AND_OBJECTS_INHERIT
            } else {
                NO_INHERITANCE
            },
            Trustee: grants::trustee(&sid),
        };
        grants::merge_into(&path, &[entry])?;
    }
    Ok(())
}
