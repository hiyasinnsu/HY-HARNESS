"""Phase 1 spike driver: builds NTFS fixtures under %USERPROFILE%\hy-spike-fixture, grants
them, runs the S-1..S-6 matrix through win-sandbox.exe, revokes and cleans up.

Every ACL change is confined to the fixture root; `assert_fixture` enforces it.

    python -I run_matrix.py [setup|s3|s2|s4|s5|s6|revoke|s1|cleanup|all]...
"""

import json
import os
import shutil
import stat
import subprocess
import sys
import time
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

HERE = Path(__file__).resolve().parent
EXE = HERE / "target" / "release" / "win-sandbox.exe"
# Not under %TEMP%: AppData carries package-SID ACEs a Low-IL token cannot open (see results).
ROOT = Path(os.environ.get("HY_SPIKE_ROOT", Path(os.environ["USERPROFILE"]) / "hy-spike-fixture"))
WS, WSB, OUT, TMP, LOGS = (ROOT / n for n in ("ws", "wsB", "outside", "tmpA", "logs"))
RESULTS = HERE / "results"
RESULTS_FILE = RESULTS / "results.json"
TSC = Path(r"F:\HY-HARNESS\node_modules\typescript\lib\tsc.js")
NODE = shutil.which("node") or r"C:\Program Files\nodejs\node.exe"
GIT_BASH = r"C:\Program Files\Git\bin\bash.exe"


def is_reparse(p: Path) -> bool:
    try:
        return bool(os.lstat(p).st_file_attributes & 0x400)  # FILE_ATTRIBUTE_REPARSE_POINT
    except OSError:
        return False


def assert_fixture(p: Path) -> Path:
    p = Path(p).resolve()
    if ROOT.resolve() not in (p, *p.parents):
        raise SystemExit(f"refusing to touch {p}: outside {ROOT}")
    return p


def load_results() -> dict:
    if RESULTS_FILE.exists():
        return json.loads(RESULTS_FILE.read_text(encoding="utf-8"))
    return {}


def save(section: str, value) -> None:
    RESULTS.mkdir(exist_ok=True)
    r = load_results()
    r[section] = value
    RESULTS_FILE.write_text(json.dumps(r, ensure_ascii=False, indent=2), encoding="utf-8")


def spike(*args: str, timeout: int = 900) -> dict:
    p = subprocess.run([str(EXE), *args], capture_output=True, timeout=timeout)
    out = p.stdout.decode("utf-8", "replace").strip()
    try:
        return json.loads(out.splitlines()[-1])
    except (json.JSONDecodeError, IndexError):
        return {"error": "no json", "stdout": out, "stderr": p.stderr.decode("utf-8", "replace")}


def run(cmd: str, mode: str = "ww", console: str = "inherit", cwd: Path | None = None, extra: list[str] | None = None) -> dict:
    a = ["run", "--mode", mode, "--workspace", str(WS), "--temp", str(TMP), "--console", console]
    if cwd:
        a += ["--cwd", str(cwd)]
    a += extra or []
    # HY_SPIKE_VARIANT reruns a phase with a token variant (src/variant.rs), e.g. "norestrict".
    if os.environ.get("HY_SPIKE_VARIANT") and mode != "none":
        a += ["--variant", os.environ["HY_SPIKE_VARIANT"]]
    return spike(*a, "--", cmd)


def brief(r: dict) -> dict:
    keys = ("exitCode", "exitHex", "timedOut", "ms", "stdout", "stderr", "error")
    return {k: (r[k][-600:] if isinstance(r.get(k), str) else r.get(k)) for k in keys if k in r}


# ---------------------------------------------------------------- setup

