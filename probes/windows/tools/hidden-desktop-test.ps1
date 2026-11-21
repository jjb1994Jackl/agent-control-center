param([ValidateSet('Chrome','Edge')][string]$BrowserName='Chrome', [string]$FixtureDirectory, [switch]$LibraryOnly)
$ErrorActionPreference = 'Stop'

Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class DesktopFixture {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    public struct Startup { public int cb; public string reserved,desktop,title; public int x,y,w,h,xc,yc,fill,flags; public short show,res2; public IntPtr reserved2,input,output,error; }
    [StructLayout(LayoutKind.Sequential)] public struct Child { public IntPtr process,thread; public int pid,tid; }
    [DllImport("user32",CharSet=CharSet.Unicode,SetLastError=true)] public static extern IntPtr CreateDesktop(string name,IntPtr device,IntPtr mode,int flags,uint access,IntPtr security);
    [DllImport("user32")] public static extern bool CloseDesktop(IntPtr handle);
    [DllImport("user32")] public static extern IntPtr GetForegroundWindow();
    private delegate bool Visit(IntPtr window, IntPtr context);
    [DllImport("user32")] private static extern bool EnumDesktopWindows(IntPtr desktop,Visit callback,IntPtr context);
    [DllImport("user32")] private static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
    [DllImport("user32",CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr window,StringBuilder title,int length);
    [DllImport("user32",CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr window,StringBuilder name,int length);
    [DllImport("user32")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32")] private static extern IntPtr GetThreadDesktop(uint thread);
    [DllImport("kernel32")] private static extern uint GetCurrentThreadId();
    public static IntPtr FindFixtureWindow(int processId) {
        return FindBrowserWindow(processId, "Frontdesk fixture");
    }
    public static IntPtr FindBrowserWindow(int processId, string titleFragment) {
        IntPtr found = IntPtr.Zero;
        EnumDesktopWindows(GetThreadDesktop(GetCurrentThreadId()), delegate(IntPtr w, IntPtr unused) {
            uint pid;
            GetWindowThreadProcessId(w,out pid);
            if (pid != processId) return true;
            var title = new StringBuilder(256);
            GetWindowText(w,title,title.Capacity);
            var className = new StringBuilder(128);
            GetClassName(w,className,className.Capacity);
            if (!IsWindowVisible(w) || className.ToString() != "Chrome_WidgetWin_1" || !title.ToString().Contains(titleFragment)) return true;
            found = w;
            return false;
        }, IntPtr.Zero);
        return found;
    }
    [DllImport("kernel32",CharSet=CharSet.Unicode,SetLastError=true)] public static extern bool CreateProcess(string exe,System.Text.StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,int flags,IntPtr env,string dir,ref Startup startup,out Child child);
    [DllImport("kernel32")] public static extern bool CloseHandle(IntPtr handle);
}
'@
if ($LibraryOnly) { return }

# The worker starts inside the test desktop. Its only input is a local fixture.
if ($FixtureDirectory) {
    $result = 'Fixture editor unavailable'
    try {
        Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
        function Find-Control($root, $name) {
            $match = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, $name)
            $root.FindFirst([Windows.Automation.TreeScope]::Descendants, $match)
        }
        $page = Join-Path $FixtureDirectory 'fixture.html'
        Set-Content $page '<title>Frontdesk fixture</title><input id="draft" aria-label="Fixture editor"><button aria-label="Submit fixture" onclick="if(draft.value===&quot;probe&quot;)this.setAttribute(&quot;aria-label&quot;,&quot;Received fixture&quot;)">Submit</button>'
        $url = ([uri]$page).AbsoluteUri
        $profile = Join-Path $FixtureDirectory 'profile'
        $edgePath = "$env:ProgramFiles\Google\Chrome\Application\chrome.exe"
        if ($BrowserName -eq 'Edge') { $edgePath = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe" }
        $startup = [DesktopFixture+Startup]::new()
        $startup.cb = [Runtime.InteropServices.Marshal]::SizeOf($startup)
        $startup.desktop = 'WinSta0\' + [IO.Path]::GetFileName($FixtureDirectory)
        $browser = [DesktopFixture+Child]::new()
        $line = [Text.StringBuilder]::new("`"$edgePath`" --user-data-dir=`"$profile`" --app=$url --force-renderer-accessibility --no-first-run --disable-background-mode")
        if (![DesktopFixture]::CreateProcess($edgePath,$line,0,0,$false,0,0,$FixtureDirectory,[ref]$startup,[ref]$browser)) {
            throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())
        }
        $edge = Get-Process -Id $browser.pid
        [void][DesktopFixture]::CloseHandle($browser.thread)
        [void][DesktopFixture]::CloseHandle($browser.process)
        $deadline = [DateTime]::UtcNow.AddSeconds(25)
        do {
            Start-Sleep -Milliseconds 250
            $edge.Refresh()
            if ($edge.HasExited) { throw 'Edge launcher exited' }
            $window = [DesktopFixture]::FindFixtureWindow($edge.Id)
            if ($window -ne [IntPtr]::Zero) {
                $root = [Windows.Automation.AutomationElement]::FromHandle($window)
                $editor = Find-Control $root 'Fixture editor'
            }
        } until ($editor -or [DateTime]::UtcNow -gt $deadline)
        if (!$editor) {
            $result = if ($window -eq [IntPtr]::Zero) { 'Browser running, no matching fixture window on worker desktop' } else { 'Fixture window found, editor unavailable' }
            if ($root) {
                $nodes = $root.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition)
                $result += "; UIA nodes=$($nodes.Count), fixture title=$($root.Current.Name -like '*Frontdesk fixture*'), window title matches fixture=$($edge.MainWindowTitle -like '*Frontdesk fixture*'), documents=$(@($nodes | Where-Object { $_.Current.ControlType -eq [Windows.Automation.ControlType]::Document }).Count)"
            }
        }
        if ($editor) {
            $editor.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).SetValue('probe')
            (Find-Control $root 'Submit fixture').GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
            $result = 'No renderer acknowledgement'
            for ($i = 0; $i -lt 20; $i++) {
                Start-Sleep -Milliseconds 200
                if (Find-Control $root 'Received fixture') { $result = 'Verified background fill, invoke and renderer acknowledgement'; break }
            }
        }
    } catch { $result = $_.Exception.Message }
    finally {
        if ($edge -and !$edge.HasExited) {
            [void]$edge.CloseMainWindow()
            if (!$edge.WaitForExit(3000)) { $edge.Kill() }
        }
        [IO.File]::WriteAllText((Join-Path $FixtureDirectory 'result.txt'), $result)
    }
    return
}


$name = 'fd-fixture-' + [guid]::NewGuid().ToString('N')
$area = (New-Item (Join-Path $env:TEMP $name) -ItemType Directory).FullName
$handle = [DesktopFixture]::CreateDesktop($name, 0, 0, 0, 0x1ff, 0)
if (!$handle.ToInt64()) { throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
try {
    $startup = [DesktopFixture+Startup]::new()
    $startup.cb = [Runtime.InteropServices.Marshal]::SizeOf($startup)
    $startup.desktop = 'WinSta0\' + $name
    $child = [DesktopFixture+Child]::new()
    $exe = "$env:windir\System32\WindowsPowerShell\v1.0\powershell.exe"
    $argsLine = [Text.StringBuilder]::new("`"$exe`" -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -BrowserName $BrowserName -FixtureDirectory `"$area`"")
    $previous = [DesktopFixture]::GetForegroundWindow()
    if (![DesktopFixture]::CreateProcess($exe,$argsLine,0,0,$false,0x08000000,0,$area,[ref]$startup,[ref]$child)) {
        throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())
    }
    $file = Join-Path $area 'result.txt'
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    $changes = 0
    while (!(Test-Path $file) -and [DateTime]::UtcNow -lt $deadline) {
        $current = [DesktopFixture]::GetForegroundWindow()
        if ($previous -ne $current) { $changes++; $previous = $current }
        Start-Sleep -Milliseconds 15
    }
    if (Test-Path $file) { Get-Content $file } else { 'Fixture timed out' }
    "Sampled foreground changes: $changes"
    "Fixture directory: $area"
} finally {
    if ($child.thread) { [void][DesktopFixture]::CloseHandle($child.thread); [void][DesktopFixture]::CloseHandle($child.process) }
    [void][DesktopFixture]::CloseDesktop($handle)
}
