//! CP-08: `hy-secret protect|unprotect`, a tiny DPAPI helper for the control
//! plane. The value is read from stdin so it never appears in the process list.

use std::io::{Read, Write};

fn main() {
    let mode = std::env::args().nth(1).unwrap_or_default();
    let mut input = String::new();
    if std::io::stdin().read_to_string(&mut input).is_err() {
        let _ = writeln!(std::io::stderr(), "hy-secret: cannot read stdin");
        std::process::exit(2);
    }
    let value = input.trim_end_matches(['\r', '\n']);
    let result = match mode.as_str() {
        "protect" => hy_sandbox_windows::secrets::protect(value),
        "unprotect" => hy_sandbox_windows::secrets::unprotect(value),
        _ => Err("usage: hy-secret protect|unprotect  (value on stdin)".to_string()),
    };
    match result {
        Ok(out) => {
            let mut stdout = std::io::stdout();
            if writeln!(stdout, "{out}").is_err() {
                std::process::exit(2);
            }
        }
        Err(e) => {
            let _ = writeln!(std::io::stderr(), "hy-secret: {e}");
            std::process::exit(1);
        }
    }
}
