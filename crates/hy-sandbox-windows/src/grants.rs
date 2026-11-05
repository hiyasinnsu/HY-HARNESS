//! Granting writable roots to a capability SID (design §4.2 items 2, 3, 8;
//! ADR 0001 S-1, S-3, E).
//!
//! `grant` applies explicit ACEs once to every existing object under a root,
//! through `SetKernelObjectSecurity` on a handle (no inheritance propagation):
//! * allow `FILE_ALL_ACCESS` for the capability SID (inheritable on directories),
//! * deny `FILE_DELETE_CHILD` for Everyone on directories (container-inherit),
//! * a Low no-write-up mandatory label (inheritable on directories).
//!
//! It never traverses or modifies reparse points, skips files whose link count
//! is above 1 (hard links shared with outside paths stay ungranted), and does
//! not descend into the protected top-level directories (`.git`, `.hy-harness`),
//! which get an inheritable deny-write ACE for the SID instead. The original
//! DACL + label of each changed object is recorded as SDDL.
//!
//! `revoke` restores the recorded objects and then walks the whole tree,
//! stripping every ACE that names the SID (and the label and deny ACE that came
//! with it) from objects created after the grant, which the record cannot know.

use std::io::{BufRead, Write as _};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

use windows_sys::Win32::Foundation::{ERROR_NO_MORE_FILES, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Security::Authorization::{
    ConvertSecurityDescriptorToStringSecurityDescriptorW,
    ConvertStringSecurityDescriptorToSecurityDescriptorW, DENY_ACCESS, EXPLICIT_ACCESS_W,
    GRANT_ACCESS, GetSecurityInfo, NO_MULTIPLE_TRUSTEE, SDDL_REVISION_1, SE_FILE_OBJECT,
    SetEntriesInAclW, TRUSTEE_IS_SID, TRUSTEE_IS_UNKNOWN, TRUSTEE_W,
};
use windows_sys::Win32::Security::{
    ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, ACL_REVISION, AddAce, CONTAINER_INHERIT_ACE,
    DACL_SECURITY_INFORMATION, EqualSid, GetAce, GetSecurityDescriptorControl,
    GetSecurityDescriptorDacl, GetSecurityDescriptorSacl, InitializeAcl,
    InitializeSecurityDescriptor, LABEL_SECURITY_INFORMATION, NO_INHERITANCE, PSECURITY_DESCRIPTOR,
    PSID, SE_DACL_AUTO_INHERIT_REQ, SE_DACL_AUTO_INHERITED, SE_DACL_PROTECTED, SECURITY_DESCRIPTOR,
    SUB_CONTAINERS_AND_OBJECTS_INHERIT, SetKernelObjectSecurity, SetSecurityDescriptorControl,
    SetSecurityDescriptorDacl, SetSecurityDescriptorSacl,
};
use windows_sys::Win32::Storage::FileSystem::{
    BY_HANDLE_FILE_INFORMATION, CreateFileW, DELETE, FILE_ALL_ACCESS, FILE_APPEND_DATA,
    FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_DELETE_CHILD,
    FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE, FILE_SHARE_READ,
    FILE_SHARE_WRITE, FILE_WRITE_ATTRIBUTES, FILE_WRITE_DATA, FILE_WRITE_EA,
    FIND_FIRST_EX_LARGE_FETCH, FindClose, FindExInfoBasic, FindExSearchNameMatch, FindFirstFileExW,
    FindNextFileW, GetFileInformationByHandle, OPEN_EXISTING, READ_CONTROL, WIN32_FIND_DATAW,
    WRITE_DAC, WRITE_OWNER,
};
use windows_sys::Win32::System::SystemServices::{
    ACCESS_ALLOWED_ACE_TYPE, ACCESS_DENIED_ACE_TYPE, SECURITY_DESCRIPTOR_REVISION,
};

use crate::sid::{self, Sid};
use crate::util::{
    LocalBox, OwnedHandle, Result, SandboxError, check, check_status, from_wide_ptr, wide,
};

/// Top-level directories the walker never enters; they get a deny ACE instead.
pub const PROTECTED: [&str; 2] = [".git", ".hy-harness"];
/// Write-related rights denied by the `.git` guard and by `readOnly` carve-outs.
pub(crate) const DENY_WRITE_MASK: u32 = FILE_WRITE_DATA
    | FILE_APPEND_DATA
    | FILE_WRITE_EA
    | FILE_WRITE_ATTRIBUTES
    | DELETE
    | FILE_DELETE_CHILD
    | WRITE_DAC
    | WRITE_OWNER;
const SI: u32 = DACL_SECURITY_INFORMATION | LABEL_SECURITY_INFORMATION;

#[derive(Debug, Clone, Default)]
pub struct GrantReport {
    pub objects: u64,
    pub objects_changed: u64,
    pub skipped_hard_links: u64,
    pub skipped_reparse_points: u64,
    pub failed: u64,
    pub first_failure: Option<String>,
    pub protected: Vec<PathBuf>,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Default)]