S2_NODE = r"""
const cp = require('child_process');
const { Worker } = require('worker_threads');
const path = require('path');
const out = {};
const node = process.execPath;
function t(name, f) { try { out[name] = f(); } catch (e) { out[name] = 'ERR ' + (e.code || '') + ' ' + String(e.message).split('\n')[0]; } }
function r(x) { return x.error ? 'ERR ' + x.error.code + ' ' + x.error.message : 'status=' + x.status + (x.stdout ? ' out=' + String(x.stdout).trim() : ''); }
t('spawnSyncPipe', () => r(cp.spawnSync(node, ['-e', 'console.log(42)'], { stdio: 'pipe' })));
t('spawnSyncInherit', () => r(cp.spawnSync(node, ['-e', '0'], { stdio: 'inherit' })));
t('spawnSyncIgnore', () => r(cp.spawnSync(node, ['-e', '0'], { stdio: 'ignore' })));
t('execSyncCmd', () => String(cp.execSync('cmd /d /c echo 7')).trim());
t('spawnSyncWindowsHide', () => r(cp.spawnSync('cmd', ['/d', '/c', 'echo hidden'], { stdio: 'pipe', windowsHide: true })));
const asyncTests = [
  ['spawnAsyncPipe', () => new Promise((res) => {
    const c = cp.spawn(node, ['-e', 'console.log(1)']);
    let s = ''; c.stdout.on('data', (d) => (s += d));
    c.on('error', (e) => res('ERR ' + e.code + ' ' + e.message));
    c.on('close', (code) => res('code=' + code + ' out=' + s.trim()));
  })],
  ['forkIpc', () => new Promise((res) => {
    let c;
    try { c = cp.fork(path.join(__dirname, 's2_child.js')); } catch (e) { return res('ERR ' + e.code + ' ' + e.message); }
    const timer = setTimeout(() => { res('TIMEOUT'); c.kill(); }, 10000);
    c.on('error', (e) => { clearTimeout(timer); res('ERR ' + e.code + ' ' + e.message); });
    c.on('message', (m) => { clearTimeout(timer); res('reply=' + m); });
    c.send(21);
  })],
  ['workerThread', () => new Promise((res) => {
    const w = new Worker('require("worker_threads").parentPort.postMessage(5)', { eval: true });
    w.on('message', (m) => res('msg=' + m));
    w.on('error', (e) => res('ERR ' + e.message));
  })],
];
(async () => {
  for (const [n, f] of asyncTests) { try { out[n] = await f(); } catch (e) { out[n] = 'ERR ' + e.message; } }
  console.log(JSON.stringify(out));
  process.exit(0);
})();
"""

S2_CHILD = "process.on('message', (m) => { process.send(m * 2); setTimeout(() => process.exit(0), 50); });\n"

PTC_PROBE = r"""
const fs = require('fs');
const cp = require('child_process');
const path = require('path');
const ws = process.argv[2];
const exfat = process.argv[3];
const out = {};
function t(n, f) { try { out[n] = f(); } catch (e) { out[n] = 'ERR ' + (e.code || '') + ' ' + String(e.message).split('\n')[0]; } }
t('start', () => 'ok ' + process.version);
t('readWorkspace', () => fs.readFileSync(path.join(ws, 'README.md'), 'utf8').slice(0, 10));
t('writeWorkspace', () => { fs.writeFileSync(path.join(ws, 's5_appc.txt'), 'x'); return 'WROTE'; });
t('writeTemp', () => { fs.writeFileSync(path.join(require('os').tmpdir(), 's5_appc.txt'), 'x'); return 'WROTE'; });
t('writeExfat', () => { fs.writeFileSync(exfat, 'x'); return 'WROTE'; });
// Piped stdio hangs inside an AppContainer (the job timeout kills it), so probe with 'ignore'.
t('spawnCmd', () => { const r = cp.spawnSync('cmd', ['/d', '/c', 'echo hi'], { stdio: 'ignore', timeout: 5000 }); return r.error ? 'ERR ' + r.error.code : 'status=' + r.status; });
t('tmpdir', () => require('os').tmpdir());
const sock = require('net').connect({ host: '1.1.1.1', port: 80 });
sock.on('connect', () => { out.network = 'CONNECTED'; done(); });
sock.on('error', (e) => { out.network = 'ERR ' + e.code; done(); });
let finished = false;
setTimeout(() => { out.network = out.network || 'NO RESULT (6s deadline)'; done(); }, 6000);
function done() { if (finished) return; finished = true; console.log(JSON.stringify(out)); process.exit(0); }
"""


