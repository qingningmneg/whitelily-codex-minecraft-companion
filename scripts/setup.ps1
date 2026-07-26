[CmdletBinding()]
param(
  [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$failures = [System.Collections.Generic.List[string]]::new()

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

function Find-Command {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Remediation
  )
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if ($null -eq $command) {
    $script:failures.Add("FAIL: $Name was not found. $Remediation")
    return $null
  }
  return $command
}

function Test-MajorVersion {
  param(
    [Parameter(Mandatory = $true)]$Command,
    [Parameter(Mandatory = $true)][string]$Label,
    [Parameter(Mandatory = $true)][int]$Minimum
  )
  try {
    $rawLines = & $Command.Source --version 2>$null
    $commandSucceeded = $?
    $raw = $rawLines | Select-Object -First 1
    if (-not $commandSucceeded -or [string]$raw -notmatch 'v?(\d+)') {
      $script:failures.Add("FAIL: $Label version could not be read. Reinstall $Label.")
      return
    }
    if ([int]$Matches[1] -lt $Minimum) {
      $script:failures.Add("FAIL: $Label $Minimum or newer is required.")
    }
  }
  catch {
    $script:failures.Add("FAIL: $Label version could not be read. Reinstall $Label.")
  }
}

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT -or
    (Get-WindowsBuildForCheck) -lt 22000) {
  $failures.Add('FAIL: Windows 11 is required.')
}

$node = Find-Command -Name 'node' -Remediation 'Install Node.js 24 or newer.'
$npm = Find-Command -Name 'npm' -Remediation 'Install npm 11 or newer.'
$codex = Find-Command -Name 'codex' -Remediation 'Install the local OpenAI Codex CLI.'
if ($null -ne $node) {
  Test-MajorVersion -Command $node -Label 'Node.js' -Minimum 24
}
if ($null -ne $npm) {
  Test-MajorVersion -Command $npm -Label 'npm' -Minimum 11
}

Write-Output 'ChatGPT authentication is required. Run: codex login'
Write-Output 'Platform API-key fallback is disabled.'

if ($failures.Count -gt 0) {
  foreach ($failure in $failures) {
    Write-Output $failure
  }
  exit 1
}

if ($CheckOnly) {
  Write-Output 'Setup prerequisite check passed; no files were changed.'
  exit 0
}

Push-Location $repositoryRoot
try {
  & $npm.Source ci
  if ($LASTEXITCODE -ne 0) {
    throw 'npm ci failed. Check the npm output above and retry.'
  }
  & $npm.Source run build
  if ($LASTEXITCODE -ne 0) {
    throw 'npm run build failed. Check the build output above and retry.'
  }

  $exampleConfig = Join-Path $repositoryRoot 'config.example.toml'
  $personalConfig = Join-Path $repositoryRoot 'config.toml'
  if (-not (Test-Path -LiteralPath $exampleConfig -PathType Leaf)) {
    throw 'config.example.toml is missing. Restore the application files and retry.'
  }
  if (-not (Test-Path -LiteralPath $personalConfig -PathType Leaf)) {
    Copy-Item -LiteralPath $exampleConfig -Destination $personalConfig
    Write-Output 'Created config.toml from the safe example.'
  }
  else {
    Write-Output 'Existing config.toml was preserved.'
  }
}
catch {
  Write-Output "FAIL: $($_.Exception.Message)"
  exit 1
}
finally {
  Pop-Location
}

Write-Output 'Setup completed.'
