[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$fatalFailure = $false

function Get-WindowsBuildForCheck {
  $actual = [System.Environment]::OSVersion.Version.Build
  $fixtureMarker = Join-Path $repositoryRoot '.whitelily-test-fixture'
  if (
    -not [string]::IsNullOrWhiteSpace($env:WHITELILY_TEST_WINDOWS_BUILD) -and
    (Test-Path -LiteralPath $fixtureMarker -PathType Leaf) -and
    [System.IO.File]::ReadAllText($fixtureMarker) -eq "WhiteLily Windows script fixture v1`n"
  ) {
    $simulated = 0
    if (
      [int]::TryParse($env:WHITELILY_TEST_WINDOWS_BUILD, [ref]$simulated) -and
      $simulated -ge 0 -and
      $simulated -lt $actual
    ) {
      return $simulated
    }
  }
  return $actual
}

function Write-Check {
  param(
    [Parameter(Mandatory = $true)][ValidateSet('PASS', 'WARN', 'FAIL')][string]$Status,
    [Parameter(Mandatory = $true)][string]$Label,
    [Parameter(Mandatory = $true)][string]$Message
  )
  Write-Output "${Status}: ${Label} - ${Message}"
  if ($Status -eq 'FAIL') {
    $script:fatalFailure = $true
  }
}

function Read-MajorVersion {
  param([Parameter(Mandatory = $true)]$Command)
  try {
    $rawLines = & $Command.Source --version 2>$null
    $commandSucceeded = $?
    $raw = $rawLines | Select-Object -First 1
    if ($commandSucceeded -and [string]$raw -match 'v?(\d+)') {
      return [int]$Matches[1]
    }
  }
  catch {
    return $null
  }
  return $null
}

function Test-LoopbackPort {
  param(
    [Parameter(Mandatory = $true)][int]$Port,
    [Parameter(Mandatory = $true)][int]$TimeoutMilliseconds
  )
  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $connection = $client.ConnectAsync('127.0.0.1', $Port)
    return $connection.Wait($TimeoutMilliseconds) -and $client.Connected
  }
  catch {
    return $false
  }
  finally {
    $client.Dispose()
  }
}

function Test-PortAvailable {
  param([Parameter(Mandatory = $true)][int]$Port)
  $listener = $null
  try {
    $listener = [System.Net.Sockets.TcpListener]::new(
      [System.Net.IPAddress]::Loopback,
      $Port
    )
    $listener.Start()
    return $true
  }
  catch {
    return $false
  }
  finally {
    if ($null -ne $listener) {
      $listener.Stop()
    }
  }
}

function Test-TargetWritable {
  param([Parameter(Mandatory = $true)][string]$Target)
  $probeDirectory = if (Test-Path -LiteralPath $Target -PathType Container) {
    $Target
  }
  else {
    $repositoryRoot
  }
  $probe = Join-Path $probeDirectory ".whitelily-doctor-$([guid]::NewGuid().ToString('N')).tmp"
  try {
    [System.IO.File]::WriteAllText($probe, 'probe')
    return $true
  }
  catch {
    return $false
  }
  finally {
    if (Test-Path -LiteralPath $probe -PathType Leaf) {
      Remove-Item -LiteralPath $probe -Force
    }
  }
}

if ([System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT -and
    (Get-WindowsBuildForCheck) -ge 22000) {
  Write-Check -Status PASS -Label 'Windows version' -Message 'Windows 11 detected.'
}
else {
  Write-Check -Status FAIL -Label 'Windows version' -Message 'Windows 11 is required.'
}

$node = Get-Command node -ErrorAction SilentlyContinue
$nodeMajor = if ($null -ne $node) { Read-MajorVersion -Command $node } else { $null }
if ($null -ne $nodeMajor -and $nodeMajor -ge 24) {
  Write-Check -Status PASS -Label 'Node version' -Message 'Node.js 24 or newer is available.'
}
else {
  Write-Check -Status FAIL -Label 'Node version' -Message 'Install Node.js 24 or newer.'
}

$npm = Get-Command npm -ErrorAction SilentlyContinue
$npmMajor = if ($null -ne $npm) { Read-MajorVersion -Command $npm } else { $null }
if ($null -ne $npmMajor -and $npmMajor -ge 11) {
  Write-Check -Status PASS -Label 'npm version' -Message 'npm 11 or newer is available.'
}
else {
  Write-Check -Status FAIL -Label 'npm version' -Message 'Install npm 11 or newer.'
}

$codex = Get-Command codex -ErrorAction SilentlyContinue
if ($null -eq $codex) {
  Write-Check -Status FAIL -Label 'Codex executable' -Message 'Install the local OpenAI Codex CLI.'
}
else {
  Write-Check -Status PASS -Label 'Codex executable' -Message 'Local Codex CLI found.'
  try {
    $loginLines = & $codex.Source login status 2>$null
    $commandSucceeded = $?
    $loginStatus = $loginLines -join "`n"
    if ($commandSucceeded -and $loginStatus -match '(?i)ChatGPT') {
      Write-Check -Status PASS -Label 'Codex login' -Message 'ChatGPT authentication is active.'
    }
    else {
      Write-Check -Status FAIL -Label 'Codex login' -Message 'Run codex login and choose ChatGPT.'
    }
  }
  catch {
    Write-Check -Status FAIL -Label 'Codex login' -Message 'Run codex login and choose ChatGPT.'
  }
}

$configPath = Join-Path $repositoryRoot 'config.toml'
$entryPath = Join-Path $repositoryRoot 'dist\src\index.js'
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
  Write-Check -Status FAIL -Label 'Configuration' -Message 'Run scripts\setup.ps1, then edit config.toml.'
}
elseif ($null -eq $node -or -not (Test-Path -LiteralPath $entryPath -PathType Leaf)) {
  Write-Check -Status FAIL -Label 'Configuration' -Message 'Run scripts\setup.ps1 to build the application.'
}
else {
  try {
    $null = & $node.Source $entryPath --check-config $configPath 2>$null
    if ($?) {
      Write-Check -Status PASS -Label 'Configuration' -Message 'config.toml parsed successfully.'
    }
    else {
      Write-Check -Status FAIL -Label 'Configuration' -Message 'Correct config.toml and run doctor again.'
    }
  }
  catch {
    Write-Check -Status FAIL -Label 'Configuration' -Message 'Correct config.toml and run doctor again.'
  }
}

if (Test-LoopbackPort -Port 25565 -TimeoutMilliseconds 350) {
  Write-Check -Status PASS -Label 'Minecraft port 25565' -Message 'A loopback listener is reachable.'
}
else {
  Write-Check -Status WARN -Label 'Minecraft port 25565' -Message 'Open the disposable world to LAN on port 25565.'
}

if (Test-PortAvailable -Port 32123) {
  Write-Check -Status PASS -Label 'MCP port 32123' -Message 'Port is available.'
}
else {
  Write-Check -Status FAIL -Label 'MCP port 32123' -Message 'Stop the process using this port and retry.'
}

foreach ($name in @('data', 'logs')) {
  if (Test-TargetWritable -Target (Join-Path $repositoryRoot $name)) {
    Write-Check -Status PASS -Label "$name writability" -Message 'Writable.'
  }
  else {
    Write-Check -Status FAIL -Label "$name writability" -Message 'Grant write access to the repository.'
  }
}

if ($fatalFailure) {
  exit 1
}
exit 0
