# Host hardening for the IBKR bridge PC

Run from an elevated PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File "C:\Users\tando\Downloads\alphasignal-repo\ibkr-bridge\host-hardening.ps1"
```

That applies the power plan and the Windows Update policy. It prints the
scheduled-task checklist and does not replace the running task.

To also re-register the task (it will ask for your password, because "run
whether the user is logged on or not" has to store one):

```powershell
powershell -ExecutionPolicy Bypass -File "C:\Users\tando\Downloads\alphasignal-repo\ibkr-bridge\host-hardening.ps1" -ApplyTask
```

Reboot once after `-ApplyTask`. The new task starts at boot. Do not leave the
old interactive supervisor running at the same time — two bridges fight over
clientId 27.

## What the script sets

- AC and DC sleep and hibernate timeouts to 0 (never sleep, never hibernate).
- Windows Update: no automatic reboot while you are logged on, install window
  Saturday 03:00. Active hours 07:00–01:00 so a weekday trading session is not
  the install window. A domain policy can override this; the script says so if
  the write fails.

## What you confirm after it runs

1. `powercfg /query SCHEME_CURRENT SUB_SLEEP` shows standby and hibernate idle as 0.
2. Task Scheduler → AlphaSignal IBKR Bridge → General: "Run whether user is logged on or not", "Run with highest privileges".
3. Triggers: At startup.
4. Settings: restart every 1 minute, indefinitely (the task API caps the count at 999), "If the task is already running, do not start a new instance".
5. After the next reboot, `ibkr-bridge\logs\bridge-<today>.log` contains a `[run-forever] starting bridge` line within a couple of minutes of boot, with no one logged on.

## Exit code 1073807364 (0x40010004)

That is `DBG_TERMINATE_PROCESS`: Windows killed the process because its
console went away. The bridge is started by the scheduled task
`AlphaSignal IBKR Bridge` with **Logon Mode: Interactive only**, so the hidden
PowerShell and node live in your logged-on session. When that session's
console is destroyed — sleep, hibernate, logoff, an update reboot, closing the
console host — node exits 1073807364 and the supervisor dies with it. A normal
IB Gateway drop does not look like this: the bridge logs `IB disconnected` and
exits 2, and the supervisor starts it again 30 seconds later. That happens
every day at 04:45 SGT and the log shows the restart.

14 Oct 2026, 06:59:10 SGT (`bridge-2026-10-14.log`): the supervisor wrote
`bridge exited (code 1073807364) - restarting in 30s` and then nothing. The
restart line is the last line in the file. The console was torn down in that
same moment, so the 30 second sleep never came back. The bridge stayed down
until it was started by hand on 19 Oct 16:47 SGT.

22 Oct 2026, 16:53:30 SGT (`bridge-2026-10-22.log`): the log stops on an ordinary
IB error line. There is no `IB disconnected` and no `[run-forever]` exit line,
so the supervisor was killed without getting to run its next statement. Same
failure, one step earlier. It stayed down until 25 Oct 19:31 SGT.

Neither outage is the 04:45 gateway restart. Both are the interactive-only
task losing its session. `-ApplyTask` plus never-sleep is what stops the next one.
