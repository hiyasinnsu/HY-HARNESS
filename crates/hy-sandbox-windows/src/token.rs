//! Confined token construction (design §4.2 item 1).

use windows_sys::Win32::Foundation::{GENERIC_ALL, HANDLE};
use windows_sys::Win32::Security::{
    ACL, ACL_REVISION, AddAccessAllowedAce, CreateRestrictedToken, DISABLE_MAX_PRIVILEGE,
    DuplicateTokenEx, GetLengthSid, GetTokenInformation, InitializeAcl, SID_AND_ATTRIBUTES,
    SecurityImpersonation, SetTokenInformation, TOKEN_ADJUST_DEFAULT, TOKEN_ADJUST_SESSIONID,
    TOKEN_ASSIGN_PRIMARY, TOKEN_DEFAULT_DACL, TOKEN_DUPLICATE, TOKEN_GROUPS, TOKEN_IMPERSONATE,
    TOKEN_MANDATORY_LABEL, TOKEN_QUERY, TOKEN_USER, TokenDefaultDacl, TokenGroups,
    TokenImpersonation, TokenIntegrityLevel, TokenUser, WRITE_RESTRICTED,
};
use windows_sys::Win32::System::SystemServices::{SE_GROUP_INTEGRITY, SE_GROUP_LOGON_ID};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

use crate::Mode;
use crate::sid::{self, Sid};
use crate::util::{OwnedHandle, Result, SandboxError, check};

/// A primary token for `CreateProcessAsUserW`.
#[derive(Debug)]
pub struct ConfinedToken {
    pub handle: OwnedHandle,
    pub mode: Mode,
    pub restricting_sids: Vec<String>,
    pub disabled_sids: Vec<String>,
}

fn token_info(token: HANDLE, class: i32, api: &'static str) -> Result<Vec<u64>> {
    let mut len = 0u32;
    // SAFETY: size query with a null buffer.
    unsafe { GetTokenInformation(token, class, std::ptr::null_mut(), 0, &mut len) };
    if len == 0 {
        return Err(SandboxError::last(api));
    }
    // u64 elements keep the buffer suitably aligned for the token structs.
    let mut buf = vec![0u64; (len as usize).div_ceil(8)];
    // SAFETY: buffer of at least `len` bytes.
    check(
        unsafe { GetTokenInformation(token, class, buf.as_mut_ptr().cast(), len, &mut len) },
        api,
    )?;
    Ok(buf)
}

pub struct CallerIdentity {
    pub user: Sid,
    pub logon: Sid,
    pub is_admin_member: bool,
}

pub fn open_process_token() -> Result<OwnedHandle> {
    let mut h: HANDLE = std::ptr::null_mut();
    let access = TOKEN_DUPLICATE
        | TOKEN_QUERY
        | TOKEN_ASSIGN_PRIMARY
        | TOKEN_ADJUST_DEFAULT
        | TOKEN_ADJUST_SESSIONID;
    // SAFETY: pseudo-handle for the current process.
    check(
        unsafe { OpenProcessToken(GetCurrentProcess(), access, &mut h) },
        "OpenProcessToken",
    )?;
    OwnedHandle::new(h, "OpenProcessToken")
}

pub fn caller_identity(token: HANDLE) -> Result<CallerIdentity> {
    let ubuf = token_info(token, TokenUser, "GetTokenInformation(TokenUser)")?;
    // SAFETY: buffer holds a TOKEN_USER.
    let user = unsafe { Sid::from_psid((*(ubuf.as_ptr() as *const TOKEN_USER)).User.Sid)? };

    let gbuf = token_info(token, TokenGroups, "GetTokenInformation(TokenGroups)")?;
    let groups = gbuf.as_ptr() as *const TOKEN_GROUPS;
    let admins = Sid::parse(sid::ADMINISTRATORS)?;
    let mut logon = None;
    let mut is_admin_member = false;
    // SAFETY: TOKEN_GROUPS has GroupCount trailing SID_AND_ATTRIBUTES entries.
    unsafe {
        let count = (*groups).GroupCount as usize;
        let first = std::ptr::addr_of!((*groups).Groups) as *const SID_AND_ATTRIBUTES;
        for i in 0..count {
            let g = &*first.add(i);
            if g.Attributes & (SE_GROUP_LOGON_ID as u32) == SE_GROUP_LOGON_ID as u32
                && logon.is_none()
            {
                logon = Some(Sid::from_psid(g.Sid)?);
            }
            if admins.equals_psid(g.Sid) {
                is_admin_member = true;
            }
        }
    }
    let logon = logon.ok_or_else(|| SandboxError::Other("caller token has no logon SID".into()))?;
    Ok(CallerIdentity {
        user,
        logon,
        is_admin_member,
    })
}

