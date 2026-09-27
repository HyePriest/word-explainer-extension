Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

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
  $MenuKey = 'HKCU:\Software\Classes\SystemFileAssociations\.pdf\shell\WordExplainer'
  $ProgIdKey = 'HKCU:\Software\Classes\WordExplainer.PDF'
  $OpenWithKey = 'HKCU:\Software\Classes\.pdf\OpenWithProgids'
  $ApplicationKey = 'HKCU:\Software\Classes\Applications\WordExplainerLauncher.exe'
  $OpenWithListKey = 'HKCU:\Software\Classes\.pdf\OpenWithList\WordExplainerLauncher.exe'
  $CapabilitiesRootKey = 'HKCU:\Software\WordExplainer'
  $RegisteredApplicationsKey = 'HKCU:\Software\RegisteredApplications'
  $InstallDirectory = Join-Path $env:LOCALAPPDATA 'WordExplainerLauncher'

  Remove-Item -Path $MenuKey -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -Path $ProgIdKey -Recurse -Force -ErrorAction SilentlyContinue
  Remove-ItemProperty -Path $OpenWithKey -Name 'WordExplainer.PDF' -Force -ErrorAction SilentlyContinue
  Remove-Item -Path $ApplicationKey -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -Path $OpenWithListKey -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -Path $CapabilitiesRootKey -Recurse -Force -ErrorAction SilentlyContinue
  Remove-ItemProperty -Path $RegisteredApplicationsKey -Name 'Word Explainer' -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $InstallDirectory -Recurse -Force -ErrorAction SilentlyContinue
  Notify-AssociationChanged

  Write-Host ''
  Write-Host 'Word Explainer PDF Launcher was removed.' -ForegroundColor Green
  Write-Host ''
  Read-Host 'Press Enter to close'
} catch {
  Write-Host ''
  Write-Host ("Uninstall failed: {0}" -f $_.Exception.Message) -ForegroundColor Red
  Write-Host ''
  Read-Host 'Press Enter to close'
  exit 1
}
