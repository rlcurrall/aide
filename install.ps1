# aide installation script for Windows
# Usage: irm https://raw.githubusercontent.com/rlcurrall/aide/main/install.ps1 | iex

$ErrorActionPreference = "Stop"

$Repo = "rlcurrall/aide"
$BinaryName = "aide.exe"
$InstallDir = if ($env:AIDE_INSTALL_DIR) { $env:AIDE_INSTALL_DIR } else { "$env:LOCALAPPDATA\Programs\aide" }

Write-Host "Installing aide for Windows..." -ForegroundColor Cyan

# Create install directory if it doesn't exist
if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}

# Download the latest release
$DownloadUrl = "https://github.com/$Repo/releases/latest/download/$BinaryName"
$DestPath = Join-Path $InstallDir $BinaryName

Write-Host "Downloading from $DownloadUrl" -ForegroundColor Gray

try {
    Invoke-WebRequest -Uri $DownloadUrl -OutFile $DestPath -UseBasicParsing
} catch {
    Write-Host "Error: Failed to download aide" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}

Write-Host "✓ aide installed to $DestPath" -ForegroundColor Green

# Check if install directory is in PATH
$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($UserPath -notlike "*$InstallDir*") {
    Write-Host ""
    Write-Host "Adding $InstallDir to your PATH..." -ForegroundColor Yellow

    # Add to user PATH
    $NewPath = "$UserPath;$InstallDir"
    [Environment]::SetEnvironmentVariable("Path", $NewPath, "User")

    # Update PATH for current session
    $env:Path = "$env:Path;$InstallDir"

    Write-Host "✓ PATH updated. You may need to restart your terminal." -ForegroundColor Green
}

# Verify installation
Write-Host ""
if (Get-Command aide -ErrorAction SilentlyContinue) {
    Write-Host "✓ aide is ready to use!" -ForegroundColor Green
    & aide --version
} else {
    Write-Host "Installation complete. Please restart your terminal to use aide." -ForegroundColor Yellow
}
