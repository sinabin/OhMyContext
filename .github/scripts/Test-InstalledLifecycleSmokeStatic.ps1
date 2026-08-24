[CmdletBinding()]
param(
  [string]$RepositoryRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($RepositoryRoot)) {
  $RepositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
}

function Read-BoundedSource {
  param([string]$LiteralPath, [int]$MaximumBytes = 512KB)
  $item = Get-Item -LiteralPath $LiteralPath -Force -ErrorAction Stop
  if (
    $item.PSIsContainer -or
    (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) -or
    $item.Length -lt 1 -or
    $item.Length -gt $MaximumBytes
  ) {
    throw "Static lifecycle source input is invalid."
  }
  return [IO.File]::ReadAllText($item.FullName, [Text.UTF8Encoding]::new($false, $true))
}

function Assert-ContainsExactlyOnce {
  param([string]$Text, [string]$Needle)
  $first = $Text.IndexOf($Needle, [StringComparison]::Ordinal)
  if (
    $first -lt 0 -or
    $Text.IndexOf($Needle, $first + $Needle.Length, [StringComparison]::Ordinal) -ge 0
  ) {
    throw "Static lifecycle invariant is absent or duplicated."
  }
}

$rootItem = Get-Item -LiteralPath $RepositoryRoot -Force -ErrorAction Stop
if (
  -not $rootItem.PSIsContainer -or
  (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
) {
  throw "Repository root is not a regular directory."
}
$root = [IO.Path]::GetFullPath($rootItem.FullName)
$workflowPath = Join-Path $root ".github\workflows\alpha-ci.yml"
$lifecyclePath = Join-Path $root ".github\scripts\Invoke-InstalledLifecycleSmoke.ps1"
$policyPath = Join-Path $root ".github\scripts\InstalledLifecycleAssertions.ps1"
$mcpPath = Join-Path $root ".github\scripts\installed-mcp-smoke.mjs"
$workflow = Read-BoundedSource $workflowPath
$lifecycle = Read-BoundedSource $lifecyclePath
$policy = Read-BoundedSource $policyPath
$mcpSource = Read-BoundedSource $mcpPath

$tokens = $null
$parseErrors = $null
[void][Management.Automation.Language.Parser]::ParseFile(
  $lifecyclePath,
  [ref]$tokens,
  [ref]$parseErrors
)
if (@($parseErrors).Count -ne 0) {
  throw "Installed lifecycle PowerShell does not parse."
}
$policyTokens = $null
$policyParseErrors = $null
$policyAst = [Management.Automation.Language.Parser]::ParseFile(
  $policyPath,
  [ref]$policyTokens,
  [ref]$policyParseErrors
)
if (@($policyParseErrors).Count -ne 0) {
  throw "Installed lifecycle assertion policy does not parse."
}
$unexpectedPolicyStatements = @(
  $policyAst.EndBlock.Statements |
    Where-Object { $_ -isnot [Management.Automation.Language.FunctionDefinitionAst] }
)
if ($unexpectedPolicyStatements.Count -ne 0) {
  throw "Installed lifecycle assertion policy may contain only function definitions."
}

. $policyPath

$canonicalExpected = ConvertTo-CanonicalJsonText '{"root":{"value":"canary","extra":true},"mcpServers":{"unrelated":{"args":["/d","/c","exit","0"],"extra":{"nested":7}}}}'
$canonicalReordered = ConvertTo-CanonicalJsonText '{"mcpServers":{"unrelated":{"extra":{"nested":7},"args":["/d","/c","exit","0"]}},"root":{"extra":true,"value":"canary"}}'
if (-not $canonicalExpected.Equals($canonicalReordered, [StringComparison]::Ordinal)) {
  throw "Canonical JSON comparison is sensitive to object property order."
}
foreach ($mutatedClaudeJson in @(
  '{"root":{"value":"canary","extra":true},"mcpServers":{"unrelated":{"args":["/d","/c","exit","9"],"extra":{"nested":7}}}}',
  '{"root":{"value":"canary","extra":true},"mcpServers":{"unrelated":{"args":["/d","/c","exit","0"],"extra":{"nested":7},"added":true}}}',
  '{"root":{"value":"canary","extra":true},"mcpServers":{"unrelated":{"args":["/d","/c","exit","0"]}}}',
  '{"root":{"value":"canary"},"mcpServers":{"unrelated":{"args":["/d","/c","exit","0"],"extra":{"nested":7}}}}'
)) {
  if ($canonicalExpected.Equals(
    (ConvertTo-CanonicalJsonText $mutatedClaudeJson),
    [StringComparison]::Ordinal
  )) {
    throw "Canonical JSON comparison accepted a changed unrelated Claude projection."
  }
}
$duplicatePropertyRejected = $false
try {
  [void](ConvertTo-CanonicalJsonText '{"root":1,"root":2}')
}
catch {
  $duplicatePropertyRejected = $true
}
if (-not $duplicatePropertyRejected) {
  throw "Canonical JSON comparison accepted a duplicate property."
}

$testUpdate = 'C:\Users\runneradmin\AppData\Local\OhMyContextDeveloperPreview\Update.exe'
$validUninstall = '"C:\Users\runneradmin\AppData\Local\OhMyContextDeveloperPreview\Update.exe" --uninstall'
$validQuietUninstall = "$validUninstall -s"
if (-not (Test-ExactSquirrelArpCommands $testUpdate $validUninstall $validQuietUninstall)) {
  throw "Exact Squirrel ARP command policy rejected the pinned valid form."
}
foreach ($invalidArp in @(
  @('"C:\malware.exe" "C:\Users\runneradmin\AppData\Local\OhMyContextDeveloperPreview\Update.exe" --uninstall', $validQuietUninstall),
  @("$validUninstall --ignored", $validQuietUninstall),
  @($validUninstall, "$validQuietUninstall --ignored"),
  @($validUninstall, $validUninstall)
)) {
  if (Test-ExactSquirrelArpCommands $testUpdate $invalidArp[0] $invalidArp[1]) {
    throw "Exact Squirrel ARP command policy accepted an adversarial command."
  }
}

$testRootStub = 'C:\Users\runneradmin\AppData\Local\OhMyContextDeveloperPreview\OhMyContextDeveloperPreview.exe'
$testVersionExe = 'C:\Users\runneradmin\AppData\Local\OhMyContextDeveloperPreview\app-0.0.0\OhMyContextDeveloperPreview.exe'
$testDirectTargets = @($testRootStub, $testVersionExe)
foreach ($directTarget in $testDirectTargets) {
  foreach ($emptyArguments in @('', '   ')) {
    if (-not (Test-ExactSquirrelShortcutLaunch $directTarget $emptyArguments $testDirectTargets $testUpdate 'OhMyContextDeveloperPreview.exe')) {
      throw "Exact Squirrel shortcut policy rejected an argument-free direct launch."
    }
  }
  if (Test-ExactSquirrelShortcutLaunch $directTarget '--ignored' $testDirectTargets $testUpdate 'OhMyContextDeveloperPreview.exe') {
    throw "Exact Squirrel shortcut policy accepted arguments on a direct launch."
  }
}
foreach ($validUpdaterArguments in @(
  '--processStart OhMyContextDeveloperPreview.exe',
  '--processStart "OhMyContextDeveloperPreview.exe"',
  '--processStart=OhMyContextDeveloperPreview.exe',
  '--processStart="OhMyContextDeveloperPreview.exe"'
)) {
  if (-not (Test-ExactSquirrelShortcutLaunch $testUpdate $validUpdaterArguments $testDirectTargets $testUpdate 'OhMyContextDeveloperPreview.exe')) {
    throw "Exact Squirrel shortcut policy rejected a pinned updater form."
  }
}
foreach ($invalidUpdaterArguments in @(
  '--processStart=Malware.exe --ignored OhMyContextDeveloperPreview.exe',
  '--processStart OhMyContextDeveloperPreview.exe --ignored',
  ' --processStart OhMyContextDeveloperPreview.exe',
  '--processStart OhMyContextDeveloperPreview.exe '
)) {
  if (Test-ExactSquirrelShortcutLaunch $testUpdate $invalidUpdaterArguments $testDirectTargets $testUpdate 'OhMyContextDeveloperPreview.exe') {
    throw "Exact Squirrel shortcut policy accepted an adversarial updater form."
  }
}

$node = (node -p "process.execPath").Trim()
if ([string]::IsNullOrWhiteSpace($node) -or -not [IO.File]::Exists($node)) {
  throw "Node executable path could not be resolved from process.execPath."
}
$nodeStart = [Diagnostics.ProcessStartInfo]::new()
$nodeStart.FileName = $node
$nodeStart.UseShellExecute = $false
$nodeStart.CreateNoWindow = $true
$nodeStart.RedirectStandardOutput = $true
$nodeStart.RedirectStandardError = $true
[void]$nodeStart.ArgumentList.Add("--check")
[void]$nodeStart.ArgumentList.Add($mcpPath)
$nodeProcess = [Diagnostics.Process]::new()
$nodeProcess.StartInfo = $nodeStart
try {
  if (-not $nodeProcess.Start()) {
    throw "Node syntax-check process did not start."
  }
  $stdout = $nodeProcess.StandardOutput.ReadToEndAsync()
  $stderr = $nodeProcess.StandardError.ReadToEndAsync()
  if (-not $nodeProcess.WaitForExit(10000)) {
    try { $nodeProcess.Kill($true) } catch { }
    throw "Installed MCP smoke syntax check timed out."
  }
  if (
    $nodeProcess.ExitCode -ne 0 -or
    $stdout.GetAwaiter().GetResult().Length -gt 16KB -or
    $stderr.GetAwaiter().GetResult().Length -gt 16KB
  ) {
    throw "Installed MCP smoke harness does not parse."
  }
}
finally {
  $nodeProcess.Dispose()
}

Assert-ContainsExactlyOnce $workflow "runs-on: windows-latest"
Assert-ContainsExactlyOnce $workflow "if: `${{ runner.environment != 'github-hosted' }}"
Assert-ContainsExactlyOnce $workflow "if: `${{ runner.environment == 'github-hosted' }}"
Assert-ContainsExactlyOnce $workflow "OWNCONTEXT_RUNNER_ENVIRONMENT: `${{ runner.environment }}"
Assert-ContainsExactlyOnce $workflow "OWNCONTEXT_RUNNER_LABEL: windows-latest"
Assert-ContainsExactlyOnce $workflow "OWNCONTEXT_DISPOSABLE_RUNNER_ACK: github-hosted-windows-latest-disposable"
Assert-ContainsExactlyOnce $workflow "-ExecuteDisposableGitHubHostedLifecycle"
if ($workflow -match "(?im)^\s*runs-on:\s*.*self-hosted") {
  throw "Lifecycle workflow may not select a self-hosted runner."
}
$bundleIndex = $workflow.IndexOf(
  "Re-verify the source-bound draft release bundle",
  [StringComparison]::Ordinal
)
$lifecycleIndex = $workflow.IndexOf(
  "Exercise the actual installed Squirrel lifecycle",
  [StringComparison]::Ordinal
)
if ($bundleIndex -lt 0 -or $lifecycleIndex -le $bundleIndex) {
  throw "Actual installation is not ordered after source-bound bundle verification."
}

foreach ($requiredGate in @(
  '$env:GITHUB_ACTIONS -ne "true"',
  '$env:OWNCONTEXT_RUNNER_ENVIRONMENT -ne "github-hosted"',
  '$env:OWNCONTEXT_RUNNER_LABEL -ne "windows-latest"',
  '$env:OWNCONTEXT_DISPOSABLE_RUNNER_ACK -ne "github-hosted-windows-latest-disposable"',
  '$env:RUNNER_OS -ne "Windows"',
  '$env:RUNNER_ARCH -ne "X64"',
  '$env:ImageOS.StartsWith("win"',
  '$env:ImageVersion'
)) {
  if (-not $lifecycle.Contains($requiredGate, [StringComparison]::Ordinal)) {
    throw "Installed lifecycle runtime gate is incomplete."
  }
}
$requiredLifecycleAssertions = @(
  '. (Join-Path $PSScriptRoot "InstalledLifecycleAssertions.ps1")',
  'ExpectedClaudeCanonical = $expectedClaudeCanonical',
  'ConvertTo-CanonicalJsonText (',
  'QuietUninstallString = [string]$key.GetValue(',
  'Test-ExactSquirrelArpCommands',
  'Test-ExactSquirrelShortcutLaunch',
  'HOME = $mcpProfileRoot',
  'USERPROFILE = $mcpProfileRoot',
  'APPDATA = $mcpAppDataRoot',
  'LOCALAPPDATA = $mcpLocalAppDataRoot',
  'TEMP = $mcpTempRoot',
  'TMP = $mcpTempRoot'
)
foreach ($requiredAssertion in $requiredLifecycleAssertions) {
  if (-not $lifecycle.Contains($requiredAssertion, [StringComparison]::Ordinal)) {
    throw "Installed lifecycle deep assertion or MCP isolation boundary is incomplete."
  }
}
foreach ($forbiddenLifecyclePattern in @(
  '$arp.UninstallString.IndexOf(',
  '--processStart(?:'
)) {
  if ($lifecycle.Contains($forbiddenLifecyclePattern, [StringComparison]::Ordinal)) {
    throw "Installed lifecycle retains a substring-based command assertion."
  }
}
foreach ($requiredMcpAssertion in @(
  '["HOME", "profile"]',
  '["USERPROFILE", "profile"]',
  '["APPDATA", "appdata"]',
  '["LOCALAPPDATA", "local-appdata"]',
  '["TEMP", "temp"]',
  '["TMP", "temp"]',
  'HOME: environmentDirectories.HOME',
  'USERPROFILE: environmentDirectories.USERPROFILE',
  'APPDATA: environmentDirectories.APPDATA',
  'LOCALAPPDATA: environmentDirectories.LOCALAPPDATA',
  'TEMP: environmentDirectories.TEMP',
  'TMP: environmentDirectories.TMP',
  'regularRealDirectory(requiredEnvironment(name), smokeRoot)'
)) {
  if (-not $mcpSource.Contains($requiredMcpAssertion, [StringComparison]::Ordinal)) {
    throw "Installed MCP helper does not enforce its isolated profile environment."
  }
}
if ($mcpSource.Contains('tmpdir()', [StringComparison]::Ordinal)) {
  throw "Installed MCP helper may not derive its trust boundary from overridden TEMP."
}
$guardIndex = $lifecycle.IndexOf(
  "actual Setup execution is allowed only on a GitHub-hosted disposable windows-latest image",
  [StringComparison]::Ordinal
)
$setupExecutionIndex = $lifecycle.IndexOf(
  '-FilePath $setupPath',
  [StringComparison]::Ordinal
)
if ($guardIndex -lt 0 -or $setupExecutionIndex -le $guardIndex) {
  throw "Setup execution is not textually dominated by the disposable-runner guard."
}
foreach ($requiredBoundary in @(
  'a clean consumer machine or operation without the CI-provided Node.js toolchain',
  'an update channel, upgrade, rollback, or recovery path',
  'erasure of user vault data or other user-created data',
  'interactive shell shortcut activation or independent byte provenance for generated Update.exe and the root execution stub'
)) {
  if (-not $lifecycle.Contains($requiredBoundary, [StringComparison]::Ordinal)) {
    throw "Lifecycle evidence boundary is incomplete."
  }
}

[Console]::Out.WriteLine((ConvertTo-Json -Compress -InputObject ([ordered]@{
  schemaVersion = 1
  result = "PASS"
  control = "installed-lifecycle-static-validation"
  setupExecuted = $false
})))
