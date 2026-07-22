# Restarts the broker daemon (src/index.ts) if it isn't running.
#
# Runs as a Windows Scheduled Task, deliberately OUTSIDE any Claude Code
# session's own process tree -- 2026-07-19, live-confirmed both the poller
# (Monitor-tracked) and this daemon (nohup'd from a Bash tool call) died
# together at a context-compaction boundary, with no crash trace on either
# side. Anything living inside that process tree (a wrapping shell `until`
# loop included) would die the same way; only something outside it can
# reliably notice and react. Scheduled Task survives session compaction,
# session end, and Claude Code itself restarting.
#
# The poller is NOT covered here on purpose: it's intentionally tied to one
# session's lifecycle (see poller.ts's own docstring) and re-arms itself via
# the existing Stop-hook liveness check the next time that session takes a
# turn -- an external watchdog restarting it under a stale session id would
# be wrong, not just redundant.

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$logFile = Join-Path $repoRoot 'watchdog.log'

function Write-Log($message) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $message"
    Add-Content -Path $logFile -Value $line
}

$running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match [regex]::Escape($repoRoot) -and $_.CommandLine -match 'src[\\/]index\.ts' }

if ($running) {
    exit 0
}

Write-Log "daemon not running -- restarting"

Set-Location $repoRoot
$outLog = Join-Path $repoRoot 'broker-out.log'
$errLog = Join-Path $repoRoot 'broker-err.log'

# npx resolves to npx.cmd on Windows -- Start-Process needs a real Win32
# executable, not something PATHEXT/cmd.exe would resolve, so it's launched
# through cmd.exe /c the same way any other npm-ecosystem CLI is from here.
Start-Process -FilePath 'cmd.exe' `
    -ArgumentList '/c', 'npx', 'tsx', '--env-file-if-exists=.env', 'src/index.ts' `
    -WorkingDirectory $repoRoot `
    -RedirectStandardOutput $outLog `
    -RedirectStandardError $errLog `
    -WindowStyle Hidden

Write-Log "daemon restart issued"
