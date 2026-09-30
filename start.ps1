$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$bundledNode = Join-Path $root "work\node-v22.23.2-win-x64"
if (Test-Path (Join-Path $bundledNode "node.exe")) {
  $env:PATH = "$bundledNode;$env:PATH"
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

if ($useCorepack) {
  & $pnpm.Source pnpm start
} else {
  & $pnpm.Source start
}