def git(*args: str, cwd: Path) -> None:
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True)


def setup() -> None:
    if ROOT.exists():
        cleanup()
    for d in (WS, WSB, OUT, TMP, LOGS, WS / ".hy-harness", WS / "ts", WS / "src"):
        d.mkdir(parents=True, exist_ok=True)
    (WS / "README.md").write_text("# fixture\n", encoding="utf-8")
    (WS / "existing_ws.txt").write_text("delete me\n", encoding="utf-8")
    (WS / "ws_file.txt").write_text("move me\n", encoding="utf-8")
    (WS / ".gitignore").write_text("target/\ndist/\n", encoding="utf-8")
    (WS / ".hy-harness" / "config.json").write_text("{}\n", encoding="utf-8")
    (WS / "package.json").write_text(json.dumps({"name": "fx", "version": "1.0.0", "scripts": {"test": "node test.js"}}), encoding="utf-8")
    (WS / "test.js").write_text("console.log('tests pass');\n", encoding="utf-8")
    (WS / "s2_node.js").write_text(S2_NODE, encoding="utf-8")
    (WS / "s2_child.js").write_text(S2_CHILD, encoding="utf-8")
    (WS / "ts" / "tsconfig.json").write_text(
        json.dumps({"compilerOptions": {"outDir": "../dist", "strict": True, "target": "ES2022", "module": "commonjs"}, "include": ["*.ts"]}),
        encoding="utf-8",
    )
    (WS / "ts" / "a.ts").write_text("export const x: number = 1;\n", encoding="utf-8")
    (WS / "Cargo.toml").write_text('[package]\nname = "fx"\nversion = "0.1.0"\nedition = "2021"\n', encoding="utf-8")
    (WS / "src" / "lib.rs").write_text(
        "pub fn add(a: i32, b: i32) -> i32 { a + b }\n#[cfg(test)]\nmod t { #[test] fn w() { assert_eq!(super::add(1, 2), 3); } }\n",
        encoding="utf-8",
    )
    (WS / "src" / "main.rs").write_text('fn main() { println!("{}", fx::add(1, 2)); }\n', encoding="utf-8")
    git("init", "-q", cwd=WS)
    git("add", "-A", cwd=WS)
    git("-c", "user.email=spike@example.invalid", "-c", "user.name=spike", "commit", "-q", "-m", "fixture", cwd=WS)
    (WSB / "b.txt").write_text("workspace B\n", encoding="utf-8")
    for n in ("victim.txt", "victim2.txt", "hl_src.txt"):
        (OUT / n).write_text(f"original {n}\n", encoding="utf-8")
    os.link(OUT / "hl_src.txt", WS / "hl.txt")
    subprocess.run(["cmd", "/d", "/c", "mklink", "/J", str(WS / "junc"), str(OUT)], check=True, capture_output=True)

    info = spike("info")
    grants = {}
    for root, kind in ((WS, "workspace"), (WSB, "workspace"), (TMP, "temp")):
        assert_fixture(root)
        grants[root.name] = spike("grant", "--root", str(root), "--kind", kind, "--log", str(LOGS / f"{root.name}.jsonl"))
    save("setup", {"info": info, "grants": grants})
    print(json.dumps(grants, ensure_ascii=False, indent=1)[:4000])


# ---------------------------------------------------------------- S-3

