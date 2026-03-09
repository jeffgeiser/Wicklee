# Wicklee Sentinel — one-line Windows installer
#
#   irm https://wicklee.dev/install.ps1 | iex
#
# Downloads the pre-built Windows binary from GitHub Releases,
# installs it to %LOCALAPPDATA%\wicklee\wicklee.exe, and adds that
# directory to the current user's PATH.

#Requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Repo       = 'jeffgeiser/Wicklee'
$AssetName  = 'wicklee-agent-windows-x86_64.exe'
$InstallDir = Join-Path $env:LOCALAPPDATA 'wicklee'
$BinPath    = Join-Path $InstallDir 'wicklee.exe'

# ── Helpers ───────────────────────────────────────────────────────────────────

function Write-Green([string]$msg) {
    Write-Host $msg -ForegroundColor Green
}
function Write-Dim([string]$msg) {
    Write-Host $msg -ForegroundColor DarkGray
}
function Abort([string]$msg) {
    Write-Host "error: $msg" -ForegroundColor Red
    exit 1
}

# ── Fetch latest release tag ──────────────────────────────────────────────────

Write-Host ""
Write-Host "  Fetching latest Wicklee release..." -ForegroundColor Cyan

$releaseUrl = "https://api.github.com/repos/$Repo/releases/latest"
try {
    $release = Invoke-RestMethod -Uri $releaseUrl -UseBasicParsing
} catch {
    Abort "Could not reach GitHub API. Check your internet connection."
}

$tag = $release.tag_name
if (-not $tag) { Abort "Could not determine latest release tag." }

$downloadUrl = "https://github.com/$Repo/releases/download/$tag/$AssetName"

# ── Download ──────────────────────────────────────────────────────────────────

$tmp = Join-Path $env:TEMP "wicklee-install-$([System.IO.Path]::GetRandomFileName()).exe"

Write-Host "  Downloading $AssetName ($tag)..." -ForegroundColor Cyan
try {
    Invoke-WebRequest -Uri $downloadUrl -OutFile $tmp -UseBasicParsing
} catch {
    Abort "Download failed. Check https://github.com/$Repo/releases for available assets."
}

# ── Install ───────────────────────────────────────────────────────────────────

if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir | Out-Null
}

Copy-Item -Path $tmp -Destination $BinPath -Force
Remove-Item -Path $tmp -Force

# ── Add to PATH (current user, persistent) ────────────────────────────────────

$userPath = [System.Environment]::GetEnvironmentVariable('PATH', 'User') ?? ''
if ($userPath -notlike "*$InstallDir*") {
    [System.Environment]::SetEnvironmentVariable(
        'PATH',
        "$userPath;$InstallDir",
        'User'
    )
    # Also update the current session so the next command works immediately.
    $env:PATH = "$env:PATH;$InstallDir"
}

# ── Success ───────────────────────────────────────────────────────────────────

Write-Host ""
Write-Green "  + wicklee installed successfully."
Write-Host ""
Write-Host "     Run:        wicklee"
Write-Host "     Dashboard:  http://localhost:7700"
Write-Host ""
Write-Dim  "  Installed to: $BinPath"
Write-Dim  "  PATH updated for current user (restart your shell to pick it up)."
Write-Host ""
Write-Host "  Note: Run wicklee in a standard PowerShell or Terminal window." -ForegroundColor Yellow
Write-Host "        GPU and thermal metrics require no elevation on Windows." -ForegroundColor Yellow
Write-Host ""
