//! AppContainer launcher for `hy-ptc-worker` (spike item S-5).
//!
//! Creates a throwaway AppContainer profile with no capabilities, runs the
//! command in it (stdio pipes, Job Object, optional single-process limit),
//! and deletes the profile again unless `--keep` is given.

use std::path::PathBuf;

use serde_json::json;
use windows_sys::Win32::Foundation::ERROR_ALREADY_EXISTS;
use windows_sys::Win32::Security::Isolation::{
    CreateAppContainerProfile, DeleteAppContainerProfile, DeriveAppContainerSidFromAppContainerName,
};
use windows_sys::Win32::Security::{FreeSid, PSID, SECURITY_CAPABILITIES};

use crate::sid::Sid;
use crate::spawn::{ConsoleMode, Launch, env_allowlist, launch, outcome_json};
use crate::util::{Result, SandboxError, wide};
use crate::Args;

pub fn appc_cmd(a: &Args) -> Result<serde_json::Value> {
    let name = a.get("name").unwrap_or("hy-spike-ptc").to_string();
    let wname = wide(&name);
    let mut psid: PSID = std::ptr::null_mut();
    let hr = unsafe {
        CreateAppContainerProfile(wname.as_ptr(), wname.as_ptr(), wname.as_ptr(), std::ptr::null(), 0, &mut psid)
    };
    let created = hr >= 0;
    if !created {
        // HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS)
        if hr as u32 != (0x8007_0000 | ERROR_ALREADY_EXISTS) {
            return Err(SandboxError::Other(format!("CreateAppContainerProfile failed: HRESULT {hr:#x}")));
        }
        let hr2 = unsafe { DeriveAppContainerSidFromAppContainerName(wname.as_ptr(), &mut psid) };
        if hr2 < 0 {
            return Err(SandboxError::Other(format!("DeriveAppContainerSidFromAppContainerName failed: {hr2:#x}")));
        }
    }
    let ac_sid = unsafe { Sid::from_psid(psid) }?;
    unsafe { FreeSid(psid) };

    let caps = SECURITY_CAPABILITIES {
        AppContainerSid: ac_sid.as_psid(),
        Capabilities: std::ptr::null_mut(),
        CapabilityCount: 0,
        Reserved: 0,
    };
    let spec = Launch {
        token: None,
        cmdline: a.rest.join(" "),
        cwd: a.get("cwd").map(PathBuf::from),
        env: env_allowlist(&a.all("env-pass"), None, &[]),
        console: ConsoleMode::Inherit,
        timeout_ms: a.get("timeout").and_then(|t| t.parse::<u32>().ok()).unwrap_or(120) * 1000,
        security_capabilities: Some(&caps),
        single_process_job: a.flag("single-process"),
    };
    let r = launch(&spec);

    let deleted = if a.flag("keep") {
        false
    } else {
        unsafe { DeleteAppContainerProfile(wname.as_ptr()) >= 0 }
    };
    let o = r?;
    let mut v = outcome_json(&o);
    v["appContainer"] = json!(name);
    v["appContainerSid"] = json!(ac_sid.to_string_sid()?);
    v["profileCreated"] = json!(created);
    v["profileDeleted"] = json!(deleted);
    v["singleProcessJob"] = json!(a.flag("single-process"));
    v["cmd"] = json!(a.rest.join(" "));
    Ok(v)
}
