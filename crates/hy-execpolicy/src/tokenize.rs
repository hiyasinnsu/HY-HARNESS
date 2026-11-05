//! Dialect-aware tokenizer with a safe-character allowlist (design §4.1).
//!
//! A command is *simple* only when every character outside quotes is in the
//! safe set and nothing inside quotes can expand. Anything else is *compound*,
//! which fails closed for every dialect.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dialect {
    /// PowerShell 7 and Windows PowerShell 5.1.
    PowerShell,
    Cmd,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tokenized {
    /// Segments split on unquoted operators; each is a list of unquoted tokens.
    pub segments: Vec<Vec<String>>,
    pub compound: bool,
    /// Why the command is compound (first offending construct).
    pub reason: Option<String>,
}

impl Tokenized {
    /// argv of a simple command.
    pub fn argv(&self) -> Option<&[String]> {
        if self.compound {
            return None;
        }
        self.segments.first().map(Vec::as_slice)
    }
}

pub fn is_safe_char(c: char) -> bool {
    c.is_alphanumeric() || c.is_whitespace() && c != '\n' && c != '\r' || "_-./\\:=,+*?".contains(c)
}

fn is_operator(c: char) -> bool {
    matches!(c, ';' | '&' | '|' | '\n' | '\r')
}

pub fn tokenize(command: &str, dialect: Dialect) -> Tokenized {
    let mut segments: Vec<Vec<String>> = vec![Vec::new()];
    let mut current = String::new();
    let mut in_token = false;
    let mut reason: Option<String> = None;
    let mark = |r: String, reason: &mut Option<String>| {
        if reason.is_none() {
            *reason = Some(r);
        }
    };

    let chars: Vec<char> = command.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '\'' if dialect == Dialect::PowerShell => {
                // Literal string; '' is an escaped quote.
                in_token = true;
                i += 1;
                let mut closed = false;
                while i < chars.len() {
                    if chars[i] == '\'' {
                        if chars.get(i + 1) == Some(&'\'') {
                            current.push('\'');
                            i += 2;
                            continue;
                        }
                        closed = true;
                        break;
                    }
                    current.push(chars[i]);
                    i += 1;
                }
                if !closed {
                    mark("unterminated single quote".into(), &mut reason);
                }
            }
            '"' => {
                in_token = true;
                i += 1;
                let mut closed = false;
                while i < chars.len() {
                    let q = chars[i];
                    if q == '"' {
                        closed = true;
                        break;
                    }
                    let expands = match dialect {
                        Dialect::PowerShell => q == '$' || q == '`',
                        Dialect::Cmd => q == '%' || q == '^' || q == '!',
                    };
                    if expands {
                        mark(
                            format!("expansion character {q:?} inside double quotes"),
                            &mut reason,
                        );
                    }
                    if q == '\n' || q == '\r' {
                        mark("newline inside quotes".into(), &mut reason);
                    }
                    current.push(q);
                    i += 1;
                }
                if !closed {
                    mark("unterminated double quote".into(), &mut reason);
                }
            }
            c if c.is_whitespace() && c != '\n' && c != '\r' => {
                if in_token {
                    if let Some(seg) = segments.last_mut() {
                        seg.push(std::mem::take(&mut current));
                    }
                    in_token = false;
                }
            }
            c if is_operator(c) => {
                mark(format!("operator {c:?}"), &mut reason);
                if in_token {
                    if let Some(seg) = segments.last_mut() {
                        seg.push(std::mem::take(&mut current));
                    }
                    in_token = false;
                }
                // Collapse runs such as `&&`, `||`, `\r\n`.
                while i + 1 < chars.len() && is_operator(chars[i + 1]) {
                    i += 1;
                }
                segments.push(Vec::new());
            }
            c => {
                if !is_safe_char(c) {
                    mark(format!("unsafe character {c:?}"), &mut reason);
                }
                in_token = true;
                current.push(c);
            }
        }
        i += 1;
    }
    if in_token && let Some(seg) = segments.last_mut() {
        seg.push(current);
    }
    segments.retain(|s| !s.is_empty());

    // PowerShell's stop-parsing token passes the rest verbatim to the program.
    if dialect == Dialect::PowerShell && segments.iter().flatten().any(|t| t == "--%") {
        mark("stop-parsing token --%".into(), &mut reason);
    }
    if segments.is_empty() {
        mark("empty command".into(), &mut reason);
    }
    Tokenized {
        compound: reason.is_some(),
        segments,
        reason,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn simple(cmd: &str, d: Dialect) -> Vec<String> {
        let t = tokenize(cmd, d);
        assert!(!t.compound, "{cmd:?} unexpectedly compound: {:?}", t.reason);
        t.segments.into_iter().next().unwrap_or_default()
    }

    #[test]
    fn simple_commands() {
        assert_eq!(simple("git status", Dialect::PowerShell), ["git", "status"]);
        assert_eq!(
            simple("cargo test -p hy-protocol", Dialect::PowerShell),
            ["cargo", "test", "-p", "hy-protocol"]
        );
        assert_eq!(
            simple("rg 'a|b' src", Dialect::PowerShell),
            ["rg", "a|b", "src"]
        );
        assert_eq!(
            simple("echo 'it''s'", Dialect::PowerShell),
            ["echo", "it's"]
        );
        assert_eq!(
            simple("ls C:\\work\\*.rs", Dialect::Cmd),
            ["ls", "C:\\work\\*.rs"]
        );
        assert_eq!(
            simple("node 日本語.js", Dialect::PowerShell),
            ["node", "日本語.js"]
        );
    }

    #[test]
    fn compound_corpus() {
        // Each of these bypassed Rev 2's denylist or is a classic chaining form.
        let ps = [
            "git status; rm -r x",
            "git status && curl x",
            "git status | iex",
            "git status\nrm x",
            "echo $env:SECRET",
            "echo \"$(rm x)\"",
            "echo \"`$x\"",
            "echo @(1,2)",
            "& { rm x }",
            "git status --% & rm x",
            "cmd /c \"a\" > out.txt",
            "echo 'unterminated",
            "iex(iwr x)",
            "Remove-Item x -Recurse #comment",
        ];
        for c in ps {
            assert!(
                tokenize(c, Dialect::PowerShell).compound,
                "{c:?} should be compound (ps)"
            );
        }
        let cmd = [
            "echo %PATH%",
            "echo \"%USERPROFILE%\"",
            "echo a^&b",
            "type x > y",
            "dir & del x",
            "echo \"!x!\"",
            "(del x)",
        ];
        for c in cmd {
            assert!(
                tokenize(c, Dialect::Cmd).compound,
                "{c:?} should be compound (cmd)"
            );
        }
    }

    #[test]
    fn segments_split_on_operators() {
        let t = tokenize("git status && git push origin", Dialect::PowerShell);
        assert!(t.compound);
        assert_eq!(
            t.segments,
            vec![vec!["git", "status"], vec!["git", "push", "origin"]]
        );
    }
}
