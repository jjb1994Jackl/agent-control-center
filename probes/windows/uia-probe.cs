// The Windows probe: what the Mac accessibility driver (src/server/native/ax-driver.swift) relies on,
// measured through UI Automation on a Windows machine, before any of it is ported.
//
// Compiled by probe.ps1 with the csc.exe every Windows 10/11 ships (.NET Framework 4.x, C# 5), the way
// the Mac driver is compiled with swiftc on the person's machine: nothing is downloaded. UIA is reached
// through its COM interfaces (UIA3, the stack Narrator uses), not the managed System.Windows.Automation.
//
// Commands (each prints one JSON object, and writes it to --out <file> when given):
//   windows [--match <regex>]          the desktop apps' top-level windows: process, class, state, integrity
//   fg                                 the foreground window right now
//   ontop --hwnd <h>                   which top-level window is drawn at the centre of that window, and the foreground one
//   settle --hwnd <h> [--seconds 20] [--every 500]
//                                      how the page's tree grows from this first contact until it settles
//   census --hwnd <h> [--profile <json>] [--names]
//                                      what the page's controls carry besides their names (ClassName,
//                                      AutomationId, AcceleratorKey, AriaRole…), and how many controls each
//                                      of the profile's locators finds, way by way (the Mac driver's `probe`)
//   act --hwnd <h> --profile <json> (--locator <key> | --role <AXRole> [--name|--prefix|--contains <text>])
//       --do <press|invoke|default|expand|collapse|scroll|toggle|select|setvalue|clear|setrange|focus|inspect>
//       [--text <t>] [--only-if-current <t>] [--watch <key>] [--wait <ms>]
//                                      one pattern call on the one control found, and what it changed: the
//                                      foreground window, the menu rows on the page, the control's state
//   seq --hwnd <h> --profile <json> --steps <json file>
//                                      several act steps in one process, each optionally followed by waiting
//                                      (back-to-back page reads) until the menus or a locator show a change
//
// Nothing the person wrote leaves the probe: names and values are compared in here and only counts are
// printed. (--names adds the names of buttons, menu rows and headings, for a person reading their own
// output; never commit or share that.)
//
// The declarations of IUIAutomation, IUIAutomationElement, IUIAutomationTreeWalker,
// IUIAutomationCacheRequest, IUIAutomationElementArray and IUIAutomationInvokePattern follow those in
// vercel-labs/agent-desktop's probes/windows (Apache-2.0), which were checked against the Windows SDK's
// UIAutomationClient.h. Each interface is declared only as far as its last method used here (a COM
// vtable may be declared short at its end, never with a gap). The other patterns are declared here; a
// wrong interface id would fail as a cast, which the probe reports rather than crashes on.

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

