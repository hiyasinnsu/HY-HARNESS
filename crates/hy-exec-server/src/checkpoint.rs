//! Git ref checkpoints (design §6).
//!
//! A checkpoint is a shadow commit under `refs/hy/checkpoints/<run>/<label>`.
//! Creation copies `.git/index` to a work index, runs `git add -A` into it, and
//! writes a tree; that index is kept as the checkpoint's snapshot index.
//! Rollback compares the snapshot index with the worktree (`update-index
//! --refresh` + `diff-files` + `ls-files -o`, which hash only stat-dirty files
//! and write no objects), deletes the paths that are new and restores only the
//! changed ones, so untouched files keep their mtimes.

use std::collections::BTreeSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::Instant;

use hy_protocol::{
    CheckpointCreateResult, CheckpointDiffResult, CheckpointPruneResult, CheckpointRollbackResult,
};
use serde::{Deserialize, Serialize};

const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
/// Default cap for untracked files in a checkpoint (design §6: 50 MiB).
pub const DEFAULT_MAX_UNTRACKED_BYTES: u64 = 50 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum CheckpointError {
    #[error("{0}")]
    Git(String),
    #[error("{0}")]
    Io(String),
    #[error("invalid run id or label: {0}")]
    InvalidName(String),
    #[error("HEAD moved from {expected:?} to {actual:?}")]
    HeadMoved {
        expected: Option<String>,
        actual: Option<String>,
        rollback: Box<CheckpointRollbackResult>,
    },
}

#[derive(Debug, Serialize, Deserialize)]
struct Meta {
    head: Option<String>,
    had_index: bool,
    /// Tree of `<label>.snap.index`; rollback trusts that index only if this
    /// matches the ref's tree.
    #[serde(default)]
    tree: Option<String>,
    /// Oversized untracked files left out at `create` time; rollback leaves them alone.
    #[serde(default)]
    unprotected: Vec<String>,
}

/// Runs before every git invocation; an error stops the call (ADR 0001 A).
pub type GitGuard = Box<dyn Fn() -> Result<(), String> + Send + Sync>;

pub struct CheckpointEngine {
    workspace: PathBuf,
    state_dir: PathBuf,
    /// Empty directory used as `core.hooksPath`, so no hook runs in our git.
    hooks_dir: PathBuf,
    guard: Option<GitGuard>,
    index_path: OnceLock<PathBuf>,
    max_untracked_bytes: u64,
}

impl CheckpointEngine {
    pub fn new(workspace: PathBuf, state_dir: PathBuf) -> Self {
        let hooks_dir = state_dir.join("empty-hooks");
        let _ = std::fs::create_dir_all(&hooks_dir);
        Self {
            workspace,
            state_dir,
            hooks_dir,
            guard: None,
            index_path: OnceLock::new(),
            max_untracked_bytes: DEFAULT_MAX_UNTRACKED_BYTES,
        }
    }

    /// Adds the `.git/` check of design §4.2 item 2.
    pub fn with_git_guard(mut self, guard: GitGuard) -> Self {
        self.guard = Some(guard);
        self
    }

    /// Sets `checkpoint.maxUntrackedFileBytes` (design §6; default 50 MiB).
    pub fn with_max_untracked_bytes(mut self, max_bytes: u64) -> Self {
        self.max_untracked_bytes = max_bytes;
        self
    }

    /// The run's stat cache: the last snapshot index git refreshed (see `create`).
    fn stat_cache(run_dir: &Path) -> PathBuf {
        run_dir.join("stat.index")
    }

    fn valid(name: &str) -> bool {
        !name.is_empty()
            && name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    }

    fn check_names(run_id: &str, label: &str) -> Result<(), CheckpointError> {
        if !Self::valid(run_id) || !Self::valid(label) {
            return Err(CheckpointError::InvalidName(format!("{run_id}/{label}")));
        }
        Ok(())
    }

