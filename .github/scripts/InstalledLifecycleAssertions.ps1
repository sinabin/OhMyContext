function Write-CanonicalJsonElement {
  param(
    [System.Text.Json.JsonElement]$Element,
    [System.Text.Json.Utf8JsonWriter]$Writer
  )

  switch ($Element.ValueKind) {
    ([System.Text.Json.JsonValueKind]::Object) {
      $names = [Collections.Generic.List[string]]::new()
      $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
      foreach ($property in $Element.EnumerateObject()) {
        if (-not $seen.Add($property.Name)) {
          throw "Canonical JSON input contains a duplicate property."
        }
        $names.Add($property.Name)
      }
      $names.Sort([StringComparer]::Ordinal)
      $Writer.WriteStartObject()
      foreach ($name in $names) {
        $Writer.WritePropertyName($name)
        Write-CanonicalJsonElement -Element $Element.GetProperty($name) -Writer $Writer
      }
      $Writer.WriteEndObject()
      break
    }
    ([System.Text.Json.JsonValueKind]::Array) {
      $Writer.WriteStartArray()
      foreach ($entry in $Element.EnumerateArray()) {
        Write-CanonicalJsonElement -Element $entry -Writer $Writer
      }
      $Writer.WriteEndArray()
      break
    }
    ([System.Text.Json.JsonValueKind]::String) {
      $Writer.WriteStringValue($Element.GetString())
      break
    }
    ([System.Text.Json.JsonValueKind]::Number) {
      $Writer.WriteRawValue($Element.GetRawText(), $true)
      break
    }
    ([System.Text.Json.JsonValueKind]::True) {
      $Writer.WriteBooleanValue($true)
      break
    }
    ([System.Text.Json.JsonValueKind]::False) {
      $Writer.WriteBooleanValue($false)
      break
    }
    ([System.Text.Json.JsonValueKind]::Null) {
      $Writer.WriteNullValue()
      break
    }
    default {
      throw "Canonical JSON input contains an unsupported value."
    }
  }
}

function ConvertTo-CanonicalJsonText {
  param([Parameter(Mandatory = $true)][string]$JsonText)

  $documentOptions = [System.Text.Json.JsonDocumentOptions]::new()
  $documentOptions.AllowTrailingCommas = $false
  $documentOptions.CommentHandling = [System.Text.Json.JsonCommentHandling]::Disallow
  $document = [System.Text.Json.JsonDocument]::Parse($JsonText, $documentOptions)
  $stream = [IO.MemoryStream]::new()
  $writer = [System.Text.Json.Utf8JsonWriter]::new($stream)
  try {
    Write-CanonicalJsonElement -Element $document.RootElement -Writer $writer
    $writer.Flush()
    return [Text.Encoding]::UTF8.GetString($stream.ToArray())
  }
  finally {
    $writer.Dispose()
    $stream.Dispose()
    $document.Dispose()
  }
}

function Test-ExactSquirrelArpCommands {
  param(
    [Parameter(Mandatory = $true)][string]$UpdateExecutable,
    [AllowEmptyString()][string]$UninstallString,
    [AllowEmptyString()][string]$QuietUninstallString
  )

  $expectedUninstall = "`"$UpdateExecutable`" --uninstall"
  $expectedQuietUninstall = "$expectedUninstall -s"
  return (
    $UninstallString.Equals($expectedUninstall, [StringComparison]::Ordinal) -and
    $QuietUninstallString.Equals($expectedQuietUninstall, [StringComparison]::Ordinal)
  )
}

function Test-ExactSquirrelShortcutLaunch {
  param(
    [Parameter(Mandatory = $true)][string]$TargetPath,
    [AllowEmptyString()][string]$Arguments,
    [Parameter(Mandatory = $true)][string[]]$DirectApplicationTargets,
    [Parameter(Mandatory = $true)][string]$UpdateExecutable,
    [Parameter(Mandatory = $true)][string]$ApplicationExecutableName
  )

  try {
    $target = [IO.Path]::GetFullPath($TargetPath)
  }
  catch {
    return $false
  }

  foreach ($candidate in $DirectApplicationTargets) {
    if ($target.Equals([IO.Path]::GetFullPath($candidate), [StringComparison]::OrdinalIgnoreCase)) {
      return [string]::IsNullOrWhiteSpace($Arguments)
    }
  }

  if (-not $target.Equals(
    [IO.Path]::GetFullPath($UpdateExecutable),
    [StringComparison]::OrdinalIgnoreCase
  )) {
    return $false
  }

  $allowedUpdaterArguments = @(
    "--processStart $ApplicationExecutableName",
    "--processStart `"$ApplicationExecutableName`"",
    "--processStart=$ApplicationExecutableName",
    "--processStart=`"$ApplicationExecutableName`""
  )
  foreach ($allowed in $allowedUpdaterArguments) {
    if ($Arguments.Equals($allowed, [StringComparison]::Ordinal)) {
      return $true
    }
  }
  return $false
}
