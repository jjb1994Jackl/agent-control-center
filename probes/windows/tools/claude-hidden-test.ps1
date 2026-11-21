param([string]$WorkArea, [string]$ClaudePath)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'hidden-desktop-test.ps1') -LibraryOnly

function Start-OnDesktop($desktop, $exe, $arguments, $flags) {
    $startup = [DesktopFixture+Startup]::new()
    $startup.cb = [Runtime.InteropServices.Marshal]::SizeOf($startup)
    $startup.desktop = "WinSta0\$desktop"
    $child = [DesktopFixture+Child]::new()
    $line = [Text.StringBuilder]::new("`"$exe`" $arguments")
    if (![DesktopFixture]::CreateProcess($exe,$line,0,0,$false,$flags,0,(Split-Path $exe),[ref]$startup,[ref]$child)) {
        throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())
    }
    [void][DesktopFixture]::CloseHandle($child.thread)
    [void][DesktopFixture]::CloseHandle($child.process)
    $child.pid
}

if ($WorkArea) {
    $desktop = Split-Path $WorkArea -Leaf
    $marker = "Frontdesk hidden desktop test $desktop. Reply only OK."
    $report = Join-Path $WorkArea 'result.txt'
    try {
        Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
        $link = 'claude://code/new?q=' + [uri]::EscapeDataString($marker)
        $appId = Start-OnDesktop $desktop $ClaudePath "`"$link`"" 0
        Add-Content $report "Launched Claude PID=$appId"
        $deadline = [DateTime]::UtcNow.AddSeconds(45)
        $invoked = $false
        $maxNodes = 0
        $windowFound = $false
        do {
            Start-Sleep -Milliseconds 350
            foreach ($app in @(Get-Process Claude -ErrorAction SilentlyContinue | Where-Object Path -eq $ClaudePath)) {
                $hwnd = [DesktopFixture]::FindBrowserWindow($app.Id,'')
                if ($hwnd -eq [IntPtr]::Zero) { continue }
                if (!$windowFound) { Add-Content $report "Verified Claude window on hidden desktop PID=$($app.Id)"; $windowFound=$true }
                $root = [Windows.Automation.AutomationElement]::FromHandle($hwnd)
                $nodes = $root.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition)
                $maxNodes = [Math]::Max($nodes.Count,$maxNodes)
                $matches = 0
                $send = @()
                foreach ($node in $nodes) {
                    if ($node.Current.ControlType -eq [Windows.Automation.ControlType]::Edit) {
                        $value = $null
                        if ($node.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern,[ref]$value) -and $value.Current.Value -ceq $marker) { $matches++ }
                    }
                    if ($node.Current.ControlType -eq [Windows.Automation.ControlType]::Button -and $node.Current.Name -in @('Send','Send message','发送','发送消息') -and $node.Current.IsEnabled) { $send += $node }
                }
                if ($matches -eq 1 -and $send.Count -eq 1) {
                    $invoked=$true
                    $send[0].GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
                    Add-Content $report 'Invoked Send once for the exact test draft'
                    break
                }
            }
        } until ($invoked -or [DateTime]::UtcNow -gt $deadline)
        Add-Content $report "Window=$windowFound maxNodes=$maxNodes matchingEditors=$matches sendButtons=$($send.Count) sendInvoked=$invoked"
        if ($invoked) { Start-Sleep -Seconds 12 }
    } catch { Add-Content $report $_.Exception.Message }
    finally { Set-Content (Join-Path $WorkArea 'done') 'done' }
    return
}

$exe=(Get-AppxPackage Claude).InstallLocation
if (!$exe) {throw 'Claude package missing'}
$exe=Join-Path $exe 'app\claude.exe'
if (Get-Process Claude -ErrorAction SilentlyContinue | Where-Object Path -eq $exe) {throw 'Fully exit Claude desktop before cold launch'}
$name='fd-claude-'+[guid]::NewGuid().ToString('N')
$area=(New-Item (Join-Path $env:TEMP $name) -ItemType Directory).FullName
$desktopHandle=[DesktopFixture]::CreateDesktop($name,0,0,0,0x1ff,0)
if ($desktopHandle -eq [IntPtr]::Zero) {throw 'Could not create desktop'}
try {
    $pwsh="$env:windir\System32\WindowsPowerShell\v1.0\powershell.exe"
    $fg=[DesktopFixture]::GetForegroundWindow()
    $changes=0
    $worker=Start-OnDesktop $name $pwsh "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -WorkArea `"$area`" -ClaudePath `"$exe`"" 0x08000000
    $limit=[DateTime]::UtcNow.AddSeconds(85)
    while (!(Test-Path (Join-Path $area 'done')) -and [DateTime]::UtcNow -lt $limit) {
        $now=[DesktopFixture]::GetForegroundWindow()
        if ($fg -ne $now) {$changes++; $fg=$now}
        Start-Sleep -Milliseconds 15
    }
    Get-Content (Join-Path $area 'result.txt')
    "Test desktop=$name, sampled foreground transitions=$changes"
} finally {
    [void][DesktopFixture]::CloseDesktop($desktopHandle)
}
