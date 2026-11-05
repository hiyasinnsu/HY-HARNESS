//! The `.git/` check that runs before every harness git invocation
//! (design §4.2 item 2, ADR 0001 A).
//!
//! A `.git` created after the grant inherits the root's allow ACE and Low
//! label, so a confined command can plant `core.fsmonitor` or a hook that the
//! harness's next git call would run unconfined. The protected `.git` carries
//! only a *deny* ACE for the SID and no label.

use std::path::Path;

use crate::grants;
use crate::sid::Sid;
use crate::util::{Result, SandboxError};

/// Fails when `.git` or `.git/config` under `workspace` is writable by the
/// sandbox (`cap` allowed, or a Low label). A missing `.git` is not an error here.
pub fn check_git_dir(workspace: &Path, cap: &Sid) -> Result<()> {
    for p in [
        workspace.join(".git"),
        workspace.join(".git").join("config"),
    ] {
        if !p.exists() {
            continue;
        }
        if grants::is_sandbox_writable(&p, cap)? {
            return Err(SandboxError::Other(format!(
                "{} is writable by the sandbox (created after the workspace grant?); refusing to run git",
                p.display()
            )));
        }
    }
    Ok(())
}
