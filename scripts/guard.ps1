param(
    [ValidateSet('Menu', 'Enable', 'Disable', 'Pause', 'Resume', 'Restore', 'Status')]
    [string]$Action = 'Menu',
    [string]$NodePath = '',
    [string]$ConfigPath = '',
    [switch]$NoPause
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$ConfigureScript = Join-Path $Root 'src\configure.mjs'
$ProxyScript = Join-Path $Root 'src\proxy.mjs'
$LauncherScript = Join-Path $Root 'launch-hidden.vbs'
$GuardSettings = Get-Content -LiteralPath (Join-Path $Root 'guard.config.json') -Raw | ConvertFrom-Json
$HealthUrl = 'http://' + $GuardSettings.host + ':' + $GuardSettings.port + '/health'
$StartupFolder = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
$StartupShortcutPath = Join-Path $StartupFolder 'Codex DeepSeek 413 Guard.lnk'

function Write-Title {
    Write-Host ''
    Write-Host 'Codex DeepSeek 413 Guard' -ForegroundColor Cyan
    Write-Host ('Project: ' + $Root) -ForegroundColor DarkGray
}

function Resolve-Node {
    if ($NodePath -and (Test-Path -LiteralPath $NodePath)) {
        return (Resolve-Path -LiteralPath $NodePath).Path
    }
    $command = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $fallback = Join-Path $env:ProgramFiles 'nodejs\node.exe'
    if (Test-Path -LiteralPath $fallback) { return $fallback }
    throw 'Node.js 18 or newer is required. Install Node.js and run this file again.'
}

function Invoke-GuardConfig {
    param([string[]]$Arguments)
    $fullArgs = @($ConfigureScript) + $Arguments
    if ($ConfigPath) { $fullArgs += @('--config', $ConfigPath) }
    $output = & $script:ResolvedNode @fullArgs 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw ($output -join [Environment]::NewLine)
    }
    return ($output -join [Environment]::NewLine)
}

function Get-ProviderStatus {
    return (Invoke-GuardConfig @('status') | ConvertFrom-Json)
}

function Test-GuardHealth {
    try {
        $health = Invoke-RestMethod -Uri $script:HealthUrl -TimeoutSec 2
        return ($health.status -eq 'ok' -and $health.service -eq 'codex-deepseek-413-guard')
    } catch {
        return $false
    }
}

function Wait-ForHealth {
    param([int]$TimeoutSeconds = 15)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        if (Test-GuardHealth) { return $true }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)
    return $false
}

function Ensure-Provider {
    $status = Get-ProviderStatus
    if (-not $status.providerFound) {
        throw 'Codex config does not contain [model_providers.deepseek]. Configure your direct official DeepSeek provider first; see README.md.'
    }
}

function Ensure-Enabled {
    $status = Get-ProviderStatus
    if ($status.baseUrl -ne $status.expectedGuardedBaseUrl) {
        throw 'Protection is not enabled. Run enable.cmd first.'
    }
}

function Install-StartupShortcut {
    if (-not (Test-Path -LiteralPath $LauncherScript)) {
        throw ('Missing launcher: ' + $LauncherScript)
    }
    if (-not (Test-Path -LiteralPath $StartupFolder)) {
        New-Item -ItemType Directory -Path $StartupFolder -Force | Out-Null
    }
    $wscript = Join-Path $env:WINDIR 'System32\wscript.exe'
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($StartupShortcutPath)
    $shortcut.TargetPath = $wscript
    $shortcut.Arguments = ('"{0}" "{1}"' -f $LauncherScript, $script:ResolvedNode)
    $shortcut.WorkingDirectory = $Root
    $shortcut.WindowStyle = 7
    $shortcut.Description = 'Start Codex DeepSeek 413 Guard'
    $shortcut.Save()
}

function Remove-StartupShortcut {
    if (Test-Path -LiteralPath $StartupShortcutPath) {
        Remove-Item -LiteralPath $StartupShortcutPath -Force
    }
}

function Start-Guard {
    Install-StartupShortcut
    if (-not (Wait-ForHealth)) {
        Start-Process `
            -FilePath (Join-Path $env:WINDIR 'System32\wscript.exe') `
            -ArgumentList ('"{0}" "{1}"' -f $LauncherScript, $script:ResolvedNode) `
            -WorkingDirectory $Root `
            -WindowStyle Hidden
        if (-not (Wait-ForHealth)) {
            throw ('The local guard did not become healthy on ' + $GuardSettings.host + ':' + $GuardSettings.port + '.')
        }
    }
}

