# Hardens the PC that runs the AlphaSignal IBKR bridge.
# Prints a checklist. Applies the power plan and Windows Update policy when
# elevated. Re-registers the scheduled task only with -ApplyTask (prompts for
# the account password). Does not stop the bridge that is running now.
#
#   powershell -ExecutionPolicy Bypass -File .\host-hardening.ps1
#   powershell -ExecutionPolicy Bypass -File .\host-hardening.ps1 -ApplyTask

param([switch]$ApplyTask)

$ErrorActionPreference = 'Continue'
$taskName = 'AlphaSignal IBKR Bridge'
$bridgeScript = Join-Path $PSScriptRoot 'run-forever.ps1'
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)

function Say([string]$text) { Write-Host $text }

Say '=== Power: never sleep, never hibernate ==='
if ($isAdmin) {
  powercfg /change standby-timeout-ac 0 | Out-Null
  powercfg /change hibernate-timeout-ac 0 | Out-Null
  powercfg /change standby-timeout-dc 0 | Out-Null
  powercfg /change hibernate-timeout-dc 0 | Out-Null
  powercfg /setacvalueindex SCHEME_CURRENT SUB_SLEEP STANDBYIDLE 0 | Out-Null
  powercfg /setdcvalueindex SCHEME_CURRENT SUB_SLEEP STANDBYIDLE 0 | Out-Null
  powercfg /setacvalueindex SCHEME_CURRENT SUB_SLEEP HIBERNATEIDLE 0 | Out-Null
  powercfg /setdcvalueindex SCHEME_CURRENT SUB_SLEEP HIBERNATEIDLE 0 | Out-Null
  powercfg /setactive SCHEME_CURRENT | Out-Null
  Say 'Sleep and hibernate timeouts set to 0 on AC and DC.'
} else {
  Say 'Not elevated. Re-run this script from an elevated PowerShell to apply the power plan.'
}

Say ''
Say '=== Windows Update: no reboot outside the weekend window ==='
if ($isAdmin) {
  $ux = 'HKLM:\SOFTWARE\Microsoft\WindowsUpdate\UX\Settings'
  $au = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU'
  New-Item -Path $ux -Force | Out-Null
  New-Item -Path $au -Force | Out-Null
  # Active hours cover the SGT trading day. Saturday 03:00 is the install window.
  New-ItemProperty -Path $ux -Name ActiveHoursStart -Value 7 -PropertyType DWord -Force | Out-Null
  New-ItemProperty -Path $ux -Name ActiveHoursEnd -Value 1 -PropertyType DWord -Force | Out-Null
  New-ItemProperty -Path $au -Name NoAutoRebootWithLoggedOnUsers -Value 1 -PropertyType DWord -Force | Out-Null
  New-ItemProperty -Path $au -Name AlwaysAutoRebootAtScheduledTime -Value 0 -PropertyType DWord -Force | Out-Null
  New-ItemProperty -Path $au -Name ScheduledInstallDay -Value 7 -PropertyType DWord -Force | Out-Null
  New-ItemProperty -Path $au -Name ScheduledInstallTime -Value 3 -PropertyType DWord -Force | Out-Null
  New-ItemProperty -Path $au -Name AUOptions -Value 4 -PropertyType DWord -Force | Out-Null
  Say 'Active hours 07:00-01:00. Auto-install Saturday 03:00. No auto-reboot while logged on.'
  Say 'A domain group policy wins over these keys if one is present.'
} else {
  Say 'Not elevated. Windows Update policy was not changed.'
}

Say ''
Say '=== Scheduled task ==='
Say "Name:        $taskName"
Say "Script:      $bridgeScript"
Say 'Wanted:      run whether the user is logged on or not, highest privileges,'
Say '             trigger at startup, restart every 1 minute indefinitely,'
Say '             do not start a second instance.'
if ($ApplyTask) {
  if (-not $isAdmin) { throw 'ApplyTask needs an elevated PowerShell.' }
  $cred = Get-Credential -UserName $env:USERNAME -Message 'Password so the bridge can run when you are logged off'
  if (-not $cred) { throw 'No credential, task not changed.' }
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$bridgeScript`""
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -User $cred.UserName -Password $cred.GetNetworkCredential().Password -RunLevel Highest -Force | Out-Null
  Say "Task re-registered. Reboot once so only this instance is running."
  Say "Until that reboot the bridge that is already running keeps going; do not start a second one."
} else {
  Say 'Task not changed. Re-run with -ApplyTask when you are ready (it prompts for your password).'
}

Say ''
Say '=== Checklist ==='
Say '[ ] powercfg /query SCHEME_CURRENT SUB_SLEEP  -> standby and hibernate idle are 0'
Say '[ ] Task Scheduler: Run whether user is logged on or not, highest privileges'
Say '[ ] Trigger: At startup'
Say '[ ] Settings: restart every 1 minute, stop the task if it runs longer than: disabled'
Say '[ ] After the next reboot, a [run-forever] line appears in today''s bridge log with nobody logged on'
Say ''
Say 'Exit code 1073807364 (0x40010004) means Windows destroyed the console,'
Say 'which is what an Interactive-only task does on sleep, logoff or an update reboot.'
Say '14 Oct 06:59 SGT logged that code and never restarted. 22 Oct 16:53 SGT the log'
Say 'just stops. Details: docs/bridge-host-hardening.md'
