// Claude's desktop flows on Windows: the twin of claude-desktop.swift, on the shared driver
// (uia-driver.cs, compiled together with this file):
//   send <title> <localId> [steer]   (message text on stdin)
//   settings <title> <localId>       (only changes the session's settings, sends nothing)
//   new <folder|-> [<control> <option>…]   (first message on stdin: the desktop's "New session" page)
//   new-controls / new-pick / new-leave    (that page's own choices: the shared NewPageCommands)
//   send-now <title> <localId>       (deliver the desktop's queued message right away)
//   stop <title> <localId>
//   answer <title> <localId> <question> [<option>]   (a question card in the chat; no option: Skip)
//   card <title> <localId> <ask> <recap> <replies JSON>            (the wrap-up card's own buttons)
//   action <title> <localId> <index> <ask> <recap> <replies JSON>  (press one of them)
// send, new and settings take --model / --effort / --mode as the desktop's own menus name them.
// The chat mode's commands, open-file and show-session are the shared driver's (RunShared).
//
// The window is parked first (uia-driver.cs, "parked in a corner"): off the screen but for a corner,
// with the foreground given straight back to the person's window each time the page takes it, and
// everything put back afterwards. The menus are the exception: they answer only while Claude holds
// the foreground, so a model, effort or mode change keeps it for the second or so the change takes
// (the window itself stays off screen). Measured in probes/windows/PLAN.md.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Web.Script.Serialization;

namespace Frontdesk.Driver
{
    public static partial class Helper
    {
        static partial void DeclareFlow()
        {
            foreach (string c in new[] { "send", "settings", "new", "new-controls", "new-pick", "new-leave", "send-now", "stop", "answer", "card", "action" }) flowCommands.Add(c);
        }

        // ---- Claude's own controls, named in profiles/claude.json ----
        static Node Composer() { return Find("composer"); }
        static Node ModelMenu() { return Find("modelMenu"); }
        static string ShownModel() { Node m = ModelMenu(); return m == null ? "" : AfterColon(m.Name); }
        static List<string> Modes { get { return Settings("modes"); } }
        // The permission mode's button: the first menu button after the model's that names a mode (or the first after it).
        static Node ModeMenu()
        {
            Node model = ModelMenu();
            if (model == null) return null;
            List<Node> after = nodes.Where(n => n.Index > model.Index && RoleIs(n, "AXPopUpButton")).ToList();
            return after.FirstOrDefault(b => Modes.Any(m => Named(b, m) || AfterColon(b.Name) == m || AfterColon(b.Name).StartsWith(m + " ", StringComparison.Ordinal))) ?? after.FirstOrDefault();
        }
        // The mode it shows, in the profile's words ("Auto"; the new-session page says "Permissions: Auto").
        static string ShownMode()
        {
            Node button = ModeMenu();
            if (button == null) return "";
            string bare = AfterColon(button.Name);
            return Modes.FirstOrDefault(m => bare == m || bare.StartsWith(m + " ", StringComparison.Ordinal)) ?? "";
        }

