//! Unified-diff patcher (design §4.4).
//!
//! Hunks are anchored by context (exact, then whitespace-insensitive), not by
//! header line numbers. All files are patched in memory first; then each file
//! is written to a temp file in the same directory and renamed over the target.
//! If a later file fails, earlier ones are restored. BOM and dominant line
//! ending are preserved; `.json` / `.toml` results must still parse.

use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};

use hy_protocol::{NearestMatch, PatchApplyResult};
use sha2::{Digest, Sha256};

use crate::fs_guard::{FsGuard, GuardError};

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Hunk {
    pub old_start: usize,
    pub old: Vec<String>,
    pub new: Vec<String>,
    pub old_no_eol: bool,
    pub new_no_eol: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct FilePatch {
    pub old_path: Option<String>,
    pub new_path: Option<String>,
    pub hunks: Vec<Hunk>,
}

#[derive(Debug, thiserror::Error)]
pub enum PatchError {
    #[error("malformed patch: {0}")]
    Parse(String),
    #[error("{0}")]
    Guard(#[from] GuardError),
    #[error("hunk {hunk} does not apply to {file}")]
    Conflict {
        file: String,
        hunk: usize,
        nearest: Option<NearestMatch>,
    },
    #[error("{file}: {message}")]
    Invalid { file: String, message: String },
    #[error("{file}: {source}")]
    Io {
        file: String,
        source: std::io::Error,
    },
}

fn strip_prefix_path(p: &str) -> Option<String> {
    let p = p.split('\t').next().unwrap_or(p).trim();
    if p == "/dev/null" {
        return None;
    }
    let p = p
        .strip_prefix("a/")
        .or_else(|| p.strip_prefix("b/"))
        .unwrap_or(p);
    Some(p.trim_matches('"').to_string())
}

fn parse_range(s: &str) -> Option<usize> {
    s.split(',').next()?.parse().ok()
}

/// Parses a unified diff (git-style headers accepted).
pub fn parse(text: &str) -> Result<Vec<FilePatch>, PatchError> {
    let lines: Vec<&str> = text
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .collect();
    let mut files = Vec::new();
    let mut i = 0;
    let mut pending_rename: (Option<String>, Option<String>) = (None, None);
    while i < lines.len() {
        let l = lines[i];
        if let Some(r) = l.strip_prefix("rename from ") {
            pending_rename.0 = Some(r.trim().to_string());
            i += 1;
            continue;
        }
        if let Some(r) = l.strip_prefix("rename to ") {
            pending_rename.1 = Some(r.trim().to_string());
            i += 1;
            continue;
        }
        if l.starts_with("diff --git ") {
            if let (Some(a), Some(b)) = pending_rename.clone() {
                files.push(FilePatch {
                    old_path: Some(a),
                    new_path: Some(b),
                    hunks: vec![],
                });
            }
            pending_rename = (None, None);
            i += 1;
            continue;
        }
        if let Some(old) = l.strip_prefix("--- ") {
            let new_line = lines
                .get(i + 1)
                .ok_or_else(|| PatchError::Parse("'---' without '+++'".into()))?;
            let new = new_line
                .strip_prefix("+++ ")
                .ok_or_else(|| PatchError::Parse(format!("expected '+++' after '{l}'")))?;
            let mut fp = FilePatch {
                old_path: strip_prefix_path(old),
                new_path: strip_prefix_path(new),
                hunks: vec![],
            };
            if let (Some(a), Some(b)) = pending_rename.clone() {
                fp.old_path = Some(a);
                fp.new_path = Some(b);
            }
            pending_rename = (None, None);
            i += 2;
            while i < lines.len() && lines[i].starts_with("@@") {
                let header = lines[i];
                let inner = header.trim_start_matches('@').trim();
                let inner = inner.split("@@").next().unwrap_or("").trim();
                let mut parts = inner.split_whitespace();
                let old_r = parts
                    .next()
                    .and_then(|p| p.strip_prefix('-'))
                    .and_then(parse_range)
                    .ok_or_else(|| PatchError::Parse(format!("bad hunk header '{header}'")))?;
                let mut h = Hunk {
                    old_start: old_r,
                    ..Default::default()
                };
                i += 1;
                let mut last_side = ' ';
                while i < lines.len() {
                    let t = lines[i];
                    if t.starts_with("@@") || t.starts_with("--- ") || t.starts_with("diff --git ")
                    {
                        break;
                    }
                    if t.starts_with('\\') {
                        match last_side {
                            '-' => h.old_no_eol = true,
                            '+' => h.new_no_eol = true,
                            _ => {
                                h.old_no_eol = true;
                                h.new_no_eol = true;
                            }
                        }
                        i += 1;
                        continue;
                    }
                    match t.chars().next() {
                        Some(' ') => {
                            h.old.push(t[1..].to_string());
                            h.new.push(t[1..].to_string());
                            last_side = ' ';
                        }
                        Some('-') => {
                            h.old.push(t[1..].to_string());
                            last_side = '-';
                        }
                        Some('+') => {
                            h.new.push(t[1..].to_string());
                            last_side = '+';
                        }
                        None => {
                            // A blank line inside a hunk: models often drop the leading space.
                            if i + 1 < lines.len() {
                                h.old.push(String::new());
                                h.new.push(String::new());
                                last_side = ' ';
                            }
                        }
                        _ => break,
                    }
                    i += 1;
                }
                fp.hunks.push(h);
            }
            files.push(fp);
            continue;
        }
        i += 1;
    }
    if let (Some(a), Some(b)) = pending_rename {
        files.push(FilePatch {
            old_path: Some(a),
            new_path: Some(b),
            hunks: vec![],
        });
    }
    if files.is_empty() {
        return Err(PatchError::Parse("no file sections found".into()));
    }
    Ok(files)
}

/// The text encoding of a patched file. The control plane sends it when it
/// decoded the file itself (`edit_file` on a UTF-16 document); otherwise the
/// daemon detects it from a BOM and assumes UTF-8.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Encoding {
    Utf8,
    Utf16Le,
    Utf16Be,
}

impl Encoding {
    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "utf8" | "utf-8" => Some(Self::Utf8),
            "utf16le" | "utf-16le" => Some(Self::Utf16Le),
            "utf16be" | "utf-16be" => Some(Self::Utf16Be),
            _ => None,
        }
    }
}

