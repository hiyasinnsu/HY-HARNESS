//! CP-08: secrets at rest with Windows DPAPI.
//!
//! `apiKey` values may be stored as `dpapi:<base64>`. The ciphertext is bound to
//! the current Windows user (and machine) by `CryptProtectData`, so copying
//! `config.json` to another account does not reveal the key. The user's own
//! process decrypts it again in `roleApiKey` when a provider is built.
//!
//! The companion binary `hy-secret` exposes `protect` / `unprotect` over stdin
//! so the TypeScript control plane never has to link against crypt32 itself.

use base64::Engine;
use windows_sys::Win32::Foundation::LocalFree;
use windows_sys::Win32::Security::Cryptography::{
    CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
};

/// Prefix that marks a value as a DPAPI reference.
pub const PREFIX: &str = "dpapi:";

fn blob(data: &[u8]) -> CRYPT_INTEGER_BLOB {
    CRYPT_INTEGER_BLOB {
        cbData: data.len() as u32,
        pbData: data.as_ptr() as *mut u8,
    }
}

fn take(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
    if out.pbData.is_null() || out.cbData == 0 {
        return Vec::new();
    }
    // SAFETY: the API returned a buffer of `cbData` bytes; it is freed below.
    let bytes = unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize) }.to_vec();
    // SAFETY: LocalAlloc-allocated buffer returned by CryptProtectData.
    unsafe {
        LocalFree(out.pbData.cast());
    }
    bytes
}

/// Encrypts `value` for the current user; returns a `dpapi:` reference.
pub fn protect(value: &str) -> Result<String, String> {
    if value.is_empty() {
        return Err("refusing to protect an empty secret".into());
    }
    let input = blob(value.as_bytes());
    let mut out = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    // SAFETY: input points to a live slice; out is written by the API.
    let ok = unsafe {
        CryptProtectData(
            &input,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out,
        )
    };
    if ok == 0 {
        return Err(format!(
            "CryptProtectData: {}",
            std::io::Error::last_os_error()
        ));
    }
    let bytes = take(out);
    Ok(format!(
        "{PREFIX}{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

/// Decrypts a `dpapi:` reference produced by [`protect`].
pub fn unprotect(reference: &str) -> Result<String, String> {
    let Some(encoded) = reference.strip_prefix(PREFIX) else {
        return Err(format!("not a {PREFIX} reference"));
    };
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .map_err(|e| format!("base64: {e}"))?;
    if bytes.is_empty() {
        return Err("empty ciphertext".into());
    }
    let input = blob(&bytes);
    let mut out = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    // SAFETY: input points to a live buffer; out is written by the API.
    let ok = unsafe {
        CryptUnprotectData(
            &input,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out,
        )
    };
    if ok == 0 {
        return Err(format!(
            "CryptUnprotectData: {}",
            std::io::Error::last_os_error()
        ));
    }
    let bytes = take(out);
    String::from_utf8(bytes).map_err(|_| "the secret is not UTF-8".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() -> Result<(), String> {
        let secret = "sk-test-0123456789";
        let reference = protect(secret)?;
        assert!(reference.starts_with(PREFIX));
        assert!(!reference.contains(secret));
        assert_eq!(unprotect(&reference)?, secret);
        Ok(())
    }

    #[test]
    fn rejects_bad_inputs() {
        assert!(protect("").is_err());
        assert!(unprotect("plain-text").is_err());
        assert!(unprotect("dpapi:not-base64!").is_err());
        assert!(unprotect("dpapi:").is_err());
    }

    #[test]
    fn each_call_uses_fresh_entropy() -> Result<(), String> {
        let a = protect("same")?;
        let b = protect("same")?;
        assert_ne!(a, b, "DPAPI adds a random salt per call");
        assert_eq!(unprotect(&a)?, unprotect(&b)?);
        Ok(())
    }
}
