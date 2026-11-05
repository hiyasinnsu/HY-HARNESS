param(
  [string]$Config,
  [string]$OldExe,
  [string]$NewExe,
  [int]$ProcessId = 0,
  [string]$Log = "C:\Users\Public\hy-harness-update\update.log",
  [string]$TaskName,
  [string]$ExpectedSha256 = "",
  [switch]$DryRun
)

if ($Config) {
  try {
    $cfg = Get-Content -LiteralPath $Config -Raw -Encoding UTF8 | ConvertFrom-Json
    $OldExe = [string]$cfg.oldExe
    $NewExe = [string]$cfg.newExe
    $ProcessId = [int]$cfg.processId
    $Log = [string]$cfg.log
    $TaskName = [string]$cfg.taskName
    if ($cfg.expectedSha256) { $ExpectedSha256 = [string]$cfg.expectedSha256 }
    if ($cfg.dryRun) { $DryRun = $true }
  } catch {
    exit 2
  }
}

function Write-UpdateLog([string]$Message) {
  try {
    $dir = [System.IO.Path]::GetDirectoryName($Log)
    if ($dir) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    Add-Content -LiteralPath $Log -Value ((Get-Date).ToString('o') + ' ' + $Message) -Encoding UTF8
  } catch {
  }
}

function Write-Step([int]$Step, [string]$Message) {
  Write-UpdateLog ("progress " + $Step + "/6 " + $Message)
}

function Remove-UpdateTask {
  if ($TaskName) {
    & schtasks.exe /Delete /TN $TaskName /F 2>$null | Out-Null
  }
}

function Start-Harness([string]$Path) {
  if ($DryRun) {
    Write-UpdateLog "dry-run: would start $Path"
    return
  }
  $parent = [System.IO.Path]::GetDirectoryName($Path)
  Start-Process -FilePath $Path -WorkingDirectory $parent
}

function Restore-Backup([string]$Why) {
  try {
    Copy-Item -LiteralPath $backup -Destination $OldExe -Force -ErrorAction Stop
    Write-UpdateLog ("rollback: " + $Why + "; restored the backup")
  } catch {
    Write-UpdateLog ("rollback: " + $Why + "; restoring the backup failed: " + $_.Exception.Message)
  }
  Start-Harness $OldExe
  Remove-UpdateTask
}

if (-not $OldExe -or -not $NewExe) {
  Write-UpdateLog "missing old/new exe"
  Remove-UpdateTask
  exit 2
}

Write-Step 1 ("waiting for the app to exit (pid " + $ProcessId + ")")
$deadline = (Get-Date).AddSeconds(120)
while ($ProcessId -gt 0 -and (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue) -and ((Get-Date) -lt $deadline)) {
  Start-Sleep -Milliseconds 250
}

Write-Step 2 "moving the old exe aside"
$backup = "$OldExe.bak-" + (Get-Date -Format 'yyyyMMddHHmmss') + ".exe"
$moved = $false
$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline) {
  try {
    Move-Item -LiteralPath $OldExe -Destination $backup -ErrorAction Stop
    $moved = $true
    break
  } catch {
    Start-Sleep -Milliseconds 250
  }
}

if (-not $moved) {
  Write-UpdateLog "could not move the old exe; starting it again"
  Start-Harness $OldExe
  Remove-UpdateTask
  exit 3
}

try {
  Write-Step 3 "copying the staged build into place"
  Copy-Item -LiteralPath $NewExe -Destination $OldExe -Force -ErrorAction Stop
} catch {
  Write-UpdateLog "replace failed: $($_.Exception.Message)"
  Restore-Backup "the copy failed"
  exit 4
}

if ($ExpectedSha256) {
  Write-Step 4 "verifying the SHA-256 of the new exe"
  $actual = (Get-FileHash -LiteralPath $OldExe -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $ExpectedSha256.ToLowerInvariant()) {
    Restore-Backup ("checksum mismatch: expected " + $ExpectedSha256 + ", got " + $actual)
    exit 5
  }
} else {
  Write-Step 4 "no SHA-256 to verify (the caller did not pass one)"
}

Write-Step 5 "replaced $OldExe with $NewExe"
Write-Step 6 "starting the new build"
Start-Harness $OldExe
Remove-UpdateTask
exit 0
