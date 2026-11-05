//! Grant walker (design §4.2 items 2, 3, 8; spike items S-1, S-3).
//!
//! Applies explicit ACEs once to every existing object under a granted root,
//! without `SetNamedSecurityInfoW` auto-propagation:
//! * allow `FILE_ALL_ACCESS` for the capability SID (inheritable on directories),
//! * deny `FILE_DELETE_CHILD` for Everyone on directories (container-inherit),
//! * Low no-write-up mandatory label (inheritable on directories).
//!
//! It does not traverse or modify reparse points, does not descend into the
//! protected top-level directories (`.git`, `.hy-harness`), which instead get an
//! inheritable deny-write ACE for the capability SID, and skips files whose link
//! count is above 1. The original DACL + label of each changed object is logged
//! as SDDL so `revoke` can restore it.

use std::io::{BufRead, Write as _};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

use serde_json::json;
use windows_sys::Win32::Foundation::{ERROR_NO_MORE_FILES, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Security::Authorization::{
    ConvertSecurityDescriptorToStringSecurityDescriptorW, ConvertStringSecurityDescriptorToSecurityDescriptorW, DENY_ACCESS,
    EXPLICIT_ACCESS_W, GRANT_ACCESS, GetSecurityInfo, NO_MULTIPLE_TRUSTEE, SDDL_REVISION_1, SE_FILE_OBJECT, SetEntriesInAclW,
    TRUSTEE_IS_SID, TRUSTEE_IS_UNKNOWN, TRUSTEE_W,
};
use windows_sys::Win32::Security::{
    ACL, ACL_REVISION, CONTAINER_INHERIT_ACE, DACL_SECURITY_INFORMATION, GetSecurityDescriptorControl, GetSecurityDescriptorDacl,
    GetSecurityDescriptorSacl, InitializeAcl, InitializeSecurityDescriptor, LABEL_SECURITY_INFORMATION, NO_INHERITANCE,
    PSECURITY_DESCRIPTOR, SE_DACL_AUTO_INHERIT_REQ, SE_DACL_AUTO_INHERITED, SE_DACL_PROTECTED, SECURITY_DESCRIPTOR, SUB_CONTAINERS_AND_OBJECTS_INHERIT,
    SetKernelObjectSecurity, SetSecurityDescriptorControl, SetSecurityDescriptorDacl, SetSecurityDescriptorSacl,
};
use windows_sys::Win32::Storage::FileSystem::{
    BY_HANDLE_FILE_INFORMATION, CreateFileW, DELETE, FILE_ALL_ACCESS, FILE_APPEND_DATA, FILE_ATTRIBUTE_DIRECTORY,
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_DELETE_CHILD, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE,
    FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_WRITE_ATTRIBUTES, FILE_WRITE_DATA, FILE_WRITE_EA, FIND_FIRST_EX_LARGE_FETCH,
    FindClose, FindExInfoBasic, FindExSearchNameMatch, FindFirstFileExW, FindNextFileW, GetFileInformationByHandle, OPEN_EXISTING,
    READ_CONTROL, WIN32_FIND_DATAW, WRITE_DAC, WRITE_OWNER,
};
use windows_sys::Win32::System::SystemServices::SECURITY_DESCRIPTOR_REVISION;

use crate::sid::{self, Sid};
use crate::util::{LocalBox, OwnedHandle, Result, SandboxError, check, check_status, from_wide_ptr, wide};
use crate::{Args, canonical};

const PROTECTED: [&str; 2] = [".git", ".hy-harness"];
const DENY_PROTECTED_MASK: u32 =
    FILE_WRITE_DATA | FILE_APPEND_DATA | FILE_WRITE_EA | FILE_WRITE_ATTRIBUTES | DELETE | FILE_DELETE_CHILD | WRITE_DAC | WRITE_OWNER;
const SI: u32 = DACL_SECURITY_INFORMATION | LABEL_SECURITY_INFORMATION;

struct Entry {
    path: PathBuf,
    is_dir: bool,
}

#[derive(Default)]
struct Enumerated {
    objects: Vec<Entry>,
    protected: Vec<PathBuf>,
    reparse: Vec<PathBuf>,
}

fn enumerate(root: &Path, protect_top: bool) -> Result<Enumerated> {
    let mut out = Enumerated::default();
    out.objects.push(Entry { path: root.to_path_buf(), is_dir: true });
    let mut queue = vec![root.to_path_buf()];
    while let Some(dir) = queue.pop() {
        let pattern = wide(dir.join("*"));
        let mut data: WIN32_FIND_DATAW = unsafe { std::mem::zeroed() };
        // SAFETY: valid pattern and output buffer.
        let h = unsafe {
            FindFirstFileExW(
                pattern.as_ptr(),
                FindExInfoBasic,
                (&mut data as *mut WIN32_FIND_DATAW).cast(),
                FindExSearchNameMatch,
                std::ptr::null(),
                FIND_FIRST_EX_LARGE_FETCH,
            )
        };
        if h == INVALID_HANDLE_VALUE {
            return Err(SandboxError::last("FindFirstFileExW"));
        }
        loop {
            let name = from_wide_ptr(data.cFileName.as_ptr());
            if name != "." && name != ".." {
                let p = dir.join(&name);
                let attrs = data.dwFileAttributes;
                if attrs & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                    out.reparse.push(p);
                } else if attrs & FILE_ATTRIBUTE_DIRECTORY != 0 {
                    if protect_top && dir == root && PROTECTED.iter().any(|n| n.eq_ignore_ascii_case(&name)) {
                        out.protected.push(p);
                    } else {
                        out.objects.push(Entry { path: p.clone(), is_dir: true });
                        queue.push(p);
                    }
                } else {
                    out.objects.push(Entry { path: p, is_dir: false });
                }
            }
            // SAFETY: valid find handle.
            if unsafe { FindNextFileW(h, &mut data) } == 0 {
                let err = SandboxError::last("FindNextFileW");
                unsafe { FindClose(h) };
                if err.win32_code() == Some(ERROR_NO_MORE_FILES) {
                    break;
                }
                return Err(err);
            }
        }
    }
    Ok(out)
}

