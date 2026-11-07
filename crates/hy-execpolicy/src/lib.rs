//! Starlark exec policy (design §4.1).
//!
//! Policy files call `prefix_rule(...)` and `host_executable(...)`. Rules are
//! layered (embedded default → user → project); every `match` / `not_match`
//! example is checked at load time and any mismatch fails the load.
//! The policy is an approval-reduction layer, not a security boundary.

pub mod tokenize;

use std::cell::RefCell;

use hy_protocol::{Decision, PolicyEval, SandboxMode};
use starlark::any::ProvidesStaticType;
use starlark::environment::{GlobalsBuilder, Module};
use starlark::eval::Evaluator;
use starlark::starlark_module;
use starlark::syntax::{AstModule, Dialect as StarDialect};
use starlark::values::Value;
use starlark::values::none::NoneType;

pub use tokenize::{Dialect, Tokenized, tokenize};

pub const DEFAULT_POLICY: &str = include_str!("../policies/default.star");

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Layer {
    Default,
    User,
    Project { trusted: bool },
}

impl Layer {
    fn name(self) -> &'static str {
        match self {
            Layer::Default => "default",
            Layer::User => "user",
            Layer::Project { .. } => "project",
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum PolicyError {
    #[error("{file}: {message}")]
    Load { file: String, message: String },
    #[error("{file}: rule {rule}: {message}")]
    Example {
        file: String,
        rule: String,
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PatternElem {
    One(String),
    Any(Vec<String>),
}

#[derive(Debug, Clone)]
pub struct Rule {
    pub id: String,
    pub pattern: Vec<PatternElem>,
    pub decision: Decision,
    pub justification: Option<String>,
    pub sandbox: Option<SandboxMode>,
    pub layer: Layer,
}

#[derive(Debug, Clone)]
struct RawRule {
    pattern: serde_json::Value,
    decision: String,
    justification: Option<String>,
    examples_match: serde_json::Value,
    examples_not_match: serde_json::Value,
    sandbox: Option<String>,
    instead: Option<String>,
}

#[derive(Debug, Default, ProvidesStaticType)]
struct Collector {
    rules: RefCell<Vec<RawRule>>,
    hosts: RefCell<Vec<(String, Vec<String>)>>,
}

fn json_of(v: Value) -> anyhow::Result<serde_json::Value> {
    Ok(serde_json::from_str(&v.to_json()?)?)
}

fn missing() -> anyhow::Error {
    anyhow::anyhow!("policy collector missing")
}

/// The justification, with the replacement command a rule names (`instead`).
fn with_instead(justification: Option<String>, instead: Option<&str>) -> Option<String> {
    match (
        justification,
        instead.map(str::trim).filter(|s| !s.is_empty()),
    ) {
        (j, None) => j,
        (None, Some(cmd)) => Some(format!("use instead: {cmd}")),
        (Some(j), Some(cmd)) => Some(format!("{j}; use instead: {cmd}")),
    }
}

#[starlark_module]
fn policy_builtins(builder: &mut GlobalsBuilder) {
    // Starlark keyword arguments, one Rust parameter each.
    #[allow(clippy::too_many_arguments)]
    fn prefix_rule<'v>(
        #[starlark(require = named)] pattern: Value<'v>,
        #[starlark(require = named, default = "allow")] decision: &str,
        #[starlark(require = named)] justification: Option<&str>,
        #[starlark(require = named)] r#match: Option<Value<'v>>,
        #[starlark(require = named)] not_match: Option<Value<'v>>,
        #[starlark(require = named)] sandbox: Option<&str>,
        #[starlark(require = named)] instead: Option<&str>,
        eval: &mut Evaluator<'v, '_, '_>,
    ) -> anyhow::Result<NoneType> {
        let rule = RawRule {
            pattern: json_of(pattern)?,
            decision: decision.to_owned(),
            justification: justification.map(str::to_owned),
            examples_match: match r#match {
                Some(v) => json_of(v)?,
                None => serde_json::Value::Array(vec![]),
            },
            examples_not_match: match not_match {
                Some(v) => json_of(v)?,
                None => serde_json::Value::Array(vec![]),
            },
            sandbox: sandbox.map(str::to_owned),
            instead: instead.map(str::to_owned),
        };
        eval.extra
            .and_then(|e| e.downcast_ref::<Collector>())
            .ok_or_else(missing)?
            .rules
            .borrow_mut()
            .push(rule);
        Ok(NoneType)
    }

    fn host_executable<'v>(
        #[starlark(require = named)] name: &str,
        #[starlark(require = named)] paths: Value<'v>,
        eval: &mut Evaluator<'v, '_, '_>,
    ) -> anyhow::Result<NoneType> {
        let paths: Vec<String> = serde_json::from_value(json_of(paths)?)?;
        eval.extra
            .and_then(|e| e.downcast_ref::<Collector>())
            .ok_or_else(missing)?
            .hosts
            .borrow_mut()
            .push((name.to_owned(), paths));
        Ok(NoneType)
    }
}

/// A loaded, verified, layered policy.
#[derive(Debug, Clone, Default)]
pub struct PolicySet {
    pub rules: Vec<Rule>,
    /// Absolute executable path (lowercased) → canonical program name.
    hosts: Vec<(String, String)>,
    /// Rules dropped because their layer may not grant them.
    pub warnings: Vec<String>,
}

/// Normalizes `argv[0]`: basename, lowercase, without `.exe`/`.cmd`/`.bat`/`.com`.
pub fn program_name(argv0: &str) -> String {
    let base = argv0
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or(argv0)
        .to_lowercase();
    for ext in [".exe", ".cmd", ".bat", ".com", ".ps1"] {
        if let Some(stem) = base.strip_suffix(ext) {
            return stem.to_owned();
        }
    }
    base
}

fn parse_decision(s: &str) -> Option<Decision> {
    match s {
        "allow" => Some(Decision::Allow),
        "prompt" => Some(Decision::Prompt),
        "deny" | "forbidden" => Some(Decision::Deny),
        _ => None,
    }
}

fn parse_sandbox(s: &str) -> Option<SandboxMode> {
    match s {
        "read-only" => Some(SandboxMode::ReadOnly),
        "workspace-write" => Some(SandboxMode::WorkspaceWrite),
        "low-integrity" => Some(SandboxMode::LowIntegrity),
        "unconfined" => Some(SandboxMode::Unconfined),
        _ => None,
    }
}

fn parse_pattern(v: &serde_json::Value) -> Option<Vec<PatternElem>> {
    let arr = v.as_array()?;
    if arr.is_empty() {
        return None;
    }
    let mut out = Vec::new();
    for (i, e) in arr.iter().enumerate() {
        let norm = |s: &str| {
            if i == 0 {
                program_name(s)
            } else {
                s.to_owned()
            }
        };
        match e {
            serde_json::Value::String(s) => out.push(PatternElem::One(norm(s))),
            serde_json::Value::Array(alts) => {
                let mut v = Vec::new();
                for a in alts {
                    v.push(norm(a.as_str()?));
                }
                if v.is_empty() {
                    return None;
                }
                out.push(PatternElem::Any(v));
            }
            _ => return None,
        }
    }
    Some(out)
}

fn pattern_to_string(p: &[PatternElem]) -> String {
    p.iter()
        .map(|e| match e {
            PatternElem::One(s) => s.clone(),
            PatternElem::Any(v) => format!("[{}]", v.join("|")),
        })
        .collect::<Vec<_>>()
        .join(" ")
}

impl Rule {
    /// True when the rule's pattern is a prefix of `argv` (program name normalized).
    pub fn matches(&self, argv: &[String]) -> bool {
        if argv.len() < self.pattern.len() {
            return false;
        }
        self.pattern
            .iter()
            .zip(argv)
            .enumerate()
            .all(|(i, (p, a))| {
                let a = if i == 0 { program_name(a) } else { a.clone() };
                match p {
                    PatternElem::One(s) => *s == a,
                    PatternElem::Any(v) => v.contains(&a),
                }
            })
    }
}

fn examples(v: &serde_json::Value) -> Vec<Vec<String>> {
    let Some(arr) = v.as_array() else {
        return vec![];
    };
    arr.iter()
        .filter_map(|e| match e {
            serde_json::Value::String(s) => Some(
                tokenize(s, Dialect::PowerShell)
                    .segments
                    .into_iter()
                    .next()
                    .unwrap_or_default(),
            ),
            serde_json::Value::Array(toks) => {
                toks.iter().map(|t| t.as_str().map(str::to_owned)).collect()
            }
            _ => None,
        })
        .collect()
}

impl PolicySet {
    /// Embedded default + optional user and project policies.
    pub fn load_layers(
        user: Option<(&str, &str)>,
        project: Option<(&str, &str, bool)>,
    ) -> Result<Self, PolicyError> {
        let mut set = PolicySet::default();
        set.add_source("default.star", DEFAULT_POLICY, Layer::Default)?;
        if let Some((name, text)) = user {
            set.add_source(name, text, Layer::User)?;
        }
        if let Some((name, text, trusted)) = project {
            set.add_source(name, text, Layer::Project { trusted })?;
        }
        Ok(set)
    }

