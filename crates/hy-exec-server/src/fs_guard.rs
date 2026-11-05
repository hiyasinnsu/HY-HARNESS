//! Path checks for `patch/apply` (design §4.4).
//!
//! Every target's nearest existing ancestor is canonicalized and must lie under
//! the canonical workspace root; an existing target that is itself a reparse
//! point is rejected; `.git/**`, `.hy-harness/**` and (when enforced) the
//! project's `protectedPaths` are rejected.

use std::os::windows::fs::MetadataExt;
use std::path::{Component, Path, PathBuf};

use globset::{Glob, GlobSet, GlobSetBuilder};

const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum GuardError {
    #[error("path {0:?} is outside the workspace")]
    Outside(String),
    #[error("path {0:?} is inside a harness-owned directory (.git or .hy-harness)")]
    HarnessOwned(String),
    #[error("path {0:?} is protected (protectedPaths)")]
    Protected(String),
    #[error("path {0:?} is a reparse point (symlink or junction)")]
    ReparsePoint(String),
    #[error("invalid path {0:?}: {1}")]
    Invalid(String, String),
}

pub struct FsGuard {
    root: PathBuf,
    canonical_root: PathBuf,
    protected: GlobSet,
}

/// Lexically removes `.` and `..` (never above the start).
fn normalize(p: &Path) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    return None;
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    Some(out)
}

impl FsGuard {
    pub fn new(root: &Path, protected_globs: &[String]) -> std::io::Result<Self> {
        let canonical_root = std::fs::canonicalize(root)?;
        let mut b = GlobSetBuilder::new();
        for g in protected_globs {
            let glob = Glob::new(g)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidInput, e))?;
            b.add(glob);
        }
        let protected = b
            .build()
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidInput, e))?;
        Ok(Self {
            root: root.to_path_buf(),
            canonical_root,
            protected,
        })
    }

    /// Checks a workspace-relative path from a patch and returns the absolute
    /// path to write, plus the normalized relative path (forward slashes).
    pub fn check(
        &self,
        rel: &str,
        enforce_protected: bool,
    ) -> Result<(PathBuf, String), GuardError> {
        let raw = Path::new(rel);
        if raw.is_absolute() || raw.has_root() || rel.contains(':') {
            return Err(GuardError::Outside(rel.into()));
        }
        let norm = normalize(raw).ok_or_else(|| GuardError::Outside(rel.into()))?;
        let rel_fwd = norm
            .components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("/");
        if rel_fwd.is_empty() {
            return Err(GuardError::Invalid(rel.into(), "empty path".into()));
        }
        let first = norm
            .components()
            .next()
            .map(|c| c.as_os_str().to_string_lossy().to_lowercase());
        let any_git = norm
            .components()
            .any(|c| c.as_os_str().to_string_lossy().eq_ignore_ascii_case(".git"));
        if any_git || first.as_deref() == Some(".hy-harness") {
            return Err(GuardError::HarnessOwned(rel_fwd));
        }
        if enforce_protected && self.protected.is_match(&rel_fwd) {
            return Err(GuardError::Protected(rel_fwd));
        }
        let full = self.root.join(&norm);
        if let Ok(meta) = std::fs::symlink_metadata(&full)
            && meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
        {
            return Err(GuardError::ReparsePoint(rel_fwd));
        }
        // Nearest existing ancestor must canonicalize under the root, so a
        // junction anywhere on the path cannot redirect the write.
        let mut anc = full.parent().map(Path::to_path_buf);
        while let Some(a) = anc.clone() {
            if a.exists() {
                let canon = std::fs::canonicalize(&a)
                    .map_err(|e| GuardError::Invalid(rel_fwd.clone(), e.to_string()))?;
                if !canon.starts_with(&self.canonical_root) {
                    return Err(GuardError::Outside(rel_fwd));
                }
                break;
            }
            anc = a.parent().map(Path::to_path_buf);
        }
        Ok((full, rel_fwd))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn guard() -> (tempfile::TempDir, FsGuard) {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let g = FsGuard::new(
            dir.path(),
            &["tests/fixtures/**".into(), "package.json".into()],
        )
        .unwrap_or_else(|e| panic!("{e}"));
        (dir, g)
    }

    #[test]
    fn accepts_normal_paths() {
        let (_d, g) = guard();
        assert!(g.check("src/a.rs", true).is_ok());
        assert_eq!(
            g.check("src/./x/../a.rs", true).map(|r| r.1),
            Ok("src/a.rs".to_string())
        );
    }

    #[test]
    fn rejects_escapes_and_owned_dirs() {
        let (_d, g) = guard();
        assert!(matches!(
            g.check("../x", false),
            Err(GuardError::Outside(_))
        ));
        assert!(matches!(
            g.check("a/../../x", false),
            Err(GuardError::Outside(_))
        ));
        assert!(matches!(
            g.check("C:\\Windows\\x", false),
            Err(GuardError::Outside(_))
        ));
        assert!(matches!(
            g.check("\\\\server\\share\\x", false),
            Err(GuardError::Outside(_))
        ));
        assert!(matches!(
            g.check(".git/config", false),
            Err(GuardError::HarnessOwned(_))
        ));
        assert!(matches!(
            g.check("sub/.GIT/hooks/x", false),
            Err(GuardError::HarnessOwned(_))
        ));
        assert!(matches!(
            g.check(".hy-harness/config.json", false),
            Err(GuardError::HarnessOwned(_))
        ));
    }

    #[test]
    fn protected_only_when_enforced() {
        let (_d, g) = guard();
        assert!(matches!(
            g.check("tests/fixtures/a.txt", true),
            Err(GuardError::Protected(_))
        ));
        assert!(g.check("tests/fixtures/a.txt", false).is_ok());
        assert!(matches!(
            g.check("package.json", true),
            Err(GuardError::Protected(_))
        ));
    }
}
