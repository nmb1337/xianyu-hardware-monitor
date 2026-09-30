param(
  [Parameter(Mandatory = $true)]
  [string]$ImagePath,
  [string]$ShortcutPath = "",
  [string]$IconPath = "",
  [switch]$SkipShortcut
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$desktopPath = [Environment]::GetFolderPath("Desktop")
$defaultShortcutName = ([char]0x95F2) + ([char]0x9C7C) + ([char]0x786C) + ([char]0x4EF6) + ([char]0x76D1) + ([char]0x63A7) + ".lnk"
$shortcutDescription = [string]::Concat(
  [char]0x542F, [char]0x52A8, [char]0x95F2, [char]0x9C7C,
  [char]0x786C, [char]0x4EF6, [char]0x76D1, [char]0x63A7,
  [char]0x5F53, [char]0x524D, [char]0x7248, [char]0x672C
)
$powershellPath = Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\powershell.exe"
$launcherPath = Join-Path $projectRoot "run-monitor.ps1"

if (-not $ShortcutPath) {
  $ShortcutPath = Join-Path $desktopPath $defaultShortcutName
}
if (-not $IconPath) {
  $IconPath = Join-Path $projectRoot "assets\xianyu-hardware-monitor.ico"
}

$resolvedImage = (Resolve-Path -LiteralPath $ImagePath).Path
$iconDirectory = Split-Path -Parent $IconPath
if (-not (Test-Path -LiteralPath $iconDirectory)) {
  New-Item -ItemType Directory -Path $iconDirectory -Force | Out-Null
}

Add-Type -AssemblyName System.Drawing

function Convert-PngToIco {
  param(
    [Parameter(Mandatory = $true)]
    [string]$SourcePath,
    [Parameter(Mandatory = $true)]
    [string]$DestinationPath
  )

  $source = [System.Drawing.Image]::FromFile($SourcePath)
  $bitmap = New-Object System.Drawing.Bitmap(256, 256)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $stream = New-Object System.IO.MemoryStream
  $writer = New-Object System.IO.BinaryWriter([System.IO.File]::Open($DestinationPath, [System.IO.FileMode]::Create))
  try {
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $graphics.DrawImage($source, 0, 0, 256, 256)
    $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    $png = $stream.ToArray()

    # ICO header plus one PNG-compressed 256x256 image entry.
    $writer.Write([UInt16]0)
    $writer.Write([UInt16]1)
    $writer.Write([UInt16]1)
    $writer.Write([Byte]0)
    $writer.Write([Byte]0)
    $writer.Write([Byte]0)
    $writer.Write([Byte]0)
    $writer.Write([UInt16]1)
    $writer.Write([UInt16]32)
    $writer.Write([UInt32]$png.Length)
    $writer.Write([UInt32]22)
    $writer.Write($png)
  }
  finally {
    $writer.Dispose()
    $stream.Dispose()
    $graphics.Dispose()
    $bitmap.Dispose()
    $source.Dispose()
  }
}

Convert-PngToIco -SourcePath $resolvedImage -DestinationPath $IconPath

if (-not $SkipShortcut) {
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($ShortcutPath)
  $shortcut.TargetPath = $powershellPath
  $shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcherPath`" -OpenBrowser"
  $shortcut.WorkingDirectory = $projectRoot
  $shortcut.IconLocation = "$((Resolve-Path -LiteralPath $IconPath).Path),0"
  $shortcut.Description = $shortcutDescription
  $shortcut.Save()
  Write-Output "Updated shortcut: $ShortcutPath"
}

Write-Output "Created icon: $IconPath"
