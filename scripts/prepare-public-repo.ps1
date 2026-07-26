[CmdletBinding()]
param([switch]$InitializeFreshHistory)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'release-path-safety.ps1')

$repoRoot = [IO.Path]::GetFullPath((& git rev-parse --show-toplevel).Trim())
$releaseRoot = Initialize-SafeDirectoryRoot (Join-Path $repoRoot "release") $repoRoot
$candidate = Assert-SafeChildPath (Join-Path $releaseRoot "public-repo") $releaseRoot
$archive = Assert-SafeChildPath (Join-Path $releaseRoot "public-repo-export.zip") $releaseRoot
$sourceOwnerConfig = Join-Path $repoRoot "config.toml"
Remove-SafePath $candidate $releaseRoot
Remove-SafePath $archive $releaseRoot
try {
  [void](Assert-SafePathChain $archive $releaseRoot)
  & git archive --format=zip --output=$archive HEAD
  if ($LASTEXITCODE -ne 0) { throw "git archive failed." }
  $candidate = Initialize-SafeDirectoryRoot $candidate $releaseRoot
  Expand-Archive -LiteralPath $archive -DestinationPath $candidate -Force
  Push-Location $candidate
  try {
    & git init -b main
    if ($LASTEXITCODE -ne 0) { throw "git init failed." }
    & git config core.autocrlf false
    if ($LASTEXITCODE -ne 0) { throw "git config failed." }
    & git add .
    if ($LASTEXITCODE -ne 0) { throw "git add failed." }
    & (Join-Path $candidate "scripts\release-check.ps1") -ScanOnly -OwnerConfigPath $sourceOwnerConfig
    if ($LASTEXITCODE -ne 0) { throw "Exported release owner scan failed." }
    & (Join-Path $candidate "scripts\release-check.ps1") -ScanOnly
    if ($LASTEXITCODE -ne 0) { throw "Exported release scan failed." }
    if ($InitializeFreshHistory) {
      & git -c user.name="WhiteLily Release" -c user.email="release@example.invalid" commit -m "Initial public release"
      if ($LASTEXITCODE -ne 0) { throw "git commit failed." }
    } else {
      $candidateGit = Assert-SafeChildPath (Join-Path $candidate ".git") $candidate
      Remove-SafePath $candidateGit $candidate
    }
  } finally { Pop-Location }
  Write-Host "Prepared local public candidate at $candidate"
} finally {
  Remove-SafePath $archive $releaseRoot
}
