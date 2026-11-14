$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$nodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source
$entryPath = Join-Path $projectRoot 'ustazon\supervisor.mjs'
if (-not (Test-Path -LiteralPath $entryPath -PathType Leaf)) { throw 'Cannot find the Ustazon supervisor.' }
$arguments = '"{0}" start' -f $entryPath
$workerProcess = Start-Process -FilePath $nodeExecutable -ArgumentList $arguments -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -Wait
exit $workerProcess.ExitCode