    /// The user's index path; asked once (a git call costs ~20 ms on Windows).
    fn index_path(&self) -> Result<PathBuf, CheckpointError> {
        if let Some(p) = self.index_path.get() {
            return Ok(p.clone());
        }
        let out = self.git(&["rev-parse", "--git-path", "index"], &[], None)?;
        let p = PathBuf::from(out.trim());
        let p = if p.is_absolute() {
            p
        } else {
            self.workspace.join(p)
        };
        Ok(self.index_path.get_or_init(|| p).clone())
    }

    fn run_dir(&self, run_id: &str) -> PathBuf {
        self.state_dir.join("ckpt").join(run_id)
    }

    fn ref_name(run_id: &str, label: &str) -> String {
        format!("refs/hy/checkpoints/{run_id}/{label}")
    }

    pub fn create(
        &self,
        run_id: &str,
        label: &str,
    ) -> Result<CheckpointCreateResult, CheckpointError> {
        Self::check_names(run_id, label)?;
        let started = Instant::now();
        let index = self.index_path()?;
        let dir = self.run_dir(run_id);
        std::fs::create_dir_all(&dir).map_err(|e| CheckpointError::Io(e.to_string()))?;
        let user_index = dir.join(format!("{label}.user.index"));
        let work_index = dir.join(format!("{label}.work.index"));
        let had_index = index.exists();
        if had_index {
            std::fs::copy(&index, &user_index).map_err(|e| CheckpointError::Io(e.to_string()))?;
        }
        // Snapshot from the run's stat cache when there is one: it carries stat
        // data git refreshed at the previous checkpoint, so only files changed
        // since then are hashed. The user's index is never refreshed during a
        // run, so basing every snapshot on it re-hashes every file changed since
        // the user's last `git status` (measured: 400 dirty files ≈ 180 ms vs 36 ms).
        let base = Self::stat_cache(&dir);
        let base = if base.exists() { base } else { index.clone() };
        if base.exists() {
            std::fs::copy(&base, &work_index).map_err(|e| CheckpointError::Io(e.to_string()))?;
        } else {
            let _ = std::fs::remove_file(&work_index);
        }

        let head = self.git_opt(&["rev-parse", "HEAD"], &[], None)?;
        let env = self.index_env(&work_index);
        let unprotected = self.stage_worktree(&env)?;
        let tree = self.git(&["write-tree"], &env, None)?.trim().to_string();
        let mut commit_args = vec!["commit-tree", tree.as_str()];
        if let Some(h) = &head {
            commit_args.push("-p");
            commit_args.push(h);
        }
        let commit = self
            .git(&commit_args, &env, Some("hy-harness checkpoint"))?
            .trim()
            .to_string();
        let refname = Self::ref_name(run_id, label);
        self.git(&["update-ref", &refname, &commit], &[], None)?;
        // Best effort: a missing cache only costs speed.
        let _ = std::fs::copy(&work_index, Self::stat_cache(&dir));
        let snap_index = dir.join(format!("{label}.snap.index"));
        let snapped = std::fs::rename(&work_index, &snap_index).is_ok();

        let meta = Meta {
            head,
            had_index,
            tree: snapped.then(|| tree.clone()),
            unprotected: unprotected.clone(),
        };
        std::fs::write(
            dir.join(format!("{label}.meta.json")),
            serde_json::to_vec_pretty(&meta).map_err(|e| CheckpointError::Io(e.to_string()))?,
        )
        .map_err(|e| CheckpointError::Io(e.to_string()))?;

        Ok(CheckpointCreateResult {
            reference: refname,
            tree_oid: tree,
            head_oid: meta.head,
            unprotected,
            duration_ms: started.elapsed().as_millis() as u64,
        })
    }

