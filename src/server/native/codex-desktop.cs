// Codex's desktop flows on Windows: the twin of codex-desktop.swift, on the shared driver
// (uia-driver.cs, compiled together with this file):
//   new <project|-|:none>   (first message on stdin: the desktop's New chat page sends it; a project
//                            named here is picked in the page's project menu first, ":none" works
//                            outside every project, "-" keeps what the page has picked)
//   new-shown               (what the New chat page's model button shows now, e.g. "GPT-6 Sol Medium":
//                            a new chat runs with it; nothing is picked)
//   new-leave               (the shared driver's: back to the person's chat, unless they write there)
//   settings <title>        (brings the chat up in the sidebar, then back to the person's chat: a window
//                            then owns it, and its model and effort are changed over the router; with
//                            --model, picked in the chat's own model menu, when the router cannot)
// new takes --model / --effort as the console names them ("GPT-6-Sol", "high").
//
// Everything else Codex does from the console needs no window: sending, steering and stopping go
// through its app-server and its windows' router (codex-bridge.ts, codex-desktop.ts), and so does an
// existing chat's model and effort (thread-follower-update-thread-settings), once a window owns the
// chat: only a chat the desktop has loaded since it started has an owner, so `settings` loads it
// (codex-bridge.ts pickInDesktop). A new chat is the exception: it has to be started by the desktop
// itself, so its own app-server owns the thread from the first turn on.
//
// On Windows the window is parked for these as for Claude's (uia-driver.cs, "the window"): off the
// screen but for a corner, the foreground given straight back, held only while a menu is open. Two
// differences from the Mac, both because no key is sent on Windows:
// - The effort is a slider row ("Power") moved only with the arrow keys (measured: no RangeValue, no
//   Value pattern). A new chat whose effort differs from what the New chat page shows is not
//   started; the page is told why, before anything on the page was touched.
// - A Codex menu is not closed by Collapse (measured); a pick closes it. One left open is reported,
//   and nothing is sent.
// - `settings` picks a model in the chat's model menu (the Mac's fallback when the router cannot), but
//   not an effort: one other than the chat's is refused, as the slider takes only arrow keys.
// Tried on the real app: probes/windows/PLAN.md, "The round of real-app tests".
using System;
using System.Collections.Generic;
using System.Linq;

namespace Frontdesk.Driver
{
    public static partial class Helper
    {
        static partial void DeclareFlow()
        {
            foreach (string c in new[] { "new", "new-shown", "new-leave", "settings" }) flowCommands.Add(c);
        }

        // ---- Codex's own controls, named in profiles/codex.json ----
        static string NormModel(string text) { return (text ?? "").ToLowerInvariant().Replace("-", " ").Trim(); }
        static Node CodexModelMenu() { return Find("modelMenu"); }
        // "Change project: <name>" while the page has a project, "Choose project" while it has none.
        static Node ProjectMenu() { return Find("projectMenu") ?? Find("projectChooser"); }
        // What the closed model button says: "<model> <effort>", e.g. "GPT-6 Sol Medium".
        static string ShownLabel() { Node m = CodexModelMenu(); return m == null ? "" : m.Name; }
        static bool ShowsModel(string model) { string shown = NormModel(ShownLabel()), want = NormModel(model); return shown == want || shown.StartsWith(want + " ", StringComparison.Ordinal); }
        static bool ShowsEffort(string label) { return ShownLabel().EndsWith(" " + label, StringComparison.Ordinal); }
        // The model menu's "Select model" row, found by what the page declares for it, else by name.
        static Node SelectModelRow() { return Find("selectModelRow") ?? Item(Setting("selectModelItem")); }
        // A model row: a menu item, or (as Codex draws its list) a radio button with Invoke.
        static List<Node> ModelRows() { ReadPage(); return nodes.Where(n => RoleIs(n, "AXMenuItem") || n.ControlType == CT_RadioButton).ToList(); }
        static IEnumerable<Node> ChildrenOf(Node box) { return Within(box).Where(n => n.Parent == box.Index); }