#[derive(Debug, Clone)]
struct TextFile {
    encoding: Encoding,
    bom: bool,
    crlf: bool,
    lines: Vec<String>,
    final_newline: bool,
}

fn decode(bytes: &[u8], file: &str, requested: Option<Encoding>) -> Result<TextFile, PatchError> {
    // An explicit encoding wins; otherwise a BOM tells UTF-16 apart from UTF-8.
    let (encoding, body) = match requested {
        Some(Encoding::Utf16Le) => (Encoding::Utf16Le, bytes.strip_prefix(&[0xFF, 0xFE]).unwrap_or(bytes)),
        Some(Encoding::Utf16Be) => (Encoding::Utf16Be, bytes.strip_prefix(&[0xFE, 0xFF]).unwrap_or(bytes)),
        Some(Encoding::Utf8) => (Encoding::Utf8, bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes)),
        None if bytes.starts_with(&[0xFF, 0xFE]) => (Encoding::Utf16Le, &bytes[2..]),
        None if bytes.starts_with(&[0xFE, 0xFF]) => (Encoding::Utf16Be, &bytes[2..]),
        // A UTF-8 BOM is kept as a flag, not as a character in the first line.
        None if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) => (Encoding::Utf8, &bytes[3..]),
        None => (Encoding::Utf8, bytes),
    };
    let bom = matches!(encoding, Encoding::Utf8) && bytes.starts_with(&[0xEF, 0xBB, 0xBF])
        || matches!(encoding, Encoding::Utf16Le) && bytes.starts_with(&[0xFF, 0xFE])
        || matches!(encoding, Encoding::Utf16Be) && bytes.starts_with(&[0xFE, 0xFF]);
    let text = match encoding {
        Encoding::Utf8 => std::str::from_utf8(body).map_err(|_| PatchError::Invalid {
            file: file.into(),
            message: "file is not valid UTF-8".into(),
        })?.to_string(),
        Encoding::Utf16Le | Encoding::Utf16Be => {
            if body.len() % 2 != 0 {
                return Err(PatchError::Invalid {
                    file: file.into(),
                    message: "file is not valid UTF-16 (odd length)".into(),
                });
            }
            let units: Vec<u16> = body
                .chunks_exact(2)
                .map(|c| match encoding {
                    Encoding::Utf16Be => u16::from_be_bytes([c[0], c[1]]),
                    _ => u16::from_le_bytes([c[0], c[1]]),
                })
                .collect();
            String::from_utf16(&units).map_err(|_| PatchError::Invalid {
                file: file.into(),
                message: "file is not valid UTF-16".into(),
            })?
        }
    };
    let text = text.as_str();
    let crlf_count = text.matches("\r\n").count();
    let lf_count = text.matches('\n').count();
    let crlf = crlf_count * 2 > lf_count && crlf_count > 0;
    let final_newline = text.ends_with('\n');
    let mut lines: Vec<String> = text
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l).to_string())
        .collect();
    if final_newline || text.is_empty() {
        lines.pop();
    }
    Ok(TextFile {
        encoding,
        bom,
        crlf,
        lines,
        final_newline,
    })
}

