// Drives the Claude desktop app through macOS Accessibility so a message typed in the
// workbench is sent by the desktop itself (one process owns the session, nothing forks).
// It never activates the app: it presses the sidebar row, fills the composer and presses
// Send through the accessibility tree, then returns to the session that was on screen.
//
//   claude-desktop answer <title> <localId> <question> [<option>]   (a question card in the chat)
//   claude-desktop check / probe                (the shared driver's: src/server/native/ax-driver.swift)
//   claude-desktop send <title> <localId> [steer]  (message text on stdin; steer: the session
//                                              may be running — the desktop queues it into that turn)
//   claude-desktop new <folder|-> [<control> <option>…]
//                                              (first message on stdin: the desktop's own "New session"
//                                              page, opened by its sidebar's New button, sends it with
//                                              what that page has picked; a folder given here is picked
//                                              in the page's Folder menu first, and each control named
//                                              is checked to show its option, and picked if it does not)
//   claude-desktop new-controls / new-pick / new-leave
//                                              (the "New session" page's own choices: the shared
//                                              driver's newPageCommands, on the page openNewPage opens)
//   claude-desktop send-now <title> <localId>  (deliver the desktop's queued message right away)
//   claude-desktop stop <title> <localId>
//   claude-desktop settings <title> <localId>  (only changes the session's settings, sends nothing)
//
// send, new and settings take --model <name> --effort <name> --mode <name>, named as the desktop's
// own menus name them ("Opus 5.5", "High", "Accept edits"). Whatever differs from what the
// composer shows is picked in the desktop's model and permission menus before the message is
// sent, so the session really runs with it, and the desktop shows and remembers the change.
//
// Every command prints one JSON object. Needs Accessibility permission for the process
// that runs the workbench server (System Settings → Privacy & Security → Accessibility).
//
// Compiled after src/server/native/ax-driver.swift, which provides the actions (find, press, fill, open,
// close, show, …); what Claude calls its controls is data, in src/server/native/profiles/claude.json.

// ---- Claude's own controls, named in src/server/native/profiles/claude.json ----
func prompt() -> AXUIElement? { find("composer") }
func button(_ name: String) -> AXUIElement? { find(["Send": "send", "Stop": "stop", "Cancel": "cancel"][name] ?? name) }

