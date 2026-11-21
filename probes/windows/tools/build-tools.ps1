<#
.SYNOPSIS
  Builds the helpers the test runners in this folder use, with the csc.exe Windows ships, into
  %LOCALAPPDATA%\agent-frontdesk\tools (or $env:FRONTDESK_TOOLS):
    uia-probe.exe   probes\windows\uia-probe.cs   (windows, fg, ontop, census, act …)
    uia-driver.exe  src\server\native\uia-driver.cs  (the driver's read-only commands: check, probe, inspect, warm)
    fgtool.exe      probes\windows\tools\fgtool.cs  (fg, restore, watch, guard)
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File probes\windows\tools\build-tools.ps1
#>
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
$tools = if ($env:FRONTDESK_TOOLS) { $env:FRONTDESK_TOOLS } else { Join-Path $env:LOCALAPPDATA 'agent-frontdesk\tools' }
New-Item -ItemType Directory -Force -Path $tools | Out-Null
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
$builds = @(
    @{ out = 'uia-probe.exe'; src = Join-Path $repo 'probes\windows\uia-probe.cs' },
    @{ out = 'uia-driver.exe'; src = Join-Path $repo 'src\server\native\uia-driver.cs' },
    @{ out = 'fgtool.exe'; src = Join-Path $PSScriptRoot 'fgtool.cs' },
    @{ out = 'corner.exe'; src = Join-Path $PSScriptRoot 'corner.cs' },
    @{ out = 'screencap.exe'; src = Join-Path $PSScriptRoot 'screencap.cs' }
)
foreach ($b in $builds) {
    $out = Join-Path $tools $b.out
    & $csc /nologo /target:exe /langversion:5 /platform:anycpu /optimize+ /unsafe /codepage:65001 "/out:$out" /reference:System.dll /reference:System.Core.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll $b.src
    if ($LASTEXITCODE -ne 0) { throw "csc failed for $($b.src)" }
    Write-Host "built $out"
}
