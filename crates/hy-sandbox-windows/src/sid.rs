//! SIDs: owned buffers, string conversion, and the deterministic capability SIDs.

use sha2::{Digest, Sha256};
use windows_sys::Win32::Security::Authorization::{ConvertSidToStringSidW, ConvertStringSidToSidW};
use windows_sys::Win32::Security::PSID;
use windows_sys::Win32::Security::{CopySid, EqualSid, GetLengthSid, IsValidSid};

use crate::util::{LocalBox, Result, SandboxError, check, from_wide_ptr, wide};

pub const EVERYONE: &str = "S-1-1-0";
pub const LOW_INTEGRITY: &str = "S-1-16-4096";
pub const SYSTEM: &str = "S-1-5-18";
pub const ADMINISTRATORS: &str = "S-1-5-32-544";

/// An owned SID in a `Vec<u8>` buffer.
#[derive(Clone, PartialEq, Eq)]
pub struct Sid(Vec<u8>);

impl std::fmt::Debug for Sid {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Sid({})",
            self.to_string_sid().unwrap_or_else(|_| "?".into())
        )
    }
}

impl Sid {
    pub fn parse(s: &str) -> Result<Self> {
        let w = wide(s);
        let mut psid: PSID = std::ptr::null_mut();
        // SAFETY: valid NUL-terminated input; output freed via LocalBox.
        check(
            unsafe { ConvertStringSidToSidW(w.as_ptr(), &mut psid) },
            "ConvertStringSidToSidW",
        )?;
        let _guard = LocalBox(psid);
        // SAFETY: psid is a valid SID returned by the system.
        unsafe { Self::from_psid(psid) }
    }

    /// Copies a SID the caller guarantees is valid.
    ///
    /// # Safety
    /// `psid` must point to a valid SID.
    pub unsafe fn from_psid(psid: PSID) -> Result<Self> {
        // SAFETY: per contract.
        unsafe {
            if IsValidSid(psid) == 0 {
                return Err(SandboxError::Other("invalid SID".into()));
            }
            let len = GetLengthSid(psid);
            let mut buf = vec![0u8; len as usize];
            check(CopySid(len, buf.as_mut_ptr().cast(), psid), "CopySid")?;
            Ok(Self(buf))
        }
    }

    pub fn as_psid(&self) -> PSID {
        self.0.as_ptr() as PSID
    }

    pub fn to_string_sid(&self) -> Result<String> {
        let mut out: *mut u16 = std::ptr::null_mut();
        // SAFETY: self holds a valid SID.
        check(
            unsafe { ConvertSidToStringSidW(self.as_psid(), &mut out) },
            "ConvertSidToStringSidW",
        )?;
        let _guard = LocalBox(out.cast());
        Ok(from_wide_ptr(out))
    }

    /// # Safety
    /// `psid` must point to a valid SID.
    pub unsafe fn equals_psid(&self, psid: PSID) -> bool {
        // SAFETY: both are valid SIDs.
        unsafe { EqualSid(self.as_psid(), psid) != 0 }
    }
}

fn derived(domain: &str, key: &str) -> Result<Sid> {
    let mut h = Sha256::new();
    h.update(b"hy-harness/");
    h.update(domain.as_bytes());
    h.update([0u8]);
    h.update(key.as_bytes());
    let d = h.finalize();
    let sub = |i: usize| u32::from_le_bytes([d[i], d[i + 1], d[i + 2], d[i + 3]]);
    // S-1-4 is the non-unique authority, as in the DeepSeek Harness design.
    Sid::parse(&format!(
        "S-1-4-{}-{}-{}-{}",
        sub(0),
        sub(4),
        sub(8),
        sub(12)
    ))
}

/// Deterministic workspace capability SID from the canonical workspace path.
pub fn workspace_sid(canonical_workspace: &str) -> Result<Sid> {
    derived("workspace", &canonical_workspace.to_lowercase())
}

/// Domain-separated SID for a private temp directory.
pub fn temp_sid(canonical_temp_dir: &str) -> Result<Sid> {
    derived("temp", &canonical_temp_dir.to_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_derivation() -> Result<()> {
        let e = Sid::parse(EVERYONE)?;
        assert_eq!(e.to_string_sid()?, EVERYONE);
        let a = workspace_sid("C:\\work\\repo")?;
        let b = workspace_sid("c:\\WORK\\repo")?;
        let t = temp_sid("C:\\work\\repo")?;
        assert_eq!(a, b, "case-insensitive paths give one SID");
        assert_ne!(a, t, "domains are separated");
        assert!(a.to_string_sid()?.starts_with("S-1-4-"));
        Ok(())
    }
}
