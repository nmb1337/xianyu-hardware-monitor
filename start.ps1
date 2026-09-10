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
  throw "未找到 pnpm 或 corepack。请先安装 Node.js 22.13 或更高版本。"
}

if (-not (Test-Path "node_modules/playwright-core")) {
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