        class SettingsError { public string Code, Message; public SettingsError(string code, string message) { Code = code; Message = message; } }
        // Picks what was asked for where the composer shows something else. Returns why it stopped, or null.
        static SettingsError ApplySettings(List<string> changed, List<string> notes)
        {
            Func<string, string, SettingsError> stop = (code, message) =>
            {
                Node dialog = Dialog();
                if (dialog != null) { Node cancel = Find("cancel"); if (cancel != null) { Press(cancel); Wait(0.4); } }
                CloseMenus(ModelMenu); CloseMenus(ModeMenu);
                HoldForeground(false);
                return new SettingsError(code, message);
            };
            string model, effort, mode;
            wanted.TryGetValue("model", out model); wanted.TryGetValue("effort", out effort); wanted.TryGetValue("mode", out mode);
            if (!string.IsNullOrEmpty(model) || !string.IsNullOrEmpty(effort) || !string.IsNullOrEmpty(mode))
            {
                // A question left over the page (a model switch an earlier attempt did not get to confirm) hides the
                // composer's menus: it is answered with Cancel, which changes nothing, before anything is picked.
                Node leftover = Dialog();
                if (leftover != null) { Node cancel = Within(leftover).FirstOrDefault(n => RoleIs(n, "AXButton") && FindAll("cancel").Contains(n)); if (cancel != null) { Press(cancel); Until(1.5, () => Dialog() == null); } }
                Until(2, () => ModelMenu() != null);
            }
            if (!string.IsNullOrEmpty(model))
            {
                Func<bool> shown = () => { string now = ShownModel(); return now == model || now.StartsWith(model + " ", StringComparison.Ordinal); };
                if (!shown())
                {
                    if (!OpenMenu(ModelMenu)) return stop("no_model_menu", "没能打开 Claude 桌面版的模型菜单");
                    Node choice = Item(model);
                    if (choice == null)
                    {
                        Node more = Item(Setting("moreModelsItem"));
                        if (more != null) { Expand(more); Until(3, () => Item(model) != null); choice = Item(model); }
                    }
                    if (choice == null) return stop("model_unavailable", "Claude 桌面版的模型菜单里没有这个模型");
                    Press(choice);
                    // "Switch model?" in a session with history: the model was picked on purpose in the console.
                    bool confirmed = false;
                    for (int i = 0; i < 16; i++)
                    {
                        Wait(0.2);
                        Node box = Dialog();
                        if (!confirmed && box != null)
                        {
                            List<Node> confirms = FindAll("dialogConfirm");
                            List<Node> buttons = Within(box).Where(n => RoleIs(n, "AXButton") && confirms.Contains(n)).ToList();
                            if (buttons.Count != 1) continue;
                            string said = Within(box).Where(n => n.ControlType == CT_Text).Select(n => n.Name).OrderByDescending(s => s.Length).FirstOrDefault() ?? "";
                            if (said.Length > 0) notes.Add(said);
                            Press(buttons[0]); confirmed = true;
                        }
                        else if (shown()) break;
                    }
                    if (!confirmed && Dialog() != null) return stop("model_confirm", "切换模型时 Claude 桌面版弹出了确认，请到桌面版里操作");
                    CloseMenus(ModelMenu);
                    // The menus are closed: the foreground goes straight back (the button is read without it).
                    HoldForeground(false);
                    if (!Until(1, shown)) return stop("model_not_set", "在 Claude 桌面版里选了这个模型，但它没有切换过去");
                    changed.Add("model");
                }
            }
            if (!string.IsNullOrEmpty(effort) && !ShownModel().EndsWith(" " + effort, StringComparison.Ordinal))
            {
                string effortItem = Setting("effortItem").Length > 0 ? Setting("effortItem") : "Effort";
                if (!OpenMenu(ModelMenu)) return stop("no_model_menu", "没能打开 Claude 桌面版的模型菜单");
                Node own = Item(effortItem);
                if (own == null) return stop("effort_unavailable", "这个模型在 Claude 桌面版里不能调推理强度");
                if (own.Name != effortItem + " " + effort)
                {
                    Expand(own);
                    Func<Node> level = () => Items().FirstOrDefault(n => Named(n, effort) && !n.Name.StartsWith(effortItem, StringComparison.Ordinal));
                    if (!Until(3, () => Menus() >= 2 && level() != null)) return stop("no_effort_menu", "没能打开 Claude 桌面版的推理强度菜单");
                    Press(level());
                    Until(3, () => Menus() == 0);
                    HoldForeground(false);
                    if (!Until(1, () => ShownModel().EndsWith(" " + effort, StringComparison.Ordinal))) return stop("effort_not_set", "在 Claude 桌面版里选了这档推理强度，但它没有切换过去");
                    changed.Add("effort");
                }
                CloseMenus(ModelMenu);
            }
            if (!string.IsNullOrEmpty(mode))
            {
                Node button = ModeMenu();
                if (button == null) return stop("no_mode_menu", "没能打开 Claude 桌面版的权限菜单");
                if (ShownMode() != mode)
                {
                    if (!OpenMenu(ModeMenu)) return stop("no_mode_menu", "没能打开 Claude 桌面版的权限菜单");
                    Node choice = Item(mode);
                    if (choice == null) return stop("mode_unavailable", "Claude 桌面版的权限菜单里没有这个模式");
                    string locked = Setting("modeLockedSuffix").Length > 0 ? Setting("modeLockedSuffix") : "Enable";
                    if (choice.Name.EndsWith(" " + locked, StringComparison.Ordinal)) return stop("mode_locked", "Claude 桌面版里还没有启用这个权限模式，请先在桌面版里启用它");
                    Press(choice); Wait(0.4);
                    if (Dialog() != null) return stop("mode_confirm", "切换到这个权限模式需要在 Claude 桌面版里确认，请到桌面版里操作");
                    Until(2, () => Menus() == 0);
                    HoldForeground(false);
                    if (!Until(1, () => ShownMode() == mode)) return stop("mode_not_set", "在 Claude 桌面版里选了这个权限模式，但它没有切换过去");
                    changed.Add("mode");
                }
                CloseMenus(ModeMenu);
            }
            HoldForeground(false);
            return null;
        }

