// Drives the Codex desktop app (ChatGPT.app in Codex mode) through macOS Accessibility, so a new
// chat started in the console is started by the desktop itself: its own app-server owns the
// thread from the first turn on, and nothing else ever holds the thread's writer lock.
//
//   codex-desktop new <project|-|:none>   (first message on stdin: the desktop's New chat page
//                                          sends it; a project named here is picked in the page's
//                                          project menu first, ":none" works outside every project,
//                                          "-" keeps what the page has picked)
//   codex-desktop settings <title>        (changes a chat's model and effort in the desktop, sends nothing)
//   codex-desktop new-shown               (what the New chat page's model button shows now, e.g.
//                                          "GPT-6.1 Sol Medium": a new chat runs with it; nothing is picked)
//   codex-desktop check / probe           (the shared driver's: src/server/native/ax-driver.swift)
//
// new and settings take --model <name> --effort <level>, named as the console names them
// ("GPT-6.1-Sol", "high"); the profile (src/server/native/profiles/codex.json) says what the desktop
// calls each level. Whatever differs from what the composer shows is picked in the desktop's own
// model menu before anything is sent, so the desktop shows and keeps it.
//
// Compiled after src/server/native/ax-driver.swift. Seen on the real app, also off screen: presses open
// its menus; the effort is a slider row ("Power") moved with the arrow keys, and while the menu is
// open its status line says where it is ("GPT-6.1 Sol Standard, 2 of 5.").

func norm(_ text: String) -> String { text.lowercased().replacingOccurrences(of: "-", with: " ").trimmingCharacters(in: .whitespaces) }
func modelMenu() -> AXUIElement? { find("modelMenu") }
// "Change project: <name>" while the page has a project, "Choose project" while it has none.
func projectMenu() -> AXUIElement? { find("projectMenu") ?? find("projectChooser") }
// What the closed model button says: "<model> <effort>", e.g. "GPT-6.1 Sol Medium".
func shownLabel() -> String { modelMenu().map(name) ?? "" }  // only while no menu is open
func shows(model: String) -> Bool { let shown = norm(shownLabel()), want = norm(model); return shown == want || shown.hasPrefix(want + " ") }
let effortNames = profile["effortNames"] as? [String: String] ?? [:]
let effortSteps = profile["effortSteps"] as? [String: String] ?? [:]
func shows(effort label: String) -> Bool { shownLabel().hasSuffix(" " + label) }
// The model menu's rows. "Select model" opens the models and the effort's slider row is "Power":
// the profile's "selectModelRow" and "effortRow" find them by what the page declares for them
// (the row's own class, the arrow keys), whatever the desktop's language calls them.
func selectModelRow() -> AXUIElement? { find("selectModelRow") ?? item(setting("selectModelItem")) }
func powerRow() -> AXUIElement? { find("effortRow") ?? item(setting("effortItem")) }
// The levels from the lowest up, as the console names them: a level's place on the slider.
let effortOrder = settings("effortOrder")
// The open menu's status line, read only while the menu is open.
func effortStatus() -> String { every { attr($0, "AXSubrole") as? String == "AXApplicationStatus" }.flatMap { within($0) { role($0) == "AXStaticText" } }.map(value).joined() }

