[CmdletBinding()]
param(
  [ValidateRange(1, 10)][int]$GracefulTimeoutSeconds = 10
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$dataDirectory = Join-Path $repositoryRoot 'data'
$pidPath = Join-Path $dataDirectory 'whitelily.pid'
$markerPath = Join-Path $dataDirectory 'stop.request'
$entryPath = Join-Path $repositoryRoot 'dist\src\index.js'
$lifecycleMutex = $null
$script:stopExitCode = 0

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

function Get-ProcessRecord {
  param([Parameter(Mandatory = $true)][int]$ProcessId)
  $record = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
  $fixtureMarker = Join-Path $repositoryRoot '.whitelily-test-fixture'
  if (
    $null -ne $record -and
    $env:WHITELILY_TEST_DROP_OWNERSHIP_AFTER_MARKER -eq '1' -and
    (Test-Path -LiteralPath $markerPath -PathType Leaf) -and
    (Test-Path -LiteralPath $fixtureMarker -PathType Leaf) -and
    [System.IO.File]::ReadAllText($fixtureMarker) -eq "WhiteLily Windows script fixture v1`n"
  ) {
    return [pscustomobject]@{
      ProcessId = $record.ProcessId
      CreationDate = $record.CreationDate
      CommandLine = 'fixture-forced ownership mismatch'
    }
  }
  return $record
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

function Test-OriginalProcessIdentity {
  param(
    [Parameter(Mandatory = $true)]$Record,
    [Parameter(Mandatory = $true)][string]$CreationDate
  )
  return (
    $null -ne $Record -and
    [string]$Record.CreationDate -eq $CreationDate -and
    (Test-OwnedCommandLine -Record $Record)
  )
}

function Test-PidRecordMatches {
  param([Parameter(Mandatory = $true)][int]$ExpectedPid)
  if (-not (Test-Path -LiteralPath $pidPath -PathType Leaf)) {
    return $false
  }
  $current = [System.IO.File]::ReadAllText($pidPath)
  return (
    $current -match '^[1-9]\d*(?:\r?\n)?$' -and
    [int]$current.Trim() -eq $ExpectedPid
  )
}

function Remove-PidRecordIfMatches {
  param([Parameter(Mandatory = $true)][int]$ExpectedPid)
  if (-not (Test-PidRecordMatches -ExpectedPid $ExpectedPid)) {
    return $false
  }
  Remove-Item -LiteralPath $pidPath -Force
  return $true
}

function Invoke-WhiteLilyStop {
  if (-not (Test-Path -LiteralPath $pidPath -PathType Leaf)) {
    Write-Output 'WhiteLily is not running; no PID file exists.'
    return
  }

  $pidText = [System.IO.File]::ReadAllText($pidPath)
  if ($pidText -notmatch '^[1-9]\d*(?:\r?\n)?$') {
    Write-Output 'FAIL: The WhiteLily PID file is invalid.'
    $script:stopExitCode = 1
    return
  }
  $processId = 0
  if (-not [int]::TryParse($pidText.Trim(), [ref]$processId)) {
    Write-Output 'FAIL: The WhiteLily PID file is invalid.'
    $script:stopExitCode = 1
    return
  }

  $record = Get-ProcessRecord -ProcessId $processId
  if ($null -eq $record) {
    if (Remove-PidRecordIfMatches -ExpectedPid $processId) {
      Write-Output 'Removed a stale WhiteLily PID file; no process was stopped.'
    }
    else {
      Write-Output 'FAIL: The PID record changed while stale state was being checked.'
      $script:stopExitCode = 1
    }
    return
  }
  if (-not (Test-OwnedCommandLine -Record $record)) {
    Write-Output 'FAIL: PID does not belong to WhiteLily; no process was stopped.'
    $script:stopExitCode = 1
    return
  }

  $originalCreationDate = [string]$record.CreationDate
  $markerToken = [guid]::NewGuid().ToString('N')
  $createdMarker = $false
  $removePid = $false
  try {
    [System.IO.File]::WriteAllText($markerPath, $markerToken, [System.Text.Encoding]::ASCII)
    $createdMarker = $true
    $deadline = [DateTime]::UtcNow.AddSeconds($GracefulTimeoutSeconds)
    do {
      Start-Sleep -Milliseconds 100
      $record = Get-ProcessRecord -ProcessId $processId
      if ($null -eq $record) {
        $removePid = $true
        Write-Output 'WhiteLily stopped gracefully.'
        break
      }
    } while ([DateTime]::UtcNow -lt $deadline)

    if ($null -ne $record) {
      if (-not (Test-PidRecordMatches -ExpectedPid $processId)) {
        throw 'PID changed during shutdown; refusing forced fallback.'
      }
      $record = Get-ProcessRecord -ProcessId $processId
      if ($null -eq $record) {
        $removePid = $true
        Write-Output 'WhiteLily stopped gracefully.'
      }
      elseif (-not (
          Test-OriginalProcessIdentity `
            -Record $record `
            -CreationDate $originalCreationDate
        )) {
        throw 'PID no longer belongs to the original WhiteLily process; refusing forced fallback.'
      }
      else {
        Stop-Process -Id $processId -Force -ErrorAction Stop
        Wait-Process -Id $processId -Timeout 5 -ErrorAction SilentlyContinue
        $remaining = Get-ProcessRecord -ProcessId $processId
        if (
          $null -ne $remaining -and
          (Test-OriginalProcessIdentity -Record $remaining -CreationDate $originalCreationDate)
        ) {
          throw 'Forced fallback could not stop WhiteLily.'
        }
        $removePid = $true
        Write-Output 'WhiteLily stopped; forced fallback was required.'
      }
    }
  }
  catch {
    Write-Output "FAIL: $($_.Exception.Message)"
    $script:stopExitCode = 1
  }
  finally {
    if (
      $createdMarker -and
      (Test-Path -LiteralPath $markerPath -PathType Leaf) -and
      [System.IO.File]::ReadAllText($markerPath) -eq $markerToken
    ) {
      Remove-Item -LiteralPath $markerPath -Force -ErrorAction SilentlyContinue
    }
    if ($removePid) {
      $null = Remove-PidRecordIfMatches -ExpectedPid $processId
    }
  }
}

try {
  $lifecycleMutex = Enter-LifecycleMutex
  Invoke-WhiteLilyStop
}
catch {
  Write-Output "FAIL: $($_.Exception.Message)"
  $script:stopExitCode = 1
}
finally {
  Exit-LifecycleMutex -Mutex $lifecycleMutex
}

exit $stopExitCode