        // ---- the desktop's "New session" page ----
        static bool HeadingStarts(string words) { ReadPage(); return words.Length > 0 && nodes.Any(n => n.AriaRole == "heading" && Label(n).StartsWith(words, StringComparison.Ordinal)); }
        static bool OnNewPage() { return Current().Length == 0 && Composer() != null && (Find("newPage") != null || HeadingStarts(Setting("newPageHeading"))); }
        // Whether to trust a folder is the person's decision, made in the desktop app: never accept it here.
        static bool DeclineTrust()
        {
            if (!HeadingStarts(Setting("trustHeading"))) return false;
            Node cancel = Find("cancel"); if (cancel != null) { Press(cancel); Wait(0.25); }
            return true;
        }
        const string TrustMessage = "Claude 桌面版要先确认信任这个文件夹：请在桌面版里用它新建一次会话";
        static string[] OpenNewPage()
        {
            if (OnNewPage()) return null;
            Node start = Find("newChat");
            if (start == null) return new[] { "no_new_page", "Claude 桌面版的侧栏里没有找到新建按钮" };
            Press(start);
            bool trust = false;
            bool opened = Until(6, () => { trust = DeclineTrust(); return trust || OnNewPage(); });
            if (trust) return new[] { "trust", TrustMessage };
            if (!opened) Trace("not the new page: current='" + Current() + "' url='" + PageURL() + "' heading=" + HeadingStarts(Setting("newPageHeading")) + " composer=" + (Composer() != null) + " docs=" + string.Join(" | ", nodes.Where(n => n.ControlType == CT_Document).Select(n => n.Name)));
            return opened ? null : new[] { "no_new_page", "没能在 Claude 桌面版里打开新建会话页" };
        }

        // ---- the wrap-up card: its own buttons, by the names the desktop gives them ----
        static Node WrapUpCard(string ask, string recap)
        {
            List<Node> words = FindAll("transcript").SelectMany(box => Within(box).Where(n => n.ControlType == CT_Text && n.Name.Trim().Length > 0 && (n.Name.Trim() == ask || (ask.Length == 0 && n.Name.Trim() == recap)))).ToList();
            for (int w = words.Count - 1; w >= 0; w--)
            {
                Node box = words[w];
                for (int up = 0; up < 4 && box.Parent >= 0; up++)
                {
                    box = nodes[box.Parent];
                    if (Within(box).Any(n => RoleIs(n, "AXButton"))) return box;
                }
            }
            return null;
        }

