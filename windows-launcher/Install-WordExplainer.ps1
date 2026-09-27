Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$InstallDirectory = Join-Path $env:LOCALAPPDATA 'WordExplainerLauncher'
$SourceDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$LauncherSource = Join-Path $SourceDirectory 'WordExplainerLauncher.ps1'
$LauncherTarget = Join-Path $InstallDirectory 'WordExplainerLauncher.ps1'
$LauncherHostSource = Join-Path $SourceDirectory 'WordExplainerLauncher.cs'
$LauncherHostTarget = Join-Path $InstallDirectory 'WordExplainerLauncher.exe'
$LauncherIconSource = Join-Path $SourceDirectory 'WordExplainer.ico'
$LauncherIconTarget = Join-Path $InstallDirectory 'WordExplainer.ico'
$ConfigPath = Join-Path $InstallDirectory 'config.json'

function Find-ChromeExecutable {
  $Candidates = @()
  if ($env:ProgramFiles) {
    $Candidates += Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'
  }
  if (${env:ProgramFiles(x86)}) {
    $Candidates += Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'
  }
  if ($env:LOCALAPPDATA) {
    $Candidates += Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe'
  }
  foreach ($Candidate in $Candidates) {
    if (Test-Path -LiteralPath $Candidate -PathType Leaf) { return (Resolve-Path -LiteralPath $Candidate).Path }
  }
  throw 'Google Chrome was not found.'
}

function Get-ChromeProfiles {
  $UserData = Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data'
  if (-not (Test-Path -LiteralPath $UserData -PathType Container)) {
    throw 'Chrome user data directory was not found.'
  }

  $Profiles = @()
  foreach ($Directory in (Get-ChildItem -LiteralPath $UserData -Directory)) {
    if ($Directory.Name -ne 'Default' -and $Directory.Name -notmatch '^Profile \d+$') { continue }
    $DisplayName = $Directory.Name
    $PreferencesPath = Join-Path $Directory.FullName 'Preferences'
    if (Test-Path -LiteralPath $PreferencesPath -PathType Leaf) {
      try {
        $Preferences = Get-Content -LiteralPath $PreferencesPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($Preferences.profile.name) { $DisplayName = [string]$Preferences.profile.name }
      } catch {}
    }
    $Profiles += [PSCustomObject]@{ Directory = $Directory.Name; DisplayName = $DisplayName }
  }
  return $Profiles
}

function Notify-AssociationChanged {
  Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ShellNotify {
  [DllImport("shell32.dll")]
  public static extern void SHChangeNotify(uint eventId, uint flags, IntPtr item1, IntPtr item2);
}
'@
  [ShellNotify]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)
}

