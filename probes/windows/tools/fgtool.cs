// One-off test tool: the foreground window, giving it back to a window, and watching it.
//   fgtool fg                       → {"hwnd","exe"}
//   fgtool restore <hwnd>           → attaches to the foreground thread's input, SetForegroundWindow(hwnd); no input is sent
//   fgtool watch <ms> <hwnd>        → every 50 ms: the foreground (on change), and whether <hwnd> is on the current desktop
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

[ComImport, Guid("a5cd92ff-29be-454c-8d04-d82879fb3f1b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IVirtualDesktopManager { [PreserveSig] int IsWindowOnCurrentVirtualDesktop(IntPtr hwnd, out int on); }

public static class FgTool
{
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint from, uint to, bool attach);
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT r);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr p, int flags, StringBuilder name, ref int size);

    static string Hex(IntPtr h) { return "0x" + h.ToInt64().ToString("x"); }
    static string Exe(IntPtr hwnd)
    {
        uint pid; GetWindowThreadProcessId(hwnd, out pid);
        IntPtr p = OpenProcess(0x1000, false, pid); if (p == IntPtr.Zero) return "";
        try { StringBuilder sb = new StringBuilder(1024); int n = sb.Capacity; return QueryFullProcessImageName(p, 0, sb, ref n) ? Path.GetFileName(sb.ToString()) : ""; } finally { CloseHandle(p); }
    }
    static object OnDesktop(IntPtr hwnd)
    {
        try { var m = (IVirtualDesktopManager)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("aa509086-5ca9-4c25-8f95-589d3c07b48a"))); int on; return m.IsWindowOnCurrentVirtualDesktop(hwnd, out on) == 0 ? (object)(on != 0) : null; }
        catch { return null; }
    }
    static IntPtr Parse(string s) { return new IntPtr(Convert.ToInt64(s.StartsWith("0x") ? s.Substring(2) : s, s.StartsWith("0x") ? 16 : 10)); }

    [STAThread]
    public static int Main(string[] args)
    {
        var json = new JavaScriptSerializer();
        Stopwatch clock = Stopwatch.StartNew();
        if (args[0] == "fg") { IntPtr f = GetForegroundWindow(); Console.WriteLine(json.Serialize(new Dictionary<string, object> { { "hwnd", Hex(f) }, { "exe", Exe(f) } })); return 0; }
        if (args[0] == "restore")
        {
            IntPtr target = Parse(args[1]), fg = GetForegroundWindow();
            uint pid, fgThread = GetWindowThreadProcessId(fg, out pid), me = GetCurrentThreadId();
            bool attached = fgThread != 0 && fgThread != me && AttachThreadInput(me, fgThread, true);
            bool set = SetForegroundWindow(target);
            if (attached) AttachThreadInput(me, fgThread, false);
            IntPtr after = GetForegroundWindow();
            Console.WriteLine(json.Serialize(new Dictionary<string, object> { { "from", Hex(fg) + " " + Exe(fg) }, { "attached", attached }, { "set", set }, { "after", Hex(after) + " " + Exe(after) }, { "ms", clock.ElapsedMilliseconds } }));
            return 0;
        }
        // guard <ms> <original> <claude>: every 10 ms, if a claude.exe window holds the foreground, give it
        // back to <original> at once. Reports each grab (start, how long), and how long Claude's window was
        // drawn on top at its own centre. Stops early when the file <ms>.stop appears next to the tool.
        if (args[0] == "guard")
        {
            int ms = int.Parse(args[1]); IntPtr original = Parse(args[2]), claude = Parse(args[3]);
            string stopFile = Path.Combine(Path.GetDirectoryName(typeof(FgTool).Assembly.Location), "guard.stop");
            RECT r; GetWindowRect(claude, out r); POINT centre; centre.X = (r.Left + r.Right) / 2; centre.Y = (r.Top + r.Bottom) / 2;
            var grabs = new List<object>(); long grabStart = -1, exposedMs = 0, lastTick = 0; int restores = 0, failed = 0; string grabbedBy = "";
            while (clock.ElapsedMilliseconds < ms && !File.Exists(stopFile))
            {
                long now = clock.ElapsedMilliseconds;
                IntPtr top = GetAncestor(WindowFromPoint(centre), 2);
                if (top != IntPtr.Zero && string.Equals(Exe(top), "claude.exe", StringComparison.OrdinalIgnoreCase)) exposedMs += now - lastTick;
                lastTick = now;
                IntPtr fg = GetForegroundWindow();
                bool claudeHasIt = fg != original && string.Equals(Exe(fg), "claude.exe", StringComparison.OrdinalIgnoreCase);
                if (claudeHasIt)
                {
                    if (grabStart < 0) { grabStart = now; grabbedBy = Hex(fg); }
                    uint pid, fgThread = GetWindowThreadProcessId(fg, out pid), me = GetCurrentThreadId();
                    bool attached = fgThread != 0 && fgThread != me && AttachThreadInput(me, fgThread, true);
                    bool set = SetForegroundWindow(original);
                    if (attached) AttachThreadInput(me, fgThread, false);
                    restores++; if (!set) failed++;
                }
                else if (grabStart >= 0 && fg == original)
                {
                    grabs.Add(new Dictionary<string, object> { { "at", grabStart }, { "ms", now - grabStart }, { "by", grabbedBy } });
                    grabStart = -1;
                }
                Thread.Sleep(10);
            }
            if (grabStart >= 0) grabs.Add(new Dictionary<string, object> { { "at", grabStart }, { "ms", clock.ElapsedMilliseconds - grabStart }, { "by", grabbedBy }, { "open", true } });
            Console.WriteLine(json.Serialize(new Dictionary<string, object> { { "grabs", grabs }, { "restores", restores }, { "failedRestores", failed }, { "claudeOnTopMs", exposedMs }, { "ranMs", clock.ElapsedMilliseconds } }));
            return 0;
        }
        if (args[0] == "watch")
        {
            int ms = int.Parse(args[1]); IntPtr target = Parse(args[2]);
            var changes = new List<object>(); string last = null; object lastDesk = null;
            while (clock.ElapsedMilliseconds < ms)
            {
                IntPtr f = GetForegroundWindow(); string now = Hex(f) + " " + Exe(f); object desk = OnDesktop(target);
                if (now != last || !Equals(desk, lastDesk)) { changes.Add(new Dictionary<string, object> { { "t", clock.ElapsedMilliseconds }, { "fg", now }, { "targetOnCurrentDesktop", desk } }); last = now; lastDesk = desk; }
                Thread.Sleep(50);
            }
            Console.WriteLine(json.Serialize(new Dictionary<string, object> { { "changes", changes } }));
            return 0;
        }
        return 2;
    }
}
