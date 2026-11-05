//! Prints the protocol JSON Schema bundle to stdout.
use std::io::Write;

fn main() -> std::io::Result<()> {
    let text = serde_json::to_string_pretty(&hy_protocol::schema_bundle())?;
    let mut out = std::io::stdout().lock();
    out.write_all(text.as_bytes())?;
    out.write_all(b"\n")
}
