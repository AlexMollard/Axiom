#requires -Version 7
[CmdletBinding()]
param([switch]$Register, [switch]$Open, [switch]$Restart)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$configPath = if ($env:SHARED_BRAIN_CONFIG) { $env:SHARED_BRAIN_CONFIG } else {
  $data = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path ([Environment]::GetFolderPath('UserProfile')) '.config' }
  Join-Path $data 'Axiom/config.json'
}
$configPath = [IO.Path]::GetFullPath($configPath)
$logs = Join-Path (Split-Path -Parent $configPath) '.state'
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$url = "http://127.0.0.1:$($config.port)"
if ($Register) {
  $run = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
  $pwsh = (Get-Command pwsh -ErrorAction Stop).Source
  $command = '"' + $pwsh + '" -NoProfile -WindowStyle Hidden -File "' + (Join-Path $root 'start.ps1') + '"'
  if (-not (Test-Path $run)) { New-Item -Path $run | Out-Null }
  Set-ItemProperty -Path $run -Name 'Axiom' -Value $command
  Write-Output 'Axiom will start at this user account login.'
}
function Ready {
  try { return (Invoke-RestMethod -Uri "$url/health" -TimeoutSec 2).ok -eq $true }
  catch { return $false }
}
if (Ready) {
  $listener = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $config.port -State Listen
  $serverPid = $listener.OwningProcess | Select-Object -Unique
  if (@($serverPid).Count -ne 1) { throw 'Cannot identify a single Shared Brain listener.' }
  $pidFile = Join-Path $logs 'server.pid'
  if (-not (Test-Path -LiteralPath $pidFile) -or (Get-Content -LiteralPath $pidFile -Raw).Trim() -ne "$serverPid") { throw 'The port is occupied by a listener not owned by this Axiom launcher.' }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $serverPid"
  if (-not $process.CommandLine -or $process.CommandLine.IndexOf((Join-Path $root 'server.mjs'), [StringComparison]::OrdinalIgnoreCase) -lt 0) { throw 'Refusing to stop a process that is not this Shared Brain server.' }
  if ($Restart) {
    $running = Get-Process -Id $serverPid
    Stop-Process -Id $serverPid
    $running.WaitForExit()
  }
}
if (-not (Ready)) {
  New-Item -ItemType Directory -Path $logs -Force | Out-Null
  $node = (Get-Command node -ErrorAction Stop).Source
  $child = Start-Process -FilePath $node -ArgumentList ('"' + (Join-Path $root 'server.mjs') + '"') -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logs 'server.log') -RedirectStandardError (Join-Path $logs 'server.err.log') -PassThru
  [IO.File]::WriteAllText((Join-Path $logs 'server.pid'), "$($child.Id)`r`n")
  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  while ([DateTime]::UtcNow -lt $deadline -and -not $child.HasExited -and -not (Ready)) { Start-Sleep -Milliseconds 200 }
  if (-not (Ready)) { throw "Shared Brain did not become ready. Inspect $logs/server.err.log" }
}
Write-Output "Shared Brain ready: $url"
if ($Open) { Start-Process $url }
