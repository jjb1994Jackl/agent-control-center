// The UI Automation driver every desktop flow shares on Windows: the twin of ax-driver.swift.
// The actions live here, the engine's names for its controls live in its profile
// (src/server/native/profiles/<id>.json, read the same way as on macOS, with a "windows" section for
// what differs there), and whether a message really went out is decided by the engine's own record,
// back in JS.
//
// Compiled by src/server/core/desktop-automation.ts with the csc.exe of .NET Framework 4.x that every
// Windows 10/11 ships (C# 5), into the person's cache, once per source version: nothing is downloaded
// and nothing has to be signed. UIA is reached through its COM interfaces (UIA3, as Narrator reaches
// it), declared by hand below. The helper is run as
//   AX_PROFILE=<profile.json> <helper> <command> [args…]
// and prints one JSON object. The driver's own commands only look:
//   check  → {"trusted":…, "running":…, "ported":[…]}: the app has a window, this process may act on
//            it, and which commands the engine's flow (<engine>-desktop.cs) ports
//   probe  → which of the profile's locators the page shows right now: found / ways / differ / drift / several
//   inspect [<locator>…]  → what the controls those locators find go by besides their names
//   warm [check]  → reads the page once so the desktop keeps its accessibility tree; with `check`,
//            also whether the profile still matches that page
//   restore  → puts back a window a helper left parked when it was stopped (every command does this
//            first; the server runs `restore` alone right after it had to stop a helper)
// The commands an engine's flow ports act on the page, with the window parked in a corner (below);
// any other command answers `not_ported` until its flow is ported. One window is parked at a time on
// the machine, whichever engine's helper parks it.
//
// The three things ax-driver.swift holds for every flow hold here too, written once below:
// "one control, or none" (Sole), "a control found by its place" (Confirmed, against the profile's
// menuSigns), and every answer naming the controls found by another way than their first (`via`).
//
// No global input is sent, and UIA's SetFocus is not used. On Windows a page takes the foreground
// whenever an action moves its focus, so the window is parked off screen but for a corner and the
// foreground given straight back (skills/add-desktop-engine/references/philosophy.md's rule, bent as
// little as measured: probes/windows/PLAN.md, "Parked in a corner").
//
// The COM declarations of IUIAutomation, IUIAutomationElement, IUIAutomationTreeWalker,
// IUIAutomationCacheRequest and IUIAutomationElementArray follow vercel-labs/agent-desktop's
// probes/windows (Apache-2.0), which checked them against the Windows SDK's UIAutomationClient.h.
// Each interface is declared only as far as its last method used (a COM vtable may be declared short
// at its end, never with a gap).

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

