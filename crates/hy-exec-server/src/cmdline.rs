//! Turning an evaluated command into a process invocation (design §4.1,
//! "Execution follows evaluation").
//!
//! A simple command whose `argv[0]` resolves on `PATH` + `PATHEXT` runs directly
//! from the evaluated argv, with no shell. `.cmd` / `.bat` targets go through Rust
//! std's batch-argument handling (Rust ≥ 1.77.2, the CVE-2024-24576 fix), which
//! refuses arguments it cannot quote safely. Builtins, cmdlets and approved
//! compound commands go through the dialect shell.

use std::path::{Path, PathBuf};

use base64::Engine;
use hy_execpolicy::{Dialect, Tokenized};
use hy_protocol::ShellDialect;

#[derive(Debug, Clone)]
pub struct Shell {
    pub dialect: ShellDialect,
    pub executable: PathBuf,
}

impl Shell {
    pub fn policy_dialect(&self) -> Dialect {
        match self.dialect {
            ShellDialect::Cmd => Dialect::Cmd,
            ShellDialect::Pwsh | ShellDialect::Powershell => Dialect::PowerShell,
        }
    }

    /// Finds `pwsh` (PowerShell 7) first, then Windows PowerShell 5.1 (OQ-1).
    pub fn detect(path_var: &str) -> Shell {
        if let Some(p) = find_on_path("pwsh.exe", path_var) {
            return Shell {
                dialect: ShellDialect::Pwsh,
                executable: p,
            };
        }
        let sys = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
        Shell {
            dialect: ShellDialect::Powershell,
            executable: PathBuf::from(sys)
                .join("System32\\WindowsPowerShell\\v1.0\\powershell.exe"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Invocation {
    /// Program + argv[1..], no shell.
    Direct { program: PathBuf, args: Vec<String> },
    /// Through the dialect shell.
    Shell {
        program: PathBuf,
        args: Vec<String>,
        raw_arg: Option<String>,
    },
}

impl Invocation {
    pub fn describe(&self) -> &'static str {
        match self {
            Invocation::Direct { .. } => "direct",
            Invocation::Shell { .. } => "shell",
        }
    }
}

fn find_on_path(file: &str, path_var: &str) -> Option<PathBuf> {
    path_var
        .split(';')
        .filter(|d| !d.is_empty())
        .map(|d| Path::new(d).join(file))
        .find(|p| p.is_file())
}

/// Resolves `argv[0]` on PATH + PATHEXT. The current directory is not searched,
/// so a file planted in the workspace cannot shadow a tool.
pub fn resolve_program(name: &str, path_var: &str, pathext: &str, cwd: &Path) -> Option<PathBuf> {
    let exts: Vec<String> = pathext
        .split(';')
        .filter(|e| !e.is_empty())
        .map(|e| e.to_lowercase())
        .collect();
    let has_ext = |p: &Path| {
        p.extension()
            .map(|e| format!(".{}", e.to_string_lossy().to_lowercase()))
            .is_some_and(|e| exts.contains(&e))
    };
    let try_candidates = |base: PathBuf| -> Option<PathBuf> {
        if has_ext(&base) && base.is_file() {
            return Some(base);
        }
        exts.iter()
            .map(|e| PathBuf::from(format!("{}{}", base.display(), e)))
            .find(|p| p.is_file())
    };
    if name.contains(['\\', '/']) {
        let p = Path::new(name);
        let full = if p.is_absolute() {
            p.to_path_buf()
        } else {
            cwd.join(p)
        };
        return try_candidates(full);
    }
    for dir in path_var.split(';').filter(|d| !d.is_empty()) {
        if let Some(found) = try_candidates(Path::new(dir).join(name)) {
            return Some(found);
        }
    }
    None
}

pub fn shell_invocation(shell: &Shell, command: &str) -> Invocation {
    match shell.dialect {
        ShellDialect::Pwsh | ShellDialect::Powershell => {
            // With redirected output, PowerShell serializes progress records
            // (e.g. first-time module loading) to stderr as `#< CLIXML` noise.
            // The encodings match the persistent shell (`shell.rs`): without
            // them a non-Japanese code page emits ANSI bytes that `jobs.rs`
            // decodes as Shift_JIS (T-3).
            let command = format!(
                "$ProgressPreference = 'SilentlyContinue'; \
                 [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; \
                 $OutputEncoding = [System.Text.Encoding]::UTF8; \
                 {command}"
            );
            let utf16: Vec<u8> = command.encode_utf16().flat_map(u16::to_le_bytes).collect();
            let encoded = base64::engine::general_purpose::STANDARD.encode(utf16);
            Invocation::Shell {
                program: shell.executable.clone(),
                args: vec![
                    "-NoLogo".into(),
                    "-NoProfile".into(),
                    "-NonInteractive".into(),
                    "-EncodedCommand".into(),
                    encoded,
                ],
                raw_arg: None,
            }
        }
        ShellDialect::Cmd => Invocation::Shell {
            program: shell.executable.clone(),
            args: vec![],
            raw_arg: Some(format!("/d /s /c \"{command}\"")),
        },
    }
}

/// Chooses how to run a command the policy has already evaluated.
pub fn plan(
    command: &str,
    tokens: &Tokenized,
    shell: &Shell,
    path_var: &str,
    pathext: &str,
    cwd: &Path,
) -> Invocation {
    if let Some(argv) = tokens.argv()
        && let Some((first, rest)) = argv.split_first()
        && let Some(program) = resolve_program(first, path_var, pathext, cwd)
    {
        return Invocation::Direct {
            program,
            args: rest.to_vec(),
        };
    }
    shell_invocation(shell, command)
}

#[cfg(test)]
mod tests {
    use super::*;
    use hy_execpolicy::tokenize;

    fn env_path() -> String {
        std::env::var("PATH").unwrap_or_default()
    }

    #[test]
    fn resolves_system_tools_and_not_cwd() {
        let tmp = std::env::temp_dir();
        let pathext = ".COM;.EXE;.BAT;.CMD";
        let found = resolve_program("cmd", &env_path(), pathext, &tmp);
        assert!(found.is_some_and(|p| p.to_string_lossy().to_lowercase().ends_with("cmd.exe")));
        // A file in cwd must not be found by bare name.
        let dir = tempfile::tempdir().map_err(|e| e.to_string());
        if let Ok(dir) = dir {
            let planted = dir.path().join("zz-planted-tool.exe");
            let _ = std::fs::write(&planted, b"x");
            assert_eq!(
                resolve_program("zz-planted-tool", "", pathext, dir.path()),
                None
            );
            assert!(resolve_program(".\\zz-planted-tool", "", pathext, dir.path()).is_some());
        }
    }

    /// The one-shot PowerShell prefix: no CLIXML progress noise, and UTF-8
    /// output like the persistent shell (`shell.rs`), so `jobs.rs` stops
    /// reading ANSI bytes from a non-Japanese code page as Shift_JIS (T-3).
    #[test]
    fn powershell_prefix_sets_progress_and_utf8_output() {
        for dialect in [ShellDialect::Pwsh, ShellDialect::Powershell] {
            let shell = Shell {
                dialect,
                executable: PathBuf::from("powershell.exe"),
            };
            let Invocation::Shell { args, .. } = shell_invocation(&shell, "Get-ChildItem -Name")
            else {
                panic!("a PowerShell dialect must use the shell invocation");
            };
            assert_eq!(args[args.len() - 2], "-EncodedCommand");
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(&args[args.len() - 1])
                .expect("the command is base64 UTF-16LE");
            let units: Vec<u16> = bytes
                .chunks_exact(2)
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                .collect();
            let command = String::from_utf16(&units).expect("valid UTF-16");
            let prefix = "$ProgressPreference = 'SilentlyContinue'; \
                          [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; \
                          $OutputEncoding = [System.Text.Encoding]::UTF8; ";
            assert!(command.starts_with(prefix), "prefix mismatch: {command}");
            assert_eq!(&command[prefix.len()..], "Get-ChildItem -Name");
        }
    }

    #[test]
    fn builtins_and_compound_use_the_shell() {
        let shell = Shell::detect(&env_path());
        let cwd = std::env::temp_dir();
        let t = tokenize("Get-ChildItem -Name", Dialect::PowerShell);
        assert_eq!(
            plan(
                "Get-ChildItem -Name",
                &t,
                &shell,
                &env_path(),
                ".EXE;.CMD",
                &cwd
            )
            .describe(),
            "shell"
        );
        let t = tokenize("git status | Out-Host", Dialect::PowerShell);
        assert_eq!(
            plan(
                "git status | Out-Host",
                &t,
                &shell,
                &env_path(),
                ".EXE;.CMD",
                &cwd
            )
            .describe(),
            "shell"
        );
        // Direct invocation when argv[0] resolves on PATH, and Cmd shell dialect.
        let cmd_shell = Shell {
            dialect: ShellDialect::Cmd,
            executable: PathBuf::from("C:\\Windows\\System32\\cmd.exe"),
        };
        assert_eq!(cmd_shell.policy_dialect(), Dialect::Cmd);
        assert_eq!(shell.policy_dialect(), Dialect::PowerShell);
        assert_eq!(
            shell_invocation(&cmd_shell, "echo hi && dir").describe(),
            "shell"
        );
        let direct = tokenize("cmd /c echo hi", Dialect::Cmd);
        assert_eq!(
            plan(
                "cmd /c echo hi",
                &direct,
                &cmd_shell,
                &env_path(),
                ".COM;.EXE;.BAT;.CMD",
                &cwd
            )
            .describe(),
            "direct"
        );
    }
}
