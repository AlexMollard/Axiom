#requires -Version 7
[CmdletBinding()]
param([string]$EvidenceDir)
$ErrorActionPreference = 'Stop'
$repo = $PSScriptRoot
$launcher = Join-Path $repo 'start.ps1'
$server = Join-Path $repo 'server.mjs'
$node = (Get-Command node -ErrorAction Stop).Source
$pwsh = (Get-Command pwsh -ErrorAction Stop).Source
if (-not $EvidenceDir) {
  $privateConfig = if ($env:SHARED_BRAIN_CONFIG) { $env:SHARED_BRAIN_CONFIG } else { Join-Path $env:LOCALAPPDATA 'Axiom/config.json' }
  $EvidenceDir = Join-Path (Join-Path (Split-Path -Parent ([IO.Path]::GetFullPath($privateConfig))) '.state') ('qualification-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
}
$EvidenceDir = [IO.Path]::GetFullPath($EvidenceDir)
New-Item -ItemType Directory -Path $EvidenceDir -Force | Out-Null
$root = Join-Path ([IO.Path]::GetTempPath()) ('axiom-qualification-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root -ErrorAction Stop | Out-Null
$configPath = Join-Path $root 'config.json'
$secondaryConfigPath = Join-Path $root 'second.json'
$vault = Join-Path $root 'vault'
$backup = Join-Path $root 'backups'
$events = [Collections.Generic.List[object]]::new()
$cleanupErrors = [Collections.Generic.List[string]]::new()
$taskName = $null; $healthName = $null; $state = $null
$foreign = $null; $secondary = $null; $suspended = $null
function Record($name, $data) { $events.Add([pscustomobject]@{name=$name; at=[DateTime]::UtcNow.ToString('o'); data=$data}); Write-Output $name }
function FreePort { $s=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0); try { $s.Start(); return $s.LocalEndpoint.Port } finally { $s.Stop() } }
function SaveConfig { [IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 10)) }
function Launcher([string[]]$Extra, [switch]$Failure) {
  $output = & $pwsh -NoProfile -NonInteractive -File $launcher -ConfigPath $configPath @Extra 2>&1
  $code = $LASTEXITCODE
  if (($Failure -and $code -eq 0) -or (-not $Failure -and $code -ne 0)) { throw "Launcher unexpected exit $code : $output" }
  return [pscustomobject]@{code=$code; output=($output | Out-String)}
}
function FixtureTask($name, $mode) {
  $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if (-not $task) { return $null }
  $expected = '-NoProfile -NonInteractive -WindowStyle Hidden -File "' + $launcher + '" ' + $mode + ' -ConfigPath "' + $configPath + '"'
  if (@($task.Actions).Count -ne 1 -or $task.Actions[0].Execute -ine $pwsh -or $task.Actions[0].Arguments -cne $expected) { throw "Refusing to manage foreign task $name." }
  return $task
}
function FixtureProcess {
  $pidFile = Join-Path $state 'server.pid'
  if (-not (Test-Path -LiteralPath $pidFile)) { return $null }
  $id = 0
  if (-not [int]::TryParse((Get-Content -LiteralPath $pidFile -Raw).Trim(), [ref]$id) -or $id -le 0) { return $null }
  $p = Get-CimInstance Win32_Process -Filter "ProcessId = $id"
  $expected = '(?i)(?:^|\s)"?' + [regex]::Escape($server) + '"?\s+"?' + [regex]::Escape($configPath) + '"?\s*$'
  if (-not $p -or $p.ExecutablePath -ine $node -or -not $p.CommandLine -or $p.CommandLine -notmatch $expected) { return $null }
  return Get-Process -Id $id -ErrorAction SilentlyContinue
}
function StopFixture {
  $task = FixtureTask $taskName '-TaskLaunch'
  if ($task -and $task.State -eq 'Running') {
    Stop-ScheduledTask -TaskName $taskName
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    do { Start-Sleep -Milliseconds 200; $task = FixtureTask $taskName '-TaskLaunch' } while ($task -and $task.State -eq 'Running' -and [DateTime]::UtcNow -lt $deadline)
    if ($task -and $task.State -eq 'Running') { throw 'Fixture launch task did not stop.' }
  }
  $owned = FixtureProcess
  if ($owned) {
    $again = FixtureProcess
    if (-not $again -or $again.Id -ne $owned.Id -or $again.StartTime -ne $owned.StartTime) { throw 'Fixture process changed during cleanup.' }
    Stop-Process -Id $owned.Id
    if (-not $owned.WaitForExit(15000)) { throw 'Fixture process did not stop.' }
  }
}
function WaitReady([int]$NotPid=0, [int]$Seconds=240) {
  $deadline=[DateTime]::UtcNow.AddSeconds($Seconds)
  do {
    try {
      $id=[int](Get-Content -LiteralPath (Join-Path $state 'server.pid') -Raw)
      $response=Invoke-RestMethod "http://127.0.0.1:$($config.port)/health" -TimeoutSec 1 -NoProxy
      if ($id -ne $NotPid -and $response.ok -eq $true -and $response.pid -eq $id -and $response.configId -ceq $hash -and (FixtureProcess)) { return $id }
    } catch {}
    Start-Sleep -Milliseconds 500
  } while ([DateTime]::UtcNow -lt $deadline)
  throw 'Owned fixture did not become ready.'
}
function CheckConsole([int]$id) {
  $owned = FixtureProcess
  if (-not $owned -or $owned.Id -ne $id) { throw 'Cannot inspect a non-fixture process.' }
  $output = & $pwsh -NoProfile -NonInteractive -WindowStyle Hidden -File $consoleScript -ServerId $id 2>&1
  if ($LASTEXITCODE -ne 0) { throw "Console inspection failed: $output" }
  return ($output | Out-String | ConvertFrom-Json)
}
try {
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class AxiomQualificationSuspend {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
  [DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr handle);
  [DllImport("ntdll.dll")] public static extern int NtResumeProcess(IntPtr handle);
}
'@
$consoleScript = Join-Path $root 'inspect-console.ps1'
[IO.File]::WriteAllText($consoleScript, @'
param([Parameter(Mandatory)][int]$ServerId)
$ErrorActionPreference='Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class AxiomQualificationConsole {
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool FreeConsole();
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool AttachConsole(uint pid);
 [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
}
"@
[AxiomQualificationConsole]::FreeConsole() | Out-Null
if (-not [AxiomQualificationConsole]::AttachConsole([uint32]$ServerId)) {
  $code=[Runtime.InteropServices.Marshal]::GetLastWin32Error()
  if ($code -ne 6) { throw "Cannot inspect console: $code" }
  [pscustomobject]@{pid=$ServerId;hasConsole=$false;visible=$false} | ConvertTo-Json -Compress
  exit 0
}
$handle=[AxiomQualificationConsole]::GetConsoleWindow()
$visible=$handle -ne [IntPtr]::Zero -and [AxiomQualificationConsole]::IsWindowVisible($handle)
[AxiomQualificationConsole]::FreeConsole() | Out-Null
[pscustomobject]@{pid=$ServerId;hasConsole=($handle -ne [IntPtr]::Zero);visible=$visible} | ConvertTo-Json -Compress
if ($visible) { throw 'Managed fixture console is visible.' }
'@)
  New-Item -ItemType Directory -Path (Join-Path $vault 'Owner') -Force | Out-Null
  [IO.File]::WriteAllText((Join-Path $vault 'Owner/Policies.md'), "# Policies`r`nIsolated scheduler fixture.`r`n")
  [IO.File]::WriteAllText((Join-Path $vault 'Owner/Preferences.md'), "# Preferences`r`nNo live data.`r`n")
  $config=[ordered]@{vault=$vault;backupDir=$backup;port=(FreePort);projects=@()}
  SaveConfig
  $identityJson = & $node -e 'const p=require("node:fs").realpathSync.native(process.argv[1]); process.stdout.write(JSON.stringify({path:p,hash:require("node:crypto").createHash("sha256").update(p.toLowerCase()).digest("hex").slice(0,16).toUpperCase()}))' $configPath
  if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve fixture configuration.' }
  $identity=$identityJson | ConvertFrom-Json
  $configPath=$identity.path; $hash=$identity.hash
  $state=Join-Path (Join-Path $root '.state') "runtime-$hash"
  $taskName="Axiom-$hash"; $healthName="$taskName-Health"
  if ((Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) -or (Get-ScheduledTask -TaskName $healthName -ErrorAction SilentlyContinue)) { throw 'Fixture task name is already occupied.' }
  $null=Launcher -Extra @('-Register')
  $initial=WaitReady
  $task=FixtureTask $taskName '-TaskLaunch'
  $healthTask=FixtureTask $healthName '-Health'
  $initialConsole=CheckConsole $initial
  $priority=(Get-Process -Id $initial).PriorityClass.ToString()
  if ($priority -ne 'Normal') { throw "Unexpected fixture Node priority: $priority" }
  Record 'registered-hidden-launch-task' @{pid=$initial; task=$taskName; priority=$priority; console=$initialConsole; executionTimeLimit=$task.Settings.ExecutionTimeLimit; multipleInstances=[string]$task.Settings.MultipleInstances; taskPriority=$task.Settings.Priority; healthPriority=$healthTask.Settings.Priority}
  $duplicateOutput=& $node $server $configPath 2>&1
  if ($LASTEXITCODE -eq 0 -or (WaitReady) -ne $initial) { throw "Duplicate launch was not refused: $duplicateOutput" }
  Record 'duplicate-process-refused' @{pid=$initial}
  $secondaryPort=FreePort
  $secondaryConfig=[ordered]@{vault=$vault;backupDir=$backup;port=$secondaryPort;projects=@()}
  [IO.File]::WriteAllText($secondaryConfigPath,($secondaryConfig|ConvertTo-Json))
  $secondary=Start-Process -FilePath $node -ArgumentList ('"'+$server+'" "'+$secondaryConfigPath+'"') -WorkingDirectory $repo -WindowStyle Hidden -PassThru
  $deadline=[DateTime]::UtcNow.AddSeconds(30)
  do { try {$ok=(Invoke-RestMethod "http://127.0.0.1:$secondaryPort/health" -TimeoutSec 1 -NoProxy).ok} catch {$ok=$false}; if(-not $ok){Start-Sleep -Milliseconds 200} } while(-not $ok -and [DateTime]::UtcNow -lt $deadline)
  if(-not $ok){throw 'Second isolated config failed.'}
  $firstPort=$config.port
  $config.port=$secondaryPort; SaveConfig
  $cross=Launcher -Extra @('-Restart') -Failure
  if(-not (Invoke-RestMethod "http://127.0.0.1:$secondaryPort/health" -TimeoutSec 1 -NoProxy).ok){throw 'Cross-config listener was interrupted.'}
  $config.port=$firstPort; SaveConfig
  Stop-Process -Id $secondary.Id; $secondary.WaitForExit(); $secondary=$null
  Record 'same-directory-config-isolation' @{foreignConfigurationProtected=$true; denial=$cross.output.Trim()}
  $crashAt=[DateTime]::UtcNow
  Stop-Process -Id $initial
  $recovered=WaitReady -NotPid $initial
  $recoveredConsole=CheckConsole $recovered
  Record 'actual-periodic-crash-recovery' @{before=$initial;after=$recovered;seconds=[math]::Round(([DateTime]::UtcNow-$crashAt).TotalSeconds,2);console=$recoveredConsole}
  # Periodic recovery is proven; disable this fixture's health task to isolate manual probes.
  $null=FixtureTask $healthName '-Health'
  Disable-ScheduledTask -TaskName $healthName | Out-Null
  $age=([DateTime]::Now-(Get-Process -Id $recovered).StartTime).TotalSeconds
  if($age -lt 61){Start-Sleep -Seconds ([int][math]::Ceiling(61-$age))}
  $handle=[AxiomQualificationSuspend]::OpenProcess(0x0800,$false,$recovered)
  if($handle -eq [IntPtr]::Zero){throw 'Cannot open owned fixture for suspend.'}
  try {if([AxiomQualificationSuspend]::NtSuspendProcess($handle) -ne 0){throw 'Owned process suspend failed.'};$suspended=$recovered} finally {[AxiomQualificationSuspend]::CloseHandle($handle)|Out-Null}
  $null=Launcher -Extra @('-Health')
  if((Get-Content (Join-Path $state 'health-failures.txt') -Raw).Trim() -ne '1' -or -not (Get-Process -Id $recovered -ErrorAction SilentlyContinue)){throw 'First failed probe prematurely restarted the server.'}
  $hangAt=[DateTime]::UtcNow
  $null=Launcher -Extra @('-Health')
  $hangRecovered=WaitReady -NotPid $recovered
  $suspended=$null
  Record 'actual-two-probe-hang-recovery' @{before=$recovered;after=$hangRecovered;secondsAfterSecondProbe=[math]::Round(([DateTime]::UtcNow-$hangAt).TotalSeconds,2);firstFailureDidNotKill=$true}
  StopFixture
  $sinceLaunch=([DateTime]::Now-(Get-ScheduledTaskInfo -TaskName $taskName).LastRunTime).TotalSeconds
  if($sinceLaunch -lt 61){Start-Sleep -Seconds ([int][math]::Ceiling(61-$sinceLaunch))}
  # This is deliberately seeded, not a claim that three natural failures occurred.
  [IO.File]::WriteAllText((Join-Path $state 'health-failures.txt'),"1`r`n")
  [IO.File]::WriteAllText((Join-Path $state 'health-recoveries.txt'),"3`r`n")
  $limited=Launcher -Extra @('-Health') -Failure
  if($limited.output -notmatch 'budget exhausted' -or (Get-ScheduledTask -TaskName $taskName).State -eq 'Running'){throw 'Seeded exhausted recovery budget was ignored.'}
  Record 'seeded-budget-exhaustion-refused' @{seededRecoveries=3;diagnostic=$limited.output.Trim()}
  $null=Launcher -Extra @('-Restart')
  $resetPid=WaitReady
  if(Test-Path (Join-Path $state 'health-recoveries.txt')){throw 'Manual restart did not clear the budget.'}
  Record 'manual-restart-resets-budget' @{pid=$resetPid}
  StopFixture
  $foreignScript=Join-Path $root 'foreign-server.mjs'
  [IO.File]::WriteAllText($foreignScript,"import http from 'node:http'; http.createServer((q,s)=>s.end(JSON.stringify({ok:true}))).listen($($config.port),'127.0.0.1');`r`n")
  $foreign=Start-Process -FilePath $node -ArgumentList ('"'+$foreignScript+'"') -WindowStyle Hidden -PassThru
  $deadline=[DateTime]::UtcNow.AddSeconds(15)
  do {try {$foreignOk=(Invoke-RestMethod "http://127.0.0.1:$($config.port)/health" -TimeoutSec 1 -NoProxy).ok} catch {$foreignOk=$false}; if(-not $foreignOk){Start-Sleep -Milliseconds 200}} while(-not $foreignOk -and [DateTime]::UtcNow -lt $deadline)
  if(-not $foreignOk){throw 'Owned foreign-listener fixture failed.'}
  [IO.File]::WriteAllText((Join-Path $state 'server.pid'),"$($foreign.Id)`r`n")
  $denied=Launcher -Extra @('-Restart') -Failure
  if(-not (Invoke-RestMethod "http://127.0.0.1:$($config.port)/health" -TimeoutSec 1 -NoProxy).ok){throw 'Foreign listener was stopped.'}
  Record 'foreign-listener-with-stale-pid-protected' @{pid=$foreign.Id;diagnostic=$denied.output.Trim()}
} catch {
  Record 'qualification-failed' @{error=$_.ToString()}
  throw
} finally {
  if($suspended){try {$h=[AxiomQualificationSuspend]::OpenProcess(0x0800,$false,$suspended);if($h -ne [IntPtr]::Zero){[AxiomQualificationSuspend]::NtResumeProcess($h)|Out-Null;[AxiomQualificationSuspend]::CloseHandle($h)|Out-Null}} catch {$cleanupErrors.Add($_.ToString())}}
  if($foreign){try {if(-not $foreign.HasExited){Stop-Process -Id $foreign.Id; $foreign.WaitForExit()}} catch {$cleanupErrors.Add($_.ToString())}}
  if($secondary){try {if(-not $secondary.HasExited){Stop-Process -Id $secondary.Id; $secondary.WaitForExit()}} catch {$cleanupErrors.Add($_.ToString())}}
  if($taskName){
    try { $healthTask=FixtureTask $healthName '-Health'; if($healthTask){Unregister-ScheduledTask -TaskName $healthName -Confirm:$false} } catch {$cleanupErrors.Add($_.ToString())}
    try { StopFixture } catch {$cleanupErrors.Add($_.ToString())}
    try { $task=FixtureTask $taskName '-TaskLaunch'; if($task){Unregister-ScheduledTask -TaskName $taskName -Confirm:$false} } catch {$cleanupErrors.Add($_.ToString())}
  }
  if($cleanupErrors.Count -eq 0){try {Remove-Item -LiteralPath $root -Recurse -Force} catch {$cleanupErrors.Add($_.ToString())}}
  $evidence=[pscustomobject]@{events=@($events);cleanupErrors=@($cleanupErrors);fixtureRetained=($cleanupErrors.Count -gt 0);fixturePath=if($cleanupErrors.Count -gt 0){$root}else{$null}}
  [IO.File]::WriteAllText((Join-Path $EvidenceDir 'scheduler-smoke.json'), (($evidence | ConvertTo-Json -Depth 8) -replace "`r?`n","`r`n"))
  if($cleanupErrors.Count -gt 0){throw "Fixture cleanup failed; retained $root. $($cleanupErrors -join '; ')"}
}
Write-Output "All isolated scheduler recovery scenarios passed. Evidence: $EvidenceDir"
