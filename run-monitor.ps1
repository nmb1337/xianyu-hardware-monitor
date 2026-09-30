param(
  [switch]$OpenBrowser
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
$listening = $false
try { $listening = [bool](Get-NetTCPConnection -LocalPort 8788 -State Listen -ErrorAction SilentlyContinue) } catch { }
if ($listening) {
  Note 'port 8788 is already open, nothing to do'
}
else {
  $nodeExe = 'node.exe'
  if ($bundledNode) { $nodeExe = Join-Path $bundledNode 'node.exe' }
  Note ("starting server: {0}" -f $nodeExe)
  Start-Process -FilePath $nodeExe -ArgumentList 'src\server.js' -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $work 'server-out.log') -RedirectStandardError (Join-Path $work 'server-err.log')
  Note 'server process spawned'
}

if ($OpenBrowser) {
  $ready = $false
  for ($index = 0; $index -lt 30; $index += 1) {
    try {
      Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8788/api/status' -TimeoutSec 1 | Out-Null
      $ready = $true
      break
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }
  if ($ready) {
    Start-Process 'http://127.0.0.1:8788'
  } else {
    Note 'server did not become ready before browser launch'
  }
}

