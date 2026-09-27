param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$PdfPath
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$InstallDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$ConfigPath = Join-Path $InstallDirectory 'config.json'
$LogPath = Join-Path $InstallDirectory 'launcher.log'

function Write-LauncherLog {
  param([string]$Message)
  try {
    if ((Test-Path -LiteralPath $LogPath -PathType Leaf) -and (Get-Item -LiteralPath $LogPath).Length -gt 262144) {
      Set-Content -LiteralPath $LogPath -Value '' -Encoding UTF8
    }
    Add-Content -LiteralPath $LogPath -Value ("{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message) -Encoding UTF8
  } catch {}
}

function Show-LauncherError {
  param([string]$Message)
  Write-LauncherLog $Message
  try {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show(
      $Message,
      'Word Explainer PDF Launcher',
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
  } catch {}
}

function Find-ChromeExecutable {
  param([string]$ConfiguredPath)
  $Candidates = @($ConfiguredPath)
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
    if (Test-Path -LiteralPath $Candidate -PathType Leaf) {
      return (Resolve-Path -LiteralPath $Candidate).Path
    }
  }
  throw 'Google Chrome was not found. Run Install-WordExplainer.cmd again after installing Chrome.'
}

function Send-HttpTextResponse {
  param(
    [System.IO.Stream]$Stream,
    [string]$Status,
    [string]$Body
  )
  $BodyBytes = [System.Text.Encoding]::UTF8.GetBytes($Body)
  $Header = "HTTP/1.1 $Status`r`nContent-Type: text/plain; charset=utf-8`r`nContent-Length: $($BodyBytes.Length)`r`nAccess-Control-Allow-Origin: *`r`nAccess-Control-Allow-Private-Network: true`r`nConnection: close`r`n`r`n"
  $HeaderBytes = [System.Text.Encoding]::ASCII.GetBytes($Header)
  $Stream.Write($HeaderBytes, 0, $HeaderBytes.Length)
  $Stream.Write($BodyBytes, 0, $BodyBytes.Length)
  $Stream.Flush()
}

function Send-HttpOptionsResponse {
  param([System.IO.Stream]$Stream)
  $Header = "HTTP/1.1 204 No Content`r`nAccess-Control-Allow-Origin: *`r`nAccess-Control-Allow-Methods: GET, OPTIONS`r`nAccess-Control-Allow-Headers: *`r`nAccess-Control-Allow-Private-Network: true`r`nContent-Length: 0`r`nConnection: close`r`n`r`n"
  $Bytes = [System.Text.Encoding]::ASCII.GetBytes($Header)
  $Stream.Write($Bytes, 0, $Bytes.Length)
  $Stream.Flush()
}

function Send-PdfResponse {
  param(
    [System.IO.Stream]$Stream,
    [string]$Path
  )
  $File = Get-Item -LiteralPath $Path
  $Header = "HTTP/1.1 200 OK`r`nContent-Type: application/pdf`r`nContent-Length: $($File.Length)`r`nCache-Control: no-store`r`nAccess-Control-Allow-Origin: *`r`nAccess-Control-Allow-Private-Network: true`r`nConnection: close`r`n`r`n"
  $HeaderBytes = [System.Text.Encoding]::ASCII.GetBytes($Header)
  $Stream.Write($HeaderBytes, 0, $HeaderBytes.Length)
  $FileStream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
  try {
    $FileStream.CopyTo($Stream, 65536)
    $Stream.Flush()
  } finally {
    $FileStream.Dispose()
  }
}

try {
  if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    throw 'Launcher configuration is missing. Run Install-WordExplainer.cmd first.'
  }

  $Config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $ExtensionId = [string]$Config.extensionId
  $ProfileDirectory = [string]$Config.profileDirectory
  if ($ExtensionId -notmatch '^[a-p]{32}$') {
    throw 'The configured Chrome extension ID is invalid. Run Install-WordExplainer.cmd again.'
  }
  if ([string]::IsNullOrWhiteSpace($ProfileDirectory)) {
    throw 'The configured Chrome profile is invalid. Run Install-WordExplainer.cmd again.'
  }

  $CleanPath = $PdfPath.Trim().Trim('"')
  $FullPath = [System.IO.Path]::GetFullPath($CleanPath)
  if (-not (Test-Path -LiteralPath $FullPath -PathType Leaf)) {
    throw 'PDF file was not found or has been moved.'
  }
  if ([System.IO.Path]::GetExtension($FullPath) -ine '.pdf') {
    throw 'Word Explainer Launcher only accepts PDF files.'
  }

  $ChromePath = Find-ChromeExecutable ([string]$Config.chromePath)
  $Listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $Listener.Start()
  try {
    $Port = ([System.Net.IPEndPoint]$Listener.LocalEndpoint).Port
    $Token = [Guid]::NewGuid().ToString('N')
    $RelayUrl = "http://127.0.0.1:$Port/document.pdf?token=$Token"
    $EncodedRelayUrl = [Uri]::EscapeDataString($RelayUrl)
    $EncodedName = [Uri]::EscapeDataString([System.IO.Path]::GetFileName($FullPath))
    $ReaderUrl = "chrome-extension://$ExtensionId/pdf/reader.html?url=$EncodedRelayUrl&name=$EncodedName&source=windows"
    $ProfileArgument = '--profile-directory="{0}"' -f $ProfileDirectory.Replace('"', '')
    Start-Process -FilePath $ChromePath -ArgumentList @($ProfileArgument, ('"{0}"' -f $ReaderUrl)) | Out-Null

    Write-LauncherLog ("Waiting for Chrome profile '{0}' to request PDF '{1}'." -f $ProfileDirectory, [System.IO.Path]::GetFileName($FullPath))
    $Deadline = [DateTime]::UtcNow.AddSeconds(120)
    $Served = $false
    while (-not $Served -and [DateTime]::UtcNow -lt $Deadline) {
      if (-not $Listener.Pending()) {
        Start-Sleep -Milliseconds 100
        continue
      }

      $Client = $Listener.AcceptTcpClient()
      try {
        $Client.ReceiveTimeout = 10000
        $Client.SendTimeout = 120000
        $Stream = $Client.GetStream()
        $Reader = [System.IO.StreamReader]::new($Stream, [System.Text.Encoding]::ASCII, $false, 1024, $true)
        try {
          $RequestLine = $Reader.ReadLine()
          while ($true) {
            $HeaderLine = $Reader.ReadLine()
            if ($null -eq $HeaderLine -or $HeaderLine.Length -eq 0) { break }
          }
        } finally {
          $Reader.Dispose()
        }

        if ($RequestLine -notmatch '^(GET|OPTIONS)\s+(\S+)\s+HTTP/') {
          Send-HttpTextResponse $Stream '400 Bad Request' 'Invalid request.'
          continue
        }

        $Method = $Matches[1]
        $RequestTarget = $Matches[2]
        $RequestUri = [Uri]("http://127.0.0.1:$Port$RequestTarget")
        $TokenMatch = [regex]::Match($RequestUri.Query, '(?:^\?|&)token=([^&]+)')
        $RequestToken = if ($TokenMatch.Success) { [Uri]::UnescapeDataString($TokenMatch.Groups[1].Value) } else { '' }
        if ($RequestUri.AbsolutePath -ne '/document.pdf' -or $RequestToken -ne $Token) {
          Send-HttpTextResponse $Stream '403 Forbidden' 'Invalid or expired transfer token.'
          continue
        }

        if ($Method -eq 'OPTIONS') {
          Send-HttpOptionsResponse $Stream
          continue
        }

        Send-PdfResponse $Stream $FullPath
        $Served = $true
        Write-LauncherLog ("Transferred PDF '{0}' successfully." -f [System.IO.Path]::GetFileName($FullPath))
      } finally {
        $Client.Dispose()
      }
    }

    if (-not $Served) {
      throw 'Chrome did not request the PDF within 120 seconds. Check the selected profile, extension ID, and whether the extension is enabled.'
    }
  } finally {
    $Listener.Stop()
  }
} catch {
  Show-LauncherError $_.Exception.Message
  exit 1
}
