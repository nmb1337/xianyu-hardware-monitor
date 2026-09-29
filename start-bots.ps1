[CmdletBinding()]
param([switch]$OpenPages)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$logDirectory = Join-Path $root "outputs"
New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null

function Start-LocalService {
  param(
    [string]$Name,
    [string]$Directory,
    [string]$Executable,
    [string[]]$Arguments,
    [int]$Port
  )
  if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) {
    Write-Host "$Name already has a listener on port $Port; no duplicate process started."
    return
  }
  $file = Join-Path $Directory $Executable
  if (-not (Test-Path -LiteralPath $file)) {
    throw "$Name is not installed in $Directory. See docs\WINDOWS11_DEPLOY.md."
  }
  $log = Join-Path $logDirectory "$Name.log"
  $errorLog = Join-Path $logDirectory "$Name-error.log"
  $process = Start-Process -FilePath $file -ArgumentList $Arguments `
    -WorkingDirectory $Directory -WindowStyle Hidden `
    -RedirectStandardOutput $log -RedirectStandardError $errorLog -PassThru
  for ($attempt = 0; $attempt -lt 45; $attempt++) {
    if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) {
      Write-Host "$Name ready on 127.0.0.1:$Port"
      return
    }
    Start-Sleep -Seconds 1
  }
  throw "$Name did not start. Check $log and $errorLog."
}

$env:PYTHONUTF8 = "1"
$env:NO_PROXY = "127.0.0.1,localhost,::1"
Start-LocalService -Name "astrbot" -Directory "$root\data\services\astrbot" `
  -Executable ".venv\Scripts\python.exe" `
  -Arguments @("-u", "main.py", "--webui-dir", "data/dist") -Port 6185

# NapCat's Node bundle must not receive Electron-only worker arguments.
$env:NAPCAT_DISABLE_MULTI_PROCESS = "1"
Start-LocalService -Name "napcat" -Directory "$root\data\services\napcat" `
  -Executable "node.exe" -Arguments @("index.js") -Port 6099

if ($OpenPages) {
  $webuiPath = "$root\data\services\napcat\napcat\config\webui.json"
  if (Test-Path -LiteralPath $webuiPath) {
    $webui = Get-Content -LiteralPath $webuiPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $token = [Uri]::EscapeDataString([string]$webui.token)
    Start-Process "http://127.0.0.1:6099/webui/?token=$token"
  } else {
    Start-Process "http://127.0.0.1:6099/webui/"
  }
}
