[CmdletBinding()]
param(
  [switch]$SkipInstall,
  [switch]$ScanOnly,
  [string]$OwnerConfigPath
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Invoke-CheckedCommand {
  param([string]$FilePath, [string[]]$Arguments)
  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$FilePath $($Arguments -join ' ') failed with exit code $LASTEXITCODE."
  }
}

function Read-ReleaseText {
  param([string]$Path, [string]$DisplayPath)
  $bytes = [IO.File]::ReadAllBytes($Path)
  if ($bytes.Length -eq 0) { return "" }
  if ($bytes.Length -ge 2 -and $bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE) {
    return [Text.Encoding]::Unicode.GetString($bytes, 2, $bytes.Length - 2)
  }
  if ($bytes.Length -ge 2 -and $bytes[0] -eq 0xFE -and $bytes[1] -eq 0xFF) {
    return [Text.Encoding]::BigEndianUnicode.GetString($bytes, 2, $bytes.Length - 2)
  }
  if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
    return [Text.UTF8Encoding]::new($false, $true).GetString($bytes, 3, $bytes.Length - 3)
  }
  if ($bytes -contains 0) {
    $extension = [IO.Path]::GetExtension($DisplayPath).ToLowerInvariant()
    if ($extension -in @(".png", ".jpg", ".jpeg", ".gif", ".ico", ".jar", ".zip", ".woff", ".woff2", ".blend", ".glb")) { return $null }
    throw "Unreadable or ambiguous NUL-containing tracked file: $DisplayPath"
  }
  return [Text.UTF8Encoding]::new($false, $true).GetString($bytes)
}

function ConvertFrom-TomlBasicString {
  param([string]$Value)
  $decoded = [Text.StringBuilder]::new()
  for ($index = 0; $index -lt $Value.Length; $index++) {
    $character = $Value[$index]
    if ($character -ne '\') {
      $codePoint = [int][char]$character
      if ($codePoint -lt 0x20 -or $codePoint -eq 0x7F) {
        throw "config.toml has an invalid owner_username character."
      }
      [void]$decoded.Append($character)
      continue
    }

    $index++
    if ($index -ge $Value.Length) { throw "config.toml has an invalid owner_username escape." }
    $escape = $Value[$index]
    if ($escape -eq 'u' -or $escape -eq 'U') {
      $hexLength = if ($escape -eq 'u') { 4 } else { 8 }
      $digitsStart = $index + 1
      if ($digitsStart + $hexLength -gt $Value.Length) { throw "config.toml has an invalid owner_username escape." }
      $digits = $Value.Substring($digitsStart, $hexLength)
      if ($digits -notmatch '^[0-9A-Fa-f]+$') { throw "config.toml has an invalid owner_username escape." }
      $codePoint = [Convert]::ToInt32($digits, 16)
      if ($codePoint -gt 0x10FFFF -or ($codePoint -ge 0xD800 -and $codePoint -le 0xDFFF)) {
        throw "config.toml has an invalid owner_username Unicode escape."
      }
      if ($codePoint -le 0xFFFF) {
        [void]$decoded.Append([char]$codePoint)
      } else {
        [void]$decoded.Append([char]::ConvertFromUtf32($codePoint))
      }
      $index += $hexLength
      continue
    }

    switch ($escape) {
      '"' { [void]$decoded.Append('"'); continue }
      '\' { [void]$decoded.Append('\'); continue }
      '/' { [void]$decoded.Append('/'); continue }
      'b' { [void]$decoded.Append([char]8); continue }
      'f' { [void]$decoded.Append([char]12); continue }
      'n' { [void]$decoded.Append("`n"); continue }
      'r' { [void]$decoded.Append("`r"); continue }
      't' { [void]$decoded.Append("`t"); continue }
      default { throw "config.toml has an invalid owner_username escape." }
    }
  }
  return $decoded.ToString()
}

function Get-ConfiguredOwner {
  param([string]$ConfigPath)
  if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { return $null }
  $configContent = Read-ReleaseText $ConfigPath "config.toml"
  $ownerLines = @($configContent -split "`r?`n" | Where-Object { $_ -match '^\s*owner_username\s*=' })
  if ($ownerLines.Count -eq 0) { return $null }
  if ($ownerLines.Count -ne 1) { throw "config.toml contains more than one owner_username value." }
  $line = $ownerLines[0]
  $doubleMatch = [regex]::Match($line, '^\s*owner_username\s*=\s*"((?:\\.|[^"\\])*)"\s*(?:#.*)?$')
  if ($doubleMatch.Success) {
    return ConvertFrom-TomlBasicString $doubleMatch.Groups[1].Value
  }
  $singleMatch = [regex]::Match($line, "^\\s*owner_username\\s*=\\s*'([^']*)'\\s*(?:#.*)?$")
  if ($singleMatch.Success) { return $singleMatch.Groups[1].Value }
  throw "config.toml has a malformed owner_username value."
}