/// Builds the confined primary token.
///
/// * `read-only`: restricting SIDs = [logon SID, Everyone]
/// * `workspace-write`: + workspace SID + private-temp SID
/// * `low-integrity`: no restricting SIDs and no `WRITE_RESTRICTED` (ADR 0001 C)
pub fn create_confined(
    mode: Mode,
    workspace: Option<&Sid>,
    temp: Option<&Sid>,
) -> Result<ConfinedToken> {
    let base = open_process_token()?;
    let id = caller_identity(base.raw())?;
    create_confined_with_identity(&base, &id, mode, workspace, temp)
}

pub fn create_confined_with_identity(
    base_token: &OwnedHandle,
    id: &CallerIdentity,
    mode: Mode,
    workspace: Option<&Sid>,
    temp: Option<&Sid>,
) -> Result<ConfinedToken> {
    let everyone = Sid::parse(sid::EVERYONE)?;
    let admins = Sid::parse(sid::ADMINISTRATORS)?;

    let mut restricting: Vec<&Sid> = Vec::new();
    match mode {
        Mode::ReadOnly => restricting.extend([&id.logon, &everyone]),
        Mode::WorkspaceWrite => {
            restricting.extend([&id.logon, &everyone]);
            restricting.push(workspace.ok_or_else(|| {
                SandboxError::Other("workspace-write needs a workspace SID".into())
            })?);
            if let Some(t) = temp {
                restricting.push(t);
            }
        }
        Mode::LowIntegrity => {}
    }
    let flags = if restricting.is_empty() {
        DISABLE_MAX_PRIVILEGE
    } else {
        DISABLE_MAX_PRIVILEGE | WRITE_RESTRICTED
    };
    let mut restrict_attrs: Vec<SID_AND_ATTRIBUTES> = restricting
        .iter()
        .map(|s| SID_AND_ATTRIBUTES {
            Sid: s.as_psid(),
            Attributes: 0,
        })
        .collect();
    // BUILTIN\Administrators becomes deny-only when present (UAC admin, built-in Administrator).
    let mut disable_attrs: Vec<SID_AND_ATTRIBUTES> = Vec::new();
    if id.is_admin_member {
        disable_attrs.push(SID_AND_ATTRIBUTES {
            Sid: admins.as_psid(),
            Attributes: 0,
        });
    }

    let mut new_token: HANDLE = std::ptr::null_mut();
    // SAFETY: all SID pointers outlive the call.
    check(
        unsafe {
            CreateRestrictedToken(
                base_token.raw(),
                flags,
                disable_attrs.len() as u32,
                if disable_attrs.is_empty() {
                    std::ptr::null()
                } else {
                    disable_attrs.as_mut_ptr()
                },
                0,
                std::ptr::null(),
                restrict_attrs.len() as u32,
                if restrict_attrs.is_empty() {
                    std::ptr::null()
                } else {
                    restrict_attrs.as_mut_ptr()
                },
                &mut new_token,
            )
        },
        "CreateRestrictedToken",
    )?;
    let token = OwnedHandle::new(new_token, "CreateRestrictedToken")?;

    set_low_integrity(token.raw())?;

    // Objects the child creates (anonymous pipes, events) stay usable by it.
    let system = Sid::parse(sid::SYSTEM)?;
    let mut dacl_sids: Vec<&Sid> = vec![&id.user, &system, &id.logon];
    if let Some(t) = temp {
        dacl_sids.push(t);
    }
    set_default_dacl(token.raw(), &dacl_sids)?;

    Ok(ConfinedToken {
        handle: token,
        mode,
        restricting_sids: restricting
            .iter()
            .filter_map(|s| s.to_string_sid().ok())
            .collect(),
        disabled_sids: if id.is_admin_member {
            vec![sid::ADMINISTRATORS.into()]
        } else {
            vec![]
        },
    })
}

fn set_low_integrity(token: HANDLE) -> Result<()> {
    let low = Sid::parse(sid::LOW_INTEGRITY)?;
    let label = TOKEN_MANDATORY_LABEL {
        Label: SID_AND_ATTRIBUTES {
            Sid: low.as_psid(),
            Attributes: SE_GROUP_INTEGRITY as u32,
        },
    };
    // SAFETY: `low` outlives the call.
    let size = std::mem::size_of::<TOKEN_MANDATORY_LABEL>() as u32
        + unsafe { GetLengthSid(low.as_psid()) };
    check(
        unsafe {
            SetTokenInformation(
                token,
                TokenIntegrityLevel,
                (&label as *const TOKEN_MANDATORY_LABEL).cast(),
                size,
            )
        },
        "SetTokenInformation(TokenIntegrityLevel)",
    )
}

