param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$taskName = 'UstazonVideoBot-' + $env:USERNAME
if ($Remove) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop
    Write-Host 'Ustazon startup task removed. Use USTAZON_STOP.cmd to stop an already running worker.'
    exit 0
}
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$runnerPath = Join-Path $PSScriptRoot 'Start-UstazonHidden.ps1'
$nodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source
$versionText = (& $nodeExecutable --version).Trim()
$majorVersion = [int]($versionText.TrimStart('v').Split('.')[0])
if ($majorVersion -lt 24) { throw 'Ustazon requires Node.js 24 or newer.' }
$accountName = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$powerShellExecutable = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -File "{0}"' -f $runnerPath
$action = New-ScheduledTaskAction -Execute $powerShellExecutable -Argument $arguments -WorkingDirectory $projectRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $accountName
$principal = New-ScheduledTaskPrincipal -UserId $accountName -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Ustazon daily video worker at sign-in' -Force | Out-Null
Write-Host 'Startup task installed for this account. USTAZON_WORKER.cmd starts the bot now; USTAZON_STATUS.cmd shows its state.'
