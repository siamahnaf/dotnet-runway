# Build everything: the app, the installer, and the VS Code extension.
#   .\build.ps1            patch bump on the extension
#   .\build.ps1 minor      minor bump
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

Write-Host '== app ==' -ForegroundColor Cyan
Push-Location "$root\Dotswitch.App"
dotnet publish -c Release -o dist
# Symbols and XML docs have no place in an install.
Remove-Item dist\*.pdb, dist\*.xml -ErrorAction SilentlyContinue
Pop-Location

Write-Host '== installer ==' -ForegroundColor Cyan
# Version comes from the .wxs; keep the file name in step with it.
$wxs = Get-Content "$root\Dotswitch.Installer\Dotswitch.wxs" -Raw
$version = [regex]::Match($wxs, 'Version="([0-9.]+)"').Groups[1].Value
Push-Location "$root\Dotswitch.Installer"
# -arch x64 is required: WiX defaults to x86, which installs to
# Program Files (x86) and hides the registry key in WOW6432Node.
wix build Dotswitch.wxs -arch x64 -o "$root\Dotswitch-$version.msi"
Pop-Location

Write-Host '== extension ==' -ForegroundColor Cyan
Push-Location "$root\dotswitch"
if (-not (Test-Path node_modules)) { npm install }
node build.js @args
Pop-Location

Write-Host "done" -ForegroundColor Green
Get-ChildItem "$root\*.msi", "$root\*.vsix" | Select-Object Name, Length