    /// Parses, evaluates and verifies one policy file, then appends its rules.
    pub fn add_source(&mut self, file: &str, text: &str, layer: Layer) -> Result<(), PolicyError> {
        let load_err = |message: String| PolicyError::Load {
            file: file.to_owned(),
            message,
        };
        let ast = AstModule::parse(file, text.to_owned(), &StarDialect::Standard)
            .map_err(|e| load_err(e.to_string()))?;
        let globals = GlobalsBuilder::standard().with(policy_builtins).build();
        let coll = Collector::default();
        Module::with_temp_heap(|module| {
            let mut eval = Evaluator::new(&module);
            eval.extra = Some(&coll);
            eval.eval_module(ast, &globals).map(|_| ())
        })
        .map_err(|e| load_err(e.to_string()))?;

        for (idx, raw) in coll.rules.into_inner().into_iter().enumerate() {
            let pattern = parse_pattern(&raw.pattern).ok_or_else(|| {
                load_err(format!(
                    "rule #{idx}: pattern must be a non-empty list of strings or string lists"
                ))
            })?;
            let id = format!(
                "{}:{}#{} ({})",
                layer.name(),
                file,
                idx,
                pattern_to_string(&pattern)
            );
            let decision = parse_decision(&raw.decision)
                .ok_or_else(|| load_err(format!("{id}: unknown decision {:?}", raw.decision)))?;
            let sandbox = match &raw.sandbox {
                None => None,
                Some(s) => Some(
                    parse_sandbox(s)
                        .ok_or_else(|| load_err(format!("{id}: unknown sandbox {s:?}")))?,
                ),
            };
            let rule = Rule {
                id: id.clone(),
                pattern,
                decision,
                // `instead` (Bun-style guard): a denied or prompted command
                // also says what to run instead, so the agent can fix its
                // next step at once rather than guess.
                justification: with_instead(raw.justification, raw.instead.as_deref()),
                sandbox,
                layer,
            };

            // Load-time unit tests: fail closed on any mismatch.
            for ex in examples(&raw.examples_match) {
                if !rule.matches(&ex) {
                    return Err(PolicyError::Example {
                        file: file.into(),
                        rule: id,
                        message: format!("match example {ex:?} does not match"),
                    });
                }
            }
            for ex in examples(&raw.examples_not_match) {
                if rule.matches(&ex) {
                    return Err(PolicyError::Example {
                        file: file.into(),
                        rule: id,
                        message: format!("not_match example {ex:?} matches"),
                    });
                }
            }

            // Layer restrictions.
            // Both modes are looser than workspace-write (OQ-2, ADR 0001 C).
            // `unconfined` is the user's alone. `low-integrity` may also come
            // from the embedded default, which uses it only for Node test
            // runners: their pipe/IPC child processes fail with EPERM under
            // the write-restricted token (ADR 0001 S-2). A user rule with
            // `sandbox = "workspace-write"` for the same command turns it off
            // (the strictest matching sandbox wins). Project policy may not.
            let looser_allowed = match rule.sandbox {
                Some(SandboxMode::Unconfined) => layer == Layer::User,
                Some(SandboxMode::LowIntegrity) => matches!(layer, Layer::User | Layer::Default),
                _ => true,
            };
            if !looser_allowed {
                self.warnings.push(format!(
                    "{id}: sandbox = \"unconfined\" is honored only in user policy, \"low-integrity\" only in user or default policy; rule ignored"
                ));
                continue;
            }
            if let Layer::Project { trusted: false } = layer {
                if rule.decision == Decision::Allow {
                    self.warnings.push(format!(
                        "{id}: untrusted project policy cannot add allow rules; rule ignored"
                    ));
                    continue;
                }
                if rule.sandbox == Some(SandboxMode::WorkspaceWrite) {
                    self.warnings.push(format!(
                        "{id}: untrusted project policy cannot widen the sandbox; rule ignored"
                    ));
                    continue;
                }
            }
            self.rules.push(rule);
        }
        for (name, paths) in coll.hosts.into_inner() {
            for p in paths {
                self.hosts.push((p.to_lowercase(), program_name(&name)));
            }
        }
        Ok(())
    }