pub struct RevokeReport {
    pub restored: u64,
    pub stripped: u64,
    pub failed: u64,
    pub first_failure: Option<String>,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Copy)]
pub struct GrantOptions {
    pub threads: usize,
    /// Treat `.git` / `.hy-harness` at the root as protected (workspaces only).
    pub protect_top: bool,
}

impl Default for GrantOptions {
    fn default() -> Self {
        Self {
            threads: 8,
            protect_top: true,
        }
    }
}

struct Entry {
    path: PathBuf,
    is_dir: bool,
}

#[derive(Default)]
struct Enumerated {
    objects: Vec<Entry>,
    protected: Vec<PathBuf>,
    reparse: u64,
}

fn enumerate(root: &Path, protect_top: bool) -> Result<Enumerated> {
    let mut out = Enumerated::default();
    out.objects.push(Entry {
        path: root.to_path_buf(),
        is_dir: true,
    });
    let mut queue = vec![root.to_path_buf()];
    while let Some(dir) = queue.pop() {
        let pattern = wide(dir.join("*"));
        // SAFETY: plain-old-data output buffer.
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
                    out.reparse += 1;
                } else if attrs & FILE_ATTRIBUTE_DIRECTORY != 0 {
                    if protect_top
                        && dir == root
                        && PROTECTED.iter().any(|n| n.eq_ignore_ascii_case(&name))
                    {
                        out.protected.push(p);
                    } else {
                        out.objects.push(Entry {
                            path: p.clone(),
                            is_dir: true,
                        });
                        queue.push(p);
                    }
                } else {
                    out.objects.push(Entry {
                        path: p,
                        is_dir: false,
                    });
                }
            }
            // SAFETY: valid find handle.
            if unsafe { FindNextFileW(h, &mut data) } == 0 {
                let err = SandboxError::last("FindNextFileW");
                // SAFETY: valid find handle, closed once.
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
    // SAFETY: valid path; the handle is owned by the returned value.
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
    // SAFETY: plain-old-data output buffer.
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: valid handle and buffer.
    check(
        unsafe { GetFileInformationByHandle(h, &mut info) },
        "GetFileInformationByHandle",
    )?;
    Ok(info.nNumberOfLinks)
}

/// The object's current DACL + label: the owning SD buffer and pointers into it.
pub(crate) struct CurrentSd {
    pub sd: LocalBox,
    pub dacl: *mut ACL,
    pub sacl: *mut ACL,
    pub control: u16,
}

pub(crate) fn current_sd(h: HANDLE) -> Result<CurrentSd> {
    let mut dacl: *mut ACL = std::ptr::null_mut();
    let mut sacl: *mut ACL = std::ptr::null_mut();
    let mut psd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    // SAFETY: outputs are freed through LocalBox.
    check_status(
        unsafe {
            GetSecurityInfo(
                h,
                SE_FILE_OBJECT,
                SI,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut dacl,
                &mut sacl,
                &mut psd,
            )
        },
        "GetSecurityInfo",
    )?;
    let sd = LocalBox(psd);
    let mut control = 0u16;
    let mut rev = 0u32;
    // SAFETY: psd is a valid SD.
    check(
        unsafe { GetSecurityDescriptorControl(psd, &mut control, &mut rev) },
        "GetSecurityDescriptorControl",
    )?;
    Ok(CurrentSd {
        sd,
        dacl,
        sacl,
        control,
    })
}

pub(crate) fn current_sd_of(path: &Path) -> Result<CurrentSd> {
    let w = wide(path);
    // SAFETY: valid path; READ_CONTROL only.
    let h = unsafe {
        CreateFileW(
            w.as_ptr(),
            READ_CONTROL,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            std::ptr::null_mut(),
        )
    };
    let h = OwnedHandle::new(h, "CreateFileW")?;
    current_sd(h.raw())
}

fn sd_to_sddl(psd: PSECURITY_DESCRIPTOR) -> Result<String> {
    let mut out: *mut u16 = std::ptr::null_mut();
    // SAFETY: valid SD; output freed through LocalBox.
    check(
        unsafe {
            ConvertSecurityDescriptorToStringSecurityDescriptorW(
                psd,
                SDDL_REVISION_1,
                SI,
                &mut out,
                std::ptr::null_mut(),
            )
        },
        "ConvertSecurityDescriptorToStringSecurityDescriptorW",
    )?;
    let _g = LocalBox(out.cast());
    Ok(from_wide_ptr(out))
}