def s3() -> None:
    res = {}

    def case(name, cmd, check, mode="ww"):
        r = run(cmd, mode=mode)
        ok = check()
        res[name] = {"expectHolds": ok, **brief(r)}
        print(f"{name:32} {'PASS' if ok else 'FAIL'} exit={r.get('exitHex')} {r.get('error', '')}")

    t = lambda p: (WS / p)
    case("ws_write", "cmd /d /c echo x> s3_new.txt", lambda: t("s3_new.txt").exists())
    case("ws_delete", "cmd /d /c del /q existing_ws.txt", lambda: not t("existing_ws.txt").exists())
    case("ws_mkdir_rmdir_tree", "cmd /d /c mkdir s3_sub\\deep && echo x> s3_sub\\deep\\f.txt && rmdir /s /q s3_sub",
         lambda: not t("s3_sub").exists())
    case("ws_rename", "cmd /d /c ren README.md README2.md && ren README2.md README.md", lambda: t("README.md").exists())
    case("outside_write", f"cmd /d /c echo x> \"{OUT}\\s3_out.txt\"", lambda: not (OUT / "s3_out.txt").exists())
    case("outside_overwrite", f"cmd /d /c echo x> \"{OUT}\\victim.txt\"",
         lambda: (OUT / "victim.txt").read_text() == "original victim.txt\n")
    case("outside_delete", f"cmd /d /c del /q \"{OUT}\\victim.txt\"", lambda: (OUT / "victim.txt").exists())
    case("outside_move_into_ws", f"cmd /d /c move \"{OUT}\\victim2.txt\" .", lambda: (OUT / "victim2.txt").exists())
    case("ws_move_to_outside", f"cmd /d /c move ws_file.txt \"{OUT}\\\"", lambda: not (OUT / "ws_file.txt").exists())
    case("cross_root_write", f"cmd /d /c echo x> \"{WSB}\\s3_cross.txt\"", lambda: not (WSB / "s3_cross.txt").exists())
    case("cross_root_delete", f"cmd /d /c del /q \"{WSB}\\b.txt\"", lambda: (WSB / "b.txt").exists())
    cfg = (WS / ".git" / "config").read_text()
    case("git_config_append", "cmd /d /c echo x>> .git\\config", lambda: (WS / ".git" / "config").read_text() == cfg)
    case("git_new_file", "cmd /d /c echo x> .git\\s3_new", lambda: not (WS / ".git" / "s3_new").exists())
    case("git_delete_head", "cmd /d /c del /q .git\\HEAD", lambda: (WS / ".git" / "HEAD").exists())
    case("git_rename_dir", "cmd /d /c ren .git git_renamed", lambda: (WS / ".git").is_dir() and not (WS / "git_renamed").exists())
    case("hy_harness_write", "cmd /d /c echo x> .hy-harness\\config.json",
         lambda: (WS / ".hy-harness" / "config.json").read_text() == "{}\n")
    case("hy_harness_rename", "cmd /d /c ren .hy-harness hy_renamed", lambda: (WS / ".hy-harness").is_dir())
    case("hardlink_overwrite", "cmd /d /c echo evil> hl.txt", lambda: (OUT / "hl_src.txt").read_text() == "original hl_src.txt\n")
    case("hardlink_delete_ws_name", "cmd /d /c del /q hl.txt", lambda: (WS / "hl.txt").exists())
    case("junction_write", "cmd /d /c echo x> junc\\s3_j.txt", lambda: not (OUT / "s3_j.txt").exists())
    case("junction_replace", "cmd /d /c rmdir junc && mkdir junc", lambda: is_reparse(WS / "junc"))
    case("temp_write", "cmd /d /c echo x> %TEMP%\\s3_t.txt", lambda: (TMP / "s3_t.txt").exists())
    prof = Path(os.environ["USERPROFILE"]) / "hy_s3_probe.txt"
    case("userprofile_write", f"cmd /d /c echo x> \"{prof}\"", lambda: not prof.exists())
    if prof.exists():
        prof.unlink()
    exfat = HERE / "s3_exfat_probe.txt"
    case("exfat_write_GAP", f"cmd /d /c echo x> \"{exfat}\"", lambda: exfat.exists())
    if exfat.exists():
        exfat.unlink()
    case("outside_read_GAP", f"cmd /d /c type \"{OUT}\\victim.txt\"", lambda: True)
    reg = subprocess.run(["reg", "query", r"HKCU\Software\hy-spike-probe"], capture_output=True).returncode
    case("hkcu_write", r"reg add HKCU\Software\hy-spike-probe /f",
         lambda: subprocess.run(["reg", "query", r"HKCU\Software\hy-spike-probe"], capture_output=True).returncode != 0)
    if reg != 0:
        subprocess.run(["reg", "delete", r"HKCU\Software\hy-spike-probe", "/f"], capture_output=True)
    # A .git created after the grant (no .git at grant time).
    late = ROOT / "wsLate"
    late.mkdir(exist_ok=True)
    spike("grant", "--root", str(late), "--log", str(LOGS / "wsLate.jsonl"))
    git("init", "-q", cwd=late)
    cfg_late = (late / ".git" / "config").read_text()
    r = spike("run", "--mode", "ww", "--workspace", str(late), "--", "cmd /d /c echo [core]fsmonitor = evil>> .git\config")
    res["late_git_config_append"] = {"expectHolds": (late / ".git" / "config").read_text() == cfg_late, **brief(r)}
    print(f"{'late_git_config_append':32} {'PASS' if res['late_git_config_append']['expectHolds'] else 'FAIL'} exit={r.get('exitHex')}")
    case("ro_ws_write", "cmd /d /c echo x> s3_ro.txt", lambda: not t("s3_ro.txt").exists(), mode="ro")
    # Writes into another session's granted root and the user's LocalLow (Low-labeled by Windows).
    lowlow = Path(os.environ["USERPROFILE"]) / "AppData" / "LocalLow" / "hy_s3_probe.txt"
    case("locallow_write", f"cmd /d /c echo x> \"{lowlow}\"", lambda: not lowlow.exists())
    lowlow.unlink(missing_ok=True)
    v = os.environ.get("HY_SPIKE_VARIANT")
    save(f"s3_{v}" if v else "s3", res)


