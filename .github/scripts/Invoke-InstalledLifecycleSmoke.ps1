[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$BuildDirectory,

  [Parameter(Mandatory = $true)]
  [switch]$ExecuteDisposableGitHubHostedLifecycle
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
. (Join-Path $PSScriptRoot "InstalledLifecycleAssertions.ps1")

$ProductPackageId = "OhMyContextDeveloperPreview"
$ProductTitle = "OhMyContext Developer Preview"
$ProductPublisher = "OhMyContext project contributors"
$ProductProcessName = "OhMyContextDeveloperPreview"
$ApplicationExecutableName = "OhMyContextDeveloperPreview.exe"
$SetupFileName = "OhMyContext-Developer-Preview-Unsigned-Setup.exe"
$ReleaseManifestName = "OWNCONTEXT-RELEASE-CANDIDATE.json"
$ReleaseChecksumsName = "OWNCONTEXT-RELEASE-SHA256SUMS"
$CodexMarkerStart = "# >>> owncontext managed MCP server (do not edit) >>>"
$CodexMarkerEnd = "# <<< owncontext managed MCP server <<<"
$LifecycleEvidenceName = "WINDOWS-INSTALLED-LIFECYCLE-CI.json"
$MaximumTextFileBytes = 1024 * 1024
$ProcessTimeoutMilliseconds = 60 * 1000

function Throw-BoundaryFailure {
  param([string]$Message)
  throw "Installed lifecycle boundary rejected: $Message"
}

function Assert-RegularDirectory {
  param([string]$LiteralPath, [string]$Label)
  $item = Get-Item -LiteralPath $LiteralPath -Force -ErrorAction Stop
  if (
    -not $item.PSIsContainer -or
    (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
  ) {
    Throw-BoundaryFailure "$Label must be a regular directory."
  }
  return [IO.Path]::GetFullPath($item.FullName)
}

function Assert-RegularFile {
  param([string]$LiteralPath, [string]$Label, [long]$MaximumBytes = 2GB)
  $item = Get-Item -LiteralPath $LiteralPath -Force -ErrorAction Stop
  if (
    $item.PSIsContainer -or
    (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) -or
    $item.Length -lt 1 -or
    $item.Length -gt $MaximumBytes
  ) {
    Throw-BoundaryFailure "$Label must be a bounded regular file."
  }
  return [IO.Path]::GetFullPath($item.FullName)
}

function Test-StrictDescendant {
  param([string]$Parent, [string]$Candidate)
  $parentPath = [IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetFullPath($Parent))
  $candidatePath = [IO.Path]::GetFullPath($Candidate)
  return (
    $candidatePath.Length -gt $parentPath.Length -and
    $candidatePath.StartsWith(
      "$parentPath$([IO.Path]::DirectorySeparatorChar)",
      [StringComparison]::OrdinalIgnoreCase
    )
  )
}

function Get-Sha256 {
  param([string]$LiteralPath)
  return (Get-FileHash -LiteralPath $LiteralPath -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Read-BoundedUtf8 {
  param([string]$LiteralPath, [long]$MaximumBytes = $MaximumTextFileBytes)
  $path = Assert-RegularFile $LiteralPath "text input" $MaximumBytes
  $bytes = [IO.File]::ReadAllBytes($path)
  $encoding = [Text.UTF8Encoding]::new($false, $true)
  return $encoding.GetString($bytes)
}

function Invoke-BoundedProcess {
  param(
    [string]$FilePath,
    [string[]]$ArgumentList = @(),
    [string]$WorkingDirectory,
    [hashtable]$EnvironmentOverrides = @{},
    [string[]]$RemoveEnvironment = @(),
    [int]$TimeoutMilliseconds = $ProcessTimeoutMilliseconds,
    [int]$MaximumOutputCharacters = 256 * 1024
  )

  $executable = Assert-RegularFile $FilePath "child executable"
  $workingRoot = Assert-RegularDirectory $WorkingDirectory "child working directory"
  if ($TimeoutMilliseconds -lt 1 -or $TimeoutMilliseconds -gt 120000) {
    Throw-BoundaryFailure "child timeout is invalid."
  }

  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $executable
  $startInfo.WorkingDirectory = $workingRoot
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  foreach ($argument in $ArgumentList) {
    if ($null -eq $argument -or $argument.Contains([char]0)) {
      Throw-BoundaryFailure "child argument is invalid."
    }
    [void]$startInfo.ArgumentList.Add($argument)
  }
  foreach ($name in $RemoveEnvironment) {
    [void]$startInfo.Environment.Remove($name)
  }
  foreach ($entry in $EnvironmentOverrides.GetEnumerator()) {
    if (
      [string]::IsNullOrWhiteSpace([string]$entry.Key) -or
      $null -eq $entry.Value -or
      ([string]$entry.Value).Contains([char]0)
    ) {
      Throw-BoundaryFailure "child environment override is invalid."
    }
    $startInfo.Environment[[string]$entry.Key] = [string]$entry.Value
  }

  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  try {
    if (-not $process.Start()) {
      throw "Child process did not start."
    }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit($TimeoutMilliseconds)) {
      try { $process.Kill($true) } catch { }
      [void]$process.WaitForExit(5000)
      throw "Child process exceeded its time bound."
    }
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    if (
      $stdout.Length -gt $MaximumOutputCharacters -or
      $stderr.Length -gt $MaximumOutputCharacters
    ) {
      throw "Child process output exceeded its content bound."
    }
    if ($process.ExitCode -ne 0) {
      throw "Child process returned a nonzero status."
    }
    return [PSCustomObject]@{
      ExitCode = $process.ExitCode
      Stdout = $stdout
      Stderr = $stderr
    }
  }
  finally {
    $process.Dispose()
  }
}

function Wait-Until {
  param(
    [scriptblock]$Condition,
    [int]$TimeoutMilliseconds,
    [string]$FailureMessage
  )
  $timer = [Diagnostics.Stopwatch]::StartNew()
  do {
    if (& $Condition) { return }
    Start-Sleep -Milliseconds 250
  } while ($timer.ElapsedMilliseconds -lt $TimeoutMilliseconds)
  throw $FailureMessage
}

function Start-UnobservedProcess {
  param(
    [string]$FilePath,
    [string[]]$ArgumentList = @(),
    [string]$WorkingDirectory,
    [hashtable]$EnvironmentOverrides = @{},
    [string[]]$RemoveEnvironment = @()
  )

  $executable = Assert-RegularFile $FilePath "child executable"
  $workingRoot = Assert-RegularDirectory $WorkingDirectory "child working directory"
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $executable
  $startInfo.WorkingDirectory = $workingRoot
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  foreach ($argument in $ArgumentList) {
    if ($null -eq $argument -or $argument.Contains([char]0)) {
      Throw-BoundaryFailure "child argument is invalid."
    }
    [void]$startInfo.ArgumentList.Add($argument)
  }
  foreach ($name in $RemoveEnvironment) {
    [void]$startInfo.Environment.Remove($name)
  }
  foreach ($entry in $EnvironmentOverrides.GetEnumerator()) {
    if (
      [string]::IsNullOrWhiteSpace([string]$entry.Key) -or
      $null -eq $entry.Value -or
      ([string]$entry.Value).Contains([char]0)
    ) {
      Throw-BoundaryFailure "child environment override is invalid."
    }
    $startInfo.Environment[[string]$entry.Key] = [string]$entry.Value
  }
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  if (-not $process.Start()) {
    $process.Dispose()
    throw "Child process did not start."
  }
  return $process
}

function Get-ProductProcesses {
  return @(Get-Process -Name $ProductProcessName -ErrorAction SilentlyContinue)
}

function Describe-ProductProcesses {
  return @(
    Get-ProductProcesses | ForEach-Object {
      $path = "unknown"
      try { $path = [string]$_.Path } catch { }
      "pid=$($_.Id);path=$path"
    }
  )
}

function Get-OwnContextArpRecords {
  $records = @()
  foreach ($view in @(
    [Microsoft.Win32.RegistryView]::Registry32,
    [Microsoft.Win32.RegistryView]::Registry64
  )) {
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
      [Microsoft.Win32.RegistryHive]::CurrentUser,
      $view
    )
    try {
      $uninstall = $base.OpenSubKey("Software\Microsoft\Windows\CurrentVersion\Uninstall")
      if ($null -eq $uninstall) { continue }
      try {
        foreach ($keyName in $uninstall.GetSubKeyNames()) {
          $key = $uninstall.OpenSubKey($keyName)
          if ($null -eq $key) { continue }
          try {
            $displayName = [string]$key.GetValue("DisplayName", "")
            if (
              -not $keyName.Equals($ProductPackageId, [StringComparison]::OrdinalIgnoreCase) -and
              -not $displayName.Equals($ProductTitle, [StringComparison]::Ordinal)
            ) {
              continue
            }
            $records += [PSCustomObject]@{
              View = [string]$view
              KeyName = $keyName
              DisplayName = $displayName
              DisplayVersion = [string]$key.GetValue("DisplayVersion", "")
              Publisher = [string]$key.GetValue("Publisher", "")
              InstallLocation = [string]$key.GetValue("InstallLocation", "")
              UninstallString = [string]$key.GetValue(
                "UninstallString",
                "",
                [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
              )
              QuietUninstallString = [string]$key.GetValue(
                "QuietUninstallString",
                "",
                [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
              )
            }
          }
          finally {
            $key.Dispose()
          }
        }
      }
      finally {
        $uninstall.Dispose()
      }
    }
    finally {
      $base.Dispose()
    }
  }
  return @($records)
}

function Get-ShortcutRoots {
  $desktop = [Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory)
  $startMenu = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
  return @(
    [PSCustomObject]@{ Kind = "desktop"; Path = $desktop },
    [PSCustomObject]@{ Kind = "start-menu"; Path = $startMenu }
  )
}

function Get-ProductShortcuts {
  $shell = New-Object -ComObject WScript.Shell
  $results = @()
  try {
    foreach ($root in Get-ShortcutRoots) {
      if (-not (Test-Path -LiteralPath $root.Path -PathType Container)) { continue }
      $links = @(Get-ChildItem -LiteralPath $root.Path -Filter "*.lnk" -File -Recurse -Force)
      if (@($links).Count -gt 5000) {
        Throw-BoundaryFailure "shortcut inventory exceeded its bound."
      }
      foreach ($link in $links) {
        if (
          -not $link.BaseName.Equals($ProductTitle, [StringComparison]::OrdinalIgnoreCase) -and
          -not $link.BaseName.Equals($ProductPackageId, [StringComparison]::OrdinalIgnoreCase)
        ) {
          continue
        }
        $shortcut = $shell.CreateShortcut($link.FullName)
        try {
          $results += [PSCustomObject]@{
            Kind = $root.Kind
            Path = $link.FullName
            TargetPath = [string]$shortcut.TargetPath
            Arguments = [string]$shortcut.Arguments
          }
        }
        finally {
          [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut)
        }
      }
    }
  }
  finally {
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)
  }
  return @($results)
}

function Assert-ShortcutTargets {
  param(
    [object[]]$Shortcuts,
    [string[]]$DirectApplicationTargets,
    [string]$UpdateExecutable
  )
  foreach ($kind in @("desktop", "start-menu")) {
    $matching = @($Shortcuts | Where-Object { $_.Kind -eq $kind })
    if (@($matching).Count -ne 1) {
      throw "Expected exactly one $kind shortcut."
    }
    $shortcut = $matching[0]
    if (-not (Test-ExactSquirrelShortcutLaunch `
      -TargetPath $shortcut.TargetPath `
      -Arguments $shortcut.Arguments `
      -DirectApplicationTargets $DirectApplicationTargets `
      -UpdateExecutable $UpdateExecutable `
      -ApplicationExecutableName $ApplicationExecutableName)) {
      throw "Installed shortcut is not an exact verified Squirrel application launch."
    }
  }
}

function ConvertTo-TomlString {
  param([string]$Value)
  return ConvertTo-Json -InputObject $Value -Compress
}

function Seed-IsolatedClientConfigs {
  param(
    [string]$ProfileRoot,
    [string]$ClaudeConfigRoot,
    [string]$InstalledExecutable,
    [string]$McpEntry,
    [string]$VaultPath,
    [string]$Canary,
    [string]$BrokerPipeName,
    [string]$AllowedCollection = "installed-lifecycle"
  )
  $codexDirectory = Join-Path $ProfileRoot ".codex"
  [void](New-Item -ItemType Directory -Path $codexDirectory -ErrorAction Stop)
  [void](New-Item -ItemType Directory -Path $ClaudeConfigRoot -ErrorAction Stop)
  $codexPath = Join-Path $codexDirectory "config.toml"
  $claudePath = Join-Path $ClaudeConfigRoot ".claude.json"

  $codexEnvironment = if ($BrokerPipeName) {
    "OWNCONTEXT_MCP_BROKER_PIPE = $(ConvertTo-TomlString $BrokerPipeName), OWNCONTEXT_ALLOWED_COLLECTION = $(ConvertTo-TomlString $AllowedCollection), OWNCONTEXT_CLIENT_KIND = `"codex`", ELECTRON_RUN_AS_NODE = `"1`""
  } else {
    "OWNCONTEXT_VAULT_PATH = $(ConvertTo-TomlString $VaultPath), OWNCONTEXT_ALLOWED_COLLECTION = $(ConvertTo-TomlString $AllowedCollection), OWNCONTEXT_CLIENT_KIND = `"codex`", ELECTRON_RUN_AS_NODE = `"1`""
  }
  $codexLines = @(
    "model_provider = $(ConvertTo-TomlString $Canary)",
    "",
    $CodexMarkerStart,
    "[mcp_servers.owncontext]",
    "command = $(ConvertTo-TomlString $InstalledExecutable)",
    "args = [$(ConvertTo-TomlString $McpEntry)]",
    "env = { $codexEnvironment }",
    $CodexMarkerEnd,
    "[projects.$(ConvertTo-TomlString $Canary)]",
    "trust_level = `"trusted`""
  )
  $codexBefore = [string]::Join("`n", $codexLines) + "`n"
  $codexAfter = [string]::Join("`n", @(
    $codexLines[0],
    "",
    $codexLines[8],
    $codexLines[9]
  )) + "`n"
  [IO.File]::WriteAllText($codexPath, $codexBefore, [Text.UTF8Encoding]::new($false))

  $unrelatedClaudeServer = [ordered]@{
    type = "stdio"
    command = $env:ComSpec
    args = @("/d", "/c", "exit", "0")
    env = [ordered]@{
      OWNCONTEXT_LIFECYCLE_CANARY = $Canary
      UNRELATED_CLAUDE_CANARY = "preserve-this-exact-value"
    }
    unrelatedMetadata = [ordered]@{
      preserve = $true
      nested = @("alpha", 7, $false)
    }
  }
  $rootCanary = [ordered]@{
    value = $Canary
    preserved = $true
    extra = [ordered]@{ exact = "root-canary" }
  }
  $expectedClaudeRoot = [ordered]@{
    ownContextLifecycleCanary = $rootCanary
    mcpServers = [ordered]@{
      "unrelated-ci-canary" = $unrelatedClaudeServer
    }
  }
  $claudeEnvironment = [ordered]@{
    OWNCONTEXT_ALLOWED_COLLECTION = $AllowedCollection
    OWNCONTEXT_CLIENT_KIND = "claude-code"
    OWNCONTEXT_MANAGED_BY = "owncontext-desktop-v1"
    ELECTRON_RUN_AS_NODE = "1"
  }
  if ($BrokerPipeName) {
    $claudeEnvironment.OWNCONTEXT_MCP_BROKER_PIPE = $BrokerPipeName
  } else {
    $claudeEnvironment.OWNCONTEXT_VAULT_PATH = $VaultPath
  }
  $claudeRoot = [ordered]@{
    ownContextLifecycleCanary = $rootCanary
    mcpServers = [ordered]@{
      "unrelated-ci-canary" = $unrelatedClaudeServer
      owncontext = [ordered]@{
        type = "stdio"
        command = $InstalledExecutable
        args = @($McpEntry)
        env = $claudeEnvironment
      }
    }
  }
  $expectedClaudeCanonical = ConvertTo-CanonicalJsonText (
    ConvertTo-Json -InputObject $expectedClaudeRoot -Depth 20 -Compress
  )
  $claudeText = ConvertTo-Json -InputObject $claudeRoot -Depth 20
  [IO.File]::WriteAllText(
    $claudePath,
    "$claudeText`n",
    [Text.UTF8Encoding]::new($false)
  )

  return [PSCustomObject]@{
    CodexPath = $codexPath
    ClaudePath = $claudePath
    ExpectedCodexAfter = $codexAfter
    ExpectedClaudeCanonical = $expectedClaudeCanonical
  }
}

function Assert-IsolatedConfigsRemoved {
  param([object]$Fixture)
  $codexAfter = Read-BoundedUtf8 $Fixture.CodexPath
  if (-not $codexAfter.Equals($Fixture.ExpectedCodexAfter, [StringComparison]::Ordinal)) {
    throw "Codex uninstall cleanup did not preserve the exact unrelated canary projection."
  }
  if ($codexAfter.Contains($CodexMarkerStart) -or $codexAfter.Contains($CodexMarkerEnd)) {
    throw "Codex uninstall cleanup left a managed marker."
  }

  $claudeAfterCanonical = ConvertTo-CanonicalJsonText (
    Read-BoundedUtf8 $Fixture.ClaudePath
  )
  if (-not $claudeAfterCanonical.Equals(
    $Fixture.ExpectedClaudeCanonical,
    [StringComparison]::Ordinal
  )) {
    throw "Claude uninstall cleanup did not preserve the exact unrelated JSON projection."
  }
}

function Assert-InstalledPayloadChecksums {
  param([string]$ApplicationRoot, [string]$ChecksumText)
  $lines = @($ChecksumText -split "\r?\n" | Where-Object { $_.Length -gt 0 })
  if (@($lines).Count -lt 1 -or @($lines).Count -gt 20000) {
    throw "Installed payload checksum inventory is outside its bound."
  }
  $seen = [Collections.Generic.HashSet[string]]::new(
    [StringComparer]::OrdinalIgnoreCase
  )
  foreach ($line in $lines) {
    $match = [Regex]::Match($line, "^([0-9a-f]{64})  (.+)$")
    if (-not $match.Success) {
      throw "Installed payload checksum inventory is malformed."
    }
    $relativePath = $match.Groups[2].Value
    $segments = @($relativePath -split "/")
    if (
      $relativePath.StartsWith("/", [StringComparison]::Ordinal) -or
      $relativePath.Contains("\") -or
      $relativePath.Contains(":") -or
      $relativePath.Contains([char]0) -or
      @($segments).Count -lt 1 -or
      @($segments | Where-Object { $_ -eq "" -or $_ -eq "." -or $_ -eq ".." }).Count -ne 0
    ) {
      throw "Installed payload checksum path is unsafe."
    }
    if (-not $seen.Add($relativePath)) {
      throw "Installed payload checksum path is duplicated."
    }
    $candidate = [IO.Path]::GetFullPath((Join-Path $ApplicationRoot $relativePath))
    if (-not (Test-StrictDescendant $ApplicationRoot $candidate)) {
      throw "Installed payload checksum path escaped the application root."
    }
    $currentDirectory = $ApplicationRoot
    foreach ($segment in $segments[0..([Math]::Max(0, @($segments).Count - 2))]) {
      if (@($segments).Count -eq 1) { break }
      $currentDirectory = Assert-RegularDirectory (
        Join-Path $currentDirectory $segment
      ) "checksummed installed payload parent"
    }
    $file = Assert-RegularFile $candidate "checksummed installed payload"
    if ((Get-Sha256 $file) -ne $match.Groups[1].Value) {
      throw "Installed payload differs from its verified checksum inventory."
    }
  }
}

function Remove-VerifiedTemporaryRoot {
  param([string]$TemporaryRoot, [string]$TemporaryBase)
  if (-not (Test-Path -LiteralPath $TemporaryRoot)) { return }
  $root = Assert-RegularDirectory $TemporaryRoot "lifecycle temporary root"
  if (-not (Test-StrictDescendant $TemporaryBase $root)) {
    Throw-BoundaryFailure "temporary cleanup target escaped the OS temporary directory."
  }
  Remove-Item -LiteralPath $root -Recurse -Force
}

if (-not $ExecuteDisposableGitHubHostedLifecycle.IsPresent) {
  Throw-BoundaryFailure "the explicit disposable-runner execution switch is required."
}
if (
  $env:GITHUB_ACTIONS -ne "true" -or
  $env:OWNCONTEXT_RUNNER_ENVIRONMENT -ne "github-hosted" -or
  $env:OWNCONTEXT_RUNNER_LABEL -ne "windows-latest" -or
  $env:OWNCONTEXT_DISPOSABLE_RUNNER_ACK -ne "github-hosted-windows-latest-disposable" -or
  $env:RUNNER_OS -ne "Windows" -or
  $env:RUNNER_ARCH -ne "X64" -or
  [string]::IsNullOrWhiteSpace($env:ImageOS) -or
  -not $env:ImageOS.StartsWith("win", [StringComparison]::OrdinalIgnoreCase) -or
  [string]::IsNullOrWhiteSpace($env:ImageVersion)
) {
  Throw-BoundaryFailure "actual Setup execution is allowed only on a GitHub-hosted disposable windows-latest image."
}
if (
  [string]::IsNullOrWhiteSpace($env:GITHUB_WORKSPACE) -or
  [string]::IsNullOrWhiteSpace($env:GITHUB_SHA) -or
  $env:GITHUB_SHA -notmatch "^[0-9a-fA-F]{40}$" -or
  [string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)
) {
  Throw-BoundaryFailure "required GitHub Actions identity variables are absent."
}

$workspace = Assert-RegularDirectory $env:GITHUB_WORKSPACE "GitHub workspace"
$outRoot = Assert-RegularDirectory (Join-Path $workspace "apps\desktop\out") "Forge output root"
$build = Assert-RegularDirectory $BuildDirectory "Forge build directory"
if (
  -not (Test-StrictDescendant $outRoot $build) -or
  [IO.Directory]::GetParent($build).FullName -ne $outRoot -or
  [IO.Path]::GetFileName($build) -notmatch "^(unsigned|public)-[0-9TZ.-]+-[0-9]+$"
) {
  Throw-BoundaryFailure "the requested build is not one exact unsigned Forge build directory."
}

$manifestPath = Join-Path $build "evidence\$ReleaseManifestName"
$manifest = (Read-BoundedUtf8 $manifestPath) | ConvertFrom-Json -Depth 30
$commit = $env:GITHUB_SHA.ToLowerInvariant()
$publicRelease = [bool]$manifest.release.publicRelease
if ($publicRelease) {
  $ProductPackageId = "OhMyContext"
  $ProductTitle = "OhMyContext"
  $ProductPublisher = "NextH and OhMyContext contributors"
  $ProductProcessName = "OhMyContext"
  $ApplicationExecutableName = "OhMyContext.exe"
  $SetupFileName = "OhMyContext-Setup.exe"
  $expectedPackagedDirectoryName = "OhMyContext-win32-x64"
  $expectedProductName = "OhMyContext"
} else {
  $expectedPackagedDirectoryName = "OhMyContext Developer Preview-win32-x64"
  $expectedProductName = $ProductTitle
}
if (
  $manifest.schemaVersion -ne 1 -or
  (($publicRelease -and $manifest.status -ne "PUBLIC RELEASE") -or
    (-not $publicRelease -and $manifest.status -ne "DRAFT — NOT FOR PUBLIC RELEASE")) -or
  $manifest.product -ne "OhMyContext" -or
  $manifest.release.platform -ne "Windows x64" -or
  (($publicRelease -and $manifest.release.channel -ne "stable") -or
    (-not $publicRelease -and $manifest.release.channel -ne "developer-alpha")) -or
  $manifest.release.publicRelease -ne $publicRelease -or
  $manifest.source.commit -ne $commit -or
  $manifest.source.trackedWorktreeClean -ne $true
) {
  Throw-BoundaryFailure "source-bound release manifest does not match this CI revision and release boundary."
}
$releaseVersion = [string]$manifest.release.version
if ($releaseVersion -notmatch "^[0-9]+[.][0-9]+[.][0-9]+$") {
  Throw-BoundaryFailure "release version is not a simple Squirrel version."
}
$setupArtifacts = @($manifest.artifacts | Where-Object { $_.role -eq "windows-setup" })
if (@($setupArtifacts).Count -ne 1) {
  Throw-BoundaryFailure "release manifest must name one setup artifact."
}
$setupArtifact = $setupArtifacts[0]
$expectedSetupRelativePath = "make/squirrel.windows/x64/$SetupFileName"
if (
  $setupArtifact.relativePath -ne $expectedSetupRelativePath -or
  [string]$setupArtifact.sha256 -notmatch "^[0-9a-f]{64}$" -or
  [long]$setupArtifact.size -lt 1
) {
  Throw-BoundaryFailure "release manifest setup identity is invalid."
}
$setupPath = Assert-RegularFile (
  Join-Path $build ($expectedSetupRelativePath.Replace("/", "\"))
) "source-bound Setup" 2GB
if (-not (Test-StrictDescendant $build $setupPath)) {
  Throw-BoundaryFailure "Setup escaped the exact Forge build directory."
}
$setupHash = Get-Sha256 $setupPath
$setupLength = (Get-Item -LiteralPath $setupPath).Length
if ($setupHash -ne $setupArtifact.sha256 -or $setupLength -ne [long]$setupArtifact.size) {
  Throw-BoundaryFailure "Setup bytes differ from the source-bound manifest."
}
$checksumsPath = Assert-RegularFile (
  Join-Path $build "evidence\$ReleaseChecksumsName"
) "source-bound release checksum index" $MaximumTextFileBytes
if (
  $manifest.releaseChecksums.relativePath -ne "evidence/$ReleaseChecksumsName" -or
  [long]$manifest.releaseChecksums.size -ne (Get-Item -LiteralPath $checksumsPath).Length -or
  [string]$manifest.releaseChecksums.sha256 -ne (Get-Sha256 $checksumsPath)
) {
  Throw-BoundaryFailure "release checksum index differs from its manifest identity."
}
$checksums = Read-BoundedUtf8 $checksumsPath
$escapedRelativeSetup = [Regex]::Escape($expectedSetupRelativePath)
$checksumMatches = @([Regex]::Matches(
  $checksums,
  "(?m)^([0-9a-f]{64})  $escapedRelativeSetup$"
))
if (@($checksumMatches).Count -ne 1 -or $checksumMatches[0].Groups[1].Value -ne $setupHash) {
  Throw-BoundaryFailure "release checksum index does not bind the exact Setup bytes."
}
$checksumLines = @($checksums -split "\r?\n" | Where-Object { $_.Length -gt 0 })
if (@($checksumLines).Count -ne [int]$manifest.releaseChecksums.entryCount) {
  Throw-BoundaryFailure "release checksum index entry count changed."
}

$localAppData = Assert-RegularDirectory $env:LOCALAPPDATA "local application data root"
$installRoot = [IO.Path]::GetFullPath((Join-Path $localAppData $ProductPackageId))
if (-not (Test-StrictDescendant $localAppData $installRoot)) {
  Throw-BoundaryFailure "expected Squirrel install root escaped local application data."
}
if (Test-Path -LiteralPath $installRoot) {
  throw "A prior OwnContext installation tree exists on the runner."
}
if (@(Get-ProductProcesses).Count -ne 0) {
  throw "A prior OwnContext process exists on the runner."
}
if (@(Get-OwnContextArpRecords).Count -ne 0) {
  throw "A prior OwnContext uninstall registration exists on the runner."
}
if (@(Get-ProductShortcuts).Count -ne 0) {
  throw "A prior OwnContext shortcut exists on the runner."
}

$temporaryBase = Assert-RegularDirectory ([IO.Path]::GetTempPath()) "OS temporary root"
$temporaryRoot = Join-Path $temporaryBase ("owncontext-installed-lifecycle-" + [Guid]::NewGuid().ToString("N"))
[void](New-Item -ItemType Directory -Path $temporaryRoot -ErrorAction Stop)
$temporaryRoot = Assert-RegularDirectory $temporaryRoot "lifecycle temporary root"
if (-not (Test-StrictDescendant $temporaryBase $temporaryRoot)) {
  Throw-BoundaryFailure "lifecycle temporary root escaped the OS temporary directory."
}
$profileRoot = Join-Path $temporaryRoot "profile"
$claudeConfigRoot = Join-Path $temporaryRoot "claude-config"
$guiRoot = Join-Path $temporaryRoot "gui"
$brokerSmokeRoot = Join-Path $temporaryRoot "broker-smoke"
$mcpSmokeRoot = Join-Path $temporaryRoot "mcp"
$mcpProfileRoot = Join-Path $mcpSmokeRoot "profile"
$mcpAppDataRoot = Join-Path $mcpSmokeRoot "appdata"
$mcpLocalAppDataRoot = Join-Path $mcpSmokeRoot "local-appdata"
$mcpTempRoot = Join-Path $mcpSmokeRoot "temp"
[void](New-Item -ItemType Directory -Path $profileRoot -ErrorAction Stop)
[void](New-Item -ItemType Directory -Path $guiRoot -ErrorAction Stop)
[void](New-Item -ItemType Directory -Path $brokerSmokeRoot -ErrorAction Stop)
[void](New-Item -ItemType Directory -Path $mcpSmokeRoot -ErrorAction Stop)
foreach ($mcpEnvironmentDirectory in @(
  $mcpProfileRoot,
  $mcpAppDataRoot,
  $mcpLocalAppDataRoot,
  $mcpTempRoot
)) {
  [void](New-Item -ItemType Directory -Path $mcpEnvironmentDirectory -ErrorAction Stop)
  [void](Assert-RegularDirectory $mcpEnvironmentDirectory "isolated MCP environment directory")
  if (-not (Test-StrictDescendant $mcpSmokeRoot $mcpEnvironmentDirectory)) {
    Throw-BoundaryFailure "isolated MCP environment directory escaped its smoke root."
  }
}

$isolatedEnvironment = @{
  HOME = $profileRoot
  USERPROFILE = $profileRoot
  CLAUDE_CONFIG_DIR = $claudeConfigRoot
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1"
  DISABLE_AUTOUPDATER = "1"
  DISABLE_ERROR_REPORTING = "1"
  DISABLE_TELEMETRY = "1"
}
$primaryFailure = $null
$installedExecutable = $null
$rootApplicationExecutable = $null
$updateExecutable = $null
$configFixture = $null
$explicitUninstallCompleted = $false
$forcedTerminationCompleted = $false
$cleanProfileRelaunchCompleted = $false
$forcedProcess = $null
$brokerProcess = $null
$brokerSmokeCompleted = $false

try {
  [void](Invoke-BoundedProcess `
    -FilePath $setupPath `
    -ArgumentList @("--silent") `
    -WorkingDirectory ([IO.Path]::GetDirectoryName($setupPath)) `
    -EnvironmentOverrides $isolatedEnvironment `
    -RemoveEnvironment @("ELECTRON_RUN_AS_NODE") `
    -TimeoutMilliseconds 90000)

  try {
    # Setup launches Squirrel's detached Update.exe worker; on a clean
    # GitHub-hosted Windows image extraction can outlive the bootstrapper by
    # more than 30 seconds even though no product process remains.
    Wait-Until -TimeoutMilliseconds 120000 -FailureMessage "Silent Setup did not settle." -Condition {
      (Test-Path -LiteralPath $installRoot -PathType Container) -and
      @(Get-ProductProcesses).Count -eq 0
    }
  } catch {
    $processes = @(Describe-ProductProcesses)
    $candidates = @(
      Get-ChildItem -LiteralPath $localAppData -Directory -Force -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match "(?i)owncontext|ohmy" } |
        ForEach-Object { $_.FullName }
    )
    $suffix = if ($processes.Count -gt 0) {
      " Processes: $($processes -join ' | ')"
    } else {
      " No matching product process remained. Candidate install directories: $($candidates -join ' | ')"
    }
    throw "$($_.Exception.Message)$suffix"
  }
  $installedRoot = Assert-RegularDirectory $installRoot "installed Squirrel root"
  $updateExecutable = Assert-RegularFile (Join-Path $installedRoot "Update.exe") "installed Update.exe"
  $rootApplicationExecutable = Assert-RegularFile (
    Join-Path $installedRoot $ApplicationExecutableName
  ) "installed Squirrel application execution stub"
  $applicationDirectories = @(Get-ChildItem -LiteralPath $installedRoot -Directory -Filter "app-*" -Force)
  if (
    @($applicationDirectories).Count -ne 1 -or
    $applicationDirectories[0].Name -ne "app-$releaseVersion" -or
    (($applicationDirectories[0].Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
  ) {
    throw "Installed Squirrel application version directory is not exact."
  }
  $applicationRoot = Assert-RegularDirectory $applicationDirectories[0].FullName "installed application version root"
  $installedExecutable = Assert-RegularFile (
    Join-Path $applicationRoot $ApplicationExecutableName
  ) "installed application executable"
  $installedVersionPayload = Assert-RegularFile (Join-Path $applicationRoot "version") "installed version payload" 128
  $installedMcpEntry = Assert-RegularFile (
    Join-Path $applicationRoot "resources\mcp-server\cli.mjs"
  ) "installed MCP entry"
  $installedCompliance = Assert-RegularFile (
    Join-Path $applicationRoot "resources\compliance\SHA256SUMS"
  ) "installed compliance checksums" $MaximumTextFileBytes

  $packagedRoot = Assert-RegularDirectory (
    Join-Path $build $expectedPackagedDirectoryName
  ) "verified unpacked package"
  foreach ($comparison in @(
    @($installedExecutable, (Join-Path $packagedRoot $ApplicationExecutableName), "application executable"),
    @($installedVersionPayload, (Join-Path $packagedRoot "version"), "version payload"),
    @($installedMcpEntry, (Join-Path $packagedRoot "resources\mcp-server\cli.mjs"), "MCP entry"),
    @($installedCompliance, (Join-Path $packagedRoot "resources\compliance\SHA256SUMS"), "compliance checksum payload")
  )) {
    $expectedFile = Assert-RegularFile $comparison[1] "packaged $($comparison[2])"
    if ((Get-Sha256 $comparison[0]) -ne (Get-Sha256 $expectedFile)) {
      throw "Installed $($comparison[2]) differs from the verified package."
    }
  }
  Assert-InstalledPayloadChecksums $applicationRoot (Read-BoundedUtf8 $installedCompliance)
  $versionInfo = (Get-Item -LiteralPath $installedExecutable).VersionInfo
  if (
    $versionInfo.FileVersion -ne $releaseVersion -or
    $versionInfo.ProductVersion -ne $releaseVersion -or
    $versionInfo.ProductName -ne $expectedProductName -or
    $versionInfo.OriginalFilename -ne $ApplicationExecutableName
  ) {
    throw "Installed executable version metadata is not exact."
  }

  Wait-Until -TimeoutMilliseconds 15000 -FailureMessage "Squirrel registration or shortcuts did not appear." -Condition {
    @(Get-OwnContextArpRecords).Count -eq 1 -and
    @(Get-ProductShortcuts).Count -eq 2
  }
  $arpRecords = Get-OwnContextArpRecords
  if (@($arpRecords).Count -ne 1) { throw "Expected one OwnContext uninstall registration." }
  $arp = $arpRecords[0]
  if (
    $arp.KeyName -ne $ProductPackageId -or
    $arp.DisplayName -ne $ProductTitle -or
    $arp.DisplayVersion -ne $releaseVersion -or
    $arp.Publisher -ne $ProductPublisher -or
    -not (Test-ExactSquirrelArpCommands `
      -UpdateExecutable $updateExecutable `
      -UninstallString $arp.UninstallString `
      -QuietUninstallString $arp.QuietUninstallString) -or
    [string]::IsNullOrWhiteSpace($arp.InstallLocation) -or
    -not ([IO.Path]::TrimEndingDirectorySeparator(
      [IO.Path]::GetFullPath($arp.InstallLocation)
    )).Equals(
      [IO.Path]::TrimEndingDirectorySeparator($installedRoot),
      [StringComparison]::OrdinalIgnoreCase
    )
  ) {
    throw "Installed uninstall registration does not identify the verified product root."
  }
  Assert-ShortcutTargets `
    -Shortcuts (Get-ProductShortcuts) `
    -DirectApplicationTargets @($rootApplicationExecutable, $installedExecutable) `
    -UpdateExecutable $updateExecutable

  $guiNonce = [Guid]::NewGuid().ToString()
  $guiEnvironment = @{} + $isolatedEnvironment
  $guiEnvironment.OWNCONTEXT_GUI_SMOKE_ROOT = $guiRoot
  $guiEnvironment.OWNCONTEXT_GUI_SMOKE_NONCE = $guiNonce
  [void](Invoke-BoundedProcess `
    -FilePath $installedExecutable `
    -ArgumentList @("--owncontext-gui-smoke") `
    -WorkingDirectory $applicationRoot `
    -EnvironmentOverrides $guiEnvironment `
    -RemoveEnvironment @("ELECTRON_RUN_AS_NODE") `
    -TimeoutMilliseconds 45000)
  $guiEvidence = (Read-BoundedUtf8 (Join-Path $guiRoot "renderer-ready.json") 16KB) | ConvertFrom-Json -Depth 10
  if (
    $guiEvidence.status -ne "first-run-sample-search-and-connections-preview-complete" -or
    $guiEvidence.nonce -ne $guiNonce -or
    $guiEvidence.isPackaged -ne $true -or
    $guiEvidence.sampleSourceReady -ne $true -or
    $guiEvidence.sampleProvenanceVerified -ne $true -or
    [int]$guiEvidence.resultCardCount -lt 1 -or
    $guiEvidence.connectionsScreenReady -ne $true -or
    $guiEvidence.accessHistoryScreenReady -ne $true -or
    $guiEvidence.desktopHistoryEntryReady -ne $true -or
    $guiEvidence.contentFreeHistoryBoundaryVisible -ne $true
  ) {
    throw "Installed GUI first-run smoke evidence is invalid."
  }

  # Force-terminate a packaged first-run journey before it can publish its
  # renderer evidence, then prove a fresh profile can start and complete.
  $forcedRoot = Join-Path $temporaryRoot "forced-gui"
  $relaunchRoot = Join-Path $temporaryRoot "relaunch-gui"
  [void](New-Item -ItemType Directory -Path $forcedRoot -ErrorAction Stop)
  [void](New-Item -ItemType Directory -Path $relaunchRoot -ErrorAction Stop)
  $forcedEnvironment = @{} + $isolatedEnvironment
  $forcedEnvironment.OWNCONTEXT_GUI_SMOKE_ROOT = $forcedRoot
  $forcedEnvironment.OWNCONTEXT_GUI_SMOKE_NONCE = [Guid]::NewGuid().ToString()
  $forcedProcess = Start-UnobservedProcess `
    -FilePath $installedExecutable `
    -ArgumentList @("--owncontext-gui-smoke") `
    -WorkingDirectory $applicationRoot `
    -EnvironmentOverrides $forcedEnvironment `
    -RemoveEnvironment @("ELECTRON_RUN_AS_NODE")
  Start-Sleep -Milliseconds 1500
  if ($forcedProcess.HasExited) {
    $forcedProcess.Dispose()
    $forcedProcess = $null
    throw "Packaged GUI process exited before forced-termination test."
  }
  $forcedProcess.Kill($true)
  [void]$forcedProcess.WaitForExit(10000)
  if (-not $forcedProcess.HasExited) {
    throw "Forced-termination GUI process did not exit within its bound."
  }
  $forcedProcess.Dispose()
  $forcedProcess = $null
  Wait-Until -TimeoutMilliseconds 15000 -FailureMessage "Forced-termination process cleanup did not settle." -Condition {
    @(Get-ProductProcesses).Count -eq 0
  }
  $forcedTerminationCompleted = $true

  $relaunchNonce = [Guid]::NewGuid().ToString()
  $relaunchEnvironment = @{} + $isolatedEnvironment
  $relaunchEnvironment.OWNCONTEXT_GUI_SMOKE_ROOT = $relaunchRoot
  $relaunchEnvironment.OWNCONTEXT_GUI_SMOKE_NONCE = $relaunchNonce
  [void](Invoke-BoundedProcess `
    -FilePath $installedExecutable `
    -ArgumentList @("--owncontext-gui-smoke") `
    -WorkingDirectory $applicationRoot `
    -EnvironmentOverrides $relaunchEnvironment `
    -RemoveEnvironment @("ELECTRON_RUN_AS_NODE") `
    -TimeoutMilliseconds 45000)
  $relaunchEvidence = (Read-BoundedUtf8 (Join-Path $relaunchRoot "renderer-ready.json") 16KB) | ConvertFrom-Json -Depth 10
  if (
    $relaunchEvidence.status -ne "first-run-sample-search-and-connections-preview-complete" -or
    $relaunchEvidence.nonce -ne $relaunchNonce -or
    $relaunchEvidence.isPackaged -ne $true -or
    [int]$relaunchEvidence.resultCardCount -lt 1 -or
    $relaunchEvidence.connectionsScreenReady -ne $true -or
    $relaunchEvidence.accessHistoryScreenReady -ne $true
  ) {
    throw "Clean-profile relaunch GUI evidence is invalid."
  }
  $cleanProfileRelaunchCompleted = $true

  $brokerEnvironment = @{} + $isolatedEnvironment
  $brokerEnvironment.OWNCONTEXT_BROKER_SMOKE_ROOT = $brokerSmokeRoot
  $brokerEnvironment.OWNCONTEXT_BROKER_SMOKE_NONCE = [Guid]::NewGuid().ToString()
  $brokerProcess = Start-UnobservedProcess `
    -FilePath $installedExecutable `
    -ArgumentList @("--owncontext-mcp-broker-smoke") `
    -WorkingDirectory $applicationRoot `
    -EnvironmentOverrides $brokerEnvironment `
    -RemoveEnvironment @("ELECTRON_RUN_AS_NODE")
  $brokerReadyPath = Join-Path $brokerSmokeRoot "broker-ready.json"
  Wait-Until -TimeoutMilliseconds 30000 -FailureMessage "Encrypted MCP broker did not become ready." -Condition {
    (Test-Path -LiteralPath $brokerReadyPath -PathType Leaf) -and
    -not $brokerProcess.HasExited
  }
  $brokerReady = (Read-BoundedUtf8 $brokerReadyPath 16KB) | ConvertFrom-Json -Depth 10
  if (
    $brokerReady.status -ne "encrypted-vault-broker-ready" -or
    $brokerReady.nonce -ne $brokerEnvironment.OWNCONTEXT_BROKER_SMOKE_NONCE -or
    [string]$brokerReady.pipeName -notmatch "^\\\\[.]\\pipe\\owncontext-mcp-[0-9a-f]{32}$" -or
    $brokerReady.collection -ne "default" -or
    $brokerReady.query -ne "weekly review"
  ) {
    throw "Encrypted MCP broker readiness evidence is invalid."
  }

  $nodeExecutable = (Get-Command node -CommandType Application -ErrorAction Stop).Source
  $mcpScript = Assert-RegularFile (
    Join-Path $workspace ".github\scripts\installed-mcp-smoke.mjs"
  ) "installed MCP smoke harness" $MaximumTextFileBytes
  $mcpEnvironment = @{
    HOME = $mcpProfileRoot
    USERPROFILE = $mcpProfileRoot
    APPDATA = $mcpAppDataRoot
    LOCALAPPDATA = $mcpLocalAppDataRoot
    TEMP = $mcpTempRoot
    TMP = $mcpTempRoot
    OWNCONTEXT_INSTALLED_SMOKE_ROOT = $mcpSmokeRoot
    OWNCONTEXT_INSTALLED_ROOT = $installedRoot
    OWNCONTEXT_INSTALLED_EXE = $installedExecutable
    OWNCONTEXT_INSTALLED_MCP = $installedMcpEntry
    OWNCONTEXT_MCP_BROKER_PIPE = [string]$brokerReady.pipeName
  }
  [void](Invoke-BoundedProcess `
    -FilePath $nodeExecutable `
    -ArgumentList @($mcpScript) `
    -WorkingDirectory $workspace `
    -EnvironmentOverrides $mcpEnvironment `
    -TimeoutMilliseconds 45000)
  $brokerSmokeCompleted = $true
  if (-not $brokerProcess.HasExited) { $brokerProcess.Kill($true) }
  [void]$brokerProcess.WaitForExit(10000)
  $brokerProcess.Dispose()
  $brokerProcess = $null

  $configFixture = Seed-IsolatedClientConfigs `
    -ProfileRoot $profileRoot `
    -ClaudeConfigRoot $claudeConfigRoot `
    -InstalledExecutable $installedExecutable `
    -McpEntry $installedMcpEntry `
    -VaultPath (Join-Path $mcpSmokeRoot "vault.sqlite") `
    -Canary ("lifecycle-" + [Guid]::NewGuid().ToString("N")) `
    -BrokerPipeName ([string]$brokerReady.pipeName) `
    -AllowedCollection ([string]$brokerReady.collection)

  [void](Invoke-BoundedProcess `
    -FilePath $updateExecutable `
    -ArgumentList @("--uninstall", "-s") `
    -WorkingDirectory $installedRoot `
    -EnvironmentOverrides $isolatedEnvironment `
    -RemoveEnvironment @("ELECTRON_RUN_AS_NODE") `
    -TimeoutMilliseconds 90000)

  Wait-Until -TimeoutMilliseconds 60000 -FailureMessage "Squirrel uninstall did not remove every installed-state surface." -Condition {
    -not (Test-Path -LiteralPath $installRoot) -and
    @(Get-ProductProcesses).Count -eq 0 -and
    @(Get-OwnContextArpRecords).Count -eq 0 -and
    @(Get-ProductShortcuts).Count -eq 0
  }
  $explicitUninstallCompleted = $true
  Assert-IsolatedConfigsRemoved $configFixture
  if ((Get-Sha256 $setupPath) -ne $setupHash) {
    Throw-BoundaryFailure "Setup bytes changed during lifecycle verification."
  }

  $ciEvidenceDirectory = Join-Path $build "ci-evidence"
  [void](New-Item -ItemType Directory -Path $ciEvidenceDirectory -ErrorAction Stop)
  $evidencePath = Join-Path $ciEvidenceDirectory $LifecycleEvidenceName
  $evidence = [ordered]@{
    schemaVersion = 1
    status = "passed"
    control = "windows-squirrel-installed-lifecycle"
    result = "PASS"
    sourceCommit = $commit
    runner = "github-hosted/windows-latest"
    nodeRequired = $false
    installerSha256 = $setupHash
    steps = [ordered]@{
      "setup-install" = $true
      "no-node-launch" = $true
      "sample-import-and-search" = $true
      "mcp-search-and-fetch" = $brokerSmokeCompleted
      "forced-termination-recovery" = $forcedTerminationCompleted
      "managed-client-cleanup" = $true
      "squirrel-uninstall" = $true
      "clean-profile-relaunch" = $cleanProfileRelaunchCompleted
    }
    setup = [ordered]@{
      fileName = $SetupFileName
      size = $setupLength
      sha256 = $setupHash
    }
    source = [ordered]@{
      commit = $commit
      releaseId = [string]$manifest.release.releaseId
      forgeBuildId = [IO.Path]::GetFileName($build)
      bundleContextRevalidated = $true
    }
    runnerDetails = [ordered]@{
      environment = "github-hosted"
      requestedLabel = "windows-latest"
      os = $env:RUNNER_OS
      architecture = $env:RUNNER_ARCH
      imageOS = $env:ImageOS
      imageVersion = $env:ImageVersion
    }
    assertions = [ordered]@{
      priorStateAbsent = $true
      silentSetupCompleted = $true
      allDeclaredInstalledPayloadHashesMatchedVerifiedPackage = $true
      arpAndShortcutTargetsVerified = $true
      isolatedInstalledGuiJourneyCompleted = $true
      forcedTerminationRecoveryCompleted = $forcedTerminationCompleted
      cleanProfileRelaunchCompleted = $cleanProfileRelaunchCompleted
      installedPackagedMcpSearchFetchCompleted = $true
      managedClientEntriesRemoved = $true
      unrelatedClientCanariesPreserved = $true
      processInstallTreeArpAndShortcutsAbsentAfterUninstall = $true
    }
    doesNotProve = @(
      "a clean consumer machine or operation without the CI-provided Node.js toolchain",
      "an update channel, upgrade, rollback, or recovery path",
      "erasure of user vault data or other user-created data",
      "interactive shell shortcut activation or independent byte provenance for generated Update.exe and the root execution stub"
    )
  }
  $evidenceJson = ConvertTo-Json -InputObject $evidence -Depth 12
  $evidenceBytes = [Text.UTF8Encoding]::new($false).GetBytes("$evidenceJson`n")
  if ($evidenceBytes.Length -gt 16KB) {
    throw "Lifecycle evidence exceeded its content bound."
  }
  $handle = [IO.File]::Open(
    $evidencePath,
    [IO.FileMode]::CreateNew,
    [IO.FileAccess]::Write,
    [IO.FileShare]::None
  )
  try {
    $handle.Write($evidenceBytes, 0, $evidenceBytes.Length)
    $handle.Flush($true)
  }
  finally {
    $handle.Dispose()
  }
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $evidence -Depth 12 -Compress))
}
catch {
  $primaryFailure = $_
}
finally {
  if ($null -ne $forcedProcess) {
    try {
      if (-not $forcedProcess.HasExited) { $forcedProcess.Kill($true) }
      [void]$forcedProcess.WaitForExit(5000)
    } catch { }
    try { $forcedProcess.Dispose() } catch { }
    $forcedProcess = $null
  }
  if ($null -ne $brokerProcess) {
    try {
      if (-not $brokerProcess.HasExited) { $brokerProcess.Kill($true) }
      [void]$brokerProcess.WaitForExit(5000)
    } catch { }
    try { $brokerProcess.Dispose() } catch { }
    $brokerProcess = $null
  }
  if (-not $explicitUninstallCompleted -and $null -ne $updateExecutable) {
    try {
      [void](Invoke-BoundedProcess `
        -FilePath $updateExecutable `
        -ArgumentList @("--uninstall", "-s") `
        -WorkingDirectory $installRoot `
        -EnvironmentOverrides $isolatedEnvironment `
        -RemoveEnvironment @("ELECTRON_RUN_AS_NODE") `
        -TimeoutMilliseconds 90000)
    }
    catch {
      # The disposable runner is discarded after this fail-closed job. Never
      # convert a failed lifecycle assertion into a passing cleanup result.
    }
  }
  try {
    Remove-VerifiedTemporaryRoot $temporaryRoot $temporaryBase
  }
  catch {
    if ($null -eq $primaryFailure) { $primaryFailure = $_ }
  }
}

if ($null -ne $primaryFailure) {
  throw $primaryFailure
}
