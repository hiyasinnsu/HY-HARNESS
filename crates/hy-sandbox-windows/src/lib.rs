//! Windows confined-token backend (design §4.2, Rev 3.1; ADR 0001).
//!
//! A write-restricted, Low-integrity version of the caller's token. Reads keep
//! the caller's ambient access; a write must pass both the normal access check
//! and the restricting-SID check, and the Low no-write-up label blocks writes
//! (including parent-directory deletes) everywhere except granted roots.
//! `low-integrity` drops the restricting SIDs and keeps only the label, for
//! toolchains that pipe child processes (OQ-2, ADR 0001 C).
//! Every Win32 failure is returned with the API name and code (fail closed).

#![cfg(windows)]

pub mod appcontainer;
pub mod console;
pub mod deny_read;
pub mod fs;
pub mod gitguard;
pub mod grants;
pub mod impersonate;
pub mod read_only;
pub mod secrets;
pub mod sid;
pub mod spawn;
pub mod token;
pub mod util;

pub use util::{Result, SandboxError};

/// Confined sandbox mode for one command. `unconfined` has no token and is
/// handled by the caller.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    ReadOnly,
    WorkspaceWrite,
    /// Low label only, no restricting SIDs (ADR 0001 C).
    LowIntegrity,
}

/// Gaps that hold whenever a confined mode is in use, reported through
/// `capabilities.gaps`. Callers add the per-machine ones (non-ACL volumes).
pub fn known_gaps() -> Vec<String> {
    vec![
        "reads-not-confined: confined commands keep the caller's read access except the denyRead paths".into(),
        "network-not-confined: confined commands can open outbound connections".into(),
        "named-pipe-grandchildren: Node child processes with piped stdio or IPC fail with EPERM in read-only/workspace-write; use a user-policy low-integrity rule".into(),
        "late-hard-links: files hard-linked into the workspace after the grant are not re-audited".into(),
        "low-integrity: commands in this mode can also write other sessions' granted roots and %USERPROFILE%\\AppData\\LocalLow".into(),
    ]
}
