param(
  [switch]$OpenBrowser
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$bundledNode = Join-Path $root "work\node-v22.23.2-win-x64"
if (Test-Path (Join-Path $bundledNode "node.exe")) {
  $env:PATH = "$bundledNode;$env:PATH"
}

$listening = $false
try { $listening = [bool](Get-NetTCPConnection -LocalPort 8788 -State Listen -ErrorAction SilentlyContinue) } catch { }
if ($listening) {
  Write-Host "Xianyu Hardware Monitor is already running: http://127.0.0.1:8788"
  if ($OpenBrowser) { Start-Process "http://127.0.0.1:8788" }
  exit 0
}

$pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
$corepack = Get-Command corepack.cmd -ErrorAction SilentlyContinue
$useCorepack = $false
if (-not $pnpm -and $corepack) {
  $pnpm = $corepack
  $useCorepack = $true
}
if (-not $pnpm) {
  throw "pnpm or corepack is required. Install Node.js 22.13 or newer."
}

if (-not (Test-Path 'node_modules/playwright-core')) {
  if ($useCorepack) {
    & $pnpm.Source pnpm install
  } else {
    & $pnpm.Source install
  }
}

if ($OpenBrowser) {
  # A hidden helper waits until the server answers, then opens the console page.
  $watcher = @'
for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
  try {
    Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8788/api/status' -TimeoutSec 1 | Out-Null
    Start-Process 'http://127.0.0.1:8788'
    break
  } catch {
    Start-Sleep -Milliseconds 500
  }
}
'@
  Start-Process -FilePath (Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe') -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', $watcher -WindowStyle Hidden | Out-Null
}

if ($useCorepack) {
  & $pnpm.Source pnpm start
} else {
  & $pnpm.Source start
}
