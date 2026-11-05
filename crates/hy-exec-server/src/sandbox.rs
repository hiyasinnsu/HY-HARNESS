//! The session's sandbox (design §4.2, Rev 3.1; ADR 0001).
//!
//! Prepared once at `initialize`. When the session asks for a confined mode it
//! creates `.hy-harness/` and, outside a repository, runs `git init` before the
//! workspace grant (A), grants the workspace once per machine, grants a private
//! temp under `%USERPROFILE%\.hy-harness\tmp` (B), builds the three confined
//! tokens and checks that the confined token can open every ancestor of the
//! workspace and the temp (B). Any failure leaves the confined modes
//! unavailable with a reason; nothing here is fatal for an unconfined session.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use hy_protocol::{SandboxGrantResult, SandboxMode, SandboxRevokeResult};
use hy_sandbox_windows::deny_read;
use hy_sandbox_windows::grants::{self, GrantOptions, GrantReport};
use hy_sandbox_windows::read_only as carve_out;
use hy_sandbox_windows::sid::{self, Sid};
use hy_sandbox_windows::token::{self, ConfinedToken};
use hy_sandbox_windows::util::OwnedHandle;
use hy_sandbox_windows::{Mode, fs as sbfs, gitguard};
use windows_sys::Win32::Foundation::HANDLE;

struct Tokens {
    read_only: ConfinedToken,
    workspace_write: ConfinedToken,
    low_integrity: ConfinedToken,
    /// Impersonation copy of `workspace_write` for the patcher and checks.
    patch: OwnedHandle,
}

pub struct Sandbox {
    workspace: PathBuf,
    /// `extraWritableRoots` from user config, granted to the workspace SID.
    extra_roots: Vec<PathBuf>,
    state_dir: PathBuf,
    ws_sid: Option<Sid>,
    temp_dir: Option<PathBuf>,
    record: PathBuf,
    tokens: Option<Tokens>,
    granted: bool,
    /// The workspace volume cannot store ACLs (exFAT / FAT32). Confined
    /// commands still run under the restricted token, but writes are limited
    /// to the whole volume rather than the workspace subtree. This matches
    /// Codex's Windows behaviour on non-ACL volumes.
    non_acl_workspace: bool,
    pub available: bool,
    pub unavailable_reason: Option<String>,
    pub gaps: Vec<String>,
    pub notices: Vec<String>,
    pub grant: Option<SandboxGrantResult>,
    pub unprotected_hard_links: u64,
    /// `denyRead` paths requested at initialize (CP-02). The deny ACEs name the
    /// workspace SID, which exists only in the restricted token, so the user
    /// keeps access.
    deny_read_request: Vec<PathBuf>,
    deny_record: PathBuf,
    pub deny_read: Vec<String>,
    pub deny_read_missing: Vec<String>,
    pub deny_read_failed: Vec<String>,
    /// `readOnly` carve-outs requested at initialize (CP-02).
    read_only_request: Vec<PathBuf>,
    read_only_record: PathBuf,
    pub read_only: Vec<String>,
    pub read_only_missing: Vec<String>,
    pub read_only_failed: Vec<String>,
}

fn grant_result(r: &GrantReport, already: bool) -> SandboxGrantResult {
    SandboxGrantResult {
        already_granted: already,
        objects: r.objects,
        objects_changed: r.objects_changed,
        skipped_hard_links: r.skipped_hard_links,
        skipped_reparse_points: r.skipped_reparse_points,
        protected: r
            .protected
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect(),
        failed: r.failed,
        first_failure: r.first_failure.clone(),
        duration_ms: r.duration_ms,
    }
}

/// `%USERPROFILE%\.hy-harness\tmp\<session>`: outside `AppData`, whose
/// package-SID ACEs a Low-integrity token cannot open (ADR 0001 §5.2).
fn private_temp_dir() -> Option<PathBuf> {
    let profile = std::env::var_os("USERPROFILE")?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    Some(
        PathBuf::from(profile)
            .join(".hy-harness")
            .join("tmp")
            .join(format!("{:x}-{}", stamp, std::process::id())),
    )
}