function Stop-Guard {
    if (Test-GuardHealth) {
        $health = Invoke-RestMethod -Uri $script:HealthUrl -TimeoutSec 2
        if ($health.service -eq 'codex-deepseek-413-guard' -and $health.pid) {
            Stop-Process -Id ([int]$health.pid) -Force -ErrorAction SilentlyContinue
        }
    }
}

function Enable-Guard {
    Ensure-Provider
    Start-Guard
    Invoke-GuardConfig @('enable') | Out-Null
    Write-Host 'Protection enabled. Codex DeepSeek now uses 127.0.0.1:18766.' -ForegroundColor Green
}

function Disable-Guard {
    Invoke-GuardConfig @('disable') | Out-Null
    Stop-Guard
    Remove-StartupShortcut
    Invoke-GuardConfig @('resume') | Out-Null
    Write-Host 'Protection disabled. Codex DeepSeek now uses the official API directly.' -ForegroundColor Yellow
}

function Pause-Guard {
    Ensure-Enabled
    if (-not (Test-GuardHealth)) { Start-Guard }
    Invoke-GuardConfig @('pause') | Out-Null
    Write-Host 'Request pruning is paused. The local proxy remains active.' -ForegroundColor Yellow
}

function Resume-Guard {
    Ensure-Enabled
    if (-not (Test-GuardHealth)) { Start-Guard }
    Invoke-GuardConfig @('resume') | Out-Null
    Write-Host 'Request pruning resumed.' -ForegroundColor Green
}

function Restore-Guard {
    Invoke-GuardConfig @('disable') | Out-Null
    Stop-Guard
    Remove-StartupShortcut
    Invoke-GuardConfig @('cleanup') | Out-Null
    Write-Host 'Restored the official DeepSeek URL and removed automatic startup.' -ForegroundColor Green
}

function Show-Status {
    $provider = Get-ProviderStatus
    $health = $null
    try { $health = Invoke-RestMethod -Uri $script:HealthUrl -TimeoutSec 2 } catch {}

    Write-Host ''
    Write-Host 'Provider configuration' -ForegroundColor Cyan
    Write-Host ('  provider found : ' + $provider.providerFound)
    Write-Host ('  base_url       : ' + $provider.baseUrl)
    Write-Host ('  paused         : ' + $provider.paused)
    Write-Host ('  auto-start     : ' + $(if (Test-Path -LiteralPath $StartupShortcutPath) { 'installed' } else { 'not installed' }))
    Write-Host ('  proxy health   : ' + $(if ($health) { 'ok (PID ' + $health.pid + ')' } else { 'not running' }))
}

function Invoke-Action {
    param([string]$SelectedAction)
    switch ($SelectedAction) {
        'Enable'  { Enable-Guard }
        'Disable' { Disable-Guard }
        'Pause'   { Pause-Guard }
        'Resume'  { Resume-Guard }
        'Restore' { Restore-Guard }
        'Status'  { Show-Status }
    }
}

$script:ResolvedNode = Resolve-Node

if ($Action -eq 'Menu') {
    do {
        Write-Title
        Write-Host ''
        Write-Host '1. Enable or repair protection'
        Write-Host '2. Pause image pruning (proxy stays active)'
        Write-Host '3. Resume image pruning'
        Write-Host '4. Disable and restore the official URL'
        Write-Host '5. Show status'
        Write-Host '6. Remove automatic startup and restore everything'
        Write-Host '0. Exit'
        $choice = Read-Host 'Select'
        switch ($choice) {
            '1' { try { Invoke-Action 'Enable' } catch { Write-Host $_ -ForegroundColor Red } }
            '2' { try { Invoke-Action 'Pause' } catch { Write-Host $_ -ForegroundColor Red } }
            '3' { try { Invoke-Action 'Resume' } catch { Write-Host $_ -ForegroundColor Red } }
            '4' { try { Invoke-Action 'Disable' } catch { Write-Host $_ -ForegroundColor Red } }
            '5' { try { Invoke-Action 'Status' } catch { Write-Host $_ -ForegroundColor Red } }
            '6' { try { Invoke-Action 'Restore' } catch { Write-Host $_ -ForegroundColor Red } }
            '0' { break }
            default { Write-Host 'Unknown selection.' -ForegroundColor Yellow }
        }
        if ($choice -ne '0') { Read-Host 'Press Enter to continue' | Out-Null }
    } while ($choice -ne '0')
} else {
    Write-Title
    try {
        Invoke-Action $Action
    } catch {
        Write-Host $_ -ForegroundColor Red
        exit 1
    } finally {
        if (-not $NoPause -and $Host.Name -eq 'ConsoleHost') {
            Read-Host 'Press Enter to close' | Out-Null
        }
    }
}
