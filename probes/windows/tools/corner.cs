// One-off test tool: operate Claude's window from behind another app by first parking it off the
// virtual screen with only a few pixels of one corner left on screen, then putting everything back.
//
//   corner info <hwnd>
//       placement, rects, the window right above it, the visible z-order, the foreground
//   corner place <hwnd> <showCmd>
//       sets only showCmd (4 normal, 3 maximized), transitions off: for setting up a case
//   corner run --claude <hwnd> --probe <uia-probe.exe> --profile <json> --steps <json> --out <file>
//              [--cap <screencap.exe> --capdir <dir>] [--corner 4] [--settle 400] [--tail 1500]
//              [--park true|false] [--guard-steps on|off]
//       1. records placement, the window right above it and the nearest visible one, the visible
//          z-order and the foreground
//       2. starts a watchdog thread (10 ms) that gives the foreground back whenever claude.exe takes it
//          (unless --guard-steps off, during the steps), logs every foreground change and whether Claude
//          is drawn at the screen's centre, and while parked re-raises Claude when its corner is covered
//       3. switches DWM's transitions off for the window; maximized: SetWindowPlacement to normal
//          (SW_SHOWNOACTIVATE), rcNormalPosition = the maximized rect
//       4. moves it (z-order unchanged) so only <corner>×<corner> visible pixels of its bottom-right corner
//          are on screen at the top-left; waits <settle> ms; raises it (HWND_TOP, else HWND_TOPMOST then
//          HWND_NOTOPMOST), never activating it; WindowFromPoint checked
//       5. runs `uia-probe seq` with the steps (one process, no pause between steps)
//       6. restores: foreground, z-order under the recorded visible window, SetWindowPlacement (the
//          original; normal shown without activating), z-order again, foreground, taskbar flash stopped;
//          then checks placement, rect, the windows above, the z-order and the foreground
// Every time is milliseconds on the machine-wide performance counter (qpcMs), as uia-probe seq and
// screencap write them. The process is per-monitor DPI aware, so every coordinate is in physical pixels.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

