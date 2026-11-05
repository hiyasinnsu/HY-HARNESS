//! File-system checks at `initialize` (design §4.2 item 6, Rev 3.1).
//!
//! * Volume capabilities by flags, not file-system names.
//! * Non-ACL volumes on this machine (ADR 0001 D): confined commands can write
//!   there, so they are reported as a gap.
//! * Ancestor readability (ADR 0001 B): a Low-integrity token cannot open a
//!   directory whose DACL has an ACE for a package SID applying to the object
//!   itself, which breaks `realpath` of everything below it.

use std::path::{Path, PathBuf};

use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_FLAG_BACKUP_SEMANTICS, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE,
    FILE_SHARE_READ, FILE_SHARE_WRITE, GetDriveTypeW, GetLogicalDrives, GetVolumeInformationW,
    GetVolumePathNameW, OPEN_EXISTING,
};
use windows_sys::Win32::System::SystemServices::{FILE_PERSISTENT_ACLS, FILE_SUPPORTS_HARD_LINKS};
use windows_sys::Win32::System::WindowsProgramming::{
    DRIVE_FIXED, DRIVE_RAMDISK, DRIVE_REMOTE, DRIVE_REMOVABLE,
};

use crate::impersonate;
use crate::util::{OwnedHandle, Result, check, wide};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VolumeCaps {
    pub volume_root: String,
    pub fs_name: String,
    pub persistent_acls: bool,
    pub hard_links: bool,
}

fn root_caps(root: &[u16]) -> Result<(String, u32)> {
    let mut fs_name = vec![0u16; 64];
    let mut flags = 0u32;
    // SAFETY: buffers sized as passed.
    check(
        unsafe {
            GetVolumeInformationW(
                root.as_ptr(),
                std::ptr::null_mut(),
                0,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut flags,
                fs_name.as_mut_ptr(),
                fs_name.len() as u32,
            )
        },
        "GetVolumeInformationW",
    )?;
    Ok((from_buf(&fs_name), flags))
}

fn from_buf(v: &[u16]) -> String {
    String::from_utf16_lossy(&v[..v.iter().position(|&c| c == 0).unwrap_or(v.len())])
}

pub fn volume_caps(path: &Path) -> Result<VolumeCaps> {
    let p = wide(path.as_os_str());
    let mut root = vec![0u16; 1024];
    // SAFETY: buffers sized as passed.
    check(
        unsafe { GetVolumePathNameW(p.as_ptr(), root.as_mut_ptr(), root.len() as u32) },
        "GetVolumePathNameW",
    )?;
    let (fs_name, flags) = root_caps(&root)?;
    Ok(VolumeCaps {
        volume_root: from_buf(&root),
        fs_name,
        persistent_acls: flags & FILE_PERSISTENT_ACLS != 0,
        hard_links: flags & FILE_SUPPORTS_HARD_LINKS != 0,
    })
}

/// Drive roots (fixed, removable, RAM, network) whose volume has no persistent
/// ACLs, e.g. `F:\ (exFAT)`. Drives that cannot be queried (empty card readers)
/// are skipped.
pub fn non_acl_volumes() -> Vec<String> {
    // SAFETY: no preconditions.
    let mask = unsafe { GetLogicalDrives() };
    let mut out = Vec::new();
    for i in 0..26u32 {
        if mask & (1 << i) == 0 {
            continue;
        }
        let letter = char::from(b'A' + i as u8);
        let root = wide(format!("{letter}:\\"));
        // SAFETY: valid NUL-terminated root path.
        let kind = unsafe { GetDriveTypeW(root.as_ptr()) };
        if ![DRIVE_FIXED, DRIVE_REMOVABLE, DRIVE_RAMDISK, DRIVE_REMOTE].contains(&kind) {
            continue;
        }
        if let Ok((fs, flags)) = root_caps(&root)
            && flags & FILE_PERSISTENT_ACLS == 0
        {
            out.push(format!("{letter}:\\ ({fs})"));
        }
    }
    out
}

fn open_attrs(path: &Path) -> Result<()> {
    let w = wide(path);
    // SAFETY: valid path; the handle is closed on drop.
    let h = unsafe {
        CreateFileW(
            w.as_ptr(),
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            std::ptr::null_mut(),
        )
    };
    OwnedHandle::new(h, "CreateFileW").map(drop)
}

/// Opens each path and every ancestor with `FILE_READ_ATTRIBUTES` while
/// impersonating `token`. Returns the first directory the token cannot open.
pub fn unreadable_ancestor(paths: &[&Path], token: HANDLE) -> Result<Option<(PathBuf, String)>> {
    let mut all: Vec<PathBuf> = Vec::new();
    for p in paths {
        for a in p.ancestors() {
            if !all.iter().any(|x| x == a) {
                all.push(a.to_path_buf());
            }
        }
    }
    impersonate::run_as(token, move || {
        all.into_iter()
            .find_map(|a| open_attrs(&a).err().map(|e| (a, e.to_string())))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn temp_dir_is_queryable() -> Result<()> {
        let caps = volume_caps(&std::env::temp_dir())?;
        assert!(!caps.fs_name.is_empty());
        Ok(())
    }

    #[test]
    fn non_acl_volume_listing_does_not_fail() {
        // C: (NTFS) must never be listed.
        assert!(!non_acl_volumes().iter().any(|v| v.starts_with("C:")));
    }
}