        // ---- the New chat page ----
        static bool OnNewPage() { return Current().Length == 0 && ProjectMenu() != null && Find("composer") != null; }
        static bool OpenNewPage()
        {
            if (OnNewPage()) return true;
            Node start = Find("newChat");
            if (start == null || !Press(start)) return false;
            return Until(6, OnNewPage);
        }
        // The project's button is named "Change project: <name>": the project is what follows the
        // profile's "projectPrefix", or, named another way (another language), what follows its colon.
        static string ShownProject()
        {
            Node own = Find("projectMenu");
            if (own == null) return "";
            string prefix = Setting("projectPrefix");
            if (prefix.Length > 0 && own.Name.StartsWith(prefix, StringComparison.Ordinal)) return own.Name.Substring(prefix.Length);
            string after = AfterColon(own.Name);
            return after == own.Name ? "" : after;
        }
        // The project menu is a search box over a list of the desktop's projects, by name.
        static string[] PickProject(string project)
        {
            if (project == ":none")
            {
                if (Find("projectMenu") == null && Find("projectChooser") != null) return null;
                Node none = Find("noProject");
                if (none == null) return new[] { "no_project_menu", "Codex 桌面版的新建页上没有「不在项目里」这一项" };
                Press(none);
                if (Until(2.4, () => Find("projectMenu") == null && Find("projectChooser") != null)) return null;
                return new[] { "project_not_set", "在 Codex 桌面版里选了不在项目里，但项目没有切换过去" };
            }
            if (ShownProject() == project) return null;
            Func<string[], string[]> stop = error => { CloseMenus(ProjectMenu); HoldForeground(false); return error; };
            if (!OpenMenu(ProjectMenu, () => Find("projectList") != null)) return stop(new[] { "no_project_menu", "没能打开 Codex 桌面版的项目菜单" });
            Node list = Find("projectList");
            Func<Node, string> text = row => Within(row).Where(n => n.ControlType == CT_Text && n.Name.Trim().Length > 0).Select(n => n.Name.Trim()).FirstOrDefault() ?? Label(row);
            Node choice = list == null ? null : ChildrenOf(list).FirstOrDefault(row => text(row) == project);
            if (choice == null) return stop(new[] { "project_unavailable", "Codex 桌面版的项目菜单里没有「" + project + "」" });
            Press(choice);
            Until(2.4, () => ShownProject() == project);
            HoldForeground(false);
            if (Find("projectList") != null) return stop(new[] { "menu_open", "Codex 桌面版的项目菜单没有关上，没有发送：请到桌面版里关掉它" });
            if (ShownProject() != project) return new[] { "project_not_set", "在 Codex 桌面版里选了「" + project + "」，但项目没有切换过去" };
            return null;
        }

        // Moves the page's focus into the composer, which closes a menu a pick from behind left open (a
        // fill was seen to close the model menu, new below). The composer keeps what it held: its text
        // is set again, or, empty, a space is set and taken out.
        static void FocusComposer()
        {
            Node box = Find("composer");
            if (box == null) return;
            string held = HoldsText(box) ? box.Value : "";
            SetValue(box, held.Length > 0 ? held : " ");
            if (held.Length > 0) return;
            Wait(0.2);
            Node again = Find("composer");
            if (again != null) SetValue(again, "");
        }

        // The effort, checked before anything on the page is touched: the slider has no way in on
        // Windows but the arrow keys, so a level other than the one the page shows cannot be picked.
        static string[] EffortCheck(bool newPage = true)
        {
            string effort; if (!wanted.TryGetValue("effort", out effort) || string.IsNullOrEmpty(effort)) return null;
            Until(2, () => CodexModelMenu() != null);
            if (CodexModelMenu() == null) return new[] { "no_model_menu", "Codex 桌面版的输入框下面没有模型菜单" };
            string label; if (!StrMap(profile, "effortNames").TryGetValue(effort, out label)) return new[] { "effort_unavailable", "Codex 桌面版没有「" + effort + "」这一档推理强度" };
            if (ShowsEffort(label)) return null;
            if (!newPage) return new[] { "effort_keys", "Windows 上 Codex 桌面版的推理强度只能用方向键调，工作台不向桌面版发按键：请在桌面版里把这个聊天的推理强度调成「" + label + "」" };
            return new[] { "effort_keys", "Windows 上 Codex 桌面版的推理强度只能用方向键调，工作台不向桌面版发按键，没有新建：请先在桌面版的新建页上把推理强度调成「" + label + "」" };
        }
        // A model other than the one the composer shows, picked in the desktop's own model menu.
        static string[] PickModel(List<string> changed)
        {
            string model; if (!wanted.TryGetValue("model", out model) || string.IsNullOrEmpty(model)) return null;
            Until(2, () => CodexModelMenu() != null);
            if (CodexModelMenu() == null) return new[] { "no_model_menu", "Codex 桌面版的输入框下面没有模型菜单" };
            if (ShowsModel(model)) return null;
            Func<string[], string[]> stop = error => { CloseMenus(CodexModelMenu); HoldForeground(false); return error; };
            if (!OpenMenu(CodexModelMenu)) return stop(new[] { "no_model_menu", "没能打开 Codex 桌面版的模型菜单" });
            Node select = SelectModelRow();
            if (select == null) return stop(new[] { "no_model_menu", "Codex 桌面版的模型菜单里找不到选模型的入口" });
            Press(select);
            Node choice = null;
            Until(2.4, () => (choice = ModelRows().FirstOrDefault(n => NormModel(Label(n)) == NormModel(model))) != null);
            if (choice == null) return stop(new[] { "model_unavailable", "Codex 桌面版的模型菜单里没有 " + model });
            Press(choice);
            // Picked from behind, the menu goes back to its first page and stays open (Collapse does
            // not close it), and the button shows the model only once it closes (both measured: the
            // pick itself is made). The fill that follows moves the page's focus to the composer,
            // which closes it; RunFlow checks the button then, before Send.
            // (A menu that closes on a pick does so within about 0.1 s: the foreground is not held longer.)
            bool closed = Until(1.0, () => Menus() == 0);
            HoldForeground(false);
            if (closed && !Until(1.6, () => ShowsModel(model))) return new[] { "model_not_set", "在 Codex 桌面版里选了 " + model + "，但它没有切换过去" };
            changed.Add("model");
            return null;
        }

