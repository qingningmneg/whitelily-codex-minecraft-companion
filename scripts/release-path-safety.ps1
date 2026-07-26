function Assert-SafeChildPath {
  param(
    [Parameter(Mandatory = $true)][string]$Child,
    [Parameter(Mandatory = $true)][string]$Parent
  )
  $fullChild = [IO.Path]::GetFullPath($Child)
  $fullParent = [IO.Path]::GetFullPath($Parent).TrimEnd(
    [IO.Path]::DirectorySeparatorChar,
    [IO.Path]::AltDirectorySeparatorChar
  )
  $prefix = $fullParent + [IO.Path]::DirectorySeparatorChar
  if (-not $fullChild.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Refusing to operate outside the trusted release boundary.'
  }
  return $fullChild
}

function Assert-PathItemIsNotReparsePoint {
  param([Parameter(Mandatory = $true)][string]$Path)
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  if (
    $null -ne $item -and
    ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
  ) {
    throw "Refusing to operate through a reparse point: $Path"
  }
}

function Clear-DeletionBlockingAttributes {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)]$Attributes
  )
  $blocking = [IO.FileAttributes]::ReadOnly -bor
    [IO.FileAttributes]::Hidden -bor
    [IO.FileAttributes]::System
  $cleared = $Attributes -band (-bnot $blocking)
  if ($cleared -ne $Attributes) {
    [IO.File]::SetAttributes($Path, $cleared)
  }
}

function Assert-SafePathChain {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$TrustedRoot
  )
  $fullRoot = [IO.Path]::GetFullPath($TrustedRoot).TrimEnd(
    [IO.Path]::DirectorySeparatorChar,
    [IO.Path]::AltDirectorySeparatorChar
  )
  $fullPath = [IO.Path]::GetFullPath($Path)
  if (-not $fullPath.Equals($fullRoot, [StringComparison]::OrdinalIgnoreCase)) {
    $fullPath = Assert-SafeChildPath $fullPath $fullRoot
  }
  Assert-PathItemIsNotReparsePoint $fullRoot
  if ($fullPath.Equals($fullRoot, [StringComparison]::OrdinalIgnoreCase)) {
    return $fullPath
  }
  $relative = $fullPath.Substring($fullRoot.Length).TrimStart(
    [IO.Path]::DirectorySeparatorChar,
    [IO.Path]::AltDirectorySeparatorChar
  )
  $current = $fullRoot
  foreach ($segment in $relative.Split(
      @([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar),
      [StringSplitOptions]::RemoveEmptyEntries
    )) {
    $current = Join-Path $current $segment
    Assert-PathItemIsNotReparsePoint $current
  }
  return $fullPath
}

function Initialize-SafeDirectoryRoot {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$TrustedParent
  )
  $fullPath = Assert-SafeChildPath $Path $TrustedParent
  [void](Assert-SafePathChain $fullPath $TrustedParent)
  $existing = Get-Item -LiteralPath $fullPath -Force -ErrorAction SilentlyContinue
  if ($null -eq $existing) {
    New-Item -ItemType Directory -Path $fullPath | Out-Null
  }
  [void](Assert-SafePathChain $fullPath $TrustedParent)
  $created = Get-Item -LiteralPath $fullPath -Force -ErrorAction Stop
  if (
    -not $created.PSIsContainer -or
    ($created.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
  ) {
    throw "Safe release root is not a directory: $fullPath"
  }
  return $fullPath
}

function Get-SafePayloadFiles {
  param([Parameter(Mandatory = $true)][string]$Root)
  $fullRoot = [IO.Path]::GetFullPath($Root).TrimEnd(
    [IO.Path]::DirectorySeparatorChar,
    [IO.Path]::AltDirectorySeparatorChar
  )
  Assert-PathItemIsNotReparsePoint $fullRoot
  $rootItem = Get-Item -LiteralPath $fullRoot -Force -ErrorAction Stop
  if (
    -not $rootItem.PSIsContainer -or
    ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
  ) {
    throw "Payload root is not a directory: $fullRoot"
  }
  $directories = [Collections.Generic.Queue[string]]::new()
  $files = [Collections.Generic.List[string]]::new()
  $directories.Enqueue($fullRoot)
  while ($directories.Count -gt 0) {
    $directory = $directories.Dequeue()
    Assert-PathItemIsNotReparsePoint $directory
    foreach ($item in @(Get-ChildItem -LiteralPath $directory -Force)) {
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Release payload contains a reparse point: $($item.FullName)"
      }
      if ($item.PSIsContainer) {
        $directories.Enqueue($item.FullName)
      }
      else {
        $relative = $item.FullName.Substring($fullRoot.Length).TrimStart(
          [IO.Path]::DirectorySeparatorChar,
          [IO.Path]::AltDirectorySeparatorChar
        ).Replace('\', '/')
        $files.Add($relative)
      }
    }
  }
  return @($files | Sort-Object)
}

function Remove-SafePath {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$TrustedRoot
  )
  $fullPath = Assert-SafeChildPath $Path $TrustedRoot
  [void](Assert-SafePathChain $fullPath $TrustedRoot)
  $item = Get-Item -LiteralPath $fullPath -Force -ErrorAction SilentlyContinue
  if ($null -eq $item) {
    return
  }
  if (-not $item.PSIsContainer) {
    [void](Assert-SafePathChain $fullPath $TrustedRoot)
    $current = Get-Item -LiteralPath $fullPath -Force -ErrorAction Stop
    if (
      $current.PSIsContainer -or
      ($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
    ) {
      throw "Release path changed type before deletion: $fullPath"
    }
    Clear-DeletionBlockingAttributes $fullPath $current.Attributes
    Assert-PathItemIsNotReparsePoint $fullPath
    [IO.File]::Delete($fullPath)
    return
  }

  $queue = [Collections.Generic.Queue[string]]::new()
  $directories = [Collections.Generic.List[string]]::new()
  $files = [Collections.Generic.List[string]]::new()
  $queue.Enqueue($fullPath)
  while ($queue.Count -gt 0) {
    $directory = $queue.Dequeue()
    [void](Assert-SafePathChain $directory $TrustedRoot)
    $directories.Add($directory)
    foreach ($child in @(Get-ChildItem -LiteralPath $directory -Force)) {
      if (($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing recursive deletion containing a reparse point: $($child.FullName)"
      }
      if ($child.PSIsContainer) {
        $queue.Enqueue($child.FullName)
      }
      else {
        $files.Add($child.FullName)
      }
    }
  }

  foreach ($file in $files) {
    [void](Assert-SafePathChain $file $TrustedRoot)
    $current = Get-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
    if ($null -eq $current) {
      continue
    }
    if (
      $current.PSIsContainer -or
      ($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
    ) {
      throw "Release file changed type before deletion: $file"
    }
    Clear-DeletionBlockingAttributes $file $current.Attributes
    Assert-PathItemIsNotReparsePoint $file
    [IO.File]::Delete($file)
  }
  foreach ($directory in @($directories | Sort-Object Length -Descending)) {
    [void](Assert-SafePathChain $directory $TrustedRoot)
    $current = Get-Item -LiteralPath $directory -Force -ErrorAction SilentlyContinue
    if ($null -eq $current) {
      continue
    }
    if (
      -not $current.PSIsContainer -or
      ($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
    ) {
      throw "Release directory changed type before deletion: $directory"
    }
    Clear-DeletionBlockingAttributes $directory $current.Attributes
    Assert-PathItemIsNotReparsePoint $directory
    [IO.Directory]::Delete($directory, $false)
  }
}