fn open_for_security(path: &Path) -> Result<OwnedHandle> {
    let w = wide(path);
    // SAFETY: valid path.
    let h = unsafe {
        CreateFileW(
            w.as_ptr(),
            READ_CONTROL | WRITE_DAC | WRITE_OWNER,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            std::ptr::null_mut(),
        )
    };
    OwnedHandle::new(h, "CreateFileW")
}

fn link_count(h: HANDLE) -> Result<u32> {
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    check(unsafe { GetFileInformationByHandle(h, &mut info) }, "GetFileInformationByHandle")?;
    Ok(info.nNumberOfLinks)
}

/// The object's current DACL + label: owning SD buffer, DACL pointer, control bits.
struct CurrentSd {
    sd: LocalBox,
    dacl: *mut ACL,
    control: u16,
}

fn current_sd(h: HANDLE) -> Result<CurrentSd> {
    let mut dacl: *mut ACL = std::ptr::null_mut();
    let mut sacl: *mut ACL = std::ptr::null_mut();
    let mut psd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    // SAFETY: outputs freed via LocalBox.
    check_status(
        unsafe {
            GetSecurityInfo(h, SE_FILE_OBJECT, SI, std::ptr::null_mut(), std::ptr::null_mut(), &mut dacl, &mut sacl, &mut psd)
        },
        "GetSecurityInfo",
    )?;
    let sd = LocalBox(psd);
    let mut control = 0u16;
    let mut rev = 0u32;
    check(unsafe { GetSecurityDescriptorControl(psd, &mut control, &mut rev) }, "GetSecurityDescriptorControl")?;
    Ok(CurrentSd { sd, dacl, control })
}

