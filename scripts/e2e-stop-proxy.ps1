$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $root "e2e-logs\claudex.pid"

if (-not (Test-Path $pidFile)) {
  exit 0
}

$processId = Get-Content $pidFile | Select-Object -First 1
if ($processId) {
  Stop-Process -Id ([int]$processId) -Force -ErrorAction SilentlyContinue
}

Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