// ---- model, effort and permission mode: the two menus under the composer ----
// "Model: Fable 5.2 Medium" opens the models, with "Effort …" and "More models" as submenus;
// the button after it is named by the permission mode alone ("Auto") and opens the modes.
// Neither is told by the word "Model": the button is the profile's "modelMenu", the model is what
// its name says after the colon, and the modes' button is the one that follows it.
let modes = settings("modes")
func modelMenu() -> AXUIElement? { find("modelMenu") }
func modeMenu() -> AXUIElement? {
  guard let model = modelMenu() else { return nil }
  let after = every { role($0) == "AXPopUpButton" }.drop { !CFEqual($0, model) }.dropFirst()
  return after.first { button in modes.contains { named(button, $0) } } ?? after.first
}
func shownModel() -> String { modelMenu().map { labelled(name($0))?.value ?? name($0) } ?? "" }
typealias SettingsError = StepError
// A menu that still will not open while the window is off screen (a minimised window was never
// seen to open one) is reported as that, so the person knows what to do about it.
let hidden = "Claude 桌面版的窗口不在屏幕上，这次没能改它的模型和权限：把窗口放到看得见的地方再发"
func unopened(_ code: String, _ message: String) -> SettingsError { onScreen() ? SettingsError(code: code, message: message) : SettingsError(code: "hidden", message: hidden) }
// A submenu opens for the pointer or the arrow key, not for a press: focus its row through the
// accessibility tree and send the app (not the screen) a right arrow.
func submenu(_ target: () -> AXUIElement?) -> Bool {
  guard let row = target() else { return false }
  let before = items().count
  focus(row); wait(0.15)
  key(.right)
  for attempt in 0..<10 { wait(0.15); if items().count > before { return true }; if attempt == 2, !onScreen() { break } }
  // Off screen a submenu that was open before still has its rows in the tree, so no new row
  // shows up and nothing else says it is open: carry on, and let the caller's own check of
  // what the desktop shows afterwards decide whether the pick took.
  return !onScreen()
}
// ---- the menus' rows, by name or by place ----
// The models' menu ends in two rows that open a submenu: "Effort <level>", then "More models".
// Each is found by its name; in a menu that names neither (a desktop shown in another language),
// by its place among exactly two such rows. With one such row only, the model has no effort to
// set and that row is "More models": nothing is taken for the effort row.
func submenuRow(_ word: String, _ place: Int) -> AXUIElement? {
  if let row = item(word) { return row }
  let rows = menuRows(modelMenu()).filter(opensSubmenu)
  guard rows.count == 2, wordless(rows, [setting("effortItem"), setting("moreModelsItem")]) else { return nil }
  return rows[place]
}
func effortRow() -> AXUIElement? { submenuRow(setting("effortItem"), 0) }
func moreModelsRow() -> AXUIElement? { submenuRow(setting("moreModelsItem"), 1) }
// The effort submenu's rows are the ones in the box named after its own row (none while it has
// never been opened). A level is found by its name ("Medium Recommended" is
// Medium); where the rows are named otherwise, by its place: the levels run from the lowest up in
// the order of the profile's "efforts", and a model that stops short of the highest lists fewer.
let efforts = settings("efforts")
func levelRows() -> [AXUIElement] {
  guard let own = effortRow() else { return [] }
  return menuRows(own)
}
func levelRow(_ effort: String) -> AXUIElement? {
  let rows = levelRows()
  if let row = rows.first(where: { named($0, effort) }) ?? (rows.isEmpty ? item(effort) : nil) { return row }
  guard let place = efforts.firstIndex(of: effort), wordless(rows, efforts), place < rows.count else { return nil }
  return rows[place]
}
// The modes' menu lists the modes in the order of the profile's "modes" and declares a number for
// each one it can switch to ("1" for the first). A mode is found by its name; where the rows are
// named otherwise, by that number, or by its place in a menu of exactly as many rows.
func modeRow(_ mode: String) -> AXUIElement? {
  if let row = item(mode) { return row }
  let rows = menuRows(modeMenu())
  guard let place = modes.firstIndex(of: mode), wordless(rows, modes) else { return nil }
  if let numbered = rows.first(where: { shortcut($0) == String(place + 1) }) { return numbered }
  return rows.count == modes.count ? rows[place] : nil
}
// A mode the desktop has not been allowed to use yet says "Enable" after its name; told without
// that word, it is the row with no number among rows that have one.
func modeLocked(_ row: AXUIElement) -> Bool {
  if name(row).hasSuffix(" " + (setting("modeLockedSuffix").isEmpty ? "Enable" : setting("modeLockedSuffix"))) { return true }
  let rows = menuRows(modeMenu())
  return wordless(rows, modes) && shortcut(row).isEmpty && rows.contains { !shortcut($0).isEmpty }
}

