$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $root "e2e-logs"

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$stdout = Join-Path $logDir "claudex.stdout.log"
$stderr = Join-Path $logDir "claudex.stderr.log"
$pidFile = Join-Path $logDir "claudex.pid"

Set-Location $root

"Starting claudex at $(Get-Date -Format o)" | Out-File -FilePath $stdout -Append -Encoding utf8

$process = Start-Process -FilePath node `
  -ArgumentList "dist/src/index.js", "--reuse-codex", "--debug" `
  -WorkingDirectory $root `
  -RedirectStandardOutput $stdout `
  -RedirectStandardError $stderr `
  -PassThru

$process.Id | Out-File -FilePath $pidFile -Encoding ascii
