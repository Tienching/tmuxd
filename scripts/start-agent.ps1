$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$NodeDir = 'D:\Users\jonaszchen\.tmuxd-runtime\node-v22.22.2-win-x64'
$TmuxBinDir = 'D:\msys64\usr\bin'
$Npm = Join-Path $NodeDir 'npm.cmd'
$EnvFile = Join-Path $ProjectRoot '.env'
$LogDir = Join-Path $ProjectRoot '.tmuxd-local-logs'
$StdoutLog = Join-Path $LogDir 'agent.out.log'
$StderrLog = Join-Path $LogDir 'agent.err.log'
$BootstrapLog = Join-Path $LogDir 'agent.bootstrap.log'

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-BootstrapLog {
    param([string] $Message)
    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Add-Content -LiteralPath $BootstrapLog -Value "[$stamp] $Message"
}

try {
    if (-not (Test-Path -LiteralPath $Npm)) {
        throw "npm not found at $Npm"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $TmuxBinDir 'tmux.exe'))) {
        throw "tmux.exe not found in $TmuxBinDir"
    }
    if (-not (Test-Path -LiteralPath $EnvFile)) {
        throw ".env not found at $EnvFile"
    }

    $existing = Get-CimInstance Win32_Process |
        Where-Object {
            $_.Name -eq 'node.exe' -and
            $_.CommandLine -like "*$ProjectRoot*" -and
            $_.CommandLine -like '*src/agent.ts*'
        } |
        Select-Object -First 1

    if ($existing) {
        Write-BootstrapLog "agent already running as PID $($existing.ProcessId)"
        exit 0
    }

    $env:Path = "$NodeDir;$TmuxBinDir;$env:Path"
    $env:MSYS = 'noglob'
    $env:HOME = 'D:\Users\jonaszchen'
    $env:USERPROFILE = 'D:\Users\jonaszchen'

    $proc = Start-Process `
        -FilePath $Npm `
        -ArgumentList @('run', 'agent') `
        -WorkingDirectory $ProjectRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput $StdoutLog `
        -RedirectStandardError $StderrLog `
        -PassThru

    Write-BootstrapLog "started tmuxd agent root PID $($proc.Id)"
} catch {
    Write-BootstrapLog "failed: $($_.Exception.Message)"
    throw
}