    /// Stages tracked and untracked-not-ignored files into the work index,
    /// leaving out untracked files larger than `max_untracked_bytes` (design §6).
    fn stage_worktree(&self, env: &[(String, String)]) -> Result<Vec<String>, CheckpointError> {
        let others = self.git(
            &[
                "ls-files",
                "-z",
                "-o",
                "--exclude-standard",
                "--",
                ".",
                ":(exclude).hy-harness",
            ],
            env,
            None,
        )?;
        let mut unprotected = Vec::new();
        for rel in others.split('\0').filter(|p| !p.is_empty()) {
            if let Ok(m) = std::fs::metadata(self.workspace.join(rel))
                && m.len() > self.max_untracked_bytes
            {
                unprotected.push(rel.to_owned());
            }
        }
        let mut add_args = vec![
            "add".to_owned(),
            "-A".to_owned(),
            "--".to_owned(),
            ".".to_owned(),
            ":(exclude).hy-harness".to_owned(),
        ];
        // `literal`: a name like `data[1].bin` must not be read as a glob that
        // also excludes other files (`data1.bin`) from the snapshot.
        for rel in &unprotected {
            add_args.push(format!(":(exclude,literal){rel}"));
        }
        let refs: Vec<&str> = add_args.iter().map(String::as_str).collect();
        self.git(&refs, env, None)?;
        Ok(unprotected)
    }

    pub fn rollback(
        &self,
        run_id: &str,
        label: &str,
    ) -> Result<CheckpointRollbackResult, CheckpointError> {
        Self::check_names(run_id, label)?;
        let started = Instant::now();
        let dir = self.run_dir(run_id);
        let refname = Self::ref_name(run_id, label);
        let ckpt_tree = self
            .git(&["rev-parse", &format!("{refname}^{{tree}}")], &[], None)?
            .trim()
            .to_string();
        let meta: Option<Meta> = std::fs::read(dir.join(format!("{label}.meta.json")))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok());

        let index = self.index_path()?;
        // Work on a copy of the checkpoint's snapshot index: its entries are the
        // checkpoint tree and its stat data dates from the checkpoint, so the
        // refresh hashes only files whose stat changed since then (the same
        // stat trust `create` relies on). Without a matching snapshot index the
        // tree is read in with no stat data and every file is hashed: slow, but
        // still correct.
        let cur_index = dir.join(format!("{label}.cur.index"));
        let _ = std::fs::remove_file(&cur_index);
        let snap_index = dir.join(format!("{label}.snap.index"));
        let env = self.index_env(&cur_index);
        let snapped = meta
            .as_ref()
            .is_some_and(|m| m.tree.as_deref() == Some(ckpt_tree.as_str()))
            && std::fs::copy(&snap_index, &cur_index).is_ok();
        if !snapped {
            self.git(&["read-tree", &ckpt_tree], &env, None)?;
        }

        // The refresh drops files whose stat changed but whose content did not,
        // so `diff-files` lists only real changes. `ls-files -m` does the same
        // in one call but stats entries one by one (measured: 370 ms vs 165 ms
        // for 10,000 files). A failed refresh only means touched-but-identical
        // files are rewritten.
        let _ = self.git(
            &["update-index", "-q", "--ignore-missing", "--refresh"],
            &env,
            None,
        );
        // Tracked in the checkpoint but modified, deleted or of another type.
        let changed = self.git(&["diff-files", "-z", "--name-only"], &env, None)?;
        let restore: BTreeSet<String> = changed
            .split('\0')
            .filter(|p| !p.is_empty())
            .map(str::to_owned)
            .collect();
        // New since the checkpoint (ignored files and pre-existing oversized
        // untracked files recorded in `meta.unprotected` are left alone).
        let others = self.git(
            &[
                "ls-files",
                "-z",
                "-o",
                "--exclude-standard",
                "--",
                ".",
                ":(exclude).hy-harness",
            ],
            &env,
            None,
        )?;
        let keep_unprotected: BTreeSet<&str> = meta
            .as_ref()
            .map(|m| m.unprotected.iter().map(String::as_str).collect())
            .unwrap_or_default();
        let delete: BTreeSet<String> = others
            .split('\0')
            .filter(|p| !p.is_empty() && !keep_unprotected.contains(p))
            .map(str::to_owned)
            .collect();