fn sd_to_sddl(psd: PSECURITY_DESCRIPTOR) -> Result<String> {
    let mut out: *mut u16 = std::ptr::null_mut();
    check(
        unsafe {
            ConvertSecurityDescriptorToStringSecurityDescriptorW(psd, SDDL_REVISION_1, SI, &mut out, std::ptr::null_mut())
        },
        "ConvertSecurityDescriptorToStringSecurityDescriptorW",
    )?;
    let _g = LocalBox(out.cast());
    Ok(from_wide_ptr(out))
}

fn sddl_to_sd(s: &str) -> Result<LocalBox> {
    let w = wide(s);
    let mut psd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    check(
        unsafe { ConvertStringSecurityDescriptorToSecurityDescriptorW(w.as_ptr(), SDDL_REVISION_1, &mut psd, std::ptr::null_mut()) },
        "ConvertStringSecurityDescriptorToSecurityDescriptorW",
    )?;
    Ok(LocalBox(psd))
}

fn sacl_of(psd: PSECURITY_DESCRIPTOR) -> Result<*mut ACL> {
    let mut present = 0;
    let mut acl: *mut ACL = std::ptr::null_mut();
    let mut defaulted = 0;
    check(unsafe { GetSecurityDescriptorSacl(psd, &mut present, &mut acl, &mut defaulted) }, "GetSecurityDescriptorSacl")?;
    Ok(if present != 0 { acl } else { std::ptr::null_mut() })
}

fn dacl_of(psd: PSECURITY_DESCRIPTOR) -> Result<(bool, *mut ACL)> {
    let mut present = 0;
    let mut acl: *mut ACL = std::ptr::null_mut();
    let mut defaulted = 0;
    check(unsafe { GetSecurityDescriptorDacl(psd, &mut present, &mut acl, &mut defaulted) }, "GetSecurityDescriptorDacl")?;
    Ok((present != 0, acl))
}

/// Writes DACL + label through an absolute SD (no inheritance propagation).
fn set_dacl_and_label(h: HANDLE, dacl: *mut ACL, sacl: *mut ACL, control: u16) -> Result<()> {
    let mut sd: SECURITY_DESCRIPTOR = unsafe { std::mem::zeroed() };
    let psd: PSECURITY_DESCRIPTOR = (&mut sd as *mut SECURITY_DESCRIPTOR).cast();
    check(unsafe { InitializeSecurityDescriptor(psd, SECURITY_DESCRIPTOR_REVISION) }, "InitializeSecurityDescriptor")?;
    check(unsafe { SetSecurityDescriptorDacl(psd, 1, dacl, 0) }, "SetSecurityDescriptorDacl")?;
    // An empty SACL with LABEL_SECURITY_INFORMATION removes the label. The object
    // then reports `S:NO_ACCESS_CONTROL` instead of no SACL at all; both mean
    // "no label" (implicit Medium), so revoke compares with that normalized away.
    let mut empty = [0u64; 2];
    let sacl = if sacl.is_null() {
        let e = empty.as_mut_ptr() as *mut ACL;
        check(unsafe { InitializeAcl(e, 16, ACL_REVISION) }, "InitializeAcl")?;
        e
    } else {
        sacl
    };
    check(unsafe { SetSecurityDescriptorSacl(psd, 1, sacl, 0) }, "SetSecurityDescriptorSacl")?;
    // The kernel keeps SE_DACL_AUTO_INHERITED only together with SE_DACL_AUTO_INHERIT_REQ.
    let mut want = control & (SE_DACL_AUTO_INHERITED | SE_DACL_PROTECTED);
    if want & SE_DACL_AUTO_INHERITED != 0 {
        want |= SE_DACL_AUTO_INHERIT_REQ;
    }
    let bits = SE_DACL_AUTO_INHERITED | SE_DACL_AUTO_INHERIT_REQ | SE_DACL_PROTECTED;
    check(unsafe { SetSecurityDescriptorControl(psd, bits, want) }, "SetSecurityDescriptorControl")?;
    check(unsafe { SetKernelObjectSecurity(h, SI, psd) }, "SetKernelObjectSecurity")
}

