$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  throw "未找到 pnpm。请先安装 Node.js，并执行 corepack enable。"
}

if (-not (Test-Path "node_modules/playwright-core")) {
  pnpm install
}

pnpm start
