param(
  [switch]$OpenBrowser,
  [switch]$Restart
)

# Xianyu Hardware Monitor launcher (does not require pnpm)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root
$work = Join-Path $root 'work'
if (-not (Test-Path $work)) { New-Item -ItemType Directory -Force -Path $work | Out-Null }
$logFile = Join-Path $work 'monitor-start.log'
function Note([string]$m) {
  try { Add-Content -Path $logFile -Value ("[{0}] {1}" -f (Get-Date -Format s), $m) -Encoding UTF8 } catch { }
}
function Get-MonitorServer {
  try {
    $connection = Get-NetTCPConnection -LocalPort 8788 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($connection) { return Get-Process -Id $connection.OwningProcess -ErrorAction SilentlyContinue }
  } catch { }
  return $null
}
Note 'launcher invoked'
$bundledNode = Join-Path $work 'node-v22.23.2-win-x64'
if (Test-Path (Join-Path $bundledNode 'node.exe')) { $env:PATH = "$bundledNode;$env:PATH" } else { $bundledNode = $null }
if (-not (Test-Path (Join-Path $root 'node_modules\playwright-core'))) {
  $npm = 'npm.cmd'
  if ($bundledNode) { $npm = Join-Path $bundledNode 'npm.cmd' }
  Note 'dependencies missing, installing with npm (npmmirror)'
  $prevEAP = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  & $npm install --registry 'https://registry.npmmirror.com' --no-audit --no-fund *>> $logFile
  $ErrorActionPreference = $prevEAP
}
$server = Get-MonitorServer
if ($server -and -not $Restart) {
  # A running server keeps the code it loaded at startup. Restart it when the checkout
  # is newer so the desktop shortcut always brings up the current version.
  try {
    $sources = @(Get-ChildItem -Path (Join-Path $root 'src'), (Join-Path $root 'public') -Recurse -File -ErrorAction SilentlyContinue)
    $sources += Get-Item (Join-Path $root 'package.json') -ErrorAction SilentlyContinue
    $newestSource = $sources | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($newestSource -and $newestSource.LastWriteTime -gt $server.StartTime) {
      Note ("newer source {0} ({1}) than running server; restarting" -f $newestSource.FullName, $newestSource.LastWriteTime)
      $Restart = $true
    }
  } catch {
    Note ("source freshness check failed: {0}" -f $_.Exception.Message)
  }
}
if ($server -and $Restart) {
  Note ("restart requested, closing server process {0} ({1})" -f $server.Id, $server.ProcessName)
  # Best effort: stop the scan loop and the monitor browser before replacing the process.
  foreach ($endpoint in @('/api/monitor/stop', '/api/browser/close')) {
    try {
      Invoke-RestMethod -Method Post -Uri ("http://127.0.0.1:8788" + $endpoint) -TimeoutSec 15 | Out-Null
    } catch {
      Note ("graceful shutdown step {0} failed: {1}" -f $endpoint, $_.Exception.Message)
    }
  }
  try { Stop-Process -Id $server.Id -Force } catch { Note ("failed to stop process {0}: {1}" -f $server.Id, $_.Exception.Message) }
  for ($index = 0; $index -lt 40; $index += 1) {
    Start-Sleep -Milliseconds 250
    if (-not (Get-MonitorServer)) { break }
  }
  $server = Get-MonitorServer
}
if ($server) {
  Note 'port 8788 is already open, nothing to do'
}
else {
  $nodeExe = 'node.exe'
  if ($bundledNode) { $nodeExe = Join-Path $bundledNode 'node.exe' }
  Note ("starting server: {0}" -f $nodeExe)
  Start-Process -FilePath $nodeExe -ArgumentList 'src\server.js' -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $work 'server-out.log') -RedirectStandardError (Join-Path $work 'server-err.log')
  Note 'server process spawned'
}

$ready = $false
for ($index = 0; $index -lt 40; $index += 1) {
  try {
    Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8788/api/status' -TimeoutSec 1 | Out-Null
    $ready = $true
    break
  } catch {
    Start-Sleep -Milliseconds 500
  }
}
if (-not $ready) {
  Note 'server did not become ready'
  exit 1
}
Note 'server is ready'
if ($OpenBrowser) {
  Start-Process 'http://127.0.0.1:8788'
}