// Picks what was asked for where the composer on screen shows something else. Returns what it
// changed, or why it stopped; nothing has been sent either way.
func applySettings() -> (changed: [String], notes: [String], error: SettingsError?) {
  var changed: [String] = [], notes: [String] = []
  // The composer's menus can be a moment behind the session coming on screen.
  if !wanted.isEmpty { for _ in 0..<10 { if modelMenu() != nil { break }; wait(0.2) } }
  // Stopping leaves the desktop as it was found: any question it asked is answered with Cancel.
  func stop(_ error: SettingsError) -> (changed: [String], notes: [String], error: SettingsError?) { dismiss(); close(modelMenu); close(modeMenu); return (changed, notes, error) }
  func stop(_ code: String, _ message: String) -> (changed: [String], notes: [String], error: SettingsError?) { stop(SettingsError(code: code, message: message)) }
  if let model = wanted["model"], !model.isEmpty {
    func shown() -> Bool { let now = shownModel(); return now == model || now.hasPrefix(model + " ") }
    if !shown() {
      guard open(modelMenu) else { return stop(unopened("no_model_menu", "没能打开 Claude 桌面版的模型菜单")) }
      var choice = item(model)
      if choice == nil, submenu(moreModelsRow) { choice = item(model) }
      guard let choice else { return stop("model_unavailable", "Claude 桌面版的模型菜单里没有这个模型") }
      press(choice)
      // In a session with history the desktop may ask first ("Switch model?": the next message
      // re-reads the whole session, which uses more of the person's usage). The model was picked on
      // purpose in the console, so the answer is yes: the question's own primary button (the
      // profile's "dialogConfirm", told by its class, its name only where that is gone), whatever
      // the question is titled or worded in. A question that has only just come up may not have
      // its button yet: it is looked at again rather than given up on. What the desktop said goes
      // back with the result. "Don't ask again" stays unticked.
      // Answered once: off screen the answered question stays in the tree after it has gone.
      var confirmed = false, asked = ""
      for _ in 0..<16 {
        wait(0.2)
        if !confirmed, let box = dialog() {
          let said = inDialog(box) { role($0) == "AXStaticText" }.map(value).max { $0.count < $1.count } ?? ""
          if !said.isEmpty { asked = said }
          let buttons = inDialog(box) { fits($0, "dialogConfirm") }
          guard buttons.count == 1, let confirm = buttons.first else { continue }
          if !asked.isEmpty { notes.append(asked) }
          press(confirm); confirmed = true
        } else if shown() { break }
      }
      if !confirmed, dialog() != nil { return stop("model_confirm", asked.isEmpty ? "切换模型时 Claude 桌面版弹出了确认，请到桌面版里操作" : "切换模型时 Claude 桌面版弹出了确认，没能在里面确认，请到桌面版里操作。桌面版的提示：\(asked)") }
      close(modelMenu)
      guard shown() else { return stop("model_not_set", "在 Claude 桌面版里选了这个模型，但它没有切换过去") }
      changed.append("model")
    }
  }
  if let effort = wanted["effort"], !effort.isEmpty, !shownModel().hasSuffix(" " + effort) {
    // The menu's own "Effort <level>" row says what is set, whatever the button abbreviates it to.
    // Where that row is named otherwise (found by its place), the level's own row says it, ticked
    // in the submenu.
    func said() -> Bool { effortRow().map { name($0) == setting("effortItem") + " " + effort } ?? false }
    func ticked() -> Bool { (levelRows().isEmpty ? submenu(effortRow) : true) && levelRow(effort).map(checked) == true }
    guard open(modelMenu) else { return stop(unopened("no_model_menu", "没能打开 Claude 桌面版的模型菜单")) }
    guard let own = effortRow() else { return stop("effort_unavailable", "这个模型在 Claude 桌面版里不能调推理强度") }
    let worded = named(own, setting("effortItem"))
    if !said() {
      guard submenu(effortRow) else { return stop("no_effort_menu", "没能打开 Claude 桌面版的推理强度菜单") }
      guard let choice = levelRow(effort) else { return stop("effort_unavailable", "Claude 桌面版的推理强度菜单里没有这一档") }
      if worded || !checked(choice) {
        press(choice); wait(0.4)
        close(modelMenu)
        guard open(modelMenu), worded ? said() : ticked() else { return stop("effort_not_set", "在 Claude 桌面版里选了这档推理强度，但它没有切换过去") }
        changed.append("effort")
      }
    }
    close(modelMenu)
  }
  if let mode = wanted["mode"], !mode.isEmpty, let button = modeMenu(), !named(button, mode) {
    guard open(modeMenu) else { return stop(unopened("no_mode_menu", "没能打开 Claude 桌面版的权限菜单")) }
    guard let choice = modeRow(mode) else { return stop("mode_unavailable", "Claude 桌面版的权限菜单里没有这个模式") }
    if !checked(choice) {
      // A mode the desktop has not been allowed to use yet shows "Enable": turning it on is the
      // person's decision, made in the desktop app.
      if modeLocked(choice) { return stop("mode_locked", "Claude 桌面版里还没有启用这个权限模式，请先在桌面版里启用它") }
      press(choice); wait(0.4)
      // A mode that asks for confirmation is confirmed by the person, in the desktop app.
      if dialog() != nil { return stop("mode_confirm", "切换到这个权限模式需要在 Claude 桌面版里确认，请到桌面版里操作") }
      close(modeMenu)
      guard open(modeMenu), modeRow(mode).map(checked) == true else { return stop("mode_not_set", "在 Claude 桌面版里选了这个权限模式，但它没有切换过去") }
      changed.append("mode")
    }
    close(modeMenu)
  } else if let mode = wanted["mode"], !mode.isEmpty, modeMenu() == nil { return stop("no_mode_menu", "没能打开 Claude 桌面版的权限菜单") }
  return (changed, notes, nil)
}