namespace Frontdesk.Driver
{
    // ---- UI Automation, as COM ----
    [ComImport, Guid("352ffba8-0973-437c-a61f-f64cafd81df9"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IUIAutomationCondition { }

    [ComImport, Guid("14314595-b4bc-4055-95f2-58f2e42c9855"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IUIAutomationElementArray { int GetLength(); IUIAutomationElement GetElement(int index); }

    [ComImport, Guid("b32a92b5-bc25-4078-9c08-d7ee95c48e03"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IUIAutomationCacheRequest
    {
        void AddProperty(int propertyId);
        void AddPattern(int patternId);
        IUIAutomationCacheRequest Clone();
        int GetTreeScope();
        void SetTreeScope(int scope);
        IUIAutomationCondition GetTreeFilter();
        void SetTreeFilter(IUIAutomationCondition filter);
    }

    [ComImport, Guid("4042c624-389c-4afc-a630-9df854a541fc"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IUIAutomationTreeWalker
    {
        IUIAutomationElement GetParentElement(IUIAutomationElement element);
        IUIAutomationElement GetFirstChildElement(IUIAutomationElement element);
        IUIAutomationElement GetLastChildElement(IUIAutomationElement element);
        IUIAutomationElement GetNextSiblingElement(IUIAutomationElement element);
    }

    [ComImport, Guid("d22108aa-8ac5-49a5-837b-37bbb3d7591e"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IUIAutomationElement
    {
        void SetFocus();
        [return: MarshalAs(UnmanagedType.SafeArray, SafeArraySubType = VarEnum.VT_I4)]
        int[] GetRuntimeId();
        IUIAutomationElement FindFirst(int scope, IUIAutomationCondition condition);
        IUIAutomationElementArray FindAll(int scope, IUIAutomationCondition condition);
        void Slot5FindFirstBuildCache();
        IUIAutomationElementArray FindAllBuildCache(int scope, IUIAutomationCondition condition, IUIAutomationCacheRequest cacheRequest);
        IUIAutomationElement BuildUpdatedCache(IUIAutomationCacheRequest cacheRequest);
        [return: MarshalAs(UnmanagedType.Struct)]
        object GetCurrentPropertyValue(int propertyId);
        void Slot9GetCurrentPropertyValueEx();
        [return: MarshalAs(UnmanagedType.Struct)]
        object GetCachedPropertyValue(int propertyId);
        void Slot11GetCachedPropertyValueEx();
        void Slot12GetCurrentPatternAs();
        void Slot13GetCachedPatternAs();
        [return: MarshalAs(UnmanagedType.IUnknown)]
        object GetCurrentPattern(int patternId);
        void Slot15GetCachedPattern();
        void Slot16GetCachedParent();
        IUIAutomationElementArray GetCachedChildren();
    }

    [ComImport, Guid("30cbe57d-d9d0-452a-ab13-7ac5ac4825ee"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IUIAutomation
    {
        int CompareElements(IUIAutomationElement el1, IUIAutomationElement el2);
        void Slot2CompareRuntimeIds();
        IUIAutomationElement GetRootElement();
        IUIAutomationElement ElementFromHandle(IntPtr hwnd);
        void Slot5ElementFromPoint();
        IUIAutomationElement GetFocusedElement();
        void Slot7RootBuildCache();
        void Slot8FromHandleBuildCache();
        void Slot9FromPointBuildCache();
        void Slot10FocusedBuildCache();
        IUIAutomationTreeWalker CreateTreeWalker(IUIAutomationCondition condition);
        IUIAutomationTreeWalker GetControlViewWalker();
        IUIAutomationTreeWalker GetContentViewWalker();
        IUIAutomationTreeWalker GetRawViewWalker();
        IUIAutomationCondition GetRawViewCondition();
        IUIAutomationCondition GetControlViewCondition();
        IUIAutomationCondition GetContentViewCondition();
        IUIAutomationCacheRequest CreateCacheRequest();
    }

    [ComImport, Guid("a5cd92ff-29be-454c-8d04-d82879fb3f1b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IVirtualDesktopManager { [PreserveSig] int IsWindowOnCurrentVirtualDesktop(IntPtr topLevelWindow, out int onCurrentDesktop); }

    // The patterns the flows act through (ids from UIAutomationClient.h, as uia-probe.cs declares them).
    [ComImport, Guid("fb377fbe-8ea6-46d5-9c73-6499642d3059"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IUIAutomationInvokePattern { void Invoke(); }

    [ComImport, Guid("a94cd8b1-0844-4cd6-9d2d-640537ab39e9"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IUIAutomationValuePattern
    {
        void SetValue([MarshalAs(UnmanagedType.BStr)] string value);
        [return: MarshalAs(UnmanagedType.BStr)] string GetCurrentValue();
    }

    [ComImport, Guid("619be086-1f4e-4ee4-bafa-210128738730"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IUIAutomationExpandCollapsePattern { void Expand(); void Collapse(); int GetCurrentExpandCollapseState(); }

    [ComImport, Guid("b488300f-d015-4f19-9c29-bb595e3645ef"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IUIAutomationScrollItemPattern { void ScrollIntoView(); }

    [ComImport, Guid("94cf8058-9b8d-4ab9-8bfd-4cd0a33c8c70"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IUIAutomationTogglePattern { void Toggle(); int GetCurrentToggleState(); }

    [ComImport, Guid("a8efa66a-0fda-421a-9194-38021f3578ea"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IUIAutomationSelectionItemPattern { void Select(); }


    // What the window parking (see "parked in a corner" below) calls: placement, z-order, foreground.
    public static class Win
    {
        [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
        [StructLayout(LayoutKind.Sequential)] public struct WINDOWPLACEMENT { public int length, flags, showCmd; public POINT ptMin, ptMax; public Native.RECT rcNormal; }
        [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public Native.RECT rcMonitor, rcWork; public int dwFlags; }
        [StructLayout(LayoutKind.Sequential)] public struct FLASHWINFO { public int cbSize; public IntPtr hwnd; public int dwFlags, uCount, dwTimeout; }
        public delegate bool MonitorProc(IntPtr monitor, IntPtr dc, ref Native.RECT rect, IntPtr data);
        [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
        [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr h, ref WINDOWPLACEMENT wp);
        [DllImport("user32.dll")] public static extern bool SetWindowPlacement(IntPtr h, ref WINDOWPLACEMENT wp);
        [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
        [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
        [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
        [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool altTab);
        [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
        [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
        [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
        [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int index);
        [DllImport("user32.dll")] public static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, MonitorProc proc, IntPtr data);
        [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
        [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
        [DllImport("user32.dll")] public static extern bool FlashWindowEx(ref FLASHWINFO fi);
        [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
        [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(IntPtr m, int type, out uint x, out uint y);
        [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out Native.RECT r, int size);
        [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr h, int attr, ref int v, int size);
        [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    }

    public static class Native
    {
        public delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
        [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc proc, IntPtr lParam);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, StringBuilder name, int max);
        [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
        [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
        [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
        [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);
        [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern bool QueryFullProcessImageName(IntPtr process, int flags, StringBuilder name, ref int size);
        [DllImport("advapi32.dll")] public static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
        [DllImport("advapi32.dll")] public static extern bool GetTokenInformation(IntPtr token, int infoClass, IntPtr info, int length, out int returned);
        [DllImport("advapi32.dll")] public static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
        [DllImport("advapi32.dll")] public static extern IntPtr GetSidSubAuthority(IntPtr sid, int index);
    }

    // One element of the page, as read once (ax-driver.swift's `known`: everything a search looks at,
    // fetched together, in one round trip for the whole page).
    public class Node
    {
        public int Index, End, Parent = -1, ControlType, ExpandState = -1, ToggleState = -1;
        public double Top, Bottom;   // on screen (physical pixels), for telling one block from the next
        public List<int> Kids = new List<int>();
        public string Name = "", Accel = "", AutomationId = "", ClassName = "", AriaRole = "", AriaProps = "", Value = "", Help = "", FullDescription = "", Framework = "";
        public bool IsDialog, PExpand, PValue, PText, Enabled = true;
        public string Localized = "";
        public IUIAutomationElement Element;
        public bool HasPopupMark { get { return Regex.IsMatch(AriaProps, @"(^|;)\s*haspopup=(?!false)", RegexOptions.IgnoreCase); } }
        public bool ValueIsAddress { get { return Regex.IsMatch(Value, @"^(https?|file|about|chrome|app):", RegexOptions.IgnoreCase); } }
        public List<string> Classes { get { return ClassName.Split(new[] { ' ', '\t', '\n' }, StringSplitOptions.RemoveEmptyEntries).ToList(); } }
    }

    // A locator of the profile, read as ax-driver.swift reads it (see its "A locator names one kind of
    // control"): the Mac roles (AXButton…) are mapped to what Chromium shows on Windows in RoleIs.
    public class Loc
    {
        public string Key, Role, Name, Prefix, Contains, After, Inside, Has, Keys, Id, Subrole, Url, Aria;
        public List<string> Roles = new List<string>(), Classes = new List<string>();
        public bool Named; public int? Index; public bool? Popup;
        public bool Worded { get { return Name != null || Prefix != null || Contains != null; } }
        public bool Placed { get { return Index.HasValue || After != null; } }
        public string Kind { get { return Worded ? "name" : Placed ? "place" : "mark"; } }
        public static Loc From(string key, Dictionary<string, object> spec)
        {
            Loc l = new Loc(); l.Key = key;
            l.Role = Str(spec, "role"); l.Name = Str(spec, "name"); l.Prefix = Str(spec, "prefix"); l.Contains = Str(spec, "contains");
            l.After = Str(spec, "after"); l.Inside = Str(spec, "inside"); l.Has = Str(spec, "has"); l.Keys = Str(spec, "keys");
            l.Id = Str(spec, "id"); l.Subrole = Str(spec, "subrole"); l.Url = Str(spec, "url"); l.Aria = Str(spec, "aria");
            object v;
            if (spec.TryGetValue("roles", out v) && v is object[]) l.Roles = ((object[])v).Select(o => Convert.ToString(o, CultureInfo.InvariantCulture)).ToList();
            if (spec.TryGetValue("class", out v)) { if (v is string) l.Classes.Add((string)v); else if (v is object[]) l.Classes = ((object[])v).Select(o => Convert.ToString(o, CultureInfo.InvariantCulture)).ToList(); }
            if (spec.TryGetValue("named", out v) && v is bool) l.Named = (bool)v;
            if (spec.TryGetValue("popup", out v) && v is bool) l.Popup = (bool)v;
            if (spec.TryGetValue("index", out v) && v != null) l.Index = Convert.ToInt32(v, CultureInfo.InvariantCulture);
            return l;
        }
        static string Str(Dictionary<string, object> spec, string key) { object v; return spec.TryGetValue(key, out v) && v is string ? (string)v : null; }
    }

    public static partial class Helper
    {
        // ---- the ids UIAutomationClient.h gives ----
        const int P_ControlType = 30003, P_Name = 30005, P_Accel = 30006, P_AutomationId = 30011, P_ClassName = 30012, P_Help = 30013,
            P_Framework = 30024, P_IsExpand = 30028, P_IsText = 30040, P_IsValue = 30043, P_Value = 30045,
            P_AriaRole = 30101, P_AriaProps = 30102, P_FullDescription = 30159, P_IsDialog = 30174, P_ExpandState = 30070,
            P_ToggleState = 30086, P_Bounds = 30001, P_Enabled = 30010, P_Localized = 30004;
        const int Pat_Invoke = 10000, Pat_Value = 10002, Pat_Expand = 10005, Pat_SelItem = 10010, Pat_Toggle = 10015, Pat_ScrollItem = 10017;
        const int CT_Button = 50000, CT_CheckBox = 50002, CT_ComboBox = 50003, CT_Edit = 50004, CT_Hyperlink = 50005, CT_Image = 50006, CT_List = 50008,
            CT_Menu = 50009, CT_MenuItem = 50011, CT_RadioButton = 50013, CT_Slider = 50015, CT_Text = 50020, CT_Custom = 50025, CT_Group = 50026,
            CT_Document = 50030, CT_Pane = 50033;
        static readonly Dictionary<int, string> ControlTypeNames = new Dictionary<int, string> {
            {50000,"Button"},{50002,"CheckBox"},{50003,"ComboBox"},{50004,"Edit"},{50005,"Hyperlink"},{50006,"Image"},{50007,"ListItem"},{50008,"List"},
            {50009,"Menu"},{50011,"MenuItem"},{50013,"RadioButton"},{50015,"Slider"},{50018,"Tab"},{50019,"TabItem"},{50020,"Text"},{50025,"Custom"},
            {50026,"Group"},{50030,"Document"},{50032,"Window"},{50033,"Pane"} };
        // The Mac subroles the profiles use, as the ARIA role Chromium reports on Windows.
        static readonly Dictionary<string, string> SubroleAria = new Dictionary<string, string> {
            {"AXDocumentArticle","article"},{"AXApplicationGroup","group"},{"AXApplicationStatus","status"},{"AXApplicationDialog","dialog"},
            {"AXApplicationAlertDialog","alertdialog"},{"AXApplicationAlert","alert"},{"AXLandmarkMain","main"},{"AXLandmarkNavigation","navigation"},
            {"AXLandmarkRegion","region"},{"AXTabPanel","tabpanel"} };

        static IUIAutomation uia;
        static readonly Stopwatch clock = Stopwatch.StartNew();
        static int reads;
        static readonly bool tracing = Environment.GetEnvironmentVariable("AX_TRACE") != null;
        static void Trace(string what) { if (tracing) Console.Error.WriteLine("[uia +" + clock.ElapsedMilliseconds + "ms " + reads + "r] " + what); }

        // ---- the command line ----
        static List<string> args = new List<string>();
        static Dictionary<string, string> wanted = new Dictionary<string, string>();
        static string command { get { return args.Count > 0 ? args[0] : ""; } }
        // The new-chat page's parking (desktop-automation.ts): the conversation the person had before
        // the desktop was left on that page, and whether this command leaves it there.
        static string parkedPrevious = ""; static bool staying;

        // ---- the answer ----
        // What the command learned about its own footing (see "one control, or none" and "a control
        // found by its place"), added to every answer by Annotate.
        static Dictionary<string, int> via = new Dictionary<string, int>(), refused = new Dictionary<string, int>();
        static List<string> unconfirmed = new List<string>();
        static Dictionary<Node, KeyValuePair<string, int>> origin = new Dictionary<Node, KeyValuePair<string, int>>();
        static HashSet<Node> soleNow = new HashSet<Node>();
        class Done : Exception { public readonly int Code; public Done(int code) { Code = code; } }
        static void Out(Dictionary<string, object> answer)
        {
            // Whatever the answer, the person's mode comes back and the window is put back first.
            Func<string> exit = beforeExit; beforeExit = null;
            if (exit != null) { string error = null; try { error = exit(); } catch { } if (error != null) answer["spaceNotRestored"] = error; }
            Unpark(false);
            if (parkReport != null) answer["parked"] = parkReport;
            else if (Parking.Skipped != null) answer["parked"] = Parking.Skipped;
            Annotate(answer);
            answer["ms"] = (int)clock.ElapsedMilliseconds; answer["reads"] = reads;
            JavaScriptSerializer json = new JavaScriptSerializer(); json.MaxJsonLength = int.MaxValue; json.RecursionLimit = 100;
            Console.WriteLine(json.Serialize(answer));
            Console.Out.Flush();
            // What is left of the park (a minimized window's saved bounds), after the answer is out.
            FinishPark();
            object ok;
            throw new Done(answer.TryGetValue("ok", out ok) && ok is bool && !(bool)ok ? 1 : 0);
        }
        static void Fail(string code, string message) { Out(new Dictionary<string, object> { { "ok", false }, { "code", code }, { "error", message } }); }

        [MTAThread]
        public static int Main(string[] argv)
        {
            try { Console.OutputEncoding = new UTF8Encoding(false); } catch { }
            // Per-monitor DPI aware (V2): window rects, frame bounds and points all in physical pixels.
            try { Win.SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
            for (int i = 0; i < argv.Length; i++)
            {
                string a = argv[i];
                if ((a == "--model" || a == "--effort" || a == "--mode" || a == "--space") && i + 1 < argv.Length) { wanted[a.Substring(2)] = argv[++i]; continue; }
                if (a == "--previous" && i + 1 < argv.Length) { parkedPrevious = argv[++i]; continue; }
                if (a == "--stay") { staying = true; continue; }
                args.Add(a);
            }
            try { Run(); return 0; }
            catch (Done done) { return done.Code; }
            catch (Exception e)
            {
                try { Unpark(); } catch { }
                Console.WriteLine(new JavaScriptSerializer().Serialize(new Dictionary<string, object> { { "ok", false }, { "code", "crashed" }, { "error", e.GetType().Name + ": " + e.Message }, { "ms", (int)clock.ElapsedMilliseconds } }));
                return 1;
            }
        }

        // ---- the profile: the engine's names for things, as data ----
        static Dictionary<string, object> profile = new Dictionary<string, object>();
        static Dictionary<string, object> windowsSpec = new Dictionary<string, object>();
        static Dictionary<string, List<Loc>> locators = new Dictionary<string, List<Loc>>();
        static string Setting(string key)
        {
            object v;
            if (windowsSpec.TryGetValue(key, out v) && v is string) return (string)v;
            return profile.TryGetValue(key, out v) && v is string ? (string)v : "";
        }
        static List<string> Settings(string key)
        {
            object v;
            if (!windowsSpec.TryGetValue(key, out v)) profile.TryGetValue(key, out v);
            return v is object[] ? ((object[])v).Select(o => Convert.ToString(o, CultureInfo.InvariantCulture)).ToList() : new List<string>();
        }
        static string appName { get { string n = Setting("name"); return n.Length > 0 ? n : "桌面版"; } }
        static List<Loc> LocatorList(string key, object value)
        {
            List<Loc> ways = new List<Loc>();
            if (value is Dictionary<string, object>) ways.Add(Loc.From(key, (Dictionary<string, object>)value));
            else if (value is object[]) foreach (object o in (object[])value) { if (o is Dictionary<string, object>) ways.Add(Loc.From(key, (Dictionary<string, object>)o)); }
            return ways;
        }
        // The profile's locators, with the "windows" section's own for the controls the Windows app
        // draws elsewhere (Claude's mode switch sits in the window's top bar, not in its sidebar): a
        // locator named there replaces the one of the same name, and may be new.
        static void LoadProfile()
        {
            string path = Environment.GetEnvironmentVariable("AX_PROFILE");
            if (string.IsNullOrEmpty(path) || !File.Exists(path)) return;
            profile = new JavaScriptSerializer().DeserializeObject(File.ReadAllText(path, Encoding.UTF8)) as Dictionary<string, object> ?? new Dictionary<string, object>();
            object raw;
            if (profile.TryGetValue("windows", out raw) && raw is Dictionary<string, object>) windowsSpec = (Dictionary<string, object>)raw;
            foreach (Dictionary<string, object> source in new[] { profile, windowsSpec })
            {
                if (!source.TryGetValue("locators", out raw) || !(raw is Dictionary<string, object>)) continue;
                foreach (KeyValuePair<string, object> kv in (Dictionary<string, object>)raw) locators[kv.Key] = LocatorList(kv.Key, kv.Value);
            }
        }

        // ---- the app ----
        static IntPtr window = IntPtr.Zero;
        static int IntegrityOf(IntPtr process)
        {
            IntPtr token;
            if (!Native.OpenProcessToken(process, 0x0008, out token)) return -1;
            try
            {
                int size; Native.GetTokenInformation(token, 25, IntPtr.Zero, 0, out size);
                IntPtr buffer = Marshal.AllocHGlobal(size);
                try
                {
                    if (!Native.GetTokenInformation(token, 25, buffer, size, out size)) return -1;
                    IntPtr sid = Marshal.ReadIntPtr(buffer);
                    int count = Marshal.ReadByte(Native.GetSidSubAuthorityCount(sid));
                    return Marshal.ReadInt32(Native.GetSidSubAuthority(sid, count - 1));
                }
                finally { Marshal.FreeHGlobal(buffer); }
            }
            finally { Native.CloseHandle(token); }
        }
        static int IntegrityOfPid(uint pid)
        {
            IntPtr process = Native.OpenProcess(0x1000, false, pid);
            if (process == IntPtr.Zero) return -1;
            try { return IntegrityOf(process); } finally { Native.CloseHandle(process); }
        }
        static string ExeOf(uint pid)
        {
            IntPtr process = Native.OpenProcess(0x1000, false, pid);
            if (process == IntPtr.Zero) return "";
            try { StringBuilder sb = new StringBuilder(1024); int size = sb.Capacity; return Native.QueryFullProcessImageName(process, 0, sb, ref size) ? Path.GetFileName(sb.ToString()) : ""; }
            finally { Native.CloseHandle(process); }
        }
        static string ClassOf(IntPtr hwnd) { StringBuilder sb = new StringBuilder(256); Native.GetClassName(hwnd, sb, sb.Capacity); return sb.ToString(); }
        static bool Cloaked(IntPtr hwnd) { int cloaked; return Native.DwmGetWindowAttribute(hwnd, 14, out cloaked, 4) == 0 && cloaked != 0; }
        // The app's own window: a titled Chromium window of the profile's exe ("windows": {"exe": …}).
        // A visible one before a hidden one (Codex keeps a hidden window titled like its main one),
        // then a restored one before a minimized one (whose rect is only its caption), then the largest.
        static IntPtr FindWindow()
        {
            string exe = Setting("exe");
            if (exe.Length == 0) return IntPtr.Zero;
            List<IntPtr> found = new List<IntPtr>();
            Native.EnumWindows(delegate (IntPtr hwnd, IntPtr l)
            {
                uint pid; Native.GetWindowThreadProcessId(hwnd, out pid);
                if (ClassOf(hwnd).StartsWith("Chrome_WidgetWin", StringComparison.Ordinal) && Native.GetWindowTextLength(hwnd) > 0 && string.Equals(ExeOf(pid), exe, StringComparison.OrdinalIgnoreCase)) found.Add(hwnd);
                return true;
            }, IntPtr.Zero);
            return found.OrderByDescending(h => Native.IsWindowVisible(h)).ThenByDescending(h => !Native.IsIconic(h))
                .ThenByDescending(h => { Native.RECT r; Native.GetWindowRect(h, out r); return (long)(r.Right - r.Left) * (r.Bottom - r.Top); })
                .FirstOrDefault();
        }
        // On screen: shown, not minimized, not cloaked (another virtual desktop, or hidden by the shell).
        static bool OnScreen()
        {
            if (window == IntPtr.Zero || !Native.IsWindowVisible(window) || Native.IsIconic(window) || Cloaked(window)) return false;
            try
            {
                IVirtualDesktopManager m = (IVirtualDesktopManager)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("aa509086-5ca9-4c25-8f95-589d3c07b48a")));
                int on; return m.IsWindowOnCurrentVirtualDesktop(window, out on) != 0 || on != 0;
            }
            catch { return true; }
        }

        // ---- reading the page ----
        // Every property read is a round trip to the desktop's process, so the whole page is read in
        // one: a cache request over the raw view (Stale() drops it after anything that could change it).
        static List<Node> nodes = new List<Node>();
        static bool pageRead;
        static readonly int[] WalkProps = { P_ControlType, P_Name, P_Accel, P_AutomationId, P_ClassName, P_Help, P_Framework, P_IsExpand, P_IsText, P_IsValue, P_Value, P_AriaRole, P_AriaProps, P_FullDescription, P_IsDialog, P_ExpandState, P_ToggleState, P_Bounds, P_Enabled, P_Localized };
        static void Stale() { pageRead = false; soleNow.Clear(); }
        static object ReadProp(IUIAutomationElement e, int id)
        {
            try { object v = e.GetCachedPropertyValue(id); return v != null && Marshal.IsComObject(v) ? null : v; } catch { return null; }
        }
        static string S(object v) { return v as string ?? ""; }
        static bool B(object v) { return v is bool && (bool)v; }
        static void Add(IUIAutomationElement e, int parent, int depth)
        {
            if (nodes.Count >= 20000 || depth > 90) return;
            Node n = new Node { Element = e, Parent = parent, Index = nodes.Count };
            n.ControlType = ReadProp(e, P_ControlType) is int ? (int)ReadProp(e, P_ControlType) : 0;
            n.Name = S(ReadProp(e, P_Name)); n.Accel = S(ReadProp(e, P_Accel)); n.AutomationId = S(ReadProp(e, P_AutomationId));
            n.ClassName = S(ReadProp(e, P_ClassName)); n.Help = S(ReadProp(e, P_Help)); n.Framework = S(ReadProp(e, P_Framework));
            n.Value = S(ReadProp(e, P_Value)); n.AriaRole = S(ReadProp(e, P_AriaRole)); n.AriaProps = S(ReadProp(e, P_AriaProps));
            n.FullDescription = S(ReadProp(e, P_FullDescription)); n.IsDialog = B(ReadProp(e, P_IsDialog));
            n.PExpand = B(ReadProp(e, P_IsExpand)); n.PValue = B(ReadProp(e, P_IsValue)); n.PText = B(ReadProp(e, P_IsText));
            object state = ReadProp(e, P_ExpandState); if (state is int) n.ExpandState = (int)state;
            object toggle = ReadProp(e, P_ToggleState); if (toggle is int) n.ToggleState = (int)toggle;
            double[] bounds = ReadProp(e, P_Bounds) as double[]; if (bounds != null && bounds.Length == 4) { n.Top = bounds[1]; n.Bottom = bounds[1] + bounds[3]; }
            n.Enabled = !(ReadProp(e, P_Enabled) is bool) || (bool)ReadProp(e, P_Enabled);
            n.Localized = S(ReadProp(e, P_Localized));
            if (parent >= 0) nodes[parent].Kids.Add(n.Index);
            nodes.Add(n);
            IUIAutomationElementArray kids = null;
            try { kids = e.GetCachedChildren(); } catch { }
            if (kids != null) { int count = kids.GetLength(); for (int i = 0; i < count; i++) Add(kids.GetElement(i), n.Index, depth + 1); }
            n.End = nodes.Count - 1;
        }
        static void ReadPage()
        {
            if (pageRead) return;
            nodes = new List<Node>(); origin.Clear();
            reads++;
            IUIAutomationCacheRequest cache = uia.CreateCacheRequest();
            foreach (int id in WalkProps) { try { cache.AddProperty(id); } catch { } }
            cache.SetTreeScope(7);                                  // the element and everything under it
            cache.SetTreeFilter(uia.GetRawViewCondition());          // the raw view, like the Mac tree
            try { Add(uia.ElementFromHandle(window).BuildUpdatedCache(cache), -1, 0); } catch (Exception e) { Trace("read failed: " + e.Message); }
            popupMarked = nodes.Any(n => n.AriaProps.IndexOf("haspopup=", StringComparison.OrdinalIgnoreCase) >= 0);
            pageRead = true;
        }
        static IEnumerable<Node> Within(Node box) { for (int i = box.Index; i <= box.End && i < nodes.Count; i++) yield return nodes[i]; }

        // ---- finding a control ----
        // Whether Chromium puts haspopup into AriaProperties on this machine; when it does not, a button
        // that opens something is told by the ExpandCollapse pattern instead.
        static bool popupMarked;
        // A Mac role, as Chromium shows it on Windows (measured: probes/windows/PLAN.md).
        static HashSet<string> unmappedRoles = new HashSet<string>();
        static bool RoleIs(Node n, string ax)
        {
            bool opens = popupMarked ? n.HasPopupMark : n.PExpand;
            switch (ax)
            {
                case "AXButton": return n.ControlType == CT_Button && !opens;
                case "AXPopUpButton": return n.ControlType == CT_ComboBox || (n.ControlType == CT_Button && opens);
                case "AXMenuItem": return n.ControlType == CT_MenuItem || n.AriaRole == "menuitem" || n.AriaRole == "menuitemradio" || n.AriaRole == "menuitemcheckbox";
                case "AXGroup": return (n.ControlType == CT_Group || n.ControlType == CT_Custom || n.ControlType == CT_Pane) && n.AriaRole != "heading" && n.AriaRole != "radiogroup";
                case "AXTextArea": return n.ControlType == CT_Edit || (n.ControlType != CT_Document && n.PValue && n.PText && !n.ValueIsAddress);
                case "AXTextField": return n.ControlType == CT_Edit;
                case "AXHeading": return n.AriaRole == "heading";
                case "AXWebArea": return n.ControlType == CT_Document;
                case "AXRadioGroup": return n.AriaRole == "radiogroup";
                case "AXList": return n.ControlType == CT_List;
                case "AXStaticText": return n.ControlType == CT_Text && n.AriaRole != "heading";
                case "AXCheckBox": return n.ControlType == CT_CheckBox;
                case "AXRadioButton": return n.ControlType == CT_RadioButton;
                case "AXLink": return n.ControlType == CT_Hyperlink;
                case "AXImage": return n.ControlType == CT_Image;
                case "AXSlider": return n.ControlType == CT_Slider;
                case "AXMenu": return n.ControlType == CT_Menu;
                default: unmappedRoles.Add(ax); return false;
            }
        }
        static bool HasClass(Node n, string want)
        {
            List<string> has = n.Classes;
            return want.EndsWith("*", StringComparison.Ordinal) ? has.Any(c => c.StartsWith(want.Substring(0, want.Length - 1), StringComparison.Ordinal)) : has.Contains(want);
        }
        // A shortcut the page declares, as Windows writes it: Chromium reports aria-keyshortcuts' "Meta"
        // as "Control" here ("Meta+n" is "Control+n"), so a profile's keys are compared that way.
        static string WindowsKeys(string keys) { return keys.Replace("Meta", "Control"); }
        // What the element itself is; where it is ("inside", "after", "index") is Matches.
        static bool Fits(Node n, Loc l)
        {
            if (l.Role != null && !RoleIs(n, l.Role)) return false;
            if (l.Roles.Count > 0 && !l.Roles.Any(r => RoleIs(n, r))) return false;
            if (l.Subrole != null) { string aria; if (!SubroleAria.TryGetValue(l.Subrole, out aria)) { unmappedRoles.Add(l.Subrole); return false; } if (n.AriaRole != aria) return false; }
            // (Windows only, in a profile's "windows" section: the ARIA role Chromium reports, where it says
            // more than the Mac subrole does, as for Claude's chat list, a "feed".)
            if (l.Aria != null && n.AriaRole != l.Aria) return false;
            if (l.Id != null && n.AutomationId != l.Id) return false;
            if (l.Keys != null && n.Accel != WindowsKeys(l.Keys)) return false;
            foreach (string want in l.Classes) if (!HasClass(n, want)) return false;
            if (l.Popup.HasValue && (n.HasPopupMark || n.PExpand) != l.Popup.Value) return false;
            if (l.Url != null) { if (n.ControlType != CT_Document) return false; string own = n.Value; if (l.Url.EndsWith("*", StringComparison.Ordinal) ? !own.StartsWith(l.Url.Substring(0, l.Url.Length - 1), StringComparison.Ordinal) : own != l.Url) return false; }
            if (!l.Worded && !l.Named) return true;
            string[] names = { n.Name, Label(n) };
            if (l.Name != null && !names.Contains(l.Name)) return false;
            if (l.Prefix != null && !names.Any(s => s.StartsWith(l.Prefix, StringComparison.Ordinal))) return false;
            if (l.Contains != null && !names.Any(s => s.IndexOf(l.Contains, StringComparison.OrdinalIgnoreCase) >= 0)) return false;
            if (l.Named && names.All(s => s.Length == 0)) return false;
            return true;
        }
        // A control's label: its name and its description, once when they say the same.
        static string Label(Node n)
        {
            string more = n.FullDescription.Length > 0 ? n.FullDescription : n.Help;
            return more.Length == 0 || more == n.Name ? n.Name : (n.Name + " " + more).Trim();
        }
        // Everything one way of finding a control finds, in the order the page lists it. (`depth`: a
        // locator placed by another, placed by another…: a profile that goes round in a circle finds nothing.)
        static List<Node> Matches(Loc l, int depth)
        {
            ReadPage();
            if (depth >= 5 || nodes.Count == 0) return new List<Node>();
            Node scope = nodes[0];
            if (l.Inside != null) { scope = Find(l.Inside, depth + 1); if (scope == null) return new List<Node>(); }
            List<Node> hits;
            if (l.After != null)
            {
                Node mark = Find(l.After, depth + 1);
                if (mark == null) return new List<Node>();
                hits = Within(scope).Where(n => n.Index > mark.Index && Fits(n, l)).ToList();
            }
            else hits = Within(scope).Where(n => Fits(n, l)).ToList();
            if (l.Has != null)
            {
                List<Node> held = FindAll(l.Has, depth + 1);
                hits = hits.Where(box => held.Any(part => part != box && part.Index > box.Index && part.Index <= box.End)).ToList();
            }
            if (!l.Index.HasValue) return hits;
            int at = l.Index.Value < 0 ? hits.Count + l.Index.Value : l.Index.Value;
            return at >= 0 && at < hits.Count ? new List<Node> { hits[at] } : new List<Node>();
        }
        static List<Node> FindAll(string key, int depth = 0)
        {
            List<Loc> ways; if (!locators.TryGetValue(key, out ways)) return new List<Node>();
            foreach (Loc l in ways) { List<Node> hits = Matches(l, depth); if (hits.Count > 0) return hits; }
            return new List<Node>();
        }
        // (Which locator found the control, and by which of its ways, is kept with it: `origin`, for
        // the check before anything is done to it; `via`, for the answer.)
        static Node Find(string key, int depth = 0)
        {
            List<Loc> ways; if (!locators.TryGetValue(key, out ways)) return null;
            for (int way = 0; way < ways.Count; way++)
            {
                List<Node> hits = Matches(ways[way], depth);
                if (hits.Count == 0) continue;
                origin[hits[0]] = new KeyValuePair<string, int>(key, way); via[key] = way;
                return hits[0];
            }
            return null;
        }

        // ---- one control, or none ----
        // As in ax-driver.swift: before anything is done to a control a locator found, the way that
        // found it is asked for everything it finds. Exactly one: go on. Several: another of the
        // locator's ways may still single out this very control; if none does, nothing is done and the
        // answer says why ("ambiguous"). The box it was looked for in, and the control it was counted
        // from, have to be the only ones too.
        static bool Sole(Node e, int depth = 0)
        {
            KeyValuePair<string, int> from; List<Loc> ways;
            if (depth >= 5 || !origin.TryGetValue(e, out from) || !locators.TryGetValue(from.Key, out ways) || from.Value >= ways.Count || soleNow.Contains(e)) return true;
            Loc l = ways[from.Value];
            if (!l.Placed)
            {
                List<Node> hits = Matches(l, 0);
                if (hits.Count > 1)
                {
                    bool singled = Enumerable.Range(0, ways.Count).Any(j => j != from.Value && !ways[j].Placed && Matches(ways[j], 0).Count == 1 && Matches(ways[j], 0)[0] == e);
                    if (!singled) { refused[from.Key] = hits.Count; Trace("held back: " + hits.Count + " controls answer to " + from.Key); return false; }
                }
            }
            foreach (string anchor in new[] { l.Inside, l.After }.Where(a => a != null)) { Node box = Find(anchor, depth + 1); if (box != null && !Sole(box, depth + 1)) return false; }
            origin[e] = from;
            soleNow.Add(e);
            return true;
        }

        // ---- a control found by its place ----
        // A menu button found by its place has to open the menu the profile describes for it
        // ("menuSigns": a locator spec one of that menu's rows answers to). Called with the menu open;
        // a menu without such a row is not taken, and the answer says so ("unconfirmed").
        static Dictionary<string, object> MenuSigns()
        {
            object raw;
            if (windowsSpec.TryGetValue("menuSigns", out raw) && raw is Dictionary<string, object>) return (Dictionary<string, object>)raw;
            return profile.TryGetValue("menuSigns", out raw) && raw is Dictionary<string, object> ? (Dictionary<string, object>)raw : new Dictionary<string, object>();
        }
        static bool Confirmed(Node button)
        {
            KeyValuePair<string, int> from; List<Loc> ways; object spec;
            if (!origin.TryGetValue(button, out from) || !locators.TryGetValue(from.Key, out ways) || from.Value >= ways.Count || !ways[from.Value].Placed || !MenuSigns().TryGetValue(from.Key, out spec)) return true;
            List<Loc> signs = LocatorList(from.Key, spec);
            ReadPage();
            bool holds = nodes.Any(row => RoleIs(row, "AXMenuItem") && signs.Any(sign => Fits(row, sign)));
            if (!holds) { unconfirmed.Add(from.Key); Trace("the menu " + from.Key + " opened is not the one the profile describes"); }
            return holds;
        }

        // ---- what the answer says about its footing ----
        static void Annotate(Dictionary<string, object> answer)
        {
            if (!new[] { "warm", "probe", "inspect", "check" }.Contains(command))
            {
                Dictionary<string, object> other = new Dictionary<string, object>();
                foreach (KeyValuePair<string, int> kv in via) { List<Loc> ways; if (kv.Value > 0 && locators.TryGetValue(kv.Key, out ways) && kv.Value < ways.Count) other[kv.Key] = ways[kv.Value].Kind; }
                if (other.Count > 0) answer["via"] = other;
            }
            object okValue; bool failed = answer.TryGetValue("ok", out okValue) && okValue is bool && !(bool)okValue;
            Action<string, string> because = (code, message) => { if (failed) { object step; if (answer.TryGetValue("code", out step)) answer["step"] = step; answer["code"] = code; answer["error"] = message; } };
            if (refused.Count > 0)
            {
                KeyValuePair<string, int> first = refused.OrderBy(kv => kv.Key, StringComparer.Ordinal).First();
                answer["ambiguous"] = refused.ToDictionary(kv => kv.Key, kv => (object)kv.Value);
                because("ambiguous", appName + "的页面上有 " + first.Value + " 个控件都对得上「" + first.Key + "」，分不清该动哪一个，所以没有动手（桌面版可能改过界面，这个控件的认法要更新）");
            }
            else if (unconfirmed.Count > 0)
            {
                answer["unconfirmed"] = unconfirmed;
                because("unconfirmed", appName + "里按位置找到的「" + unconfirmed[0] + "」打开的不是预期的菜单，所以什么都没有选（桌面版可能改过界面，这个控件的认法要更新）");
            }
        }

        // ---- does the profile still match the desktop? ----
        // ax-driver.swift's profileCheck: found / ways / differ / drift / several, the same fields.
        static Dictionary<string, object> ProfileCheck()
        {
            Dictionary<string, object> found = new Dictionary<string, object>(), waysOut = new Dictionary<string, object>(), several = new Dictionary<string, object>();
            List<string> differ = new List<string>(), drift = new List<string>();
            foreach (string key in locators.Keys.OrderBy(k => k, StringComparer.Ordinal))
            {
                List<Loc> list = locators[key];
                List<List<Node>> each = list.Select(l => Matches(l, 0)).ToList();
                int at = each.FindIndex(h => h.Count > 0);
                found[key] = at >= 0 ? each[at].Count : 0;
                if (at >= 0 && !list[at].Placed && each[at].Count > 1)
                {
                    bool singled = Enumerable.Range(0, list.Count).Any(j => j != at && !list[j].Placed && each[j].Count == 1 && each[j][0] == each[at][0]);
                    if (!singled) several[key] = each[at].Count;
                }
                if (each.Count < 2) continue;
                waysOut[key] = each.Select(h => (object)h.Count).ToList();
                List<Node> firsts = each.Where(h => h.Count > 0).Select(h => h[0]).ToList();
                if (firsts.Count > 1 && firsts.Any(f => f != firsts[0])) differ.Add(key);
                if (at > 0)
                {
                    Node hit = each[at][0];
                    bool lost = Enumerable.Range(0, at).Any(j =>
                    {
                        Loc way = list[j];
                        if (way.Kind != "mark" || (way.Role != null && !RoleIs(hit, way.Role)) || (way.Roles.Count > 0 && !way.Roles.Any(r => RoleIs(hit, r)))) return false;
                        if (way.Inside == null) return true;
                        Node box = Find(way.Inside); return box != null && hit.Index > box.Index && hit.Index <= box.End;
                    });
                    if (lost) drift.Add(key);
                }
            }
            return new Dictionary<string, object> { { "found", found }, { "ways", waysOut }, { "differ", differ }, { "drift", drift }, { "several", several } };
        }
        // Which conversation is on screen: the page's title, as ax-driver.swift's current() reads it.
        static string modeTitleSuffix;   // the mode a command acts in may name its pages its own way (spaces.titleSuffix)
        static string Current()
        {
            string suffix = modeTitleSuffix ?? Setting("titleSuffix");
            List<string> blank = Settings("blankTitles");
            ReadPage();
            foreach (Node page in nodes.Where(n => n.ControlType == CT_Document))
            {
                string title = page.Name;
                if (suffix.Length > 0) { if (title.EndsWith(suffix, StringComparison.Ordinal)) return title.Substring(0, title.Length - suffix.Length); continue; }
                return blank.Contains(title) ? "" : title;
            }
            return "";
        }
        // What a control goes by besides its name (inspect).
        static Dictionary<string, object> Facts(Node n)
        {
            Dictionary<string, object> f = new Dictionary<string, object> { { "role", ControlTypeNames.ContainsKey(n.ControlType) ? ControlTypeNames[n.ControlType] : n.ControlType.ToString(CultureInfo.InvariantCulture) } };
            if (n.AriaRole.Length > 0) f["ariaRole"] = n.AriaRole;
            if (n.Name.Length > 0) f["name"] = n.Name.Length > 80 ? n.Name.Substring(0, 80) : n.Name;
            if (n.AutomationId.Length > 0) f["id"] = n.AutomationId;
            if (n.ClassName.Length > 0) f["class"] = n.Classes;
            if (n.Accel.Length > 0) f["keys"] = n.Accel;
            return f;
        }

        // ---- actions ----
        // Anything done to the page ends what was read from it (Stale). Nothing is done to a control
        // that is not the only one its locator finds (Sole). Each action that can make the page take the
        // foreground waits first for a parked page to be live and for the person to finish a word (BeforeAct).
        static T Pattern<T>(Node n, int id) where T : class { try { return n.Element.GetCurrentPattern(id) as T; } catch { return null; } }
        static bool Press(Node n)
        {
            if (n == null || !Sole(n)) return false;
            BeforeAct();
            Trace("press " + (n.Name.Length > 40 ? n.Name.Substring(0, 40) : n.Name));
            try
            {
                IUIAutomationInvokePattern invoke = Pattern<IUIAutomationInvokePattern>(n, Pat_Invoke);
                if (invoke != null) { invoke.Invoke(); return true; }
                IUIAutomationExpandCollapsePattern ec = Pattern<IUIAutomationExpandCollapsePattern>(n, Pat_Expand);
                if (ec != null) { ec.Expand(); return true; }
                return false;
            }
            catch (Exception e) { Trace("press failed: " + e.Message); return false; }
            finally { Stale(); }
        }
        static bool Expand(Node n)
        {
            if (n == null || !Sole(n)) return false;
            BeforeAct();
            try { IUIAutomationExpandCollapsePattern ec = Pattern<IUIAutomationExpandCollapsePattern>(n, Pat_Expand); if (ec == null) return false; ec.Expand(); return true; }
            catch (Exception e) { Trace("expand failed: " + e.Message); return false; }
            finally { Stale(); }
        }
        static bool Collapse(Node n)
        {
            if (n == null) return false;
            BeforeAct();
            try { IUIAutomationExpandCollapsePattern ec = Pattern<IUIAutomationExpandCollapsePattern>(n, Pat_Expand); if (ec == null) return false; ec.Collapse(); return true; }
            catch { return false; }
            finally { Stale(); }
        }
        static bool SetValue(Node n, string text)
        {
            if (n == null || !Sole(n)) return false;
            BeforeAct();
            try { IUIAutomationValuePattern v = Pattern<IUIAutomationValuePattern>(n, Pat_Value); if (v == null) return false; v.SetValue(text); return true; }
            catch (Exception e) { Trace("set value failed: " + e.Message); return false; }
            finally { Stale(); }
        }
        static void Wait(double seconds) { Thread.Sleep((int)(seconds * 1000)); Stale(); }
        // Looks again until `done` holds or `seconds` have passed (a look is one read of the page).
        static bool Until(double seconds, Func<bool> done)
        {
            DateTime end = ActClock.AddSeconds(seconds);
            while (true) { Stale(); if (done()) return true; if (ActClock >= end) return false; Thread.Sleep(40); }
        }
        static bool Named(Node n, string text) { return n.Name == text || n.Name.StartsWith(text + " ", StringComparison.Ordinal); }
        static List<Node> Items() { ReadPage(); return nodes.Where(n => RoleIs(n, "AXMenuItem")).ToList(); }
        static Node Item(string text) { return Items().FirstOrDefault(n => Named(n, text)); }
        static int Menus() { ReadPage(); return nodes.Count(n => n.ControlType == CT_Menu || n.AriaRole == "menu"); }
        static bool Expanded(Node n) { return n != null && (n.ExpandState == 1 || n.ExpandState == 2 || Regex.IsMatch(n.AriaProps, @"(^|;)\s*expanded=true", RegexOptions.IgnoreCase)); }
        static bool Checked(Node n) { return n.ToggleState == 1 || Regex.IsMatch(n.AriaProps, @"(^|;)\s*(checked|selected|pressed)=(true|mixed)", RegexOptions.IgnoreCase); }
        // A row or toggle that has a checked state at all (rows that open something else have none, like
        // Claude's "Open folder…", which opens a folder picker). By what the page says (ARIA checked or
        // pressed) or by being a checkbox or radio: UIA reports a toggle state (2, indeterminate) for every
        // menu row, the ones without a check too.
        static bool HasCheckState(Node n) { return n.ControlType == CT_CheckBox || n.ControlType == CT_RadioButton || Regex.IsMatch(n.AriaProps, @"(^|;)\s*(checked|pressed)=", RegexOptions.IgnoreCase); }
        // Whatever the control offers: Invoke, Toggle, SelectionItem, ExpandCollapse (a checkbox or radio
        // may offer only some of them).
        static bool Activate(Node n)
        {
            if (n == null || !Sole(n)) return false;
            BeforeAct();
            try
            {
                IUIAutomationInvokePattern invoke = Pattern<IUIAutomationInvokePattern>(n, Pat_Invoke);
                if (invoke != null) { invoke.Invoke(); return true; }
                IUIAutomationTogglePattern toggle = Pattern<IUIAutomationTogglePattern>(n, Pat_Toggle);
                if (toggle != null) { toggle.Toggle(); return true; }
                IUIAutomationSelectionItemPattern select = Pattern<IUIAutomationSelectionItemPattern>(n, Pat_SelItem);
                if (select != null) { select.Select(); return true; }
                IUIAutomationExpandCollapsePattern ec = Pattern<IUIAutomationExpandCollapsePattern>(n, Pat_Expand);
                if (ec != null) { ec.Expand(); return true; }
                return false;
            }
            catch (Exception e) { Trace("activate failed: " + e.Message); return false; }
            finally { Stale(); }
        }
        static bool Toggle(Node n)
        {
            if (n == null || !Sole(n)) return false;
            BeforeAct();
            try { IUIAutomationTogglePattern t = Pattern<IUIAutomationTogglePattern>(n, Pat_Toggle); if (t != null) { t.Toggle(); return true; } } catch { }
            finally { Stale(); }
            return Activate(n);
        }
        static void ScrollIntoView(IUIAutomationElement e)
        {
            BeforeAct();
            try { IUIAutomationScrollItemPattern s = e.GetCurrentPattern(Pat_ScrollItem) as IUIAutomationScrollItemPattern; if (s != null) s.ScrollIntoView(); } catch { }
            Stale();
        }
        // A question the desktop puts over the page (the Mac's AXApplicationAlertDialog). Chromium on Windows
        // reports an alertdialog as a dialog window whose ARIA role reads "alert" (measured: Claude's "Switch
        // model?" is ControlType Window, AriaRole "alert", IsDialog true), so either is taken.
        static Node Dialog() { ReadPage(); return nodes.FirstOrDefault(n => n.AriaRole == "alertdialog" || (n.IsDialog && n.AriaRole == "alert")); }
        // A menu button says what it shows after what it is: "Model: Opus 5.5 High".
        static string AfterColon(string text)
        {
            int at = -1; foreach (string colon in new[] { ": ", "：" }) { int i = text.IndexOf(colon, StringComparison.Ordinal); if (i >= 0 && (at < 0 || i < at)) at = i; }
            if (at < 0) return text;
            return text.Substring(at + (text[at] == '：' ? 1 : 2)).Trim();
        }

        // ==== the window: parked, put back, brought forward ====
        // The only code that moves a window, changes the z-order or hands the foreground anywhere
        // (test/platform.test.ts checks that no other code, and no engine's flow, does). Every engine's
        // flow acts through it: Begin(park), HoldForeground, Activate(), BringForward.
        //
        // ---- parked in a corner (probes/windows/PLAN.md, "Parked in a corner") ----
        // Chromium stops updating a window that is fully covered, and on Windows nothing reaches its
        // page without the page taking the foreground for a moment. So while a flow acts, the window is
        // moved off the screen but for a few pixels of one corner (a page with a pixel showing stays
        // live), a watchdog gives the foreground straight back to the window the person was in and keeps
        // that corner uncovered, and afterwards everything is put back exactly: placement (maximized or
        // not, and the normal bounds), the z-order under the same window, the foreground.
        // A menu needs the foreground while it is open (given back, its rows stop answering), so a flow
        // holds it for the time a menu change takes (HoldForeground), and the watchdog gives it back after.
        // The window is not parked when it is the foreground window itself (the person is in it).
        const uint SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOZORDER = 0x4, SWP_NOACTIVATE = 0x10;
        static class Parking
        {
            public static bool Active, Front;
            public static string Skipped;
            // Original: the window the person is in, given the foreground back whenever the app takes it.
            // It starts as the foreground window at park time and follows the person when they move to
            // another one while parked (Followed counts those moves). Home: the monitor the window is on.
            public static IntPtr Original, InsertAfter, Home;
            public static int Followed;
            public static Win.WINDOWPLACEMENT Placement;
            public static Win.POINT Corner;
            public static bool MaxMoved; public static Native.RECT MaxRect;
            public static DateTime Began;
            public static volatile bool Stop, KeepCorner, Held;
            public static Thread Guard;
            public static int Grabs, GiveBacks, Failed, ReRaises; public static long LongestGrabMs, HeldMs;
            // SettledMs and PersonMs: how long actions waited for the page to be shown again and for the person
            // to finish a word (BeforeAct); NotLive: actions that went ahead on a page still stopped.
            public static long SettledMs, PersonMs; public static int NotLive;
            public static readonly object Lock = new object();
        }
        static string Hex(IntPtr h) { return "0x" + h.ToInt64().ToString("x", CultureInfo.InvariantCulture); }
        static bool IsOurs(IntPtr h)
        {
            if (h == IntPtr.Zero) return false;
            uint pid, own; Native.GetWindowThreadProcessId(h, out pid); Native.GetWindowThreadProcessId(window, out own);
            return pid == own;
        }
        static bool Topmost(IntPtr h) { return (Win.GetWindowLong(h, -20) & 0x8) != 0; }
        static IntPtr Root(IntPtr h) { IntPtr r = Win.GetAncestor(h, 2); return r == IntPtr.Zero ? h : r; }
        // The nearest window above ours that the person can see and that is not the app's own: the one to put it back under.
        static IntPtr AboveVisible(IntPtr h)
        {
            IntPtr p = Win.GetWindow(h, 3);
            while (p != IntPtr.Zero && (!Native.IsWindowVisible(p) || Cloaked(p) || Topmost(p) || IsOurs(p))) p = Win.GetWindow(p, 3);
            return p;
        }
        static Win.WINDOWPLACEMENT PlacementOf(IntPtr h) { Win.WINDOWPLACEMENT wp = new Win.WINDOWPLACEMENT(); wp.length = Marshal.SizeOf(typeof(Win.WINDOWPLACEMENT)); Win.GetWindowPlacement(h, ref wp); return wp; }
        static bool CornerUp() { return Root(Win.WindowFromPoint(Parking.Corner)) == window; }
        // Raised without being activated: HWND_TOP from a background process usually leaves it under the
        // foreground window, so through the topmost band and back, which leaves it on top of the ordinary
        // windows. Then nudged (Nudge), so the page shows again at once.
        static bool RaiseCorner()
        {
            Win.SetWindowPos(window, IntPtr.Zero, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            if (!CornerUp())
            {
                Win.SetWindowPos(window, new IntPtr(-1), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
                Win.SetWindowPos(window, new IntPtr(-2), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            }
            Nudge();
            return CornerUp();
        }
        // Chromium stops a page whose window it counts as covered (it takes no press, its tree does not
        // change) and counts again on some window events only. A move is one, a change of z-order made by
        // another process is not: raised into its corner, Claude's page came back 0.85 to more than 4 s
        // later, and a press before that was lost; moved a pixel and back, within 0.1 s (measured,
        // probes/windows/PLAN.md "The page is stopped while Chromium counts it covered"). Whether it is back
        // shows in the window Chromium keeps for its page (PageLive).
        static void Nudge()
        {
            Native.RECT r; Native.GetWindowRect(window, out r);
            Win.SetWindowPos(window, IntPtr.Zero, r.Left + 1, r.Top, 0, 0, SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOZORDER);
            Win.SetWindowPos(window, IntPtr.Zero, r.Left, r.Top, 0, 0, SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOZORDER);
        }
        [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, Native.EnumProc proc, IntPtr lParam);
        // The page is shown: Chromium's window for it (Chrome_RenderWidgetHostHWND, a child of the app's
        // window) exists and is visible. It is not there while Chromium has the page stopped.
        static bool PageLive()
        {
            bool live = false;
            EnumChildWindows(window, delegate (IntPtr h, IntPtr l)
            {
                if (Native.IsWindowVisible(h) && ClassOf(h).StartsWith("Chrome_RenderWidgetHostHWND", StringComparison.Ordinal)) { live = true; return false; }
                return true;
            }, IntPtr.Zero);
            return live;
        }
        // The foreground back to `to`, with no input: attached to the foreground thread first; then to
        // both threads with BringWindowToTop; then SwitchToThisWindow (each seen to be needed once).
        static bool GiveBack(IntPtr to)
        {
            if (to == IntPtr.Zero) return true;
            IntPtr fg = Win.GetForegroundWindow(); uint pid, fgThread = Native.GetWindowThreadProcessId(fg, out pid), me = Win.GetCurrentThreadId(), toThread = Native.GetWindowThreadProcessId(to, out pid);
            bool a = fgThread != 0 && fgThread != me && Win.AttachThreadInput(me, fgThread, true);
            Win.SetForegroundWindow(to);
            if (a) Win.AttachThreadInput(me, fgThread, false);
            if (Win.GetForegroundWindow() == to) return true;
            bool a1 = fgThread != 0 && fgThread != me && Win.AttachThreadInput(me, fgThread, true), a2 = toThread != 0 && toThread != me && toThread != fgThread && Win.AttachThreadInput(me, toThread, true);
            Win.BringWindowToTop(to); Win.SetForegroundWindow(to);
            if (a2) Win.AttachThreadInput(me, toThread, false); if (a1) Win.AttachThreadInput(me, fgThread, false);
            if (Win.GetForegroundWindow() == to) return true;
            Win.SwitchToThisWindow(to, true);
            return Win.GetForegroundWindow() == to;
        }
        // A window the person moved to while parked, to be given the foreground from then on: not the
        // app's own, and not the shell's passing ones (the taskbar, Alt+Tab, Task View), which hold the
        // foreground only on the way to another window.
        static readonly string[] Passing = { "Shell_TrayWnd", "Shell_SecondaryTrayWnd", "XamlExplorerHostIslandWindow", "MultitaskingViewFrame", "TaskSwitcherWnd", "ForegroundStaging" };
        static bool Followable(IntPtr h)
        {
            if (h == IntPtr.Zero || h == Parking.Original || IsOurs(h) || !Native.IsWindowVisible(h)) return false;
            return Array.IndexOf(Passing, ClassOf(Root(h))) < 0;
        }
        static void Watchdog()
        {
            Stopwatch grab = null, held = null;
            while (!Parking.Stop)
            {
                IntPtr fg = Win.GetForegroundWindow();
                if (Followable(fg)) { lock (Parking.Lock) { Parking.Original = fg; Parking.Followed++; } Trace("followed the person to " + Hex(fg)); }
                bool ours = fg != Parking.Original && IsOurs(fg);
                if (ours && Parking.Held) { if (held == null) held = Stopwatch.StartNew(); }
                else if (held != null) { lock (Parking.Lock) Parking.HeldMs += held.ElapsedMilliseconds; held = null; }
                if (ours && !Parking.Held)
                {
                    if (grab == null) { grab = Stopwatch.StartNew(); lock (Parking.Lock) Parking.Grabs++; }
                    bool back = GiveBack(Parking.Original);
                    lock (Parking.Lock) { Parking.GiveBacks++; if (!back) Parking.Failed++; }
                }
                else if (grab != null) { lock (Parking.Lock) Parking.LongestGrabMs = Math.Max(Parking.LongestGrabMs, grab.ElapsedMilliseconds); grab = null; }
                if (Parking.KeepCorner && !CornerUp()) { RaiseCorner(); lock (Parking.Lock) Parking.ReRaises++; }
                Thread.Sleep(10);
            }
            if (held != null) lock (Parking.Lock) Parking.HeldMs += held.ElapsedMilliseconds;
        }
        // While a menu is open the page needs the foreground (on: the watchdog leaves it to the app;
        // off: it is given back at once).
        static void HoldForeground(bool on) { if (Parking.Active) { if (on && !Parking.Held) BeforeAct(); Parking.Held = on; } }
        // Before an action that can make a parked page take the foreground (Press, SetValue, Expand…):
        // - The page has to be shown (PageLive). A press on a page Chromium has stopped is lost, and only the
        //   retry seconds later is taken: a second grab, and the seconds (measured, probes/windows/PLAN.md
        //   "Live before the first press"). The corner is nudged whenever it is raised (RaiseCorner), so the
        //   page is usually back within a tenth of a second; an action that finds it stopped nudges it again
        //   and waits for it, at most the profile's windows.settleMs (default 2500), then acts anyway.
        // - Each grab takes the foreground from the person's window for a moment, and a browser that loses
        //   it ends the word an input method is composing (the pinyin typed so far is dropped); while the app
        //   holds the foreground (a menu open) the keys the person types go to its page, and a page redrawn
        //   under them lost the menu button (UIA_E_ELEMENTNOTAVAILABLE, measured: the person typed on through
        //   a model and effort change). The console's page says while the person is typing (POST /api/typing
        //   writes the time until which they are into "person-typing" next to the helper: a word being
        //   composed, or until a pause in keys), and each action, and the start of a hold, waits until they
        //   are not: up to 3 s for one action and 10 s for a command, so a person who never stops typing
        //   still gets the message sent.
        // Neither applies while the app holds the foreground (a menu is open) or when nothing is parked.
        static readonly string TypingFile = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "person-typing");
        static int SettleMs()
        {
            object v; int ms;
            return windowsSpec.TryGetValue("settleMs", out v) && v != null && int.TryParse(Convert.ToString(v, CultureInfo.InvariantCulture), out ms) && ms >= 0 ? ms : 2500;
        }
        static long TypingUntil()
        {
            try { long until; return File.Exists(TypingFile) && long.TryParse(File.ReadAllText(TypingFile).Trim(), out until) ? until : 0; } catch { return 0; }
        }
        // The clock every deadline outside this section is kept by (Until, Put, Fill, WaitReady, menus…): the
        // time since the command began, less what BeforeAct waited. A wait for the page or for the person
        // is not time the page had to answer, and counted against a fill's few seconds it failed the fill
        // (measured: a send while the person kept typing waited 3 s for them, and the fill had no time left).
        static DateTime ActClock { get { return DateTime.UtcNow.AddMilliseconds(-(Parking.SettledMs + Parking.PersonMs)); } }
        static long NowMs() { return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds; }
        static void BeforeAct()
        {
            if (!Parking.Active || Parking.Held) return;
            Stopwatch waited = null;
            while (TypingUntil() > NowMs())
            {
                if (waited == null) { waited = Stopwatch.StartNew(); Trace("the person is typing: waiting"); }
                if (waited.ElapsedMilliseconds >= 3000 || Parking.PersonMs + waited.ElapsedMilliseconds >= 10000) break;
                Thread.Sleep(40);
            }
            if (waited != null) { lock (Parking.Lock) Parking.PersonMs += waited.ElapsedMilliseconds; Trace("waited " + waited.ElapsedMilliseconds + "ms for the person"); Stale(); }
            // Then the page, right before the action (a wait for the person may have let it be covered again).
            if (PageLive()) return;
            Stopwatch shown = Stopwatch.StartNew();
            Nudge();
            while (!PageLive() && shown.ElapsedMilliseconds < SettleMs()) Thread.Sleep(20);
            bool live = PageLive();
            lock (Parking.Lock) { Parking.SettledMs += shown.ElapsedMilliseconds; if (!live) Parking.NotLive++; }
            Trace((live ? "page shown again after " : "page still stopped after ") + shown.ElapsedMilliseconds + "ms");
            Stale();
        }
        // The app's window takes the foreground (parked off screen, nothing of it shows) for the presses its
        // page takes only while the window is active: a chat card's controls (measured on Claude's question
        // card: from behind a press only moves the focus, and pressing again after the foreground was given
        // back does not help; with the window active first, one press picks, one press submits). The caller
        // holds the foreground (HoldForeground) for as long as those presses take.
        static void Activate()
        {
            if (Root(Win.GetForegroundWindow()) == window) return;
            GiveBack(window);
            Until(0.3, () => Root(Win.GetForegroundWindow()) == window);
            Thread.Sleep(80);
            Trace("activated: " + (Root(Win.GetForegroundWindow()) == window));
        }
        // Where the corner goes: a corner of a monitor's work area from which the rest of the window lies
        // outside every monitor (the top left, with the taskbar at the bottom). The window's own monitor
        // is tried first, then the others at its scale (primary first), then the rest: moved to a monitor
        // at another scale, the page would get a DPI change, lay out again and may be resized.
        static uint DpiOf(IntPtr m) { uint x, y; try { if (Win.GetDpiForMonitor(m, 0, out x, out y) == 0) return x; } catch { } return 0; }
        static bool CornerFor(int width, int height, int keep, out Native.RECT frame, out Win.POINT probe)
        {
            List<KeyValuePair<IntPtr, Win.MONITORINFO>> found = new List<KeyValuePair<IntPtr, Win.MONITORINFO>>();
            Win.EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate (IntPtr m, IntPtr dc, ref Native.RECT r, IntPtr d)
            {
                Win.MONITORINFO mi = new Win.MONITORINFO(); mi.cbSize = Marshal.SizeOf(typeof(Win.MONITORINFO));
                if (Win.GetMonitorInfo(m, ref mi)) found.Add(new KeyValuePair<IntPtr, Win.MONITORINFO>(m, mi));
                return true;
            }, IntPtr.Zero);
            uint homeDpi = DpiOf(Parking.Home);
            List<Win.MONITORINFO> monitors = found
                .OrderBy(p => p.Key == Parking.Home ? 0 : DpiOf(p.Key) == homeDpi ? 1 : 2)
                .ThenBy(p => (p.Value.dwFlags & 1) != 0 ? 0 : 1)
                .Select(p => p.Value).ToList();
            foreach (Win.MONITORINFO mi in monitors)
            {
                Native.RECT w = mi.rcWork;
                // (x, y) of the corner pixel area's top left, and which way the window extends from it.
                int[][] corners = { new[] { w.Left, w.Top, -1, -1 }, new[] { w.Right - keep, w.Top, 1, -1 }, new[] { w.Left, w.Bottom - keep, -1, 1 }, new[] { w.Right - keep, w.Bottom - keep, 1, 1 } };
                foreach (int[] c in corners)
                {
                    Native.RECT f;
                    f.Left = c[2] < 0 ? c[0] + keep - width : c[0]; f.Right = f.Left + width;
                    f.Top = c[3] < 0 ? c[1] + keep - height : c[1]; f.Bottom = f.Top + height;
                    Native.RECT kept; kept.Left = c[0]; kept.Top = c[1]; kept.Right = c[0] + keep; kept.Bottom = c[1] + keep;
                    bool clear = monitors.All(other =>
                    {
                        Native.RECT o = other.rcMonitor;
                        int l = Math.Max(f.Left, o.Left), t = Math.Max(f.Top, o.Top), r = Math.Min(f.Right, o.Right), b = Math.Min(f.Bottom, o.Bottom);
                        if (l >= r || t >= b) return true;
                        return l >= kept.Left && t >= kept.Top && r <= kept.Right && b <= kept.Bottom;
                    });
                    if (!clear) continue;
                    frame = f; probe.X = c[0] + keep / 2; probe.Y = c[1] + keep / 2;
                    return true;
                }
            }
            frame = new Native.RECT(); probe = new Win.POINT();
            return false;
        }
        // ---- a park that outlives its helper ----
        // The server kills a helper that runs past its timeout, and a killed process runs no `finally`:
        // its window would stay off screen. So before the window moves, how to put it back is written to
        // parked\<window>.json next to the helper (the shared cache), and removed once it is back. Every
        // helper start, of any engine (the warm read comes every ten seconds while the console is in use),
        // puts back a window whose record no live park owns (Recover), and the server runs `restore` right
        // after a helper it had to stop.
        // One park at a time on the machine (Claude's and Codex's helpers, or two servers): two watchdogs
        // would hand the foreground back and forth. The lock is a named mutex; a helper that ended while
        // parked leaves it abandoned, and the next one takes it and recovers what it left.
        static Mutex parkLock;
        static bool parkLockHeld;
        static string ParkDir { get { return Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "parked"); } }
        static string RecordOf(IntPtr h) { return Path.Combine(ParkDir, Hex(h) + ".json"); }
        static bool TakeParkLock(int waitMs)
        {
            if (parkLockHeld) return true;
            if (parkLock == null) parkLock = new Mutex(false, @"Local\agent-frontdesk-park");
            try { parkLockHeld = parkLock.WaitOne(waitMs); }
            catch (AbandonedMutexException) { parkLockHeld = true; Trace("took the park lock from a helper that ended while parked"); }
            return parkLockHeld;
        }
        static void DropParkLock() { if (!parkLockHeld) return; parkLockHeld = false; try { parkLock.ReleaseMutex(); } catch { } }
        static uint PidOf(IntPtr h) { uint pid = 0; if (h != IntPtr.Zero) Native.GetWindowThreadProcessId(h, out pid); return pid; }
        static int[] Four(Native.RECT r) { return new[] { r.Left, r.Top, r.Right, r.Bottom }; }
        static Native.RECT RectOf(object value) { object[] v = (object[])value; Native.RECT r; r.Left = Convert.ToInt32(v[0]); r.Top = Convert.ToInt32(v[1]); r.Right = Convert.ToInt32(v[2]); r.Bottom = Convert.ToInt32(v[3]); return r; }
        static void WriteRecord()
        {
            try
            {
                Directory.CreateDirectory(ParkDir);
                Win.WINDOWPLACEMENT p = Parking.Placement;
                Dictionary<string, object> record = new Dictionary<string, object> {
                    { "window", window.ToInt64() }, { "pid", (long)PidOf(window) }, { "helper", (long)Process.GetCurrentProcess().Id }, { "began", Parking.Began.ToString("o", CultureInfo.InvariantCulture) },
                    { "flags", p.flags }, { "showCmd", p.showCmd }, { "ptMin", new[] { p.ptMin.X, p.ptMin.Y } }, { "ptMax", new[] { p.ptMax.X, p.ptMax.Y } }, { "normal", Four(p.rcNormal) },
                    { "maxMoved", Parking.MaxMoved }, { "maxRect", Four(Parking.MaxRect) }, { "insertAfter", Parking.InsertAfter.ToInt64() }, { "original", Parking.Original.ToInt64() } };
                string file = RecordOf(window), tmp = file + ".tmp";
                File.WriteAllText(tmp, new JavaScriptSerializer().Serialize(record));
                if (File.Exists(file)) File.Delete(file);
                File.Move(tmp, file);
            }
            catch (Exception e) { Trace("park record not written: " + e.Message); }
        }
        // Puts back the windows that helpers which ended while parked left off screen; how many.
        static int Recover()
        {
            string[] files;
            try { files = Directory.Exists(ParkDir) ? Directory.GetFiles(ParkDir, "*.json") : new string[0]; } catch { return 0; }
            if (files.Length == 0) return 0;
            bool had = parkLockHeld;
            if (!TakeParkLock(0)) return 0;   // a live park: its own helper puts its window back
            try { return files.Count(PutBack); }
            finally { if (!had) DropParkLock(); }
        }
        static bool PutBack(string file)
        {
            bool done = false;
            try
            {
                Dictionary<string, object> r = new JavaScriptSerializer().DeserializeObject(File.ReadAllText(file)) as Dictionary<string, object>;
                IntPtr h = r == null ? IntPtr.Zero : new IntPtr(Convert.ToInt64(r["window"], CultureInfo.InvariantCulture));
                uint pid = r == null ? 0 : Convert.ToUInt32(r["pid"], CultureInfo.InvariantCulture);
                // The same window of the same process (a handle is reused only once the window is gone).
                if (h != IntPtr.Zero && Win.IsWindow(h) && PidOf(h) == pid)
                {
                    Win.WINDOWPLACEMENT was = PlacementOf(h);
                    was.flags = Convert.ToInt32(r["flags"]); was.showCmd = Convert.ToInt32(r["showCmd"]);
                    object[] min = (object[])r["ptMin"], max = (object[])r["ptMax"];
                    was.ptMin.X = Convert.ToInt32(min[0]); was.ptMin.Y = Convert.ToInt32(min[1]); was.ptMax.X = Convert.ToInt32(max[0]); was.ptMax.Y = Convert.ToInt32(max[1]);
                    was.rcNormal = RectOf(r["normal"]);
                    IntPtr after = new IntPtr(Convert.ToInt64(r["insertAfter"], CultureInfo.InvariantCulture)), original = new IntPtr(Convert.ToInt64(r["original"], CultureInfo.InvariantCulture));
                    if (after != IntPtr.Zero && !Win.IsWindow(after)) after = IntPtr.Zero;
                    if (original != IntPtr.Zero && !(Win.IsWindow(original) && Native.IsWindowVisible(original))) original = IntPtr.Zero;
                    PutWindowBack(h, pid, was, (bool)r["maxMoved"], RectOf(r["maxRect"]), after, original);
                    Trace("put back " + Hex(h) + ", left off screen by helper " + r["helper"]);
                    done = true;
                }
            }
            catch (Exception e) { Trace("park record unreadable: " + e.Message); }
            try { File.Delete(file); } catch { }
            return done;
        }
        // Everything back as it was found: foreground first (a window that holds it would be put on top
        // by a maximize), then the z-order while it is still off screen, the placement, the z-order again,
        // the foreground; and the taskbar button's flash a refused grab leaves is stopped. The foreground
        // is only taken back from the app (or from nothing): a window the person went to stays in front.
        static void PutWindowBack(IntPtr h, uint pid, Win.WINDOWPLACEMENT was, bool maxMoved, Native.RECT maxRect, IntPtr insertAfter, IntPtr original)
        {
            Func<IntPtr, bool> app = w => w != IntPtr.Zero && PidOf(w) == pid;
            for (int i = 0; i < 60 && original != IntPtr.Zero && app(Win.GetForegroundWindow()) && Win.GetForegroundWindow() != original; i++) { if (GiveBack(original)) break; Thread.Sleep(15); }
            if (was.showCmd != 2) Win.SetWindowPos(h, insertAfter, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            Win.WINDOWPLACEMENT back = was;
            if (back.showCmd == 1) back.showCmd = 4;   // normal, without activating it
            if (back.showCmd == 2) back.showCmd = 7;   // minimized, without activating anything
            // A maximized one is moved back where it was (it never stopped being maximized).
            if (maxMoved) Win.SetWindowPos(h, IntPtr.Zero, maxRect.Left, maxRect.Top, 0, 0, SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOZORDER);
            else Win.SetWindowPlacement(h, ref back);
            if (back.showCmd != 7) Win.SetWindowPos(h, insertAfter, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            IntPtr last = Win.GetForegroundWindow();
            if (original != IntPtr.Zero && last != original && (last == IntPtr.Zero || app(last))) GiveBack(original);
            Win.FLASHWINFO fi = new Win.FLASHWINFO(); fi.cbSize = Marshal.SizeOf(typeof(Win.FLASHWINFO)); fi.hwnd = h; Win.FlashWindowEx(ref fi);
            int on = 0; Win.DwmSetWindowAttribute(h, 3, ref on, 4);
        }

        // Whether the program in front runs exclusive full screen (a game, Windows' own QUNS_RUNNING_D3D_FULL_SCREEN,
        // which it uses to hold back notifications). Each grab of the foreground a park causes would take the
        // foreground from it, which such a program takes as being switched away from: it goes black, changes
        // mode and is often minimized, and a give-back does not restore a minimized window. So a command that
        // would park does nothing then and says so ("fullscreen"); the console waits and tries again (the
        // Claude bridge, sendViaDesktop). A borderless full-screen window, or one that leaves the taskbar in
        // view, is not this: a grab costs it a moment's stutter, and the command goes ahead. A command already
        // parked when the person goes into a game finishes (a second or two), rather than stop half done.
        [DllImport("shell32.dll")] static extern int SHQueryUserNotificationState(out int state);
        static bool ExclusiveFullscreen() { int state; try { return SHQueryUserNotificationState(out state) == 0 && state == 3; } catch { return false; } }
        // Parks the window for a flow that acts on the page. Returns false (and leaves it as it is) when
        // the person is in the app themselves, or the window cannot be parked (minimized, another desktop).
        // Another park on the machine is waited for; one that does not end in time stops the command.
        static bool Park()
        {
            IntPtr fg = Win.GetForegroundWindow();
            bool minimized = Native.IsIconic(window);
            // The person is in the app: its own window is the one in front (not just some window of its process).
            if (fg != IntPtr.Zero && Root(fg) == window && !minimized) { Parking.Front = true; Parking.Skipped = "front"; return false; }
            FailIfHidden();
            // An exclusive full-screen program in front (a game): nothing is done (ExclusiveFullscreen).
            if (ExclusiveFullscreen()) { Parking.Skipped = "fullscreen"; Fail("fullscreen", "前台的程序独占全屏，工作台没有操作" + appName); }
            // On another virtual desktop: not parked, acted on where it is (measured: probes/windows/PLAN.md).
            if (Cloaked(window)) { Parking.Skipped = "cloaked"; return false; }
            // Not "busy": a flow's "busy" means the chat is running (the Claude bridge then steers).
            if (!TakeParkLock(15000)) { Parking.Skipped = "busy"; Fail("park_busy", "另一个桌面版正在后台操作，稍后再试"); }
            Recover();
            fg = Win.GetForegroundWindow();
            Parking.Placement = PlacementOf(window);
            Parking.Original = fg; Parking.InsertAfter = minimized ? IntPtr.Zero : AboveVisible(window);
            Parking.Home = Win.MonitorFromWindow(window, 2);   // a minimized window: the monitor it comes back on
            Native.RECT rect; Native.GetWindowRect(window, out rect);
            // A maximized window stays maximized and is only moved: its size does not change (the page does
            // not lay out again) and neither do its normal bounds, so the app saves nothing off screen
            // however long the park lasts. (Shown normal at the maximized rect instead, as first built,
            // Claude lost its normal bounds to the maximized ones.) Measured: probes/windows/PLAN.md.
            if (!minimized && Parking.Placement.showCmd == 3) { Parking.MaxMoved = true; Parking.MaxRect = rect; }
            Parking.Began = DateTime.UtcNow;
            WriteRecord();
            int off = 1; Win.DwmSetWindowAttribute(window, 3, ref off, 4);   // DWMWA_TRANSITIONS_FORCEDISABLED: no animation to show
            Parking.Active = true; Parking.Stop = false;
            Parking.Guard = new Thread(Watchdog); Parking.Guard.IsBackground = true; Parking.Guard.Start();
            if (minimized)
            {
                // Shown (not activated) at the size it comes back at: the work area when it restores to
                // maximized (WPF_RESTORETOMAXIMIZED), else its normal bounds; then moved to the corner below.
                Win.MONITORINFO mi = new Win.MONITORINFO(); mi.cbSize = Marshal.SizeOf(typeof(Win.MONITORINFO)); Win.GetMonitorInfo(Parking.Home, ref mi);
                Win.WINDOWPLACEMENT wp = Parking.Placement; wp.showCmd = 4; wp.flags = 0;
                int width = (Parking.Placement.flags & 2) != 0 ? mi.rcWork.Right - mi.rcWork.Left : wp.rcNormal.Right - wp.rcNormal.Left;
                int height = (Parking.Placement.flags & 2) != 0 ? mi.rcWork.Bottom - mi.rcWork.Top : wp.rcNormal.Bottom - wp.rcNormal.Top;
                // Shown straight at the corner (a window placed entirely off screen would be moved back onto
                // a monitor), assuming Windows' usual invisible borders (8 px left, right and bottom); the move
                // below then puts its visible frame exactly there.
                Native.RECT at; Win.POINT unused;
                if (!CornerFor(width - 16, height - 8, 4, out at, out unused)) { Unpark(); Parking.Skipped = "no corner"; return false; }
                int ox = mi.rcWork.Left - mi.rcMonitor.Left, oy = mi.rcWork.Top - mi.rcMonitor.Top;
                wp.rcNormal.Left = at.Left - 8 - ox; wp.rcNormal.Top = at.Top - oy; wp.rcNormal.Right = wp.rcNormal.Left + width; wp.rcNormal.Bottom = wp.rcNormal.Top + height;
                Win.SetWindowPlacement(window, ref wp);
                Native.GetWindowRect(window, out rect);
            }
            Native.RECT ef; if (Win.DwmGetWindowAttribute(window, 9, out ef, 16) != 0) ef = rect;
            Native.RECT frame; Win.POINT probe;
            if (!CornerFor(ef.Right - ef.Left, ef.Bottom - ef.Top, 4, out frame, out probe)) { Unpark(); Parking.Skipped = "no corner"; return false; }
            Parking.Corner = probe;
            // Moved first with the z-order unchanged (still covered), then raised once it is there.
            Win.SetWindowPos(window, IntPtr.Zero, frame.Left - (ef.Left - rect.Left), frame.Top - (ef.Top - rect.Top), 0, 0, SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOZORDER);
            Thread.Sleep(80);
            bool up = RaiseCorner();
            Parking.KeepCorner = true;
            Trace("parked at " + probe.X + "," + probe.Y + (up ? "" : " (corner not raised)"));
            Stale();
            return true;
        }
        // The window back as it was found (PutWindowBack) and the park's report; then (FinishPark) the
        // saved bounds repaired, its record removed and the machine's park lock let go. Also runs when the
        // command fails or crashes. Out puts the window back, writes the answer and only then finishes:
        // the repair of a minimized window's saved bounds takes up to a few seconds (RepairSavedBounds),
        // and the console reads the answer as soon as it is written (desktop-automation.ts, run), so the
        // person is not kept waiting for it. A park that comes meanwhile waits for the park lock.
        static Dictionary<string, object> parkReport;
        static long parkedMs = -1;
        static void Unpark(bool finish = true)
        {
            if (!Parking.Active) { if (finish) FinishPark(); return; }
            Parking.Active = false; Parking.KeepCorner = false; Parking.Held = false;
            Thread.Sleep(30);
            PutWindowBack(window, PidOf(window), Parking.Placement, Parking.MaxMoved, Parking.MaxRect, Parking.InsertAfter, Parking.Original);
            Parking.Stop = true; if (Parking.Guard != null) Parking.Guard.Join(500);
            Win.WINDOWPLACEMENT now = PlacementOf(window), was = Parking.Placement;
            bool same = now.showCmd == was.showCmd && now.rcNormal.Left == was.rcNormal.Left && now.rcNormal.Top == was.rcNormal.Top && now.rcNormal.Right == was.rcNormal.Right && now.rcNormal.Bottom == was.rcNormal.Bottom;
            long ms = (long)(DateTime.UtcNow - Parking.Began).TotalMilliseconds;
            if (Parking.MaxMoved) { Native.RECT r; Native.GetWindowRect(window, out r); same = same && r.Left == Parking.MaxRect.Left && r.Top == Parking.MaxRect.Top && r.Right == Parking.MaxRect.Right && r.Bottom == Parking.MaxRect.Bottom; }
            lock (Parking.Lock) parkReport = new Dictionary<string, object> {
                { "ms", ms }, { "grabs", Parking.Grabs }, { "longestGrabMs", Parking.LongestGrabMs }, { "failedGiveBacks", Parking.Failed }, { "heldMs", Parking.HeldMs },
                // (a minimized window has no place in the visible z-order to go back to)
                { "cornerReRaises", Parking.ReRaises }, { "placementBack", same }, { "underSame", Parking.Placement.showCmd == 2 || AboveVisible(window) == Parking.InsertAfter },
                { "foregroundBack", Win.GetForegroundWindow() == Parking.Original }, { "followed", Parking.Followed },
                { "settledMs", Parking.SettledMs }, { "personMs", Parking.PersonMs }, { "notLive", Parking.NotLive } };
            Trace("put back after " + ms + "ms");
            parkedMs = ms;
            if (finish) FinishPark();
        }
        static void FinishPark()
        {
            if (parkedMs >= 0)
            {
                long ms = parkedMs; parkedMs = -1;
                try { RepairSavedBounds(ms); } catch (Exception e) { Trace("saved bounds not repaired: " + e.Message); }
                try { File.Delete(RecordOf(window)); } catch { }
            }
            DropParkLock();
        }
        // An app that saves its window's bounds (Claude: window-state.json, about 3.3 s after the window
        // settles) saves the parked ones when a park lasts longer than that. A normal window saves its own
        // again once it is back, and a maximized one is only moved (its normal bounds never change); a
        // minimized one is shown normal in the corner, and minimizing it again saves nothing. The
        // profile's windows.windowStateFile names that file; when it holds off-screen bounds after a
        // minimized window was put back, the window is shown normal at its own bounds, behind every
        // other window, until they are saved again, then minimized.
        // Every park of a minimized window is checked, however short: Claude 6.6395 saved the corner's
        // bounds about 1 s after the move, and a 1.1 s park left them off screen (measured; 5.11492 had
        // saved 3.3 s after the window settled).
        static void RepairSavedBounds(long parkedMs)
        {
            if (Parking.Placement.showCmd != 2) return;
            IntPtr under = Parking.InsertAfter != IntPtr.Zero ? Parking.InsertAfter : new IntPtr(1);   // HWND_BOTTOM for a minimized one
            string pattern = Environment.ExpandEnvironmentVariables(Setting("windowStateFile"));
            if (pattern.Length == 0) return;
            string file = null;
            try
            {
                string dir = Path.GetDirectoryName(pattern), parent = Path.GetDirectoryName(dir), leaf = Path.GetFileName(dir);
                if (leaf.Contains("*")) { string[] dirs = Directory.GetDirectories(parent, leaf); if (dirs.Length == 1) file = Path.Combine(dirs[0], Path.GetFileName(pattern)); }
                else file = pattern;
            }
            catch { return; }
            if (file == null) return;
            Func<bool> offScreen = () =>
            {
                try
                {
                    Dictionary<string, object> s = new JavaScriptSerializer().DeserializeObject(File.ReadAllText(file)) as Dictionary<string, object>;
                    if (s == null || !s.ContainsKey("x") || !s.ContainsKey("width")) return false;
                    int x = Convert.ToInt32(s["x"], CultureInfo.InvariantCulture), y = Convert.ToInt32(s["y"], CultureInfo.InvariantCulture);
                    int w = Convert.ToInt32(s["width"], CultureInfo.InvariantCulture), h = Convert.ToInt32(s["height"], CultureInfo.InvariantCulture);
                    return x + w < 80 || y + h < 80;
                }
                catch { return false; }
            };
            // The save may still be on its way: look until 4 s after the move (it comes 1 to 3.3 s after
            // it), or until the app has saved bounds on screen since the park began (the corner's own save
            // comes first, so none can follow that).
            Func<bool> savedSince = () => { try { return File.GetLastWriteTimeUtc(file) > Parking.Began; } catch { return false; } };
            DateTime end = Parking.Began.AddSeconds(4);
            bool bad = false; while (DateTime.UtcNow < end) { if (offScreen()) { bad = true; break; } if (savedSince()) break; Thread.Sleep(200); }
            if (!bad) return;
            Trace("saved bounds are off screen: showing the window normal until they are saved again");
            Win.WINDOWPLACEMENT normal = Parking.Placement; normal.showCmd = 4;
            int off = 1; Win.DwmSetWindowAttribute(window, 3, ref off, 4);
            Win.SetWindowPos(window, under, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            Win.SetWindowPlacement(window, ref normal);
            Win.SetWindowPos(window, under, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            end = DateTime.UtcNow.AddSeconds(6); while (DateTime.UtcNow < end && offScreen()) Thread.Sleep(200);
            Win.WINDOWPLACEMENT back = Parking.Placement;
            if (back.showCmd == 2) back.showCmd = 7;
            Win.SetWindowPlacement(window, ref back);
            if (back.showCmd != 7) Win.SetWindowPos(window, under, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            int on = 0; Win.DwmSetWindowAttribute(window, 3, ref on, 4);
            if (parkReport != null) parkReport["savedBoundsRepaired"] = !offScreen();
        }
        // open-file and show-session: the person asked to go there, so the app comes to the front.
        [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
        // Closed to the tray: the app hid its window rather than closing it. Nothing is done then. Its
        // page is not read while hidden (Codex: 22 elements, measured), and an app may keep a second
        // hidden window titled like its main one (Codex does), so the console cannot tell which to show.
        static void FailIfHidden()
        {
            if (window == IntPtr.Zero || Native.IsWindowVisible(window)) return;
            Parking.Skipped = "hidden";
            Fail("hidden", appName + "的窗口关到了托盘（现在没有显示），工作台在后台操作不了它：从托盘图标把" + appName + "的窗口打开（打开后最小化也行）再试");
        }
        static void BringForward()
        {
            FailIfHidden();
            if (Native.IsIconic(window)) ShowWindow(window, 9);   // SW_RESTORE
            GiveBack(window);
            Stale();
        }
        // ==== end of the window ====

        // ---- the page, ready ----
        // Chromium builds its page's tree once a UIA client asks, starting from a shell of a dozen nodes;
        // until it has, every control would read as missing. So wait for one of the profile's
        // "refreshAnchors" (up to `patience` seconds), as ax-driver.swift does.
        static bool pageEmpty;
        static bool WaitReady(double patience)
        {
            List<string> anchors = Settings("refreshAnchors");
            DateTime end = ActClock.AddSeconds(patience);
            bool ready;
            while (true)
            {
                Stale(); ReadPage();
                ready = anchors.Count == 0 ? nodes.Count >= 40 : anchors.Any(a => FindAll(a).Count > 0);
                if (ready || ActClock >= end) break;
                Thread.Sleep(150);
            }
            pageEmpty = !ready && nodes.Count < 40;
            Trace("page " + (ready ? "ready" : pageEmpty ? "empty" : "not ready") + " (" + nodes.Count + " elements)");
            return ready;
        }
        static void FailPageEmpty()
        {
            FailIfHidden();
            Fail("page_empty", OnScreen() && !Parking.Active && !Parking.Front
                ? appName + "的窗口被别的窗口完全挡住，或者刚启动后还没显示过，页面没有接进 UI Automation：把它的窗口切到前台看一眼再发"
                : OnScreen() ? appName + "的页面没有接进 UI Automation，工作台读不到它的界面：把它的窗口切到前台看一眼再发"
                : appName + "的窗口不在屏幕上（最小化或在另一个桌面），页面没有接进 UI Automation：把窗口还原后再试");
        }

        // ---- which conversation is on screen, and going to one (ax-driver.swift's show) ----
        // Sidebar rows are buttons named "<title>", or "<title> <state>" ("Running", "Unread response"):
        // every row that may be the conversation, the likeliest first (its exact name, then with a state).
        static List<Node> TitledRows(string title)
        {
            ReadPage();
            Node box = Find("sidebar");
            IEnumerable<Node> scope = box != null ? Within(box) : nodes;
            List<Node> rows = scope.Where(n => RoleIs(n, "AXButton") && Label(n).StartsWith(title, StringComparison.Ordinal)).ToList();
            Func<Node, bool> exact = n => Label(n) == title || n.Name == title;
            Func<Node, bool> stated = n => !exact(n) && Label(n).StartsWith(title + " ", StringComparison.Ordinal);
            return rows.Where(exact).Concat(rows.Where(stated)).Concat(rows.Where(n => !exact(n) && !stated(n))).ToList();
        }
        static Node Row(string title) { return TitledRows(title).FirstOrDefault(); }
        static void OpenLink(string template, Dictionary<string, string> values)
        {
            string link = template;
            foreach (KeyValuePair<string, string> kv in values) link = link.Replace("{" + kv.Key + "}", Uri.EscapeDataString(kv.Value));
            BeforeAct();
            try { Process.Start(new ProcessStartInfo("rundll32.exe", "url.dll,FileProtocolHandler " + link) { UseShellExecute = false, CreateNoWindow = true }).WaitForExit(5000); } catch { }
            Stale();
        }
        // A conversation known by its address (ax-driver.swift's address / rowAt). A desktop whose page has
        // an address of its own for each conversation (profile "sessionAddress", its path with {localId}:
        // Antigravity's "/c/{localId}") is asked by that rather than by title, which two conversations
        // may share: the page shows the conversation when its document's address has that path, and the
        // sidebar's row for it is the link that points there (inside the "sessionList" locator, when the
        // profile has one). A long list is drawn only near what is on screen, so rows it has not drawn
        // are brought in by scrolling its last drawn row into view, down to the list's end, then its
        // first, up to its start, until the row is there.
        static string Address(string localId)
        {
            string template = Setting("sessionAddress");
            if (template.Length == 0 || string.IsNullOrEmpty(localId)) return "";
            string path = template.Replace("{localId}", localId).Replace("{id}", localId);
            return path.Contains("{") ? "" : path;
        }
        static string PathOf(Node n) { Uri u; return n.Value.Length > 0 && Uri.TryCreate(n.Value, UriKind.Absolute, out u) ? Uri.UnescapeDataString(u.AbsolutePath) : ""; }
        static bool Showing(string path) { ReadPage(); return nodes.Any(n => n.ControlType == CT_Document && PathOf(n) == path); }
        static Regex RowShape()
        {
            string template = Setting("sessionAddress");
            return template.Length == 0 ? null : new Regex("^" + Regex.Replace(Regex.Escape(template), @"\\\{[A-Za-z]+}", "[^/]+") + "$");
        }
        static List<Node> SessionRows()
        {
            Regex shape = RowShape();
            if (shape == null) return new List<Node>();
            ReadPage();
            Node box = locators.ContainsKey("sessionList") ? Find("sessionList") : null;
            IEnumerable<Node> scope = box != null ? Within(box) : nodes;
            return scope.Where(n => (n.ControlType == CT_Hyperlink || RoleIs(n, "AXButton")) && shape.IsMatch(PathOf(n))).ToList();
        }
        static Node RowAt(string path)
        {
            HashSet<string> seen = new HashSet<string>();
            foreach (bool downward in new[] { true, false })
            {
                // The list's end in that direction: the row at its edge stays the same however it is scrolled.
                string edgeBefore = ""; int still = 0;
                for (int i = 0; i < 40; i++)
                {
                    List<Node> rows = SessionRows();
                    Node hit = rows.FirstOrDefault(r => PathOf(r) == path);
                    if (hit != null) return hit;
                    foreach (Node r in rows) seen.Add(PathOf(r));
                    if (rows.Count == 0) break;
                    Node edge = downward ? rows[rows.Count - 1] : rows[0];
                    string edgePath = PathOf(edge);
                    still = edgePath == edgeBefore ? still + 1 : 0;
                    if (still >= 2) break;
                    edgeBefore = edgePath;
                    ScrollIntoView(edge.Element); Wait(0.3);
                }
            }
            Trace("no row for " + path + " among " + seen.Count);
            return null;
        }
        // The address of the conversation on screen: the path of the document that has the template's
        // shape ("" with no "sessionAddress", or on a page that is not a conversation).
        static string ShownAddress()
        {
            Regex shape = RowShape();
            if (shape == null) return "";
            ReadPage();
            foreach (Node page in nodes.Where(n => n.ControlType == CT_Document)) { string path = PathOf(page); if (path.Length > 0 && shape.IsMatch(path)) return path; }
            return "";
        }
        // Is this conversation the one on screen: by its address when the page has one, else by its title.
        static bool IsShown(string title, string at) { return at.Length == 0 ? Current() == title : Showing(at); }
        // A deep link ("sessionLink") brings the desktop to the front (Claude's does, measured on the Mac),
        // so only the commands that bring it there anyway, because the person asked to go there, use it.
        static bool MayFront { get { return command == "open-file" || command == "show-session"; } }
        // Its sidebar row (by its address where the profile has one; rows the sidebar keeps folded away
        // are unfolded first), or, for a command that may bring the desktop to the front, the profile's
        // sessionLink. ax-driver.swift's show.
        static bool Show(string title, string localId) { return ShowAt(title, Address(localId), localId); }
        static bool ShowAt(string title, string at, string localId)
        {
            Func<bool> here = () => IsShown(title, at);
            if (here()) return true;
            string link = Setting("sessionLink");
            bool linkable = MayFront && link.Length > 0 && !string.IsNullOrEmpty(localId);
            // A desktop whose page has an address but whose rows are known only by title (profile
            // "sessionRowsBy": "title"; Claude's rows are plain buttons, its page "/epitaxy/local_..."): two
            // conversations may share the title, so each row with it is pressed in turn until the page's
            // address is this conversation's. None of them: not shown, and the command does nothing to
            // whatever conversation is on screen instead. A press after which nothing changed at all was
            // lost (a page not yet taking presses: BeforeAct), and that row is pressed once more.
            if (at.Length > 0 && Setting("sessionRowsBy") == "title")
            {
                Func<bool> byRows = () =>
                {
                    int index = 0; bool again = false;
                    while (true)
                    {
                        List<Node> rows = TitledRows(title);
                        if (index >= rows.Count) return false;
                        string before = ShownAddress();
                        Press(rows[index]);
                        bool moved = Until(1.2, () => here() || ShownAddress() != before);
                        if (Until(0.5, here)) { Trace("showing " + title + " by row " + (index + 1)); return true; }
                        if (!moved && !again) { again = true; continue; }
                        again = false; index++;
                    }
                };
                if (byRows()) return true;
                // Rows the sidebar folds away (profile "moreSessions": a project's "Show 20 more";
                // "nestedSessions": the sessions under another) are unfolded where they are, and the rows
                // with the title are tried again each time more of them are drawn.
                int tried = TitledRows(title).Count;
                for (int i = 0; i < 16; i++)
                {
                    Node more = FindAll("moreSessions").FirstOrDefault() ?? FindAll("nestedSessions").FirstOrDefault();
                    if (more == null) break;
                    Press(more); Wait(0.4);
                    int count = TitledRows(title).Count;
                    if (count > tried) { tried = count; if (byRows()) return true; }
                }
                if (linkable) { OpenLink(link, new Dictionary<string, string> { { "localId", localId } }); if (Until(3, here)) { Trace("showing " + title + " by link"); return true; } }
                Trace("no row shows " + at);
                return false;
            }
            for (int attempt = 0; attempt < 4; attempt++)
            {
                bool asked = false, linked = false;
                if (at.Length > 0)
                {
                    // Every row of the list was looked through: another try finds no more.
                    Node found = RowAt(at);
                    if (found == null) return false;
                    asked = Press(found);
                }
                else
                {
                    Node row = Row(title);
                    if (row != null) asked = Press(row);
                    else if (attempt == 1 && linkable) { OpenLink(link, new Dictionary<string, string> { { "localId", localId } }); asked = linked = true; }
                }
                // A press the page took shows the conversation within a few tenths of a second (measured:
                // 0.1 to 0.35 s once the page is live, BeforeAct), so one not shown after 1.2 s was lost and is
                // pressed again; a link goes through the shell and is given 2 s. Nothing pressed (no row
                // yet): look again soon rather than wait for a page that is not coming.
                if (Until(linked ? 2 : asked ? 1.2 : 0.5, here)) { Trace("showing " + title); return true; }
            }
            return false;
        }
        // Back to the conversation a command started on (`previous`), once it has done its work. Not while
        // the window is parked: the person was not in the app (it was behind their window, or minimized),
        // so the conversation it shows was not in front of them, and going back costs a press (a grab of
        // the foreground, which ends a word the person is composing) and, after a lost press, seconds. The
        // desktop then stays on the conversation the console used last, and the next command for it finds
        // it already shown (Show presses nothing). The desktop's new-chat page is never left on: a command
        // that ends there (a failed new chat, the new-page commands) goes back as before.
        static readonly HashSet<string> newPageNames = new HashSet<string> { "new-controls", "new-pick", "new-leave", "new-shown" };
        // `previousAt`: its address, when the page has one (it may share the title and still be another).
        static void ReturnTo(string previous, string previousAt = "")
        {
            if (previous.Length == 0) return;
            if (Parking.Active && !staying && !newPageNames.Contains(command) && Current().Length > 0) { Trace("left on " + Current() + " (parked: not going back to " + previous + ")"); return; }
            ShowAt(previous, previousAt, "");
        }
        // The conversation a command goes back to: the one on screen as it starts, or, with the desktop
        // parked on its new-chat page, the one the person had before that.
        static string StartedOn() { string now = Current(); return now.Length == 0 ? parkedPrevious : now; }
        // Its address, when the page has one (a conversation parked away from has none here: by title).
        static string StartedAddress() { return Current().Length == 0 ? "" : ShownAddress(); }
        // Whether a box holds text: an empty one reads as its placeholder, which is its name ("Do anything").
        static bool HoldsText(Node box) { string own = (box == null ? "" : box.Value).Trim(); return own.Length > 0 && own != box.Name.Trim(); }
        // Whether `field` reads as `text` (an empty text: as holding none).
        static bool Holds(string field, string text) { Node now = Find(field); return now != null && (text.Trim().Length == 0 ? !HoldsText(now) : now.Value.Trim() == text.Trim()); }
        static double Left(DateTime end, double most) { return Math.Max(0, Math.Min(most, (end - ActClock).TotalSeconds)); }
        // Sets `field` to `text` and waits until it reads so. A set the page reports done is sometimes not
        // taken: the box keeps what it held (measured in Codex's ChatGPT mode and Claude's chat mode, in
        // about one fill in five, and in Codex nearly always when the box already held text). Set again,
        // it took within 0.2 s every time. So each set is given 0.6 s and made again until `seconds`
        // have passed; a set replaces the text, so one taken late is not doubled.
        static bool Put(string field, string text, double seconds)
        {
            DateTime end = ActClock.AddSeconds(seconds);
            while (true)
            {
                if (Holds(field, text)) return true;
                Node box = Find(field);
                if (box == null) { if (ActClock >= end) return false; Wait(0.3); continue; }
                SetValue(box, text);
                if (Until(Left(end, 0.6), () => Holds(field, text))) return true;
                if (ActClock >= end) return false;
            }
        }
        // Fills `field` and waits for the `ready` button (the send button) to show.
        static bool Fill(string field, string text, string ready)
        {
            DateTime end = ActClock.AddSeconds(4);
            do
            {
                if (!Put(field, text, Left(end, 4))) return false;
                // Taken: Send shows, unless the page drops the text again (then it is set again).
                Until(Left(end, 4), () => Find(ready) != null || !Holds(field, text));
                if (Holds(field, text) && Find(ready) != null) return true;
            } while (ActClock < end);
            return false;
        }
        static void Clear(string field) { Put(field, "", 2.4); }

        // ---- modes: the desktop's own switch between its kinds of chat (ax-driver.swift's spaces) ----
        static Dictionary<string, object> Spec(string key) { object v; return profile.TryGetValue(key, out v) && v is Dictionary<string, object> ? (Dictionary<string, object>)v : new Dictionary<string, object>(); }
        static string Str(Dictionary<string, object> d, string key) { object v; return d.TryGetValue(key, out v) && v is string ? (string)v : ""; }
        static Dictionary<string, string> StrMap(Dictionary<string, object> d, string key) { object v; return d.TryGetValue(key, out v) && v is Dictionary<string, object> ? ((Dictionary<string, object>)v).ToDictionary(kv => kv.Key, kv => Convert.ToString(kv.Value, CultureInfo.InvariantCulture)) : new Dictionary<string, string>(); }
        static List<string> StrList(Dictionary<string, object> d, string key) { object v; return d.TryGetValue(key, out v) && v is object[] ? ((object[])v).Select(o => Convert.ToString(o, CultureInfo.InvariantCulture)).ToList() : new List<string>(); }
        static Dictionary<string, object> spaceSpec { get { return Spec("spaces"); } }
        // The mode on screen, as a space id; null when the switch is not there, "" for a word not in the profile.
        static string ShownSpace()
        {
            Node control = Find(Str(spaceSpec, "control"));
            if (control == null) return null;
            string word;
            if (Str(spaceSpec, "kind") == "menu") { string prefix = Str(spaceSpec, "currentPrefix"); word = prefix.Length > 0 && control.Name.StartsWith(prefix, StringComparison.Ordinal) ? control.Name.Substring(prefix.Length) : AfterColon(control.Name); }
            else { Node on = Within(control).FirstOrDefault(n => n.ControlType == CT_RadioButton && Checked(n)); word = on == null ? "" : on.Name; }
            foreach (KeyValuePair<string, string> kv in StrMap(spaceSpec, "names")) if (kv.Value == word) return kv.Key;
            return "";
        }
        static bool ModeDrawn(string id)
        {
            Dictionary<string, string> suffixes = StrMap(spaceSpec, "titleSuffix");
            string own = suffixes.ContainsKey(id) ? suffixes[id] : id == Str(spaceSpec, "home") ? Setting("titleSuffix") : "";
            if (own.Length == 0) return true;
            ReadPage();
            return nodes.Any(n => n.ControlType == CT_Document && n.Name.EndsWith(own, StringComparison.Ordinal));
        }
        static string SwitchSpace(string id)
        {
            Dictionary<string, string> names = StrMap(spaceSpec, "names");
            if (!names.ContainsKey(id)) return appName + "没有这个模式";
            string word = names[id];
            Func<Node> control = () => Find(Str(spaceSpec, "control"));
            if (control() == null) return "没能在" + appName + "上找到切换模式的地方";
            if (ShownSpace() == id) return null;
            if (Str(spaceSpec, "kind") == "menu")
            {
                if (!OpenMenu(control)) { HoldForeground(false); return "没能打开" + appName + "切换模式的菜单"; }
                Node entry = Item(word);
                if (entry == null) { CloseMenus(control); HoldForeground(false); return appName + "切换模式的菜单里没有「" + word + "」"; }
                Press(entry); HoldForeground(false);
            }
            else
            {
                Func<Node> optionNow = () => { Node box = control(); return box == null ? null : Within(box).FirstOrDefault(n => n.ControlType == CT_RadioButton && n.Name == word); };
                Node option = optionNow();
                if (option == null) return appName + "的模式切换里没有「" + word + "」";
                Activate(option);
                // A press that came while the page was settling is lost (measured: Claude's switch to its chat
                // mode missed about one run in four, with no error): pressed once more, as a menu's is.
                if (!Until(1.2, () => ShownSpace() == id)) { Node again = optionNow(); if (again != null) { Trace("mode " + id + ": pressed again"); Activate(again); } }
            }
            if (Until(3.2, () => ShownSpace() == id)) { Until(3.2, () => ModeDrawn(id)); Wait(0.4); Trace("mode " + id); return null; }
            Trace("mode " + id + " not reached (shows " + ShownSpace() + ")");
            return "在" + appName + "里切到「" + word + "」模式，但没有切过去";
        }
        // The mode a command acts in (--space, default the profile's home); the person's comes back at the end.
        static Func<string> beforeExit;
        static void PrepareSpace()
        {
            if (spaceSpec.Count == 0) return;
            string target = wanted.ContainsKey("space") ? wanted["space"] : Str(spaceSpec, "home");
            string before = ShownSpace();
            if (command != "chat-status" && target.Length > 0 && before != null && before != target)
            {
                string error = SwitchSpace(target);
                if (error != null) Fail("no_space_switch", error);
                if (command != "open-file" && command != "show-session" && before.Length > 0) beforeExit = () => SwitchSpace(before);
            }
            Dictionary<string, string> suffixes = StrMap(spaceSpec, "titleSuffix");
            if (target.Length > 0 && suffixes.ContainsKey(target)) modeTitleSuffix = suffixes[target];
        }

        // ---- a menu (only while the app holds the foreground: HoldForeground) ----
        // `opened`: what says it is open, for a popup that is not a menu (Codex's project picker, a
        // list); by default a menu on the page.
        static bool OpenMenu(Func<Node> menu, Func<bool> opened = null)
        {
            Func<bool> open = opened ?? (() => Menus() > 0);
            Node button = menu();
            if (button == null) return false;
            if (Expanded(button) && open()) return true;
            HoldForeground(true);
            // A button the page has just drawn anew is gone by the time it is pressed (UIA_E_ELEMENTNOTAVAILABLE,
            // seen right after a "Switch model?" was confirmed): found again and pressed at once.
            bool expanded = Expand(button);
            for (int i = 0; i < 2 && !expanded; i++) { Wait(0.15); Node now = menu(); if (now == null) break; expanded = Expand(now); }
            // A press that came while the page was still settling (a chat just brought on screen) is
            // lost: pressed once more if the button still says closed (ax-driver.swift's open).
            DateTime began = ActClock; bool pressedAgain = false;
            bool shown = Until(3, () =>
            {
                if (open()) return true;
                if (!pressedAgain && (ActClock - began).TotalSeconds > 1.2) { Node now = menu(); if (now != null && !Expanded(now)) { pressedAgain = true; Expand(now); } }
                return false;
            });
            if (shown) { Node again = menu(); if (again != null && !Confirmed(again)) { CloseMenus(menu); return false; } }
            return shown;
        }
        // No key reaches the page, so a menu is closed by what closes it without a change: Collapse on its
        // button, else picking the row it already has (a pick closes every menu).
        static void CloseMenus(Func<Node> menu)
        {
            if (Menus() == 0) return;
            Node button = menu();
            if (button != null) Collapse(button);
            if (!Until(0.6, () => Menus() == 0))
            {
                Node current = Items().LastOrDefault(Checked);
                if (current != null) { Press(current); Until(1, () => Menus() == 0); }
            }
        }

        // ---- a chat mode's chats (ax-driver.swift's read-chat, chat-status, chat-new, chat-send, chat-stop) ----
        static Dictionary<string, object> chatSpec { get { return Spec("chatRead"); } }
        static Dictionary<string, object> sendSpec { get { return Spec("chatSend"); } }
        static string SendKey(string key) { return Str(sendSpec, key); }
        static List<Loc> SpecList(Dictionary<string, object> d, string key) { object v; return d.TryGetValue(key, out v) ? LocatorList(key, v) : new List<Loc>(); }
        static List<Loc> ChatBox()
        {
            object v; chatSpec.TryGetValue("container", out v);
            List<Loc> ways; if (v is string && locators.TryGetValue((string)v, out ways)) return ways;
            return v == null ? new List<Loc>() : LocatorList("chatRead", v);
        }
        static Node ChatRegion() { foreach (Loc l in ChatBox()) { List<Node> hits = Matches(l, 0); if (hits.Count > 0) return hits[0]; } return null; }
        static string PageURL() { ReadPage(); Node page = nodes.FirstOrDefault(n => n.ControlType == CT_Document && n.Value.StartsWith("http", StringComparison.Ordinal)); return page == null ? "" : page.Value; }
        static string ChatID()
        {
            Match m = Regex.Match(PageURL(), @"/chat/([0-9a-fA-F-]{36})(?:[/?#]|$)");
            return m.Success ? m.Groups[1].Value.ToLowerInvariant() : "";
        }
        static bool SameId(string a, string b) { Guid x, y; return Guid.TryParse(a, out x) && Guid.TryParse(b, out y) && x == y; }
        static bool Fits(Node n, List<Loc> ways) { return ways.Any(l => Fits(n, l)); }
        static string TextOf(Node n) { return n.ControlType == CT_Text ? n.Name : ""; }
        // The messages on the page now: (messages, total, read); total and read only with "article".
        static List<Dictionary<string, object>> ChatMessages(out int total, out int read)
        {
            Dictionary<string, string> speakers = StrMap(chatSpec, "speakers");
            string article = Str(chatSpec, "article"); List<string> ignore = StrList(chatSpec, "ignore");
            List<Loc> anyHeading = SpecList(chatSpec, "speakerHeading"), userMessage = SpecList(chatSpec, "userMessage"), notChat = SpecList(chatSpec, "skip"),
                assistantIn = SpecList(chatSpec, "assistantIn"), anyMessage = SpecList(chatSpec, "message");
            List<Dictionary<string, object>> messages = new List<Dictionary<string, object>>();
            SortedDictionary<int, Dictionary<string, object>> numbered = new SortedDictionary<int, Dictionary<string, object>>();
            StringBuilder text = new StringBuilder(); string speaker = ""; double lastBottom = -1; int number = 0, most = 0;
            IUIAutomationElement firstArticle = null;
            Action flush = () =>
            {
                string body = text.ToString().Trim();
                if (speaker.Length > 0 && body.Length > 0) { Dictionary<string, object> m = new Dictionary<string, object> { { "role", speaker }, { "text", body } }; if (number > 0) numbered[number] = m; else messages.Add(m); }
                text.Clear();
            };
            Action<string, Node> add = (piece, e) =>
            {
                if (lastBottom >= 0 && e.Bottom > e.Top && e.Top > lastBottom + 1 && !text.ToString().EndsWith("\n", StringComparison.Ordinal)) text.Append("\n\n");
                text.Append(piece);
                if (e.Bottom > e.Top) lastBottom = Math.Max(lastBottom, e.Bottom);
            };
            Action<Node> visit = null;
            visit = e =>
            {
                string n = e.Name;
                int k = 0, of = 0;
                if (article.Length > 0 && RoleIs(e, "AXGroup") && n.StartsWith(article, StringComparison.Ordinal))
                {
                    string[] parts = n.Substring(article.Length).Split(new[] { " of " }, StringSplitOptions.None);
                    if (parts.Length == 2) { int.TryParse(parts[0], out k); int.TryParse(parts[1], out of); }
                }
                if (k == 0 && Fits(e, anyMessage))
                {
                    List<int> found = Regex.Matches(n, @"\d+").Cast<Match>().Select(x => int.Parse(x.Value, CultureInfo.InvariantCulture)).ToList();
                    if (found.Count == 2 && found.Min() >= 1) { k = found.Min(); of = found.Max(); }
                }
                if (k > 0 && of > 0) { flush(); speaker = ""; number = k; most = Math.Max(most, of); if (firstArticle == null) firstArticle = e.Element; }
                int ct = e.ControlType;
                if (ct == CT_Button || ct == 50021 /* ToolBar */ || ct == CT_CheckBox || ct == CT_ComboBox || ct == CT_Edit || RoleIs(e, "AXPopUpButton") || e.AriaRole == "time") return;
                if (ignore.Count > 0 && new[] { n, e.Value }.Any(t => t.Length > 0 && ignore.Any(p => t.StartsWith(p, StringComparison.Ordinal)))) return;
                if (Fits(e, notChat)) return;
                if (e.AriaRole == "heading")
                {
                    KeyValuePair<string, string> who = speakers.FirstOrDefault(kv => n.StartsWith(kv.Key, StringComparison.Ordinal));
                    if (who.Key != null) { flush(); speaker = who.Value; lastBottom = -1; foreach (int c in e.Kids) visit(nodes[c]); return; }
                    if (Fits(e, anyHeading))
                    {
                        flush(); lastBottom = -1;
                        if (assistantIn.Count > 0) speaker = e.Parent >= 0 && Fits(nodes[e.Parent], assistantIn) ? "assistant" : "user";
                        else
                        {
                            Node after = null;
                            if (e.Parent >= 0) { List<int> sib = nodes[e.Parent].Kids; int at = sib.IndexOf(e.Index); if (at >= 0 && at + 1 < sib.Count) after = nodes[sib[at + 1]]; }
                            speaker = after != null && Fits(after, userMessage) ? "user" : "assistant";
                        }
                        for (int place = 0; place < e.Kids.Count; place++)
                        {
                            Node child = nodes[e.Kids[place]];
                            if (place == 0 && child.ControlType == CT_Text && child.Name.Length > 0 && n.StartsWith(child.Name, StringComparison.Ordinal)) continue;
                            visit(child);
                        }
                        return;
                    }
                    if (speaker.Length > 0 && n.Length > 0) { text.Append((text.Length == 0 ? "" : "\n\n") + "### " + n + "\n\n"); lastBottom = e.Bottom; return; }
                }
                // A table, read by its rows as a Markdown table.
                if (ct == 50036 /* Table */ || ct == 50028 /* DataGrid */ || e.AriaRole == "table" || e.AriaRole == "grid")
                {
                    if (speaker.Length == 0) return;
                    List<Node> rows = Within(e).Where(r => r.AriaRole == "row" || r.ControlType == 50029 /* DataItem */).ToList();
                    Func<Node, string> cellText = cell => string.Concat(Within(cell).Where(x => x.ControlType == CT_Text).Select(x => x.Name)).Replace("|", "\\|").Replace("\n", " ");
                    List<string> lines = rows.Select(r => "| " + string.Join(" | ", r.Kids.Select(c => cellText(nodes[c]))) + " |").ToList();
                    if (lines.Count > 0)
                    {
                        int columns = Math.Max(1, rows[0].Kids.Count);
                        string sep = "|" + string.Concat(Enumerable.Repeat(" --- |", columns));
                        text.Append((text.Length == 0 || text.ToString().EndsWith("\n\n", StringComparison.Ordinal) ? "" : "\n\n") + string.Join("\n", new[] { lines[0], sep }.Concat(lines.Skip(1))) + "\n\n");
                        lastBottom = e.Bottom;
                    }
                    return;
                }
                // Code: a block (its class names the language, or it spans lines) as a fenced block.
                string lang = e.Classes.Where(c => c.StartsWith("language-", StringComparison.Ordinal)).Select(c => c.Substring(9)).FirstOrDefault() ?? "";
                if ((e.AriaRole == "code" || e.Localized == "code" || lang.Length > 0) && speaker.Length > 0)
                {
                    string raw = string.Concat(Within(e).Where(x => x.ControlType == CT_Text).Select(x => x.Name));
                    if (lang.Length > 0 || raw.Contains("\n"))
                    {
                        string sofar = text.ToString();
                        if (lang.Length > 0 && sofar.ToLowerInvariant().EndsWith(lang.ToLowerInvariant(), StringComparison.Ordinal)) { string cut = sofar.Substring(0, sofar.Length - lang.Length); if (cut.Length == 0 || cut.EndsWith("\n", StringComparison.Ordinal)) sofar = cut; }
                        sofar = sofar.TrimEnd('\n', ' ');
                        string fence = raw.Contains("```") ? "~~~~" : "```";
                        text.Clear(); text.Append(sofar + (sofar.Length == 0 ? "" : "\n\n") + fence + lang + "\n" + raw.TrimEnd('\n') + "\n" + fence + "\n\n");
                        lastBottom = e.Bottom;
                    }
                    else if (raw.Length > 0) { string tick = raw.Contains("`") ? "``" : "`"; add(tick + (raw.Contains("`") ? " " + raw + " " : raw) + tick, e); }
                    return;
                }
                if (ct == 50007 /* ListItem */ && speaker.Length > 0)
                {
                    string sofar = text.ToString();
                    text.Append((sofar.EndsWith("\n", StringComparison.Ordinal) || sofar.Length == 0 ? "" : "\n") + "- "); lastBottom = -1;
                    foreach (int c in e.Kids) { Node child = nodes[c]; if (child.ControlType == CT_Text && Regex.IsMatch(child.Name, @"^\s*([•◦▪·‣-]|\d+[.)])\s*$")) continue; visit(child); }
                    return;
                }
                if (ct == CT_Image && speaker.Length > 0 && n.Length > 0) { string sofar = text.ToString(); text.Append((sofar.Length == 0 || sofar.EndsWith("\n", StringComparison.Ordinal) ? "" : "\n") + "[" + n + "]\n"); lastBottom = e.Bottom; return; }
                if (ct == CT_Text && speaker.Length > 0) { if (n.Length > 0 && !speakers.Keys.Any(p => n.StartsWith(p, StringComparison.Ordinal))) add(n, e); return; }
                foreach (int c in e.Kids) visit(nodes[c]);
            };
            Node area = ChatRegion();
            if (area != null) { visit(area); flush(); }
            // A long chat opens at its end with only the last messages drawn. No key reaches the page on
            // Windows, so the first drawn message is scrolled into view, which draws the ones above it,
            // until message 1 is read or nothing new comes.
            int still = 0;
            while (area != null && most > 0 && !numbered.ContainsKey(1) && still < 3 && numbered.Count < most)
            {
                int before = numbered.Count;
                if (firstArticle != null) ScrollIntoView(firstArticle);
                Wait(0.8);
                firstArticle = null; speaker = ""; number = 0;
                area = ChatRegion();
                if (area != null) { visit(area); flush(); }
                still = numbered.Count > before ? 0 : still + 1;
            }
            if (numbered.Count > 0) messages = numbered.Values.ToList();
            total = most; read = numbered.Count;
            return messages;
        }
        // Whether a locator's worded ways find anything (the page names it in the profile's words).
        static bool Spoken(string key) { List<Loc> ways; return locators.TryGetValue(key, out ways) && ways.Any(l => l.Worded && Matches(l, 0).Count > 0); }
        static List<Node> StopButtons()
        {
            if (SendKey("stop").Length == 0) return new List<Node>();
            List<Node> named = FindAll(SendKey("stop"));
            if (named.Count > 0) return named;
            if (SendKey("stopSlot").Length == 0 || Spoken(SendKey("send")) || Spoken(SendKey("stop")) || ChatRegion() == null) return new List<Node>();
            Node button = Find(SendKey("stopSlot"));
            if (button == null || FindAll(SendKey("send")).Contains(button)) return new List<Node>();
            return new List<Node> { button };
        }
        static bool Answering() { return StopButtons().Count > 0; }
        static Dictionary<string, object> ChatAnswer(Dictionary<string, object> extra)
        {
            int total, read; List<Dictionary<string, object>> messages = ChatMessages(out total, out read);
            Dictionary<string, object> answer = new Dictionary<string, object> { { "ok", true }, { "messages", messages }, { "running", Answering() }, { "title", Current() }, { "url", PageURL() } };
            if (total > 0) { answer["total"] = total; answer["read"] = read; }
            if (extra != null) foreach (KeyValuePair<string, object> kv in extra) answer[kv.Key] = kv.Value;
            return answer;
        }
        // The reply is done once the page stops showing its stop button and its last message is the assistant's.
        static void AwaitReply(double seconds)
        {
            DateTime end = ActClock.AddSeconds(seconds);
            Wait(1.5);
            while (ActClock < end)
            {
                if (!Answering() && ChatRegion() != null)
                {
                    int t, r; List<Dictionary<string, object>> m = ChatMessages(out t, out r);
                    if (m.Count > 0 && (string)m[m.Count - 1]["role"] == "assistant") { Wait(0.6); if (!Answering()) return; }
                }
                Wait(1);
            }
        }
        static string[] SendText(string text)
        {
            if (SendKey("composer").Length == 0 || SendKey("send").Length == 0) return new[] { "usage", appName + "的配置里没有 chatSend" };
            if (!Fill(SendKey("composer"), text, SendKey("send"))) { Clear(SendKey("composer")); return new[] { "fill_failed", "没能把消息填进" + appName + "的输入框" }; }
            Node send = Find(SendKey("send"));
            bool pressed = send != null && Press(send);
            // The page can draw the button anew between the read and the press (UIA's "element not
            // available", seen in Codex's ChatGPT mode): read again and pressed once more, only while the
            // composer still holds the message, so a send that went through is not made twice.
            if (!pressed && send != null)
            {
                Wait(0.2);
                Node box = Find(SendKey("composer"));
                if (box != null && box.Value.Trim() == text.Trim()) { send = Find(SendKey("send")); pressed = send != null && Press(send); }
            }
            if (!pressed) { Clear(SendKey("composer")); return new[] { "no_send", appName + "没有出现发送按钮" }; }
            Func<bool> gone = () => { Node box = Find(SendKey("composer")); return (box != null && !HoldsText(box)) || Answering(); };
            if (Until(1.5, gone)) return null;
            // Still in the composer: in a chat that is already open, Codex's ChatGPT mode takes the press only
            // while its window is active (measured: from behind nothing happened; with the window in front,
            // the same press sent). Pressed once more with the window activated, still off screen, and the
            // foreground held for that press only (as a card's buttons are).
            Node holding = Find(SendKey("composer"));
            if (Parking.Active && holding != null && holding.Value.Trim() == text.Trim())
            {
                HoldForeground(true); Activate();
                // (Activated, the page draws its buttons anew: read again before each press.)
                for (int attempt = 0; attempt < 3; attempt++)
                {
                    Stale(); Wait(0.15);
                    Node box = Find(SendKey("composer"));
                    if (box == null || box.Value.Trim() != text.Trim()) break;
                    send = Find(SendKey("send"));
                    if (send != null && Press(send) && Until(1.0, gone)) break;
                }
                HoldForeground(false);
            }
            if (Until(8, gone)) return null;
            Clear(SendKey("composer"));
            return new[] { "not_sent", "按了" + appName + "的发送，但消息还留在输入框里" };
        }
        static string[] OpenChatPage(string project)
        {
            Func<bool> ready = () => Find(SendKey("composer")) != null && ChatRegion() == null;
            string mode = ShownSpace();
            Func<string[]> moved = () => mode != null && ShownSpace() != mode ? new[] { "space_moved", appName + "离开了这个模式，没有新建聊天" } : null;
            if (project.Length == 0)
            {
                Node start = Find(SendKey("newChat"));
                if (start == null) return new[] { "no_new_page", appName + "的侧栏里没有找到新建聊天的按钮" };
                Press(start);
                for (int attempt = 0; attempt < 24; attempt++)
                {
                    Wait(0.25);
                    string[] error = moved(); if (error != null) return error;
                    if (attempt == 10 && !ready()) { Node again = Find(SendKey("newChat")); if (again != null) Press(again); }
                    if (!ready()) continue;
                    if (SendKey("inProject").Length > 0 && Find(SendKey("inProject")) != null) { Node none = Find(SendKey("noProject")); if (none != null) { Press(none); Wait(0.4); } continue; }
                    if (SendKey("newShown").Length == 0 || Find(SendKey("newShown")) != null) return null;
                }
                return new[] { "no_new_page", "没能在" + appName + "里打开新聊天的页面" };
            }
            List<string> names = StrList(sendSpec, "project").Select(p => p.Replace("{project}", project)).ToList();
            Func<Node> button = () => { ReadPage(); return names.Select(w => nodes.FirstOrDefault(n => RoleIs(n, "AXButton") && n.Name == w)).FirstOrDefault(n => n != null); };
            Node first = button();
            if (first == null) return new[] { "no_project", appName + "的侧栏里没有「" + project + "」这个项目，没能在里面新建聊天" };
            Press(first);
            object shownSpecRaw; sendSpec.TryGetValue("projectShown", out shownSpecRaw);
            Func<bool> shown = () =>
            {
                Dictionary<string, object> spec = shownSpecRaw as Dictionary<string, object>;
                if (spec == null) return false;
                Dictionary<string, object> filled = spec.ToDictionary(kv => kv.Key, kv => kv.Value is string ? (object)((string)kv.Value).Replace("{project}", project) : kv.Value);
                Loc l = Loc.From("projectShown", filled); ReadPage(); return nodes.Any(n => Fits(n, l));
            };
            for (int attempt = 0; attempt < 24; attempt++)
            {
                Wait(0.25);
                string[] error = moved(); if (error != null) return error;
                if (ready() && shown()) return null;
                if (attempt == 10) { Node again = button(); if (again != null) Press(again); }
            }
            return new[] { "no_new_page", "没能在" + appName + "里打开「" + project + "」的新聊天页面" };
        }
        static void RunChat()
        {
            if (ChatBox().Count == 0) Fail("usage", appName + "的配置里没有 chatRead");
            string previous = Current(), target = args.Count > 1 ? args[1] : "";
            Action back = () => { if (previous != target) ReturnTo(previous); };
            double seconds = 60; if (args.Count > 2) double.TryParse(args[2], NumberStyles.Float, CultureInfo.InvariantCulture, out seconds);
            switch (command)
            {
                case "chat-stop":
                    {
                        string id = args.Count > 2 ? args[2] : ""; Guid g;
                        if (target.Length == 0 || !Guid.TryParse(id, out g)) Fail("usage", "缺少有效的会话 ID 或标题");
                        Func<bool> onTarget = () => SameId(ChatID(), id);
                        if (!onTarget() && !Show(target, "")) { back(); Fail("not_found", "没能在" + appName + "的侧栏里找到这个聊天"); }
                        Until(4, () => onTarget() && ChatRegion() != null);
                        if (!onTarget() || ChatRegion() == null) { back(); Fail("wrong_chat", "没能在" + appName + "里确认打开的是要停止的聊天"); }
                        List<Node> buttons = StopButtons();
                        if (buttons.Count == 0) { back(); Fail("not_running", "这个会话在" + appName + "里已经没有在回复"); }
                        if (buttons.Count != 1) { back(); Fail("ambiguous_stop", "没能在" + appName + "里确认哪个按钮会停止这条回复"); }
                        if (!Press(buttons[0])) { back(); Fail("not_stopped", "没能按下" + appName + "的停止按钮"); }
                        for (int i = 0; i < 12; i++)
                        {
                            Wait(0.25);
                            if (!onTarget() || ChatRegion() == null) { back(); Fail("wrong_chat", "没能在" + appName + "里确认这条回复已停止"); }
                            if (!Answering()) { Dictionary<string, object> answer = ChatAnswer(new Dictionary<string, object> { { "interrupted", true } }); back(); Out(answer); }
                        }
                        back(); Fail("not_stopped", "按了停止，但" + appName + "还在回复");
                        break;
                    }
                case "chat-new":
                    {
                        string text = ReadInput(), project = target == "-" ? "" : target;
                        if (text.Length == 0) Fail("usage", "消息是空的");
                        target = "";
                        string[] error = OpenChatPage(project);
                        if (error != null) { back(); Fail(error[0], error[1]); }
                        error = SendText(text);
                        if (error != null) { back(); Fail(error[0], error[1]); }
                        Until(10, () => ChatRegion() != null);
                        if (seconds > 0) AwaitReply(seconds); else Until(10, () => Current().Length > 0);
                        target = Current();
                        Dictionary<string, object> answer = seconds > 0 ? ChatAnswer(new Dictionary<string, object> { { "sent", true } }) : new Dictionary<string, object> { { "ok", true }, { "sent", true }, { "running", Answering() }, { "title", target }, { "url", PageURL() } };
                        back(); Out(answer);
                        break;
                    }
                case "chat-send":
                    {
                        string text = ReadInput();
                        if (target.Length == 0 || text.Length == 0) Fail("usage", "缺少会话标题或消息");
                        if (!Show(target, "")) { back(); Fail("not_found", "没能在" + appName + "的侧栏里找到这个聊天"); }
                        Until(4, () => ChatRegion() != null);
                        if (Answering()) { back(); Fail("busy", "这个聊天正在" + appName + "里回复，等它回复完再发"); }
                        string[] error = SendText(text);
                        if (error != null) { back(); Fail(error[0], error[1]); }
                        if (seconds > 0) AwaitReply(seconds);
                        Dictionary<string, object> answer = seconds > 0 ? ChatAnswer(new Dictionary<string, object> { { "sent", true } }) : new Dictionary<string, object> { { "ok", true }, { "sent", true }, { "running", Answering() }, { "title", target }, { "url", PageURL() } };
                        back(); Out(answer);
                        break;
                    }
                default:
                    {
                        if (target.Length == 0) Fail("usage", "缺少会话标题");
                        bool onIt = args.Count > 2 && SameId(ChatID(), args[2]);
                        if (!onIt && !Show(target, "")) { back(); Fail("not_found", "没能在" + appName + "的侧栏里找到这个聊天"); }
                        Until(4, () => ChatRegion() != null);
                        if (ChatRegion() == null) { back(); Fail("no_messages", appName + "里这个聊天没有显示出消息"); }
                        Wait(0.6);
                        Dictionary<string, object> answer = ChatAnswer(null); back(); Out(answer);
                        break;
                    }
            }
        }

        // ---- a question card in the chat: its question, its options, Submit and Skip ----
        static List<Node> QuestionCards()
        {
            string submit = Setting("questionSubmit");
            ReadPage();
            // On Windows every box reports the ARIA role "group" (on the Mac only the card's own does), and the
            // options are buttons ("A <description>"), not checkboxes. So a card is the nearest box around a
            // Submit button that holds options and is named (by its question); else the nearest with options.
            List<Node> cards = new List<Node>();
            foreach (Node button in nodes.Where(b => RoleIs(b, "AXButton") && b.Name == submit))
            {
                Node withOptions = null;
                for (int up = button.Parent, i = 0; up >= 0 && i < 6; up = nodes[up].Parent, i++)
                {
                    Node box = nodes[up];
                    if (box.ControlType == CT_Document || box.AriaRole == "article") break;
                    if (!QuestionOptions(box).Any()) continue;
                    if (withOptions == null) withOptions = box;
                    if (box.Name.Length > 0) { withOptions = box; break; }
                }
                if (withOptions != null && !cards.Contains(withOptions)) cards.Add(withOptions);
            }
            return cards;
        }
        static IEnumerable<Node> QuestionOptions(Node card)
        {
            string submit = Setting("questionSubmit"), skip = Setting("questionSkip");
            return Within(card).Where(n => n.ControlType == CT_CheckBox || n.ControlType == CT_RadioButton || (RoleIs(n, "AXButton") && n.Name.Length > 0 && n.Name != submit && n.Name != skip));
        }
        static string[] AnswerCard(string question, string option)
        {
            List<Node> cards = QuestionCards();
            for (int i = 0; i < 32 && cards.Count == 0; i++) { Wait(0.25); cards = QuestionCards(); }
            Node card = cards.FirstOrDefault(c => c.Name == question) ?? (cards.Count == 1 ? cards[0] : null);
            if (card == null)
            {
                if (tracing) foreach (Node b in nodes.Where(x => RoleIs(x, "AXButton") && x.Name == Setting("questionSubmit")))
                    for (int up = b.Parent, i = 0; up >= 0 && i < 6; up = nodes[up].Parent, i++)
                        Trace("around Submit, " + i + " up: " + string.Join(", ", Within(nodes[up]).Where(n => n.Index != up).GroupBy(n => (ControlTypeNames.ContainsKey(n.ControlType) ? ControlTypeNames[n.ControlType] : n.ControlType.ToString(CultureInfo.InvariantCulture)) + "/" + n.AriaRole).Select(g => g.Key + "×" + g.Count())) + " | named: " + string.Join(" ; ", Within(nodes[up]).Where(n => n.Name.Length > 0 && n.ControlType != CT_Text && n.Index != up).Take(8).Select(n => n.Name.Length > 30 ? n.Name.Substring(0, 30) : n.Name)));
                return new[] { "no_question", appName + "里没有在等回答的这个问题" };
            }
            int count = cards.Count; string cardName = card.Name;
            Func<Node> currentCard = () => QuestionCards().FirstOrDefault(c => c.Name == cardName) ?? (QuestionCards().Count == 1 ? QuestionCards()[0] : null);
            if (option != null)
            {
                Func<Node> choice = () => { Node c = currentCard(); return c == null ? null : QuestionOptions(c).FirstOrDefault(n => Named(n, option) || Label(n) == option || Label(n).StartsWith(option + " ", StringComparison.Ordinal)); };
                Node wantedOption = choice();
                if (wantedOption == null)
                {
                    Node c = currentCard();
                    if (c != null) Trace("the card holds: " + string.Join(" | ", Within(c).Where(n => n.Name.Length > 0 && n.ControlType != CT_Text).Take(30).Select(n => (ControlTypeNames.ContainsKey(n.ControlType) ? ControlTypeNames[n.ControlType] : n.ControlType.ToString(CultureInfo.InvariantCulture)) + "/" + n.AriaRole + " '" + n.Name + "' " + n.AriaProps)));
                    return new[] { "no_option", appName + "的这个问题里没有「" + option + "」这个选项" };
                }
                // Another option may be picked already (the first is, by default): nothing is submitted until this
                // one is. The card takes a press only while its window is active (Activate): the foreground is held
                // from just before the pick until the card has gone (about half a second, the window off screen).
                // The Mac picks with Space after a press that only focused; no key is sent here. A press that
                // showed nothing is tried again (never one on an option already picked: on a card that lets
                // several be picked it would take it back).
                Func<bool> took = () => { Node now = choice(); return now != null && Checked(now); };
                if (!took()) { HoldForeground(true); Activate(); }
                for (int press = 0; press < 3 && !took(); press++)
                {
                    Node now = choice();
                    if (now == null) break;
                    Toggle(now);
                    if (Until(0.35, took)) break;
                }
                Trace("options: " + string.Join(" | ", (currentCard() == null ? new List<Node>() : QuestionOptions(currentCard()).ToList()).Select(n => n.Name + (Checked(n) ? " [picked]" : ""))));
                Node picked = choice();
                if (picked == null || !Checked(picked)) { HoldForeground(false); return new[] { "not_picked", "没能在" + appName + "的问题卡片上选中「" + option + "」，没有提交" }; }
            }
            string doneName = Setting(option == null ? "questionSkip" : "questionSubmit");
            Func<Node> done = () => { Node box = currentCard(); return box == null ? null : Within(box).FirstOrDefault(n => RoleIs(n, "AXButton") && n.Name == doneName); };
            if (done() == null) return new[] { "no_submit", appName + "的问题卡片上没有找到提交按钮" };
            // Submit (or Skip) the same way, still held. A press that was taken takes the card away: nothing is
            // left to press twice.
            HoldForeground(true); Activate();
            try
            {
                for (int press = 0; press < 3; press++)
                {
                    Node button = done();
                    if (button == null) break;
                    Press(button);
                    if (Until(press == 0 ? 0.35 : press == 1 ? 1.0 : 4, () => QuestionCards().Count < count)) return null;
                }
            }
            finally { HoldForeground(false); }
            return new[] { "not_taken", appName + "没有收下这个回答" };
        }

        // ---- open-file and show-session: the person asked to go there, so the app comes to the front (BringForward) ----
        static List<KeyValuePair<Node, int>> FileLinks(string path, string absolute, string text)
        {
            string bare = Regex.Replace(path, @":\d+(:\d+)?$", "");
            string baseName = Path.GetFileName(bare.Replace('/', '\\'));
            List<KeyValuePair<Node, int>> hits = new List<KeyValuePair<Node, int>>();
            // A page that names the file elsewhere too (Antigravity: the tabs of the files it has open,
            // after the chat) says what the chat's own links are with the profile's "fileLink": only those count.
            List<Loc> shaped; locators.TryGetValue("fileLink", out shaped);
            ReadPage();
            foreach (Node e in nodes.Where(n => n.ControlType == CT_Hyperlink || RoleIs(n, "AXButton")))
            {
                if (shaped != null && !Fits(e, shaped)) continue;
                // A control that folds or opens something (a diff's header naming its file, Codex's
                // changes panel) is not a link to the file. A profile's "fileLink" says it for itself.
                if (shaped == null && e.ControlType != CT_Hyperlink && e.PExpand) continue;
                string url = Uri.UnescapeDataString(e.Value ?? "").Replace('\\', '/'), own = Label(e).Trim();
                string abs = absolute.Replace('\\', '/'), bareSlash = bare.Replace('\\', '/');
                int score = 0;
                // A link may name the file and carry its path as its description (Antigravity's pills:
                // "ScreenSwitch.cs", described "c:\…\ScreenSwitch.cs"), which Label joins to the name:
                // the description is matched as a path, and the name alone as the link's text.
                string named = e.Name.Trim(), aside = (e.FullDescription.Length > 0 ? e.FullDescription : e.Help).Trim().Replace('\\', '/');
                string[] names = { own, named };
                string[] paths = new[] { baseName, path, bare }.Where(p => p.Length > 0).ToArray();
                if (url.Length > 0 && ((abs.Length > 0 && url.EndsWith(abs, StringComparison.OrdinalIgnoreCase)) || url.EndsWith("/" + bareSlash, StringComparison.OrdinalIgnoreCase) || url == bareSlash)) score = 5;
                else if (abs.Length > 0 && aside.Equals(abs, StringComparison.OrdinalIgnoreCase)) score = 5;
                else if (text.Length > 0 && names.Contains(text)) score = 4;
                else if (text.Length > 0 && names.Any(o => Leads(o, text))) score = 3;
                else if (baseName.Length > 0 && names.Any(o => paths.Contains(o))) score = 2;
                else if (baseName.Length > 0 && names.Any(o => paths.Any(p => Leads(o, p)))) score = 1;
                if (score > 0) hits.Add(new KeyValuePair<Node, int>(e, score));
            }
            return hits;
        }
        // A link named for the file and then what the desktop says about it, after a space: Codex's
        // changed-file rows ("src/app.ts +10 -2") and file mentions ("app.ts (line 12)").
        static bool Leads(string name, string file) { return name.Length > file.Length && name.StartsWith(file + " ", StringComparison.Ordinal); }
        // The file's link, waited for while the chat is drawn. Two things can keep a link off the page:
        // - The box holding it draws it only once it has been on screen (Codex's "Edited N files" card on
        //   an earlier turn shows its rows only then): the profile's "fileCard" boxes are brought on
        //   screen, newest first.
        // - A long chat draws only its last messages (Claude, Antigravity): the first of the profile's
        //   "messageMark" (what each message carries: its box, or its speaker line) is brought on
        //   screen, which draws the messages above it, until nothing new comes.
        // Each stops once the link is drawn, and both within the helper's time (the command's timeout is 30 s).
        static List<KeyValuePair<Node, int>> DrawnFileLinks(string path, string absolute, string text)
        {
            Func<bool> late = () => clock.ElapsedMilliseconds > 22000;
            List<KeyValuePair<Node, int>> hits = FileLinks(path, absolute, text);
            for (int i = 0; i < 12 && hits.Count == 0; i++) { Wait(0.25); hits = FileLinks(path, absolute, text); }
            if (hits.Count > 0) return hits;
            Action settle = () => { for (int i = 0; i < 6 && hits.Count == 0; i++) { Wait(0.25); hits = FileLinks(path, absolute, text); } };
            Func<List<Node>> messages = () => FindAll("messageMark");
            // Where the chat was, to go back to when the link is not drawn after all.
            List<Node> drawn = messages(), cardsNow = FindAll("fileCard");
            IUIAutomationElement back = drawn.Count > 0 ? drawn[drawn.Count - 1].Element : cardsNow.Count > 0 ? cardsNow[cardsNow.Count - 1].Element : null;
            bool moved = false;
            if (locators.ContainsKey("fileCard"))
            {
                int cards = FindAll("fileCard").Count;
                for (int index = cards - 1; index >= 0 && index >= cards - 40 && hits.Count == 0 && !late(); index--)
                {
                    List<Node> found = FindAll("fileCard");
                    if (index >= found.Count) continue;
                    ScrollIntoView(found[index].Element); moved = true;
                    settle();
                }
            }
            string before = null; int still = 0;
            while (hits.Count == 0 && still < 2 && !late())
            {
                List<Node> now = messages();
                if (now.Count == 0) break;
                // What the top of the chat is now: the first mark, the text that follows it, and how
                // many marks there are (a speaker line reads the same on every message).
                Node next = nodes.Skip(now[0].Index + 1).FirstOrDefault(n => n.ControlType == CT_Text && n.Name.Trim().Length > 0);
                string mark = now[0].Name + "\n" + (next == null ? "" : next.Name) + "\n" + now.Count;
                still = mark == before ? still + 1 : 0; before = mark;
                if (still >= 2) break;
                ScrollIntoView(now[0].Element); moved = true;
                settle();
            }
            if (hits.Count == 0 && moved && back != null) ScrollIntoView(back);
            return hits;
        }

        // ---- a new chat's page: what it asks for before the first message (ax-driver.swift's pageControls) ----
        class PageControl { public Node Element; public string Kind, Label, Value, Title; }
        class PageChoice { public Node Element; public string Label, Section; public bool Selected; }
        static Func<string[]> newPageWatch = () => null;
        static Func<bool> newPageInUse = () => false;
        static Func<Dictionary<string, object>> newPageShown = () => new Dictionary<string, object>();
        static int DocOf(Node n) { for (int i = n.Index; i >= 0; i = nodes[i].Parent) if (nodes[i].ControlType == CT_Document) return i; return -1; }
        static string LabelPart(string text, out string value)
        {
            value = "";
            int at = -1; foreach (string colon in new[] { ": ", "：" }) { int i = text.IndexOf(colon, StringComparison.Ordinal); if (i >= 0 && (at < 0 || i < at)) at = i; }
            if (at < 0) return null;
            value = text.Substring(at + (text[at] == '：' ? 1 : 2)).Trim();
            return text.Substring(0, at);
        }
        static List<PageControl> PageControls()
        {
            ReadPage();
            string heading = Setting("newPageHeading"); List<string> skip = Settings("newPageSkip"), skipToggles = Settings("newPageSkipToggles");
            Node togglesAfter = Find(Setting("newPageTogglesAfter")), startAt = Find(Setting("newPageStart")), menusEnd = Find(Setting("newPageMenusBefore"));
            Node toggleBox = Find(Setting("newPageSkipTogglesInside"));
            HashSet<Node> composerToggles = toggleBox == null ? new HashSet<Node>() : new HashSet<Node>(Within(toggleBox).Where(n => n.ControlType == CT_CheckBox));
            bool menusOver = false, started = false, afterPrompt = !locators.ContainsKey(Setting("newPageTogglesAfter"));
            int page = -1;
            List<PageControl> found = new List<PageControl>();
            foreach (Node e in nodes)
            {
                if (!started && (startAt != null ? e == startAt : e.AriaRole == "heading" && Label(e).StartsWith(heading, StringComparison.Ordinal))) { started = true; page = DocOf(e); }
                if (!started || DocOf(e) != page) continue;
                if (togglesAfter != null && e == togglesAfter) afterPrompt = true;
                if (menusEnd != null && e == menusEnd) menusOver = true;
                string value = ""; string key = RoleIs(e, "AXPopUpButton") ? LabelPart(e.Name, out value) : null;
                if (key != null) { if (!menusOver && !skip.Contains(key)) found.Add(new PageControl { Element = e, Kind = "menu", Label = key, Value = value, Title = e.Name }); }
                else if (e.ControlType == CT_CheckBox && afterPrompt && !skipToggles.Any(s => e.Name.StartsWith(s, StringComparison.Ordinal)) && !composerToggles.Contains(e))
                    found.Add(new PageControl { Element = e, Kind = "toggle", Label = e.Name, Value = Checked(e) ? "on" : "off", Title = e.Name });
            }
            return found;
        }
        static PageControl PageControlNamed(string label) { return PageControls().FirstOrDefault(c => c.Label == label); }
        static List<PageChoice> PageChoices(PageControl control)
        {
            ReadPage();
            Node box = nodes.FirstOrDefault(n => RoleIs(n, "AXGroup") && n.Name == control.Title) ?? nodes.FirstOrDefault(n => (n.ControlType == CT_Menu || n.AriaRole == "menu") && Within(n).Any(x => RoleIs(x, "AXMenuItem")));
            List<PageChoice> list = new List<PageChoice>();
            if (box == null) return list;
            string header = "";
            Action<Node, string> collect = null;
            collect = (e, section) =>
            {
                foreach (int c in e.Kids)
                {
                    Node child = nodes[c];
                    if (RoleIs(child, "AXMenuItem"))
                    {
                        if (!HasCheckState(child) || !child.Enabled) continue;
                        string full = child.Name; int cut = full.IndexOf(" , ", StringComparison.Ordinal);
                        list.Add(new PageChoice { Element = child, Label = (cut >= 0 ? full.Substring(0, cut) : full).Trim(), Section = section.Length == 0 ? header : section, Selected = Checked(child) });
                    }
                    else if (RoleIs(child, "AXGroup") && child.Name.Length > 0 && child.Name != control.Title)
                    {
                        if (Within(child).Any(x => RoleIs(x, "AXMenuItem"))) collect(child, child.Name); else header = child.Name;
                    }
                    else collect(child, section);
                }
            };
            collect(box, "");
            return list;
        }
        static Dictionary<string, object> Describe(PageControl control, List<PageChoice> options)
        {
            Dictionary<string, object> d = new Dictionary<string, object> { { "kind", control.Kind }, { "label", control.Label }, { "value", control.Value } };
            if (options != null) d["options"] = options.Select(o => (object)new Dictionary<string, object> { { "label", o.Label }, { "section", o.Section }, { "selected", o.Selected } }).ToList();
            return d;
        }
        static List<object> ListPageControls(Func<string, bool> read)
        {
            List<object> list = new List<object>();
            foreach (PageControl item in PageControls())
            {
                if (item.Kind != "menu" || read == null || !read(item.Label)) { list.Add(Describe(item, null)); continue; }
                string label = item.Label;
                Func<Node> button = () => { PageControl now = PageControlNamed(label); return now == null ? null : now.Element; };
                List<PageChoice> found = new List<PageChoice>();
                for (int attempt = 0; attempt < 2 && found.Count == 0; attempt++)
                {
                    if (attempt > 0) { CloseMenus(button); Wait(0.4); }
                    if (!OpenMenu(button)) continue;
                    PageControl now = PageControlNamed(label);
                    found = now == null ? new List<PageChoice>() : PageChoices(now);
                }
                CloseMenus(button); HoldForeground(false);
                list.Add(Describe(PageControlNamed(label) ?? item, found));
            }
            return list;
        }
        // A folder is listed by its name and shown on its button as a path.
        static bool IsPath(string v) { return Regex.IsMatch(v, @"^([A-Za-z]:[\\/]|\\\\|/|~[\\/]|~$)"); }
        static string StandardPath(string v)
        {
            string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            if (v.StartsWith("~", StringComparison.Ordinal)) v = home + v.Substring(1);
            try { return Path.GetFullPath(v).TrimEnd('\\', '/'); } catch { return v; }
        }
        static bool Shows(string value, string option) { return value == option || (IsPath(option) && IsPath(value) && string.Equals(StandardPath(value), StandardPath(option), StringComparison.OrdinalIgnoreCase)); }
        static bool Lists(string label, string option) { return label == option || (IsPath(option) && string.Equals(label, Path.GetFileName(StandardPath(option)), StringComparison.OrdinalIgnoreCase)); }
        static string[] PickOnPage(string label, string option)
        {
            PageControl item = PageControlNamed(label);
            if (item == null) return new[] { "no_control", appName + "的新建会话页上现在没有「" + label + "」这一项" };
            if (item.Kind == "toggle")
            {
                if (option != "on" && option != "off") return new[] { "usage", "开关只能选 on 或 off" };
                if (item.Value != option) { Toggle(item.Element); Until(1.2, () => { PageControl now = PageControlNamed(label); return now != null && now.Value == option; }); }
                PageControl after = PageControlNamed(label);
                return after != null && after.Value == option ? null : new[] { "not_set", "在 " + appName + "里按了「" + label + "」，但它没有变" };
            }
            if (Shows(item.Value, option)) return null;
            Func<Node> button = () => { PageControl now = PageControlNamed(label); return now == null ? null : now.Element; };
            if (!OpenMenu(button)) { HoldForeground(false); return new[] { "no_menu", "没能打开 " + appName + "新建会话页上的「" + label + "」菜单" }; }
            PageControl open = PageControlNamed(label);
            List<PageChoice> found = open == null ? new List<PageChoice>() : PageChoices(open);
            string shownName = IsPath(option) ? Path.GetFileName(StandardPath(option)) : option;
            PageChoice choice = found.FirstOrDefault(c => Lists(c.Label, option));
            if (choice == null) { CloseMenus(button); HoldForeground(false); return new[] { "unavailable", appName + "的「" + label + "」菜单里没有「" + shownName + "」" }; }
            if (choice.Selected) { CloseMenus(button); HoldForeground(false); return null; }
            Press(choice.Element);
            string[] stopped = null;
            bool took = Until(3.2, () =>
            {
                string[] error = newPageWatch(); if (error != null) { stopped = error; return true; }
                PageControl now = PageControlNamed(label);
                return now == null || now.Value != item.Value;
            });
            CloseMenus(button); HoldForeground(false);
            if (stopped != null) return stopped;
            return took ? null : new[] { "not_set", "在 " + appName + "里选了「" + shownName + "」，但「" + label + "」没有变" };
        }
        // new-controls / new-pick / new-leave, for a flow that can open its desktop's new-chat page.
        static void NewPageCommands(Func<string[]> open)
        {
            if (command == "new-leave")
            {
                bool onPage = Current().Length == 0;
                if (onPage && newPageInUse()) Out(new Dictionary<string, object> { { "ok", true }, { "left", false }, { "inUse", true } });
                if (onPage && parkedPrevious.Length > 0) Show(parkedPrevious, "");
                Out(new Dictionary<string, object> { { "ok", true }, { "left", onPage } });
            }
            string before = Current(), previous = before.Length == 0 ? parkedPrevious : before;
            Action goBack = () => { if (!staying && previous.Length > 0) Show(previous, ""); };
            string[] failed = open();
            if (failed != null) { if (previous.Length > 0) Show(previous, ""); Fail(failed[0], failed[1]); }
            // A page just opened fills in for a moment: read once its controls stop changing.
            if (before.Length > 0)
            {
                string last = ""; DateTime since = ActClock;
                Until(2.5, () => { string now = string.Join(" | ", PageControls().Select(c => c.Label + "=" + c.Value)); if (now != last) { last = now; since = ActClock; return false; } return (ActClock - since).TotalSeconds >= 0.4; });
            }
            if (command == "new-pick")
            {
                List<string> pairs = args.Skip(1).ToList();
                if (pairs.Count < 2 || pairs.Count % 2 != 0) { if (previous.Length > 0) Show(previous, ""); Fail("usage", "缺少要选的项和选项"); }
                List<string> picked = new List<string>(); bool moved = false;
                Action<string[]> answer = error =>
                {
                    if (moved)
                    {
                        Func<string> words = () => string.Join(" | ", newPageShown().Select(kv => kv.Key + "=" + kv.Value).OrderBy(s => s, StringComparer.Ordinal));
                        string last = words(); DateTime since = ActClock;
                        Until(1.5, () => { string now = words(); if (now != last) { last = now; since = ActClock; return false; } return (ActClock - since).TotalSeconds >= 0.3; });
                    }
                    List<object> shown = ListPageControls(null); Dictionary<string, object> menus = newPageShown(); goBack();
                    Dictionary<string, object> o = new Dictionary<string, object> { { "ok", error == null }, { "controls", shown }, { "picked", picked }, { "shown", menus }, { "previous", previous }, { "stayed", staying } };
                    if (error != null) { o["code"] = error[0]; o["error"] = error[1]; }
                    Out(o);
                };
                for (int i = 0; i + 1 < pairs.Count; i += 2)
                {
                    PageControl was = PageControlNamed(pairs[i]);
                    string[] error = PickOnPage(pairs[i], pairs[i + 1]);
                    if (error != null) answer(error);
                    PageControl now = PageControlNamed(pairs[i]);
                    if (was != null && was.Kind == "menu" && (now == null || now.Value != was.Value)) moved = true;
                    picked.Add(pairs[i]);
                }
                answer(null);
            }
            List<string> named = args.Skip(1).ToList();
            List<object> list = ListPageControls(label => named.Contains(label) || named.Contains("*"));
            Dictionary<string, object> shownMenus = newPageShown();
            goBack();
            Out(new Dictionary<string, object> { { "ok", true }, { "controls", list }, { "shown", shownMenus }, { "previous", previous }, { "stayed", staying } });
        }

        // ---- the shared commands, for an engine that has a flow ----
        // Each acting command parks the window first (chat-status only looks; open-file and show-session
        // bring the app forward, which the person asked for), waits for the page, and acts in the mode
        // the command is for.
        static readonly HashSet<string> sharedCommands = new HashSet<string> { "read-chat", "chat-status", "chat-new", "chat-send", "chat-stop", "open-file", "show-session" };
        // The shared commands this engine takes: every one, for a flow with commands of its own; only the
        // ones a flow with none names in `sharedTaken` (Antigravity: show-session and open-file).
        static readonly HashSet<string> sharedTaken = new HashSet<string>();
        static IEnumerable<string> Shared() { return sharedTaken.Count > 0 ? sharedTaken : flowCommands.Count > 0 ? (IEnumerable<string>)sharedCommands : new string[0]; }
        // The opening every acting command shares.
        static void Begin(bool park)
        {
            if (park) Park();
            if (!WaitReady(3.0)) FailPageEmpty();
            PrepareSpace();
        }
        static void RunShared()
        {
            if (command == "chat-status")
            {
                WaitReady(1.0);
                if (args.Count < 2 || args[1].Length == 0) Fail("usage", "缺少有效的会话 ID");
                bool shownChat = SameId(ChatID(), args[1]) && ChatRegion() != null;
                Out(new Dictionary<string, object> { { "ok", true }, { "shown", shownChat }, { "running", shownChat && Answering() }, { "front", Root(Win.GetForegroundWindow()) == window && !Native.IsIconic(window) } });
            }
            if (command == "open-file" || command == "show-session")
            {
                BringForward();
                Begin(false);
                if (args.Count < 2 || args[1].Length == 0) Fail("usage", "缺少会话标题");
                string localId = args.Count > 2 && args[2] != "-" ? args[2] : "";
                if (!Show(args[1], localId)) Fail("not_found", "没能在" + appName + "里打开这个会话");
                if (command == "show-session") Out(new Dictionary<string, object> { { "ok", true } });
                if (args.Count < 5) Fail("usage", "缺少会话标题或文件");
                string label = args.Count > 5 ? args[5] : "";
                List<KeyValuePair<Node, int>> hits = DrawnFileLinks(args[3], args[4], label);
                int best = hits.Count == 0 ? 0 : hits.Max(h => h.Value);
                Node link = hits.Where(h => h.Value == best).Select(h => h.Key).LastOrDefault();
                if (link != null) { Press(link); Wait(0.3); }
                BringForward();
                Out(new Dictionary<string, object> { { "ok", true }, { "pressed", link != null } });
            }
            Begin(true);
            RunChat();
        }

        // ---- an engine's flow ----
        // <engine>-desktop.cs, compiled with this file, names the commands it ports (DeclareFlow adds
        // them to `flowCommands`) and runs them (RunFlow). Without one, every acting command answers
        // `not_ported`.
        static readonly HashSet<string> flowCommands = new HashSet<string>();
        static partial void DeclareFlow();
        static partial void RunFlow();
        static string ReadInput() { using (StreamReader reader = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false))) return reader.ReadToEnd(); }

        // ---- the commands ----
        static void Run()
        {
            // First, whatever command this is: a window a helper left off screen when it was stopped
            // mid-park is put back (`restore` does only that; the server runs it after stopping one).
            int restored = Recover();
            if (command == "restore") Out(new Dictionary<string, object> { { "ok", true }, { "restored", restored } });
            LoadProfile();
            window = FindWindow();
            int self = IntegrityOf(Native.GetCurrentProcess());
            uint pid = 0; if (window != IntPtr.Zero) Native.GetWindowThreadProcessId(window, out pid);
            int app = window == IntPtr.Zero ? -1 : IntegrityOfPid(pid);
            // Windows has no accessibility permission to ask for. What it has is integrity levels (UIPI):
            // a process may read a window of a higher level's process but not act on it.
            bool trusted = app < 0 || self >= app;
            DeclareFlow();
            if (command == "check") Out(new Dictionary<string, object> { { "ok", true }, { "trusted", trusted }, { "running", window != IntPtr.Zero }, { "integrity", self }, { "appIntegrity", app }, { "ported", flowCommands.Concat(Shared()).ToList() } });
            if (Setting("exe").Length == 0) Fail("usage", "缺少桌面版在 Windows 上的配置（AX_PROFILE 的 windows.exe）");
            if (window == IntPtr.Zero) Fail("not_running", appName + "没有在运行");
            if (!trusted) Fail("not_trusted", appName + "以更高的权限运行（例如以管理员身份），工作台读得到它的界面但不能操作：请用相同的权限运行两者");
            try { uia = (IUIAutomation)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("e22ad333-b25f-460c-83d0-0581107395c9"), true)); }
            catch { uia = (IUIAutomation)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("ff48dba4-60ef-4201-aa87-54103eef594e"), true)); }

            // A command the engine's flow ports acts on the page: the flow parks the window first and
            // waits for the page itself (RunFlow).
            if (Shared().Contains(command)) RunShared();
            if (flowCommands.Contains(command))
            {
                RunFlow();
                Fail("not_ported", "Windows 上的桌面代发还在移植中，" + appName + "暂时不能通过窗口操作「" + command + "」");
            }
            // warm only looks; the others wait up to three seconds for the page.
            bool ready = WaitReady(command == "warm" ? 0 : 3.0);

            if (command == "warm")
            {
                Dictionary<string, object> answer = new Dictionary<string, object> { { "ok", true }, { "ready", ready } };
                if (args.Contains("check") && ready) { Dictionary<string, object> state = ProfileCheck(); answer["checked"] = true; answer["drift"] = state["drift"]; answer["differ"] = state["differ"]; }
                answer["elements"] = nodes.Count;
                Out(answer);
            }
            if (command == "probe")
            {
                Dictionary<string, object> state = ProfileCheck();
                state["ok"] = true; state["onScreen"] = OnScreen(); state["current"] = Current();
                if (unmappedRoles.Count > 0) state["unmappedRoles"] = unmappedRoles.OrderBy(r => r, StringComparer.Ordinal).ToList();
                Out(state);
            }
            if (command == "inspect")
            {
                Dictionary<string, object> report = new Dictionary<string, object>();
                IEnumerable<string> asked = args.Count > 1 ? args.Skip(1) : locators.Keys.OrderBy(k => k, StringComparer.Ordinal);
                foreach (string key in asked)
                {
                    report[key] = FindAll(key).Take(3).Select(hit =>
                    {
                        Dictionary<string, object> own = Facts(hit);
                        List<object> boxes = new List<object>();
                        for (int up = hit.Parent, i = 0; up >= 0 && i < 12; up = nodes[up].Parent, i++)
                        {
                            Dictionary<string, object> box = Facts(nodes[up]);
                            if (box.Count > 1) boxes.Add(box);
                            if (nodes[up].ControlType == CT_Document) break;
                        }
                        own["in"] = boxes;
                        return (object)own;
                    }).ToList();
                }
                Out(new Dictionary<string, object> { { "ok", true }, { "current", Current() }, { "controls", report } });
            }
            if (pageEmpty) FailPageEmpty();
            Fail("not_ported", "Windows 上的桌面代发还在移植中，" + appName + "暂时不能通过窗口操作「" + command + "」");
        }
    }
}