fn sddl_to_sd(s: &str) -> Result<LocalBox> {
    let w = wide(s);
    let mut psd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    // SAFETY: valid NUL-terminated input; output freed through LocalBox.
    check(
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                w.as_ptr(),
                SDDL_REVISION_1,
                &mut psd,
                std::ptr::null_mut(),
            )
        },
        "ConvertStringSecurityDescriptorToSecurityDescriptorW",
    )?;
    Ok(LocalBox(psd))
}

fn sacl_of(psd: PSECURITY_DESCRIPTOR) -> Result<*mut ACL> {
    let (mut present, mut defaulted) = (0, 0);
    let mut acl: *mut ACL = std::ptr::null_mut();
    // SAFETY: valid SD.
    check(
        unsafe { GetSecurityDescriptorSacl(psd, &mut present, &mut acl, &mut defaulted) },
        "GetSecurityDescriptorSacl",
    )?;
    Ok(if present != 0 {
        acl
    } else {
        std::ptr::null_mut()
    })
}

fn dacl_of(psd: PSECURITY_DESCRIPTOR) -> Result<*mut ACL> {
    let (mut present, mut defaulted) = (0, 0);
    let mut acl: *mut ACL = std::ptr::null_mut();
    // SAFETY: valid SD.
    check(
        unsafe { GetSecurityDescriptorDacl(psd, &mut present, &mut acl, &mut defaulted) },
        "GetSecurityDescriptorDacl",
    )?;
    Ok(acl)
}

/// Writes DACL + label through an absolute SD (no inheritance propagation).
fn set_dacl_and_label(h: HANDLE, dacl: *mut ACL, sacl: *mut ACL, control: u16) -> Result<()> {
    // SAFETY: plain-old-data; initialized below.
    let mut sd: SECURITY_DESCRIPTOR = unsafe { std::mem::zeroed() };
    let psd: PSECURITY_DESCRIPTOR = (&mut sd as *mut SECURITY_DESCRIPTOR).cast();
    // SAFETY: psd points to a SECURITY_DESCRIPTOR-sized buffer.
    check(
        unsafe { InitializeSecurityDescriptor(psd, SECURITY_DESCRIPTOR_REVISION) },
        "InitializeSecurityDescriptor",
    )?;
    // SAFETY: dacl outlives the call.
    check(
        unsafe { SetSecurityDescriptorDacl(psd, 1, dacl, 0) },
        "SetSecurityDescriptorDacl",
    )?;
    // An empty SACL with LABEL_SECURITY_INFORMATION removes the label; the object
    // then reports `S:NO_ACCESS_CONTROL`, which also means "no label".
    let mut empty = [0u64; 2];
    let sacl = if sacl.is_null() {
        let e = empty.as_mut_ptr() as *mut ACL;
        // SAFETY: 16-byte buffer for an empty ACL.
        check(
            unsafe { InitializeAcl(e, 16, ACL_REVISION) },
            "InitializeAcl",
        )?;
        e
    } else {
        sacl
    };
    // SAFETY: sacl outlives the call.
    check(
        unsafe { SetSecurityDescriptorSacl(psd, 1, sacl, 0) },
        "SetSecurityDescriptorSacl",
    )?;
    // The kernel keeps SE_DACL_AUTO_INHERITED only together with SE_DACL_AUTO_INHERIT_REQ.
    let mut want = control & (SE_DACL_AUTO_INHERITED | SE_DACL_PROTECTED);
    if want & SE_DACL_AUTO_INHERITED != 0 {
        want |= SE_DACL_AUTO_INHERIT_REQ;
    }
    let bits = SE_DACL_AUTO_INHERITED | SE_DACL_AUTO_INHERIT_REQ | SE_DACL_PROTECTED;
    // SAFETY: valid absolute SD.
    check(
        unsafe { SetSecurityDescriptorControl(psd, bits, want) },
        "SetSecurityDescriptorControl",
    )?;
    // SAFETY: valid handle opened with WRITE_DAC | WRITE_OWNER.
    check(
        unsafe { SetKernelObjectSecurity(h, SI, psd) },
        "SetKernelObjectSecurity",
    )
}