// ---- the desktop's "New session" page ----
func heading(_ name: String) -> Bool { first { role($0) == "AXHeading" && label($0).hasPrefix(name) } != nil }
// The page is told by its address (the profile's "newPage"), which no language changes; by its
// heading's words where the address is not what the profile expects.
func onNewPage() -> Bool { current().isEmpty && prompt() != nil && (find("newPage") != nil || heading(setting("newPageHeading"))) }
// Whether to trust a folder is the person's decision, made in the desktop app: never accept it here.
func declineTrust() -> Bool { guard heading(setting("trustHeading")) else { return false }; if let cancel = button("Cancel") { press(cancel); wait() }; return true }
// The sidebar's own New button opens the page where the window is. (The claude://code/new link
// does too, but it brings Claude to the front and switches the screen to its Space.)
func openNewPage() -> SettingsError? {
  if onNewPage() { return nil }
  guard let new = find("newChat") else { return SettingsError(code: "no_new_page", message: "Claude 桌面版的侧栏里没有找到新建按钮") }
  press(new)
  var trust = false
  let opened = until(6) { trust = declineTrust(); return trust || onNewPage() }
  if trust { return SettingsError(code: "trust", message: "Claude 桌面版要先确认信任这个文件夹：请在桌面版里用它新建一次会话") }
  return opened ? nil : SettingsError(code: "no_new_page", message: "没能在 Claude 桌面版里打开新建会话页")
}

