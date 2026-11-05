//! CP-02: read denial for the confined token.
//!
//! Reads used to be unconfined (`docs/enforcement-gaps.md` S1): a restricted
//! token can still read anything the user can. For each path marked `denyRead`,
//! the path and every object below it get
//!
//! * a Medium mandatory label with NO_READ_UP. This is what stops the read:
//!   every confined mode runs at Low integrity, and the user's own token is
//!   Medium, so the user keeps full access;
//! * a deny ACE for the workspace SID, which blocks writes by the
//!   workspace-write token. It cannot block reads on its own: the token is
//!   WRITE_RESTRICTED, so restricting SIDs are only checked for writes.
//!
//! Existing children are changed one by one (no inheritance propagation), and
//! the inheritable entries cover objects created later.
//!
//! Snapshots of the original SDDL are appended to a JSONL record next to the
//! grant record; `hy sandbox revoke` restores them.

use std::io::Write;
use std::path::{Path, PathBuf};

use crate::grants;
use crate::sid::Sid;
use crate::util::{Result, SandboxError};

/// `FILE_GENERIC_READ` | `FILE_GENERIC_EXECUTE`: read/list, read attributes and
/// extended attributes, read control, traverse/execute, synchronize.
pub const DENY_READ_MASK: u32 = 0x0012_00A9;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DenyReport {
    /// Paths that now carry the deny ACE.
    pub denied: Vec<String>,
    /// Paths that do not exist (not an error: the user may deny a path that
    /// only some machines have, e.g. `%USERPROFILE%\.aws`).
    pub missing: Vec<String>,
    pub failed: Vec<String>,
    pub first_failure: Option<String>,
}

/// Denies read access to each existing path for `sid`, appending undo records
/// to `record`. Errors on one path do not stop the others.
pub fn apply(paths: &[PathBuf], sid: &Sid, record: &Path) -> Result<DenyReport> {
    let mut report = DenyReport::default();
    let mut lines: Vec<String> = Vec::new();
    for path in paths {
        if !path.exists() {
            report.missing.push(path.display().to_string());
            continue;
        }
        if grants::has_deny_ace_for(path, sid)? {
            // An earlier session already denied it; its snapshot is on record.
            report.denied.push(path.display().to_string());
            continue;
        }
        match grants::add_deny_ace_tree(path, sid, DENY_READ_MASK, true) {
            Ok(tree) => {
                for (p, sddl) in &tree.snapshots {
                    lines.push(serde_json::json!({ "path": p, "sddl": sddl }).to_string());
                }
                // A partly denied tree is a failure: some files stay readable.
                match tree.first_failure {
                    None => report.denied.push(path.display().to_string()),
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

/// Restores every object in the deny-read record and removes the file.
pub fn restore(record: &Path) -> Result<grants::RevokeReport> {
    grants::restore(record)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ntfs_tempdir() -> Option<tempfile::TempDir> {
        let base = std::env::var_os("USERPROFILE").map(PathBuf::from)?;
        let dir = tempfile::Builder::new()
            .prefix("hy-deny-read-test-")
            .tempdir_in(base)
            .ok()?;
        let caps = crate::fs::volume_caps(dir.path()).ok()?;
        caps.persistent_acls.then_some(dir)
    }

    #[test]
    fn deny_then_restore_round_trips() -> Result<()> {
        let Some(dir) = ntfs_tempdir() else {
            return Ok(());
        };
        let secret = dir.path().join("secret");
        let file = secret.join("key.txt");
        std::fs::create_dir_all(&secret).map_err(|e| SandboxError::Other(e.to_string()))?;
        std::fs::write(&file, b"token").map_err(|e| SandboxError::Other(e.to_string()))?;
        let sid = crate::sid::workspace_sid(&dir.path().to_string_lossy())?;
        let record = dir.path().join("deny.jsonl");

        assert!(!grants::has_deny_ace_for(&file, &sid)?);
        let report = apply(std::slice::from_ref(&secret), &sid, &record)?;
        assert_eq!(report.denied.len(), 1, "{report:?}");
        assert_eq!(report.failed.len(), 0, "{report:?}");
        assert!(grants::has_deny_ace_for(&secret, &sid)?);
        // Existing children are covered too, not only objects created later.
        assert!(grants::has_deny_ace_for(&file, &sid)?);
        // The read is stopped by the NO_READ_UP label (Low tokens), not the ACE.
        for p in [&secret, &file] {
            let sddl = grants::sddl_of(p)?;
            assert!(sddl.contains(";NWNR;;;ME)"), "{}: {sddl}", p.display());
        }

        let restored = restore(&record)?;
        assert_eq!(restored.failed, 0, "{restored:?}");
        assert!(!grants::has_deny_ace_for(&secret, &sid)?);
        assert!(!grants::has_deny_ace_for(&file, &sid)?);
        assert!(
            !grants::sddl_of(&file)?.contains("NR"),
            "the label is restored"
        );
        assert!(
            !record.exists(),
            "the record is removed after a clean restore"
        );
        Ok(())
    }

    #[test]
    fn missing_paths_are_reported_not_failed() -> Result<()> {
        let Some(dir) = ntfs_tempdir() else {
            return Ok(());
        };
        let sid = crate::sid::workspace_sid(&dir.path().to_string_lossy())?;
        let record = dir.path().join("deny.jsonl");
        let absent = dir.path().join("does-not-exist");
        let report = apply(&[absent], &sid, &record)?;
        assert_eq!(report.missing.len(), 1);
        assert!(report.failed.is_empty());
        let empty =
            !record.exists() || std::fs::read_to_string(&record).is_ok_and(|t| t.trim().is_empty());
        assert!(empty);
        Ok(())
    }
}
