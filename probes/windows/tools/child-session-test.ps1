# Run with Windows PowerShell in STA mode. Requires permission to temporarily
# enable child sessions. Only a child created during this probe is logged off.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;
public class ChildProbeForm : Form {
    protected override bool ShowWithoutActivation { get { return true; } }
}
public class ChildSessionFixture : AxHost {
    public ChildSessionFixture() : base("A0C63C30-F08D-4AB4-907C-34905D770C7D") {}
    public object Client { get { return GetOcx(); } }
    [ComImport, Guid("302D8188-0052-4807-806A-362B628F9AC5"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface Extended {
        void Put([MarshalAs(UnmanagedType.BStr)] string property, [In, MarshalAs(UnmanagedType.Struct)] ref object value);
        [return: MarshalAs(UnmanagedType.Struct)] object Get([MarshalAs(UnmanagedType.BStr)] string property);
    }
    public void SelectChild() {
        var settings = (Extended)Client;
        object enable = true;
        settings.Put("ConnectToChildSession", ref enable);
        if (!true.Equals(settings.Get("ConnectToChildSession"))) throw new InvalidOperationException("Child mode unconfirmed");
    }
    [DllImport("wtsapi32",SetLastError=true)] public static extern bool WTSIsChildSessionsEnabled(out bool enabled);
    [DllImport("wtsapi32",SetLastError=true)] public static extern bool WTSEnableChildSessions(bool enabled);
    [DllImport("wtsapi32",SetLastError=true)] public static extern bool WTSGetChildSessionId(out uint id);
    [DllImport("wtsapi32",SetLastError=true)] public static extern bool WTSLogoffSession(IntPtr server,uint id,bool wait);
}
'@
$original = $false
if (![ChildSessionFixture]::WTSIsChildSessionsEnabled([ref]$original)) { throw 'Cannot read original child session setting' }
if ($original) { throw 'Child sessions already enabled; leaving existing setup alone' }
$priorId = [uint32]::MaxValue
if ([ChildSessionFixture]::WTSGetChildSessionId([ref]$priorId) -and $priorId -ne [uint32]::MaxValue) { throw 'Existing child session; leaving it alone' }
$parentId = (Get-Process -Id $PID).SessionId
try {
    if (![ChildSessionFixture]::WTSEnableChildSessions($true)) { throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
    $now = $false
    if (![ChildSessionFixture]::WTSIsChildSessionsEnabled([ref]$now) -or !$now) { throw 'Enable did not take effect' }
    'Child sessions enabled'
    $form = New-Object ChildProbeForm
    $form.ShowInTaskbar = $false
    $form.Opacity = 0
    $form.ClientSize = New-Object Drawing.Size(1024,768)
    $control = New-Object ChildSessionFixture
    $control.Dock = 'Fill'
    $form.Controls.Add($control)
    $form.Show()
    [Windows.Forms.Application]::DoEvents()
    $null = $form.Handle
    $null = $control.Handle
    $control.SelectChild()
    $control.Client.DesktopWidth = 1024
    $control.Client.DesktopHeight = 768
    # ConnectToChildSession supplies the loopback destination itself.
    $control.Client.Connect()
    $limit = [DateTime]::UtcNow.AddSeconds(30)
    do {
        [Windows.Forms.Application]::DoEvents()
        Start-Sleep -Milliseconds 200
        $id = [uint32]::MaxValue
        $found = [ChildSessionFixture]::WTSGetChildSessionId([ref]$id) -and $id -ne [uint32]::MaxValue
    } until (($found -and $control.Client.Connected -eq 1) -or [DateTime]::UtcNow -gt $limit)
    "RDP state=$($control.Client.Connected); child ID=$id; parent ID=$parentId"
} finally {
    try {
        $id = [uint32]::MaxValue
        if ([ChildSessionFixture]::WTSGetChildSessionId([ref]$id) -and $id -ne [uint32]::MaxValue -and $id -ne $parentId -and $id -gt 0) {
            if (![ChildSessionFixture]::WTSLogoffSession([IntPtr]::Zero,$id,$true)) { Write-Warning 'Test child could not be logged off' }
        }
        if ($form) { $form.Dispose() }
    } finally {
        [void][ChildSessionFixture]::WTSEnableChildSessions($false)
        $after = $true
        if (![ChildSessionFixture]::WTSIsChildSessionsEnabled([ref]$after) -or $after) { throw 'Child-session setting restoration could not be verified' }
        'Verified original child-session setting restored'
    }
}