struct Stop: Error { let code: String, message: String }
// Picks what was asked for where the composer shows something else. Throws why it stopped;
// nothing has been sent either way.
func applySettings() throws -> [String] {
  var changed: [String] = []
  if !wanted.isEmpty { for _ in 0..<10 { if modelMenu() != nil { break }; wait(0.2) } }
  // Held on to: while its menu is open the page hides the button from the tree.
  guard wanted.values.contains(where: { !$0.isEmpty }) else { return changed }
  guard let button = modelMenu() else { throw Stop(code: "no_model_menu", message: "Codex 桌面版的输入框下面没有模型菜单") }
  let menu = { () -> AXUIElement? in button }
  defer { close(menu) }
  if let model = wanted["model"], !model.isEmpty, !shows(model: model) {
    guard open(menu) else { throw Stop(code: "no_model_menu", message: "没能打开 Codex 桌面版的模型菜单") }
    guard let select = selectModelRow() else { throw Stop(code: "no_model_menu", message: "Codex 桌面版的模型菜单里找不到选模型的入口") }
    press(select)
    var choice: AXUIElement?
    for _ in 0..<12 { wait(0.2); choice = items().first { norm(name($0)) == norm(model) }; if choice != nil { break } }
    guard let choice else { throw Stop(code: "model_unavailable", message: "Codex 桌面版的模型菜单里没有 \(model)") }
    press(choice)
    for _ in 0..<12 { wait(0.2); if !expanded(button) { break } }
    close(menu)
    for _ in 0..<8 { if shows(model: model) { break }; wait(0.2) }
    guard shows(model: model) else { throw Stop(code: "model_not_set", message: "在 Codex 桌面版里选了 \(model)，但它没有切换过去") }
    changed.append("model")
  }
  if let effort = wanted["effort"], !effort.isEmpty {
    guard let label = effortNames[effort] else { throw Stop(code: "effort_unavailable", message: "Codex 桌面版没有「\(effort)」这一档推理强度") }
    if !shows(effort: label) {
      // The slider's status names a level its own way ("Standard" for the button's "Medium").
      let step = effortSteps[label] ?? label
      guard open(menu), let power = powerRow() else { throw Stop(code: "no_effort_menu", message: "没能打开 Codex 桌面版的推理强度滑块") }
      focus(power); wait(0.2)
      // "GPT-6.1 Sol Extended, 3 of 5.": the level's name, then its place. In another language the
      // line reads otherwise but still ends in those two numbers, the place being the smaller.
      func at() -> (name: String, index: Int, count: Int)? {
        let status = effortStatus()
        trace("slider says \(status)")
        if let match = status.range(of: #", (\d+) of (\d+)\.?$"#, options: .regularExpression) {
          let numbers = status[match].split(whereSeparator: { !$0.isNumber }).compactMap { Int($0) }
          let level = String(status[..<match.lowerBound]).components(separatedBy: " ").last ?? ""
          let full = String(status[..<match.lowerBound])
          if numbers.count == 2 { return (full.hasSuffix(" " + step) ? step : level, numbers[0], numbers[1]) }
        }
        let numbers = status.split(whereSeparator: { !($0.isASCII && $0.isNumber) }).compactMap { Int($0) }.suffix(2)
        guard numbers.count == 2, let low = numbers.min(), let high = numbers.max(), low >= 1 else { return nil }
        return ("", low, high)
      }
      guard let start = at() else { throw Stop(code: "no_effort_menu", message: "读不到 Codex 桌面版推理强度滑块的位置") }
      // A status that names its level in none of the profile's words is read by the level's place
      // alone, and only on a slider with as many places as the console has levels: a model with
      // fewer has left some out, and which ones the numbers do not say.
      let words = Set(effortNames.values).union(effortSteps.values)
      let place = effortOrder.firstIndex(of: effort).map { $0 + 1 }
      let byPlace = !words.contains(start.name) && place != nil && start.count == effortOrder.count
      func there() -> Bool { guard let now = at() else { return false }; return byPlace ? now.index == place : now.name == step }
      let was = start.index
      // Down to the first level, then up one at a time until the status names the one wanted.
      var found = there()
      if !found { for _ in 0..<start.index { key(.left); wait(0.25) }; found = there() }
      for _ in 0..<start.count where !found { key(.right); wait(0.3); found = there() }
      let moved = at()?.index != was
      close(menu)
      // The closed button names the level too, in the desktop's language: it has to agree where it
      // speaks the profile's words, and where it does not the slider's own status is the evidence.
      func worded() -> Bool { effortNames.values.contains { shows(effort: $0) } }
      for _ in 0..<8 { if shows(effort: label) || !worded() { break }; wait(0.2) }
      guard found, shows(effort: label) || !worded() else { throw Stop(code: "effort_not_set", message: "Codex 桌面版里这个模型没有「\(label)」这一档推理强度") }
      if moved { changed.append("effort") }
    }
  }
  return changed
}

