# IB Gateway after a reboot

Checked 2026-10-27 on this PC.

## What happens today

IB Gateway stable is `C:\Jts\ibgateway\1037\ibgateway.exe`. It is running now,
logged into the paper account (`tradingMode=p` in `jts.ini`), API trusted IP
`127.0.0.1`, `AutoRestart=1`.

Auto restart only recycles a Gateway that is already logged in. It does not
survive a Windows reboot or a logoff. There is no IBC install, no Gateway
shortcut in Startup, no scheduled task, and Windows auto-logon is off. After
a reboot the login dialog waits for a person, including the IB Key prompt.

The bridge task can come back at boot once `-ApplyTask` is in place. It will
then sit in a connect loop until someone logs Gateway in. That is the gap
the Saturday checklist closes.

## Recommendation

Use **IBC for the paper login**, and **Windows auto-logon only so a desktop
session exists** for that GUI. Auto-logon by itself still stops at the
Gateway password and the IB Key. IBC by itself, started with nobody logged
on, usually cannot drive the Gateway window.

Lock the workstation as soon as IBC has logged in, so the session stays up
and the screen does not.

IBKR still forces a full re-login about once a week. Budget a Monday check
for that. IBC cannot tap the IBKR Mobile prompt; if the paper user uses a
mobile IB Key, switch that user to a TOTP authenticator and put the secret
in IBC's `config.ini` (`ReloginAfterSecondFactorAuthenticationTimeout=no` is
the usual companion setting). Do not put the password in the repo.

## IBC steps (paper only)

1. Download IBC from https://github.com/IbcAlpha/IBC/releases and unzip to `C:\IBC`.
2. Copy `config.ini.template` to `C:\IBC\config.ini`. Set:
   - `IbLoginId` and `IbPassword` for the **paper** user
   - `TradingMode=paper`
   - `OverrideTwsApiPort=4002`
   - `ReadOnlyApi=no`
   - `AcceptIncomingConnectionAction=accept`
   - `ExistingSessionDetectedAction=primary`
3. In `StartGateway.bat`, set `TWS_MAJOR_VRSN=1037` and `IBC_PATH=C:\IBC`.
4. Log into Gateway once by hand and confirm Configure → Settings → API:
   socket port 4002, trusted IP `127.0.0.1`, read-only unticked. Then exit.
5. From an elevated PowerShell, register a task that runs at logon:

```powershell
$action = New-ScheduledTaskAction -Execute "C:\IBC\StartGateway.bat" -WorkingDirectory "C:\IBC"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName "IB Gateway Paper (IBC)" -Action $action -Trigger $trigger -Settings $settings -RunLevel Highest
```

6. Turn on auto-logon so the logon trigger fires after a reboot. Run `netplwiz`,
   untick "Users must enter a user name and password", and enter the Windows
   password. This stores it in the registry. Do this only on this trading PC.
7. Reboot once and confirm `127.0.0.1:4002` accepts a connection without you
   typing the IB password. Then lock the screen.

## Alert

If the bridge supervisor is running and nothing accepts on `127.0.0.1:4002`
for 10 minutes, Telegram gets `GATEWAY DOWN`. A repeat goes out every 30
minutes until the port accepts, then one `GATEWAY BACK`. The bridge process
itself uses the same 10-minute clock across its own restarts
(`IBKR_GATEWAY_DOWN_ALERT_MIN_MS`, default 600000).
