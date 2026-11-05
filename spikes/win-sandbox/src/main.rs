//! Phase 1 Windows sandbox feasibility spike (design_draft_rev3.md §Phase 1).
//!
//! Throwaway binary. It reuses the draft `hy-sandbox-windows` modules verbatim
//! (token shape, SIDs, volume check, hidden console) so the spike also tests
//! that code, and adds the pieces the draft does not have yet: the grant
//! walker, the confined spawn, the patcher impersonation probe and an
//! AppContainer launcher.
//!
//! Every subcommand prints one JSON object on stdout.

#![cfg(windows)]
#![allow(dead_code)]

#[path = "../../../crates/hy-sandbox-windows/src/console.rs"]
mod console;
#[path = "../../../crates/hy-sandbox-windows/src/fs.rs"]
mod fs;
#[path = "../../../crates/hy-sandbox-windows/src/sid.rs"]
mod sid;
#[path = "../../../crates/hy-sandbox-windows/src/token.rs"]
mod token;
#[path = "../../../crates/hy-sandbox-windows/src/util.rs"]
mod util;

mod appc;
mod probe;
mod spawn;
mod variant;
mod walker;

use std::path::PathBuf;

use serde_json::json;

pub use util::{Result, SandboxError};

/// Sandbox mode for one command (same shape as the draft crate's `Mode`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    ReadOnly,
    WorkspaceWrite,
    Unconfined,
}

impl Mode {
    fn parse(s: &str) -> Result<Self> {
        match s {
            "ro" | "read-only" => Ok(Self::ReadOnly),
            "ww" | "workspace-write" => Ok(Self::WorkspaceWrite),
            "none" | "unconfined" => Ok(Self::Unconfined),
            _ => Err(SandboxError::Other(format!("unknown mode {s}"))),
        }
    }
}

/// `--key value` options plus everything after `--`.
struct Args {
    opts: Vec<(String, String)>,
    flags: Vec<String>,
    rest: Vec<String>,
}

impl Args {
    fn parse(raw: &[String]) -> Self {
        let mut opts = Vec::new();
        let mut flags = Vec::new();
        let mut rest = Vec::new();
        let mut i = 0;
        while i < raw.len() {
            let a = &raw[i];
            if a == "--" {
                rest.extend(raw[i + 1..].iter().cloned());
                break;
            }
            if let Some(k) = a.strip_prefix("--") {
                if i + 1 < raw.len() && !raw[i + 1].starts_with("--") {
                    opts.push((k.to_string(), raw[i + 1].clone()));
                    i += 2;
                    continue;
                }
                flags.push(k.to_string());
            } else {
                rest.push(a.clone());
            }
            i += 1;
        }
        Self { opts, flags, rest }
    }
    fn get(&self, k: &str) -> Option<&str> {
        self.opts.iter().rev().find(|(n, _)| n == k).map(|(_, v)| v.as_str())
    }
    fn all(&self, k: &str) -> Vec<&str> {
        self.opts.iter().filter(|(n, _)| n == k).map(|(_, v)| v.as_str()).collect()
    }
    fn req(&self, k: &str) -> Result<&str> {
        self.get(k).ok_or_else(|| SandboxError::Other(format!("missing --{k}")))
    }
    fn flag(&self, k: &str) -> bool {
        self.flags.iter().any(|f| f == k)
    }
}

fn canonical(p: &str) -> Result<PathBuf> {
    let c = std::fs::canonicalize(p).map_err(|e| SandboxError::Other(format!("canonicalize {p}: {e}")))?;
    // Strip the \\?\ verbatim prefix so SIDs derive from the plain path.
    let s = c.to_string_lossy();
    Ok(PathBuf::from(s.strip_prefix(r"\\?\").unwrap_or(&s)))
}

fn info() -> Result<serde_json::Value> {
    let base = token::open_process_token()?;
    let id = token::caller_identity(base.raw())?;
    let mut vols = Vec::new();
    for p in [std::env::temp_dir(), PathBuf::from(r"F:\"), PathBuf::from(r"G:\")] {
        match fs::volume_caps(&p) {
            Ok(c) => vols.push(json!({"path": p, "fs": c.fs_name, "persistentAcls": c.persistent_acls, "hardLinks": c.hard_links})),
            Err(e) => vols.push(json!({"path": p, "error": e.to_string()})),
        }
    }
    Ok(json!({
        "user": id.user.to_string_sid()?,
        "logon": id.logon.to_string_sid()?,
        "adminMember": id.is_admin_member,
        "volumes": vols,
    }))
}

fn run_main() -> Result<serde_json::Value> {
    let raw: Vec<String> = std::env::args().skip(1).collect();
    let Some(cmd) = raw.first() else {
        return Err(SandboxError::Other(
            "usage: win-sandbox info|sid|grant|revoke|run|probe|appc ...".into(),
        ));
    };
    let a = Args::parse(&raw[1..]);
    match cmd.as_str() {
        "info" => info(),
        "sid" => {
            let ws = canonical(a.req("workspace")?)?;
            Ok(json!({"workspace": ws, "sid": sid::workspace_sid(&ws.to_string_lossy())?.to_string_sid()?}))
        }
        "grant" => walker::grant_cmd(&a),
        "revoke" => walker::revoke_cmd(&a),
        "run" => spawn::run_cmd(&a),
        "probe" => probe::probe_cmd(&a),
        "appc" => appc::appc_cmd(&a),
        other => Err(SandboxError::Other(format!("unknown subcommand {other}"))),
    }
}

fn main() {
    let out = match run_main() {
        Ok(v) => v,
        Err(e) => json!({"error": e.to_string(), "win32": e.win32_code()}),
    };
    let failed = out.get("error").is_some();
    #[allow(clippy::print_stdout)]
    {
        println!("{out}");
    }
    std::process::exit(if failed { 2 } else { 0 });
}