pub(crate) fn trustee(sid: &Sid) -> TRUSTEE_W {
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
    // SAFETY: entries and old ACL outlive the call; output freed through LocalBox.
    check_status(
        unsafe { SetEntriesInAclW(entries.len() as u32, entries.as_ptr(), old, &mut new_acl) },
        "SetEntriesInAclW",
    )?;
    Ok(LocalBox(new_acl.cast()))
}

/// Merges `entries` into the DACL of one object, keeping its label.
pub(crate) fn merge_into(path: &Path, entries: &[EXPLICIT_ACCESS_W]) -> Result<()> {
    let h = open_for_security(path)?;
    let cur = current_sd(h.raw())?;
    let new_dacl = merge_dacl(cur.dacl, entries)?;
    set_dacl_and_label(h.raw(), new_dacl.0.cast(), cur.sacl, cur.control)
}

/// Result of [`add_deny_ace_tree`]: one undo snapshot per changed object.
#[derive(Debug, Default)]
pub(crate) struct DenyTree {
    /// `(path, previous SDDL)` for every object that now carries the ACE.
    pub snapshots: Vec<(PathBuf, String)>,
    pub failed: u64,
    pub first_failure: Option<String>,
}

/// Adds the deny ACE for `sid` to `root` **and every existing object below it**
/// (CP-02 `denyRead` / `readOnly`). The user's own token is unaffected because
/// the SID exists only in the restricted token.
///
/// The DACL is written through `SetKernelObjectSecurity`, which does not
/// propagate inheritable ACEs to children that already exist: a deny on a
/// directory alone only covers objects created later. Existing files keep their
/// own DACLs (after `grant`, an explicit allow for the workspace SID), so each
/// one gets the ACE explicitly. Reparse points are not followed, as in `grant`.
pub(crate) fn add_deny_ace_tree(
    root: &Path,
    sid: &Sid,
    mask: u32,
    no_read_up: bool,
) -> Result<DenyTree> {
    // CP-02 `denyRead`: the confined token is WRITE_RESTRICTED, so its
    // restricting SIDs (the workspace SID among them) are checked for writes
    // only and a deny-read ACE alone never stops a read. Every confined mode
    // runs at Low integrity, so a Medium label with NO_READ_UP does: the
    // mandatory check refuses the read before the DACL is consulted, and the
    // user's Medium token is unaffected.
    let labels = if no_read_up {
        Some(Labels::medium_no_read_up()?)
    } else {
        None
    };
    let entries = if root.is_dir() {
        enumerate(root, false)?.objects
    } else {
        vec![Entry {
            path: root.to_path_buf(),
            is_dir: false,
        }]
    };
    let mut out = DenyTree::default();
    for e in entries {
        let r = (|| -> Result<String> {
            let h = open_for_security(&e.path)?;
            let cur = current_sd(h.raw())?;
            let sddl = sd_to_sddl(cur.sd.0)?;
            let ace = [EXPLICIT_ACCESS_W {
                grfAccessPermissions: mask,
                grfAccessMode: DENY_ACCESS,
                grfInheritance: if e.is_dir {
                    SUB_CONTAINERS_AND_OBJECTS_INHERIT
                } else {
                    NO_INHERITANCE
                },
                Trustee: trustee(sid),
            }];
            let new_dacl = merge_dacl(cur.dacl, &ace)?;
            let sacl = match &labels {
                Some(l) if e.is_dir => l.dir,
                Some(l) => l.file,
                None => cur.sacl,
            };
            set_dacl_and_label(h.raw(), new_dacl.0.cast(), sacl, cur.control)?;
            Ok(sddl)
        })();
        match r {
            Ok(sddl) => out.snapshots.push((e.path, sddl)),
            Err(err) => {
                out.failed += 1;
                out.first_failure
                    .get_or_insert_with(|| format!("{}: {err}", e.path.display()));
            }
        }
    }
    Ok(out)
}

/// SDDL of `path` (DACL and label), for tests and diagnostics.
#[cfg(test)]
pub(crate) fn sddl_of(path: &Path) -> Result<String> {
    sd_to_sddl(current_sd_of(path)?.sd.0)
}

