//! CP-02: read-only carve-outs inside a granted workspace.
//!
//! `workspace-write` grants the whole tree. A carve-out (`permissions.<name>.readOnly`
//! or `sandbox.readOnly`) adds an inherited deny-write ACE for the workspace SID
//! on that subdirectory, so the confined token can still read it but cannot
//! create, modify or delete anything below it. The user's own token is
//! unaffected; snapshots are recorded for `hy sandbox revoke`.

use std::io::Write;
use std::path::{Path, PathBuf};

use crate::grants;
use crate::sid::Sid;
use crate::util::{Result, SandboxError};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReadOnlyReport {
    pub applied: Vec<String>,
    pub missing: Vec<String>,
    pub failed: Vec<String>,
    pub first_failure: Option<String>,
}

/// Adds the deny-write ACE to each existing path, appending undo records.
pub fn apply(paths: &[PathBuf], sid: &Sid, record: &Path) -> Result<ReadOnlyReport> {
    let mut report = ReadOnlyReport::default();
    let mut lines: Vec<String> = Vec::new();
    for path in paths {
        if !path.exists() {
            report.missing.push(path.display().to_string());
            continue;
        }
        if grants::has_deny_ace_for(path, sid)? {
            // `.git` or an earlier carve-out already denies writes there.
            report.applied.push(path.display().to_string());
            continue;
        }
        match grants::add_deny_ace_tree(path, sid, grants::DENY_WRITE_MASK, false) {
            Ok(tree) => {
                for (p, sddl) in &tree.snapshots {
                    lines.push(serde_json::json!({ "path": p, "sddl": sddl }).to_string());
                }
                // A partly covered tree is a failure: some files stay writable.
                match tree.first_failure {
                    None => report.applied.push(path.display().to_string()),
                    Some(f) => {
                        report.failed.push(path.display().to_string());
                        report.first_failure.get_or_insert(f);
                    }
                }
            }
            Err(e) => {
                report.failed.push(path.display().to_string());
                report
                    .first_failure
                    .get_or_insert_with(|| format!("{}: {e}", path.display()));
            }
        }
    }
    if !lines.is_empty() {
        if let Some(dir) = record.parent() {
            std::fs::create_dir_all(dir)
                .map_err(|e| SandboxError::Other(format!("create {}: {e}", dir.display())))?;
        }
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(record)
            .map_err(|e| SandboxError::Other(format!("open {}: {e}", record.display())))?;
        for line in lines {
            writeln!(f, "{line}")
                .map_err(|e| SandboxError::Other(format!("write {}: {e}", record.display())))?;
        }
    }
    Ok(report)
}

/// Restores every object in the read-only record and removes the file.
pub fn restore(record: &Path) -> Result<grants::RevokeReport> {
    grants::restore(record)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ntfs_tempdir() -> Option<tempfile::TempDir> {
        let base = std::env::var_os("USERPROFILE").map(PathBuf::from)?;
        let dir = tempfile::Builder::new()
            .prefix("hy-read-only-test-")
            .tempdir_in(base)
            .ok()?;
        let caps = crate::fs::volume_caps(dir.path()).ok()?;
        caps.persistent_acls.then_some(dir)
    }

    #[test]
    fn carve_out_round_trips() -> Result<()> {
        let Some(dir) = ntfs_tempdir() else {
            return Ok(());
        };
        let ws = dir.path().join("ws");
        let vendor = ws.join("vendor");
        std::fs::create_dir_all(&vendor).map_err(|e| SandboxError::Other(e.to_string()))?;
        std::fs::write(ws.join("main.rs"), b"fn main() {}")
            .map_err(|e| SandboxError::Other(e.to_string()))?;
        // A file that exists before the carve-out: it must be covered too.
        let vendored = vendor.join("lib.rs");
        std::fs::write(&vendored, b"pub fn f() {}")
            .map_err(|e| SandboxError::Other(e.to_string()))?;
        let sid = crate::sid::workspace_sid(&ws.to_string_lossy())?;
        let record = dir.path().join("read-only.jsonl");

        assert!(!grants::has_deny_ace_for(&vendor, &sid)?);
        let report = apply(std::slice::from_ref(&vendor), &sid, &record)?;
        assert_eq!(report.applied.len(), 1, "{report:?}");
        assert!(grants::has_deny_ace_for(&vendor, &sid)?);
        assert!(grants::has_deny_ace_for(&vendored, &sid)?);
        assert!(
            !grants::has_deny_ace_for(&ws.join("main.rs"), &sid)?,
            "outside the carve-out"
        );

        let restored = restore(&record)?;
        assert_eq!(restored.failed, 0, "{restored:?}");
        assert!(!grants::has_deny_ace_for(&vendor, &sid)?);
        assert!(!grants::has_deny_ace_for(&vendored, &sid)?);
        assert!(!record.exists());
        Ok(())
    }
}