$repoRoot = (& git rev-parse --show-toplevel).Trim()
if ([string]::IsNullOrWhiteSpace($repoRoot)) {
  throw "release-check.ps1 must run inside a Git repository."
}
$repoRoot = [IO.Path]::GetFullPath($repoRoot)
Push-Location $repoRoot
try {
  $tracked = @((& git ls-files -z) -split "`0" | Where-Object { $_ } | ForEach-Object {
    $_.Replace('\', '/')
  })
  $trackedMinecraftSavePattern = '(?i)(?:^|/)\.minecraft/' + 'saves/'
  $failures = [Collections.Generic.List[string]]::new()
  foreach ($path in $tracked) {
    if ($path -ceq "config.toml" -or
      $path -match '^(?:data|logs)/' -or
      $path -match '(?i)(?:^|/)auth\.json$' -or
      $path -match '(?i)\.(?:zip|sha256)$' -or
      $path -match $trackedMinecraftSavePattern -or
      $path -match '(?i)(?:^|/)saves/') {
      $failures.Add("tracked private or generated path: $path")
    }
  }

  $minecraftSaveContentPattern = '(?i)\.minecraft[\\/]' + 'saves[\\/]'
  $contentPatterns = @(
    @{ Label = "non-test API secret"; Pattern = '\bsk-(?!test-)[A-Za-z0-9_-]{20,}\b' },
    @{
      Label = "non-placeholder API environment assignment"
      Pattern = '(?im)\b(?:OPENAI_API_KEY|CODEX_API_KEY|CODEX_ACCESS_TOKEN)\s*=\s*(?!["'']?(?:REDACTED|YOUR_[A-Z0-9_]+|TEST_ONLY)["'']?\s*$)\S+'
    },
    @{ Label = "Windows user-profile path"; Pattern = '(?i)[A-Z]:[\\/]Users[\\/](?!(?:Owner|Other)[\\/])[^\\/\s]+[\\/]' },
    @{ Label = "Minecraft save path"; Pattern = $minecraftSaveContentPattern },
    @{ Label = "non-example email address"; Pattern = '(?i)\b[A-Z0-9._%+-]+@(?!example\.(?:invalid|com|org|net)\b)[A-Z0-9.-]+\.[A-Z]{2,}\b' }
  )
  $launcherCredentialMarker = ("PCL" + "2" + "Credential" + "Store")
  $localConfig = if ([string]::IsNullOrWhiteSpace($OwnerConfigPath)) {
    Join-Path $repoRoot "config.toml"
  }
  else {
    [IO.Path]::GetFullPath($OwnerConfigPath)
  }
  $localOwner = Get-ConfiguredOwner $localConfig

  foreach ($path in $tracked) {
    $fullPath = Join-Path $repoRoot ($path.Replace("/", [IO.Path]::DirectorySeparatorChar))
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) { continue }
    $text = Read-ReleaseText $fullPath $path
    if ($null -eq $text) { continue }
    foreach ($contentPattern in $contentPatterns) {
      if ($path -ceq "package-lock.json" -and $contentPattern.Label -ceq "non-example email address") {
        continue
      }
      if ([regex]::IsMatch($text, $contentPattern.Pattern)) {
        $failures.Add("$($contentPattern.Label) in tracked file: $path")
      }
    }
    if ($text.Contains($launcherCredentialMarker)) {
      $failures.Add("launcher credential-store marker in tracked file: $path")
    }
    if ($null -ne $localOwner -and $text.Contains($localOwner)) {
      $failures.Add("local owner identity found in a tracked file: $path")
    }
  }

  if ($failures.Count -gt 0) {
    $failures | ForEach-Object { Write-Error $_ }
    throw "Release privacy scan failed with $($failures.Count) finding(s)."
  }

  Write-Host "Release privacy scan passed for $($tracked.Count) tracked files."
  if ($ScanOnly) { return }
  if (-not $SkipInstall) { Invoke-CheckedCommand npm @("ci") }
  Invoke-CheckedCommand npm @("run", "format:check")
  Invoke-CheckedCommand npm @("run", "typecheck")
  Invoke-CheckedCommand npm @("test", "--", "--no-file-parallelism")
  Invoke-CheckedCommand npm @("run", "build")
} finally {
  Pop-Location
}