/// True when `path`'s DACL names `sid` in a deny ACE.
pub(crate) fn has_deny_ace_for(path: &Path, sid: &Sid) -> Result<bool> {
    let cur = current_sd_of(path)?;
    for ace in aces(cur.dacl) {
        // SAFETY: ACE pointers come from the DACL and are valid.
        let header = unsafe { *ace };
        if header.AceType != ACCESS_DENIED_ACE_TYPE as u8 {
            continue;
        }
        // SAFETY: both SIDs are valid.
        if ace_sid(ace).is_some_and(|(psid, _, _)| unsafe { EqualSid(psid, sid.as_psid()) } != 0) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Restores every object recorded in `record` and removes the file.
/// Used for the deny-read record, which has no root to walk.
pub fn restore(record: &Path) -> Result<RevokeReport> {
    let t0 = Instant::now();
    let mut report = RevokeReport::default();
    restore_record(record, &mut report)?;
    if report.failed == 0 {
        let _ = std::fs::remove_file(record);
    }
    report.duration_ms = t0.elapsed().as_millis() as u64;
    Ok(report)
}

/// Label SACLs built once from SDDL; the buffers stay alive for the walk.
struct Labels {
    _dir: LocalBox,
    _file: LocalBox,
    dir: *mut ACL,
    file: *mut ACL,
}
// SAFETY: read-only after construction.
unsafe impl Send for Labels {}
// SAFETY: read-only after construction.
unsafe impl Sync for Labels {}

impl Labels {
    fn low() -> Result<Self> {
        let d = sddl_to_sd("S:(ML;OICI;NW;;;LW)")?;
        let f = sddl_to_sd("S:(ML;;NW;;;LW)")?;
        let dir = sacl_of(d.0)?;
        let file = sacl_of(f.0)?;
        Ok(Self {
            _dir: d,
            _file: f,
            dir,
            file,
        })
    }

    /// Medium label with NO_READ_UP and NO_WRITE_UP (CP-02 `denyRead`).
    fn medium_no_read_up() -> Result<Self> {
        let d = sddl_to_sd("S:(ML;OICI;NRNW;;;ME)")?;
        let f = sddl_to_sd("S:(ML;;NRNW;;;ME)")?;
        let dir = sacl_of(d.0)?;
        let file = sacl_of(f.0)?;
        Ok(Self {
            _dir: d,
            _file: f,
            dir,
            file,
        })
    }
}

enum Outcome {
    Changed { path: PathBuf, sddl: String },
    SkippedLink,
    Failed(String),
}

fn grant_one(e: &Entry, cap: &Sid, everyone: &Sid, labels: &Labels) -> Outcome {
    let r = (|| -> Result<Outcome> {
        let h = open_for_security(&e.path)?;
        if !e.is_dir && link_count(h.raw())? > 1 {
            return Ok(Outcome::SkippedLink);
        }
        let cur = current_sd(h.raw())?;
        let sddl = sd_to_sddl(cur.sd.0)?;
        let mut entries = vec![EXPLICIT_ACCESS_W {
            grfAccessPermissions: FILE_ALL_ACCESS,
            grfAccessMode: GRANT_ACCESS,
            grfInheritance: if e.is_dir {
                SUB_CONTAINERS_AND_OBJECTS_INHERIT
            } else {
                NO_INHERITANCE
            },
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
        set_dacl_and_label(
            h.raw(),
            new_dacl.0.cast(),
            if e.is_dir { labels.dir } else { labels.file },
            cur.control,
        )?;
        Ok(Outcome::Changed {
            path: e.path.clone(),
            sddl,
        })
    })();
    r.unwrap_or_else(|err| Outcome::Failed(format!("{}: {err}", e.path.display())))
}

fn protect_one(path: &Path, cap: &Sid) -> Result<String> {
    let h = open_for_security(path)?;
    let cur = current_sd(h.raw())?;
    let sddl = sd_to_sddl(cur.sd.0)?;
    let entries = [EXPLICIT_ACCESS_W {
        grfAccessPermissions: DENY_WRITE_MASK,
        grfAccessMode: DENY_ACCESS,
        grfInheritance: SUB_CONTAINERS_AND_OBJECTS_INHERIT,
        Trustee: trustee(cap),
    }];
    let new_dacl = merge_dacl(cur.dacl, &entries)?;
    // The protected directory keeps its own label (normally none, i.e. Medium).
    set_dacl_and_label(h.raw(), new_dacl.0.cast(), cur.sacl, cur.control)?;
    Ok(sddl)
}

/// Grants `root` to `cap` and writes the undo record to `record`.
pub fn grant(root: &Path, cap: &Sid, record: &Path, opts: GrantOptions) -> Result<GrantReport> {
    let t0 = Instant::now();
    let everyone = Sid::parse(sid::EVERYONE)?;
    let labels = Labels::low()?;
    let en = enumerate(root, opts.protect_top)?;

    let next = AtomicUsize::new(0);
    let results: Mutex<Vec<Outcome>> = Mutex::new(Vec::with_capacity(en.objects.len()));
    std::thread::scope(|s| {
        for _ in 0..opts.threads.max(1) {
            s.spawn(|| {
                let mut local = Vec::new();
                loop {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    let Some(e) = en.objects.get(i) else { break };
                    local.push(grant_one(e, cap, &everyone, &labels));
                }
                if let Ok(mut r) = results.lock() {
                    r.extend(local);
                }
            });
        }
    });
    let results = results
        .into_inner()
        .map_err(|_| SandboxError::Other("grant worker panicked".into()))?;

    let mut report = GrantReport {
        objects: en.objects.len() as u64,
        skipped_reparse_points: en.reparse,
        ..GrantReport::default()
    };
    let mut lines = Vec::new();
    for p in &en.protected {
        match protect_one(p, cap) {
            Ok(sddl) => {
                lines.push(serde_json::json!({"path": p, "sddl": sddl}));
                report.protected.push(p.clone());
            }
            Err(e) => {
                report.failed += 1;
                report
                    .first_failure
                    .get_or_insert(format!("{}: {e}", p.display()));
            }
        }
    }
    for r in results {
        match r {
            Outcome::Changed { path, sddl } => {
                report.objects_changed += 1;
                lines.push(serde_json::json!({"path": path, "sddl": sddl}));
            }
            Outcome::SkippedLink => report.skipped_hard_links += 1,
            Outcome::Failed(m) => {
                report.failed += 1;
                report.first_failure.get_or_insert(m);
            }
        }
    }

    if let Some(dir) = record.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| SandboxError::Other(format!("create {}: {e}", dir.display())))?;
    }
    let header = serde_json::json!({"root": root, "sid": cap.to_string_sid()?});
    let mut buf = format!("{header}\n");
    for l in &lines {
        buf.push_str(&l.to_string());
        buf.push('\n');
    }
    // Append: a re-grant of an already-granted root must not lose the first,
    // pre-grant snapshots (revoke applies the first record per path).
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(record)
        .map_err(|e| SandboxError::Other(format!("open {}: {e}", record.display())))?;
    f.write_all(buf.as_bytes())
        .map_err(|e| SandboxError::Other(format!("write {}: {e}", record.display())))?;
    report.duration_ms = t0.elapsed().as_millis() as u64;
    Ok(report)
}

/// Iterates the ACEs of an ACL as (header, ace pointer).
fn aces(acl: *mut ACL) -> Vec<*mut ACE_HEADER> {
    let mut out = Vec::new();
    if acl.is_null() {
        return out;
    }
    // SAFETY: acl is a valid ACL from GetSecurityInfo.
    let count = unsafe { (*acl).AceCount } as u32;
    for i in 0..count {
        let mut p: *mut core::ffi::c_void = std::ptr::null_mut();
        // SAFETY: index below AceCount.
        if unsafe { GetAce(acl, i, &mut p) } != 0 {
            out.push(p.cast());
        }
    }
    out
}

/// The SID of an allow/deny ACE (both share the ACCESS_ALLOWED_ACE layout).
fn ace_sid(ace: *mut ACE_HEADER) -> Option<(PSID, u8, u32)> {
    // SAFETY: valid ACE pointer from GetAce.
    let t = unsafe { (*ace).AceType };
    if t != ACCESS_ALLOWED_ACE_TYPE as u8 && t != ACCESS_DENIED_ACE_TYPE as u8 {
        return None;
    }
    let a = ace as *mut ACCESS_ALLOWED_ACE;
    // SAFETY: allow and deny ACEs have the same layout; SidStart begins the SID.
    unsafe { Some((std::ptr::addr_of_mut!((*a).SidStart).cast(), t, (*a).Mask)) }
}

/// True when the ACL has an ACE naming `sid`.
pub(crate) fn acl_names_sid(acl: *mut ACL, sid: &Sid) -> bool {
    aces(acl).into_iter().any(|a| {
        // SAFETY: both SIDs are valid.
        ace_sid(a).is_some_and(|(p, _, _)| unsafe { EqualSid(p, sid.as_psid()) } != 0)
    })
}

/// True when the ACL has an allow ACE naming `sid`.
pub(crate) fn acl_allows_sid(acl: *mut ACL, sid: &Sid) -> bool {
    aces(acl).into_iter().any(|a| {
        // SAFETY: both SIDs are valid.
        ace_sid(a).is_some_and(|(p, t, _)| {
            t == ACCESS_ALLOWED_ACE_TYPE as u8 && unsafe { EqualSid(p, sid.as_psid()) } != 0
        })
    })
}

/// True when the label SACL holds a Low mandatory label.
pub(crate) fn has_low_label(sacl: *mut ACL) -> Result<bool> {
    let low = Sid::parse(sid::LOW_INTEGRITY)?;
    Ok(aces(sacl).into_iter().any(|a| {
        // SAFETY: SYSTEM_MANDATORY_LABEL_ACE has the same layout as ACCESS_ALLOWED_ACE.
        let p = unsafe { std::ptr::addr_of_mut!((*(a as *mut ACCESS_ALLOWED_ACE)).SidStart) };
        // SAFETY: both SIDs are valid.
        unsafe { EqualSid(p.cast(), low.as_psid()) != 0 }
    }))
}

/// Copies `acl` without the ACEs naming `cap` and without the Everyone
/// deny-`FILE_DELETE_CHILD` ACE the grant added. Returns None when nothing changes.
fn strip_acl(acl: *mut ACL, cap: &Sid, everyone: &Sid) -> Result<Option<Vec<u64>>> {
    let all = aces(acl);
    let keep: Vec<*mut ACE_HEADER> = all
        .iter()
        .copied()
        .filter(|&a| match ace_sid(a) {
            // SAFETY: both SIDs are valid.
            Some((p, _, _)) if unsafe { EqualSid(p, cap.as_psid()) } != 0 => false,
            Some((p, t, mask))
                if t == ACCESS_DENIED_ACE_TYPE as u8
                    && mask == FILE_DELETE_CHILD
                    // SAFETY: both SIDs are valid.
                    && unsafe { EqualSid(p, everyone.as_psid()) } != 0 =>
            {
                false
            }
            _ => true,
        })
        .collect();
    if keep.len() == all.len() {
        return Ok(None);
    }
    // SAFETY: acl is valid.
    let size = unsafe { (*acl).AclSize } as u32;
    let mut buf = vec![0u64; (size as usize).div_ceil(8)];
    let new = buf.as_mut_ptr() as *mut ACL;
    // SAFETY: buffer of at least `size` bytes; the stripped ACL is never larger.
    check(
        unsafe { InitializeAcl(new, size, ACL_REVISION) },
        "InitializeAcl",
    )?;
    for a in keep {
        // SAFETY: valid ACE; AceSize covers the whole ACE.
        let len = unsafe { (*a).AceSize } as u32;
        // SAFETY: appends one ACE at the end of `new`.
        check(
            unsafe { AddAce(new, ACL_REVISION, u32::MAX, a.cast(), len) },
            "AddAce",
        )?;
    }
    Ok(Some(buf))
}

/// Removes every trace of `cap` from one object. Returns true when it changed.
fn strip_one(path: &Path, cap: &Sid, everyone: &Sid) -> Result<bool> {
    let h = open_for_security(path)?;
    let cur = current_sd(h.raw())?;
    if !acl_names_sid(cur.dacl, cap) {
        return Ok(false);
    }
    let Some(mut dacl) = strip_acl(cur.dacl, cap, everyone)? else {
        return Ok(false);
    };
    // The Low label came with the grant (directly or by inheritance).
    let sacl = if has_low_label(cur.sacl)? {
        std::ptr::null_mut()
    } else {
        cur.sacl
    };
    set_dacl_and_label(h.raw(), dacl.as_mut_ptr().cast(), sacl, cur.control)?;
    Ok(true)
}

fn restore_record(record: &Path, report: &mut RevokeReport) -> Result<()> {
    let f = match std::fs::File::open(record) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => {
            return Err(SandboxError::Other(format!(
                "open {}: {e}",
                record.display()
            )));
        }
    };
    let mut seen = std::collections::HashSet::new();
    for line in std::io::BufReader::new(f).lines().map_while(|l| l.ok()) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let (Some(path), Some(sddl)) = (v["path"].as_str(), v["sddl"].as_str()) else {
            continue;
        };
        // The first snapshot of a path is the pre-grant state.
        if !seen.insert(path.to_lowercase()) {
            continue;
        }
        let r = (|| -> Result<()> {
            let h = open_for_security(Path::new(path))?;
            let sd = sddl_to_sd(sddl)?;
            let mut control = 0u16;
            let mut rev = 0u32;
            // SAFETY: valid SD.
            check(
                unsafe { GetSecurityDescriptorControl(sd.0, &mut control, &mut rev) },
                "GetSecurityDescriptorControl",
            )?;
            set_dacl_and_label(h.raw(), dacl_of(sd.0)?, sacl_of(sd.0)?, control)
        })();
        match r {
            Ok(()) => report.restored += 1,
            // Objects deleted since the grant need no restore.
            Err(e) if e.win32_code() == Some(2) || e.win32_code() == Some(3) => {}
            Err(e) => {
                report.failed += 1;
                report.first_failure.get_or_insert(format!("{path}: {e}"));
            }
        }
    }
    Ok(())
}

