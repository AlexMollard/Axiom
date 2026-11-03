#requires -Version 7
[CmdletBinding()]
param([switch]$Register, [switch]$Unregister, [switch]$Open, [switch]$Restart, [switch]$Health, [switch]$TaskLaunch, [string]$ConfigPath)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $ConfigPath) {
  $ConfigPath = if ($env:SHARED_BRAIN_CONFIG) { $env:SHARED_BRAIN_CONFIG } else {
    $data = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path ([Environment]::GetFolderPath('UserProfile')) '.config' }
    Join-Path $data 'Axiom/config.json'
  }
}
$node = (Get-Command node -ErrorAction Stop).Source
$ConfigPath = [IO.Path]::GetFullPath($ConfigPath)
$identityJson = & $node -e 'const fs=require("node:fs"),path=require("node:path"),requested=process.argv[1]; let p; try { p=fs.realpathSync.native(requested); } catch (e) { if(e.code!=="ENOENT") throw e; p=path.join(fs.realpathSync.native(path.dirname(requested)),path.basename(requested)); } process.stdout.write(JSON.stringify({path:p,hash:require("node:crypto").createHash("sha256").update(p.toLowerCase()).digest("hex").slice(0,16).toUpperCase()}))' $ConfigPath
if ($LASTEXITCODE -ne 0 -or -not $identityJson) { throw 'Cannot resolve the configuration path.' }
$identity = $identityJson | ConvertFrom-Json
$ConfigPath = $identity.path
$hash = $identity.hash
$state = Join-Path (Join-Path (Split-Path -Parent $ConfigPath) '.state') "runtime-$hash"
trap {
  if ($Health -or $TaskLaunch) {
    try {
      New-Item -ItemType Directory -Path $state -Force | Out-Null
      $diagnostic = Join-Path $state $(if ($Health) { 'health.log' } else { 'launcher.log' })
      $line = "$([DateTime]::UtcNow.ToString('o')) $($_.ToString())`r`n"
      if ((Test-Path -LiteralPath $diagnostic) -and ((Get-Item -LiteralPath $diagnostic).Length + [Text.Encoding]::UTF8.GetByteCount($line) -gt 1048576)) { [IO.File]::WriteAllText($diagnostic, '') }
      if ($line.Length -gt 4096) { $line = $line.Substring(0, 4096) + "`r`n" }
      [IO.File]::AppendAllText($diagnostic, $line)
    } catch { [Console]::Error.WriteLine("Could not write health log: $_") }
  }
  break
}
$taskName = "Axiom-$hash"
$healthName = "$taskName-Health"
$script = Join-Path $PSScriptRoot 'start.ps1'
$server = Join-Path $root 'src/server.mjs'
$quotedConfig = '"' + $ConfigPath + '"'
$serverArgument = '"' + $server + '" ' + $quotedConfig
if ($TaskLaunch) {
  Start-Process -FilePath $node -ArgumentList $serverArgument -WorkingDirectory $root -WindowStyle Hidden | Out-Null
  return
}
$failureFile = Join-Path $state 'health-failures.txt'
$recoveryFile = Join-Path $state 'health-recoveries.txt'
if ($Health) {
  $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
  $url = "http://127.0.0.1:$($config.port)"
  try {
    $answer = Invoke-RestMethod -Uri "$url/health" -TimeoutSec 2 -NoProxy
    $pidFile = Join-Path $state 'server.pid'
    if ($answer.ok -eq $true -and $answer.configId -ceq $hash -and $answer.pid -gt 0 -and
        (Test-Path -LiteralPath $pidFile) -and (Get-Content -LiteralPath $pidFile -Raw).Trim() -ceq "$($answer.pid)") {
      if (Test-Path -LiteralPath $failureFile) { Remove-Item -LiteralPath $failureFile }
      if ($answer.uptimeSeconds -ge 180 -and (Test-Path -LiteralPath $recoveryFile)) { Remove-Item -LiteralPath $recoveryFile }
      return
    }
  } catch { }
}
$pwsh = (Get-Command pwsh -ErrorAction Stop).Source
# Start a headless console before PowerShell; -WindowStyle Hidden alone flashes
# a window and can activate Windows Terminal before PowerShell parses its flags.
$taskHost = Join-Path $env:SystemRoot 'System32/conhost.exe'
$taskPrefix = '--headless "' + $pwsh + '" '
# Runtime arguments are fixed before entering the one-shot launcher.
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
function OwnedTask($name, $expectedExecutable, $expectedArgument, [switch]$AllowLegacy) {
  $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if (-not $task) { return $null }
  $legacyArgument = if ($expectedArgument.StartsWith($taskPrefix, [StringComparison]::Ordinal)) { $expectedArgument.Substring($taskPrefix.Length) } else { $null }
  $legacyAction = $AllowLegacy -and (
    ($name -eq $taskName -and $task.Actions[0].Execute -ieq $node -and $task.Actions[0].Arguments -ceq $serverArgument) -or
    ($legacyArgument -and $task.Actions[0].Execute -ieq $pwsh -and $task.Actions[0].Arguments -ceq $legacyArgument))
  if (@($task.Actions).Count -ne 1 -or (($task.Actions[0].Execute -ine $expectedExecutable -or $task.Actions[0].Arguments -cne $expectedArgument) -and -not $legacyAction)) {
    throw "Scheduled task $name is not owned by this Axiom installation."
  }
  [xml]$xml = Export-ScheduledTask -TaskName $name
  $p = $xml.Task.Principals.Principal
  try {
    $sid = if ($p.UserId -match '^S-1-') { $p.UserId } else { ([Security.Principal.NTAccount]::new($p.UserId)).Translate([Security.Principal.SecurityIdentifier]).Value }
  } catch { throw "Cannot verify principal of task $name." }
  if ($sid -ne $userSid -or $p.LogonType -ne 'InteractiveToken' -or "$($task.Principal.RunLevel)" -notin @('0', 'Limited')) { throw "Task $name has an unexpected principal." }
  $s = $xml.Task.Settings
  # IgnoreNew is the Task Scheduler schema default and may be omitted on export.
  if (($s.MultipleInstancesPolicy -and $s.MultipleInstancesPolicy -ne 'IgnoreNew') -or $s.StartWhenAvailable -ne 'true') { throw "Task $name has unexpected settings." }
  if ($name -eq $taskName -and ($s.ExecutionTimeLimit -ne 'PT0S' -or $s.RestartOnFailure.Count -ne '3' -or $s.RestartOnFailure.Interval -ne 'PT1M')) { throw "Task $name has unexpected restart settings." }
  return $task
}
$launchArgument = $taskPrefix + '-NoProfile -NonInteractive -WindowStyle Hidden -File "' + $script + '" -TaskLaunch -ConfigPath ' + $quotedConfig
$healthArgument = $taskPrefix + '-NoProfile -NonInteractive -WindowStyle Hidden -File "' + $script + '" -Health -ConfigPath ' + $quotedConfig
$serverTask = OwnedTask $taskName $taskHost $launchArgument -AllowLegacy:$Register
$healthTask = OwnedTask $healthName $taskHost $healthArgument -AllowLegacy:$Register
if ($Unregister) {
  foreach ($name in @($healthName, $taskName)) {
    if ($name -eq $taskName) { $existing = $serverTask } else { $existing = $healthTask }
    if ($existing) { Unregister-ScheduledTask -TaskName $name -Confirm:$false }
  }
  Write-Output "Unregistered $taskName and $healthName."
  return
}
$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$url = "http://127.0.0.1:$($config.port)"
if ($Register) {
  # Use the current interactive account without elevation.
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -Priority 5 -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  $action = New-ScheduledTaskAction -Execute $taskHost -Argument $launchArgument -WorkingDirectory $root
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
  $healthSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 1) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  $healthAction = New-ScheduledTaskAction -Execute $taskHost -Argument $healthArgument -WorkingDirectory $root
  $healthTrigger = New-ScheduledTaskTrigger -Once -At ([DateTime]::Now.AddMinutes(3)) -RepetitionInterval (New-TimeSpan -Minutes 3)
  Register-ScheduledTask -TaskName $healthName -Action $healthAction -Trigger $healthTrigger -Settings $healthSettings -Principal $principal -Force | Out-Null
  $serverTask = OwnedTask $taskName $taskHost $launchArgument
  $healthTask = OwnedTask $healthName $taskHost $healthArgument
  if (-not $serverTask -or -not $healthTask) { throw 'Scheduled task registration could not be verified.' }
  # Only remove our old launcher, and only for the default installation.
  $defaultConfig = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Axiom/config.json'))
  $run = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
  if ($ConfigPath -ieq $defaultConfig) {
    $legacy = (Get-ItemProperty -Path $run -Name Axiom -ErrorAction SilentlyContinue).Axiom
    if ($legacy -and $legacy.IndexOf($script, [StringComparison]::OrdinalIgnoreCase) -ge 0) { Remove-ItemProperty -Path $run -Name Axiom }
  }
  Write-Output "Registered $taskName and $healthName for $user."
}
function RuntimeOwner {
  $pidFile = Join-Path $state 'server.pid'
  if (-not (Test-Path -LiteralPath $pidFile)) { return $null }
  $id = 0
  if (-not [int]::TryParse((Get-Content -LiteralPath $pidFile -Raw).Trim(), [ref]$id) -or $id -le 0) { return $null }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $id"
  $expected = '(?i)(?:^|\s)"?' + [regex]::Escape($server) + '"?\s+"?' + [regex]::Escape($ConfigPath) + '"?\s*$'
  if (-not $process -or $process.ExecutablePath -ine $node -or -not $process.CommandLine -or $process.CommandLine -notmatch $expected) { return $null }
  return Get-Process -Id $id -ErrorAction SilentlyContinue
}
function Listener {
  $connections = @(Get-NetTCPConnection -LocalPort $config.port -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -in @('127.0.0.1', '0.0.0.0', '::', '::1') })
  if ($connections.Count -eq 0) { return $null }
  $ids = @($connections.OwningProcess | Select-Object -Unique)
  if ($ids.Count -ne 1) { throw 'Port has multiple listeners; refusing to manage it.' }
  $id = [int]$ids[0]
  $owner = RuntimeOwner
  if (-not $owner -or $owner.Id -ne $id) { throw 'Port is occupied by a listener not owned by this Axiom installation and configuration.' }
  return $owner
}
function Ready {
  try { return (Invoke-RestMethod -Uri "$url/health" -TimeoutSec 2 -NoProxy).ok -eq $true } catch { return $false }
}
function StopOwnedTask {
  $task = OwnedTask $taskName $taskHost $launchArgument
  if (-not $task -or $task.State -ne 'Running') { return }
  Stop-ScheduledTask -TaskName $taskName
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  do {
    Start-Sleep -Milliseconds 200
    $task = OwnedTask $taskName $taskHost $launchArgument
  } while ($task -and $task.State -eq 'Running' -and [DateTime]::UtcNow -lt $deadline)
  if (-not $task -or $task.State -eq 'Running') { throw 'Scheduled server task did not stop.' }
}
if ($Restart -and (Test-Path -LiteralPath $recoveryFile)) { Remove-Item -LiteralPath $recoveryFile }
if ($Health) {
  # An unregistered or manually invoked health check must not create a watchdog.
  if (-not $serverTask -or -not $healthTask) { return }
  $listener = Listener
  $owner = RuntimeOwner
  if ($owner -and (([DateTime]::Now - $owner.StartTime).TotalSeconds -lt 60)) {
    if (Test-Path $failureFile) { Remove-Item $failureFile }
    return
  }
  if (-not $owner) {
    $lastRun = (Get-ScheduledTaskInfo -TaskName $taskName).LastRunTime
    if ($lastRun -and ([DateTime]::Now - $lastRun).TotalSeconds -lt 60) {
      if (Test-Path $failureFile) { Remove-Item $failureFile }
      return
    }
  }
  if ($owner -and $listener -and (Ready)) {
    if (Test-Path $failureFile) { Remove-Item $failureFile }
    if (([DateTime]::Now - $owner.StartTime).TotalSeconds -ge 180 -and (Test-Path $recoveryFile)) { Remove-Item $recoveryFile }
    return
  }
  New-Item -ItemType Directory -Path $state -Force | Out-Null
  $failures = 0
  if (Test-Path $failureFile) { [void][int]::TryParse((Get-Content -LiteralPath $failureFile -Raw).Trim(), [ref]$failures) }
  # A ready task with no listener is positively stopped, not an unresponsive
  # running server; do not wait for a second probe before starting it.
  if ($failures -lt 1 -and -not (-not $owner -and $serverTask.State -eq 'Ready')) {
    [IO.File]::WriteAllText($failureFile, "1`r`n")
    return
  }
  $recoveries = 0
  if (Test-Path $recoveryFile) { [void][int]::TryParse((Get-Content -LiteralPath $recoveryFile -Raw).Trim(), [ref]$recoveries) }
  if ($recoveries -ge 3) { throw 'Automatic health recovery budget exhausted; investigate and use -Restart to reset it.' }
  [IO.File]::WriteAllText($recoveryFile, "$($recoveries + 1)`r`n")
  [IO.File]::WriteAllText($failureFile, "0`r`n")
  if ($owner) {
    # Revalidate immediately before termination; never act on a stale PID alone.
    [void](Listener)
    $current = RuntimeOwner
    if (-not $current -or $current.Id -ne $owner.Id -or $current.StartTime -ne $owner.StartTime) { throw 'Listener changed during health check.' }
    Stop-Process -Id $owner.Id
    if (-not $owner.WaitForExit(15000)) { throw 'Unresponsive server did not terminate.' }
  }
  # Cancel any scheduler-controlled retry before starting a fresh owned task.
  # This also handles tasks hung before binding without trusting a stale PID.
  if (Listener) { throw 'Listener appeared during health check.' }
  StopOwnedTask
  if (Listener) { throw 'Listener appeared while stopping the scheduled task.' }
  if (-not (OwnedTask $taskName $taskHost $launchArgument)) { throw 'Scheduled server task disappeared.' }
  Start-ScheduledTask -TaskName $taskName
  return
}
[void](Listener)
$owner = RuntimeOwner
if ($owner -and $Restart) {
  [void](Listener)
  $current = RuntimeOwner
  if (-not $current -or $current.Id -ne $owner.Id -or $current.StartTime -ne $owner.StartTime) { throw 'Listener changed during restart.' }
  Stop-Process -Id $owner.Id
  $owner.WaitForExit()
  $owner = $null
}
if (-not $owner -and $Restart -and $serverTask) {
  if (Listener) { throw 'Listener appeared during restart.' }
  StopOwnedTask
}
if (-not $owner) {
  if ($serverTask) {
    # A running task may already be in its scheduler-controlled restart delay.
    if ((Get-ScheduledTask -TaskName $taskName).State -ne 'Running') { Start-ScheduledTask -TaskName $taskName }
  } else {
    Start-Process -FilePath $node -ArgumentList ('"' + $server + '" ' + $quotedConfig) -WorkingDirectory $root -WindowStyle Hidden | Out-Null
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(80)
  do { Start-Sleep -Milliseconds 250; $owner = Listener } while (-not $owner -and [DateTime]::UtcNow -lt $deadline)
  if (-not $owner) { throw "Axiom did not start. Inspect $state/server.log and Task Scheduler history." }
}
$deadline = [DateTime]::UtcNow.AddSeconds(20)
while (-not (Ready) -and [DateTime]::UtcNow -lt $deadline) {
  [void](Listener)
  Start-Sleep -Milliseconds 250
}
if (-not (Ready)) { throw "Axiom is not responding. Inspect $state/server.log." }
Write-Output "Shared Brain ready: $url"
if ($Open) { Start-Process $url }