        static partial void RunFlow()
        {
            if (command == "new-controls" || command == "new-pick" || command == "new-leave")
            {
                newPageWatch = () => DeclineTrust() ? new[] { "trust", TrustMessage } : null;
                newPageInUse = () => HoldsText(Composer());
                newPageShown = () => new Dictionary<string, object> { { "model", ShownModel() }, { "mode", ShownMode() } };
                Begin(true);
                NewPageCommands(OpenNewPage);
            }
            string title = args.Count > 1 ? args[1] : "", localId = args.Count > 2 ? args[2] : "";
            if (title.Length == 0) Fail("usage", "缺少会话标题");
            string text = command == "send" || command == "new" ? ReadInput() : "";
            if ((command == "send" || command == "new") && text.Length == 0) Fail("usage", "消息是空的");

            Begin(true);
            string previous = StartedOn(), previousAt = StartedAddress();
            // The session the command acts on, by its page's address ("/epitaxy/local_..."): two sessions may share a title.
            string target = localId.StartsWith("local_", StringComparison.Ordinal) ? Address(localId) : "";
            // Back to the session the person had on screen, by its address when both are known (it may
            // have the same title as this one and still be another session). ReturnTo: not while parked.
            Action back = () =>
            {
                if (previousAt.Length > 0 && target.Length > 0) { if (previousAt != target) ReturnTo(previous, previousAt); }
                else if (previous != title) ReturnTo(previous);
            };
            List<string> changed = new List<string>(), notes = new List<string>();

            if (command == "new")
            {
                // A new session is made by the desktop itself: its "New session" page takes the first
                // message with what that page has picked.
                string folder = title == "-" ? "" : Path.GetFullPath(title);
                Action<string, string> giveUp = (code, message) => { Clear("composer"); title = ""; back(); Fail(code, message); };
                string[] failed = OpenNewPage();
                if (failed != null) { title = ""; back(); Fail(failed[0], failed[1]); }
                if (folder.Length > 0 && PageControlNamed("Folder") != null) { string[] e = PickOnPage("Folder", folder); if (e != null) giveUp(e[0], e[1]); }
                // What the console showed as chosen: checked here, and picked where the page has moved on.
                List<string> expected = args.Skip(2).ToList();
                for (int i = 0; i + 1 < expected.Count; i += 2) { string[] e = PickOnPage(expected[i], expected[i + 1]); if (e != null) giveUp(e[0], e[1]); }
                SettingsError settingsError = ApplySettings(changed, notes);
                if (settingsError != null) giveUp(settingsError.Code, settingsError.Message);
                if (!Fill("composer", text, "send") || !OnNewPage()) giveUp("fill_failed", "没能把消息填进 Claude 桌面版的输入框");
                Node sendNew = Find("send");
                if (sendNew == null || !Press(sendNew)) giveUp("no_send", "Claude 桌面版没有出现发送按钮");
                bool started = Until(10, () => Current().Length > 0 || Find("stop") != null);
                title = "";
                back();
                Out(new Dictionary<string, object> { { "ok", true }, { "started", started }, { "restored", previous }, { "changed", changed }, { "notes", notes } });
            }

            if (!Show(title, localId)) { back(); Fail("not_found", "没能在 Claude 桌面版里打开这个会话"); }

            switch (command)
            {
                case "settings":
                    {
                        SettingsError error = ApplySettings(changed, notes);
                        Node mm = ModeMenu();
                        Dictionary<string, object> shownNow = new Dictionary<string, object> { { "model", ShownModel() }, { "mode", mm == null ? "" : mm.Name } };
                        back();
                        if (error != null) Out(new Dictionary<string, object> { { "ok", false }, { "code", error.Code }, { "error", error.Message }, { "changed", changed }, { "shown", shownNow } });
                        Out(new Dictionary<string, object> { { "ok", true }, { "changed", changed }, { "notes", notes }, { "shown", shownNow } });
                        break;
                    }
                case "send-now":
                    {
                        List<Node> now = FindAll("sendNow");
                        if (now.Count == 0) { back(); Fail("no_queue", "Claude 桌面版里没有排队中的消息"); }
                        Press(now[0]); Wait(0.5);
                        back(); Out(new Dictionary<string, object> { { "ok", true } });
                        break;
                    }
                case "stop":
                    {
                        Node stopButton = Find("stop");
                        if (stopButton == null) { back(); Fail("not_running", "这个会话在 Claude 桌面版里没有在运行"); }
                        if (!Press(stopButton)) { back(); Fail("not_stopped", "没能按下 Claude 桌面版的停止按钮"); }
                        bool stopped = false;
                        for (int i = 0; i < 12; i++) { Wait(0.25); if (!IsShown(title, target)) break; if (Find("stop") == null) { stopped = true; break; } }
                        back();
                        if (!stopped) Fail("not_stopped", "按了停止，但 Claude 桌面版还在运行");
                        Out(new Dictionary<string, object> { { "ok", true } });
                        break;
                    }
                case "answer":
                    {
                        if (args.Count < 4) { back(); Fail("usage", "缺少要回答的问题"); }
                        string[] error = AnswerCard(args[3], args.Count > 4 ? args[4] : null);
                        back();
                        if (error != null) Fail(error[0], error[1]);
                        Out(new Dictionary<string, object> { { "ok", true } });
                        break;
                    }
                case "card":
                case "action":
                    {
                        bool reading = command == "card"; int at = reading ? 3 : 4, index = 0;
                        if (args.Count <= at + 2 || (!reading && !int.TryParse(args[3], out index))) { back(); Fail("usage", "缺少卡片的内容"); }
                        string ask = args[at], recap = args[at + 1];
                        HashSet<string> replies = new HashSet<string>();
                        try { foreach (string r in new JavaScriptSerializer().Deserialize<string[]>(args[at + 2]) ?? new string[0]) replies.Add(r); } catch { }
                        HashSet<string> skip = new HashSet<string>(Settings("cardSkip"));
                        Func<Node, List<Node>> actions = box => Within(box).Where(n => RoleIs(n, "AXButton") && Label(n).Length > 0 && !skip.Contains(Label(n)) && !replies.Contains(Label(n))).ToList();
                        // The card is drawn a moment after the session is shown.
                        Node found = WrapUpCard(ask, recap);
                        for (int i = 0; i < 12 && (found == null || actions(found).Count == 0); i++) { Wait(0.25); found = WrapUpCard(ask, recap); }
                        if (found == null) { back(); Fail("no_card", "Claude 桌面版里没有找到这一轮的卡片"); }
                        List<Node> drawn = actions(found); List<string> names = drawn.Select(Label).ToList();
                        if (reading) { back(); Out(new Dictionary<string, object> { { "ok", true }, { "actions", names } }); }
                        if (index >= drawn.Count) { back(); Out(new Dictionary<string, object> { { "ok", false }, { "code", "no_action" }, { "error", "Claude 桌面版的这张卡片上已经没有这个按钮了" }, { "actions", names } }); }
                        string pressed = names[index];
                        // A chat card's buttons take a press only while the window is active, as the question
                        // card's do (uia-driver.cs, Activate): held for the press, given back right after.
                        HoldForeground(true); Activate();
                        Press(drawn[index]); Wait(0.3);
                        HoldForeground(false);
                        Wait(0.2);
                        back(); Out(new Dictionary<string, object> { { "ok", true }, { "pressed", pressed } });
                        break;
                    }
            }

            // send: while a turn runs the desktop shows Stop until the composer has text, then Send,
            // which queues the message into that turn. A plain send waits for the turn to end.
            bool steer = args.Count > 3 && args[3] == "steer";
            bool running = Find("stop") != null;
            if (running && !steer) { back(); Fail("busy", "这个会话正在 Claude 桌面版里运行，等这一轮结束再发"); }
            SettingsError sendError = ApplySettings(changed, notes);
            if (sendError != null) { back(); Out(new Dictionary<string, object> { { "ok", false }, { "code", sendError.Code }, { "error", sendError.Message }, { "changed", changed } }); }
            Node field = Composer();
            string draft = HoldsText(field) ? field.Value : "";
            if (!Fill("composer", text, "send"))
            {
                Put("composer", draft, 2.4);
                back();
                Fail("fill_failed", "没能把消息填进 Claude 桌面版的输入框");
            }
            Node send = Find("send");
            if (send == null || !Press(send)) { Put("composer", draft, 2.4); back(); Fail("no_send", "Claude 桌面版没有出现发送按钮"); }
            // The record, not this, says whether it went out; this only hints.
            System.Diagnostics.Stopwatch sentFor = System.Diagnostics.Stopwatch.StartNew();
            bool cleared = Until(3, () => Find("send") == null || Find("stop") != null || Composer() == null || !HoldsText(Composer()));
            Trace("sent: " + (cleared ? "the composer cleared after " : "the composer did not clear in ") + sentFor.ElapsedMilliseconds + "ms");
            // A message sent into a running turn waits in the desktop's own queue (its "Send now" shows) until
            // the turn's next step; the record has it only then (seen 30 s later on a turn with no steps).
            bool queued = steer && running && Until(1.5, () => FindAll("sendNow").Count > 0);
            if (cleared && draft.Length > 0) Put("composer", draft, 2.4);
            back();
            Out(new Dictionary<string, object> { { "ok", true }, { "cleared", cleared }, { "queued", queued }, { "restored", previous }, { "changed", changed }, { "notes", notes } });
        }
    }
}