/// The decoded text as it will be written (line endings and final newline included).
fn render_text(t: &TextFile) -> String {
    let eol = if t.crlf { "\r\n" } else { "\n" };
    let mut s = t.lines.join(eol);
    if t.final_newline && !t.lines.is_empty() {
        s.push_str(eol);
    }
    s
}

fn encode(t: &TextFile) -> Vec<u8> {
    let s = render_text(t);
    let mut out = Vec::with_capacity(s.len() + 3);
    match t.encoding {
        Encoding::Utf8 => {
            if t.bom {
                out.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
            }
            out.extend_from_slice(s.as_bytes());
        }
        Encoding::Utf16Le | Encoding::Utf16Be => {
            if t.bom {
                out.extend_from_slice(if t.encoding == Encoding::Utf16Le { &[0xFF, 0xFE] } else { &[0xFE, 0xFF] });
            }
            for unit in s.encode_utf16() {
                out.extend_from_slice(&match t.encoding {
                    Encoding::Utf16Be => unit.to_be_bytes(),
                    _ => unit.to_le_bytes(),
                });
            }
        }
    }
    out
}

fn ws_norm(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn find_at(lines: &[String], needle: &[String], from: usize, fuzzy: bool) -> Vec<usize> {
    if needle.is_empty() || needle.len() > lines.len() {
        return vec![];
    }
    (from..=lines.len() - needle.len())
        .filter(|&p| {
            needle.iter().enumerate().all(|(k, n)| {
                if fuzzy {
                    ws_norm(&lines[p + k]) == ws_norm(n)
                } else {
                    lines[p + k] == *n
                }
            })
        })
        .collect()
}

fn nearest(lines: &[String], needle: &[String]) -> Option<NearestMatch> {
    let first = needle.iter().find(|l| !l.trim().is_empty())?;
    let key = ws_norm(first);
    let pos = lines.iter().position(|l| ws_norm(l) == key)?;
    let end = (pos + needle.len()).min(lines.len());
    Some(NearestMatch {
        start_line: pos + 1,
        text: lines[pos..end].join("\n"),
    })
}

fn apply_hunks(file: &str, t: &mut TextFile, hunks: &[Hunk]) -> Result<(), PatchError> {
    let mut floor = 0usize;
    let mut offset: isize = 0;
    for (idx, h) in hunks.iter().enumerate() {
        let hint = ((h.old_start.saturating_sub(1)) as isize + offset).max(0) as usize;
        let pos = if h.old.is_empty() {
            hint.min(t.lines.len()).max(floor)
        } else {
            let pick = |cands: Vec<usize>| {
                cands
                    .into_iter()
                    .min_by_key(|&p| (p as isize - hint as isize).abs())
            };
            pick(find_at(&t.lines, &h.old, floor, false))
                .or_else(|| pick(find_at(&t.lines, &h.old, floor, true)))
                .ok_or_else(|| PatchError::Conflict {
                    file: file.into(),
                    hunk: idx + 1,
                    nearest: nearest(&t.lines, &h.old),
                })?
        };
        let at_end = pos + h.old.len() == t.lines.len();
        t.lines
            .splice(pos..pos + h.old.len(), h.new.iter().cloned());
        if at_end {
            if h.new_no_eol {
                t.final_newline = false;
            } else if h.old_no_eol {
                t.final_newline = true;
            }
        }
        floor = pos + h.new.len();
        offset += h.new.len() as isize - h.old.len() as isize;
    }
    Ok(())
}

fn validate(rel: &str, t: &TextFile) -> Result<(), PatchError> {
    let lower = rel.to_lowercase();
    let text = render_text(t);
    let text = text.as_str();
    if lower.ends_with(".json") {
        serde_json::from_str::<serde_json::Value>(text).map_err(|e| PatchError::Invalid {
            file: rel.into(),
            message: format!("result is not valid JSON: {e}"),
        })?;
    } else if lower.ends_with(".toml") {
        text.parse::<toml::Table>()
            .map_err(|e| PatchError::Invalid {
                file: rel.into(),
                message: format!("result is not valid TOML: {e}"),
            })?;
    }
    Ok(())
}

enum Action {
    Write {
        path: PathBuf,
        bytes: Vec<u8>,
        created: bool,
    },
    Delete {
        path: PathBuf,
    },
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    hex::encode(h.finalize())
}

/// Applies a patch transactionally. `dry_run` computes the result without writing.
pub fn apply(
    guard: &FsGuard,
    patch: &str,
    dry_run: bool,
    enforce_protected: bool,
    encoding: Option<Encoding>,
) -> Result<PatchApplyResult, PatchError> {
    let files = parse(patch)?;
    let mut actions: BTreeMap<String, Action> = BTreeMap::new();
    let mut result = PatchApplyResult::default();

    for fp in &files {
        match (&fp.old_path, &fp.new_path) {
            (None, Some(new)) => {
                let (path, rel) = guard.check(new, enforce_protected)?;
                let mut t = TextFile {
                    encoding: encoding.unwrap_or(Encoding::Utf8),
                    bom: false,
                    crlf: false,
                    lines: vec![],
                    // A newly created text file ends with a newline unless the
                    // patch says otherwise (`\ No newline at end of file`).
                    final_newline: true,
                };
                apply_hunks(&rel, &mut t, &fp.hunks)?;
                let bytes = encode(&t);
                validate(&rel, &t)?;
                actions.insert(
                    rel.clone(),
                    Action::Write {
                        created: !path.exists(),
                        path,
                        bytes,
                    },
                );
            }
            (Some(old), None) => {
                let (path, rel) = guard.check(old, enforce_protected)?;
                actions.insert(rel.clone(), Action::Delete { path });
            }
            (Some(old), Some(new)) if old == new => {
                let (path, rel) = guard.check(new, enforce_protected)?;
                let bytes = std::fs::read(&path).map_err(|e| PatchError::Io {
                    file: rel.clone(),
                    source: e,
                })?;
                let mut t = decode(&bytes, &rel, encoding)?;
                apply_hunks(&rel, &mut t, &fp.hunks)?;
                let out = encode(&t);
                validate(&rel, &t)?;
                actions.insert(
                    rel.clone(),
                    Action::Write {
                        path,
                        bytes: out,
                        created: false,
                    },
                );
            }
            (Some(old), Some(new)) => {
                let (old_path, old_rel) = guard.check(old, enforce_protected)?;
                let (new_path, new_rel) = guard.check(new, enforce_protected)?;
                let bytes = std::fs::read(&old_path).map_err(|e| PatchError::Io {
                    file: old_rel.clone(),
                    source: e,
                })?;
                let mut t = decode(&bytes, &old_rel, encoding)?;
                apply_hunks(&new_rel, &mut t, &fp.hunks)?;
                let out = encode(&t);
                validate(&new_rel, &t)?;
                actions.insert(old_rel.clone(), Action::Delete { path: old_path });
                actions.insert(
                    new_rel.clone(),
                    Action::Write {
                        created: !new_path.exists(),
                        path: new_path,
                        bytes: out,
                    },
                );
            }
            (None, None) => {
                return Err(PatchError::Parse(
                    "file section has neither an old nor a new path".into(),
                ));
            }
        }
    }

    if dry_run {
        for (rel, action) in &actions {
            match action {
                Action::Write { bytes, created, .. } => {
                    result.applied_files.push(rel.clone());
                    if *created {
                        result.created.push(rel.clone());
                    }
                    result.hashes.insert(rel.clone(), sha256_hex(bytes));
                }
                Action::Delete { .. } => result.deleted.push(rel.clone()),
            }
        }
        return Ok(result);
    }

    // Keep the original content so a failure halfway through can be undone.
    let mut backups: BTreeMap<String, Option<Vec<u8>>> = BTreeMap::new();
    for (rel, action) in &actions {
        let path = match action {
            Action::Write { path, .. } | Action::Delete { path, .. } => path,
        };
        backups.insert(rel.clone(), std::fs::read(path).ok());
    }

    let mut done: Vec<String> = Vec::new();
    let mut failure: Option<PatchError> = None;
    for (rel, action) in &actions {
        let step = match action {
            Action::Write {
                path,
                bytes,
                created,
                ..
            } => {
                if let Some(parent) = path.parent()
                    && let Err(e) = std::fs::create_dir_all(parent)
                {
                    Err(PatchError::Io {
                        file: rel.clone(),
                        source: e,
                    })
                } else {
                    match write_replace(path, bytes) {
                        Ok(()) => {
                            if *created {
                                result.created.push(rel.clone());
                            }
                            result.applied_files.push(rel.clone());
                            result.hashes.insert(rel.clone(), sha256_hex(bytes));
                            Ok(())
                        }
                        Err(e) => Err(PatchError::Io {
                            file: rel.clone(),
                            source: e,
                        }),
                    }
                }
            }
            Action::Delete { path, .. } => match std::fs::remove_file(path) {
                Ok(()) => {
                    result.deleted.push(rel.clone());
                    result.applied_files.push(rel.clone());
                    Ok(())
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    result.deleted.push(rel.clone());
                    Ok(())
                }
                Err(e) => Err(PatchError::Io {
                    file: rel.clone(),
                    source: e,
                }),
            },
        };
        if let Err(e) = step {
            failure = Some(e);
            break;
        }
        done.push(rel.clone());
    }

    if let Some(err) = failure {
        for rel in done.iter().rev() {
            let Some(action) = actions.get(rel) else {
                continue;
            };
            let path = match action {
                Action::Write { path, .. } | Action::Delete { path, .. } => path,
            };
            match backups.get(rel) {
                Some(Some(original)) => {
                    let _ = std::fs::write(path, original);
                }
                Some(None) => {
                    let _ = std::fs::remove_file(path);
                }
                None => {}
            }
        }
        return Err(err);
    }

    Ok(result)
}

#[cfg(windows)]
fn replace_file(src: &Path, dst: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW, REPLACEFILE_WRITE_THROUGH,
        ReplaceFileW,
    };

    let src_w: Vec<u16> = src.as_os_str().encode_wide().chain(Some(0)).collect();
    let dst_w: Vec<u16> = dst.as_os_str().encode_wide().chain(Some(0)).collect();
    if dst.exists() {
        // SAFETY: both paths are NUL-terminated UTF-16 buffers.
        let ok = unsafe {
            ReplaceFileW(
                dst_w.as_ptr(),
                src_w.as_ptr(),
                std::ptr::null(),
                REPLACEFILE_WRITE_THROUGH,
                std::ptr::null(),
                std::ptr::null(),
            )
        };
        if ok != 0 {
            return Ok(());
        }
        // SAFETY: same buffers as above.
        let ok = unsafe {
            MoveFileExW(
                src_w.as_ptr(),
                dst_w.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        };
        if ok != 0 {
            return Ok(());
        }
        Err(std::io::Error::last_os_error())
    } else {
        // SAFETY: both paths are NUL-terminated UTF-16 buffers.
        let ok = unsafe { MoveFileExW(src_w.as_ptr(), dst_w.as_ptr(), MOVEFILE_WRITE_THROUGH) };
        if ok != 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    }
}

#[cfg(not(windows))]
fn replace_file(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::rename(src, dst)
}

fn write_replace(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let mut tmp = tempfile::NamedTempFile::new_in(parent)?;
    tmp.write_all(bytes)?;
    tmp.flush()?;
    tmp.as_file().sync_all()?;
    let (_file, tmp_path) = tmp.keep().map_err(|e| e.error)?;
    replace_file(&tmp_path, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, FsGuard) {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let guard = FsGuard::new(dir.path(), &[]).unwrap_or_else(|e| panic!("{e}"));
        (dir, guard)
    }

    fn apply(guard: &FsGuard, patch: &str) -> PatchApplyResult {
        match super::apply(guard, patch, false, false, None) {
            Ok(r) => r,
            Err(e) => panic!("patch failed: {e}"),
        }
    }

    #[test]
    fn edits_utf16le_files_in_their_own_encoding() {
        let (dir, guard) = fixture();
        let path = dir.path().join("u16.txt");
        let mut bytes = vec![0xFF, 0xFE];
        for unit in "one\ntwo\n".encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        std::fs::write(&path, &bytes).unwrap_or_else(|e| panic!("{e}"));
        let diff = "--- a/u16.txt\n+++ b/u16.txt\n@@ -1,2 +1,2 @@\n-one\n+ONE\n two\n";
        // The control plane decoded the file itself and names the encoding; a
        // BOM alone would also be detected.
        match super::apply(&guard, diff, false, false, Some(Encoding::Utf16Le)) {
            Ok(r) => assert_eq!(r.applied_files, vec!["u16.txt"]),
            Err(e) => panic!("patch failed: {e}"),
        }
        let out = std::fs::read(&path).unwrap_or_default();
        assert_eq!(&out[..2], &[0xFF, 0xFE], "exactly one BOM");
        let units: Vec<u16> = out[2..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        assert_eq!(String::from_utf16(&units).unwrap_or_default(), "ONE\ntwo\n");

        // Without the hint the BOM is enough.
        std::fs::write(&path, &bytes).unwrap_or_else(|e| panic!("{e}"));
        match super::apply(&guard, diff, false, false, None) {
            Ok(r) => assert_eq!(r.applied_files, vec!["u16.txt"]),
            Err(e) => panic!("patch failed: {e}"),
        }
        let out = std::fs::read(&path).unwrap_or_default();
        assert_eq!(&out[..2], &[0xFF, 0xFE], "exactly one BOM");
    }

    #[test]
    fn creates_modifies_and_deletes() {
        let (dir, guard) = fixture();
        let created = apply(
            &guard,
            "--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1,2 @@\n+hello\n+world\n",
        );
        assert_eq!(created.created, vec!["a.txt"]);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("a.txt")).unwrap_or_default(),
            "hello\nworld\n",
            "a created text file ends with a newline unless the patch says otherwise"
        );

        // The explicit marker keeps it without one.
        let bare = apply(
            &guard,
            "--- /dev/null\n+++ b/b.txt\n@@ -0,0 +1,1 @@\n+no newline\n\\ No newline at end of file\n",
        );
        assert_eq!(bare.created, vec!["b.txt"]);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("b.txt")).unwrap_or_default(),
            "no newline"
        );

        let modified = apply(
            &guard,
            "--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n hello\n-world\n+there\n",
        );
        assert_eq!(modified.applied_files, vec!["a.txt"]);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("a.txt")).unwrap_or_default(),
            "hello\nthere\n",
            "an edit that does not mention the last line keeps the final newline"
        );

        let deleted = apply(
            &guard,
            "--- a/a.txt\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-hello\n-there\n",
        );
        assert_eq!(deleted.deleted, vec!["a.txt"]);
        assert!(!dir.path().join("a.txt").exists());
    }

    #[test]
    fn preserves_bom_and_crlf() {
        let (dir, guard) = fixture();
        let original = [0xEF, 0xBB, 0xBF, b'o', b'l', b'd', b'\r', b'\n'];
        std::fs::write(dir.path().join("b.txt"), original).unwrap_or_else(|e| panic!("{e}"));
        apply(
            &guard,
            "--- a/b.txt\n+++ b/b.txt\n@@ -1,1 +1,1 @@\n-old\n+new\n",
        );
        let bytes = std::fs::read(dir.path().join("b.txt")).unwrap_or_default();
        assert_eq!(&bytes[..3], &[0xEF, 0xBB, 0xBF]);
        assert_eq!(&bytes[3..], b"new\r\n");
    }

    #[test]
    fn rejects_conflicting_context() {
        let (dir, guard) = fixture();
        std::fs::write(dir.path().join("c.txt"), "actual\n").unwrap_or_else(|e| panic!("{e}"));
        let err = super::apply(
            &guard,
            "--- a/c.txt\n+++ b/c.txt\n@@ -1,1 +1,1 @@\n-expected\n+new\n",
            false,
            false,
            None,
        );
        assert!(matches!(err, Err(PatchError::Conflict { .. })));
    }

    #[test]
    fn dry_run_does_not_write() {
        let (dir, guard) = fixture();
        let r = super::apply(
            &guard,
            "--- /dev/null\n+++ b/d.txt\n@@ -0,0 +1,1 @@\n+x\n",
            true,
            false,
            None,
        )
        .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(r.created, vec!["d.txt"]);
        assert!(!dir.path().join("d.txt").exists());
    }

    #[test]
    fn whole_file_fallback_is_generated_by_the_control_plane() {
        // The Rust patcher only sees a unified diff; this checks the shape the
        // TypeScript host generates for {file, content}.
        let (dir, guard) = fixture();
        std::fs::write(dir.path().join("e.txt"), "old\n").unwrap_or_else(|e| panic!("{e}"));
        apply(
            &guard,
            "--- a/e.txt\n+++ b/e.txt\n@@ -1,1 +1,2 @@\n-old\n+new\n+second\n",
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("e.txt")).unwrap_or_default(),
            "new\nsecond\n"
        );
    }

    #[test]
    fn renames_fuzzy_matches_no_eol_and_validates_json_and_toml() {
        let (dir, guard) = fixture();
        // 1. Rename (old != new) + fuzzy whitespace match + no newline at EOF.
        assert!(std::fs::write(dir.path().join("old.txt"), "alpha   beta\ngamma\n").is_ok());
        let renamed = apply(
            &guard,
            "diff --git a/old.txt b/sub/new.txt\n--- a/old.txt\n+++ b/sub/new.txt\n@@ -1,2 +1,2 @@\n-alpha beta\n+alpha delta\n gamma\n\\ No newline at end of file\n",
        );
        assert!(!dir.path().join("old.txt").exists());
        assert_eq!(renamed.deleted, vec!["old.txt"]);
        assert_eq!(renamed.created, vec!["sub/new.txt"]);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("sub/new.txt")).unwrap_or_default(),
            "alpha delta\ngamma"
        );

        // 2. Nearest match reported on conflict when first line matches.
        let conflict = super::apply(
            &guard,
            "--- a/sub/new.txt\n+++ b/sub/new.txt\n@@ -1,2 +1,2 @@\n alpha delta\n-wrong_second_line\n+x\n",
            false,
            false,
            None,
        );
        match conflict {
            Err(PatchError::Conflict { nearest, .. }) => assert!(nearest.is_some()),
            other => panic!("expected conflict with nearest match, got {other:?}"),
        }

        // 3. Valid and invalid JSON / TOML validation.
        apply(
            &guard,
            "--- /dev/null\n+++ b/cfg.json\n@@ -0,0 +1,1 @@\n+{\"ok\":true}\n",
        );
        assert!(matches!(
            super::apply(
                &guard,
                "--- a/cfg.json\n+++ b/cfg.json\n@@ -1,1 +1,1 @@\n-{\"ok\":true}\n+{broken\n",
                false,
                false,
                None,
            ),
            Err(PatchError::Invalid { .. })
        ));
        apply(
            &guard,
            "--- /dev/null\n+++ b/cfg.toml\n@@ -0,0 +1,1 @@\n+key = \"val\"\n",
        );
        assert!(matches!(
            super::apply(
                &guard,
                "--- a/cfg.toml\n+++ b/cfg.toml\n@@ -1,1 +1,1 @@\n-key = \"val\"\n+key = [unclosed\n",
                false,
                false,
                None,
            ),
            Err(PatchError::Invalid { .. })
        ));

        // 4. Pure git rename header, blank line in hunk, dry_run delete, and parse errors.
        let pure_ren = apply(
            &guard,
            "diff --git a/cfg.toml b/cfg2.toml\nrename from cfg.toml\nrename to cfg2.toml\n",
        );
        assert_eq!(pure_ren.created, vec!["cfg2.toml"]);
        assert_eq!(pure_ren.deleted, vec!["cfg.toml"]);
        let Ok(dry_del) = super::apply(
            &guard,
            "--- a/cfg2.toml\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-key = \"val\"\n",
            true,
            false,
            None,
        ) else {
            panic!("dry_run delete failed");
        };
        assert_eq!(dry_del.deleted, vec!["cfg2.toml"]);
        assert!(dir.path().join("cfg2.toml").exists());
        assert!(matches!(
            super::apply(&guard, "not a patch at all", false, false, None),
            Err(PatchError::Parse(_))
        ));
    }
}
