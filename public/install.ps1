# Wicklee Sentinel — one-line Windows installer
#
#   irm https://wicklee.dev/install.ps1 | iex
#
# Downloads the latest Windows binary from GitHub Releases,
# installs it to %LOCALAPPDATA%\wicklee\wicklee.exe, and adds that
# directory to the current user's PATH.

#Requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Repo        = 'jeffgeiser/Wicklee'
$ReleaseTag  = 'nightly'
$AssetName   = 'wicklee-agent-windows-x86_64.exe'
$InstallDir  = Join-Path $env:LOCALAPPDATA 'wicklee'
$BinPath     = Join-Path $InstallDir 'wicklee.exe'

# ── Helpers ───────────────────────────────────────────────────────────────────

function Write-Green([string]$msg) { Write-Host $msg -ForegroundColor Green }
function Write-Dim([string]$msg)   { Write-Host $msg -ForegroundColor DarkGray }
function Abort([string]$msg)       { Write-Host "error: $msg" -ForegroundColor Red; exit 1 }

# ── Download ──────────────────────────────────────────────────────────────────

$DownloadUrl = "https://github.com/$Repo/releases/download/$ReleaseTag/$AssetName"
$tmp = Join-Path $env:TEMP "wicklee-install-$([System.IO.Path]::GetRandomFileName()).exe"

Write-Host ""
Write-Host "  Downloading Wicklee ($ReleaseTag)..." -ForegroundColor Cyan

try {
    Invoke-WebRequest -Uri $DownloadUrl -OutFile $tmp -UseBasicParsing
} catch {
    Abort "Download failed from $DownloadUrl`nCheck https://github.com/$Repo/releases for available assets."
}

# ── Install ───────────────────────────────────────────────────────────────────

if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir | Out-Null
}

Copy-Item -Path $tmp -Destination $BinPath -Force
Remove-Item -Path $tmp -Force

# ── Add to PATH (current user, persistent) ────────────────────────────────────

$userPath = [System.Environment]::GetEnvironmentVariable('PATH', 'User')
if ($null -eq $userPath) { $userPath = '' }
if ($userPath -notlike "*$InstallDir*") {
    [System.Environment]::SetEnvironmentVariable(
        'PATH',
        "$userPath;$InstallDir",
        'User'
    )
    $env:PATH = "$env:PATH;$InstallDir"
}

# ── Success ───────────────────────────────────────────────────────────────────

$InstalledVersion = ''
try { $InstalledVersion = (& $BinPath --version 2>&1) -replace '^wicklee\s*', '' } catch {}
if (-not $InstalledVersion) { $InstalledVersion = $ReleaseTag }

Write-Host ""
Write-Green "  + Wicklee agent installed successfully ($InstalledVersion)"
Write-Host ""
Write-Host "  Start monitoring your node:"
Write-Host ""
Write-Host "  Recommended — runs on every boot:" -ForegroundColor White
Write-Host "    wicklee --install-service" -ForegroundColor White
Write-Host ""
Write-Host "  Or run manually:"
Write-Host "    wicklee" -ForegroundColor White
Write-Host ""
Write-Host "  Your dashboard:       http://localhost:7700"
Write-Host "  Pair with your fleet: https://wicklee.dev"
Write-Host ""
Write-Dim  "  Installed to: $BinPath"
Write-Dim  "  PATH updated for current user (restart your shell to pick it up)."
Write-Host ""