fn trustee(sid: &Sid) -> TRUSTEE_W {
    TRUSTEE_W {
        pMultipleTrustee: std::ptr::null_mut(),
        MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
        TrusteeForm: TRUSTEE_IS_SID,
        TrusteeType: TRUSTEE_IS_UNKNOWN,
        ptstrName: sid.as_psid().cast(),
    }
}

fn merge_dacl(old: *mut ACL, entries: &[EXPLICIT_ACCESS_W]) -> Result<LocalBox> {
    let mut new_acl: *mut ACL = std::ptr::null_mut();
    check_status(unsafe { SetEntriesInAclW(entries.len() as u32, entries.as_ptr(), old, &mut new_acl) }, "SetEntriesInAclW")?;
    Ok(LocalBox(new_acl.cast()))
}

/// Label SACLs built once from SDDL (the buffers stay alive for the walk).
struct Labels {
    _dir: LocalBox,
    _file: LocalBox,
    dir: *mut ACL,
    file: *mut ACL,
}
// SAFETY: read-only after construction.
unsafe impl Send for Labels {}
unsafe impl Sync for Labels {}

impl Labels {
    fn low() -> Result<Self> {
        let d = sddl_to_sd("S:(ML;OICI;NW;;;LW)")?;
        let f = sddl_to_sd("S:(ML;;NW;;;LW)")?;
        let dir = sacl_of(d.0)?;
        let file = sacl_of(f.0)?;
        Ok(Self { _dir: d, _file: f, dir, file })
    }
}

enum Outcome {
    Changed { path: PathBuf, sddl: String },
    SkippedLink { path: PathBuf, links: u32 },
    Counted,
    Failed { path: PathBuf, err: String },
}

fn apply_one(e: &Entry, cap: &Sid, everyone: &Sid, labels: &Labels, dry_run: bool) -> Outcome {
    let r = (|| -> Result<Outcome> {
        let h = open_for_security(&e.path)?;
        if !e.is_dir {
            let n = link_count(h.raw())?;
            if n > 1 {
                return Ok(Outcome::SkippedLink { path: e.path.clone(), links: n });
            }
        }
        let cur = current_sd(h.raw())?;
        let sddl = sd_to_sddl(cur.sd.0)?;
        if dry_run {
            return Ok(Outcome::Counted);
        }
        let mut entries = vec![EXPLICIT_ACCESS_W {
            grfAccessPermissions: FILE_ALL_ACCESS,
            grfAccessMode: GRANT_ACCESS,
            grfInheritance: if e.is_dir { SUB_CONTAINERS_AND_OBJECTS_INHERIT } else { NO_INHERITANCE },
            Trustee: trustee(cap),
        }];
        if e.is_dir {
            entries.push(EXPLICIT_ACCESS_W {
                grfAccessPermissions: FILE_DELETE_CHILD,
                grfAccessMode: DENY_ACCESS,
                grfInheritance: CONTAINER_INHERIT_ACE,
                Trustee: trustee(everyone),
            });
        }
        let new_dacl = merge_dacl(cur.dacl, &entries)?;
        set_dacl_and_label(h.raw(), new_dacl.0.cast(), if e.is_dir { labels.dir } else { labels.file }, cur.control)?;
        Ok(Outcome::Changed { path: e.path.clone(), sddl })
    })();
    r.unwrap_or_else(|err| Outcome::Failed { path: e.path.clone(), err: err.to_string() })
}