# ---------------------------------------------------------------- S-2 + exit criterion

def s2() -> None:
    res = {}

    def case(name, cmd, mode="ww", check=None, extra=None):
        r = run(cmd, mode=mode, extra=extra)
        entry = brief(r)
        if check:
            entry["artifact"] = check()
        res[f"{mode}:{name}"] = entry
        print(f"{mode}:{name:28} exit={r.get('exitHex')} {str(entry.get('artifact', ''))} {r.get('error', '')}")
        return r

    for mode in ("ww", "ro"):
        case("cmd_echo", "cmd /d /c echo hi", mode)
        case("node_version", f"\"{NODE}\" -e \"console.log(process.version)\"", mode)
        case("node_child_matrix", f"\"{NODE}\" s2_node.js", mode)
        case("npm_version", "cmd /d /c npm --version", mode)
        case("npm_test", "cmd /d /c npm test", mode)
        case("tsc_build", f"\"{NODE}\" \"{TSC}\" -p ts", mode, check=lambda: (WS / "dist" / "a.js").exists())
        case("git_status", "git status --porcelain", mode)
        case("git_add", "git add -A", mode)
        case("cargo_build", "cargo build --offline", mode, check=lambda: (WS / "target" / "debug" / "fx.exe").exists())
        case("cargo_test", "cargo test --offline", mode)
        case("winps_51", "powershell -NoProfile -NonInteractive -Command \"(Get-ChildItem).Count; 'ok' | Set-Content s2_ps.txt\"",
             mode, check=lambda: (WS / "s2_ps.txt").exists())
        case("git_bash", f"\"{GIT_BASH}\" -c \"echo hi; ls | wc -l; echo x > s2_bash.txt\"", mode,
             check=lambda: (WS / "s2_bash.txt").exists())
        for p in ("dist", "target", "s2_ps.txt", "s2_bash.txt"):
            q = assert_fixture(WS / p)
            rmtree(q) if q.is_dir() else q.unlink(missing_ok=True)
    # S-2 variant: the caller's original default DACL instead of the draft's.
    case("node_child_matrix_origDacl", f"\"{NODE}\" s2_node.js", "ww", extra=["--dacl", "orig"])
    # Baselines without the token.
    case("node_child_matrix", f"\"{NODE}\" s2_node.js", "none")
    case("cargo_build", "cargo build --offline", "none", check=lambda: (WS / "target" / "debug" / "fx.exe").exists())
    rmtree(WS / "target")
    save("s2", res)


