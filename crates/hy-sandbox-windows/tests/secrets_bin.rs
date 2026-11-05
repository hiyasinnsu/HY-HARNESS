//! CP-08: the `hy-secret` helper round-trips through stdin/stdout.
use std::io::Write;
use std::process::{Command, Stdio};

fn bin() -> std::path::PathBuf {
    // `CARGO_BIN_EXE_<name>` is set for integration tests by cargo.
    std::path::PathBuf::from(env!("CARGO_BIN_EXE_hy-secret"))
}

fn run(mode: &str, input: &str) -> Result<(bool, String), String> {
    let mut child = Command::new(bin())
        .arg(mode)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn hy-secret: {e}"))?;
    child
        .stdin
        .as_mut()
        .ok_or("hy-secret has no stdin")?
        .write_all(input.as_bytes())
        .map_err(|e| format!("write: {e}"))?;
    let out = child.wait_with_output().map_err(|e| format!("wait: {e}"))?;
    let text = if out.status.success() {
        &out.stdout
    } else {
        &out.stderr
    };
    Ok((
        out.status.success(),
        String::from_utf8_lossy(text).into_owned(),
    ))
}

#[test]
fn protect_then_unprotect_over_stdin() -> Result<(), String> {
    let (ok, reference) = run("protect", "sk-live-123\n")?;
    assert!(ok, "{reference}");
    let reference = reference.trim();
    assert!(reference.starts_with("dpapi:"), "{reference}");

    let (ok, plain) = run("unprotect", reference)?;
    assert!(ok, "{plain}");
    assert_eq!(plain.trim(), "sk-live-123");
    Ok(())
}

#[test]
fn unknown_mode_fails_closed() -> Result<(), String> {
    let (ok, message) = run("encrypt", "x")?;
    assert!(!ok);
    assert!(message.contains("usage"), "{message}");
    Ok(())
}
