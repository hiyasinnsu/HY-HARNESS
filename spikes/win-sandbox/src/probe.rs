//! Patcher impersonation probe (design §4.4; spike item S-6).
//!
//! Runs file operations on a thread that impersonates the `workspace-write`
//! token, the way the patcher would, and checks that the OS — not the path
//! checks — stops writes that escape the workspace, including through a
//! junction that another thread flips between a real directory and a link to
//! the outside while the writes run.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

use serde_json::json;
use windows_sys::Win32::Foundation::{GENERIC_WRITE, HANDLE};
use windows_sys::Win32::Security::RevertToSelf;
use windows_sys::Win32::Storage::FileSystem::{
    CREATE_ALWAYS, CreateFileW, FILE_ATTRIBUTE_NORMAL, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    REPLACEFILE_WRITE_THROUGH, ReplaceFileW, WriteFile,
};
use windows_sys::Win32::System::Threading::SetThreadToken;

use crate::sid;
use crate::token;
use crate::util::{OwnedHandle, Result, SandboxError, check, wide};
use crate::{Args, Mode, canonical};

fn write_file(path: &Path, data: &[u8]) -> Result<()> {
    let w = wide(path);
    let h = OwnedHandle::new(
        unsafe {
            CreateFileW(w.as_ptr(), GENERIC_WRITE, 0, std::ptr::null(), CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, std::ptr::null_mut())
        },
        "CreateFileW",
    )?;
    let mut n = 0u32;
    check(unsafe { WriteFile(h.raw(), data.as_ptr(), data.len() as u32, &mut n, std::ptr::null_mut()) }, "WriteFile")
}

fn replace_file(target: &Path, replacement: &Path) -> Result<()> {
    let (t, r) = (wide(target), wide(replacement));
    check(
        unsafe {
            ReplaceFileW(t.as_ptr(), r.as_ptr(), std::ptr::null(), REPLACEFILE_WRITE_THROUGH, std::ptr::null(), std::ptr::null())
        },
        "ReplaceFileW",
    )
}

fn move_file(from: &Path, to: &Path) -> Result<()> {
    let (f, t) = (wide(from), wide(to));
    check(unsafe { MoveFileExW(f.as_ptr(), t.as_ptr(), MOVEFILE_WRITE_THROUGH | MOVEFILE_REPLACE_EXISTING) }, "MoveFileExW")
}

/// Runs `f` on a fresh thread impersonating `imp` (or not, when `None`).
fn on_thread<T: Send + 'static>(imp: Option<usize>, f: impl FnOnce() -> T + Send + 'static) -> Result<T> {
    std::thread::spawn(move || -> Result<T> {
        if let Some(h) = imp {
            check(unsafe { SetThreadToken(std::ptr::null(), h as HANDLE) }, "SetThreadToken")?;
        }
        let r = f();
        if imp.is_some() {
            unsafe { RevertToSelf() };
        }
        Ok(r)
    })
    .join()
    .map_err(|_| SandboxError::Other("probe thread panicked".into()))?
}

fn res(r: Result<()>) -> serde_json::Value {
    match r {
        Ok(()) => json!("ok"),
        Err(e) => json!(format!("denied/failed: {e}")),
    }
}