        let mut result = CheckpointRollbackResult {
            restored: Vec::new(),
            deleted: Vec::new(),
            skipped: Vec::new(),
            duration_ms: 0,
        };

        // Delete first, so a new file that stands where a checkpoint directory
        // was (or the reverse) is out of the way before the restore.
        for rel in &delete {
            let full = self.workspace.join(rel);
            match std::fs::remove_file(&full) {
                Ok(()) => result.deleted.push(rel.clone()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    result.deleted.push(rel.clone())
                }
                Err(_) => result.skipped.push(rel.clone()),
            }
        }

        if !restore.is_empty() {
            let mut input = Vec::new();
            for p in &restore {
                input.extend_from_slice(p.as_bytes());
                input.push(0);
            }
            // `-u` records the restored files' new stat data in the index.
            let out = self.git_with_stdin(
                &["checkout-index", "-f", "-u", "-z", "--stdin"],
                &env,
                &input,
            );
            match out {
                Ok(_) => result.restored = restore.into_iter().collect(),
                Err(e) => {
                    result.skipped.extend(restore);
                    result.duration_ms = started.elapsed().as_millis() as u64;
                    return Err(e);
                }
            }
        }

        // The worktree now matches this index, so it becomes the stat cache.
        let _ = std::fs::copy(&cur_index, Self::stat_cache(&dir));

        // Restore the user's staging area exactly as it was before the checkpoint.
        let user_index = dir.join(format!("{label}.user.index"));
        if meta.as_ref().is_some_and(|m| m.had_index) && user_index.exists() {
            std::fs::copy(&user_index, &index).map_err(|e| CheckpointError::Io(e.to_string()))?;
        } else {
            let _ = std::fs::remove_file(&index);
        }

        result.duration_ms = started.elapsed().as_millis() as u64;