    fn canonical_argv(&self, argv: &[String]) -> Vec<String> {
        let mut out = argv.to_vec();
        if let Some(first) = out.first_mut() {
            let lower = first.to_lowercase();
            if let Some((_, name)) = self.hosts.iter().find(|(p, _)| *p == lower) {
                *first = name.clone();
            }
        }
        out
    }

    /// Evaluates a command line. Most restrictive decision wins; unmatched → prompt.
    pub fn evaluate(&self, command: &str, dialect: Dialect) -> PolicyEval {
        let t = tokenize(command, dialect);
        if t.compound {
            for seg in &t.segments {
                let argv = self.canonical_argv(seg);
                if let Some(rule) = self
                    .rules
                    .iter()
                    .find(|r| r.decision == Decision::Deny && r.matches(&argv))
                {
                    return PolicyEval {
                        decision: Decision::Deny,
                        sandbox: None,
                        justification: rule.justification.clone(),
                        matched_rule: Some(rule.id.clone()),
                        compound: true,
                    };
                }
            }
            return PolicyEval {
                decision: Decision::Prompt,
                sandbox: None,
                justification: Some(format!(
                    "compound command: {}",
                    t.reason.unwrap_or_default()
                )),
                matched_rule: None,
                compound: true,
            };
        }
        let argv = self.canonical_argv(t.argv().unwrap_or(&[]));
        let matched: Vec<&Rule> = self.rules.iter().filter(|r| r.matches(&argv)).collect();
        let Some(strongest) = matched.iter().max_by_key(|r| r.decision) else {
            return PolicyEval {
                decision: Decision::Prompt,
                sandbox: None,
                justification: None,
                matched_rule: None,
                compound: false,
            };
        };
        // A user rule's sandbox replaces the embedded default's (the user may
        // loosen it to unconfined or tighten it back to workspace-write);
        // within a layer, and for project rules, the strictest one wins, so a
        // project can only tighten.
        let strictest = |pick: &dyn Fn(&Layer) -> bool| {
            matched
                .iter()
                .filter(|r| pick(&r.layer))
                .filter_map(|r| r.sandbox)
                .min()
        };
        let user = strictest(&|l| *l == Layer::User);
        let default = strictest(&|l| *l == Layer::Default);
        let project = strictest(&|l| matches!(l, Layer::Project { .. }));
        let sandbox = [user.or(default), project].into_iter().flatten().min();
        PolicyEval {
            decision: strongest.decision,
            sandbox,
            justification: strongest.justification.clone(),
            matched_rule: Some(strongest.id.clone()),
            compound: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn default_set() -> PolicySet {
        match PolicySet::load_layers(None, None) {
            Ok(s) => s,
            Err(e) => panic!("default policy failed: {e}"),
        }
    }

    #[test]
    fn default_policy_loads_and_classifies() {
        let p = default_set();
        let d = |c: &str| p.evaluate(c, Dialect::PowerShell).decision;
        assert_eq!(d("git status"), Decision::Allow);
        assert_eq!(d("git.exe diff --stat"), Decision::Allow);
        assert_eq!(d("git commit -m x"), Decision::Deny);
        assert_eq!(d("git push origin main"), Decision::Deny);
        assert_eq!(d("curl https://example.com"), Decision::Prompt);
        assert_eq!(d("npm install left-pad"), Decision::Prompt);
        assert_eq!(d("cargo test"), Decision::Allow);
        assert_eq!(d("some-unknown-tool"), Decision::Prompt);
        // Compound: deny wins if any segment is denied, otherwise prompt.
        assert_eq!(d("git status; git push"), Decision::Deny);
        assert_eq!(d("git status | Out-Host"), Decision::Prompt);
    }

    #[test]
    fn failing_example_fails_closed() {
        let mut s = PolicySet::default();
        let bad = r#"prefix_rule(pattern = ["git", "status"], match = ["git log"])"#;
        assert!(matches!(
            s.add_source("bad.star", bad, Layer::User),
            Err(PolicyError::Example { .. })
        ));
        let bad2 = r#"prefix_rule(pattern = ["git"], not_match = ["git status"])"#;
        assert!(s.add_source("bad2.star", bad2, Layer::User).is_err());
    }

    #[test]
    fn untrusted_project_is_tighten_only() {
        let project = r#"
prefix_rule(pattern = ["curl"], decision = "allow")
prefix_rule(pattern = ["cargo", "publish"], decision = "deny")
prefix_rule(pattern = ["npm", "test"], sandbox = "unconfined")
"#;
        let s = match PolicySet::load_layers(None, Some(("p.star", project, false))) {
            Ok(s) => s,
            Err(e) => panic!("{e}"),
        };
        assert_eq!(
            s.evaluate("curl x", Dialect::PowerShell).decision,
            Decision::Prompt
        );
        assert_eq!(
            s.evaluate("cargo publish", Dialect::PowerShell).decision,
            Decision::Deny
        );
        // The project's "unconfined" is ignored; the default test-runner rule applies.
        assert_eq!(
            s.evaluate("npm test", Dialect::PowerShell).sandbox,
            Some(SandboxMode::LowIntegrity)
        );
        assert_eq!(s.warnings.len(), 2);
    }

    #[test]
    fn user_policy_may_mark_unconfined() {
        let user = r#"prefix_rule(pattern = ["npm", "test"], sandbox = "unconfined", match = ["npm test", "npm.cmd test --watch=false"])"#;
        let s = match PolicySet::load_layers(Some(("u.star", user)), None) {
            Ok(s) => s,
            Err(e) => panic!("{e}"),
        };
        let e = s.evaluate("npm.cmd test", Dialect::PowerShell);
        assert_eq!(e.sandbox, Some(SandboxMode::Unconfined));
    }

    #[test]
    fn default_policy_runs_node_test_runners_low_integrity() {
        let p = default_set();
        let sb = |c: &str| p.evaluate(c, Dialect::PowerShell).sandbox;
        for c in [
            "node --test",
            "npm test",
            "npm.cmd test",
            "pnpm run test",
            "vitest run",
            "jest --ci",
        ] {
            assert_eq!(sb(c), Some(SandboxMode::LowIntegrity), "{c}");
            assert_eq!(
                p.evaluate(c, Dialect::PowerShell).decision,
                Decision::Allow,
                "{c}"
            );
        }
        for c in ["node script.js", "npm run build", "cargo test"] {
            assert_ne!(sb(c), Some(SandboxMode::LowIntegrity), "{c}");
        }
        // A pipeline is compound: no per-rule sandbox, as before.
        assert_eq!(sb("npm test | Select-String fail"), None);
        // The user can turn it off: the strictest matching sandbox wins.
        let off = r#"prefix_rule(pattern = [["npm", "pnpm", "yarn"], "test"], sandbox = "workspace-write", match = ["npm test"])"#;
        let s = match PolicySet::load_layers(Some(("u.star", off)), None) {
            Ok(s) => s,
            Err(e) => panic!("{e}"),
        };
        assert_eq!(
            s.evaluate("npm test", Dialect::PowerShell).sandbox,
            Some(SandboxMode::WorkspaceWrite)
        );
    }

    #[test]
    fn instead_names_the_command_to_run() {
        let user = r#"
prefix_rule(pattern = ["rustfmt"], decision = "deny", justification = "formats one file with the wrong config", instead = "cargo fmt --all", match = ["rustfmt src/main.rs"])
prefix_rule(pattern = ["make", "release"], decision = "prompt", instead = "make release-dry-run")
"#;
        let s = match PolicySet::load_layers(Some(("u.star", user)), None) {
            Ok(s) => s,
            Err(e) => panic!("{e}"),
        };
        let deny = s.evaluate("rustfmt src/main.rs", Dialect::PowerShell);
        assert_eq!(deny.decision, Decision::Deny);
        assert_eq!(
            deny.justification.as_deref(),
            Some("formats one file with the wrong config; use instead: cargo fmt --all")
        );
        let prompt = s.evaluate("make release", Dialect::PowerShell);
        assert_eq!(
            prompt.justification.as_deref(),
            Some("use instead: make release-dry-run")
        );
    }

    #[test]
    fn unconfined_is_user_policy_only() {
        let rule =
            r#"prefix_rule(pattern = ["mytool"], sandbox = "unconfined", match = ["mytool x"])"#;
        let s = match PolicySet::load_layers(None, Some(("p.star", rule, true))) {
            Ok(s) => s,
            Err(e) => panic!("{e}"),
        };
        assert_eq!(s.evaluate("mytool x", Dialect::PowerShell).sandbox, None);
        assert_eq!(s.warnings.len(), 1);
    }

    #[test]
    fn low_integrity_is_user_policy_only() {
        let rule = r#"prefix_rule(pattern = ["npx", "vitest"], sandbox = "low-integrity", match = ["npx vitest run"])"#;
        let s = match PolicySet::load_layers(Some(("u.star", rule)), None) {
            Ok(s) => s,
            Err(e) => panic!("{e}"),
        };
        assert_eq!(
            s.evaluate("npx vitest run", Dialect::PowerShell).sandbox,
            Some(SandboxMode::LowIntegrity)
        );
        let s = match PolicySet::load_layers(None, Some(("p.star", rule, true))) {
            Ok(s) => s,
            Err(e) => panic!("{e}"),
        };
        assert_eq!(
            s.evaluate("npx vitest run", Dialect::PowerShell).sandbox,
            None
        );
        assert_eq!(s.warnings.len(), 1);
    }

    #[test]
    fn alternatives_and_host_executable() {
        let user = r#"
host_executable(name = "git", paths = ["C:\\Program Files\\Git\\cmd\\git.exe"])
prefix_rule(pattern = ["git", ["fetch", "pull"]], decision = "deny", match = ["git fetch", "git pull --rebase"], not_match = ["git status"])
"#;
        let s = match PolicySet::load_layers(Some(("u.star", user)), None) {
            Ok(s) => s,
            Err(e) => panic!("{e}"),
        };
        assert_eq!(
            s.evaluate(
                "'C:\\Program Files\\Git\\cmd\\git.exe' pull",
                Dialect::PowerShell
            )
            .decision,
            Decision::Deny
        );
    }
}