/// Builds an ACL granting GENERIC_ALL to each SID.
pub fn build_allow_acl(sids: &[&Sid]) -> Result<Vec<u64>> {
    let mut size = std::mem::size_of::<ACL>() as u32;
    for s in sids {
        // ACCESS_ALLOWED_ACE header + mask (8 bytes) + SID.
        size += 8 + unsafe { GetLengthSid(s.as_psid()) };
    }
    size = size.div_ceil(4) * 4;
    let mut buf = vec![0u64; (size as usize).div_ceil(8)];
    let acl = buf.as_mut_ptr() as *mut ACL;
    // SAFETY: buffer of at least `size` bytes.
    check(
        unsafe { InitializeAcl(acl, size, ACL_REVISION) },
        "InitializeAcl",
    )?;
    for s in sids {
        check(
            unsafe { AddAccessAllowedAce(acl, ACL_REVISION, GENERIC_ALL, s.as_psid()) },
            "AddAccessAllowedAce",
        )?;
    }
    Ok(buf)
}

fn set_default_dacl(token: HANDLE, sids: &[&Sid]) -> Result<()> {
    let mut acl = build_allow_acl(sids)?;
    let info = TOKEN_DEFAULT_DACL {
        DefaultDacl: acl.as_mut_ptr() as *mut ACL,
    };
    check(
        unsafe {
            SetTokenInformation(
                token,
                TokenDefaultDacl,
                (&info as *const TOKEN_DEFAULT_DACL).cast(),
                std::mem::size_of::<TOKEN_DEFAULT_DACL>() as u32,
            )
        },
        "SetTokenInformation(TokenDefaultDacl)",
    )
}

/// Impersonation copy of a confined token (for the patcher thread).
pub fn impersonation_copy(token: &ConfinedToken) -> Result<OwnedHandle> {
    let mut out: HANDLE = std::ptr::null_mut();
    check(
        unsafe {
            DuplicateTokenEx(
                token.handle.raw(),
                TOKEN_IMPERSONATE | TOKEN_QUERY | TOKEN_DUPLICATE,
                std::ptr::null(),
                SecurityImpersonation,
                TokenImpersonation,
                &mut out,
            )
        },
        "DuplicateTokenEx",
    )?;
    OwnedHandle::new(out, "DuplicateTokenEx")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constructs_tokens_for_standard_user_and_admin_member_identities() -> Result<()> {
        let base = open_process_token()?;
        let real_id = caller_identity(base.raw())?;
        let ws_sid = sid::workspace_sid(r"C:\workspace\demo")?;
        let tmp_sid = sid::temp_sid(r"C:\temp\demo")?;

        // 1. Standard user (`is_admin_member == false`): `disabled_sids` is empty.
        let std_id = CallerIdentity {
            user: Sid::parse(&real_id.user.to_string_sid()?)?,
            logon: Sid::parse(&real_id.logon.to_string_sid()?)?,
            is_admin_member: false,
        };
        let ro_std = create_confined_with_identity(&base, &std_id, Mode::ReadOnly, None, None)?;
        assert_eq!(ro_std.restricting_sids.len(), 2);
        assert!(ro_std.disabled_sids.is_empty());

        let ww_std = create_confined_with_identity(
            &base,
            &std_id,
            Mode::WorkspaceWrite,
            Some(&ws_sid),
            Some(&tmp_sid),
        )?;
        assert_eq!(ww_std.restricting_sids.len(), 4);
        assert!(ww_std.disabled_sids.is_empty());
        let imp = impersonation_copy(&ww_std)?;
        assert!(!imp.raw().is_null());

        let li_std = create_confined_with_identity(&base, &std_id, Mode::LowIntegrity, None, None)?;
        assert!(li_std.restricting_sids.is_empty());
        assert!(li_std.disabled_sids.is_empty());

        // 2. Admin / UAC member (`is_admin_member == true`): `BUILTIN\Administrators` is disabled.
        let admin_id = CallerIdentity {
            user: Sid::parse(&real_id.user.to_string_sid()?)?,
            logon: Sid::parse(&real_id.logon.to_string_sid()?)?,
            is_admin_member: true,
        };
        let ww_admin = create_confined_with_identity(
            &base,
            &admin_id,
            Mode::WorkspaceWrite,
            Some(&ws_sid),
            Some(&tmp_sid),
        )?;
        assert_eq!(ww_admin.restricting_sids.len(), 4);
        assert_eq!(
            ww_admin.disabled_sids,
            vec![sid::ADMINISTRATORS.to_string()]
        );
        Ok(())
    }
}