        static partial void RunFlow()
        {
            // settings <title>: the chat brought up in the sidebar and the person's chat back, so that a
            // window owns it (codex-bridge.ts pickInDesktop changes its settings over the router then).
            if (command == "settings")
            {
                string chat = args.Count > 1 ? args[1] : "";
                if (chat.Length == 0) Fail("usage", "缺少会话标题");
                Begin(true);
                string was = StartedOn();
                Action goBack = () => { if (was.Length > 0 && was != chat) Show(was, ""); };
                if (!Show(chat, "")) { goBack(); Fail("not_found", "没能在 Codex 桌面版的侧栏里找到这个聊天"); }
                Until(2, () => CodexModelMenu() != null);
                // An effort other than the chat's is refused before anything is touched (its slider takes
                // only arrow keys); a model is picked in the chat's own model menu, which needs no key.
                string[] tooFar = EffortCheck(false);
                if (tooFar != null) { goBack(); Fail(tooFar[0], tooFar[1]); }
                List<string> made = new List<string>();
                string[] unpicked = PickModel(made);
                if (unpicked != null) { goBack(); Fail(unpicked[0], unpicked[1]); }
                if (made.Contains("model"))
                {
                    string asked = wanted["model"];
                    if (!Until(0.3, () => Menus() == 0)) FocusComposer();
                    if (!Until(1.6, () => Menus() == 0)) { goBack(); Fail("menu_open", "Codex 桌面版的模型菜单没有关上，请到桌面版里关掉它"); }
                    if (!Until(1.6, () => ShowsModel(asked))) { goBack(); Fail("model_not_set", "在 Codex 桌面版里选了 " + asked + "，但它没有切换过去"); }
                }
                string shown = ShownLabel();
                goBack();
                Out(new Dictionary<string, object> { { "ok", true }, { "changed", made }, { "shown", shown } });
            }
            if (command == "new-leave")
            {
                newPageInUse = () => OnNewPage() && (Find("send") != null || HoldsText(Find("composer")));
                Begin(true);
                NewPageCommands(() => OpenNewPage() ? null : new[] { "no_new_page", "没能在 Codex 桌面版里打开新建聊天页" });
            }
            string text = command == "new" ? ReadInput() : "";
            if (command == "new" && text.Length == 0) Fail("usage", "消息是空的");
            Begin(true);
            string previous = StartedOn();
            Action back = () => ReturnTo(previous);

            if (command == "new-shown")
            {
                if (!OpenNewPage()) { back(); Fail("no_new_page", "没能在 Codex 桌面版里打开新建聊天页"); }
                Until(2, () => CodexModelMenu() != null);
                string shown = ShownLabel();
                // Left on the page when asked to stay (`--stay`): the answer names the conversation to go back to.
                if (!staying || shown.Length == 0) back();
                if (shown.Length == 0) Fail("no_model_menu", "Codex 桌面版的新建页上没有模型菜单");
                Out(new Dictionary<string, object> { { "ok", true }, { "shown", new Dictionary<string, object> { { "model", shown } } }, { "restored", previous }, { "previous", previous }, { "stayed", staying } });
            }

            // new: the desktop's New chat page takes the first message with what it has picked.
            string project = args.Count > 1 ? args[1] : "-";
            Action<string[]> giveUp = error => { Clear("composer"); back(); Fail(error[0], error[1]); };
            if (!OpenNewPage()) { back(); Fail("no_new_page", "没能在 Codex 桌面版里打开新建聊天页"); }
            string[] refused = EffortCheck();
            if (refused != null) { back(); Fail(refused[0], refused[1]); }
            List<string> changed = new List<string>();
            if (project != "-") { string[] e = PickProject(project); if (e != null) giveUp(e); changed.Add("project"); }
            string[] notPicked = PickModel(changed);
            if (notPicked != null) giveUp(notPicked);
            if (!Fill("composer", text, "send") || !OnNewPage()) giveUp(new[] { "fill_failed", "没能把消息填进 Codex 桌面版的输入框" });
            // A menu still open (the model menu after a pick) would take the press: nothing is sent.
            if (!Until(1.6, () => Menus() == 0)) giveUp(new[] { "menu_open", "Codex 桌面版的模型菜单没有关上，没有发送：请到桌面版里关掉它" });
            string picked; wanted.TryGetValue("model", out picked);
            if (changed.Contains("model") && !Until(1.6, () => ShowsModel(picked))) giveUp(new[] { "model_not_set", "在 Codex 桌面版里选了 " + picked + "，但它没有切换过去" });
            Node send = Find("send");
            if (send == null || !Press(send)) giveUp(new[] { "no_send", "Codex 桌面版没有出现发送按钮" });
            // The page becomes the new chat once the desktop has started it.
            bool started = Until(8, () => !OnNewPage() || Current().Length > 0);
            string title = Current();
            back();
            Out(new Dictionary<string, object> { { "ok", true }, { "started", started }, { "title", title }, { "restored", previous }, { "changed", changed } });
        }
    }
}
