# HY-HARNESS embedded default exec policy (design §4.1).
# The policy reduces approval prompts; it is not a security boundary.
# Every rule's match / not_match examples are checked at load time.

# Read-only inspection.
prefix_rule(
    pattern = ["git", ["status", "diff", "log", "show", "rev-parse", "ls-files", "blame", "grep", "describe", "shortlog"]],
    decision = "allow",
    justification = "read-only git inspection",
    match = ["git status", "git diff --stat", "git log -n 5"],
    not_match = ["git commit", "git push"],
)
prefix_rule(
    pattern = [["rg", "ls", "dir", "cat", "type", "where", "findstr", "get-childitem", "get-content", "select-string", "get-location", "test-path", "resolve-path", "measure-object", "pwd", "echo", "write-output"]],
    decision = "allow",
    justification = "read-only file inspection",
    match = ["rg TODO src", "Get-ChildItem -Recurse", "cat README.md"],
)

# The run owns HEAD: history-changing git commands are denied for the worker.
prefix_rule(
    pattern = ["git", ["commit", "reset", "checkout", "switch", "rebase", "stash", "push", "update-ref", "gc", "merge", "cherry-pick", "tag", "branch", "restore", "clean", "am", "apply", "worktree", "filter-branch", "replace", "notes", "config"]],
    decision = "deny",
    justification = "the harness owns HEAD, refs and the index during a run",
    match = ["git commit -m x", "git push origin main", "git update-ref -d refs/hy/x", "git reset --hard"],
    not_match = ["git status"],
)

# Network clients and package installs need approval.
prefix_rule(
    pattern = [["curl", "wget", "invoke-webrequest", "iwr", "invoke-restmethod", "irm", "ssh", "scp", "sftp", "ftp", "nc", "ncat", "telnet", "start-bitstransfer"]],
    decision = "prompt",
    justification = "network client",
    match = ["curl https://example.com", "Invoke-WebRequest x"],
)
prefix_rule(
    pattern = ["git", ["clone", "fetch", "pull", "ls-remote", "submodule"]],
    decision = "prompt",
    justification = "git network access",
    match = ["git fetch origin"],
)
prefix_rule(
    pattern = [["npm", "pnpm", "yarn"], ["install", "i", "add", "ci", "update", "up", "publish", "exec", "dlx", "x"]],
    decision = "prompt",
    justification = "package install or remote execution",
    match = ["npm install left-pad", "pnpm add -D x", "npm ci"],
    not_match = ["npm test"],
)
prefix_rule(pattern = ["npx"], decision = "prompt", justification = "downloads and runs packages")
prefix_rule(pattern = [["pip", "pip3"], ["install", "download", "uninstall"]], decision = "prompt", justification = "package install")
prefix_rule(pattern = ["cargo", ["install", "add", "publish", "login", "owner", "yank"]], decision = "prompt", justification = "registry access")
prefix_rule(pattern = [["winget", "choco", "scoop"]], decision = "prompt", justification = "system package manager")

# Build and test commands run model-editable code; the sandbox limits them, not the policy.
prefix_rule(
    pattern = ["cargo", ["build", "check", "test", "clippy", "fmt", "run", "doc", "bench", "tree", "metadata"]],
    decision = "allow",
    justification = "build/test",
    match = ["cargo test -p x", "cargo build --release"],
    not_match = ["cargo install ripgrep"],
)
prefix_rule(
    pattern = [["npm", "pnpm", "yarn"], ["test", "run", "build", "t", "ls", "list", "why", "outdated"]],
    decision = "allow",
    justification = "build/test",
    match = ["npm test", "npm.cmd run build"],
)
prefix_rule(pattern = [["tsc", "node", "deno", "bun", "pytest", "go", "dotnet", "make", "cmake", "ninja", "msbuild", "gradle", "mvn", "rustc", "rustfmt", "eslint", "prettier", "vitest", "jest"]], decision = "allow", justification = "build/test")
prefix_rule(pattern = [["python", "python3", "py"], "-m", ["pytest", "unittest", "mypy", "black", "ruff"]], decision = "allow", justification = "build/test")
