$ErrorActionPreference = "Stop"

# Resolve the project root from this script's location. No hard-coded path, so
# the launcher keeps working if the folder is moved (update the Run entry then).
$project = Split-Path -Parent $PSScriptRoot
Set-Location $project

# Do nothing when a healthy relay is already running.
try {
    $response = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:8787/health" -TimeoutSec 2
    if ($response.StatusCode -eq 200) { exit 0 }
} catch {
    # not running
}

$logDir = Join-Path $project "relay\data"
if (-not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}
$logFile = Join-Path $logDir "relay.log"
$errFile = Join-Path $logDir "relay.err.log"

$node = $null
$command = Get-Command node -ErrorAction SilentlyContinue
if ($command) { $node = $command.Source }
if (-not $node) {
    $fallback = Join-Path $env:USERPROFILE ".local\node\node.exe"
    if (Test-Path $fallback) { $node = $fallback }
}
if (-not $node) {
    Add-Content -Path $errFile -Value "$(Get-Date -Format o) node.exe not found"
    exit 1
}

Start-Process -FilePath $node `
    -ArgumentList "relay\dist\index.js" `
    -WorkingDirectory $project `
    -WindowStyle Hidden `
    -RedirectStandardOutput $logFile `
    -RedirectStandardError $errFile