public static class Corner
{
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] public struct WINDOWPLACEMENT { public int length, flags, showCmd; public POINT ptMin, ptMax; public RECT rcNormal; }
    [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor, rcWork; public int dwFlags; }
    delegate bool EnumProc(IntPtr hwnd, IntPtr l);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
    [DllImport("user32.dll")] static extern bool GetWindowPlacement(IntPtr h, ref WINDOWPLACEMENT wp);
    [DllImport("user32.dll")] static extern bool SetWindowPlacement(IntPtr h, ref WINDOWPLACEMENT wp);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
    [StructLayout(LayoutKind.Sequential)] public struct FLASHWINFO { public int cbSize; public IntPtr hwnd; public int dwFlags, uCount, dwTimeout; }
    [DllImport("user32.dll")] static extern bool FlashWindowEx(ref FLASHWINFO fi);
    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr h, int attr, ref int v, int size);
    [DllImport("user32.dll")] static extern void SwitchToThisWindow(IntPtr h, bool altTab);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int index);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
    [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int max);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int v, int size);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr p, int flags, StringBuilder name, ref int size);

    const uint SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOZORDER = 0x4, SWP_NOACTIVATE = 0x10, SWP_NOOWNERZORDER = 0x200;
    static readonly IntPtr HWND_TOP = IntPtr.Zero;

    static double Qpc() { return Stopwatch.GetTimestamp() * 1000.0 / Stopwatch.Frequency; }
    static string Hex(IntPtr h) { return "0x" + h.ToInt64().ToString("x"); }
    static IntPtr Parse(string s) { return new IntPtr(Convert.ToInt64(s.StartsWith("0x") ? s.Substring(2) : s, s.StartsWith("0x") ? 16 : 10)); }
    static readonly Dictionary<uint, string> exeByPid = new Dictionary<uint, string>();
    static string Exe(IntPtr hwnd)
    {
        uint pid; GetWindowThreadProcessId(hwnd, out pid);
        lock (exeByPid)
        {
            string e; if (exeByPid.TryGetValue(pid, out e)) return e;
            IntPtr p = OpenProcess(0x1000, false, pid); e = "";
            if (p != IntPtr.Zero) { try { StringBuilder sb = new StringBuilder(1024); int n = sb.Capacity; if (QueryFullProcessImageName(p, 0, sb, ref n)) e = Path.GetFileName(sb.ToString()); } finally { CloseHandle(p); } }
            exeByPid[pid] = e; return e;
        }
    }
    static string Cls(IntPtr h) { StringBuilder sb = new StringBuilder(256); GetClassName(h, sb, 256); return sb.ToString(); }
    static bool IsClaude(IntPtr h) { return string.Equals(Exe(h), "claude.exe", StringComparison.OrdinalIgnoreCase); }
    static bool Topmost(IntPtr h) { return (GetWindowLong(h, -20) & 0x8) != 0; }
    static bool Cloaked(IntPtr h) { int c; return DwmGetWindowAttribute(h, 14, out c, 4) == 0 && c != 0; }
    static int[] R(RECT r) { return new[] { r.Left, r.Top, r.Right, r.Bottom }; }

    static WINDOWPLACEMENT Placement(IntPtr h) { WINDOWPLACEMENT wp = new WINDOWPLACEMENT(); wp.length = Marshal.SizeOf(typeof(WINDOWPLACEMENT)); GetWindowPlacement(h, ref wp); return wp; }
    static Dictionary<string, object> PlacementFacts(WINDOWPLACEMENT wp)
    {
        return new Dictionary<string, object> { { "flags", wp.flags }, { "showCmd", wp.showCmd }, { "ptMin", new[] { wp.ptMin.X, wp.ptMin.Y } }, { "ptMax", new[] { wp.ptMax.X, wp.ptMax.Y } }, { "rcNormal", R(wp.rcNormal) } };
    }
    static bool SamePlacement(WINDOWPLACEMENT a, WINDOWPLACEMENT b)
    {
        return a.flags == b.flags && a.showCmd == b.showCmd && a.ptMin.X == b.ptMin.X && a.ptMin.Y == b.ptMin.Y && a.ptMax.X == b.ptMax.X && a.ptMax.Y == b.ptMax.Y
            && a.rcNormal.Left == b.rcNormal.Left && a.rcNormal.Top == b.rcNormal.Top && a.rcNormal.Right == b.rcNormal.Right && a.rcNormal.Bottom == b.rcNormal.Bottom;
    }
    // Visible, uncloaked top-level windows, top to bottom.
    static List<IntPtr> VisibleOrder()
    {
        List<IntPtr> list = new List<IntPtr>();
        EnumWindows(delegate (IntPtr h, IntPtr l) { if (IsWindowVisible(h) && !Cloaked(h)) list.Add(h); return true; }, IntPtr.Zero);
        return list;
    }
    static List<object> Describe(List<IntPtr> order, int max)
    {
        return order.Take(max).Select(h => (object)(Hex(h) + " " + Exe(h) + " " + Cls(h) + (Topmost(h) ? " topmost" : ""))).ToList();
    }
    // The window right above <h> (GW_HWNDPREV), and the nearest one above it that is not topmost.
    static IntPtr Above(IntPtr h) { return GetWindow(h, 3); }
    static IntPtr AboveNonTopmost(IntPtr h) { IntPtr p = GetWindow(h, 3); while (p != IntPtr.Zero && Topmost(p)) p = GetWindow(p, 3); return p; }
    static Dictionary<string, object> WindowState(IntPtr h)
    {
        RECT wr; GetWindowRect(h, out wr); RECT ef; bool efOk = DwmGetWindowAttribute(h, 9, out ef, 16) == 0;
        IntPtr above = Above(h);
        return new Dictionary<string, object> {
            { "placement", PlacementFacts(Placement(h)) }, { "zoomed", IsZoomed(h) }, { "rect", R(wr) }, { "frame", efOk ? R(ef) : null },
            { "above", Hex(above) + " " + Exe(above) + " " + Cls(above) + (Topmost(above) ? " topmost" : "") + (IsWindowVisible(above) ? "" : " hidden") },
            { "aboveNonTopmost", Hex(AboveNonTopmost(h)) } };
    }
    // The nearest window above <h> that is visible, not topmost and not one of Claude's own (its IME
    // window, say): the window it was drawn under, so the one to put it back under.
    static IntPtr AboveVisible(IntPtr h)
    {
        IntPtr p = GetWindow(h, 3);
        while (p != IntPtr.Zero && (!IsWindowVisible(p) || Cloaked(p) || Topmost(p) || IsClaude(p))) p = GetWindow(p, 3);
        return p;
    }
    // Gives the foreground back to <target>, with no input. The watchdog's way first (attach to the
    // foreground thread, SetForegroundWindow); when that fails, attach to the target's thread too and
    // BringWindowToTop first; then SwitchToThisWindow. Returns the way that worked, or null.
    static string GiveBackOnce(IntPtr target, out int error)
    {
        error = 0;
        IntPtr fg = GetForegroundWindow(); uint pid, fgThread = GetWindowThreadProcessId(fg, out pid), me = GetCurrentThreadId(), tThread = GetWindowThreadProcessId(target, out pid);
        bool attached = fgThread != 0 && fgThread != me && AttachThreadInput(me, fgThread, true);
        bool set = SetForegroundWindow(target); if (!set) error = Marshal.GetLastWin32Error();
        if (attached) AttachThreadInput(me, fgThread, false);
        if (set && GetForegroundWindow() == target) return "attach+SetForegroundWindow";
        bool a1 = fgThread != 0 && fgThread != me && AttachThreadInput(me, fgThread, true), a2 = tThread != 0 && tThread != me && tThread != fgThread && AttachThreadInput(me, tThread, true);
        BringWindowToTop(target); bool set2 = SetForegroundWindow(target);
        if (a2) AttachThreadInput(me, tThread, false); if (a1) AttachThreadInput(me, fgThread, false);
        if (set2 && GetForegroundWindow() == target) return "attach both+BringWindowToTop+SetForegroundWindow";
        SwitchToThisWindow(target, true);
        if (GetForegroundWindow() == target) return "SwitchToThisWindow";
        return null;
    }
    static readonly Dictionary<string, int> giveBackWays = new Dictionary<string, int>();
    static readonly Dictionary<int, int> giveBackErrors = new Dictionary<int, int>();
    static string GiveBackCounted(IntPtr target)
    {
        int err; string way = GiveBackOnce(target, out err);
        lock (giveBackWays)
        {
            string k = way ?? "failed"; giveBackWays[k] = (giveBackWays.ContainsKey(k) ? giveBackWays[k] : 0) + 1;
            if (err != 0) giveBackErrors[err] = (giveBackErrors.ContainsKey(err) ? giveBackErrors[err] : 0) + 1;
        }
        return way;
    }
    static Dictionary<string, object> GiveBack(IntPtr target, int forMs)
    {
        double t = Qpc(); IntPtr fg = GetForegroundWindow(); string way = null; int tries = 0;
        while (way == null && Qpc() - t <= forMs) { way = GiveBackCounted(target); tries++; if (way == null) Thread.Sleep(10); }
        return new Dictionary<string, object> { { "from", Hex(fg) + " " + Exe(fg) }, { "way", way }, { "tries", tries }, { "after", Hex(GetForegroundWindow()) + " " + Exe(GetForegroundWindow()) }, { "ms", Qpc() - t } };
    }

    // ---- the watchdog ----
    static volatile bool guardStop;
    // --guard-steps off: during the steps the watchdog only logs; the foreground is given back after them.
    static volatile bool guardPaused;
    // While parked, the watchdog keeps the corner uncovered: giving the foreground back raises the other
    // window over it, and a fully covered Claude stops updating its page.
    static volatile bool keepCorner; static IntPtr cornerWindow; static POINT cornerPoint; static int reRaises;
    static readonly List<object> coveredCorner = new List<object>();
    static bool Raise(IntPtr h)
    {
        SetWindowPos(h, new IntPtr(-1), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        SetWindowPos(h, new IntPtr(-2), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        return GetAncestor(WindowFromPoint(cornerPoint), 2) == h;
    }
    static readonly List<object> fgChanges = new List<object>(), grabs = new List<object>(), centreClaude = new List<object>();
    static int restores, failedRestores;
    static void Guard(IntPtr original, POINT centre)
    {
        string last = null; double grabStart = -1; string grabBy = ""; double centreStart = -1;
        while (!guardStop)
        {
            double now = Qpc();
            IntPtr fg = GetForegroundWindow();
            string desc = Hex(fg) + " " + Exe(fg);
            if (desc != last) { lock (fgChanges) fgChanges.Add(new object[] { now, desc }); last = desc; }
            bool claudeHasIt = fg != original && IsClaude(fg) && !guardPaused;
            if (claudeHasIt)
            {
                if (grabStart < 0) { grabStart = now; grabBy = desc; }
                string way = GiveBackCounted(original);
                restores++; if (way == null) failedRestores++;
            }
            else if (grabStart >= 0)
            {
                lock (grabs) grabs.Add(new Dictionary<string, object> { { "atQpcMs", grabStart }, { "ms", now - grabStart }, { "by", grabBy }, { "backTo", desc } });
                grabStart = -1;
            }
            if (keepCorner && GetAncestor(WindowFromPoint(cornerPoint), 2) != cornerWindow)
            {
                bool up = Raise(cornerWindow); reRaises++;
                lock (coveredCorner) coveredCorner.Add(new object[] { now, up, Qpc() - now });
            }
            IntPtr top = GetAncestor(WindowFromPoint(centre), 2);
            bool claudeAtCentre = top != IntPtr.Zero && IsClaude(top);
            if (claudeAtCentre && centreStart < 0) centreStart = now;
            else if (!claudeAtCentre && centreStart >= 0) { lock (centreClaude) centreClaude.Add(new[] { centreStart, now - centreStart }); centreStart = -1; }
            Thread.Sleep(10);
        }
        double end = Qpc();
        if (grabStart >= 0) lock (grabs) grabs.Add(new Dictionary<string, object> { { "atQpcMs", grabStart }, { "ms", end - grabStart }, { "by", grabBy }, { "open", true } });
        if (centreStart >= 0) lock (centreClaude) centreClaude.Add(new[] { centreStart, end - centreStart, 1 });
    }

    static Dictionary<string, string> opts = new Dictionary<string, string>();
    static string Opt(string k, string d) { string v; return opts.TryGetValue(k, out v) ? v : d; }

    public static int Main(string[] args)
    {
        try { Console.OutputEncoding = new UTF8Encoding(false); } catch { }
        SetProcessDpiAwarenessContext(new IntPtr(-4));
        var json = new JavaScriptSerializer(); json.MaxJsonLength = int.MaxValue;
        for (int i = 1; i < args.Length; i++) if (args[i].StartsWith("--") && i + 1 < args.Length) { opts[args[i].Substring(2)] = args[i + 1]; i++; }
        if (args.Length >= 2 && args[0] == "info")
        {
            IntPtr h = Parse(args[1]); IntPtr fg = GetForegroundWindow();
            var info = WindowState(h);
            info["foreground"] = Hex(fg) + " " + Exe(fg);
            info["virtualScreen"] = new[] { GetSystemMetrics(76), GetSystemMetrics(77), GetSystemMetrics(78), GetSystemMetrics(79) };
            info["order"] = Describe(VisibleOrder(), 12);
            Console.WriteLine(json.Serialize(info));
            return 0;
        }
        // place <hwnd> <showCmd>: the window's placement with only showCmd changed (4 normal, 3 maximized), for setting up a case.
        if (args.Length >= 3 && args[0] == "place")
        {
            IntPtr h = Parse(args[1]); WINDOWPLACEMENT wp = Placement(h); wp.showCmd = int.Parse(args[2]);
            int on = 1; DwmSetWindowAttribute(h, 3, ref on, 4);
            bool ok = SetWindowPlacement(h, ref wp);
            int off = 0; DwmSetWindowAttribute(h, 3, ref off, 4);
            var res = WindowState(h); res["ok"] = ok; res["foreground"] = Hex(GetForegroundWindow()) + " " + Exe(GetForegroundWindow());
            Console.WriteLine(json.Serialize(res));
            return 0;
        }
        if (args.Length < 1 || args[0] != "run") { Console.WriteLine("usage: corner info <hwnd> | corner run --claude <hwnd> --probe <exe> --profile <json> --steps <json> --out <file>"); return 2; }

        IntPtr claude = Parse(Opt("claude", "0"));
        int keep = int.Parse(Opt("corner", "4")), tail = int.Parse(Opt("tail", "1500"));
        bool park = Opt("park", "true") != "false";
        var log = new Dictionary<string, object>();
        var timings = new List<object>();
        Action<string, double, object> mark = (what, started, extra) => { var d = new Dictionary<string, object> { { "step", what }, { "atQpcMs", started }, { "ms", Qpc() - started } }; if (extra != null) d["result"] = extra; timings.Add(d); };
        log["timings"] = timings;
        int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
        log["virtualScreen"] = new[] { vx, vy, vw, vh };

        // The screen recorder starts first, so its baseline is the scene before anything moves.
        Process cap = null; string capStop = null; var capOut = new StringBuilder();
        if (Opt("cap", null) != null)
        {
            string dir = Opt("capdir", "."); Directory.CreateDirectory(dir); capStop = Path.Combine(dir, "stop");
            try { File.Delete(capStop); } catch { }
            var psi = new ProcessStartInfo(Opt("cap", null), "\"" + dir + "\" --every 16 --preroll 1500 --max 120000") { UseShellExecute = false, RedirectStandardOutput = true, CreateNoWindow = true };
            cap = Process.Start(psi);
            cap.OutputDataReceived += (s, e) => { if (e.Data != null) lock (capOut) capOut.AppendLine(e.Data); };
            cap.BeginOutputReadLine();
            Thread.Sleep(2200);   // its preroll (1.5 s) learns what changes on its own (a caret, a clock)
        }

        // 1. What is to be put back.
        double t = Qpc();
        WINDOWPLACEMENT original = Placement(claude);
        IntPtr above = Above(claude);
        IntPtr insertAfter = AboveVisible(claude);
        IntPtr fgBefore = GetForegroundWindow();
        List<IntPtr> orderBefore = VisibleOrder();
        RECT rectBefore; GetWindowRect(claude, out rectBefore);
        log["before"] = WindowState(claude);
        log["foregroundBefore"] = Hex(fgBefore) + " " + Exe(fgBefore);
        log["insertAfter"] = Hex(insertAfter) + " " + Exe(insertAfter) + " " + Cls(insertAfter);
        log["orderBefore"] = Describe(orderBefore, 10);
        mark("record", t, null);
        if (IsClaude(fgBefore)) { log["stopped"] = "Claude holds the foreground at the start"; Finish(log, json, cap, capStop, capOut); return 3; }

        // 2. The watchdog, with the screen's centre as where a visible Claude would show.
        POINT centre; centre.X = vx + vw / 2; centre.Y = vy + vh / 2;
        guardStop = false;
        Thread guard = new Thread(() => Guard(fgBefore, centre)); guard.IsBackground = true; guard.Start();
        Thread.Sleep(50);

        bool wasMax = original.showCmd == 3;
        int settleMs = int.Parse(Opt("settle", "400"));
        if (park)
        {
            // DWM animates the change from maximized to normal; try to switch that off for this window
            // (DWMWA_TRANSITIONS_FORCEDISABLED), and in any case raise it only once the animation is over.
            int on = 1; int trHr = DwmSetWindowAttribute(claude, 3, ref on, 4);
            log["transitionsOffHr"] = "0x" + trHr.ToString("x8");
            // 3. Maximized: shown normal at the same rect, so the page keeps its size and does not lay out again.
            if (wasMax)
            {
                t = Qpc();
                IntPtr mon = MonitorFromWindow(claude, 2); MONITORINFO mi = new MONITORINFO(); mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO)); GetMonitorInfo(mon, ref mi);
                int ox = mi.rcWork.Left - mi.rcMonitor.Left, oy = mi.rcWork.Top - mi.rcMonitor.Top;   // rcNormalPosition is in workspace coordinates
                WINDOWPLACEMENT wp = original; wp.showCmd = 4; /* SW_SHOWNOACTIVATE: normal, not activated */ wp.flags = 0;
                wp.rcNormal.Left = rectBefore.Left - ox; wp.rcNormal.Top = rectBefore.Top - oy; wp.rcNormal.Right = rectBefore.Right - ox; wp.rcNormal.Bottom = rectBefore.Bottom - oy;
                bool ok = SetWindowPlacement(claude, ref wp);
                RECT now; GetWindowRect(claude, out now);
                mark("unmaximize", t, new Dictionary<string, object> { { "ok", ok }, { "rect", R(now) }, { "sameSize", now.Right - now.Left == rectBefore.Right - rectBefore.Left && now.Bottom - now.Top == rectBefore.Bottom - rectBefore.Top }, { "zoomed", IsZoomed(claude) } });
            }
            // 4. Off the virtual screen, but for keep×keep visible pixels of its bottom-right corner at the screen's top-left.
            t = Qpc();
            RECT wr, ef; GetWindowRect(claude, out wr);
            if (DwmGetWindowAttribute(claude, 9, out ef, 16) != 0) ef = wr;
            int w = wr.Right - wr.Left, hgt = wr.Bottom - wr.Top;
            int right = vx + keep + (wr.Right - ef.Right), bottom = vy + keep + (wr.Bottom - ef.Bottom);
            // Moved first without changing the z-order (still covered), so nothing of it shows yet.
            bool moved = SetWindowPos(claude, IntPtr.Zero, right - w, bottom - hgt, 0, 0, SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOZORDER);
            RECT pr; GetWindowRect(claude, out pr); RECT pf; DwmGetWindowAttribute(claude, 9, out pf, 16);
            mark("move off screen", t, new Dictionary<string, object> { { "ok", moved }, { "rect", R(pr) }, { "frame", R(pf) } });
            Thread.Sleep(settleMs);
            t = Qpc();
            POINT probe; probe.X = vx + keep / 2; probe.Y = vy + keep / 2;
            SetWindowPos(claude, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            IntPtr at = GetAncestor(WindowFromPoint(probe), 2);
            string raisedBy = at == claude ? "HWND_TOP" : null;
            cornerPoint = probe; cornerWindow = claude;
            // HWND_TOP from a background process leaves it under the foreground window: go through the
            // topmost band and back, which leaves it at the top of the ordinary windows.
            if (at != claude && Raise(claude)) { at = claude; raisedBy = "HWND_TOPMOST then HWND_NOTOPMOST"; }
            mark("raise corner", t, new Dictionary<string, object> { { "cornerPoint", new[] { probe.X, probe.Y } },
                { "atCorner", Hex(at) + " " + Exe(at) }, { "cornerIsClaude", at == claude }, { "raisedBy", raisedBy }, { "topmostNow", Topmost(claude) } });
            keepCorner = true;
            log["cornerZone"] = new[] { vx, vy, vx + keep, vy + keep };
        }

        // 5. The steps, in one process.
        guardPaused = Opt("guard-steps", "on") == "off";
        log["guardDuringSteps"] = !guardPaused;
        t = Qpc();
        var psi2 = new ProcessStartInfo(Opt("probe", "uia-probe.exe"), "seq --hwnd " + Hex(claude) + " --profile \"" + Opt("profile", "") + "\" --steps \"" + Opt("steps", "") + "\"") { UseShellExecute = false, RedirectStandardOutput = true, CreateNoWindow = true, StandardOutputEncoding = Encoding.UTF8 };
        Process p = Process.Start(psi2);
        string seqOut = p.StandardOutput.ReadToEnd(); p.WaitForExit();
        object seq; try { seq = json.DeserializeObject(seqOut.Trim().Split('\n').Last()); } catch { seq = seqOut; }
        log["seq"] = seq;
        mark("steps", t, null);

        // 6. Put everything back.
        // Restore order: the foreground first (a window that holds it is put on top by SW_SHOWMAXIMIZED),
        // then the z-order while it is still off screen, the placement, the z-order again, the foreground.
        guardPaused = false;
        keepCorner = false; Thread.Sleep(30);   // lets a re-raise the watchdog is in the middle of finish first
        t = Qpc();
        object fg1 = GetForegroundWindow() == fgBefore ? (object)"already" : GiveBack(fgBefore, 1000);
        mark("foreground (before restoring)", t, fg1);
        if (park)
        {
            t = Qpc();
            bool z1 = SetWindowPos(claude, insertAfter, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            mark("zorder (off screen)", t, new Dictionary<string, object> { { "ok", z1 }, { "aboveVisible", Hex(AboveVisible(claude)) }, { "topmostNow", Topmost(claude) } });
            t = Qpc();
            WINDOWPLACEMENT back = original;
            if (back.showCmd == 1) back.showCmd = 4;   // normal, without activating it
            bool pl = SetWindowPlacement(claude, ref back);
            IntPtr fgNow = GetForegroundWindow();
            mark("placement", t, new Dictionary<string, object> { { "ok", pl }, { "showCmd", back.showCmd }, { "aboveVisible", Hex(AboveVisible(claude)) + " " + Exe(AboveVisible(claude)) }, { "foreground", Hex(fgNow) + " " + Exe(fgNow) } });
            t = Qpc();
            bool z2 = SetWindowPos(claude, insertAfter, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            mark("zorder again", t, new Dictionary<string, object> { { "ok", z2 }, { "aboveVisible", Hex(AboveVisible(claude)) } });
        }
        t = Qpc();
        object fgBack = GetForegroundWindow() == fgBefore ? (object)"already" : GiveBack(fgBefore, 1000);
        mark("foreground", t, fgBack);
        // A refused grab leaves Claude's taskbar button flashing; stop that.
        t = Qpc();
        FLASHWINFO fi = new FLASHWINFO(); fi.cbSize = Marshal.SizeOf(typeof(FLASHWINFO)); fi.hwnd = claude; fi.dwFlags = 0;
        bool wasFlashing = FlashWindowEx(ref fi);
        mark("stop taskbar flash", t, new Dictionary<string, object> { { "wasActiveCaption", wasFlashing } });
        if (park) { int off = 0; DwmSetWindowAttribute(claude, 3, ref off, 4); }

        // Checks, then the watchdog runs on for <tail> ms.
        Thread.Sleep(200);
        WINDOWPLACEMENT after = Placement(claude);
        List<IntPtr> orderAfter = VisibleOrder();
        RECT rectAfter; GetWindowRect(claude, out rectAfter);
        log["after"] = WindowState(claude);
        log["check"] = new Dictionary<string, object> {
            { "placementSame", SamePlacement(original, after) }, { "rectSame", R(rectAfter).SequenceEqual(R(rectBefore)) },
            { "aboveSame", Above(claude) == above }, { "aboveVisibleSame", AboveVisible(claude) == insertAfter }, { "orderSame", orderAfter.SequenceEqual(orderBefore) },
            { "foregroundSame", GetForegroundWindow() == fgBefore } };
        if (!orderAfter.SequenceEqual(orderBefore)) log["orderAfter"] = Describe(orderAfter, 10);
        Thread.Sleep(tail);
        guardStop = true; guard.Join();
        log["guard"] = new Dictionary<string, object> { { "grabs", grabs }, { "restores", restores }, { "failedRestores", failedRestores }, { "giveBackWays", giveBackWays.ToDictionary(k => k.Key, k => (object)k.Value) }, { "setForegroundErrors", giveBackErrors.ToDictionary(k => k.Key.ToString(), k => (object)k.Value) }, { "claudeAtScreenCentre", centreClaude }, { "cornerReRaises", reRaises }, { "cornerCovered", coveredCorner }, { "foregroundChanges", fgChanges } };
        log["foregroundAtEnd"] = Hex(GetForegroundWindow()) + " " + Exe(GetForegroundWindow());
        Finish(log, json, cap, capStop, capOut);
        return 0;
    }

    static void Finish(Dictionary<string, object> log, JavaScriptSerializer json, Process cap, string capStop, StringBuilder capOut)
    {
        if (cap != null)
        {
            Thread.Sleep(300);
            File.WriteAllText(capStop, "");
            cap.WaitForExit(30000);
            string text; lock (capOut) text = capOut.ToString().Trim();
            try { log["screen"] = json.DeserializeObject(text.Split('\n').Last()); } catch { log["screen"] = text; }
        }
        string outFile = Opt("out", null);
        string s = json.Serialize(log);
        if (outFile != null) File.WriteAllText(outFile, s, new UTF8Encoding(false));
        Console.WriteLine(s);
    }
}