namespace Frontdesk.Probe
{
    // ---- UI Automation, as COM ----
    [ComImport, Guid("352ffba8-0973-437c-a61f-f64cafd81df9"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IUIAutomationCondition { }

    [ComImport, Guid("14314595-b4bc-4055-95f2-58f2e42c9855"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IUIAutomationElementArray
    {
        int GetLength();
        IUIAutomationElement GetElement(int index);
    }

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
        int GetAutomationElementMode();
        void SetAutomationElementMode(int mode);
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
        IUIAutomationCondition CreateTrueCondition();
    }

    [ComImport, Guid("fb377fbe-8ea6-46d5-9c73-6499642d3059"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IUIAutomationInvokePattern { void Invoke(); }

    [ComImport, Guid("a94cd8b1-0844-4cd6-9d2d-640537ab39e9"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IUIAutomationValuePattern
    {
        void SetValue([MarshalAs(UnmanagedType.BStr)] string value);
        [return: MarshalAs(UnmanagedType.BStr)] string GetCurrentValue();
        int GetCurrentIsReadOnly();
    }

    [ComImport, Guid("59213f4f-7346-49e5-b120-80555987a148"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IUIAutomationRangeValuePattern
    {
        void SetValue(double value);
        double GetCurrentValue();
        int GetCurrentIsReadOnly();
        double GetCurrentMaximum();
        double GetCurrentMinimum();
        double GetCurrentLargeChange();
        double GetCurrentSmallChange();
    }

    [ComImport, Guid("619be086-1f4e-4ee4-bafa-210128738730"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IUIAutomationExpandCollapsePattern
    {
        void Expand();
        void Collapse();
        int GetCurrentExpandCollapseState();
    }

    [ComImport, Guid("b488300f-d015-4f19-9c29-bb595e3645ef"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IUIAutomationScrollItemPattern { void ScrollIntoView(); }

    [ComImport, Guid("94cf8058-9b8d-4ab9-8bfd-4cd0a33c8c70"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IUIAutomationTogglePattern { void Toggle(); int GetCurrentToggleState(); }

    [ComImport, Guid("a8efa66a-0fda-421a-9194-38021f3578ea"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IUIAutomationSelectionItemPattern { void Select(); void AddToSelection(); void RemoveFromSelection(); int GetCurrentIsSelected(); }

    [ComImport, Guid("828055ad-355b-4435-86d5-3b51c14a9b1b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IUIAutomationLegacyIAccessiblePattern { void Select(int flags); void DoDefaultAction(); }

    // Which virtual desktop a window is on (the Windows twin of a Mac window on another Space).
    [ComImport, Guid("a5cd92ff-29be-454c-8d04-d82879fb3f1b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IVirtualDesktopManager
    {
        [PreserveSig] int IsWindowOnCurrentVirtualDesktop(IntPtr topLevelWindow, out int onCurrentDesktop);
    }

    public static class Native
    {
        public delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
        [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
        [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc proc, IntPtr lParam);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, StringBuilder name, int max);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
        [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
        [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
        [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
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

    // One element of the page, as read once (the Mac driver's `known`: every attribute fetched together).
    public class Node
    {
        public int Index, End, Parent, Depth, ControlType, ExpandState = -1, ToggleState = -1;
        public string Name = "", Accel = "", AutomationId = "", ClassName = "", AriaRole = "", AriaProps = "", Value = "", Help = "", FullDescription = "", Localized = "", Framework = "";
        public bool IsDialog, Offscreen, PInvoke, PExpand, PValue, PRange, PScrollItem, PToggle, PSelItem, PText, PLegacy;
        public IUIAutomationElement Element;
        public bool HasPopupMark { get { return Regex.IsMatch(AriaProps, @"(^|;)\s*haspopup=(?!false)", RegexOptions.IgnoreCase); } }
        public bool ValueIsAddress { get { return Regex.IsMatch(Value, @"^(https?|file|about|chrome|app):", RegexOptions.IgnoreCase); } }
        public List<string> Classes { get { return ClassName.Split(new[] { ' ', '\t', '\n' }, StringSplitOptions.RemoveEmptyEntries).ToList(); } }
    }

    // A locator of the Mac profile (src/server/native/profiles/<id>.json), read as the Mac driver reads it.
    public class Loc
    {
        public string Key, Role, Name, Prefix, Contains, After, Inside, Has, Keys, Id, Subrole, Url;
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
            l.Id = Str(spec, "id"); l.Subrole = Str(spec, "subrole"); l.Url = Str(spec, "url");
            object v;
            if (spec.TryGetValue("roles", out v) && v is object[]) l.Roles = ((object[])v).Select(o => Convert.ToString(o)).ToList();
            if (spec.TryGetValue("class", out v)) { if (v is string) l.Classes.Add((string)v); else if (v is object[]) l.Classes = ((object[])v).Select(o => Convert.ToString(o)).ToList(); }
            if (spec.TryGetValue("named", out v) && v is bool) l.Named = (bool)v;
            if (spec.TryGetValue("popup", out v) && v is bool) l.Popup = (bool)v;
            if (spec.TryGetValue("index", out v) && v != null) l.Index = Convert.ToInt32(v, CultureInfo.InvariantCulture);
            return l;
        }
        static string Str(Dictionary<string, object> spec, string key) { object v; return spec.TryGetValue(key, out v) && v is string ? (string)v : null; }
    }

    public static class Program
    {
        // ---- the ids UIAutomationClient.h gives ----
        const int P_ProcessId = 30002, P_ControlType = 30003, P_Localized = 30004, P_Name = 30005, P_Accel = 30006, P_HasFocus = 30008,
            P_AutomationId = 30011, P_ClassName = 30012, P_Help = 30013, P_Offscreen = 30022, P_Framework = 30024,
            P_IsExpand = 30028, P_IsInvoke = 30031, P_IsRange = 30033, P_IsScrollItem = 30035, P_IsSelItem = 30036, P_IsText = 30040,
            P_IsToggle = 30041, P_IsValue = 30043, P_Value = 30045, P_ExpandState = 30070, P_ToggleState = 30086, P_IsLegacy = 30090,
            P_AriaRole = 30101, P_AriaProps = 30102, P_FullDescription = 30159, P_IsDialog = 30174;
        const int Pat_Invoke = 10000, Pat_Value = 10002, Pat_Range = 10003, Pat_Expand = 10005, Pat_SelItem = 10010, Pat_Toggle = 10015, Pat_ScrollItem = 10017, Pat_Legacy = 10018;
        const int CT_Button = 50000, CT_CheckBox = 50002, CT_ComboBox = 50003, CT_Edit = 50004, CT_Hyperlink = 50005, CT_Image = 50006, CT_List = 50008,
            CT_Menu = 50009, CT_MenuItem = 50011, CT_RadioButton = 50013, CT_Slider = 50015, CT_Text = 50020, CT_Custom = 50025, CT_Group = 50026,
            CT_Document = 50030, CT_Pane = 50033;
        static readonly Dictionary<int, string> ControlTypeNames = new Dictionary<int, string> {
            {50000,"Button"},{50001,"Calendar"},{50002,"CheckBox"},{50003,"ComboBox"},{50004,"Edit"},{50005,"Hyperlink"},{50006,"Image"},{50007,"ListItem"},
            {50008,"List"},{50009,"Menu"},{50010,"MenuBar"},{50011,"MenuItem"},{50012,"ProgressBar"},{50013,"RadioButton"},{50014,"ScrollBar"},{50015,"Slider"},
            {50016,"Spinner"},{50017,"StatusBar"},{50018,"Tab"},{50019,"TabItem"},{50020,"Text"},{50021,"ToolBar"},{50022,"ToolTip"},{50023,"Tree"},
            {50024,"TreeItem"},{50025,"Custom"},{50026,"Group"},{50027,"Thumb"},{50028,"DataGrid"},{50029,"DataItem"},{50030,"Document"},{50031,"SplitButton"},
            {50032,"Window"},{50033,"Pane"},{50034,"Header"},{50035,"HeaderItem"},{50036,"Table"},{50037,"TitleBar"},{50038,"Separator"},{50039,"SemanticZoom"},{50040,"AppBar"} };
        // The Mac subroles the profiles use, as the ARIA role Chromium reports on Windows.
        static readonly Dictionary<string, string> SubroleAria = new Dictionary<string, string> {
            {"AXDocumentArticle","article"},{"AXApplicationGroup","group"},{"AXApplicationStatus","status"},{"AXApplicationDialog","dialog"},
            {"AXApplicationAlertDialog","alertdialog"},{"AXApplicationAlert","alert"},{"AXLandmarkMain","main"},{"AXLandmarkNavigation","navigation"},
            {"AXLandmarkRegion","region"},{"AXTabPanel","tabpanel"} };

        static IUIAutomation uia;
        static Dictionary<string, string> opts = new Dictionary<string, string>();
        static HashSet<string> flags = new HashSet<string>();
        static string outFile;
        static readonly Stopwatch clock = Stopwatch.StartNew();

        static int MaxNodes = 20000, MaxDepth = 90;
        static List<Node> nodes = new List<Node>();
        static bool walkCached, walkTruncated;
        static string walkError;
        static Dictionary<string, List<Loc>> locators = new Dictionary<string, List<Loc>>();
        static HashSet<string> unmappedRoles = new HashSet<string>();
        // Whether Chromium puts haspopup into AriaProperties on this machine; when it does not, a button
        // that opens something is told by the ExpandCollapse pattern instead (see RoleIs).
        static bool popupMarked;

        [MTAThread]
        public static int Main(string[] argv)
        {
            try { Console.OutputEncoding = new UTF8Encoding(false); } catch { }
            string command = argv.Length > 0 ? argv[0] : "";
            for (int i = 1; i < argv.Length; i++)
            {
                string a = argv[i];
                if (!a.StartsWith("--")) continue;
                string k = a.Substring(2);
                if (i + 1 < argv.Length && !argv[i + 1].StartsWith("--")) { opts[k] = argv[i + 1]; i++; } else flags.Add(k);
            }
            outFile = Opt("out", null);
            try
            {
                if (command != "windows" && command != "fg" && command != "ontop")
                {
                    try { uia = (IUIAutomation)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("e22ad333-b25f-460c-83d0-0581107395c9"), true)); }
                    catch { uia = (IUIAutomation)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("ff48dba4-60ef-4201-aa87-54103eef594e"), true)); }
                }
                switch (command)
                {
                    case "windows": return Emit(Windows());
                    case "fg": return Emit(new Dictionary<string, object> { { "ok", true }, { "foreground", Foreground() } });
                    case "ontop": return Emit(new Dictionary<string, object> { { "ok", true }, { "onTop", OnTop(TargetWindow()) }, { "foreground", Foreground() } });
                    case "settle": return Emit(Settle());
                    case "census": return Emit(Census());
                    case "act": return Emit(Act());
                    case "seq": return Emit(Seq());
                    default: return Emit(Fail("usage", "commands: windows, fg, settle, census, act (see the top of uia-probe.cs)"));
                }
            }
            catch (Exception e) { return Emit(Fail("crashed", e.GetType().Name + ": " + e.Message)); }
        }

        static string Opt(string k, string fallback) { string v; return opts.TryGetValue(k, out v) ? v : fallback; }
        static int OptInt(string k, int fallback) { int v; return int.TryParse(Opt(k, ""), out v) ? v : fallback; }
        static Dictionary<string, object> Fail(string code, string message) { return new Dictionary<string, object> { { "ok", false }, { "code", code }, { "error", message } }; }
        static int Emit(Dictionary<string, object> result)
        {
            result["ms"] = (int)clock.ElapsedMilliseconds;
            JavaScriptSerializer json = new JavaScriptSerializer(); json.MaxJsonLength = int.MaxValue; json.RecursionLimit = 200;
            string text = json.Serialize(result);
            if (outFile != null)
            {
                // A failed write (a path past MAX_PATH, say) must not throw out of Main: say so on stdout instead.
                try { File.WriteAllText(outFile, text, new UTF8Encoding(false)); }
                catch (Exception e)
                {
                    Console.WriteLine(json.Serialize(Fail("out-not-written", e.GetType().Name + ": " + e.Message + " (" + outFile.Length + " characters)")));
                    Console.WriteLine(text);
                    return 2;
                }
            }
            Console.WriteLine(text);
            object ok; return result.TryGetValue("ok", out ok) && ok is bool && !(bool)ok ? 1 : 0;
        }

        // ---- windows and processes ----
        static string Home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        static string Private(string path) { return string.IsNullOrEmpty(path) || string.IsNullOrEmpty(Home) ? path : path.Replace(Home, "~"); }
        static string ExePath(uint pid)
        {
            IntPtr h = Native.OpenProcess(0x1000, false, pid);
            if (h == IntPtr.Zero) return "";
            try { StringBuilder sb = new StringBuilder(1024); int size = sb.Capacity; return Native.QueryFullProcessImageName(h, 0, sb, ref size) ? sb.ToString() : ""; }
            finally { Native.CloseHandle(h); }
        }
        // The process's mandatory label: 4096 low, 8192 medium, 12288 high, 16384 system.
        static int Integrity(IntPtr process)
        {
            IntPtr token;
            if (!Native.OpenProcessToken(process, 0x0008, out token)) return -1;
            try
            {
                int size; Native.GetTokenInformation(token, 25, IntPtr.Zero, 0, out size);
                if (size <= 0) return -1;
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
        static int IntegrityOf(uint pid)
        {
            IntPtr h = Native.OpenProcess(0x1000, false, pid);
            if (h == IntPtr.Zero) return -1;
            try { return Integrity(h); } finally { Native.CloseHandle(h); }
        }
        static string ClassOf(IntPtr hwnd) { StringBuilder sb = new StringBuilder(256); Native.GetClassName(hwnd, sb, sb.Capacity); return sb.ToString(); }
        static string TitleOf(IntPtr hwnd) { int n = Native.GetWindowTextLength(hwnd); StringBuilder sb = new StringBuilder(n + 2); Native.GetWindowText(hwnd, sb, sb.Capacity); return sb.ToString(); }
        static string Hex(IntPtr hwnd) { return "0x" + hwnd.ToInt64().ToString("x", CultureInfo.InvariantCulture); }
        // A title names the conversation on screen ("<chat> - Claude Code"): only what follows its last " - " is shown,
        // or the whole title where it is just the app's name.
        static Dictionary<string, object> TitleShape(string title)
        {
            int cut = title.LastIndexOf(" - ", StringComparison.Ordinal);
            return new Dictionary<string, object> { { "length", title.Length }, { "suffix", cut >= 0 ? title.Substring(cut) : (Regex.IsMatch(title, "^(claude|codex|chatgpt|antigravity)( [a-z]+)?$", RegexOptions.IgnoreCase) ? title : "") } };
        }
        static bool? OnCurrentDesktop(IntPtr hwnd)
        {
            try
            {
                IVirtualDesktopManager m = (IVirtualDesktopManager)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("aa509086-5ca9-4c25-8f95-589d3c07b48a")));
                int on; return m.IsWindowOnCurrentVirtualDesktop(hwnd, out on) == 0 ? (bool?)(on != 0) : null;
            }
            catch { return null; }
        }
        static Dictionary<string, object> WindowFacts(IntPtr hwnd)
        {
            uint pid; Native.GetWindowThreadProcessId(hwnd, out pid);
            Native.RECT r; Native.GetWindowRect(hwnd, out r);
            int cloaked; bool cloakRead = Native.DwmGetWindowAttribute(hwnd, 14, out cloaked, 4) == 0;
            string exe = ExePath(pid);
            return new Dictionary<string, object> {
                { "hwnd", Hex(hwnd) }, { "pid", (int)pid }, { "exe", Path.GetFileName(exe) }, { "path", Private(exe) },
                { "packaged", exe.IndexOf("\\WindowsApps\\", StringComparison.OrdinalIgnoreCase) >= 0 },
                { "class", ClassOf(hwnd) }, { "title", TitleShape(TitleOf(hwnd)) },
                { "visible", Native.IsWindowVisible(hwnd) }, { "minimized", Native.IsIconic(hwnd) },
                { "cloaked", cloakRead ? (object)cloaked : null }, { "onCurrentDesktop", OnCurrentDesktop(hwnd) },
                { "rect", new[] { r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top } },
                { "integrity", IntegrityOf(pid) } };
        }
        static Dictionary<string, object> Foreground()
        {
            IntPtr fg = Native.GetForegroundWindow();
            if (fg == IntPtr.Zero) return null;
            IntPtr root = Native.GetAncestor(fg, 3);
            if (root == IntPtr.Zero) root = fg;
            uint pid; Native.GetWindowThreadProcessId(root, out pid);
            return new Dictionary<string, object> { { "hwnd", Hex(root) }, { "pid", (int)pid }, { "exe", Path.GetFileName(ExePath(pid)) }, { "class", ClassOf(root) } };
        }
        // Which top-level window is drawn on top at the centre of the target window: being the foreground
        // window and being raised over the others are not the same thing, and only the second is seen.
        static Dictionary<string, object> OnTop(IntPtr target)
        {
            Native.RECT r; if (!Native.GetWindowRect(target, out r)) return null;
            Native.POINT p; p.X = (r.Left + r.Right) / 2; p.Y = (r.Top + r.Bottom) / 2;
            IntPtr at = Native.WindowFromPoint(p);
            if (at == IntPtr.Zero) return null;
            IntPtr root = Native.GetAncestor(at, 2);
            if (root == IntPtr.Zero) root = at;
            uint pid; Native.GetWindowThreadProcessId(root, out pid);
            return new Dictionary<string, object> { { "hwnd", Hex(root) }, { "exe", Path.GetFileName(ExePath(pid)) }, { "isTarget", root == target } };
        }
        static Dictionary<string, object> Windows()
        {
            Regex match = new Regex(Opt("match", "claude|codex|chatgpt|openai|antigravity"), RegexOptions.IgnoreCase);
            List<object> apps = new List<object>(); SortedSet<string> otherChromium = new SortedSet<string>();
            Native.EnumWindows(delegate (IntPtr hwnd, IntPtr l)
            {
                uint pid; Native.GetWindowThreadProcessId(hwnd, out pid);
                string exe = Path.GetFileName(ExePath(pid));
                string cls = ClassOf(hwnd);
                if (match.IsMatch(exe)) { if (Native.IsWindowVisible(hwnd) || (cls.StartsWith("Chrome_WidgetWin") && Native.GetWindowTextLength(hwnd) > 0)) apps.Add(WindowFacts(hwnd)); }
                else if (cls == "Chrome_WidgetWin_1" && Native.IsWindowVisible(hwnd)) otherChromium.Add(exe);
                return true;
            }, IntPtr.Zero);
            return new Dictionary<string, object> {
                { "ok", true }, { "self", new Dictionary<string, object> { { "integrity", Integrity(Native.GetCurrentProcess()) }, { "bits", IntPtr.Size * 8 } } },
                { "foreground", Foreground() }, { "windows", apps },
                { "otherChromiumApps", otherChromium.ToList() } };
        }

        // ---- reading the page ----
        static IntPtr TargetWindow()
        {
            string h = Opt("hwnd", "");
            long v = 0;
            if (h.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) long.TryParse(h.Substring(2), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out v); else long.TryParse(h, out v);
            IntPtr hwnd = new IntPtr(v);
            if (v == 0 || !Native.IsWindow(hwnd)) throw new ArgumentException("--hwnd is not a window (take one from the windows command)");
            return hwnd;
        }
        static readonly int[] WalkProps = { P_ControlType, P_Localized, P_Name, P_Accel, P_AutomationId, P_ClassName, P_Help, P_Offscreen, P_Framework,
            P_IsExpand, P_IsInvoke, P_IsRange, P_IsScrollItem, P_IsSelItem, P_IsText, P_IsToggle, P_IsValue, P_Value, P_ExpandState, P_ToggleState,
            P_IsLegacy, P_AriaRole, P_AriaProps, P_FullDescription, P_IsDialog };
        static IUIAutomationCacheRequest MakeCache()
        {
            IUIAutomationCacheRequest cache = uia.CreateCacheRequest();
            foreach (int id in WalkProps) { try { cache.AddProperty(id); } catch { } }
            cache.SetTreeScope(7);                                  // the element and everything under it
            cache.SetTreeFilter(uia.GetRawViewCondition());          // the raw view, like the Mac tree
            return cache;
        }
        static object Read(IUIAutomationElement e, int id, bool cached)
        {
            try { object v = cached ? e.GetCachedPropertyValue(id) : e.GetCurrentPropertyValue(id); return v != null && Marshal.IsComObject(v) ? null : v; }
            catch { return null; }
        }
        static string S(object v) { return v as string ?? ""; }
        static bool B(object v) { return v is bool && (bool)v; }
        static int I(object v, int fallback) { return v is int ? (int)v : fallback; }
        static Node Describe(IUIAutomationElement e, bool cached)
        {
            Node n = new Node(); n.Element = e;
            n.ControlType = I(Read(e, P_ControlType, cached), 0); n.Localized = S(Read(e, P_Localized, cached));
            n.Name = S(Read(e, P_Name, cached)); n.Accel = S(Read(e, P_Accel, cached)); n.AutomationId = S(Read(e, P_AutomationId, cached));
            n.ClassName = S(Read(e, P_ClassName, cached)); n.Help = S(Read(e, P_Help, cached)); n.Offscreen = B(Read(e, P_Offscreen, cached));
            n.Framework = S(Read(e, P_Framework, cached)); n.Value = S(Read(e, P_Value, cached));
            n.PExpand = B(Read(e, P_IsExpand, cached)); n.PInvoke = B(Read(e, P_IsInvoke, cached)); n.PRange = B(Read(e, P_IsRange, cached));
            n.PScrollItem = B(Read(e, P_IsScrollItem, cached)); n.PSelItem = B(Read(e, P_IsSelItem, cached)); n.PText = B(Read(e, P_IsText, cached));
            n.PToggle = B(Read(e, P_IsToggle, cached)); n.PValue = B(Read(e, P_IsValue, cached)); n.PLegacy = B(Read(e, P_IsLegacy, cached));
            n.ExpandState = I(Read(e, P_ExpandState, cached), -1); n.ToggleState = I(Read(e, P_ToggleState, cached), -1);
            n.AriaRole = S(Read(e, P_AriaRole, cached)); n.AriaProps = S(Read(e, P_AriaProps, cached));
            n.FullDescription = S(Read(e, P_FullDescription, cached)); n.IsDialog = B(Read(e, P_IsDialog, cached));
            return n;
        }
        static void AddCached(IUIAutomationElement e, int parent, int depth)
        {
            if (nodes.Count >= MaxNodes || depth > MaxDepth) { walkTruncated = true; return; }
            Node n = Describe(e, true); n.Parent = parent; n.Depth = depth; n.Index = nodes.Count; nodes.Add(n);
            IUIAutomationElementArray kids = null;
            try { kids = e.GetCachedChildren(); } catch { }
            if (kids != null) { int count = kids.GetLength(); for (int i = 0; i < count; i++) AddCached(kids.GetElement(i), n.Index, depth + 1); }
            n.End = nodes.Count - 1;
        }
        static void AddLive(IUIAutomationTreeWalker walker, IUIAutomationElement e, int parent, int depth)
        {
            if (nodes.Count >= MaxNodes || depth > MaxDepth) { walkTruncated = true; return; }
            Node n = Describe(e, false); n.Parent = parent; n.Depth = depth; n.Index = nodes.Count; nodes.Add(n);
            IUIAutomationElement child = null;
            try { child = walker.GetFirstChildElement(e); } catch { }
            while (child != null)
            {
                AddLive(walker, child, n.Index, depth + 1);
                try { child = walker.GetNextSiblingElement(child); } catch { child = null; }
            }
            n.End = nodes.Count - 1;
        }
        // Reads the whole page once: in one round trip (a cache request over the raw view), or, where the
        // provider refuses that, element by element.
        static int ReadPage(IntPtr hwnd)
        {
            nodes = new List<Node>(); walkTruncated = false; walkError = null; walkCached = false;
            Stopwatch took = Stopwatch.StartNew();
            IUIAutomationElement root = uia.ElementFromHandle(hwnd);
            IUIAutomationElement cachedRoot = null;
            try { cachedRoot = root.BuildUpdatedCache(MakeCache()); } catch (Exception e) { walkError = e.Message; }
            if (cachedRoot != null) { walkCached = true; AddCached(cachedRoot, -1, 0); }
            else AddLive(uia.GetRawViewWalker(), root, -1, 0);
            popupMarked = nodes.Any(n => n.AriaProps.IndexOf("haspopup=", StringComparison.OrdinalIgnoreCase) >= 0);
            return (int)took.ElapsedMilliseconds;
        }
        static Dictionary<string, object> PageFacts(int ms)
        {
            return new Dictionary<string, object> { { "nodes", nodes.Count }, { "readMs", ms }, { "oneRoundTrip", walkCached }, { "truncated", walkTruncated }, { "cacheError", walkError } };
        }

        // ---- settle: how the tree grows after a client first asks for it ----
        static Dictionary<string, object> Settle()
        {
            IntPtr hwnd = TargetWindow();
            int seconds = OptInt("seconds", 20), every = OptInt("every", 500);
            List<object> timeline = new List<object>();
            int first = -1, most = 0, mostAt = 0;
            while (clock.ElapsedMilliseconds < seconds * 1000L)
            {
                int at = (int)clock.ElapsedMilliseconds, ms = ReadPage(hwnd);
                if (first < 0) first = nodes.Count;
                if (nodes.Count > most) { most = nodes.Count; mostAt = at; }
                timeline.Add(new[] { at, nodes.Count, ms });
                Thread.Sleep(every);
            }
            return new Dictionary<string, object> { { "ok", true }, { "window", WindowFacts(hwnd) }, { "firstRead", first }, { "most", most }, { "mostAtMs", mostAt },
                { "timeline", timeline }, { "note", "timeline rows are [ms since start, nodes, ms the read took]; a first read is first contact only if no other UI Automation client (Narrator, Inspect, a previous run) has asked since the app started" } };
        }

        // ---- the profile's locators, matched as the Mac driver matches them ----
        static void LoadProfile()
        {
            string path = Opt("profile", null);
            if (path == null) return;
            Dictionary<string, object> profile = new JavaScriptSerializer().DeserializeObject(File.ReadAllText(path, Encoding.UTF8)) as Dictionary<string, object>;
            object raw;
            if (profile == null || !profile.TryGetValue("locators", out raw) || !(raw is Dictionary<string, object>)) return;
            foreach (KeyValuePair<string, object> kv in (Dictionary<string, object>)raw)
            {
                List<Loc> ways = new List<Loc>();
                if (kv.Value is Dictionary<string, object>) ways.Add(Loc.From(kv.Key, (Dictionary<string, object>)kv.Value));
                else if (kv.Value is object[]) foreach (object o in (object[])kv.Value) { if (o is Dictionary<string, object>) ways.Add(Loc.From(kv.Key, (Dictionary<string, object>)o)); }
                locators[kv.Key] = ways;
            }
        }
        // A Mac role, as what Chromium shows on Windows. A first guess the census checks: it reports what the
        // page's controls are, and which roles had no counterpart here.
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
            return want.EndsWith("*") ? has.Any(c => c.StartsWith(want.Substring(0, want.Length - 1), StringComparison.Ordinal)) : has.Contains(want);
        }
        static bool Fits(Node n, Loc l)
        {
            if (l.Role != null && !RoleIs(n, l.Role)) return false;
            if (l.Roles.Count > 0 && !l.Roles.Any(r => RoleIs(n, r))) return false;
            if (l.Subrole != null) { string aria; if (!SubroleAria.TryGetValue(l.Subrole, out aria)) { unmappedRoles.Add(l.Subrole); return false; } if (n.AriaRole != aria) return false; }
            if (l.Id != null && n.AutomationId != l.Id) return false;
            if (l.Keys != null && n.Accel != l.Keys) return false;
            foreach (string want in l.Classes) if (!HasClass(n, want)) return false;
            if (l.Popup.HasValue && (n.HasPopupMark || n.PExpand) != l.Popup.Value) return false;
            if (l.Url != null) { if (n.ControlType != CT_Document) return false; string own = n.Value; if (l.Url.EndsWith("*") ? !own.StartsWith(l.Url.Substring(0, l.Url.Length - 1), StringComparison.Ordinal) : own != l.Url) return false; }
            if (!l.Worded && !l.Named) return true;
            string described = (n.Name + " " + (n.FullDescription.Length > 0 ? n.FullDescription : n.Help)).Trim();
            string[] names = { n.Name, described };
            if (l.Name != null && !names.Contains(l.Name)) return false;
            if (l.Prefix != null && !names.Any(s => s.StartsWith(l.Prefix, StringComparison.Ordinal))) return false;
            if (l.Contains != null && !names.Any(s => s.IndexOf(l.Contains, StringComparison.OrdinalIgnoreCase) >= 0)) return false;
            if (l.Named && names.All(s => s.Length == 0)) return false;
            return true;
        }
        static IEnumerable<Node> Within(Node box) { for (int i = box.Index; i <= box.End && i < nodes.Count; i++) yield return nodes[i]; }
        static List<Node> Matches(Loc l, int depth)
        {
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
        static List<Node> FindAll(string key, int depth)
        {
            List<Loc> ways; if (!locators.TryGetValue(key, out ways)) return new List<Node>();
            foreach (Loc l in ways) { List<Node> hits = Matches(l, depth); if (hits.Count > 0) return hits; }
            return new List<Node>();
        }
        static Node Find(string key, int depth) { List<Node> hits = FindAll(key, depth); return hits.Count > 0 ? hits[0] : null; }

        // The Mac `probe`, on this page: per locator, how many each way finds, and the same three verdicts.
        static Dictionary<string, object> ProfileCheck()
        {
            Dictionary<string, object> perLocator = new Dictionary<string, object>();
            List<string> differ = new List<string>(), drift = new List<string>(), missing = new List<string>();
            Dictionary<string, object> several = new Dictionary<string, object>();
            foreach (string key in locators.Keys.OrderBy(k => k, StringComparer.Ordinal))
            {
                List<Loc> list = locators[key];
                List<List<Node>> each = list.Select(l => Matches(l, 0)).ToList();
                int at = each.FindIndex(h => h.Count > 0);
                List<object> ways = new List<object>();
                for (int i = 0; i < list.Count; i++)
                {
                    Dictionary<string, object> way = new Dictionary<string, object> { { "kind", list[i].Kind }, { "found", each[i].Count } };
                    if (list[i].Keys != null && list[i].Keys.Contains("Meta"))
                    {
                        string asControl = list[i].Keys.Replace("Meta", "Control");
                        way["foundWithControlForMeta"] = nodes.Count(n => n.Accel == asControl);
                    }
                    ways.Add(way);
                }
                perLocator[key] = new Dictionary<string, object> { { "found", at >= 0 ? each[at].Count : 0 }, { "by", at >= 0 ? (object)at : null }, { "ways", ways } };
                if (at < 0) missing.Add(key);
                if (at >= 0 && !list[at].Placed && each[at].Count > 1)
                {
                    bool singled = Enumerable.Range(0, list.Count).Any(j => j != at && !list[j].Placed && each[j].Count == 1 && each[j][0] == each[at][0]);
                    if (!singled) several[key] = each[at].Count;
                }
                List<Node> firsts = each.Where(h => h.Count > 0).Select(h => h[0]).ToList();
                if (firsts.Count > 1 && firsts.Any(f => f != firsts[0])) differ.Add(key);
                if (at > 0 && Enumerable.Range(0, at).Any(j => list[j].Kind == "mark")) drift.Add(key);
            }
            List<string> profileClasses = locators.Values.SelectMany(w => w).SelectMany(way => way.Classes).Distinct().OrderBy(token => token, StringComparer.Ordinal).ToList();
            Dictionary<string, object> classTokens = new Dictionary<string, object>();
            foreach (string c in profileClasses) classTokens[c] = nodes.Count(n => HasClass(n, c));
            return new Dictionary<string, object> {
                { "locators", perLocator }, { "missing", missing }, { "differ", differ }, { "drift", drift }, { "several", several },
                { "profileClassTokens", classTokens }, { "unmappedRoles", unmappedRoles.OrderBy(r => r).ToList() },
                { "note", "drift here: a way that goes by a mark found nothing while a later way did — on Windows that usually means the mark (class, keys, id) is not exposed, not that the app changed" } };
        }

        static Dictionary<string, object> Tally(IEnumerable<string> values, int top)
        {
            Dictionary<string, object> outMap = new Dictionary<string, object>();
            foreach (var group in values.Where(v => !string.IsNullOrEmpty(v)).GroupBy(v => v).OrderByDescending(x => x.Count()).ThenBy(x => x.Key, StringComparer.Ordinal).Take(top)) outMap[group.Key] = group.Count();
            return outMap;
        }
        // An address keeps its origin and first path segment (a chat's id comes after them).
        static string Address(string url)
        {
            Match m = Regex.Match(url, @"^([a-z]+:(//[^/?#]*)?)(/[^/?#]*)?", RegexOptions.IgnoreCase);
            return m.Success ? m.Groups[1].Value + m.Groups[3].Value : "";
        }

        static Dictionary<string, object> Census()
        {
            IntPtr hwnd = TargetWindow();
            LoadProfile();
            int ms = ReadPage(hwnd);
            List<Node> web = nodes.Where(n => n.Framework == "Chrome").ToList();
            List<Node> marked = web.Count > 0 ? web : nodes;
            Func<Func<Node, bool>, Dictionary<string, object>> share = pick => { int c = marked.Count(pick); return new Dictionary<string, object> { { "count", c }, { "of", marked.Count } }; };
            Dictionary<string, object> marks = new Dictionary<string, object> {
                { "className", share(n => n.ClassName.Length > 0 && !n.ClassName.StartsWith("Chrome_")) },
                { "automationId", share(n => n.AutomationId.Length > 0) },
                { "acceleratorKey", share(n => n.Accel.Length > 0) },
                { "ariaRole", share(n => n.AriaRole.Length > 0) },
                { "ariaProperties", share(n => n.AriaProps.Length > 0) },
                { "ariaPropertiesWithHaspopup", share(n => n.AriaProps.IndexOf("haspopup=", StringComparison.OrdinalIgnoreCase) >= 0) },
                { "fullDescription", share(n => n.FullDescription.Length > 0) },
                { "isDialog", share(n => n.IsDialog) } };
            Dictionary<string, object> patterns = new Dictionary<string, object> {
                { "invoke", nodes.Count(n => n.PInvoke) }, { "expandCollapse", nodes.Count(n => n.PExpand) }, { "value", nodes.Count(n => n.PValue) },
                { "rangeValue", nodes.Count(n => n.PRange) }, { "scrollItem", nodes.Count(n => n.PScrollItem) }, { "toggle", nodes.Count(n => n.PToggle) },
                { "selectionItem", nodes.Count(n => n.PSelItem) }, { "text", nodes.Count(n => n.PText) }, { "legacyIAccessible", nodes.Count(n => n.PLegacy) },
                { "buttons", nodes.Count(n => n.ControlType == CT_Button) },
                { "buttonsWithExpandCollapse", nodes.Count(n => n.ControlType == CT_Button && n.PExpand) },
                { "buttonsWithInvoke", nodes.Count(n => n.ControlType == CT_Button && n.PInvoke) },
                { "menuItemsWithExpandCollapse", nodes.Count(n => n.ControlType == CT_MenuItem && n.PExpand) } };
            Dictionary<string, object> result = new Dictionary<string, object> {
                { "ok", true }, { "label", Opt("label", "") }, { "window", WindowFacts(hwnd) }, { "page", PageFacts(ms) },
                { "frameworks", Tally(nodes.Select(n => n.Framework), 10) },
                { "controlTypes", Tally(nodes.Select(n => { string s; return ControlTypeNames.TryGetValue(n.ControlType, out s) ? s : n.ControlType.ToString(CultureInfo.InvariantCulture); }), 50) },
                { "ariaRoles", Tally(nodes.Select(n => n.AriaRole), 60) },
                { "marks", marks }, { "patterns", patterns },
                { "classTokens", Tally(marked.SelectMany(n => n.ClassName.StartsWith("Chrome_") ? new List<string>() : n.Classes), 80) },
                { "classSamples", marked.Where(n => n.ClassName.Length > 0 && !n.ClassName.StartsWith("Chrome_")).Select(n => n.ClassName.Length > 120 ? n.ClassName.Substring(0, 120) : n.ClassName).Distinct().Take(25).ToList() },
                { "acceleratorKeys", Tally(nodes.Select(n => n.Accel), 40) },
                { "automationIds", Tally(nodes.Select(n => n.AutomationId), 40) },
                { "ariaPropertySamples", nodes.Select(n => Regex.Replace(n.AriaProps, @"=[^;]*", "=…")).Where(s => s.Length > 0).Distinct().Take(15).ToList() },
                { "documents", nodes.Where(n => n.ControlType == CT_Document).Select(n => Address(n.Value)).Distinct().ToList() },
                { "localizedControlTypes", Tally(nodes.Select(n => n.Localized), 30) } };
            if (locators.Count > 0) result["profile"] = ProfileCheck();
            if (flags.Contains("names"))
                result["names"] = nodes.Where(n => n.ControlType == CT_Button || n.ControlType == CT_MenuItem || n.AriaRole == "heading" || n.ControlType == CT_ComboBox)
                    .Select(n => (ControlTypeNames.ContainsKey(n.ControlType) ? ControlTypeNames[n.ControlType] : "?") + " | " + (n.Name.Length > 40 ? n.Name.Substring(0, 40) + "…" : n.Name)).Distinct().Take(300).ToList();
            return result;
        }

        // ---- act: one pattern call, and what it changed ----
        static Loc AdHoc()
        {
            Dictionary<string, object> spec = new Dictionary<string, object>();
            foreach (string k in new[] { "role", "name", "prefix", "contains", "inside", "keys", "class", "id" }) { string v = Opt(k, null); if (v != null) spec[k] = v; }
            return spec.Count == 0 ? null : Loc.From("(ad hoc)", spec);
        }
        static Dictionary<string, object> State(IntPtr hwnd, string watch)
        {
            Dictionary<string, object> s = new Dictionary<string, object> {
                { "foreground", Foreground() }, { "onTop", OnTop(hwnd) }, { "nodes", nodes.Count },
                { "menuItems", nodes.Count(n => n.ControlType == CT_MenuItem) }, { "menus", nodes.Count(n => n.ControlType == CT_Menu || n.AriaRole == "menu") },
                { "dialogs", nodes.Count(n => n.IsDialog || n.AriaRole == "dialog" || n.AriaRole == "alertdialog") } };
            if (locators.ContainsKey("menuPopup")) s["menuPopup"] = FindAll("menuPopup", 0).Count;
            if (watch != null) s["watch"] = new Dictionary<string, object> { { "locator", watch }, { "found", FindAll(watch, 0).Count } };
            return s;
        }
        static Dictionary<string, object> Facts(Node n)
        {
            Dictionary<string, object> f = new Dictionary<string, object> {
                { "controlType", ControlTypeNames.ContainsKey(n.ControlType) ? ControlTypeNames[n.ControlType] : n.ControlType.ToString(CultureInfo.InvariantCulture) },
                { "ariaRole", n.AriaRole }, { "ariaProperties", Regex.Replace(n.AriaProps, @"(^|;)(?!haspopup|expanded|checked|selected|disabled|multiline|readonly)([^=;]+)=[^;]*", "$1$2=…") },
                { "className", n.ClassName.Length > 160 ? n.ClassName.Substring(0, 160) : n.ClassName }, { "automationId", n.AutomationId }, { "acceleratorKey", n.Accel },
                { "offscreen", n.Offscreen }, { "expandState", n.ExpandState }, { "toggleState", n.ToggleState }, { "valueLength", n.Value.Length },
                { "patterns", new Dictionary<string, object> { { "invoke", n.PInvoke }, { "expandCollapse", n.PExpand }, { "value", n.PValue }, { "rangeValue", n.PRange },
                    { "scrollItem", n.PScrollItem }, { "toggle", n.PToggle }, { "selectionItem", n.PSelItem }, { "text", n.PText }, { "legacyIAccessible", n.PLegacy } } } };
            if (flags.Contains("names")) f["name"] = n.Name;
            return f;
        }
        static T Pattern<T>(IUIAutomationElement e, int id) where T : class
        {
            try { object p = e.GetCurrentPattern(id); return p as T; } catch { return null; }
        }
        static Dictionary<string, object> Range(IUIAutomationElement e)
        {
            IUIAutomationRangeValuePattern r = Pattern<IUIAutomationRangeValuePattern>(e, Pat_Range);
            if (r == null) return null;
            try { return new Dictionary<string, object> { { "value", r.GetCurrentValue() }, { "min", r.GetCurrentMinimum() }, { "max", r.GetCurrentMaximum() }, { "small", r.GetCurrentSmallChange() }, { "readOnly", r.GetCurrentIsReadOnly() != 0 } }; }
            catch (Exception ex) { return new Dictionary<string, object> { { "error", ex.Message } }; }
        }

        // ---- seq: several act steps in one process, with no fixed pause between them ----
        // seq --hwnd <h> --profile <json> --steps <json file>
        // Each step: {"label", "args": {act options, e.g. "locator", "do", "text", "role", "prefix", "names": true} (no "args": only wait),
        //             "until": {"menus": ">=1" | "==0" | ">=2", "found": "<locator>"}, "timeoutMs": 6000, "stopOnFail": true}
        // A step's "until" is polled with back-to-back page reads. Times are milliseconds on the
        // machine-wide performance counter (qpcMs), so other tools' logs line up with them.
        static double QpcMs() { return Stopwatch.GetTimestamp() * 1000.0 / Stopwatch.Frequency; }
        static Dictionary<string, object> Seq()
        {
            IntPtr hwnd = TargetWindow();
            object[] steps = new JavaScriptSerializer().DeserializeObject(File.ReadAllText(Opt("steps", ""), Encoding.UTF8)) as object[];
            if (steps == null) return Fail("usage", "--steps <json file> holding an array of steps");
            Dictionary<string, string> baseOpts = new Dictionary<string, string>(opts);
            HashSet<string> baseFlags = new HashSet<string>(flags);
            List<object> log = new List<object>();
            bool allOk = true;
            foreach (object o in steps)
            {
                Dictionary<string, object> step = o as Dictionary<string, object>;
                if (step == null) continue;
                opts = new Dictionary<string, string>(baseOpts); flags = new HashSet<string>(baseFlags);
                opts["wait"] = "0";
                object a;
                if (step.TryGetValue("args", out a) && a is Dictionary<string, object>)
                    foreach (KeyValuePair<string, object> kv in (Dictionary<string, object>)a)
                    {
                        if (kv.Value is bool) { if ((bool)kv.Value) flags.Add(kv.Key); }
                        else opts[kv.Key] = Convert.ToString(kv.Value, CultureInfo.InvariantCulture);
                    }
                double start = QpcMs();
                // A step with no "args" acts on nothing: it only waits for its "until".
                Dictionary<string, object> r = step.ContainsKey("args") ? Act() : new Dictionary<string, object> { { "ok", true } };
                double acted = QpcMs();
                Dictionary<string, object> entry = new Dictionary<string, object> {
                    { "label", step.ContainsKey("label") ? step["label"] : "" }, { "startQpcMs", start }, { "actMs", (int)(acted - start) },
                    { "ok", r.ContainsKey("ok") ? r["ok"] : false } };
                foreach (string k in new[] { "used", "refused", "error", "code", "valueTookExactly", "foundAfter", "foregroundChanged", "targetCameForward" }) if (r.ContainsKey(k) && r[k] != null) entry[k] = r[k];
                object t; if (r.TryGetValue("targetAfter", out t) || r.TryGetValue("target", out t)) { Dictionary<string, object> f = t as Dictionary<string, object>; if (f != null) { if (f.ContainsKey("name")) entry["name"] = f["name"]; entry["valueLength"] = f["valueLength"]; } }
                object st; if (r.TryGetValue("after", out st) || r.TryGetValue("state", out st)) { Dictionary<string, object> s = st as Dictionary<string, object>; if (s != null) { entry["menus"] = s["menus"]; entry["foreground"] = s["foreground"]; } }
                bool ok = r.ContainsKey("ok") && r["ok"] is bool && (bool)r["ok"];
                object u;
                if (ok && step.TryGetValue("until", out u) && u is Dictionary<string, object>)
                {
                    Dictionary<string, object> until = (Dictionary<string, object>)u;
                    int timeout = step.ContainsKey("timeoutMs") ? Convert.ToInt32(step["timeoutMs"], CultureInfo.InvariantCulture) : 6000;
                    string menus = until.ContainsKey("menus") ? Convert.ToString(until["menus"]) : null, found = until.ContainsKey("found") ? Convert.ToString(until["found"]) : null;
                    bool met = false; int reads = 0, lastMenus = -1;
                    while (QpcMs() - acted < timeout)
                    {
                        ReadPage(hwnd); reads++;
                        lastMenus = nodes.Count(n => n.ControlType == CT_Menu || n.AriaRole == "menu");
                        bool m1 = menus == null || (menus.StartsWith(">=") ? lastMenus >= int.Parse(menus.Substring(2)) : lastMenus == int.Parse(menus.Substring(2)));
                        bool m2 = found == null || FindAll(found, 0).Count == 1;
                        if (m1 && m2) { met = true; break; }
                    }
                    entry["until"] = until; entry["untilMet"] = met; entry["untilMs"] = (int)(QpcMs() - acted); entry["untilReads"] = reads; entry["menusSeen"] = lastMenus; entry["nodesSeen"] = nodes.Count;
                    if (!met) ok = false;
                }
                entry["endQpcMs"] = QpcMs();
                log.Add(entry);
                if (!ok) { allOk = false; object sf; if (!step.TryGetValue("stopOnFail", out sf) || !(sf is bool) || (bool)sf) break; }
            }
            opts = baseOpts; flags = baseFlags;
            return new Dictionary<string, object> { { "ok", allOk }, { "steps", log } };
        }

        static Dictionary<string, object> Act()
        {
            IntPtr hwnd = TargetWindow();
            LoadProfile();
            string key = Opt("locator", null), what = Opt("do", "inspect"), watch = Opt("watch", null), text = Opt("text", null);
            int settle = OptInt("wait", 700);
            // (PowerShell 5 drops an empty argument, so clearing a box has a command of its own.)
            bool clearing = what == "clear";
            if (clearing) { what = "setvalue"; text = ""; }
            ReadPage(hwnd);
            List<Node> hits;
            string by;
            if (key != null)
            {
                List<Loc> ways;
                if (!locators.TryGetValue(key, out ways)) return Fail("usage", "the profile has no locator " + key);
                int at = ways.FindIndex(l => Matches(l, 0).Count > 0);
                hits = at >= 0 ? Matches(ways[at], 0) : new List<Node>();
                // A way that goes by its place ("after" another control) means the first of what follows,
                // as ax-driver.swift's find() takes it: one control by construction.
                if (at >= 0 && ways[at].Placed && hits.Count > 1) hits = hits.Take(1).ToList();
                by = at >= 0 ? key + " way " + at + " (" + ways[at].Kind + ")" : key;
            }
            else
            {
                Loc l = AdHoc();
                if (l == null) return Fail("usage", "give --locator <key>, or --role <AXRole> with --name/--prefix/--contains");
                hits = Matches(l, 0); by = "ad hoc";
            }
            // One control, or none: the Mac driver's rule before anything is done.
            if (hits.Count != 1) return new Dictionary<string, object> { { "ok", false }, { "code", hits.Count == 0 ? "not_found" : "ambiguous" }, { "found", hits.Count }, { "by", by }, { "page", PageFacts(0) } };
            Node target = hits[0];
            IUIAutomationElement e = target.Element;
            Dictionary<string, object> before = State(hwnd, watch), targetBefore = Facts(target);
            object rangeBefore = Range(e);
            if (what == "inspect")
                return new Dictionary<string, object> { { "ok", true }, { "by", by }, { "target", targetBefore }, { "range", rangeBefore }, { "state", before } };

            string used = null, error = null, refused = null;
            try
            {
                switch (what)
                {
                    case "press":
                        {
                            IUIAutomationInvokePattern inv = Pattern<IUIAutomationInvokePattern>(e, Pat_Invoke);
                            if (inv != null) { inv.Invoke(); used = "Invoke"; break; }
                            IUIAutomationExpandCollapsePattern ec = Pattern<IUIAutomationExpandCollapsePattern>(e, Pat_Expand);
                            if (ec != null) { if (ec.GetCurrentExpandCollapseState() == 0) ec.Expand(); else ec.Collapse(); used = "ExpandCollapse"; break; }
                            IUIAutomationLegacyIAccessiblePattern leg = Pattern<IUIAutomationLegacyIAccessiblePattern>(e, Pat_Legacy);
                            if (leg != null) { leg.DoDefaultAction(); used = "LegacyIAccessible.DoDefaultAction"; break; }
                            refused = "no Invoke, ExpandCollapse or LegacyIAccessible pattern"; break;
                        }
                    case "invoke": { var p = Pattern<IUIAutomationInvokePattern>(e, Pat_Invoke); if (p == null) refused = "no Invoke pattern"; else { p.Invoke(); used = "Invoke"; } break; }
                    case "default": { var p = Pattern<IUIAutomationLegacyIAccessiblePattern>(e, Pat_Legacy); if (p == null) refused = "no LegacyIAccessible pattern"; else { p.DoDefaultAction(); used = "LegacyIAccessible.DoDefaultAction"; } break; }
                    case "expand": { var p = Pattern<IUIAutomationExpandCollapsePattern>(e, Pat_Expand); if (p == null) refused = "no ExpandCollapse pattern"; else { p.Expand(); used = "ExpandCollapse.Expand"; } break; }
                    case "collapse": { var p = Pattern<IUIAutomationExpandCollapsePattern>(e, Pat_Expand); if (p == null) refused = "no ExpandCollapse pattern"; else { p.Collapse(); used = "ExpandCollapse.Collapse"; } break; }
                    case "scroll": { var p = Pattern<IUIAutomationScrollItemPattern>(e, Pat_ScrollItem); if (p == null) refused = "no ScrollItem pattern"; else { p.ScrollIntoView(); used = "ScrollItem.ScrollIntoView"; } break; }
                    case "toggle": { var p = Pattern<IUIAutomationTogglePattern>(e, Pat_Toggle); if (p == null) refused = "no Toggle pattern"; else { p.Toggle(); used = "Toggle"; } break; }
                    case "select": { var p = Pattern<IUIAutomationSelectionItemPattern>(e, Pat_SelItem); if (p == null) refused = "no SelectionItem pattern"; else { p.Select(); used = "SelectionItem.Select"; } break; }
                    case "focus": { e.SetFocus(); used = "SetFocus"; break; }
                    case "setrange":
                        {
                            double v; var p = Pattern<IUIAutomationRangeValuePattern>(e, Pat_Range);
                            if (p == null) refused = "no RangeValue pattern";
                            else if (!double.TryParse(text ?? "", NumberStyles.Float, CultureInfo.InvariantCulture, out v)) refused = "--text must be a number";
                            else { p.SetValue(v); used = "RangeValue.SetValue"; }
                            break;
                        }
                    case "setvalue":
                        {
                            var p = Pattern<IUIAutomationValuePattern>(e, Pat_Value);
                            if (p == null) { refused = "no Value pattern"; break; }
                            if (text == null) { refused = "--text is required (--do clear empties the box)"; break; }
                            // Never write over what the person has typed: only an empty box (or one showing its own
                            // name, the placeholder), or one holding exactly --only-if-current, is written to.
                            string current = p.GetCurrentValue() ?? "", allowed = Opt("only-if-current", null);
                            bool empty = current.Trim().Length == 0 || current == target.Name;
                            if (!empty && current != allowed) { refused = "the box holds text the probe did not write: left alone"; break; }
                            p.SetValue(text); used = "Value.SetValue";
                            break;
                        }
                    default: return Fail("usage", "unknown --do " + what);
                }
            }
            catch (Exception ex) { error = ex.GetType().Name + ": " + ex.Message; }

            Thread.Sleep(settle);
            ReadPage(hwnd);
            Dictionary<string, object> after = State(hwnd, watch);
            // The control again, as the page now shows it (found the same way, not the object the call used).
            List<Node> again = key != null ? FindAll(key, 0) : Matches(AdHoc(), 0);
            Dictionary<string, object> result = new Dictionary<string, object> {
                { "ok", refused == null && error == null }, { "by", by }, { "do", clearing ? "clear" : what }, { "used", used }, { "refused", refused }, { "error", error },
                { "target", targetBefore }, { "rangeBefore", rangeBefore }, { "before", before }, { "after", after }, { "foundAfter", again.Count } };
            if (again.Count == 1)
            {
                result["targetAfter"] = Facts(again[0]);
                result["rangeAfter"] = Range(again[0].Element);
                if (what == "setvalue" && used != null) result["valueTookExactly"] = again[0].Value == text;
            }
            object fb = before["foreground"], fa = after["foreground"];
            string fgBefore = fb is Dictionary<string, object> ? (string)((Dictionary<string, object>)fb)["hwnd"] : "", fgAfter = fa is Dictionary<string, object> ? (string)((Dictionary<string, object>)fa)["hwnd"] : "";
            result["foregroundChanged"] = fgBefore != fgAfter;
            result["targetCameForward"] = fgAfter == Hex(hwnd) && fgBefore != Hex(hwnd);
            if (refused != null) result["code"] = "refused";
            else if (error != null) result["code"] = "pattern_error";
            return result;
        }
    }
}
