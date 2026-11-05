// Measures Rust unit-test coverage for the pure-logic modules using
// `llvm-tools-preview` (`llvm-profdata` + `llvm-cov`) without requiring an
// external `cargo-llvm-cov` wrapper binary.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const covDir = path.join(os.tmpdir(), `hy-rust-cov-${process.pid}`)
const covTargetDir = path.join(repo, 'target', 'llvm-cov')
fs.mkdirSync(covDir, { recursive: true })
fs.mkdirSync(covTargetDir, { recursive: true })

function findLlvmBinDir() {
  const sysroot = spawnSync('rustc', ['--print', 'sysroot'], { encoding: 'utf8' }).stdout.trim()
  const hostLine = spawnSync('rustc', ['-vV'], { encoding: 'utf8' })
    .stdout.split(/\r?\n/)
    .find((l) => l.startsWith('host:'))
  const host = hostLine ? hostLine.slice(5).trim() : 'x86_64-pc-windows-msvc'
  const binDir = path.join(sysroot, 'lib', 'rustlib', host, 'bin')
  if (!fs.existsSync(path.join(binDir, 'llvm-cov.exe')) && !fs.existsSync(path.join(binDir, 'llvm-cov'))) {
    throw new Error(`llvm-cov not found in ${binDir}; run: rustup component add llvm-tools-preview`)
  }
  return binDir
}

try {
  const llvmBin = findLlvmBinDir()
  const profdata = path.join(llvmBin, process.platform === 'win32' ? 'llvm-profdata.exe' : 'llvm-profdata')
  const llvmCov = path.join(llvmBin, process.platform === 'win32' ? 'llvm-cov.exe' : 'llvm-cov')

  const testRun = spawnSync(
    'cargo',
    ['test', '--workspace', '--no-fail-fast', '--message-format=json'],
    {
      cwd: repo,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        CARGO_INCREMENTAL: '0',
        CARGO_TARGET_DIR: covTargetDir,
        RUSTFLAGS: '-C instrument-coverage',
        LLVM_PROFILE_FILE: path.join(covDir, 'hy-%p-%m.profraw'),
      },
    },
  )
  if (testRun.status !== 0) {
    process.stderr.write(testRun.stderr)
    process.exit(testRun.status ?? 1)
  }

  const binaries = []
  for (const line of testRun.stdout.split(/\r?\n/)) {
    if (!line.startsWith('{')) continue
    try {
      const msg = JSON.parse(line)
      if (msg.reason === 'compiler-artifact' && msg.profile?.test && msg.executable) {
        binaries.push(msg.executable)
      }
    } catch {
      // ignore non-artifact lines
    }
  }

  const profraws = fs
    .readdirSync(covDir)
    .filter((n) => n.endsWith('.profraw'))
    .map((n) => path.join(covDir, n))
  if (profraws.length === 0) throw new Error('no .profraw files produced')

  const merged = path.join(covDir, 'merged.profdata')
  const mergeRes = spawnSync(profdata, ['merge', '-sparse', ...profraws, '-o', merged], { encoding: 'utf8' })
  if (mergeRes.status !== 0) throw new Error(`llvm-profdata failed: ${mergeRes.stderr}`)

  const objArgs = binaries.flatMap((b, i) => (i === 0 ? [b] : ['-object', b]))
  const ignoreRegex = '(\\.cargo[/\\\\]registry|rustc[/\\\\]|tests)'

  const report = spawnSync(
    llvmCov,
    ['report', `--instr-profile=${merged}`, `--ignore-filename-regex=${ignoreRegex}`, ...objArgs],
    { cwd: repo, encoding: 'utf8' },
  )
  if (report.status !== 0) throw new Error(`llvm-cov report failed: ${report.stderr}`)
  console.log(report.stdout)

  const exp = spawnSync(
    llvmCov,
    ['export', '--summary-only', `--instr-profile=${merged}`, `--ignore-filename-regex=${ignoreRegex}`, ...objArgs],
    { cwd: repo, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  )
  if (exp.status !== 0) throw new Error(`llvm-cov export failed: ${exp.stderr}`)
  const data = JSON.parse(exp.stdout).data[0]
  const pureTargets = [
    'hy-execpolicy\\src\\lib.rs',
    'hy-execpolicy\\src\\tokenize.rs',
    'hy-exec-server\\src\\patch.rs',
    'hy-exec-server\\src\\checkpoint.rs',
    'hy-exec-server\\src\\fs_guard.rs',
    'hy-exec-server\\src\\cmdline.rs',
  ]
  let totalLines = 0
  let coveredLines = 0
  let totalRegions = 0
  let coveredRegions = 0
  console.log('Pure-logic module breakdown (target: >= 85% lines):')
  for (const file of data.files) {
    const fn = file.filename.replace(/\//g, '\\')
    if (!pureTargets.some((t) => fn.endsWith(t))) continue
    const lines = file.summary.lines
    const regions = file.summary.regions
    totalLines += lines.count
    coveredLines += lines.covered
    totalRegions += regions.count
    coveredRegions += regions.covered
    const rel = pureTargets.find((t) => fn.endsWith(t))
    console.log(
      `  ${rel}: lines ${lines.percent.toFixed(1)}% (${lines.covered}/${lines.count}), regions ${regions.percent.toFixed(1)}% (${regions.covered}/${regions.count})`,
    )
  }
  const aggLinePct = totalLines > 0 ? (coveredLines / totalLines) * 100 : 0
  const aggRegionPct = totalRegions > 0 ? (coveredRegions / totalRegions) * 100 : 0
  console.log(
    `Aggregate pure-logic coverage: lines ${aggLinePct.toFixed(1)}% (${coveredLines}/${totalLines}), regions ${aggRegionPct.toFixed(1)}% (${coveredRegions}/${totalRegions})`,
  )
  if (aggLinePct < 85) {
    console.error(`FAIL: aggregate pure-logic line coverage ${aggLinePct.toFixed(1)}% is below 85%`)
    process.exit(1)
  }
} finally {
  fs.rmSync(covDir, { recursive: true, force: true })
}