fn mklink_junction(link: &Path, target: &Path) -> bool {
    Command::new("cmd")
        .args(["/d", "/c", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Removes the junction itself (never its target's contents) or the real directory.
fn remove_race_dir(race: &Path) {
    match std::fs::symlink_metadata(race) {
        Ok(m) if m.file_type().is_symlink() => {
            let _ = std::fs::remove_dir(race);
        }
        Ok(m) if m.is_dir() => {
            let _ = std::fs::remove_dir_all(race);
        }
        _ => {}
    }
}

pub fn probe_cmd(a: &Args) -> Result<serde_json::Value> {
    let ws = canonical(a.req("workspace")?)?;
    let outside = canonical(a.req("outside")?)?;
    let iterations: usize = a.get("iterations").and_then(|v| v.parse().ok()).unwrap_or(200);
    let ws_sid = sid::workspace_sid(&ws.to_string_lossy())?;
    let confined = token::create_confined(Mode::WorkspaceWrite, Some(&ws_sid), None)?;
    let imp = token::impersonation_copy(&confined)?;
    let imp_raw = imp.raw() as usize;

    let mut results = serde_json::Map::new();
    let p = |n: &str| ws.join(n);

    // a/b: plain write inside and outside.
    let (i1, o1) = (p("s6_inside.txt"), outside.join("s6_outside.txt"));
    results.insert("writeInside".into(), res(on_thread(Some(imp_raw), move || write_file(&i1, b"in"))?));
    results.insert("writeOutside".into(), res(on_thread(Some(imp_raw), move || write_file(&o1, b"out"))?));

    // c: write through a static junction to the outside.
    let junc = p("s6_junction");
    let _ = std::fs::remove_dir(&junc);
    let made = mklink_junction(&junc, &outside);
    let jf = junc.join("s6_via_junction.txt");
    let jf2 = jf.clone();
    results.insert("junctionCreated".into(), json!(made));
    results.insert("writeThroughJunction".into(), res(on_thread(Some(imp_raw), move || write_file(&jf, b"j"))?));
    results.insert("writeThroughJunctionUnimpersonated".into(), res(on_thread(None, move || write_file(&jf2, b"j"))?));
    let _ = std::fs::remove_file(outside.join("s6_via_junction.txt"));
    let _ = std::fs::remove_dir(&junc);

    // d/e: the patcher's temp-file + ReplaceFileW / MoveFileExW swap.
    let target = p("s6_target.txt");
    std::fs::write(&target, b"old").map_err(|e| SandboxError::Other(e.to_string()))?;
    let (t1, tmp1) = (target.clone(), p("s6_target.tmp"));
    results.insert(
        "replaceFileInside".into(),
        res(on_thread(Some(imp_raw), move || {
            write_file(&tmp1, b"new")?;
            replace_file(&t1, &tmp1)
        })?),
    );
    let (tmp2, newf) = (p("s6_new.tmp"), p("s6_new.txt"));
    results.insert(
        "moveFileNewInside".into(),
        res(on_thread(Some(imp_raw), move || {
            write_file(&tmp2, b"new")?;
            move_file(&tmp2, &newf)
        })?),
    );

    // f: hard link to an outside file (created before the grant, so the walker skipped it).
    if let Some(hl) = a.get("hardlink") {
        let hl = PathBuf::from(hl);
        let hl1 = hl.clone();
        let tmp3 = p("s6_hl.tmp");
        results.insert("writeHardLinkInPlace".into(), res(on_thread(Some(imp_raw), move || write_file(&hl1, b"evil"))?));
        results.insert(
            "replaceHardLink".into(),
            res(on_thread(Some(imp_raw), move || {
                write_file(&tmp3, b"evil")?;
                replace_file(&hl, &tmp3)
            })?),
        );
    }

    // g: race — flip ws\s6_race between a real directory and a junction to the outside.
    let race = p("s6_race");
    // The writer keeps writing until the flipper has made `iterations` flips, so
    // every junction/directory state is hit many times.
    let stop = Arc::new(AtomicBool::new(false));
    let flips = Arc::new(AtomicU32::new(0));
    let flipper = {
        let (race, outside, stop, flips) = (race.clone(), outside.clone(), stop.clone(), flips.clone());
        std::thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                remove_race_dir(&race);
                if flips.load(Ordering::Relaxed) % 2 == 0 {
                    let _ = mklink_junction(&race, &outside);
                } else {
                    let _ = std::fs::create_dir(&race);
                }
                flips.fetch_add(1, Ordering::Relaxed);
            }
        })
    };
    let (race_w, flips_w) = (race.clone(), flips.clone());
    let (ok_writes, failed_writes) = on_thread(Some(imp_raw), move || {
        let (mut ok, mut failed) = (0u32, 0u32);
        let mut i = 0u64;
        while (flips_w.load(Ordering::Relaxed) as usize) < iterations {
            match write_file(&race_w.join(format!("s6_race_{i}.txt")), b"r") {
                Ok(()) => ok += 1,
                Err(_) => failed += 1,
            }
            i += 1;
        }
        (ok, failed)
    })?;
    stop.store(true, Ordering::Relaxed);
    let _ = flipper.join();
    let flips = flips.load(Ordering::Relaxed);
    let escaped: Vec<String> = std::fs::read_dir(&outside)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|n| n.starts_with("s6_race_"))
                .collect()
        })
        .unwrap_or_default();
    remove_race_dir(&race);
    results.insert(
        "race".into(),
        json!({"iterations": iterations, "flips": flips, "writesOk": ok_writes, "writesFailed": failed_writes,
               "filesEscapedOutside": escaped.len()}),
    );

    Ok(json!({"workspace": ws, "outside": outside, "results": results}))
}
