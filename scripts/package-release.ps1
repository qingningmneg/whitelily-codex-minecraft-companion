[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$')]
  [string]$Version
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'release-path-safety.ps1')

function Assert-SafePayload {
  param([string]$Root)
  $files = @(Get-SafePayloadFiles $Root)
  foreach ($relative in $files) {
    if ($relative -match '(?i)(?:^|/)(?:\.git|data|logs|saves)(?:/|$)' -or $relative -match '(?i)(?:^|/)auth\.json$') {
      throw "Release payload contains a private path: $relative"
    }
  }
  return $files
}

function Assert-CleanTrackedTree {
  & git diff --quiet --ignore-submodules --exit-code
  if ($LASTEXITCODE -ne 0) { throw "Refusing to package a working tree with tracked changes." }
  & git diff --cached --quiet --ignore-submodules --exit-code
  if ($LASTEXITCODE -ne 0) { throw "Refusing to package an index with staged changes." }
}

function Invoke-ExportPrivacyScan {
  param([string]$ExportRoot)
  $exportGitDirectory = Assert-SafeChildPath (Join-Path $ExportRoot ".git") $ExportRoot
  Push-Location $ExportRoot
  try {
    & git init -q
    if ($LASTEXITCODE -ne 0) { throw "Could not initialize the committed export for privacy scanning." }
    & git add --all
    if ($LASTEXITCODE -ne 0) { throw "Could not index the committed export for privacy scanning." }
    & (Join-Path $ExportRoot "scripts\release-check.ps1") -ScanOnly
    if ($LASTEXITCODE -ne 0) { throw "Committed export privacy scan failed." }
  } finally {
    Remove-SafePath $exportGitDirectory $ExportRoot
    Pop-Location
  }
}

function New-ReproducibleZip {
  param([string]$Source, [string]$Destination)
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $stream = [IO.File]::Open($Destination, [IO.FileMode]::CreateNew)
  try {
    $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $false)
    try {
      $epoch = [DateTimeOffset]::new(1980, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
      foreach ($relative in (Assert-SafePayload $Source)) {
        $entry = $archive.CreateEntry($relative, [IO.Compression.CompressionLevel]::Optimal)
        $entry.LastWriteTime = $epoch
        $input = [IO.File]::OpenRead((Join-Path $Source ($relative.Replace("/", [IO.Path]::DirectorySeparatorChar))))
        try {
          $output = $entry.Open()
          try { $input.CopyTo($output) } finally { $output.Dispose() }
        } finally { $input.Dispose() }
      }
    } finally { $archive.Dispose() }
  } finally { $stream.Dispose() }
}

$repoRoot = [IO.Path]::GetFullPath((& git rev-parse --show-toplevel).Trim())
$releaseRoot = Initialize-SafeDirectoryRoot (Join-Path $repoRoot "release") $repoRoot
$stage = Assert-SafeChildPath (Join-Path $releaseRoot "whitelily-$Version") $releaseRoot
$zip = Assert-SafeChildPath (Join-Path $releaseRoot "whitelily-$Version-windows-x64.zip") $releaseRoot
$checksum = Assert-SafeChildPath "$zip.sha256" $releaseRoot
$sourceArchive = Assert-SafeChildPath (Join-Path $releaseRoot "whitelily-$Version-source.zip") $releaseRoot
$export = Assert-SafeChildPath (Join-Path $releaseRoot "whitelily-$Version-export") $releaseRoot
$verify = Assert-SafeChildPath (Join-Path $releaseRoot "whitelily-$Version-verify") $releaseRoot
Assert-CleanTrackedTree
& (Join-Path $repoRoot "scripts\release-check.ps1")
if ($LASTEXITCODE -ne 0) { throw "Release checks failed." }

try {
  foreach ($path in @($stage, $export, $verify, $zip, $checksum, $sourceArchive)) {
    Remove-SafePath $path $releaseRoot
  }
  [void](Assert-SafePathChain $sourceArchive $releaseRoot)
  & git archive --format=zip --output=$sourceArchive HEAD
  if ($LASTEXITCODE -ne 0) { throw "git archive failed." }
  $export = Initialize-SafeDirectoryRoot $export $releaseRoot
  Expand-Archive -LiteralPath $sourceArchive -DestinationPath $export -Force
  Invoke-ExportPrivacyScan $export
  $stage = Initialize-SafeDirectoryRoot $stage $releaseRoot
  $allow = @("src", "dist", "scripts", "codex-workspace", ".codex", "docs/windows-smoke-test.md", "docs/installation-windows.zh-CN.md", "docs/runtime-architecture.md", "package.json", "package-lock.json", "config.example.toml", "README.md", "README.zh-CN.md", "LICENSE", "NOTICE", "CONTRIBUTING.md", "SECURITY.md", "CHANGELOG.md")
  foreach ($item in $allow) {
    $source = Join-Path $export $item
    if (Test-Path -LiteralPath $source) {
      $destination = Join-Path $stage $item
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
      Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force
    }
  }
  $stageFiles = Assert-SafePayload $stage
  [void](Assert-SafePathChain $zip $releaseRoot)
  New-ReproducibleZip $stage $zip
  $verify = Initialize-SafeDirectoryRoot $verify $releaseRoot
  Expand-Archive -LiteralPath $zip -DestinationPath $verify -Force
  $verifiedFiles = Assert-SafePayload $verify
  if (@(Compare-Object $stageFiles $verifiedFiles).Count -ne 0) { throw "Archive contents do not match the validated staging payload." }
  $hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
  [IO.File]::WriteAllText($checksum, "$hash  $(Split-Path -Leaf $zip)`n", [Text.UTF8Encoding]::new($false))
  Write-Host "Created $zip and $checksum"
} finally {
  foreach ($path in @($stage, $export, $verify, $sourceArchive)) {
    Remove-SafePath $path $releaseRoot
  }
}