fn protect_one(path: &Path, cap: &Sid) -> Result<String> {
    let h = open_for_security(path)?;
    let cur = current_sd(h.raw())?;
    let sddl = sd_to_sddl(cur.sd.0)?;
    let entries = [EXPLICIT_ACCESS_W {
        grfAccessPermissions: DENY_PROTECTED_MASK,
        grfAccessMode: DENY_ACCESS,
        grfInheritance: SUB_CONTAINERS_AND_OBJECTS_INHERIT,
        Trustee: trustee(cap),
    }];
    let new_dacl = merge_dacl(cur.dacl, &entries)?;
    // Keep the existing label (none, i.e. implicit Medium) on protected dirs.
    let sacl = sacl_of(cur.sd.0)?;
    set_dacl_and_label(h.raw(), new_dacl.0.cast(), sacl, cur.control)?;
    Ok(sddl)
}

fn cap_sid(a: &Args, root: &Path) -> Result<Sid> {
    match a.get("kind").unwrap_or("workspace") {
        "workspace" => sid::workspace_sid(&root.to_string_lossy()),
        "temp" => sid::temp_sid(&root.to_string_lossy()),
        k => Err(SandboxError::Other(format!("unknown --kind {k}"))),
    }
}

pub fn grant_cmd(a: &Args) -> Result<serde_json::Value> {
    let root = canonical(a.req("root")?)?;
    let cap = cap_sid(a, &root)?;
    let everyone = Sid::parse(sid::EVERYONE)?;
    let labels = Labels::low()?;
    let dry_run = a.flag("dry-run");
    let threads: usize = a.get("threads").and_then(|t| t.parse().ok()).unwrap_or(8).max(1);
    let protect_top = a.get("kind").unwrap_or("workspace") == "workspace";

    let t0 = Instant::now();
    let en = enumerate(&root, protect_top)?;
    let enum_ms = t0.elapsed().as_millis();

    let t1 = Instant::now();
    let next = AtomicUsize::new(0);
    let results: Mutex<Vec<Outcome>> = Mutex::new(Vec::with_capacity(en.objects.len()));
    std::thread::scope(|s| {
        for _ in 0..threads {
            s.spawn(|| {
                let mut local = Vec::new();
                loop {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    let Some(e) = en.objects.get(i) else { break };
                    local.push(apply_one(e, &cap, &everyone, &labels, dry_run));
                }
                if let Ok(mut r) = results.lock() {
                    r.extend(local);
                }
            });
        }
    });
    let apply_ms = t1.elapsed().as_millis();
    let results = results.into_inner().map_err(|_| SandboxError::Other("poisoned".into()))?;

    let mut log_lines = Vec::new();
    let mut protected_out = Vec::new();
    if !dry_run {
        for p in &en.protected {
            match protect_one(p, &cap) {
                Ok(sddl) => {
                    log_lines.push(json!({"path": p, "sddl": sddl}));
                    protected_out.push(json!({"path": p, "ok": true}));
                }
                Err(e) => protected_out.push(json!({"path": p, "error": e.to_string()})),
            }
        }
    }

    let (mut changed, mut counted, mut skipped, mut failed) = (0usize, 0usize, Vec::new(), Vec::new());
    for r in results {
        match r {
            Outcome::Changed { path, sddl } => {
                changed += 1;
                log_lines.push(json!({"path": path, "sddl": sddl}));
            }
            Outcome::Counted => counted += 1,
            Outcome::SkippedLink { path, links } => skipped.push(json!({"path": path, "links": links})),
            Outcome::Failed { path, err } => failed.push(json!({"path": path, "error": err})),
        }
    }

    if !dry_run {
        let log = a.req("log")?;
        let mut f = std::fs::File::create(log).map_err(|e| SandboxError::Other(format!("create {log}: {e}")))?;
        let header = json!({"root": root, "sid": cap.to_string_sid()?});
        let mut buf = format!("{header}\n");
        for l in &log_lines {
            buf.push_str(&l.to_string());
            buf.push('\n');
        }
        f.write_all(buf.as_bytes()).map_err(|e| SandboxError::Other(format!("write {log}: {e}")))?;
    }

    let dirs = en.objects.iter().filter(|e| e.is_dir).count();
    Ok(json!({
        "root": root,
        "sid": cap.to_string_sid()?,
        "dryRun": dry_run,
        "threads": threads,
        "objects": en.objects.len(),
        "dirs": dirs,
        "files": en.objects.len() - dirs,
        "changed": changed,
        "counted": counted,
        "skippedHardLinks": skipped.len(),
        "skippedHardLinkSample": skipped.iter().take(5).collect::<Vec<_>>(),
        "skippedReparse": en.reparse,
        "protected": protected_out,
        "failed": failed.len(),
        "failedSample": failed.iter().take(5).collect::<Vec<_>>(),
        "enumerateMs": enum_ms,
        "applyMs": apply_ms,
        "totalMs": t0.elapsed().as_millis(),
    }))
}

