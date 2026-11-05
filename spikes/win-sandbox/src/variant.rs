//! Token variants for isolating which property of the confined token causes a
//! failure (spike item S-2: "test whether any token or owner adjustment fixes it").
//!
//! `--variant` is a comma-separated list applied to the draft token shape:
//! * `nolow`      — keep the caller's integrity level (Medium) instead of Low
//! * `nowr`       — no `WRITE_RESTRICTED` (restricting SIDs apply to all access)
//! * `norestrict` — no restricting SIDs at all (only privileges removed)
//! * `keepadmin`  — do not put BUILTIN\Administrators into SidsToDisable
//! * `users`      — add BUILTIN\Users to the restricting SIDs
//! * `authusers`  — add Authenticated Users to the restricting SIDs

use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::Security::{
    CreateRestrictedToken, DISABLE_MAX_PRIVILEGE, GetLengthSid, SID_AND_ATTRIBUTES, SetTokenInformation, TOKEN_MANDATORY_LABEL,
    TokenIntegrityLevel, WRITE_RESTRICTED,
};
use windows_sys::Win32::System::SystemServices::SE_GROUP_INTEGRITY;

use crate::sid::{self, Sid};
use crate::token;
use crate::util::{OwnedHandle, Result, check};

pub struct Variant {
    pub handle: OwnedHandle,
    pub restricting: Vec<String>,
    pub flags: Vec<String>,
}

pub fn create(spec: &str, ws: Option<&Sid>, temp: Option<&Sid>) -> Result<Variant> {
    let has = |f: &str| spec.split(',').any(|s| s.trim() == f);
    let base = token::open_process_token()?;
    let id = token::caller_identity(base.raw())?;
    let everyone = Sid::parse(sid::EVERYONE)?;
    let admins = Sid::parse(sid::ADMINISTRATORS)?;
    let users = Sid::parse("S-1-5-32-545")?;
    let auth = Sid::parse("S-1-5-11")?;

    let mut restricting: Vec<&Sid> = Vec::new();
    if !has("norestrict") {
        restricting.extend([&id.logon, &everyone]);
        restricting.extend(ws);
        restricting.extend(temp);
        if has("users") {
            restricting.push(&users);
        }
        if has("authusers") {
            restricting.push(&auth);
        }
    }
    let mut r_attrs: Vec<SID_AND_ATTRIBUTES> =
        restricting.iter().map(|s| SID_AND_ATTRIBUTES { Sid: s.as_psid(), Attributes: 0 }).collect();
    let mut d_attrs: Vec<SID_AND_ATTRIBUTES> = Vec::new();
    if id.is_admin_member && !has("keepadmin") {
        d_attrs.push(SID_AND_ATTRIBUTES { Sid: admins.as_psid(), Attributes: 0 });
    }
    let mut flags = DISABLE_MAX_PRIVILEGE;
    if !has("nowr") && !restricting.is_empty() {
        flags |= WRITE_RESTRICTED;
    }
    let mut out: HANDLE = std::ptr::null_mut();
    check(
        unsafe {
            CreateRestrictedToken(
                base.raw(),
                flags,
                d_attrs.len() as u32,
                if d_attrs.is_empty() { std::ptr::null() } else { d_attrs.as_mut_ptr() },
                0,
                std::ptr::null(),
                r_attrs.len() as u32,
                if r_attrs.is_empty() { std::ptr::null() } else { r_attrs.as_mut_ptr() },
                &mut out,
            )
        },
        "CreateRestrictedToken",
    )?;
    let handle = OwnedHandle::new(out, "CreateRestrictedToken")?;
    if !has("nolow") {
        let low = Sid::parse(sid::LOW_INTEGRITY)?;
        let label = TOKEN_MANDATORY_LABEL { Label: SID_AND_ATTRIBUTES { Sid: low.as_psid(), Attributes: SE_GROUP_INTEGRITY as u32 } };
        let size = std::mem::size_of::<TOKEN_MANDATORY_LABEL>() as u32 + unsafe { GetLengthSid(low.as_psid()) };
        check(
            unsafe { SetTokenInformation(handle.raw(), TokenIntegrityLevel, (&label as *const TOKEN_MANDATORY_LABEL).cast(), size) },
            "SetTokenInformation(TokenIntegrityLevel)",
        )?;
    }
    Ok(Variant {
        handle,
        restricting: restricting.iter().filter_map(|s| s.to_string_sid().ok()).collect(),
        flags: spec.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect(),
    })
}