// ---- the New chat page ----
func onNewPage() -> Bool { current().isEmpty && projectMenu() != nil && find("composer") != nil }
func openNewPage() -> Bool {
  if onNewPage() { return true }
  guard let new = find("newChat") else { return false }
  press(new)
  return until(6) { onNewPage() }
}
// The project's button is named "Change project: <name>": the project is what follows the
// profile's "projectPrefix", or, named another way (another language), what follows its colon.
func shownProject() -> String {
  guard let own = find("projectMenu").map(name) else { return "" }
  let prefix = setting("projectPrefix")
  return !prefix.isEmpty && own.hasPrefix(prefix) ? String(own.dropFirst(prefix.count)) : labelled(own)?.value ?? ""
}
// The project menu is a search box over a list of the desktop's projects, by name.
func pickProject(_ project: String) throws {
  if project == ":none" {
    if find("projectMenu") == nil, find("projectChooser") != nil { return }
    guard let none = find("noProject") else { throw Stop(code: "no_project_menu", message: "Codex 桌面版的新建页上没有「不在项目里」这一项") }
    press(none)
    for _ in 0..<12 { wait(0.2); if find("projectMenu") == nil, find("projectChooser") != nil { return } }
    throw Stop(code: "project_not_set", message: "在 Codex 桌面版里选了不在项目里，但项目没有切换过去")
  }
  if shownProject() == project { return }
  guard open(projectMenu, opened: { find("projectList") != nil }) else { throw Stop(code: "no_project_menu", message: "没能打开 Codex 桌面版的项目菜单") }
  let rows = find("projectList").flatMap { attr($0, "AXChildren") as? [AXUIElement] } ?? []
  func text(_ row: AXUIElement) -> String { within(row) { role($0) == "AXStaticText" }.map(value).first { !$0.isEmpty } ?? label(row) }
  guard let row = rows.first(where: { text($0) == project }) else { close(projectMenu); throw Stop(code: "project_unavailable", message: "Codex 桌面版的项目菜单里没有「\(project)」") }
  press(row)
  for _ in 0..<12 { wait(0.2); if shownProject() == project { break } }
  anchor = nil
  guard shownProject() == project else { close(projectMenu); throw Stop(code: "project_not_set", message: "在 Codex 桌面版里选了「\(project)」，但项目没有切换过去") }
}

let previous = startedOn()
func back() { if !previous.isEmpty { _ = show(previous) } }
// The New chat page is read with `--stay` while the console shows a new chat (new-shown); the
// shared driver's new-leave takes the desktop back afterwards, unless somebody is writing there.
// (An empty message box here reads as its placeholder, "Do anything": what says somebody is
// writing is the Send button, which the page shows only once the box holds text.)
// (Where Send is not found by its name, the box itself says it: it holds something that is not its placeholder.)
leaveNewPage(inUse: { onNewPage() && (find("send") != nil || find("composer").map(holdsText) == true) })

// The app's ChatGPT mode has its own New chat page, without projects or models: the shared driver
// puts the desktop in Codex mode first (profile "spaces") and back afterwards.

switch args.first {
case "new":
  let text = stdinText()
  guard !text.isEmpty else { fail("usage", "消息是空的") }
  let project = args.count > 1 ? args[1] : "-"
  func giveUp(_ code: String, _ message: String) -> Never { clear("composer"); back(); fail(code, message) }
  guard openNewPage() else { back(); fail("no_new_page", "没能在 Codex 桌面版里打开新建聊天页") }
  var changed: [String] = []
  do {
    if project != "-" { try pickProject(project); changed.append("project") }
    changed += try applySettings()
  } catch let stop as Stop { giveUp(stop.code, stop.message) } catch { giveUp("failed", "\(error)") }
  guard fill("composer", text, ready: "send"), onNewPage() else { giveUp("fill_failed", "没能把消息填进 Codex 桌面版的输入框") }
  guard let send = sendButton("send") else { giveUp("no_send", "Codex 桌面版没有出现发送按钮") }
  press(send)
  // Not pressed (the driver's `sole`: several controls answered to it): nothing was sent.
  if heldBack() { giveUp("no_send", "Codex 桌面版没有出现发送按钮") }
  // The page becomes the new chat once the desktop has started it.
  var started = false
  for _ in 0..<40 { wait(); if !onNewPage() || !current().isEmpty { started = true; break } }
  let title = current()
  back()
  out(["ok": true, "started": started, "title": title, "restored": previous, "changed": changed])
case "new-shown":
  guard openNewPage() else { back(); fail("no_new_page", "没能在 Codex 桌面版里打开新建聊天页") }
  for _ in 0..<10 { if modelMenu() != nil { break }; wait(0.2) }
  let shown = shownLabel()
  // Left on the page when asked to stay (`--stay`): the answer names the conversation to go back to.
  if !staying || shown.isEmpty { back() }
  guard !shown.isEmpty else { fail("no_model_menu", "Codex 桌面版的新建页上没有模型菜单") }
  out(["ok": true, "shown": ["model": shown], "restored": previous, "previous": previous, "stayed": staying])
case "settings":
  let title = args.count > 1 ? args[1] : ""
  guard !title.isEmpty else { fail("usage", "缺少会话标题") }
  guard show(title) else { back(); fail("not_found", "没能在 Codex 桌面版的侧栏里找到这个聊天") }
  do {
    let changed = try applySettings()
    let shown = shownLabel()
    if previous != title { back() }
    out(["ok": true, "changed": changed, "shown": shown])
  } catch let stop as Stop { if previous != title { back() }; fail(stop.code, stop.message) } catch { back(); fail("failed", "\(error)") }
default:
  fail("usage", "未知命令")
}
