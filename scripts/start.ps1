[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$dataDirectory = Join-Path $repositoryRoot 'data'
$logsDirectory = Join-Path $repositoryRoot 'logs'
$pidPath = Join-Path $dataDirectory 'whitelily.pid'
$markerPath = Join-Path $dataDirectory 'stop.request'
$entryPath = Join-Path $repositoryRoot 'dist\src\index.js'
$configPath = Join-Path $repositoryRoot 'config.toml'
$startedProcess = $null
$lifecycleMutex = $null

function Enter-LifecycleMutex {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($repositoryRoot.ToLowerInvariant())
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    $hash = [System.BitConverter]::ToString($sha256.ComputeHash($bytes)).Replace('-', '')
  }
  finally {
    $sha256.Dispose()
  }
  $mutex = [System.Threading.Mutex]::new($false, "Local\WhiteLilyLifecycle-$hash")
  $acquired = $false
  try {
    $acquired = $mutex.WaitOne([TimeSpan]::FromSeconds(15))
  }
  catch [System.Threading.AbandonedMutexException] {
    $acquired = $true
  }
  if (-not $acquired) {
    $mutex.Dispose()
    throw 'Timed out waiting for another WhiteLily lifecycle operation.'
  }
  return $mutex
}

function Exit-LifecycleMutex {
  param($Mutex)
  if ($null -eq $Mutex) {
    return
  }
  try {
    $Mutex.ReleaseMutex()
  }
  finally {
    $Mutex.Dispose()
  }
}

function Remove-PidRecordIfMatches {
  param([Parameter(Mandatory = $true)][int]$ExpectedPid)
  if (-not (Test-Path -LiteralPath $pidPath -PathType Leaf)) {
    return $false
  }
  $current = [System.IO.File]::ReadAllText($pidPath)
  if ($current -notmatch '^[1-9]\d*(?:\r?\n)?$' -or
      [int]$current.Trim() -ne $ExpectedPid) {
    return $false
  }
  Remove-Item -LiteralPath $pidPath -Force
  return $true
}

function Get-ProcessRecord {
  param([Parameter(Mandatory = $true)][int]$ProcessId)
  return Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
}

function Test-OwnedCommandLine {
  param([Parameter(Mandatory = $true)]$Record)
  if ($null -eq $Record -or [string]::IsNullOrWhiteSpace([string]$Record.CommandLine)) {
    return $false
  }
  $expected = $entryPath.Replace('\', '/').ToLowerInvariant()
  $actual = ([string]$Record.CommandLine).Replace('\', '/').ToLowerInvariant()
  return $actual.Contains($expected)
}

try {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'doctor.ps1')
  if ($LASTEXITCODE -ne 0) {
    throw 'Doctor found a fatal prerequisite. Resolve FAIL items before starting.'
  }

  $lifecycleMutex = Enter-LifecycleMutex
  New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null
  New-Item -ItemType Directory -Path $logsDirectory -Force | Out-Null

  if (Test-Path -LiteralPath $pidPath -PathType Leaf) {
    $pidText = [System.IO.File]::ReadAllText($pidPath)
    if ($pidText -notmatch '^[1-9]\d*(?:\r?\n)?$') {
      throw 'The WhiteLily PID file is invalid; inspect data\whitelily.pid manually.'
    }
    $existingId = 0
    if (-not [int]::TryParse($pidText.Trim(), [ref]$existingId)) {
      throw 'The WhiteLily PID file is invalid; inspect data\whitelily.pid manually.'
    }
    $record = Get-ProcessRecord -ProcessId $existingId
    if ($null -ne $record) {
      if (Test-OwnedCommandLine -Record $record) {
        throw 'WhiteLily is already running.'
      }
      throw 'The PID file points to a process that does not belong to WhiteLily.'
    }
    if (-not (Remove-PidRecordIfMatches -ExpectedPid $existingId)) {
      throw 'The WhiteLily PID file changed while startup was checking it.'
    }
  }

  if (Test-Path -LiteralPath $markerPath) {
    if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) {
      throw 'The WhiteLily stop request path is not a regular file; inspect it manually.'
    }
    Remove-Item -LiteralPath $markerPath -Force
  }

  $node = Get-Command node -ErrorAction Stop
  $stdoutPath = Join-Path $logsDirectory 'whitelily.out.log'
  $stderrPath = Join-Path $logsDirectory 'whitelily.err.log'
  $quotedEntryPath = '"' + $entryPath + '"'
  $quotedConfigPath = '"' + $configPath + '"'
  $startedProcess = Start-Process `
    -FilePath $node.Source `
    -ArgumentList @($quotedEntryPath, $quotedConfigPath) `
    -WorkingDirectory $repositoryRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -PassThru
  Start-Sleep -Milliseconds 200
  $startedProcess.Refresh()
  if ($startedProcess.HasExited) {
    throw 'WhiteLily exited during startup. Check logs\whitelily.err.log.'
  }
  [System.IO.File]::WriteAllText(
    $pidPath,
    [string]$startedProcess.Id,
    [System.Text.Encoding]::ASCII
  )
}
catch {
  if ($null -ne $startedProcess -and -not $startedProcess.HasExited) {
    $startedRecord = Get-ProcessRecord -ProcessId $startedProcess.Id
    if ($null -ne $startedRecord -and (Test-OwnedCommandLine -Record $startedRecord)) {
      Stop-Process -Id $startedProcess.Id -Force -ErrorAction SilentlyContinue
      Wait-Process -Id $startedProcess.Id -Timeout 5 -ErrorAction SilentlyContinue
    }
  }
  if (Test-Path -LiteralPath $pidPath -PathType Leaf) {
    $writtenPid = [System.IO.File]::ReadAllText($pidPath)
    if ($null -ne $startedProcess -and $writtenPid.Trim() -eq [string]$startedProcess.Id) {
      Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
    }
  }
  Write-Output "FAIL: $($_.Exception.Message)"
  exit 1
}
finally {
  Exit-LifecycleMutex -Mutex $lifecycleMutex
}

Write-Output 'WhiteLily started in the background.'
Write-Output 'Stop it with scripts\stop.ps1.'
Write-Output 'In Minecraft chat, use !status to check it.'