try {
  Write-Host ''
  Write-Host 'Word Explainer PDF Launcher' -ForegroundColor Cyan
  Write-Host 'This installs files only for the current Windows user.'
  Write-Host ''

  $ExtensionInput = Read-Host 'Chrome extension ID (copy from chrome://extensions)'
  $ExtensionId = if ($null -eq $ExtensionInput) { '' } else { $ExtensionInput.Trim() }
  if ($ExtensionId -notmatch '^[a-p]{32}$') { throw 'The Chrome extension ID must contain 32 letters from a to p.' }

  $Profiles = @(Get-ChromeProfiles)
  if ($Profiles.Count -eq 0) { throw 'No Chrome profiles were found.' }
  Write-Host ''
  Write-Host 'Choose the Chrome profile that has Word Explainer installed:' -ForegroundColor Yellow
  for ($Index = 0; $Index -lt $Profiles.Count; $Index += 1) {
    Write-Host ("[{0}] {1} ({2})" -f ($Index + 1), $Profiles[$Index].DisplayName, $Profiles[$Index].Directory)
  }
  $ChoiceText = Read-Host 'Profile number'
  $Choice = 0
  if (-not [int]::TryParse($ChoiceText, [ref]$Choice) -or $Choice -lt 1 -or $Choice -gt $Profiles.Count) {
    throw 'Invalid profile number.'
  }
  $ProfileDirectory = $Profiles[$Choice - 1].Directory
  $ChromePath = Find-ChromeExecutable

  foreach ($RequiredFile in @($LauncherSource, $LauncherHostSource, $LauncherIconSource)) {
    if (-not (Test-Path -LiteralPath $RequiredFile -PathType Leaf)) {
      throw ("Installer file is missing: {0}" -f [System.IO.Path]::GetFileName($RequiredFile))
    }
  }

  New-Item -Path $InstallDirectory -ItemType Directory -Force | Out-Null
  Copy-Item -LiteralPath $LauncherSource -Destination $LauncherTarget -Force
  Copy-Item -LiteralPath $LauncherIconSource -Destination $LauncherIconTarget -Force
  Remove-Item -LiteralPath $LauncherHostTarget -Force -ErrorAction SilentlyContinue
  Add-Type -LiteralPath $LauncherHostSource `
    -ReferencedAssemblies @('System.dll', 'System.Windows.Forms.dll') `
    -OutputAssembly $LauncherHostTarget `
    -OutputType WindowsApplication
  if (-not (Test-Path -LiteralPath $LauncherHostTarget -PathType Leaf)) {
    throw 'The Word Explainer launcher application could not be created.'
  }

  $Config = [ordered]@{
    extensionId = $ExtensionId
    profileDirectory = $ProfileDirectory
    chromePath = $ChromePath
  }
  $Config | ConvertTo-Json | Set-Content -LiteralPath $ConfigPath -Encoding UTF8

  $CommandLine = ('"{0}" "%1"' -f $LauncherHostTarget)
  $IconLocation = ('"{0}"' -f $LauncherIconTarget)

  $MenuKey = 'HKCU:\Software\Classes\SystemFileAssociations\.pdf\shell\WordExplainer'
  New-Item -Path $MenuKey -Force | Out-Null
  Set-Item -Path $MenuKey -Value 'Open with Word Explainer'
  New-ItemProperty -Path $MenuKey -Name 'MUIVerb' -Value 'Open with Word Explainer' -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $MenuKey -Name 'Icon' -Value $IconLocation -PropertyType String -Force | Out-Null
  $MenuCommandKey = Join-Path $MenuKey 'command'
  New-Item -Path $MenuCommandKey -Force | Out-Null
  Set-Item -Path $MenuCommandKey -Value $CommandLine

  $ProgIdKey = 'HKCU:\Software\Classes\WordExplainer.PDF'
  New-Item -Path $ProgIdKey -Force | Out-Null
  Set-Item -Path $ProgIdKey -Value 'Word Explainer PDF Reader'
  New-ItemProperty -Path $ProgIdKey -Name 'FriendlyTypeName' -Value 'Word Explainer PDF Reader' -PropertyType String -Force | Out-Null
  $IconKey = Join-Path $ProgIdKey 'DefaultIcon'
  New-Item -Path $IconKey -Force | Out-Null
  Set-Item -Path $IconKey -Value $IconLocation
  $ProgCommandKey = Join-Path $ProgIdKey 'shell\open\command'
  New-Item -Path $ProgCommandKey -Force | Out-Null
  Set-Item -Path $ProgCommandKey -Value $CommandLine

  $OpenWithKey = 'HKCU:\Software\Classes\.pdf\OpenWithProgids'
  New-Item -Path $OpenWithKey -Force | Out-Null
  New-ItemProperty -Path $OpenWithKey -Name 'WordExplainer.PDF' -Value '' -PropertyType String -Force | Out-Null

  $ApplicationKey = 'HKCU:\Software\Classes\Applications\WordExplainerLauncher.exe'
  New-Item -Path $ApplicationKey -Force | Out-Null
  New-ItemProperty -Path $ApplicationKey -Name 'FriendlyAppName' -Value 'Word Explainer' -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $ApplicationKey -Name 'ApplicationName' -Value 'Word Explainer' -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $ApplicationKey -Name 'ApplicationDescription' -Value 'Open PDF files in the Word Explainer Chrome extension' -PropertyType String -Force | Out-Null
  $ApplicationIconKey = Join-Path $ApplicationKey 'DefaultIcon'
  New-Item -Path $ApplicationIconKey -Force | Out-Null
  Set-Item -Path $ApplicationIconKey -Value $IconLocation
  $SupportedTypesKey = Join-Path $ApplicationKey 'SupportedTypes'
  New-Item -Path $SupportedTypesKey -Force | Out-Null
  New-ItemProperty -Path $SupportedTypesKey -Name '.pdf' -Value '' -PropertyType String -Force | Out-Null
  $ApplicationCommandKey = Join-Path $ApplicationKey 'shell\open\command'
  New-Item -Path $ApplicationCommandKey -Force | Out-Null
  Set-Item -Path $ApplicationCommandKey -Value $CommandLine

  $OpenWithListKey = 'HKCU:\Software\Classes\.pdf\OpenWithList\WordExplainerLauncher.exe'
  New-Item -Path $OpenWithListKey -Force | Out-Null

  $CapabilitiesKey = 'HKCU:\Software\WordExplainer\Capabilities'
  New-Item -Path $CapabilitiesKey -Force | Out-Null
  New-ItemProperty -Path $CapabilitiesKey -Name 'ApplicationName' -Value 'Word Explainer' -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $CapabilitiesKey -Name 'ApplicationDescription' -Value 'Open PDF files in the Word Explainer Chrome extension' -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $CapabilitiesKey -Name 'ApplicationIcon' -Value $IconLocation -PropertyType String -Force | Out-Null
  $FileAssociationsKey = Join-Path $CapabilitiesKey 'FileAssociations'
  New-Item -Path $FileAssociationsKey -Force | Out-Null
  New-ItemProperty -Path $FileAssociationsKey -Name '.pdf' -Value 'WordExplainer.PDF' -PropertyType String -Force | Out-Null
  $RegisteredApplicationsKey = 'HKCU:\Software\RegisteredApplications'
  New-Item -Path $RegisteredApplicationsKey -Force | Out-Null
  New-ItemProperty -Path $RegisteredApplicationsKey -Name 'Word Explainer' -Value 'Software\WordExplainer\Capabilities' -PropertyType String -Force | Out-Null
  Notify-AssociationChanged

  Write-Host ''
  Write-Host 'Installation completed.' -ForegroundColor Green
  Write-Host ("Chrome profile: {0}" -f $ProfileDirectory)
  Write-Host ("Extension ID: {0}" -f $ExtensionId)
  Write-Host 'Open-with application: Word Explainer'
  Write-Host 'On Windows 11, the command may appear under Show more options.'
  Write-Host ''
  Read-Host 'Press Enter to close'
} catch {
  Write-Host ''
  Write-Host ("Installation failed: {0}" -f $_.Exception.Message) -ForegroundColor Red
  Write-Host ''
  Read-Host 'Press Enter to close'
  exit 1
}