# ---------------------------------------------------------------- S-4

def s4() -> None:
    res = {}
    for console in ("inherit", "hidden", "nowindow", "conpty"):
        for name, cmd in (("cmd_echo", "cmd /d /c echo hi"), ("node_version", f"\"{NODE}\" -e \"console.log(1)\""),
                          ("node_child_matrix", f"\"{NODE}\" s2_node.js")):
            r = run(cmd, console=console)
            res[f"{console}:{name}"] = brief(r)
            print(f"{console:9}{name:20} exit={r.get('exitHex')} {r.get('error', '')}")
    save("s4", res)


# ---------------------------------------------------------------- S-5

def s5() -> None:
    # AppContainers cannot read exFAT (F:) or ordinary user dirs: the worker lives in a
    # directory readable by ALL APPLICATION PACKAGES, as an installed worker would.
    ptc = assert_fixture(ROOT / "ptc")
    ptc.mkdir(exist_ok=True)
    subprocess.run(["icacls", str(ptc), "/grant", "*S-1-15-2-1:(OI)(CI)(RX)"], check=True, capture_output=True)
    script = ptc / "ptc_probe.js"
    script.write_text(PTC_PROBE, encoding="utf-8")
    exfat = HERE / "s5_exfat_probe.txt"
    res = {}
    for single in (False, True):
        args = ["appc", "--cwd", str(ptc)] + (["--single-process"] if single else [])
        # --preserve-symlinks-main: an AppContainer cannot lstat C:\, so the main-module realpath fails.
        r = spike(*args, "--", f"\"{NODE}\" --preserve-symlinks --preserve-symlinks-main \"{script}\" \"{WS}\" \"{exfat}\"")
        res["singleProcess" if single else "default"] = {**brief(r), "profileDeleted": r.get("profileDeleted")}
        print(json.dumps(res["singleProcess" if single else "default"], ensure_ascii=False)[:800])
        exfat.unlink(missing_ok=True)
    (WS / "s5_appc.txt").unlink(missing_ok=True)
    save("s5", res)


# ---------------------------------------------------------------- S-6

def s6() -> None:
    r = spike("probe", "--workspace", str(WS), "--outside", str(OUT), "--hardlink", str(WS / "hl.txt"), "--iterations", "200")
    print(json.dumps(r, ensure_ascii=False, indent=1))
    save("s6", r)


# ---------------------------------------------------------------- revoke / cleanup

def revoke() -> None:
    res = {}
    for name in ("ws", "wsB", "tmpA", "wsLate"):
        log = LOGS / f"{name}.jsonl"
        if log.exists():
            res[name] = spike("revoke", "--log", str(log))
            print(name, json.dumps(res[name], ensure_ascii=False)[:600])
    save("revoke", res)


def cleanup() -> None:
    if not ROOT.exists():
        return
    # Remove junctions first so rmtree never walks into their targets.
    for dirpath, dirnames, _ in os.walk(ROOT):
        for d in list(dirnames):
            p = Path(dirpath) / d
            if is_reparse(p):
                os.rmdir(p)
                dirnames.remove(d)
    rmtree(ROOT)
    if ROOT.exists():
        raise SystemExit(f"cleanup left files behind in {ROOT}")
    print("cleanup: done")


def rmtree(p: Path) -> None:
    """rmtree that clears the read-only attribute (git objects) instead of giving up."""
    def onerror(func, path, _exc):
        os.chmod(path, stat.S_IWRITE)
        func(path)
    if p.exists():
        shutil.rmtree(assert_fixture(p), onerror=onerror)