/// Restores every logged SD, then audits the tree for leftover ACEs naming the SID.
pub fn revoke_cmd(a: &Args) -> Result<serde_json::Value> {
    let log = a.req("log")?;
    let f = std::fs::File::open(log).map_err(|e| SandboxError::Other(format!("open {log}: {e}")))?;
    let mut lines = std::io::BufReader::new(f).lines();
    let header: serde_json::Value = lines
        .next()
        .and_then(|l| l.ok())
        .and_then(|l| serde_json::from_str(&l).ok())
        .ok_or_else(|| SandboxError::Other("bad log header".into()))?;
    let sid_str = header["sid"].as_str().unwrap_or_default().to_string();
    let root = PathBuf::from(header["root"].as_str().unwrap_or_default());

    let t0 = Instant::now();
    let (mut restored, mut mismatched, mut failed) = (0usize, 0usize, Vec::new());
    for line in lines.map_while(|l| l.ok()) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        let path = PathBuf::from(v["path"].as_str().unwrap_or_default());
        let want = v["sddl"].as_str().unwrap_or_default().to_string();
        let r = (|| -> Result<bool> {
            let h = open_for_security(&path)?;
            let sd = sddl_to_sd(&want)?;
            let (_, dacl) = dacl_of(sd.0)?;
            let sacl = sacl_of(sd.0)?;
            let mut control = 0u16;
            let mut rev = 0u32;
            check(unsafe { GetSecurityDescriptorControl(sd.0, &mut control, &mut rev) }, "GetSecurityDescriptorControl")?;
            set_dacl_and_label(h.raw(), dacl, sacl, control)?;
            let now = sd_to_sddl(current_sd(h.raw())?.sd.0)?;
            Ok(now.trim_end_matches("S:NO_ACCESS_CONTROL") == want)
        })();
        match r {
            Ok(true) => restored += 1,
            Ok(false) => {
                restored += 1;
                mismatched += 1;
            }
            Err(e) => failed.push(json!({"path": path, "error": e.to_string()})),
        }
    }
    let restore_ms = t0.elapsed().as_millis();

    // Audit: objects that still name the capability SID (e.g. files created after
    // the grant, which inherited the ACE and are not in the log).
    let mut leftovers = Vec::new();
    if root.exists() {
        let en = enumerate(&root, false)?;
        for e in en.objects.iter().map(|e| e.path.clone()).chain(en.protected.iter().cloned()) {
            if let Ok(h) = open_for_security(&e)
                && let Ok(cur) = current_sd(h.raw())
                && let Ok(s) = sd_to_sddl(cur.sd.0)
                && s.contains(&sid_str)
            {
                leftovers.push(e);
            }
        }
    }
    Ok(json!({
        "root": root,
        "sid": sid_str,
        "restored": restored,
        "mismatchedAfterRestore": mismatched,
        "failed": failed.len(),
        "failedSample": failed.iter().take(5).collect::<Vec<_>>(),
        "leftoverObjectsNamingSid": leftovers.len(),
        "leftoverSample": leftovers.iter().take(5).collect::<Vec<_>>(),
        "restoreMs": restore_ms,
    }))
}