fn git_ok(workspace: &Path, args: &[&str]) -> bool {
    Command::new("git")
        .current_dir(workspace)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

impl Sandbox {
    fn unavailable(workspace: &Path, state_dir: &Path, record: PathBuf, reason: String) -> Self {
        Self {
            workspace: workspace.to_path_buf(),
            extra_roots: Vec::new(),
            state_dir: state_dir.to_path_buf(),
            ws_sid: None,
            temp_dir: None,
            record,
            tokens: None,
            granted: false,
            non_acl_workspace: false,
            available: false,
            unavailable_reason: Some(reason),
            gaps: Vec::new(),
            notices: Vec::new(),
            grant: None,
            unprotected_hard_links: 0,
            deny_read_request: Vec::new(),
            deny_record: state_dir.join("grants").join("deny-read.jsonl"),
            deny_read: Vec::new(),
            deny_read_missing: Vec::new(),
            deny_read_failed: Vec::new(),
            read_only_request: Vec::new(),
            read_only_record: state_dir.join("grants").join("read-only.jsonl"),
            read_only: Vec::new(),
            read_only_missing: Vec::new(),
            read_only_failed: Vec::new(),
        }
    }

    /// Prepares the sandbox. With `grant`, the workspace is granted if it is
    /// not already; without it, an ungranted workspace leaves the confined
    /// modes unavailable and nothing is changed on disk.
    pub fn prepare(
        workspace: &Path,
        state_dir: &Path,
        grant: bool,
        extra_roots: &[PathBuf],
        deny_read: &[PathBuf],
        read_only: &[PathBuf],
    ) -> Self {
        let record = state_dir.join("grants").join("workspace.jsonl");
        let mut gaps = hy_sandbox_windows::known_gaps();
        let non_acl = sbfs::non_acl_volumes();
        if !non_acl.is_empty() {
            gaps.push(format!(
                "non-acl-volumes: confined commands can write to {} (no ACLs)",
                non_acl.join(", ")
            ));
        }
        let mut sb = match Self::prepare_inner(
            workspace,
            state_dir,
            &record,
            grant,
            extra_roots,
            deny_read,
            read_only,
        ) {
            Ok(sb) => sb,
            Err(reason) => Self::unavailable(workspace, state_dir, record, reason),
        };
        sb.gaps = gaps;
        sb
    }

    fn prepare_inner(
        workspace: &Path,
        state_dir: &Path,
        record: &Path,
        grant: bool,
        extra_roots: &[PathBuf],
        deny_read: &[PathBuf],
        read_only: &[PathBuf],
    ) -> Result<Self, String> {
        let caps = sbfs::volume_caps(workspace).map_err(|e| format!("volume check: {e}"))?;
        let non_acl_workspace = !caps.persistent_acls;
        let ws_sid = sid::workspace_sid(&workspace.to_string_lossy()).map_err(|e| e.to_string())?;
        let mut sb = Self {
            workspace: workspace.to_path_buf(),
            extra_roots: extra_roots.to_vec(),
            state_dir: state_dir.to_path_buf(),
            ws_sid: Some(ws_sid.clone()),
            temp_dir: None,
            record: record.to_path_buf(),
            tokens: None,
            granted: non_acl_workspace || grants::is_granted(workspace, &ws_sid),
            non_acl_workspace,
            available: false,
            unavailable_reason: None,
            gaps: Vec::new(),
            notices: Vec::new(),
            grant: None,
            unprotected_hard_links: 0,
            deny_read_request: deny_read.to_vec(),
            deny_record: state_dir.join("grants").join("deny-read.jsonl"),
            deny_read: Vec::new(),
            deny_read_missing: Vec::new(),
            deny_read_failed: Vec::new(),
            read_only_request: read_only.to_vec(),
            read_only_record: state_dir.join("grants").join("read-only.jsonl"),
            read_only: Vec::new(),
            read_only_missing: Vec::new(),
            read_only_failed: Vec::new(),
        };
        if non_acl_workspace {
            // exFAT and FAT32 cannot store the workspace SID. Running confined
            // is still useful: the restricted token keeps NTFS paths outside
            // the workspace and temp read-only, while the entire non-ACL
            // volume is writable. Codex behaves the same way on Windows.
            sb.grant = Some(SandboxGrantResult {
                already_granted: true,
                ..SandboxGrantResult::default()
            });
        } else if !sb.granted {
            if !grant {
                // Keep the context (workspace SID included) instead of dropping
                // to `unavailable`: WP-12 lets a session switch from unconfined
                // to a confined mode later, and `grant_now()` needs the SID to
                // grant + build tokens on that explicit user action.
                sb.unavailable_reason = Some(
                    "the workspace is not granted; switching to a confined mode will grant it"
                        .into(),
                );
                return Ok(sb);
            }
            sb.grant_workspace()?;
        } else {
            sb.grant = Some(SandboxGrantResult {
                already_granted: true,
                ..SandboxGrantResult::default()
            });
        }
        if grant {
            sb.grant_extra_roots()?;
        }
        sb.finish()?;
        sb.apply_deny_read();
        sb.apply_read_only();
        Ok(sb)
    }

    fn extra_record(&self, root: &Path) -> PathBuf {
        use sha2::{Digest, Sha256};
        let digest = Sha256::digest(root.to_string_lossy().to_lowercase().as_bytes());
        self.state_dir
            .join("grants")
            .join(format!("extra-{}.jsonl", hex::encode(&digest[..8])))
    }

    /// Grants each `extraWritableRoot` to the workspace SID (no protected
    /// subdirectories: they are not workspaces).
    fn grant_extra_roots(&mut self) -> Result<(), String> {
        let sid = self.ws_sid.clone().ok_or("no workspace SID")?;
        for root in self.extra_roots.clone() {
            let caps = sbfs::volume_caps(&root)
                .map_err(|e| format!("extra root {}: {e}", root.display()))?;
            if !caps.persistent_acls {
                // The whole volume is writable to the restricted token, so
                // there is no ACL to add. Matches the workspace fallback.
                continue;
            }
            if grants::is_granted(&root, &sid) {
                continue;
            }
            let r = grants::grant(
                &root,
                &sid,
                &self.extra_record(&root),
                GrantOptions {
                    threads: 8,
                    protect_top: false,
                },
            )
            .map_err(|e| format!("grant {}: {e}", root.display()))?;
            if r.failed > 0 {
                return Err(format!(
                    "grant {}: {}",
                    root.display(),
                    r.first_failure.unwrap_or_default()
                ));
            }
            self.notices.push(format!(
                "granted extra writable root {} ({} objects)",
                root.display(),
                r.objects_changed
            ));
        }
        Ok(())
    }

    /// Adds a root after `initialize` (the GUI can add workspace roots while
    /// the server is running). Grants it to the workspace SID when the sandbox
    /// is already active; otherwise it will be granted by `grant_now`.
    pub fn add_extra_root(&mut self, root: &Path) -> Result<(), String> {
        if self.extra_roots.iter().any(|existing| existing == root) {
            return Ok(());
        }
        if !self.granted {
            self.extra_roots.push(root.to_path_buf());
            return Ok(());
        }
        let sid = self.ws_sid.clone().ok_or("no workspace SID")?;
        let caps =
            sbfs::volume_caps(root).map_err(|e| format!("extra root {}: {e}", root.display()))?;
        if caps.persistent_acls && !grants::is_granted(root, &sid) {
            let r = grants::grant(
                root,
                &sid,
                &self.extra_record(root),
                GrantOptions {
                    threads: 8,
                    protect_top: false,
                },
            )
            .map_err(|e| format!("grant {}: {e}", root.display()))?;
            if r.failed > 0 {
                return Err(format!(
                    "grant {}: {}",
                    root.display(),
                    r.first_failure.unwrap_or_default()
                ));
            }
            self.notices.push(format!(
                "granted new extra writable root {} ({} objects)",
                root.display(),
                r.objects_changed
            ));
        }
        self.extra_roots.push(root.to_path_buf());
        Ok(())
    }

    /// Stops accepting a root and restores its ACLs when this root was granted
    /// during this session.
    pub fn remove_extra_root(&mut self, root: &Path) -> Result<(), String> {
        if self.granted
            && !self.non_acl_workspace
            && let Some(sid) = self.ws_sid.clone()
        {
            grants::revoke(root, &sid, &self.extra_record(root))
                .map_err(|e| format!("revoke {}: {e}", root.display()))?;
        }
        self.extra_roots.retain(|existing| existing != root);
        Ok(())
    }
    fn grant_workspace(&mut self) -> Result<(), String> {
        let ws = self.workspace.clone();
        let sid = self.ws_sid.clone().ok_or("no workspace SID")?;
        std::fs::create_dir_all(ws.join(".hy-harness"))
            .map_err(|e| format!("create .hy-harness: {e}"))?;
        if !ws.join(".git").exists() && !git_ok(&ws, &["rev-parse", "--git-dir"]) {
            if !git_ok(&ws, &["init", "-q"]) {
                return Err("git init failed; a repository is required before the grant".into());
            }
            self.notices.push(format!(
                "initialized a git repository in {} before the sandbox grant",
                ws.display()
            ));
        }
        let report = grants::grant(&ws, &sid, &self.record, GrantOptions::default())
            .map_err(|e| format!("grant: {e}"))?;
        if report.failed > 0 {
            return Err(format!(
                "grant failed on {} object(s), first: {}",
                report.failed,
                report.first_failure.clone().unwrap_or_default()
            ));
        }
        self.unprotected_hard_links = report.skipped_hard_links;
        self.notices.push(format!(
            "granted the workspace to the sandbox: {} objects in {} ms, {} hard-linked file(s) left read-only",
            report.objects_changed, report.duration_ms, report.skipped_hard_links
        ));
        self.grant = Some(grant_result(&report, false));
        self.granted = true;
        Ok(())
    }

    /// Private temp, tokens and the ancestor check.
    fn finish(&mut self) -> Result<(), String> {
        let ws_sid = self.ws_sid.clone().ok_or("no workspace SID")?;
        let temp = private_temp_dir().ok_or("USERPROFILE is not set")?;
        std::fs::create_dir_all(&temp)
            .map_err(|e| format!("private temp {}: {e}", temp.display()))?;
        self.temp_dir = Some(temp.clone());
        let caps = sbfs::volume_caps(&temp).map_err(|e| format!("volume check: {e}"))?;
        if !caps.persistent_acls {
            return Err(format!(
                "the private temp volume {} has no persistent ACLs",
                caps.volume_root
            ));
        }
        let temp_sid = sid::temp_sid(&temp.to_string_lossy()).map_err(|e| e.to_string())?;
        let temp_record = temp.with_extension("grant.jsonl");
        let r = grants::grant(
            &temp,
            &temp_sid,
            &temp_record,
            GrantOptions {
                threads: 1,
                protect_top: false,
            },
        )
        .map_err(|e| format!("private temp grant: {e}"))?;
        if r.failed > 0 {
            return Err(format!(
                "private temp grant: {}",
                r.first_failure.unwrap_or_default()
            ));
        }

        let make = |mode| {
            token::create_confined(mode, Some(&ws_sid), Some(&temp_sid))
                .map_err(|e| format!("token: {e}"))
        };
        let workspace_write = make(Mode::WorkspaceWrite)?;
        let patch =
            token::impersonation_copy(&workspace_write).map_err(|e| format!("token: {e}"))?;
        let tokens = Tokens {
            read_only: make(Mode::ReadOnly)?,
            low_integrity: make(Mode::LowIntegrity)?,
            workspace_write,
            patch,
        };
        let mut roots: Vec<&Path> = vec![&self.workspace, &temp];
        roots.extend(self.extra_roots.iter().map(PathBuf::as_path));
        if let Some((dir, err)) = sbfs::unreadable_ancestor(&roots, tokens.patch.raw())
            .map_err(|e| format!("ancestor check: {e}"))?
        {
            return Err(format!(
                "the confined token cannot open {} ({err}); a directory above the workspace or temp probably carries an AppContainer package ACE (ADR 0001 §5.2)",
                dir.display()
            ));
        }
        self.tokens = Some(tokens);
        self.available = true;
        self.unavailable_reason = None;
        Ok(())
    }

    /// Applies `denyRead` (CP-02) to the workspace SID. Idempotent; failures
    /// are reported in `sandbox/status` and as a gap instead of failing the
    /// session (the user can fix the ACL and grant again).
    fn apply_deny_read(&mut self) {
        if self.deny_read_request.is_empty() || !self.available {
            return;
        }
        let Some(sid) = self.ws_sid.clone() else {
            return;
        };
        let mut paths = Vec::new();
        for p in &self.deny_read_request {
            // `canonicalize` returns `\\?\C:\...`; the workspace and the paths
            // reported in `sandbox/status` use the plain spelling, and the
            // ancestor check below only works when both spellings match.
            let canon = match std::fs::canonicalize(p).map(|c| crate::server::plain_path(&c)) {
                Ok(c) => c,
                Err(_) => {
                    self.deny_read_missing.push(p.display().to_string());
                    continue;
                }
            };
            // Never deny the workspace or an ancestor: the agent could not read
            // anything at all.
            if self.workspace.starts_with(&canon) {
                self.deny_read_failed.push(format!(
                    "{}: is the workspace or an ancestor",
                    canon.display()
                ));
                continue;
            }
            paths.push(canon);
        }
        match deny_read::apply(&paths, &sid, &self.deny_record) {
            Ok(r) => {
                for p in r.denied {
                    if !self.deny_read.contains(&p) {
                        self.deny_read.push(p);
                    }
                }
                self.deny_read_missing.extend(r.missing);
                self.deny_read_failed.extend(r.failed);
                if let Some(f) = r.first_failure {
                    self.gaps.push(format!("deny-read-failed: {f}"));
                }
            }
            Err(e) => self.deny_read_failed.push(format!("deny-read: {e}")),
        }
        if !self.deny_read.is_empty() {
            self.notices.push(format!(
                "denyRead: {} path(s) are not readable by confined commands",
                self.deny_read.len()
            ));
        }
    }

    /// Applies `readOnly` carve-outs (CP-02): a deny-write ACE for the
    /// workspace SID on each subdirectory. Outside paths are rejected.
    fn apply_read_only(&mut self) {
        if self.read_only_request.is_empty() || !self.available {
            return;
        }
        let Some(sid) = self.ws_sid.clone() else {
            return;
        };
        let mut paths = Vec::new();
        for p in &self.read_only_request {
            // `canonicalize` returns `\\?\C:\...`; the workspace is plain, so
            // the inside-the-workspace check needs the plain spelling too.
            let canon = match std::fs::canonicalize(p).map(|c| crate::server::plain_path(&c)) {
                Ok(c) => c,
                Err(_) => {
                    self.read_only_missing.push(p.display().to_string());
                    continue;
                }
            };
            if !canon.starts_with(&self.workspace) || canon == self.workspace {
                self.read_only_failed.push(format!(
                    "{}: must be a subdirectory of the workspace",
                    canon.display()
                ));
                continue;
            }
            paths.push(canon);
        }
        match carve_out::apply(&paths, &sid, &self.read_only_record) {
            Ok(r) => {
                for p in r.applied {
                    if !self.read_only.contains(&p) {
                        self.read_only.push(p);
                    }
                }
                self.read_only_missing.extend(r.missing);
                self.read_only_failed.extend(r.failed);
                if let Some(f) = r.first_failure {
                    self.gaps.push(format!("read-only-failed: {f}"));
                }
            }
            Err(e) => self.read_only_failed.push(format!("read-only: {e}")),
        }
        if !self.read_only.is_empty() {
            self.notices.push(format!(
                "readOnly: {} path(s) are read-only for confined commands",
                self.read_only.len()
            ));
        }
    }

    /// The primary token for a confined mode, when available.
    pub fn token(&self, mode: SandboxMode) -> Option<HANDLE> {
        let t = self.tokens.as_ref().filter(|_| self.available)?;
        match mode {
            SandboxMode::ReadOnly => Some(t.read_only.handle.raw()),
            SandboxMode::WorkspaceWrite => Some(t.workspace_write.handle.raw()),
            SandboxMode::LowIntegrity => Some(t.low_integrity.handle.raw()),
            SandboxMode::Unconfined => None,
        }
    }

    /// The impersonation token the patcher writes with, when available.
    pub fn patch_token(&self) -> Option<HANDLE> {
        self.tokens
            .as_ref()
            .filter(|_| self.available)
            .map(|t| t.patch.raw())
    }

    pub fn temp_dir(&self) -> Option<&Path> {
        self.temp_dir.as_deref()
    }

    pub fn workspace_sid(&self) -> String {
        self.ws_sid
            .as_ref()
            .and_then(|s| s.to_string_sid().ok())
            .unwrap_or_default()
    }

    pub fn granted(&self) -> bool {
        self.granted
    }

    pub fn extra_roots(&self) -> &[PathBuf] {
        &self.extra_roots
    }

    /// Fails when a granted workspace's `.git` is writable by the sandbox
    /// (ADR 0001 A). Runs before every harness git invocation.
    pub fn check_git(workspace: &Path) -> Result<(), String> {
        let Ok(ws_sid) = sid::workspace_sid(&workspace.to_string_lossy()) else {
            return Ok(());
        };
        if !grants::is_granted(workspace, &ws_sid) {
            return Ok(());
        }
        gitguard::check_git_dir(workspace, &ws_sid).map_err(|e| e.to_string())
    }

    /// `sandbox/grant`: grants an ungranted workspace and makes the modes available.
    pub fn grant_now(&mut self) -> Result<SandboxGrantResult, String> {
        if self.ws_sid.is_none() {
            return Err(self
                .unavailable_reason
                .clone()
                .unwrap_or_else(|| "sandbox unavailable".into()));
        }
        if self.non_acl_workspace {
            if !self.available {
                self.finish()?;
            }
            self.apply_deny_read();
            self.apply_read_only();
            return Ok(self.grant.clone().unwrap_or_else(|| SandboxGrantResult {
                already_granted: true,
                ..SandboxGrantResult::default()
            }));
        }
        if !self.granted {
            self.grant_workspace()?;
        }
        self.grant_extra_roots()?;
        if !self.available {
            self.finish()?;
        }
        self.apply_deny_read();
        self.apply_read_only();
        Ok(self.grant.clone().unwrap_or_else(|| SandboxGrantResult {
            already_granted: true,
            ..SandboxGrantResult::default()
        }))
    }

    /// `sandbox/revoke`: restores the recorded ACLs, strips the SID from the
    /// rest of the tree, and leaves the confined modes unavailable.
    pub fn revoke(&mut self) -> Result<SandboxRevokeResult, String> {
        // CP-02: restore the deny-read objects first; they live outside the
        // workspace, so the grant revoke below does not reach them.
        let deny_restore =
            deny_read::restore(&self.deny_record).map_err(|e| format!("deny-read revoke: {e}"))?;
        self.deny_read.clear();
        // CP-02: carve-outs are inside the workspace, but their deny ACEs were
        // recorded separately; restore them before the grant revoke.
        let carve_restore = carve_out::restore(&self.read_only_record)
            .map_err(|e| format!("read-only revoke: {e}"))?;
        self.read_only.clear();
        if self.non_acl_workspace {
            // There are no ACLs to restore on this volume.
            self.tokens = None;
            self.available = false;
            self.granted = false;
            self.unavailable_reason = Some("the workspace grant was revoked".into());
            return Ok(SandboxRevokeResult {
                restored: deny_restore.restored + carve_restore.restored,
                failed: deny_restore.failed + carve_restore.failed,
                first_failure: deny_restore.first_failure.or(carve_restore.first_failure),
                duration_ms: deny_restore.duration_ms + carve_restore.duration_ms,
                ..SandboxRevokeResult::default()
            });
        }
        let sid = self.ws_sid.clone().ok_or("no workspace SID")?;
        let mut r = grants::revoke(&self.workspace, &sid, &self.record)
            .map_err(|e| format!("revoke: {e}"))?;
        for root in self.extra_roots.clone() {
            let x = grants::revoke(&root, &sid, &self.extra_record(&root))
                .map_err(|e| format!("revoke {}: {e}", root.display()))?;
            r.restored += x.restored;
            r.stripped += x.stripped;
            r.failed += x.failed;
            if r.first_failure.is_none() {
                r.first_failure = x.first_failure;
            }
        }
        self.available = false;
        self.granted = false;
        self.unavailable_reason = Some("the workspace grant was revoked".into());
        Ok(SandboxRevokeResult {
            restored: r.restored + deny_restore.restored + carve_restore.restored,
            stripped: r.stripped,
            failed: r.failed + deny_restore.failed + carve_restore.failed,
            first_failure: r
                .first_failure
                .or(deny_restore.first_failure)
                .or(carve_restore.first_failure),
            duration_ms: r.duration_ms + deny_restore.duration_ms + carve_restore.duration_ms,
        })
    }

    /// Removes this session's private temp (its ACEs go with it).
    pub fn cleanup(&self) {
        if let Some(t) = &self.temp_dir {
            let _ = std::fs::remove_dir_all(t);
            let _ = std::fs::remove_file(t.with_extension("grant.jsonl"));
        }
    }
}