        if let Some(meta) = meta {
            let actual = self.git_opt(&["rev-parse", "HEAD"], &[], None)?;
            if actual != meta.head {
                return Err(CheckpointError::HeadMoved {
                    expected: meta.head,
                    actual,
                    rollback: Box::new(result),
                });
            }
        }
        Ok(result)
    }

    pub fn diff(
        &self,
        run_id: &str,
        from_label: &str,
        max_bytes: u64,
    ) -> Result<CheckpointDiffResult, CheckpointError> {
        Self::check_names(run_id, from_label)?;
        let refname = Self::ref_name(run_id, from_label);
        let tree = self
            .git(&["rev-parse", &format!("{refname}^{{tree}}")], &[], None)?
            .trim()
            .to_string();
        let dir = self.run_dir(run_id);
        std::fs::create_dir_all(&dir).map_err(|e| CheckpointError::Io(e.to_string()))?;
        let index = self.index_path()?;
        let cur_index = dir.join(format!("{from_label}.diff.index"));
        let _ = std::fs::remove_file(&cur_index);
        if index.exists() {
            std::fs::copy(&index, &cur_index).map_err(|e| CheckpointError::Io(e.to_string()))?;
        }
        let env = self.index_env(&cur_index);
        let _ = self.stage_worktree(&env)?;
        let cur_tree = self.git(&["write-tree"], &env, None)?.trim().to_string();
        let stat = self.git(&["diff", "--stat", &tree, &cur_tree], &[], None)?;
        let files = self.git(&["diff", "--name-only", &tree, &cur_tree], &[], None)?;
        let patch = self.git(&["diff", &tree, &cur_tree], &[], None)?;
        let truncated = patch.len() as u64 > max_bytes;
        let patch = if truncated {
            let mut end = max_bytes.min(patch.len() as u64) as usize;
            while !patch.is_char_boundary(end) && end > 0 {
                end -= 1;
            }
            format!("{}\n… [truncated] …\n", &patch[..end])
        } else {
            patch
        };
        Ok(CheckpointDiffResult {
            stat,
            patch,
            truncated,
            files_changed: files.lines().map(str::to_owned).collect(),
        })
    }

    pub fn prune(
        &self,
        run_id: &str,
        keep: &[String],
    ) -> Result<CheckpointPruneResult, CheckpointError> {
        Self::check_names(run_id, "base")?;
        let prefix = format!("refs/hy/checkpoints/{run_id}/");
        let out = self.git(&["for-each-ref", "--format=%(refname)", &prefix], &[], None)?;
        let keep: BTreeSet<&str> = keep.iter().map(String::as_str).collect();
        let mut deleted_refs = Vec::new();
        for r in out.lines().map(str::trim).filter(|r| !r.is_empty()) {
            let label = r.rsplit('/').next().unwrap_or("");
            if keep.contains(label) {
                continue;
            }
            self.git(&["update-ref", "-d", r], &[], None)?;
            deleted_refs.push(r.to_string());
        }
        Ok(CheckpointPruneResult { deleted_refs })
    }

    fn index_env(&self, index: &Path) -> Vec<(String, String)> {
        vec![
            (
                "GIT_INDEX_FILE".into(),
                index.to_string_lossy().into_owned(),
            ),
            ("GIT_ATTR_SOURCE".into(), EMPTY_TREE.into()),
            ("GIT_AUTHOR_NAME".into(), "hy-harness".into()),
            ("GIT_AUTHOR_EMAIL".into(), "hy@localhost".into()),
            ("GIT_COMMITTER_NAME".into(), "hy-harness".into()),
            ("GIT_COMMITTER_EMAIL".into(), "hy@localhost".into()),
        ]
    }

    fn git(
        &self,
        args: &[&str],
        env: &[(String, String)],
        stdin: Option<&str>,
    ) -> Result<String, CheckpointError> {
        let input = stdin.map(|s| s.as_bytes().to_vec()).unwrap_or_default();
        self.git_with_stdin(args, env, &input)
    }

    fn git_with_stdin(
        &self,
        args: &[&str],
        env: &[(String, String)],
        input: &[u8],
    ) -> Result<String, CheckpointError> {
        if let Some(guard) = &self.guard {
            guard().map_err(CheckpointError::Git)?;
        }
        let hooks = format!("core.hooksPath={}", self.hooks_dir.display());
        let mut cmd = Command::new("git");
        cmd.current_dir(&self.workspace)
            .args([
                "-c",
                "core.autocrlf=false",
                "-c",
                "core.safecrlf=false",
                "-c",
                "commit.gpgsign=false",
                "-c",
                hooks.as_str(),
                "-c",
                "core.fsmonitor=false",
            ])
            .args(args)
            .stdin(if input.is_empty() {
                Stdio::null()
            } else {
                Stdio::piped()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (k, v) in env {
            cmd.env(k, v);
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| CheckpointError::Git(format!("git {:?}: {e}", args)))?;
        if !input.is_empty()
            && let Some(mut stdin) = child.stdin.take()
        {
            stdin
                .write_all(input)
                .map_err(|e| CheckpointError::Io(e.to_string()))?;
        }
        let out = child
            .wait_with_output()
            .map_err(|e| CheckpointError::Io(e.to_string()))?;
        if out.status.success() {
            Ok(String::from_utf8_lossy(&out.stdout).into_owned())
        } else {
            Err(CheckpointError::Git(format!(
                "git {:?} failed: {}",
                args,
                String::from_utf8_lossy(&out.stderr).trim()
            )))
        }
    }

    fn git_opt(
        &self,
        args: &[&str],
        env: &[(String, String)],
        stdin: Option<&str>,
    ) -> Result<Option<String>, CheckpointError> {
        match self.git(args, env, stdin) {
            Ok(s) => Ok(Some(s.trim().to_string())),
            Err(CheckpointError::Git(_)) => Ok(None),
            Err(e) => Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn has_git() -> bool {
        std::process::Command::new("git")
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
    }

    #[test]
    fn create_diff_rollback_and_prune() {
        if !has_git() {
            return;
        }
        let repo = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let state = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let git = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .current_dir(repo.path())
                .args(args)
                .output()
                .unwrap_or_else(|e| panic!("{e}"));
            assert!(
                out.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        };
        git(&["init", "-q"]);
        std::fs::write(repo.path().join("a.txt"), "one\n").unwrap_or_else(|e| panic!("{e}"));

        let engine = CheckpointEngine::new(repo.path().to_path_buf(), state.path().to_path_buf());
        let created = engine
            .create("run1", "base")
            .unwrap_or_else(|e| panic!("{e}"));
        assert!(created.reference.ends_with("/run1/base"));

        std::fs::write(repo.path().join("a.txt"), "two\n").unwrap_or_else(|e| panic!("{e}"));
        std::fs::write(repo.path().join("new.txt"), "new\n").unwrap_or_else(|e| panic!("{e}"));
        let diff = engine
            .diff("run1", "base", 64 * 1024)
            .unwrap_or_else(|e| panic!("{e}"));
        assert!(diff.files_changed.iter().any(|p| p == "a.txt"));
        assert!(diff.files_changed.iter().any(|p| p == "new.txt"));

        let rollback = engine
            .rollback("run1", "base")
            .unwrap_or_else(|e| panic!("{e}"));
        assert!(rollback.restored.iter().any(|p| p == "a.txt"));
        assert!(rollback.deleted.iter().any(|p| p == "new.txt"));
        assert_eq!(
            std::fs::read_to_string(repo.path().join("a.txt")).unwrap_or_default(),
            "one\n"
        );
        assert!(!repo.path().join("new.txt").exists());

        let pruned = engine
            .prune("run1", &["base".to_string()])
            .unwrap_or_else(|e| panic!("{e}"));
        assert!(pruned.deleted_refs.is_empty());
        let pruned = engine.prune("run1", &[]).unwrap_or_else(|e| panic!("{e}"));
        assert!(pruned.deleted_refs.iter().any(|r| r.ends_with("/base")));
    }

    #[test]
    fn rollback_edge_cases_with_and_without_snapshot_index() {
        if !has_git() {
            return;
        }
        for with_snapshot in [true, false] {
            let repo = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
            let state = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
            let p = |rel: &str| repo.path().join(rel);
            let write =
                |rel: &str, s: &str| std::fs::write(p(rel), s).unwrap_or_else(|e| panic!("{e}"));
            let read = |rel: &str| std::fs::read_to_string(p(rel)).unwrap_or_default();
            let ok = std::process::Command::new("git")
                .current_dir(repo.path())
                .args(["init", "-q"])
                .status()
                .is_ok_and(|s| s.success());
            assert!(ok);
            std::fs::create_dir(p("dir")).unwrap_or_else(|e| panic!("{e}"));
            write("dir/x.txt", "x\n");
            write("gone.txt", "gone\n");
            write("same.txt", "same\n");
            write("日本 語.txt", "ja\n");
            write("was-file", "file\n");
            write(".gitignore", "*.log\n");

            let engine =
                CheckpointEngine::new(repo.path().to_path_buf(), state.path().to_path_buf());
            engine
                .create("run3", "base")
                .unwrap_or_else(|e| panic!("{e}"));
            let run_dir = state.path().join("ckpt").join("run3");
            if !with_snapshot {
                std::fs::remove_file(run_dir.join("base.snap.index"))
                    .unwrap_or_else(|e| panic!("{e}"));
            }

            for _ in 0..2 {
                std::thread::sleep(std::time::Duration::from_millis(20));
                // Same content, new mtime: must not be rewritten.
                write("same.txt", "same\n");
                std::fs::remove_file(p("gone.txt")).unwrap_or_else(|e| panic!("{e}"));
                write("日本 語.txt", "changed\n");
                std::fs::remove_dir_all(p("dir")).unwrap_or_else(|e| panic!("{e}"));
                write("dir", "now a file\n");
                std::fs::remove_file(p("was-file")).unwrap_or_else(|e| panic!("{e}"));
                std::fs::create_dir(p("was-file")).unwrap_or_else(|e| panic!("{e}"));
                write("was-file/inner.txt", "inner\n");
                write("build.log", "ignored\n");

                let r = engine
                    .rollback("run3", "base")
                    .unwrap_or_else(|e| panic!("{e}"));
                assert!(r.skipped.is_empty(), "{r:?}");
                assert_eq!(read("dir/x.txt"), "x\n");
                assert_eq!(read("gone.txt"), "gone\n");
                assert_eq!(read("日本 語.txt"), "ja\n");
                assert_eq!(read("was-file"), "file\n");
                assert_eq!(
                    read("build.log"),
                    "ignored\n",
                    "ignored files are kept (C1)"
                );
                assert!(!r.restored.iter().any(|f| f == "same.txt"), "{r:?}");
                assert!(r.deleted.iter().any(|f| f == "dir"), "{r:?}");
                assert!(r.deleted.iter().any(|f| f == "was-file/inner.txt"), "{r:?}");
            }
        }
    }

    #[test]
    fn preserves_user_index_and_head() {
        if !has_git() {
            return;
        }
        let repo = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let state = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let git = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .current_dir(repo.path())
                .args(args)
                .output()
                .unwrap_or_else(|e| panic!("{e}"));
            assert!(
                out.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        };
        git(&["init", "-q"]);
        git(&["config", "user.name", "test"]);
        git(&["config", "user.email", "test@example.com"]);
        std::fs::write(repo.path().join("a.txt"), "one\n").unwrap_or_else(|e| panic!("{e}"));
        git(&["add", "a.txt"]);
        git(&["commit", "-qm", "init"]);
        let head = std::process::Command::new("git")
            .current_dir(repo.path())
            .args(["rev-parse", "HEAD"])
            .output()
            .unwrap_or_else(|e| panic!("{e}"));
        let head = String::from_utf8_lossy(&head.stdout).trim().to_string();

        std::fs::write(repo.path().join("b.txt"), "staged\n").unwrap_or_else(|e| panic!("{e}"));
        git(&["add", "b.txt"]);
        let engine = CheckpointEngine::new(repo.path().to_path_buf(), state.path().to_path_buf());
        engine
            .create("run2", "base")
            .unwrap_or_else(|e| panic!("{e}"));

        std::fs::write(repo.path().join("a.txt"), "two\n").unwrap_or_else(|e| panic!("{e}"));
        std::fs::write(repo.path().join("c.txt"), "unstaged\n").unwrap_or_else(|e| panic!("{e}"));
        engine
            .rollback("run2", "base")
            .unwrap_or_else(|e| panic!("{e}"));

        let after_head = std::process::Command::new("git")
            .current_dir(repo.path())
            .args(["rev-parse", "HEAD"])
            .output()
            .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(String::from_utf8_lossy(&after_head.stdout).trim(), head);
        let staged = std::process::Command::new("git")
            .current_dir(repo.path())
            .args(["diff", "--cached", "--name-only"])
            .output()
            .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(String::from_utf8_lossy(&staged.stdout).trim(), "b.txt");
        assert!(!repo.path().join("c.txt").exists());
    }

    #[test]
    fn oversized_file_names_are_excluded_literally_not_as_globs() {
        if !has_git() {
            return;
        }
        let repo = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let state = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let ok = std::process::Command::new("git")
            .current_dir(repo.path())
            .args(["init", "-q"])
            .status()
            .is_ok_and(|s| s.success());
        assert!(ok);
        // `data[1].bin` read as a glob matches `data1.bin`, a small file that must be kept.
        std::fs::write(repo.path().join("data[1].bin"), vec![b'x'; 2048])
            .unwrap_or_else(|e| panic!("{e}"));
        std::fs::write(repo.path().join("data1.bin"), "small\n").unwrap_or_else(|e| panic!("{e}"));

        let engine = CheckpointEngine::new(repo.path().to_path_buf(), state.path().to_path_buf())
            .with_max_untracked_bytes(1024);
        let created = engine
            .create("run-glob", "base")
            .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(created.unprotected, vec!["data[1].bin".to_string()]);
        let ls = std::process::Command::new("git")
            .current_dir(repo.path())
            .args(["ls-tree", "-r", "--name-only", &created.tree_oid])
            .output()
            .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(String::from_utf8_lossy(&ls.stdout).trim(), "data1.bin");
    }

    #[test]
    fn skips_oversized_untracked_files_and_preserves_them_on_rollback() {
        if !has_git() {
            return;
        }
        let repo = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let state = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let ok = std::process::Command::new("git")
            .current_dir(repo.path())
            .args(["init", "-q"])
            .status()
            .is_ok_and(|s| s.success());
        assert!(ok);
        std::fs::write(repo.path().join("small.txt"), "small\n").unwrap_or_else(|e| panic!("{e}"));
        std::fs::write(repo.path().join("big.bin"), vec![b'x'; 2048])
            .unwrap_or_else(|e| panic!("{e}"));

        let engine = CheckpointEngine::new(repo.path().to_path_buf(), state.path().to_path_buf())
            .with_max_untracked_bytes(1024);
        let created = engine
            .create("run-big", "base")
            .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(created.unprotected, vec!["big.bin".to_string()]);

        // Modify small.txt and add a new oversized untracked file after the checkpoint.
        std::fs::write(repo.path().join("small.txt"), "edited\n").unwrap_or_else(|e| panic!("{e}"));
        std::fs::write(repo.path().join("new-big.bin"), vec![b'y'; 2048])
            .unwrap_or_else(|e| panic!("{e}"));

        let diff = engine
            .diff("run-big", "base", 10)
            .unwrap_or_else(|e| panic!("{e}"));
        assert!(diff.truncated);
        assert!(diff.files_changed.iter().any(|p| p == "small.txt"));
        assert!(!diff.files_changed.iter().any(|p| p == "big.bin"));
        assert!(!diff.files_changed.iter().any(|p| p == "new-big.bin"));

        let rolled = engine
            .rollback("run-big", "base")
            .unwrap_or_else(|e| panic!("{e}"));
        assert!(rolled.restored.iter().any(|p| p == "small.txt"));
        // Pre-existing oversized untracked file stays; new oversized file is deleted.
        assert!(repo.path().join("big.bin").exists());
        assert!(!repo.path().join("new-big.bin").exists());
    }

    #[test]
    fn rejects_invalid_names_and_detects_head_moved() {
        if !has_git() {
            return;
        }
        let repo = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let state = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let engine = CheckpointEngine::new(repo.path().to_path_buf(), state.path().to_path_buf());
        assert!(matches!(
            engine.create("bad/name", "base"),
            Err(CheckpointError::InvalidName(_))
        ));

        let git = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .current_dir(repo.path())
                .args(args)
                .output()
                .unwrap_or_else(|e| panic!("{e}"));
            assert!(out.status.success());
        };
        git(&["init", "-q"]);
        git(&["config", "user.name", "test"]);
        git(&["config", "user.email", "test@example.com"]);
        std::fs::write(repo.path().join("a.txt"), "1\n").unwrap_or_else(|e| panic!("{e}"));
        git(&["add", "a.txt"]);
        git(&["commit", "-qm", "c1"]);
        engine
            .create("run-head", "base")
            .unwrap_or_else(|e| panic!("{e}"));
        std::fs::write(repo.path().join("a.txt"), "2\n").unwrap_or_else(|e| panic!("{e}"));
        git(&["add", "a.txt"]);
        git(&["commit", "-qm", "c2"]);
        assert!(matches!(
            engine.rollback("run-head", "base"),
            Err(CheckpointError::HeadMoved { .. })
        ));
    }
}