# ---------------------------------------------------------------- S-1

def make_tree(base: Path, files: int, store: Path | None) -> int:
    """npm-like nested tree; with `store`, files are hard links into the store (pnpm-like)."""
    per_pkg = 64
    made = 0
    pkg = 0
    while made < files:
        rel = Path(f"pkg{pkg:05d}") / "lib" / f"sub{pkg % 7}"
        tgt = base / rel
        tgt.mkdir(parents=True, exist_ok=True)
        if store is not None:
            (store / rel).mkdir(parents=True, exist_ok=True)
        for i in range(min(per_pkg, files - made)):
            name = f"m{i:03d}.js"
            body = f"module.exports = {pkg * 1000 + i};\n" * (1 + i % 5)
            if store is None:
                (tgt / name).write_text(body, encoding="utf-8")
            else:
                s = store / rel / name
                s.write_text(body, encoding="utf-8")
                os.link(s, tgt / name)
            made += 1
        pkg += 1
    return made


def s1() -> None:
    n = int(os.environ.get("S1_FILES", "100000"))
    res = {}
    for layout in ("npm", "pnpm"):
        ws = assert_fixture(ROOT / f"s1_{layout}")
        store = assert_fixture(ROOT / "s1_store") if layout == "pnpm" else None
        rmtree(ws)
        if store:
            rmtree(store)
            store.mkdir(parents=True)
        nm = ws / "node_modules"
        nm.mkdir(parents=True)
        t0 = time.time()
        made = make_tree(nm / (".pnpm" if store else ""), n, store)
        gen_s = time.time() - t0
        log = LOGS / f"s1_{layout}.jsonl"
        LOGS.mkdir(parents=True, exist_ok=True)
        entry = {"files": made, "generateSec": round(gen_s, 1)}
        for th in (1, 8):
            entry[f"dryRun_t{th}"] = spike("grant", "--root", str(ws), "--dry-run", "--threads", str(th), "--log", str(log))
        entry["grant_t8"] = g = spike("grant", "--root", str(ws), "--threads", "8", "--log", str(log))
        # Confined write into a hard-linked file must not reach the store.
        if store:
            first = next((nm / ".pnpm").rglob("m000.js"))
            rel = first.relative_to(nm / ".pnpm")
            before = (store / rel).read_text()
            r = spike("run", "--mode", "ww", "--workspace", str(ws), "--", f"cmd /d /c echo evil> \"{first}\"")
            entry["hardlinkWrite"] = {**brief(r), "storeUnchanged": (store / rel).read_text() == before}
        r = spike("run", "--mode", "ww", "--workspace", str(ws), "--", "cmd /d /c echo ok> node_modules\\s1_new.txt")
        entry["newFileWrite"] = {**brief(r), "created": (nm / "s1_new.txt").exists()}
        entry["revoke"] = spike("revoke", "--log", str(log))
        for k in ("dryRun_t1", "dryRun_t8", "grant_t8", "revoke"):
            v = entry[k]
            print(layout, k, {x: v.get(x) for x in ("objects", "changed", "skippedHardLinks", "failed", "enumerateMs", "applyMs",
                                                     "totalMs", "restored", "restoreMs", "leftoverObjectsNamingSid", "error")})
        entry = {k: ({x: y for x, y in v.items() if not x.endswith("Sample")} if isinstance(v, dict) else v) for k, v in entry.items()}
        res[layout] = entry
        rmtree(ws)
        if store:
            rmtree(store)
    save("s1", res)


PHASES = {"setup": setup, "s3": s3, "s2": s2, "s4": s4, "s5": s5, "s6": s6, "revoke": revoke, "s1": s1, "cleanup": cleanup}

if __name__ == "__main__":
    steps = sys.argv[1:] or ["all"]
    if steps == ["all"]:
        steps = ["setup", "s3", "s2", "s4", "s5", "s6", "revoke", "s1", "cleanup"]
    for s in steps:
        print(f"===== {s}")
        PHASES[s]()