// The page's own choices (new-controls, new-pick) are the shared driver's: newPageCommands.
newPageWatch = { declineTrust() ? StepError(code: "trust", message: "Claude 桌面版要先确认信任这个文件夹：请在桌面版里用它新建一次会话") : nil }
// A session's composer names the mode button by the mode alone ("Auto"); the "New session" page
// names it "Permissions: Auto". Either way, the mode it shows, in the profile's own words.
func shownMode() -> String {
  guard let button = modeMenu() else { return "" }
  let own = name(button), bare = labelled(own)?.value ?? own
  return modes.first { bare == $0 || bare.hasPrefix($0 + " ") } ?? ""
}
newPageShown = { ["model": shownModel(), "mode": shownMode()] }
newPageInUse = { !(prompt().map(value) ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
newPageCommands(open: openNewPage)
let previous = startedOn(), previousAt = startedAddress()
let title = args.count > 1 ? args[1] : "", localId = args.count > 2 ? args[2] : "", steer = args.count > 3 && args[3] == "steer"
guard !title.isEmpty else { fail("usage", "缺少会话标题") }
// The session the command acts on, by its page's address ("/epitaxy/local_…"): two sessions may share a title.
let target = localId.hasPrefix("local_") ? address(["localId": localId]) : ""
// Back to the session the person had on screen, by its address when both are known (it may have
// the same title as this one and still be another session).
func back() {
  guard !previous.isEmpty else { return }
  if !previousAt.isEmpty && !target.isEmpty { if previousAt != target { _ = show(previous, at: previousAt) } }
  else if previous != title { _ = show(previous) }
}

switch args.first {
case "send":
  let text = String(data: FileHandle.standardInput.readDataToEndOfFile(), encoding: .utf8) ?? ""
  guard !text.isEmpty else { fail("usage", "消息是空的") }
  guard show(title, ["localId": localId]) else { back(); fail("not_found", "没能在 Claude 桌面版里打开这个会话") }
  // While a turn runs the desktop shows Stop until the composer has text, then Send, which
  // queues the message into the running turn. A plain send still waits for the turn to end.
  let running = button("Stop") != nil
  if running && !steer { back(); fail("busy", "这个会话正在 Claude 桌面版里运行，等这一轮结束再发") }
  let settings = applySettings()
  if let error = settings.error { back(); out(["ok": false, "code": error.code, "error": error.message, "changed": settings.changed]) }
  let draft = prompt().map(value) ?? ""
  guard fill("composer", text, ready: "send") else {
    if let field = prompt() { setValue(field, draft) }; back()
    // A window full screen on another Space takes the message; a minimised one was seen not to.
    onScreen() ? fail("fill_failed", "没能把消息填进 Claude 桌面版的输入框") : fail("hidden", "Claude 桌面版的窗口不在屏幕上，这次没能把消息交给它：把窗口放到看得见的地方再发")
  }
  guard let send = button("Send") else { back(); fail("no_send", "Claude 桌面版没有出现发送按钮") }
  act(send, kAXPressAction as String)
  // Not pressed (the driver's `sole`: several controls answered to it): nothing was sent, and
  // the composer gets back what it held.
  if heldBack() { if let field = prompt() { setValue(field, draft) }; back(); fail("no_send", "Claude 桌面版没有出现发送按钮") }
  // The accessibility value can lag behind the editor, so this is only a hint; the caller
  // confirms the send by finding the message in the session's transcript.
  let cleared = until(5) { button("Send") == nil || button("Stop") != nil || prompt().map(value)?.isEmpty == true }
  // A message sent into a running turn waits in the desktop's own queue (its "Send now" shows)
  // until the turn's next step; the record has it only then (seen 30 s later on Windows, on a turn
  // with no steps). The console then takes the steer instead of waiting for the record.
  let queued = steer && running && until(1.5) { !findAll("sendNow").isEmpty }
  // Put back whatever the person had typed there before.
  if cleared, !draft.isEmpty, let field = prompt() { setValue(field, draft) }
  back()
  out(["ok": true, "cleared": cleared, "queued": queued, "restored": previous, "changed": settings.changed, "notes": settings.notes])
case "new":
  // A new session is made by the desktop app itself: its "New session" page takes the first
  // message with what that page has picked (environment, folder, worktree: see new-controls),
  // so it shows in the desktop and runs there with the desktop's model and permissions.
  let text = String(data: FileHandle.standardInput.readDataToEndOfFile(), encoding: .utf8) ?? ""
  guard !text.isEmpty else { fail("usage", "消息是空的") }
  let folder = title == "-" ? "" : URL(fileURLWithPath: title).standardizedFileURL.path
  func giveUp(_ code: String, _ message: String) -> Never { clear("composer"); back(); fail(code, message) }
  if let error = openNewPage() { back(); fail(error.code, error.message) }
  // A folder named here is picked in the page's Folder menu, which lists the folders the
  // desktop already knows, by name.
  if !folder.isEmpty, pageControl("Folder") != nil, let error = pickOnPage("Folder", folder) { giveUp(error.code, error.message) }
  // What the console showed as chosen when the message was written (it may be showing an earlier
  // read of this page): each is checked here, and picked when the page has moved on since, so the
  // session starts where the person was told it would or not at all.
  let expected = Array(args.dropFirst(2))
  for index in stride(from: 0, to: expected.count - 1, by: 2) { if let error = pickOnPage(expected[index], expected[index + 1]) { giveUp(error.code, error.message) } }
  let settings = applySettings()
  if let error = settings.error { giveUp(error.code, error.message) }
  guard fill("composer", text, ready: "send"), onNewPage() else { giveUp("fill_failed", "没能把消息填进 Claude 桌面版的输入框") }
  guard let send = button("Send") else { giveUp("no_send", "Claude 桌面版没有出现发送按钮") }
  act(send, kAXPressAction as String)
  if heldBack() { giveUp("no_send", "Claude 桌面版没有出现发送按钮") }
  // The page becomes the new session once the desktop has started it.
  let started = until(10) { !current().isEmpty || button("Stop") != nil }
  back()
  out(["ok": true, "started": started, "restored": previous, "changed": settings.changed, "notes": settings.notes])
case "settings":
  guard show(title, ["localId": localId]) else { back(); fail("not_found", "没能在 Claude 桌面版里打开这个会话") }
  let settings = applySettings()
  let shown: [String: Any] = ["model": shownModel(), "mode": modeMenu().map(name) ?? ""]
  back()
  if let error = settings.error { out(["ok": false, "code": error.code, "error": error.message, "changed": settings.changed, "shown": shown]) }
  out(["ok": true, "changed": settings.changed, "notes": settings.notes, "shown": shown])
case "answer":
  // answer <title> <localId> <question> [<option>]: the question card's option, then Submit;
  // without an option, Skip. The session's record shows the answer once the desktop took it.
  guard args.count > 3 else { fail("usage", "缺少要回答的问题") }
  guard show(title, ["localId": localId]) else { back(); fail("not_found", "没能在 Claude 桌面版里打开这个会话") }
  if let error = answerCard(question: args[3], option: args.count > 4 ? args[4] : nil) { back(); fail(error.code, error.message) }
  back()
  out(["ok": true])
case "card", "action":
  // card <title> <localId> <ask> <recap> <replies JSON>: the desktop's own buttons on the session's
  // wrap-up card, by the names the desktop gives them, in order. Not the card's reply buttons (the
  // record has those) nor the profile's "cardSkip" (Dismiss): what is left is what the desktop runs.
  // action <title> <localId> <index> <ask> <recap> <replies JSON>: press the index-th of them.
  // The card is found by its question (or, without one, its recap) inside the desktop's own
  // transcript ("transcript" in the profile; the window may also hold web pages showing the same
  // card, Frontdesk's own among them): the nearest box around that text that holds buttons.
  // No check for Stop: off screen the tree can keep a Stop the desktop has put away, while the
  // desktop draws a card's buttons only once its turn has ended.
  let reading = args.first == "card", at = reading ? 3 : 4
  guard args.count > at + 2, reading || Int(args[3]) != nil else { fail("usage", "缺少卡片的内容") }
  let index = reading ? 0 : Int(args[3]) ?? 0, ask = args[at], recap = args[at + 1]
  let replies = Set((try? JSONSerialization.jsonObject(with: Data(args[at + 2].utf8))) as? [String] ?? [])
  let skip = Set(settings("cardSkip"))
  guard show(title, ["localId": localId]) else { back(); fail("not_found", "没能在 Claude 桌面版里打开这个会话") }
  func card() -> AXUIElement? {
    let words = findAll("transcript").flatMap { within($0, { role($0) == "AXStaticText" && { let text = value($0).trimmingCharacters(in: .whitespacesAndNewlines); return !text.isEmpty && (text == ask || (ask.isEmpty && text == recap)) }($0) }) }
    for text in words.reversed() {
      var box: AXUIElement = text
      for _ in 0..<4 {
        guard let up = attr(box, "AXParent") else { break }
        box = up as! AXUIElement
        if !within(box, { role($0) == "AXButton" }).isEmpty { return box }
      }
    }
    return nil
  }
  func actions(_ box: AXUIElement) -> [AXUIElement] { within(box, { role($0) == "AXButton" && { let own = label($0); return !own.isEmpty && !skip.contains(own) && !replies.contains(own) }($0) }) }
  // The card is drawn a moment after the session is shown. Off screen, Chromium refreshes the tree
  // only around the element an action lands on, so once the card is there the waits refresh it
  // (refresh() scrolls the anchor into view). Only off screen: on screen the tree is live, and
  // scrolling the card into view would pull the person's page down to it while they read further
  // up — for a card with only reply buttons, a dozen times over each read.
  var found = card()
  for _ in 0..<12 where found.map(actions)?.isEmpty ?? true {
    if let box = found { anchor = box }
    wait(); found = card()
  }
  anchor = nil
  guard let box = found else { back(); fail("no_card", "Claude 桌面版里没有找到这一轮的卡片") }
  // Their names are read while the card is on the page: back() may take the desktop to the chat it
  // was showing before, and a button of a page that is gone answers with no name at all.
  let drawn = actions(box), names = drawn.map(label)
  if reading { back(); out(["ok": true, "actions": names]) }
  guard index < drawn.count else { back(); out(["ok": false, "code": "no_action", "error": "Claude 桌面版的这张卡片上已经没有这个按钮了", "actions": names]) }
  let pressed = names[index]
  press(drawn[index])
  wait(0.5)
  back()
  out(["ok": true, "pressed": pressed])
case "send-now":
  guard show(title, ["localId": localId]) else { back(); fail("not_found", "没能在 Claude 桌面版里打开这个会话") }
  let now = findAll("sendNow")
  guard let press = now.first else { back(); fail("no_queue", "Claude 桌面版里没有排队中的消息") }
  act(press, kAXPressAction as String)
  wait(0.5)
  back()
  out(["ok": true])
case "stop":
  guard show(title, ["localId": localId]) else { back(); fail("not_found", "没能在 Claude 桌面版里打开这个会话") }
  guard let stop = button("Stop") else { back(); fail("not_running", "这个会话在 Claude 桌面版里没有在运行") }
  guard act(stop, kAXPressAction as String) == .success else { back(); fail("not_stopped", "没能按下 Claude 桌面版的停止按钮") }
  var stopped = false
  for _ in 0..<12 { wait(); if !isShown(title, target) { break }; if button("Stop") == nil { stopped = true; break } }
  back()
  stopped ? out(["ok": true]) : fail("not_stopped", "按了停止，但 Claude 桌面版还在运行")
default:
  fail("usage", "未知命令")
}