/// Undoes `grant`: restores the recorded objects, then strips the SID from
/// everything else under `root`, and deletes the record.
pub fn revoke(root: &Path, cap: &Sid, record: &Path) -> Result<RevokeReport> {
    let t0 = Instant::now();
    let mut report = RevokeReport::default();
    restore_record(record, &mut report)?;
    if root.exists() {
        let everyone = Sid::parse(sid::EVERYONE)?;
        let en = enumerate(root, false)?;
        for e in &en.objects {
            match strip_one(&e.path, cap, &everyone) {
                Ok(true) => report.stripped += 1,
                Ok(false) => {}
                Err(err) => {
                    report.failed += 1;
                    report
                        .first_failure
                        .get_or_insert(format!("{}: {err}", e.path.display()));
                }
            }
        }
    }
    if report.failed == 0 {
        let _ = std::fs::remove_file(record);
    }
    report.duration_ms = t0.elapsed().as_millis() as u64;
    Ok(report)
}

/// True when the root itself carries an ACE for `cap` (the grant marker).
pub fn is_granted(root: &Path, cap: &Sid) -> bool {
    current_sd_of(root).is_ok_and(|cur| acl_names_sid(cur.dacl, cap))
}

/// True when `path` grants `cap` or carries a Low label, i.e. a confined
/// process may be able to write it.
pub fn is_sandbox_writable(path: &Path, cap: &Sid) -> Result<bool> {
    let cur = current_sd_of(path)?;
    Ok(acl_allows_sid(cur.dacl, cap) || has_low_label(cur.sacl)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ntfs_tempdir() -> Option<tempfile::TempDir> {
        let base = std::env::var_os("USERPROFILE").map(PathBuf::from)?;
        let dir = tempfile::Builder::new()
            .prefix("hy-grant-test-")
            .tempdir_in(base)
            .ok()?;
        let caps = crate::fs::volume_caps(dir.path()).ok()?;
        caps.persistent_acls.then_some(dir)
    }

    fn sddl(path: &Path) -> String {
        current_sd_of(path)
            .and_then(|c| sd_to_sddl(c.sd.0))
            .unwrap_or_default()
    }

    #[test]
    fn grant_then_revoke_restores_and_strips_late_files() -> Result<()> {
        let Some(dir) = ntfs_tempdir() else {
            return Ok(());
        };
        let root = dir.path().join("ws");
        std::fs::create_dir_all(root.join("sub"))
            .map_err(|e| SandboxError::Other(e.to_string()))?;
        std::fs::create_dir_all(root.join(".git"))
            .map_err(|e| SandboxError::Other(e.to_string()))?;
        std::fs::write(root.join("sub").join("a.txt"), b"a")
            .map_err(|e| SandboxError::Other(e.to_string()))?;
        let before_root = sddl(&root);
        let before_file = sddl(&root.join("sub").join("a.txt"));
        let cap = sid::workspace_sid(&root.to_string_lossy())?;
        let record = dir.path().join("grant.jsonl");

        let g = grant(&root, &cap, &record, GrantOptions::default())?;
        assert_eq!(g.failed, 0, "{:?}", g.first_failure);
        assert_eq!(g.protected.len(), 1);
        assert!(is_granted(&root, &cap));
        assert!(is_sandbox_writable(&root.join("sub").join("a.txt"), &cap)?);
        assert!(!is_sandbox_writable(&root.join(".git"), &cap)?);
        assert!(
            acl_names_sid(current_sd_of(&root.join(".git"))?.dacl, &cap),
            ".git carries the deny ACE"
        );

        // Created after the grant: inherits the ACE and is not in the record.
        std::fs::write(root.join("sub").join("late.txt"), b"l")
            .map_err(|e| SandboxError::Other(e.to_string()))?;
        assert!(is_sandbox_writable(
            &root.join("sub").join("late.txt"),
            &cap
        )?);

        let r = revoke(&root, &cap, &record)?;
        assert_eq!(r.failed, 0, "{:?}", r.first_failure);
        assert!(r.stripped >= 1);
        assert_eq!(
            sddl(&root).trim_end_matches("S:NO_ACCESS_CONTROL"),
            before_root
        );
        assert_eq!(
            sddl(&root.join("sub").join("a.txt")).trim_end_matches("S:NO_ACCESS_CONTROL"),
            before_file
        );
        assert!(!is_sandbox_writable(
            &root.join("sub").join("late.txt"),
            &cap
        )?);
        assert!(!is_granted(&root, &cap));
        Ok(())
    }
}
