// The accessibility driver every desktop flow shares (the "page object" pattern: the actions live
// here, the engine's names for its controls live in its profile, src/server/native/profiles/<id>.json,
// and whether a message really went out is decided by the engine's own record, back in JS).
//
// A flow (src/server/native/<engine>-desktop.swift) is compiled together with this file, after it, into
// one helper per engine (src/server/core/desktop-automation.ts). The helper is run as
//   AX_PROFILE=<profile.json> <helper> <command> [args…] [--model <name>] [--effort <name>] [--mode <name>] [--space <id>]
// and prints one JSON object. Two commands work for every engine without a flow of their own:
//   check  → {"trusted":…, "running":…}
//   probe  → which of the profile's locators the desktop shows right now (nothing is pressed);
//            for a locator with several ways to be found, how many each way finds, whether
//            they found the same control, and which have lost the mark they went by (profileCheck)
//   inspect [<locator>…]  → what the controls those locators find go by besides their names
//            (DOM classes, id, declared shortcut, where they sit): what a way that does not
//            depend on the desktop's language is written from (nothing is pressed)
//   warm [check]  → reads the page once so the desktop keeps its accessibility tree (see "keeping
//            warm"); with `check`, also says whether the profile still matches that page
//   open-file <title> <localId|-> <path> <absolute> [<label>]  → the chat's link to a file, pressed there
//   show-session <title> <localId|->  → the conversation shown in the desktop, brought to the front
//   space  → which of the desktop's modes is shown (profile "spaces"; nothing is pressed)
//   read-chat / chat-new / chat-send / chat-stop  → a chat mode's chats (profile "chatRead", "chatSend")
// With a profile "spaces", every other command first puts the desktop in the mode it acts in
// (`--space <id>`, default the profile's "home") and puts it back afterwards (see "modes").
// and a flow whose desktop has a new-chat page with choices of its own gets two more from
// newPageCommands (see "a new chat's page" below): new-controls and new-pick.
//
// Every answer also says how long the command took (`ms`) and how many round trips to the desktop
// it made (`reads`); with AX_TRACE set, each step is written to stderr as it happens.
//
// Three things hold for every flow without the flow writing them. Nothing is done to a control
// that is not the only one its locator finds ("one control, or none"). A menu button found by its
// place has to open the menu the profile describes for it ("a control found by its place"). And
// every answer says which controls were found by another way than their first (`via`), so a
// desktop that has changed under the profile is noticed before it matters.
//
// Nothing here activates the desktop app or takes the person's keyboard: presses go through the
// accessibility tree and keys are posted to the app's process, not to the screen.
import Cocoa
import ApplicationServices

// Runs once, just before the answer is printed (the desktop put back in the mode it was in);
// what it could not do is reported with the answer ("restore"). A command that parks the desktop
// on its new-chat page (`--stay`, answering `stayed`) keeps the mode as well: the answer names the
// person's own (`previousSpace`) and new-leave puts it back with their conversation.
var beforeExit: (() -> String?)?
var personSpace = ""
let startedAt = Date()
// Round trips to the desktop's process: what a command's time is mostly made of.
var reads = 0
let tracing = ProcessInfo.processInfo.environment["AX_TRACE"] != nil
func elapsed() -> Int { Int(Date().timeIntervalSince(startedAt) * 1000) }
func trace(_ what: @autoclosure () -> String) { if tracing { FileHandle.standardError.write(Data("[ax +\(elapsed())ms \(reads)r] \(what())\n".utf8)) } }
// What the command learned about its own footing, added to every answer (see "one control, or
// none" and "a control found by its place"; set once the profile's locators are read):
//   via          the controls found by another way than their first: { <locator>: "name" | "place" | "mark" }
//   ambiguous    the controls it would not act on, because several answered to them: { <locator>: <how many> }
//   unconfirmed  the menus it closed again, because a button found by its place opened something else
// A command that failed after holding back says so as its reason (`code`: "ambiguous" / "unconfirmed",
// with the flow's own code kept as `step`).
var origin: [AXUIElement: (key: String, way: Int)] = [:], via: [String: Int] = [:]
var refused: [String: Int] = [:], unconfirmed: [String] = [], soleNow: Set<AXUIElement> = []
var annotate: (inout [String: Any]) -> Void = { _ in }
func out(_ input: [String: Any]) -> Never {
  var object = input
  if staying, input["stayed"] as? Bool == true, !personSpace.isEmpty { object["previousSpace"] = personSpace }
  else if let undo = beforeExit { beforeExit = nil; if let problem = undo() { object["restore"] = problem } }
  annotate(&object)
  object["ms"] = elapsed(); object["reads"] = reads
  trace("done \(object["ok"] as? Bool == false ? "failed: \(object["code"] ?? "")" : "ok")")
  let data = try! JSONSerialization.data(withJSONObject: object)
  print(String(data: data, encoding: .utf8)!)
  exit(object["ok"] as? Bool == false ? 1 : 0)
}
func fail(_ code: String, _ message: String) -> Never { out(["ok": false, "code": code, "error": message]) }

// `--previous <title>`: the conversation the person had on screen before the console parked the
// desktop on its new-chat page (`--stay`, see "a new chat's page"); a command that finds the
// desktop still on that page goes back to this conversation when it is done. `--previous-space
// <id>`: the mode they had then (the page is parked in the command's own mode, see "modes").
var args: [String] = [], wanted: [String: String] = [:], parkedPrevious = "", parkedSpace = "", staying = false
do {
  let raw = Array(CommandLine.arguments.dropFirst())
  var index = 0
  while index < raw.count {
    if ["--model", "--effort", "--mode", "--space"].contains(raw[index]), index + 1 < raw.count { wanted[String(raw[index].dropFirst(2))] = raw[index + 1]; index += 2 }
    else if raw[index] == "--previous", index + 1 < raw.count { parkedPrevious = raw[index + 1]; index += 2 }
    else if raw[index] == "--previous-space", index + 1 < raw.count { parkedSpace = raw[index + 1]; index += 2 }
    else if raw[index] == "--stay" { staying = true; index += 1 }
    else { args.append(raw[index]); index += 1 }
  }
}
func stdinText() -> String { String(data: FileHandle.standardInput.readDataToEndOfFile(), encoding: .utf8) ?? "" }

// ---- the profile: the engine's names for things, as data ----
let profile: [String: Any] = {
  guard let path = ProcessInfo.processInfo.environment["AX_PROFILE"], let data = FileManager.default.contents(atPath: path),
        let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
  return object
}()
func setting(_ key: String) -> String { profile[key] as? String ?? "" }
func settings(_ key: String) -> [String] { profile[key] as? [String] ?? [] }
let appName = setting("name").isEmpty ? "桌面版" : setting("name")

// A locator names one kind of control, by its role and by any of:
//   what stays the same whatever language the desktop is shown in —
//     "class"    one or more of the element's DOM classes ("ProseMirror"); "Name-*" matches a class
//                by its start, for the ones a build gives a new ending ("ComposerLayoutBody-uBBf1A")
//     "keys"     the shortcut the page declares for it (aria-keyshortcuts: "Meta+n")
//     "id"       its DOM id, where the page gives a fixed one (most are generated: "_r_l6l_")
//     "subrole"  its accessibility subrole
//     "url"      the address it shows or points at (a page's own, a link's); "…*" matches its start
//     "popup"    whether it opens something of its own (a menu's row with a submenu: true)
//   where it is —
//     "inside"   only within the first match of another locator
//     "has"      only what holds a match of another locator somewhere inside it
//     "after"    only after the first match of another locator, in the order the page lists them
//                (the control found is the first of those)
//     "index"    the n-th of what is left, from 0 (-1: the last)
//   what the desktop calls it, in the language it is shown in —
//     "name" (exact), "prefix" (its start), "contains" (anywhere, ignoring case), "named": true
//     (has a name at all)
// A desktop shown in another language calls its controls something else, so a control goes by
// the first kind wherever the page offers one. Where a profile gives a list, the ways are tried in
// order and the first that finds anything is the answer: what does not depend on the language
// first, the name after it, for a desktop whose page was rebuilt.
struct Locator {
  let key: String, role: String?, roles: [String], name: String?, prefix: String?, contains: String?, after: String?, named: Bool
  let classes: [String], keys: String?, id: String?, subrole: String?, url: String?, inside: String?, has: String?, index: Int?, popup: Bool?
  init(_ key: String, _ spec: [String: Any]) {
    self.key = key; role = spec["role"] as? String; roles = spec["roles"] as? [String] ?? []; named = spec["named"] as? Bool ?? false
    name = spec["name"] as? String; prefix = spec["prefix"] as? String; contains = spec["contains"] as? String; after = spec["after"] as? String
    classes = spec["class"] as? [String] ?? (spec["class"] as? String).map { [$0] } ?? []
    keys = spec["keys"] as? String; id = spec["id"] as? String; subrole = spec["subrole"] as? String; url = spec["url"] as? String
    inside = spec["inside"] as? String; has = spec["has"] as? String; index = spec["index"] as? Int; popup = spec["popup"] as? Bool
  }
  // Goes by a word the desktop translates.
  var worded: Bool { name != nil || prefix != nil || contains != nil }
  // Goes by its turn among others like it ("the second", "the next one"): one control by
  // construction, and the one meant only for as long as the page keeps that order.
  var placed: Bool { index != nil || after != nil }
  // What kind of evidence the way is: the desktop's word for the control ("name"), its turn among
  // others ("place"), or something the page marks it with (a class, a declared shortcut, an
  // address, being the only one of its role in its box: "mark").
  var kind: String { worded ? "name" : placed ? "place" : "mark" }
}
// One way to find a control, or several: a profile writes either.
func locatorList(_ key: String, _ value: Any?) -> [Locator] {
  if let spec = value as? [String: Any] { return [Locator(key, spec)] }
  return (value as? [[String: Any]] ?? []).map { Locator(key, $0) }
}
let locators: [String: [Locator]] = {
  var out: [String: [Locator]] = [:]
  for (key, value) in profile["locators"] as? [String: Any] ?? [:] { out[key] = locatorList(key, value) }
  return out
}()

// ---- the app ----
let bundleId = setting("bundleId")
let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first
if args.first == "check" { out(["ok": true, "trusted": AXIsProcessTrusted(), "running": app != nil]) }
guard !bundleId.isEmpty else { fail("usage", "缺少桌面版的配置（AX_PROFILE）") }
guard AXIsProcessTrusted() else { fail("not_trusted", "工作台没有辅助功能权限") }
guard let app else { fail("not_running", "桌面版没有在运行") }

let appRoot = AXUIElementCreateApplication(app.processIdentifier)
// Chromium builds its page's accessibility tree only once a client asks for it, and how it is asked
// depends on the app's shell (profile "accessibilitySwitches", set to true on the app): Electron's
// answers AXManualAccessibility; a Chrome-based shell (Codex since its 2026-11 update, principal
// class BrowserCrApplication) has no such attribute and answers only AXEnhancedUserInterface, the
// one VoiceOver sets. Asking the wrong one leaves the window a handful of empty groups for good.
let accessibilitySwitches = settings("accessibilitySwitches").isEmpty ? ["AXManualAccessibility"] : settings("accessibilitySwitches")
func switchOn() { for name in accessibilitySwitches { AXUIElementSetAttributeValue(appRoot, name as CFString, kCFBooleanTrue) } }
switchOn()

// ---- reading the tree ----
// Every attribute read is a round trip to the desktop's process, and a search asks every element
// on the page for several of them. So what an element says is kept until something could have
// changed it (`stale()`: after every action and every pause), and the attributes a search looks at
// are fetched together, in one round trip per element. Between two actions the page is searched
// many times (is the menu open, which row, what does the button say): all of them read it once.
let together = ["AXRole", "AXTitle", "AXDescription", "AXValue", "AXSubrole", "AXChildren", "AXDOMClassList", "AXKeyShortcutsValue", "AXDOMIdentifier"]
let togetherSet = Set(together), absent = NSNull()
var known: [AXUIElement: [String: AnyObject]] = [:]
func stale() { known.removeAll(keepingCapacity: true); soleNow.removeAll(keepingCapacity: true) }
func attr(_ e: AXUIElement, _ n: String) -> AnyObject? {
  if let kept = known[e]?[n] { return kept === absent ? nil : kept }
  reads += 1
  if togetherSet.contains(n) {
    var values: CFArray?
    var entry = known[e] ?? [:]
    if AXUIElementCopyMultipleAttributeValues(e, together as CFArray, [], &values) == .success, let list = values as? [AnyObject], list.count == together.count {
      // An attribute the element does not have comes back as an error value in its place.
      for (index, key) in together.enumerated() {
        let got = list[index]
        entry[key] = CFGetTypeID(got) == AXValueGetTypeID() && AXValueGetType(got as! AXValue) == .axError ? absent : got
      }
    } else { for key in together { entry[key] = absent } }
    known[e] = entry
    let kept = entry[n]
    return kept === absent ? nil : kept
  }
  var v: AnyObject?
  let got = AXUIElementCopyAttributeValue(e, n as CFString, &v) == .success ? v : nil
  known[e, default: [:]][n] = got ?? absent
  return got
}
// A control's label: its title and description, once when the desktop gives both the same text.
func label(_ e: AXUIElement) -> String {
  let parts = [attr(e, "AXTitle") as? String, attr(e, "AXDescription") as? String].compactMap { $0 }.filter { !$0.isEmpty }
  return parts.count == 2 && parts[0] == parts[1] ? parts[0] : parts.joined(separator: " ")
}
// A control's name: its title, or its description when it has no title.
func name(_ e: AXUIElement) -> String { let title = attr(e, "AXTitle") as? String ?? ""; return title.isEmpty ? (attr(e, "AXDescription") as? String ?? "") : title }
func named(_ e: AXUIElement, _ text: String) -> Bool { let own = name(e); return own == text || own.hasPrefix(text + " ") }
func role(_ e: AXUIElement) -> String { attr(e, "AXRole") as? String ?? "" }
func value(_ e: AXUIElement) -> String { attr(e, "AXValue") as? String ?? "" }
// Windows on another Space are missing from AXWindows; the main window is still reachable.
func root() -> AXUIElement { (attr(appRoot, "AXMainWindow") as! AXUIElement?) ?? appRoot }
func walk(_ e: AXUIElement, _ depth: Int = 0, _ visit: (AXUIElement) -> Bool) -> Bool {
  if depth > 60 { return false }
  if visit(e) { return true }
  for c in (attr(e, "AXChildren") as? [AXUIElement] ?? []) { if walk(c, depth + 1, visit) { return true } }
  return false
}
func first(_ match: (AXUIElement) -> Bool) -> AXUIElement? { var hit: AXUIElement?; _ = walk(root()) { e in if match(e) { hit = e; return true }; return false }; return hit }
func every(_ match: (AXUIElement) -> Bool) -> [AXUIElement] { var hits: [AXUIElement] = []; _ = walk(root()) { e in if match(e) { hits.append(e) }; return false }; return hits }
func within(_ box: AXUIElement, _ match: (AXUIElement) -> Bool) -> [AXUIElement] { var hits: [AXUIElement] = []; _ = walk(box) { e in if match(e) { hits.append(e) }; return false }; return hits }

func classes(_ e: AXUIElement) -> [String] { attr(e, "AXDOMClassList") as? [String] ?? [] }
// What the element itself is; where it is ("inside", "after", "index") is `matches`.
func fits(_ e: AXUIElement, _ l: Locator) -> Bool {
  let own = role(e)
  if let wantRole = l.role, own != wantRole { return false }
  if !l.roles.isEmpty, !l.roles.contains(own) { return false }
  if let sub = l.subrole, attr(e, "AXSubrole") as? String != sub { return false }
  if let id = l.id, attr(e, "AXDOMIdentifier") as? String != id { return false }
  if let keys = l.keys, attr(e, "AXKeyShortcutsValue") as? String != keys { return false }
  if !l.classes.isEmpty {
    let has = classes(e)
    for want in l.classes { if want.hasSuffix("*") ? !has.contains(where: { $0.hasPrefix(want.dropLast()) }) : !has.contains(want) { return false } }
  }
  if let want = l.popup, (attr(e, "AXHasPopup").map { "\($0)" == "1" } ?? false) != want { return false }
  // (Asked last and only of what fits so far: an address is a round trip of its own.)
  if let want = l.url {
    let own = attr(e, "AXURL").map { "\($0)" } ?? ""
    if want.hasSuffix("*") ? !own.hasPrefix(want.dropLast()) : own != want { return false }
  }
  if !l.worded && !l.named { return true }
  let names = [label(e), name(e)]
  if let exact = l.name, !names.contains(exact) { return false }
  if let start = l.prefix, !names.contains(where: { $0.hasPrefix(start) }) { return false }
  if let part = l.contains?.lowercased(), !names.contains(where: { $0.lowercased().contains(part) }) { return false }
  if l.named, names.allSatisfy({ $0.isEmpty }) { return false }
  return true
}
// Everything one way of finding a control finds, in the order the page lists it. (`depth`: a
// locator placed by another, placed by another…: a profile that goes round in a circle finds nothing.)
func matches(_ l: Locator, _ depth: Int = 0) -> [AXUIElement] {
  guard depth < 5 else { return [] }
  var scope = root()
  if let inside = l.inside { guard let box = find(inside, depth + 1) else { return [] }; scope = box }
  var hits: [AXUIElement] = []
  if let after = l.after {
    guard let mark = find(after, depth + 1) else { return [] }
    var seen = false
    _ = walk(scope) { e in if !seen { seen = CFEqual(e, mark) } else if fits(e, l) { hits.append(e) }; return false }
  } else { hits = within(scope) { fits($0, l) } }
  if let has = l.has {
    let held = findAll(has, depth + 1)
    hits = hits.filter { box in held.contains { part in !CFEqual(part, box) && !within(box, { CFEqual($0, part) }).isEmpty } }
  }
  guard let index = l.index else { return hits }
  let at = index < 0 ? hits.count + index : index
  return hits.indices.contains(at) ? [hits[at]] : []
}
func findAll(_ key: String, _ depth: Int = 0) -> [AXUIElement] {
  for l in locators[key] ?? [] { let hits = matches(l, depth); if !hits.isEmpty { return hits } }
  return []
}
// (Which locator found the control, and by which of its ways, is kept with it: `origin`, for the
// check before anything is done to it; `via`, for the answer.)
func find(_ key: String, _ depth: Int = 0) -> AXUIElement? {
  for (way, l) in (locators[key] ?? []).enumerated() {
    // Placed nowhere in particular: the first one on the page is enough, the rest is not read.
    let hit = l.inside == nil && l.after == nil && l.index == nil && l.has == nil ? first({ fits($0, l) }) : matches(l, depth).first
    if let hit { origin[hit] = (key, way); via[key] = way; return hit }
  }
  return nil
}
// Whether the element is what the locator finds, by any of its ways.
func fits(_ e: AXUIElement, _ key: String) -> Bool { (locators[key] ?? []).contains { fits(e, $0) } }

// ---- one control, or none ----
// Looking takes the first control a way finds: a look is repeated many times while the page
// settles, and reading the whole page for each would cost a few tenths of a second every time.
// Doing is another matter. A press on the first of two controls that both answer to "send" is a
// plausible success against the wrong one, so before anything is done to a control a locator
// found (`act`, `setValue`, `insert`, `focus`), the way that found it is asked for everything it
// finds, once per read of the page. Exactly one: go on. Several: another of the locator's ways may
// still single out this very control; if none does, nothing is done, the flow's own check of the
// step then fails the command, and the answer says why ("ambiguous"). A way that goes by its
// place finds one control by construction (see "a control found by its place" for what holds
// that one to account). The box a control was looked for in, and the control it was counted
// from, have to be the only ones too. Controls a flow picks out itself (a menu's row, a sidebar
// row) are not a locator's and are the flow's to check.
func sole(_ e: AXUIElement, _ depth: Int = 0) -> Bool {
  guard depth < 5, let from = origin[e], let ways = locators[from.key], ways.indices.contains(from.way), !soleNow.contains(e) else { return true }
  let l = ways[from.way]
  if !l.placed {
    let hits = matches(l)
    if hits.count > 1 {
      let singled = ways.enumerated().contains { other in other.offset != from.way && !other.element.placed && { let found = matches(other.element); return found.count == 1 && CFEqual(found[0], e) }() }
      if !singled { refused[from.key] = hits.count; trace("held back: \(hits.count) controls answer to \(from.key)"); return false }
    }
  }
  for anchor in [l.inside, l.after].compactMap({ $0 }) { if let box = find(anchor, depth + 1), !sole(box, depth + 1) { return false } }
  // (`find` above may have found this control's box under the control's own key: what is kept is this one.)
  origin[e] = from
  soleNow.insert(e)
  return true
}

// ---- does the profile still match the desktop? ----
// What `probe` answers, and what the server asks about once a minute while the console is in use
// (`warm check`): nothing is pressed.
//   found    how many each locator finds (by the first of its ways that finds anything)
//   ways     for a locator with several ways, how many each finds, in the profile's order
//   differ   the locators whose ways found different controls. On a desktop in the language the
//            names were written in every way should find the same one: that is how a way that does
//            not go by the name is checked.
//   drift    the locators that a way going by a mark of the page (a class, a declared shortcut)
//            no longer finds, though a later way (the name, a place) still does: the desktop has
//            changed under the profile. In the language the names were written in everything
//            keeps working, which is why nobody would notice; in any other, that control is now
//            found by its place or not at all. Only where the control the later way finds is one
//            the mark should have covered: of the role it looks for, and in the box it looks in
//            (a heading is not the page a mark tells by its address; a "Send" outside the composer
//            is another control with the same name).
//   several  the locators an action would be held back on (see "one control, or none")
func profileCheck() -> (found: [String: Int], ways: [String: [Int]], differ: [String], drift: [String], several: [String: Int]) {
  var found: [String: Int] = [:], ways: [String: [Int]] = [:], differ: [String] = [], drift: [String] = [], several: [String: Int] = [:]
  for key in locators.keys.sorted() {
    let list = locators[key] ?? [], each = list.map { matches($0) }
    let at = each.firstIndex { !$0.isEmpty }
    found[key] = at.map { each[$0].count } ?? 0
    if let at, !list[at].placed, each[at].count > 1 {
      let singled = each.enumerated().contains { $0.offset != at && !list[$0.offset].placed && $0.element.count == 1 && CFEqual($0.element[0], each[at][0]) }
      if !singled { several[key] = each[at].count }
    }
    guard each.count > 1 else { continue }
    ways[key] = each.map { $0.count }
    let firsts = each.compactMap { $0.first }
    if let one = firsts.first, firsts.contains(where: { !CFEqual($0, one) }) { differ.append(key) }
    if let at, at > 0, let hit = each[at].first {
      let lost = list[..<at].contains { way in
        guard way.kind == "mark", way.role.map({ $0 == role(hit) }) ?? true, way.roles.isEmpty || way.roles.contains(role(hit)) else { return false }
        guard let inside = way.inside, let box = find(inside) else { return true }
        return !within(box) { CFEqual($0, hit) }.isEmpty
      }
      if lost { drift.append(key) }
    }
  }
  return (found, ways, differ, drift, several)
}
// A menu's button says what it shows after what it is: "Model: Opus 5.5", "Folder: ~/work". A page
// in Chinese or Japanese writes the colon full width, with no space after it.
func labelled(_ text: String) -> (label: String, value: String)? {
  let found = [text.range(of: ": "), text.range(of: "：")].compactMap { $0 }
  guard let colon = found.min(by: { $0.lowerBound < $1.lowerBound }) else { return nil }
  return (String(text[..<colon.lowerBound]), String(text[colon.upperBound...]).trimmingCharacters(in: .whitespaces))
}

// ---- no window ----
// A desktop whose last window was closed keeps running without one (macOS), and a page that is not
// there cannot be read. The two commands that take the person to the desktop (open-file,
// show-session) bring a window back the way the Dock does: `open -b` sends the app its reopen
// event, and the app opens its window again (in front, where those commands leave it anyway).
// No other command does this: they work out of the person's sight.
func windowless() -> Bool { stale(); return (attr(appRoot, "AXWindows") as? [AXUIElement] ?? []).isEmpty && attr(appRoot, "AXMainWindow") == nil }
if let command = args.first, ["open-file", "show-session"].contains(command), windowless() {
  trace("no window: reopening")
  let reopen = Process(); reopen.executableURL = URL(fileURLWithPath: "/usr/bin/open"); reopen.arguments = ["-b", bundleId]
  try? reopen.run(); reopen.waitUntilExit()
  for _ in 0..<50 where windowless() { usleep(100_000) }
  if windowless() { fail("no_window", "\(appName)没有打开的窗口，工作台也没能让它重新打开：在程序坞里点一下它的图标再试") }
  // (Set again for the new window's page: the switch is only ever set to true.)
  switchOn()
}

// The page's tree is built some time after the accessibility switch is first set (seen on Codex
// after it restarted: a window of six empty groups for about a second). Until it has, every
// control would read as missing, so wait for it (up to three seconds) before anything looks.
// A page that is there but still filling in (a desktop with several pages: the window's own parts
// arrive before the conversation's) has none of the controls every page of the app shows: the
// profile's "refreshAnchors" (a composer, a pane). So the wait is for one of those; a page that
// shows none of them (settings, a sign-in) is given a second, then taken as it is.
var ready = false
// Still a window of empty groups when the wait ends: the page's tree was never built (see "no page").
var pageEmpty = false
do {
  func size(_ e: AXUIElement, _ depth: Int = 0) -> Int { depth > 12 ? 0 : 1 + (attr(e, "AXChildren") as? [AXUIElement] ?? []).reduce(0) { $0 + size($1, depth + 1) } }
  let anchors = settings("refreshAnchors")
  func built() -> Bool { anchors.isEmpty ? size(root()) >= 40 : anchors.contains { find($0) != nil } }
  // warm only looks: a page that is not there yet is reported, not waited for. A page that has not
  // started at all is given longer: the switch has only just been set, and a Chrome-based shell
  // turns its tree on a few seconds after it is asked (Codex: between three and four).
  let patience = args.first == "warm" ? 0.0 : 3.0, emptyPatience = args.first == "warm" ? 0.0 : 8.0
  while true {
    ready = built()
    let waited = Date().timeIntervalSince(startedAt), filled = size(root()) >= 40
    if ready || (filled && waited >= 1.2) || waited >= (filled ? patience : emptyPatience) { break }
    usleep(100_000); stale()
  }
  pageEmpty = !ready && size(root()) < 40
  trace("page \(ready ? "ready" : pageEmpty ? "empty" : "not ready") (\(known.count) elements)")
}

// ---- keeping warm ----
// Chromium drops its accessibility tree again once the person has used the app for half a minute
// with no accessibility client asking, and builds it only while the window is being drawn: a
// command arriving then finds an empty page, and one hidden behind other windows stays empty.
// While the console is in use the server runs `warm` every few seconds (desktop-automation.ts):
// reading the page counts as a client asking, so the tree is still there when a command comes.
// (The accessibility switch is only ever set to true. Setting it false and true again to "reset" a
// stale page was tried: it throws the tree away at once, and with the window behind another app
// or on another Space it stayed empty for as long as it was watched, 13 seconds and more.)
// `warm check` also says whether the profile still matches the page it read (profileCheck): the
// server asks that once a minute, and tells the person when a control has lost its mark.
if args.first == "warm" {
  var answer: [String: Any] = ["ok": true, "ready": ready]
  if args.contains("check"), ready { let state = profileCheck(); answer["checked"] = true; answer["drift"] = state.drift; answer["differ"] = state.differ }
  answer["elements"] = known.count
  out(answer)
}

// ---- off screen ----
// While the window is not on screen (full screen on another Space, another desktop) the page
// still does what it is told, but its accessibility tree is only brought up to date when an
// accessibility action arrives, and only around the control the action is for. So every pause
// ends by asking a control to scroll into view (it already is: nothing moves): the open menu's
// own button while a menu is open (a menu hides the page behind it from the tree, so an action
// on the composer would not reach the menu), otherwise the profile's "refreshAnchors".
func onScreen() -> Bool {
  let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
  return windows.contains { ($0[kCGWindowOwnerPID as String] as? pid_t) == app.processIdentifier && ($0[kCGWindowLayer as String] as? Int) == 0 }
}

// ---- no page ----
// Still the handful of empty groups after the wait: the page never reached the accessibility tree.
// Either the desktop did not take the profile's switch (an update that changed its shell: see
// "accessibilitySwitches" above), or, with Electron, its window has not been drawn since the tree
// was dropped (off screen, on another Space). Every control would then read as missing and each
// flow would report a step it never got to ("couldn't open the New chat page"), so a command that
// acts on the page stops here and says so.
if pageEmpty, let command = args.first, !["probe", "space", "chat-status"].contains(command) {
  if onScreen() { fail("page_empty", "\(appName)的页面没有接进辅助功能，工作台读不到它的界面（桌面版刚更新过的话，可能换了打开辅助功能的方式）") }
  fail("page_empty", "\(appName)的窗口不在屏幕上，页面没有接进辅助功能：把它的窗口切到前台看一眼再试，还不行的话可能是桌面版更新后换了打开辅助功能的方式")
}

var anchor: AXUIElement?
func refresh() {
  guard !onScreen() else { return }
  var target = anchor.flatMap { role($0).isEmpty ? nil : $0 }
  if target == nil { for key in settings("refreshAnchors") { if let hit = find(key) { target = hit; break } } }
  if let target { act(target, "AXScrollToVisible"); usleep(120_000); stale() }
}
func wait(_ seconds: Double = 0.25) { usleep(UInt32(seconds * 1_000_000)); stale(); refresh() }
// Looks every `step` until `done` holds or `seconds` have passed; says whether it came to hold.
// A look costs one read of the page, so what is waited for is noticed within a tenth of a second
// instead of at the next fixed pause.
@discardableResult func until(_ seconds: Double, step: Double = 0.1, _ done: () -> Bool) -> Bool {
  let end = Date().addingTimeInterval(seconds)
  while true {
    if done() { return true }
    if Date() >= end { return false }
    wait(step)
  }
}

// ---- actions ----
// Anything done to the page ends what was read from it (`stale`). Nothing is done to a control
// that is not the only one its locator finds (`sole`); scrolling into view is how the page is kept
// fresh, changes nothing, and is not held back.
@discardableResult func act(_ e: AXUIElement, _ action: String) -> AXError {
  guard action == "AXScrollToVisible" || sole(e) else { return .failure }
  let result = AXUIElementPerformAction(e, action as CFString); stale(); return result
}
func press(_ e: AXUIElement) { trace("press \(name(e).prefix(40))"); act(e, kAXPressAction as String) }
func setValue(_ e: AXUIElement, _ text: String) { guard sole(e) else { return }; AXUIElementSetAttributeValue(e, kAXValueAttribute as CFString, text as CFString); stale() }
func focus(_ e: AXUIElement) { guard sole(e) else { return }; AXUIElementSetAttributeValue(e, kAXFocusedAttribute as CFString, kCFBooleanTrue); stale() }
func focused(_ e: AXUIElement) -> Bool { attr(e, "AXFocused") as? Bool ?? false }
func expanded(_ e: AXUIElement) -> Bool { attr(e, "AXExpanded") as? Bool ?? false }
func checked(_ e: AXUIElement) -> Bool { attr(e, "AXValue").map { "\($0)" } == "1" }
// Replaces the field's text through its selection, the other way an editor takes text.
func insert(_ e: AXUIElement, _ text: String) {
  guard sole(e) else { return }
  focus(e); wait(0.15)
  var range = CFRange(location: 0, length: (attr(e, "AXNumberOfCharacters") as? Int) ?? 0)
  AXUIElementSetAttributeValue(e, kAXSelectedTextRangeAttribute as CFString, AXValueCreate(.cfRange, &range)!)
  AXUIElementSetAttributeValue(e, kAXSelectedTextAttribute as CFString, text as CFString)
  stale()
}
// An empty editor may read as its placeholder, which is also its name (Codex: "Do anything").
func holdsText(_ box: AXUIElement) -> Bool { let own = value(box).trimmingCharacters(in: .whitespacesAndNewlines); return !own.isEmpty && own != name(box) }
// A send button that only its name tells from what else its place shows (Codex: the voice button
// while the box is empty, Send once it holds text — same place, same classes). By its name; on a
// desktop shown in another language, the button in that place (the profile's "sendSlot", a
// locator) once it is called something else than it was while the box was empty: `fill` notes
// that name before it writes. Nothing is taken for Send while the name has not changed.
var slotIdleName: String?
func sendButton(_ key: String) -> AXUIElement? {
  if let hit = find(key) { return hit }
  guard let idle = slotIdleName, let slot = find(setting("sendSlot")), !name(slot).isEmpty, name(slot) != idle else { return nil }
  return slot
}
// An editor accepts one of the two ways depending on its state: take whichever makes the field
// hold the text and the profile's send button appear.
func fill(_ field: String, _ text: String, ready: String) -> Bool {
  if slotIdleName == nil, let box = find(field), !holdsText(box), let slot = find(setting("sendSlot")) { slotIdleName = name(slot) }
  for method in 0..<4 {
    guard let box = find(field) else { wait(); continue }
    if method % 2 == 0 { setValue(box, text) } else { insert(box, text) }
    for _ in 0..<4 { wait(0.2); if let box = find(field), value(box).trimmingCharacters(in: .whitespacesAndNewlines) == text.trimmingCharacters(in: .whitespacesAndNewlines), sendButton(ready) != nil { return true } }
  }
  return false
}
func clear(_ field: String) { if let box = find(field), !value(box).isEmpty { setValue(box, ""); wait(0.15); if let again = find(field), !value(again).isEmpty { insert(again, "") } } }
// A key goes to the app (not the screen), to whatever has the focus inside its page.
enum Key: CGKeyCode { case escape = 53, space = 49, left = 123, right = 124, down = 125, up = 126 }
// (Down and up go out together; the page is looked at again once, after both.)
// A key lands on whatever has the focus. Once a control was held back (`refused`: the focus may
// not be where the flow thinks it put it), only Escape still goes out, to close what is open.
func key(_ code: Key) {
  guard refused.isEmpty || code == .escape else { trace("key \(code) held back"); return }
  trace("key \(code)")
  for down in [true, false] { CGEvent(keyboardEventSource: CGEventSource(stateID: .hidSystemState), virtualKey: code.rawValue, keyDown: down)?.postToPid(app.processIdentifier); usleep(30_000) }
  wait(0.03)
}

// ---- menus ----
func items() -> [AXUIElement] { every { role($0) == "AXMenuItem" } }
func item(_ text: String) -> AXUIElement? { items().first { named($0, text) } }
// A menu's row is told by its name, and most rows carry nothing else. A desktop shown in another
// language names them otherwise; what stays is the order the menu lists its rows in, and for some
// rows a shortcut the page declares (`shortcut`). So a flow that does not find a row by its name
// may take it by its place — but only in a menu none of whose rows is named as the profile names
// them (`wordless`: with the profile's words on screen, a row that is not found is simply not
// there), and only where the flow knows how many rows to expect, so a menu the desktop has
// rearranged is refused, not guessed at.
func shortcut(_ e: AXUIElement) -> String { attr(e, "AXKeyShortcutsValue") as? String ?? "" }
// A desktop may keep a menu's rows in the tree after the menu has closed (Claude: every menu
// opened once stays there, its rows still declaring their numbers), so "the second row" of all
// the rows on the page can be another menu's. A row taken by its place is taken from the menu
// that was opened: the profile's "menuPopup" says what a menu's box is, and the page names each
// box after what opened it (the button, or the row a submenu hangs off). Without that locator
// every row counts; with it, a box that is not found gives no rows, and nothing is picked.
func menuRows(_ opener: AXUIElement?) -> [AXUIElement] {
  guard locators["menuPopup"] != nil else { return items() }
  guard let own = opener.map(name), !own.isEmpty, let box = findAll("menuPopup").first(where: { name($0) == own }) else { return [] }
  return within(box) { role($0) == "AXMenuItem" }
}
func opensSubmenu(_ e: AXUIElement) -> Bool { attr(e, "AXHasPopup").map { "\($0)" == "1" } ?? false }
func wordless(_ rows: [AXUIElement], _ words: [String]) -> Bool { !rows.contains { row in words.contains { !$0.isEmpty && named(row, $0) } } }
// Opens the menu behind `menu`. On screen a press opens it. Off screen it depends on the app
// (profile "offscreenMenu"): "press" works as on screen; "key" focuses the button and sends the
// down arrow, which only goes out once the button really has the focus (anywhere else the arrow
// would move a caret). `opened` says what an open menu shows (default: any menu item).
func open(_ menu: () -> AXUIElement?, opened: (() -> Bool)? = nil) -> Bool {
  refresh()
  guard let button = menu() else { return false }
  anchor = button
  if !expanded(button) {
    if onScreen() || setting("offscreenMenu") != "key" { press(button) }
    else {
      var asked = Date.distantPast
      let ready = until(1.6, step: 0.06) {
        if let button = menu(), focused(button) { return true }
        if Date().timeIntervalSince(asked) > 0.2, let button = menu() { focus(button); asked = Date() }
        return false
      }
      guard ready else { anchor = nil; return false }
      key(.down)
    }
  }
  let began = Date()
  var again = false
  let shown = until(3, step: 0.08) {
    if let button = menu(), expanded(button), opened?() ?? !items().isEmpty { anchor = button; return true }
    // A press that came while the page was still settling (a chat just brought on screen) is
    // lost: press once more if the button still says closed.
    if !again, Date().timeIntervalSince(began) > 1.2, setting("offscreenMenu") != "key", let button = menu(), !expanded(button) { again = true; press(button) }
    return false
  }
  if !shown { anchor = nil }
  trace("menu \(shown ? "open" : "did not open")")
  if shown, let button = menu(), !confirmed(button) { close(menu); return false }
  return shown
}
// ---- a control found by its place ----
// "The second menu in the box" finds something whatever the page has become: with the control
// gone, or one more menu added before it, it is the neighbour. A place is therefore never taken
// on its own word. A menu button found by its place has to open the menu the profile describes
// for it ("menuSigns": { <locator>: <what one of that menu's rows is, as a locator spec: its
// class, the keys it declares, that it opens a submenu> }): a mark of the menu itself, which no
// language changes and no other menu on the page carries. A menu that shows no such row is closed
// again, nothing in it is picked, and the answer says so ("unconfirmed"). A button found by its
// name or by a mark of its own is taken at that; so is one whose locator has no sign (its flow
// then tells the menu by what it looks for in it).
let menuSigns = profile["menuSigns"] as? [String: Any] ?? [:]
func confirmed(_ button: AXUIElement) -> Bool {
  guard let from = origin[button], let ways = locators[from.key], ways.indices.contains(from.way), ways[from.way].placed, let spec = menuSigns[from.key] else { return true }
  let signs = locatorList(from.key, spec)
  // (The rows can be a moment behind the menu saying it is open.)
  let holds = until(1.2) { menuRows(button).contains { row in signs.contains { fits(row, $0) } } }
  if !holds { unconfirmed.append(from.key); trace("the menu \(from.key) opened is not the one the profile describes") }
  return holds
}
// Escape closes an open menu off screen; it is only sent while the button says its menu is open
// (with nothing open, Escape would reach the conversation).
func close(_ menu: () -> AXUIElement?) {
  refresh()
  defer { anchor = nil }
  guard let button = menu(), expanded(button) else { return }
  if onScreen() && setting("offscreenMenu") == "key" { press(button) } else { key(.escape) }
  // Gone as soon as its button says so (it used to be a fixed pause).
  until(0.5, step: 0.06) { menu().map { !expanded($0) } ?? true }
}
// A question the desktop puts over the page (an alert dialog); nothing else responds until it is answered.
func dialog() -> AXUIElement? { first { attr($0, "AXSubrole") as? String == "AXApplicationAlertDialog" } }
func inDialog(_ box: AXUIElement, _ match: (AXUIElement) -> Bool) -> [AXUIElement] { within(box, match) }
// Answered with the profile's "cancel" (a button named Cancel where the profile has none).
func dismiss() { if let box = dialog(), let cancel = inDialog(box, { locators["cancel"] == nil ? role($0) == "AXButton" && name($0) == "Cancel" : fits($0, "cancel") }).first { press(cancel); wait(0.4) } }

// ---- which conversation is on screen, and going to one ----
// Read from the web area's title: with a "titleSuffix" ("<title> - Claude Code") only a title
// with it counts; titles in "blankTitles" are pages that are not a conversation.
// The mode a command acts in may name its pages differently (Claude: "<title> - Claude" in its
// Claude mode): the profile's spaces.titleSuffix, set once the mode is known.
var modeTitleSuffix: String?
func current() -> String {
  let suffix = modeTitleSuffix ?? setting("titleSuffix"), blank = settings("blankTitles")
  for title in every({ role($0) == "AXWebArea" }).compactMap({ attr($0, "AXTitle") as? String }) {
    if !suffix.isEmpty { if title.hasSuffix(suffix) { return String(title.dropLast(suffix.count)) } else { continue } }
    return blank.contains(title) ? "" : title
  }
  return ""
}
// Sidebar rows are buttons named "<title>", or "<title> <state>" ("Running", "Started by …"):
// every row that may be the conversation, the likeliest first (its exact name, then with a state).
func titledRows(_ title: String) -> [AXUIElement] {
  let rows = every { role($0) == "AXButton" && label($0).hasPrefix(title) }
  let exact = rows.filter { label($0) == title }, stated = rows.filter { label($0).hasPrefix(title + " ") }
  return exact + stated + rows.filter { label($0) != title && !label($0).hasPrefix(title + " ") }
}
func row(_ title: String) -> AXUIElement? { titledRows(title).first }
// Opens a link with `open -g`, which does not bring the app to the front.
func openLink(_ template: String, _ values: [String: String]) {
  var link = template
  for (k, v) in values { link = link.replacingOccurrences(of: "{\(k)}", with: v.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? v) }
  let open = Process(); open.executableURL = URL(fileURLWithPath: "/usr/bin/open")
  open.arguments = ["-g", link]; try? open.run(); open.waitUntilExit(); stale()
}
// A conversation known by its address. A desktop whose page has an address of its own for each
// conversation (profile "sessionAddress", its path with {localId}/{id}: Antigravity's "/c/{localId}")
// is asked by that rather than by title, which two conversations may share and which the page
// writes its own way ("<title> - <project> - Antigravity"): the page shows the conversation when
// its web area's address has that path, and the sidebar's row for it is the link that points there
// (looked for inside the profile's "sessionList" locator, when it has one). A long list is drawn
// only near what is on screen, so rows it has not drawn are brought in by scrolling its last drawn
// row into view, down to the list's end, then its first, up to its start, until the row is there.
func address(_ ids: [String: String]) -> String {
  var path = setting("sessionAddress")
  guard !path.isEmpty else { return "" }
  for (k, v) in ids where !v.isEmpty { path = path.replacingOccurrences(of: "{\(k)}", with: v) }
  return path.contains("{") ? "" : path
}
func pathOf(_ e: AXUIElement) -> String { attr(e, "AXURL").map { "\($0)" }.flatMap { URL(string: $0)?.path } ?? "" }
func showing(_ path: String) -> Bool { every { role($0) == "AXWebArea" }.contains { pathOf($0) == path } }
// The rows that lead to a conversation, in the order the page lists them: links whose path has the
// template's shape ("/c/{localId}" → "/c/" and one more part).
let rowShape: NSRegularExpression? = {
  let template = setting("sessionAddress")
  guard !template.isEmpty else { return nil }
  let pattern = NSRegularExpression.escapedPattern(for: template).replacingOccurrences(of: #"\\\{[A-Za-z]+\\\}"#, with: "[^/]+", options: .regularExpression)
  return try? NSRegularExpression(pattern: "^\(pattern)$")
}()
func sessionRows() -> [AXUIElement] {
  guard let shape = rowShape else { return [] }
  let box = locators["sessionList"] == nil ? root() : find("sessionList") ?? root()
  return within(box) { e in
    guard ["AXLink", "AXButton"].contains(role(e)) else { return false }
    let path = pathOf(e)
    return !path.isEmpty && shape.firstMatch(in: path, range: NSRange(path.startIndex..., in: path)) != nil
  }
}
func rowAt(_ path: String) -> AXUIElement? {
  var seen = Set<String>()
  for downward in [true, false] {
    // The list's end in that direction: the row at its edge stays the same however it is scrolled.
    var edgeBefore = "", still = 0
    for _ in 0..<40 {
      let rows = sessionRows()
      if let hit = rows.first(where: { pathOf($0) == path }) { return hit }
      seen.formUnion(rows.map(pathOf))
      guard let edge = downward ? rows.last : rows.first else { break }
      let edgePath = pathOf(edge)
      still = edgePath == edgeBefore ? still + 1 : 0
      if still >= 2 { break }
      edgeBefore = edgePath
      act(edge, "AXScrollToVisible"); wait(0.3)
    }
  }
  trace("no row for \(path) among \(seen.count)")
  return nil
}
// The address of the conversation on screen: the path of the web area that has the template's
// shape ("" with no "sessionAddress", or on a page that is not a conversation).
func shownAddress() -> String {
  guard let shape = rowShape else { return "" }
  for area in every({ role($0) == "AXWebArea" }) {
    let path = pathOf(area)
    if !path.isEmpty, shape.firstMatch(in: path, range: NSRange(path.startIndex..., in: path)) != nil { return path }
  }
  return ""
}
// Is this conversation the one on screen: by its address when the page has one, else by its title.
func isShown(_ title: String, _ at: String) -> Bool { at.isEmpty ? current() == title : showing(at) }
// A deep link ("sessionLink") brings the desktop to the front whatever `open -g` asks (Claude's
// does, measured), so it is used only by the commands that bring it there anyway, because the
// person asked to be taken to the desktop. Every other command works with the window where it is.
var mayFront: Bool { ["open-file", "show-session"].contains(args.first ?? "") }
// Brings the conversation on screen inside the desktop's window: its sidebar row (rows the sidebar
// keeps folded away are unfolded first), or, for a command that may bring the desktop to the front,
// the profile's "sessionLink" with {localId}/{id}.
func show(_ title: String, _ ids: [String: String] = [:]) -> Bool { show(title, at: address(ids), ids) }
func show(_ title: String, at: String, _ ids: [String: String] = [:]) -> Bool {
  let here = { isShown(title, at) }
  if here() { return true }
  let link = setting("sessionLink")
  let linkable = mayFront && !link.isEmpty && !ids.isEmpty && !ids.values.contains(where: { $0.isEmpty })
  // A desktop whose page has an address but whose rows are known only by title (profile
  // "sessionRowsBy": "title"; Claude's rows are plain buttons, its page "/epitaxy/local_…"): two
  // conversations may share the title, so each row with it is pressed in turn until the page's
  // address is this conversation's. None of them → not shown, and the command does nothing to
  // whatever conversation is on screen instead.
  if !at.isEmpty && setting("sessionRowsBy") == "title" {
    func byRows() -> Bool {
      var index = 0
      while true {
        let rows = titledRows(title)
        guard index < rows.count else { return false }
        let before = shownAddress()
        press(rows[index]); index += 1
        // A row that opens another conversation says so as soon as the page's address changes.
        until(2) { here() || shownAddress() != before }
        if until(0.5, here) { trace("showing \(title.prefix(30)) by row \(index)"); return true }
      }
    }
    if byRows() { return true }
    // Rows the sidebar folds away (profile "moreSessions": a project's "Show 20 more";
    // "nestedSessions": the sessions under another) are unfolded where they are, which leaves the
    // desktop behind the person's app, and the rows with the title are tried again each time more
    // of them are drawn.
    var tried = titledRows(title).count
    for _ in 0..<16 {
      guard let more = findAll("moreSessions").first ?? findAll("nestedSessions").first else { break }
      press(more); wait(0.4); stale()
      let count = titledRows(title).count
      if count > tried { tried = count; if byRows() { return true } }
    }
    if linkable { openLink(link, ids); if until(3, here) { trace("showing \(title.prefix(30)) by link"); return true } }
    trace("no row shows \(at)")
    return false
  }
  for attempt in 0..<4 {
    if !at.isEmpty {
      // Every row of the list was looked through: another try finds no more.
      guard let found = rowAt(at) else { return false }
      press(found)
    } else if let button = row(title) { press(button) }
    else if attempt == 1, linkable { openLink(link, ids) }
    if until(2, here) { trace("showing \(title.prefix(30))"); return true }
  }
  return false
}
// The conversation a command goes back to when it is done: the one on screen as it starts, or,
// with the desktop parked on its new-chat page, the one the person had before that.
func startedOn() -> String { let now = current(); return now.isEmpty ? parkedPrevious : now }
// Its address, when the page has one (a conversation parked away from has none here: by title).
func startedAddress() -> String { current().isEmpty ? "" : shownAddress() }

// ---- probe: does the profile still match the desktop? ----
if args.first == "probe" {
  refresh()
  // What each field says: profileCheck. A locator a flow acts on must not be in `several`
  // (locators read with findAll, such as a chat's messages, are there by design).
  let state = profileCheck()
  out(["ok": true, "onScreen": onScreen(), "current": current(), "found": state.found, "ways": state.ways, "differ": state.differ, "drift": state.drift, "several": state.several])
}
// ---- inspect: what a control goes by besides its name ----
// For each locator named (all of them without names): the controls it finds now, each with its
// role, name, DOM id and classes, declared shortcut, and the boxes it sits in (nearest first, the
// ones that have an id, a class or a name). Read on a desktop where the name finds the control, it
// shows what a way that does not depend on the language can be written from.
if args.first == "inspect" {
  refresh()
  func facts(_ e: AXUIElement) -> [String: Any] {
    var out: [String: Any] = ["role": role(e)]
    if let sub = attr(e, "AXSubrole") as? String, !sub.isEmpty { out["subrole"] = sub }
    if !name(e).isEmpty { out["name"] = String(name(e).prefix(80)) }
    if let id = attr(e, "AXDOMIdentifier") as? String, !id.isEmpty { out["id"] = id }
    if !classes(e).isEmpty { out["class"] = classes(e) }
    if let keys = attr(e, "AXKeyShortcutsValue") as? String, !keys.isEmpty { out["keys"] = keys }
    return out
  }
  var report: [String: Any] = [:]
  let asked = Array(args.dropFirst())
  for key in asked.isEmpty ? locators.keys.sorted() : asked {
    report[key] = findAll(key).prefix(3).map { hit -> [String: Any] in
      var own = facts(hit), boxes: [[String: Any]] = [], at: AXUIElement = hit
      for _ in 0..<12 {
        guard let up = attr(at, "AXParent"), CFGetTypeID(up) == AXUIElementGetTypeID() else { break }
        at = up as! AXUIElement
        let box = facts(at)
        if box.count > 1 { boxes.append(box) }
        if role(at) == "AXWebArea" { break }
      }
      own["in"] = boxes
      return own
    }
  }
  out(["ok": true, "current": current(), "controls": report])
}

struct StepError { let code: String, message: String }

// ---- what the answer says about its footing ----
// (Not for the commands that only look at the profile itself.)
annotate = { object in
  if !["warm", "probe", "inspect"].contains(args.first ?? "") {
    var other: [String: String] = [:]
    for (key, way) in via where way > 0 { if let ways = locators[key], ways.indices.contains(way) { other[key] = ways[way].kind } }
    if !other.isEmpty { object["via"] = other }
  }
  let failed = object["ok"] as? Bool == false
  // Why the command really stopped: the flow's own code names the step that then could not go on.
  func because(_ code: String, _ message: String) { if failed { if let step = object["code"] { object["step"] = step }; object["code"] = code; object["error"] = message } }
  if let (key, count) = refused.min(by: { $0.key < $1.key }) {
    object["ambiguous"] = refused
    because("ambiguous", "\(appName)的页面上有 \(count) 个控件都对得上「\(key)」，分不清该动哪一个，所以没有动手（桌面版可能改过界面，这个控件的认法要更新）")
  } else if let key = unconfirmed.first {
    object["unconfirmed"] = unconfirmed
    because("unconfirmed", "\(appName)里按位置找到的「\(key)」打开的不是预期的菜单，所以什么都没有选（桌面版可能改过界面，这个控件的认法要更新）")
  }
}
// Asked by a flow right after the one press that sends: a press that was held back sent nothing,
// and waiting for the page to react would only take longer to say so. (Whatever reason the flow
// then gives, the answer's is the one above.)
func heldBack() -> Bool { !refused.isEmpty }

// ---- modes: the desktop's own switch between its kinds of chat ----
// Claude: a radio group "Mode" (Claude / Code); Codex: a menu button "Switch mode, current mode: Codex".
// The profile says which ("spaces": { kind: "radio" | "menu", control: <locator>, currentPrefix?,
// names: { <space id>: <the desktop's word> }, home: <space id> }). Sessions, the new-chat page and
// their menus all belong to one mode, so a command is carried out in that mode.
let spaceSpec = profile["spaces"] as? [String: Any] ?? [:]
let spaceNames = spaceSpec["names"] as? [String: String] ?? [:]
let spaceControl = spaceSpec["control"] as? String ?? "", spaceMenu = (spaceSpec["kind"] as? String) == "menu"
// A radio's name is the mode's word, followed by what the mode is up to while a chat in it waits
// on the person ("Code, awaiting your input"): the word is what comes before the first comma.
func spaceWord(_ text: String) -> String {
  String(text[..<(text.firstIndex { $0 == "," || $0 == "，" } ?? text.endIndex)]).trimmingCharacters(in: .whitespaces)
}
// The mode on screen, as a space id; nil when the switch is not there, "" for a word not in the profile.
func shownSpace() -> String? {
  guard let control = find(spaceControl) else { return nil }
  var word = ""
  // The menu's button ends in the mode it shows: after the profile's "currentPrefix", or, named
  // another way (another language), after its colon.
  if spaceMenu { let prefix = spaceSpec["currentPrefix"] as? String ?? "", own = name(control); word = !prefix.isEmpty && own.hasPrefix(prefix) ? String(own.dropFirst(prefix.count)) : labelled(own)?.value ?? "" }
  else { word = within(control) { role($0) == "AXRadioButton" && checked($0) }.first.map { spaceWord(name($0)) } ?? "" }
  return spaceNames.first { $0.value == word }?.key ?? ""
}
func switchSpace(_ id: String) -> StepError? {
  guard let word = spaceNames[id] else { return StepError(code: "unknown_space", message: "\(appName)没有这个模式") }
  guard find(spaceControl) != nil else { return StepError(code: "no_space_switch", message: "没能在\(appName)上找到切换模式的地方") }
  if shownSpace() == id { return nil }
  if spaceMenu {
    guard open({ find(spaceControl) }) else { return StepError(code: "no_space_switch", message: "没能打开\(appName)切换模式的菜单") }
    guard let entry = item(word) else { close({ find(spaceControl) }); return StepError(code: "no_space_switch", message: "\(appName)切换模式的菜单里没有「\(word)」") }
    press(entry); anchor = nil
  } else {
    guard let control = find(spaceControl), let option = within(control, { role($0) == "AXRadioButton" && spaceWord(name($0)) == word }).first else { return StepError(code: "no_space_switch", message: "\(appName)的模式切换里没有「\(word)」") }
    press(option)
  }
  for _ in 0..<16 {
    wait(0.2)
    // The switch shows the mode at once; the page follows a moment later (until then the old
    // mode's sidebar is still there to be pressed). A mode whose pages are named their own way
    // has arrived once a page is named so.
    if shownSpace() == id { for _ in 0..<16 where !modeDrawn(id) { wait(0.2) }; wait(0.4); return nil }
  }
  return StepError(code: "space_not_set", message: "在\(appName)里切到「\(word)」模式，但没有切过去")
}
func modeDrawn(_ id: String) -> Bool {
  let own = (spaceSpec["titleSuffix"] as? [String: String])?[id] ?? (id == spaceSpec["home"] as? String ? setting("titleSuffix") : "")
  guard !own.isEmpty else { return true }
  return every({ role($0) == "AXWebArea" }).contains { (attr($0, "AXTitle") as? String ?? "").hasSuffix(own) }
}
if args.first == "space" { refresh(); let shown = shownSpace(); out(["ok": true, "found": shown != nil, "space": shown ?? ""]) }
// The person's mode comes back when the command ends, as their chat does; open-file is the
// exception: it is asked for so the person sees that chat. While the console has the desktop
// parked on its new-chat page the mode stays borrowed too (see out()): choosing a new chat's
// settings is several commands, and switching modes there and back for each one cost a second or
// two each way, more with the window off screen. The mode on screen is then the console's, so the
// person's is the one it was parked from (`--previous-space`).
if !spaceSpec.isEmpty, let command = args.first {
  let target = wanted["space"] ?? (spaceSpec["home"] as? String ?? "")
  // No switch on screen (an older desktop, a page without it): carry on as before modes existed.
  if command != "chat-status", !target.isEmpty, let before = shownSpace() {
    // new-leave never switches: the desktop in another mode is where the person took it since.
    if command == "new-leave", before != target { out(["ok": true, "left": false, "moved": true]) }
    let own = before != target ? before : parkedSpace
    if before != target, let error = switchSpace(target) { fail(error.code, error.message) }
    if !["open-file", "show-session"].contains(command), !own.isEmpty, own != target {
      personSpace = own
      beforeExit = { switchSpace(own).map { $0.message } }
    }
  }
  if !target.isEmpty, let suffix = (spaceSpec["titleSuffix"] as? [String: String])?[target] { modeTitleSuffix = suffix }
}

// ---- a chat mode's chats: read, started and answered in the desktop's own window ----
// For chats whose messages are not on disk (a cloud chat mode). Everything happens in the mode
// given by --space, and the chat that was on screen comes back afterwards.
//   read-chat <title> [id]       the chat's messages, as the page draws them
//   chat-status <id>             is that chat on the page, is it answering (moves nothing)
//   chat-new <project|-> <wait>  first message on stdin: a new chat (in that project, or in none)
//   chat-send <title> <wait>     message on stdin, into that chat (refused while it is answering)
//   chat-stop <title> <id>       press Stop after verifying the open chat's id
// chat-new and chat-send wait up to <wait> seconds for the reply and answer the chat as it is
// then: { messages, running (still answering), title, url (the page's address) }.
//
// The profile's "chatRead" names the page's parts:
//   container: locator of the messages' region ("Conversation", "Chat messages")
//   speakers:  { "<heading prefix>": "user" | "assistant" } — each message starts with a heading
//              named so ("You said:", "ChatGPT said:", "Claude responded: …")
//   article:   optional prefix of a message's own group, "Message <k> of <n>", so a list the page
//              only partly drew can be told apart (answered as `total`)
//   ignore:    texts the page adds that are not the chat ("ChatGPT can make mistakes…"), by start
// A desktop shown in another language names all of these otherwise, so the profile also says what
// they are apart from their words (locator specs, written out in place):
//   speakerHeading: what a message's heading is, whoever it names (its class)
//   userMessage:    what follows that heading when the message is the person's (the bubble's class);
//                   anything else after it is the assistant's
//   assistantIn:    or, the other way round: what the heading sits in when the message is the
//                   assistant's (its row's class); a heading anywhere else is the person's
//   message:        what a numbered message's own group is ("Message 2 of 6" in any language: the
//                   two numbers in its name, the smaller being its place)
//   skip:           the parts that are not the chat, by what they are (a notice's own class)
// A heading the words in `speakers` name is read by them; these read the ones they do not name.
// and its "chatSend" the controls for writing (locator keys, except where said):
//   composer, send, stop      the chat's message box, its send button, its stop button
//   stopSlot                  optional: where Stop takes Send's place, a locator for that place
//   newChat                   the sidebar's button for a new chat
//   inProject, noProject      optional: what the new-chat page shows while it is in a project
//                             ("Change project: …"), and its button that takes the project away
//   newShown                  optional: what only the new-chat page shows ("New session")
//   project                   names of the sidebar buttons that start a chat in a project, with
//                             "{project}" for its name ("New chat in {project}"); the first found
//   projectShown              a locator spec, with "{project}", for what shows the page is in it
// Text comes back as Markdown-ish lines: headings "### ", list items "- ", paragraphs split where
// the page starts a new block below the previous one. Buttons, toolbars and times are left out.
let chatSpec = profile["chatRead"] as? [String: Any] ?? [:], sendSpec = profile["chatSend"] as? [String: Any] ?? [:]
// (The container is one of the profile's locators, by its key, or written out in place.)
let chatBox = (chatSpec["container"] as? String).flatMap { locators[$0] } ?? locatorList("chatRead", chatSpec["container"])
func chatRegion() -> AXUIElement? { chatBox.lazy.compactMap { matches($0).first }.first }
func sendKey(_ key: String) -> String { sendSpec[key] as? String ?? "" }
func frame(_ e: AXUIElement) -> CGRect {
  var point = CGPoint.zero, size = CGSize.zero
  if let p = attr(e, "AXPosition") { AXValueGetValue(p as! AXValue, .cgPoint, &point) }
  if let v = attr(e, "AXSize") { AXValueGetValue(v as! AXValue, .cgSize, &size) }
  return CGRect(origin: point, size: size)
}
// The address of the page the chat is drawn in ("https://claude.ai/chat/<id>"), when it has one.
func pageURL() -> String {
  for area in every({ role($0) == "AXWebArea" }) { if let url = attr(area, "AXURL").map({ "\($0)" }), url.hasPrefix("http") { return url } }
  return ""
}
func chatID() -> UUID? {
  guard let parts = URLComponents(string: pageURL())?.path.split(separator: "/"),
        parts.count >= 2, parts[parts.count - 2] == "chat" else { return nil }
  return UUID(uuidString: String(parts[parts.count - 1]))
}
// The messages on the page now: (messages, total, read) — total and read only with "article".
func chatMessages() -> ([[String: Any]], Int, Int) {
  let speakers = chatSpec["speakers"] as? [String: String] ?? [:], article = chatSpec["article"] as? String ?? "", ignore = chatSpec["ignore"] as? [String] ?? []
  guard let area = chatRegion() else { return ([], 0, 0) }
  let anyHeading = locatorList("speakerHeading", chatSpec["speakerHeading"]), userMessage = locatorList("userMessage", chatSpec["userMessage"]), notChat = locatorList("skip", chatSpec["skip"])
  let assistantIn = locatorList("assistantIn", chatSpec["assistantIn"]), anyMessage = locatorList("message", chatSpec["message"])
  // The element the page lists right after this one, under the same parent.
  func parent(_ e: AXUIElement) -> AXUIElement? {
    guard let up = attr(e, "AXParent"), CFGetTypeID(up) == AXUIElementGetTypeID() else { return nil }
    return (up as! AXUIElement)
  }
  func next(_ e: AXUIElement) -> AXUIElement? {
    guard let up = parent(e) else { return nil }
    let kids = attr(up, "AXChildren") as? [AXUIElement] ?? []
    guard let at = kids.firstIndex(where: { CFEqual($0, e) }), at + 1 < kids.count else { return nil }
    return kids[at + 1]
  }
  // Messages in page order; with "article" numbering, keyed by their number so passes made while
  // scrolling (a long chat is drawn only near what is on screen) merge into one list.
  var messages: [[String: Any]] = [], numbered: [Int: [String: Any]] = [:], text = "", speaker = "", lastBottom: CGFloat = -1, total = 0, number = 0
  var firstArticle: AXUIElement?
  func flush() {
    let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if !speaker.isEmpty, !body.isEmpty { if number > 0 { numbered[number] = ["role": speaker, "text": body] } else { messages.append(["role": speaker, "text": body]) } }
    text = ""
  }
  // The block a piece of text is in: a text's parent; for an inline piece (a link, bold text), its
  // parent past the wrappers drawn exactly around it alone (a source chip's).
  var lastBlock: AXUIElement?
  func blockOf(_ e: AXUIElement, inline: Bool) -> AXUIElement? {
    var up = parent(e)
    guard inline else { return up }
    let box = frame(e)
    for _ in 0..<3 {
      guard let wrapper = up, (attr(wrapper, "AXChildren") as? [AXUIElement])?.count == 1 else { break }
      let around = frame(wrapper)
      guard abs(around.minX - box.minX) <= 1, abs(around.minY - box.minY) <= 1, abs(around.width - box.width) <= 1, abs(around.height - box.height) <= 1 else { break }
      up = parent(wrapper)
    }
    return up
  }
  // A piece below what was read last starts a new paragraph, unless it is an inline piece of the
  // block that text is in: a chip wrapped onto the next line is below the sentence it follows.
  func add(_ piece: String, _ e: AXUIElement, inline: Bool = false) {
    let box = frame(e), block = blockOf(e, inline: inline)
    if lastBottom >= 0, box.height > 0, box.minY > lastBottom + 1, !text.hasSuffix("\n"), !(inline && lastBlock != nil && block != nil && CFEqual(lastBlock!, block!)) { text += "\n\n" }
    text += piece
    if box.height > 0 { lastBottom = max(lastBottom, box.maxY) }
    lastBlock = block
  }
  let skip: Set<String> = ["AXButton", "AXToolbar", "AXCheckBox", "AXPopUpButton", "AXMenuButton", "AXTextArea", "AXTextField"]
  // A link as the page has it, in Markdown: [its text](where it points). A source the reply cites
  // (the profile's "citation": Claude draws it as a small chip after the sentence) is marked with
  // the title "citation", which the page draws as that chip.
  let citation = locatorList("citation", chatSpec["citation"])
  func link(_ e: AXUIElement) -> String {
    var label = ""
    _ = walk(e) { if role($0) == "AXStaticText" { label += value($0) }; return false }
    label = label.trimmingCharacters(in: .whitespacesAndNewlines)
    if label.isEmpty { label = name(e) }
    let url = attr(e, "AXURL").map { "\($0)" } ?? ""
    if url.isEmpty || label.isEmpty { return label }
    let shown = label.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "[", with: "\\[").replacingOccurrences(of: "]", with: "\\]")
    let target = url.contains(where: { " ()<>".contains($0) }) ? "<" + url.replacingOccurrences(of: "<", with: "%3C").replacingOccurrences(of: ">", with: "%3E").replacingOccurrences(of: " ", with: "%20") + ">" : url
    return "[\(shown)](\(target)\(citation.contains { fits(e, $0) } ? " \"citation\"" : ""))"
  }
  // Bold and italic text (Chromium's AXStrongStyleGroup / AXEmphasisStyleGroup), with what is
  // inside it (links too), as one Markdown piece; the spaces at its ends stay outside the marks.
  func styled(_ e: AXUIElement) -> String {
    let r = role(e), sub = attr(e, "AXSubrole") as? String ?? ""
    if r == "AXStaticText" { return value(e) }
    if r == "AXLink" { return link(e) }
    if skip.contains(r) { return "" }
    let inner = (attr(e, "AXChildren") as? [AXUIElement] ?? []).map(styled).joined()
    let mark = sub == "AXStrongStyleGroup" ? "**" : sub == "AXEmphasisStyleGroup" ? "*" : ""
    let body = inner.trimmingCharacters(in: .whitespaces)
    if mark.isEmpty || body.isEmpty || body.contains("\n") { return inner }
    return String(inner.prefix(while: { $0 == " " })) + mark + body + mark + String(inner.reversed().prefix(while: { $0 == " " }))
  }
  // How far each list the reading is inside indents its items' text (its marker's width), outermost first.
  var lists: [Int] = []
  func visit(_ e: AXUIElement) {
    let r = role(e), n = name(e), sub = attr(e, "AXSubrole") as? String ?? ""
    var numbers: (k: Int, of: Int)?
    if !article.isEmpty, r == "AXGroup", n.hasPrefix(article) {
      let parts = n.dropFirst(article.count).components(separatedBy: " of ")
      if parts.count == 2, let k = Int(parts[0]), let of = Int(parts[1]) { numbers = (k, of) }
    }
    if numbers == nil, anyMessage.contains(where: { fits(e, $0) }) {
      let found = n.split(whereSeparator: { !($0.isASCII && $0.isNumber) }).compactMap { Int($0) }
      if found.count == 2, let low = found.min(), let high = found.max(), low >= 1 { numbers = (low, high) }
    }
    if let numbers { flush(); speaker = ""; number = numbers.k; total = max(total, numbers.of); if firstArticle == nil { firstArticle = e } }
    if skip.contains(r) || sub == "AXTimeGroup" { return }
    if !ignore.isEmpty, [n, value(e)].contains(where: { text in !text.isEmpty && ignore.contains(where: { text.hasPrefix($0) }) }) { return }
    if notChat.contains(where: { fits(e, $0) }) { return }
    if r == "AXHeading" {
      // The heading may hold the message itself (Claude puts the person's text under it).
      if let who = speakers.first(where: { n.hasPrefix($0.key) }) { flush(); speaker = who.value; lastBottom = -1; for child in attr(e, "AXChildren") as? [AXUIElement] ?? [] { visit(child) }; return }
      // A message's heading in words the profile does not have: whose message it is, by what follows it.
      // (The heading's first text reads its own name, "You said: …": the message is what comes after it.)
      if anyHeading.contains(where: { fits(e, $0) }) {
        flush(); lastBottom = -1
        if !assistantIn.isEmpty { speaker = parent(e).map { up in assistantIn.contains { fits(up, $0) } } == true ? "assistant" : "user" }
        else { speaker = next(e).map { after in userMessage.contains { fits(after, $0) } } == true ? "user" : "assistant" }
        for (place, child) in (attr(e, "AXChildren") as? [AXUIElement] ?? []).enumerated() {
          if place == 0, role(child) == "AXStaticText", !value(child).isEmpty, n.hasPrefix(value(child)) { continue }
          visit(child)
        }
        return
      }
      if !speaker.isEmpty, !n.isEmpty { text += (text.isEmpty ? "" : "\n\n") + "### " + n + "\n\n"; lastBottom = frame(e).maxY; return }
    }
    // A table is listed by rows and again by columns: read its rows, as a Markdown table.
    if r == "AXTable" || r == "AXGrid" {
      if speaker.isEmpty { return }
      let kids = attr(e, "AXChildren") as? [AXUIElement] ?? []
      let rows = (attr(e, "AXRows") as? [AXUIElement]) ?? kids.filter { role($0) == "AXRow" }
      func cellText(_ cell: AXUIElement) -> String { var parts: [String] = []; _ = walk(cell) { if role($0) == "AXStaticText" { parts.append(value($0)) }; return false }; return parts.joined().replacingOccurrences(of: "|", with: "\\|").replacingOccurrences(of: "\n", with: " ") }
      let lines = rows.map { row in "| " + (attr(row, "AXChildren") as? [AXUIElement] ?? []).map(cellText).joined(separator: " | ") + " |" }
      if let head = lines.first {
        let columns = max(1, head.components(separatedBy: " | ").count)
        text += (text.isEmpty || text.hasSuffix("\n\n") ? "" : "\n\n") + ([head, "|" + String(repeating: " --- |", count: columns)] + lines.dropFirst()).joined(separator: "\n") + "\n\n"
        lastBottom = frame(e).maxY
      }
      return
    }
    if r == "AXColumn" { return }
    // Code (Chromium marks <code> as AXCodeStyleGroup): read its text as one piece, as written.
    // A block (its class names the language, or it spans lines) comes back as a fenced block, and
    // the language label the page draws above it is left out; short code inside a line stays inline.
    if sub == "AXCodeStyleGroup", !speaker.isEmpty {
      var raw = ""
      _ = walk(e) { if role($0) == "AXStaticText" { raw += value($0) }; return false }
      let lang = ((attr(e, "AXDOMClassList") as? [String]) ?? []).first { $0.hasPrefix("language-") }.map { String($0.dropFirst("language-".count)) } ?? ""
      if !lang.isEmpty || raw.contains("\n") {
        if !lang.isEmpty, text.lowercased().hasSuffix(lang.lowercased()) {
          let cut = String(text.dropLast(lang.count))
          if cut.isEmpty || cut.hasSuffix("\n") { text = cut }
        }
        while text.hasSuffix("\n") || text.hasSuffix(" ") { text.removeLast() }
        let fence = raw.contains("```") ? "~~~~" : "```"
        var body = raw; while body.hasSuffix("\n") { body.removeLast() }
        text += (text.isEmpty ? "" : "\n\n") + fence + lang + "\n" + body + "\n" + fence + "\n\n"
        lastBottom = frame(e).maxY
      } else if !raw.isEmpty {
        let tick = raw.contains("`") ? "``" : "`"
        add(tick + (raw.contains("`") ? " \(raw) " : raw) + tick, e)
      }
      return
    }
    // A list's marker as the page draws it: a number ("1. ") stays that number, anything else is a
    // bullet; an item of a list inside another is indented under the outer item's text.
    if r == "AXList" { lists.append(2); for child in attr(e, "AXChildren") as? [AXUIElement] ?? [] { visit(child) }; lists.removeLast(); return }
    if r == "AXListMarker" {
      let drawn = value(e).trimmingCharacters(in: .whitespaces)
      let marker = drawn.range(of: #"^\d{1,9}[.)]$"#, options: .regularExpression) != nil ? drawn + " " : "- "
      if !lists.isEmpty { lists[lists.count - 1] = marker.count }
      text += (text.hasSuffix("\n") || text.isEmpty ? "" : "\n") + String(repeating: " ", count: lists.dropLast().reduce(0, +)) + marker
      lastBottom = -1; return
    }
    // A link, and bold or italic text: one piece of the line it is in.
    if !speaker.isEmpty, r == "AXLink" || sub == "AXStrongStyleGroup" || sub == "AXEmphasisStyleGroup" {
      let piece = styled(e)
      if !piece.isEmpty { add(piece, e, inline: true) }
      return
    }
    if r == "AXImage", !speaker.isEmpty, !n.isEmpty { text += (text.isEmpty || text.hasSuffix("\n") ? "" : "\n") + "[\(n)]\n"; lastBottom = frame(e).maxY; return }
    if r == "AXStaticText", !speaker.isEmpty { let v = value(e); if !v.isEmpty, !speakers.keys.contains(where: { v.hasPrefix($0) }) { add(v, e) }; return }
    for child in attr(e, "AXChildren") as? [AXUIElement] ?? [] { visit(child) }
  }
  visit(area); flush()
  // A long chat opens at its end with only the last messages drawn. The page moves between its
  // messages with the arrow keys (Claude: "Use the up and down arrow keys…"), drawing the ones it
  // reaches: focus the first drawn message and go up, until message 1 is read or nothing new comes.
  // Keys go out only while that message really has the focus (anywhere else they would move a caret).
  var still = 0
  while total > 0, numbered[1] == nil, still < 3, numbered.count < total {
    let before = numbered.count
    if let top = firstArticle {
      focus(top); wait(0.2)
      if focused(top) { for _ in 0..<4 { key(.up) } } else { act(top, "AXScrollToVisible") }
    }
    wait(0.8)
    firstArticle = nil; speaker = ""; number = 0
    if let again = chatRegion() { visit(again); flush() }
    still = numbered.count > before ? 0 : still + 1
  }
  if !numbered.isEmpty { messages = numbered.keys.sorted().compactMap { numbered[$0] } }
  return (messages, total, numbered.count)
}
// The page's stop button: by the profile's "stop"; or, where the page puts Stop in Send's own
// place and names it in words the profile does not have (another language), the button in that
// place ("stopSlot", a locator key) whenever it is not the send button. That second way is only
// for a chat that is showing its messages on a page that names neither button in the profile's
// words: a page that does (Send is there by its name) has no reply to stop, and a new chat's
// page keeps another button in that place (Claude: Dictate).
func spoken(_ key: String) -> Bool { (locators[key] ?? []).contains { $0.worded && !matches($0).isEmpty } }
func stopButtons() -> [AXUIElement] {
  guard !sendKey("stop").isEmpty else { return [] }
  let named = findAll(sendKey("stop"))
  if !named.isEmpty { return named }
  guard !sendKey("stopSlot").isEmpty, !spoken(sendKey("send")), !spoken(sendKey("stop")), chatRegion() != nil, let button = find(sendKey("stopSlot")) else { return [] }
  return findAll(sendKey("send")).contains { CFEqual($0, button) } ? [] : [button]
}
func answering() -> Bool { !stopButtons().isEmpty }
// This check leaves the person's desktop on the page they are using. It says whether that chat is
// the one on the page (`shown`: by the id in the page's address, so only a desktop that has one
// can say yes), whether it is answering there, and whether the desktop is the app the person is
// in (`front`): a chat that is not shown can only be read by moving the desktop to it, which is
// not done under the hands of someone using it.
if args.first == "chat-status" {
  refresh()
  guard args.count > 1, !args[1].isEmpty else { fail("usage", "缺少有效的会话 ID") }
  let shown = UUID(uuidString: args[1]).map { chatID() == $0 } == true && chatRegion() != nil
  out(["ok": true, "shown": shown, "running": shown && answering(), "front": app.isActive])
}
func chatAnswer(_ extra: [String: Any] = [:]) -> [String: Any] {
  let (messages, total, read) = chatMessages()
  var answer: [String: Any] = ["ok": true, "messages": messages, "running": answering(), "title": current(), "url": pageURL()]
  if total > 0 { answer["total"] = total; answer["read"] = read }
  return answer.merging(extra) { $1 }
}
// While a command stays on a chat waiting for its reply, it says what the page shows so far: one
// JSON line each time that changes, marked `"progress": true` (the answer is still the last line).
// The first says the message went out (`sent`); the ones after carry the chat as chatAnswer does,
// so whoever started the command can show the reply as the desktop writes it.
var lastProgress = ""
func progress(_ object: [String: Any]) {
  var line = object; line["progress"] = true; line["ok"] = true
  guard let data = try? JSONSerialization.data(withJSONObject: line, options: [.sortedKeys]), let text = String(data: data, encoding: .utf8), text != lastProgress else { return }
  lastProgress = text
  print(text); fflush(stdout)
}
// After a message went out: the reply is done once the page stops showing its stop button and
// its last message is the assistant's; waited for up to `seconds`.
func awaitReply(_ seconds: Double) {
  let began = Date(), until = began.addingTimeInterval(seconds)
  while Date() < until {
    wait(0.5)
    guard chatRegion() != nil else { continue }
    let (messages, total, read) = chatMessages(), running = answering()
    var shown: [String: Any] = ["messages": messages, "running": true, "title": current()]
    if total > 0 { shown["total"] = total; shown["read"] = read }
    progress(shown)
    // (The stop button comes up a moment after the send.)
    if Date().timeIntervalSince(began) > 1.5, !running, (messages.last?["role"] as? String) == "assistant" { wait(0.6); if !answering() { return } }
  }
}
// Fills the composer and presses send; false (nothing sent) when the page did not take the text.
func sendText(_ text: String) -> StepError? {
  guard !sendKey("composer").isEmpty, !sendKey("send").isEmpty else { return StepError(code: "usage", message: "\(appName)的配置里没有 chatSend") }
  guard fill(sendKey("composer"), text, ready: sendKey("send")) else {
    clear(sendKey("composer"))
    return onScreen() ? StepError(code: "fill_failed", message: "没能把消息填进\(appName)的输入框") : StepError(code: "hidden", message: "\(appName)的窗口不在屏幕上，这次没能把消息交给它：把窗口放到看得见的地方再发")
  }
  guard let send = sendButton(sendKey("send")) else { clear(sendKey("composer")); return StepError(code: "no_send", message: "\(appName)没有出现发送按钮") }
  press(send)
  if heldBack() { clear(sendKey("composer")); return StepError(code: "no_send", message: "\(appName)没有出现发送按钮") }
  // Taken once the box is empty again or the page answers. (An empty box may read as its
  // placeholder: measured on Codex, a message that had gone out was reported as still in the box.)
  for _ in 0..<40 { wait(); if find(sendKey("composer")).map({ !holdsText($0) }) ?? false || answering() { return nil } }
  return StepError(code: "not_sent", message: "按了\(appName)的发送，但消息还留在输入框里")
}
// The new-chat page, in a project or in none: opened from the sidebar and checked by what it shows.
func openChatPage(_ project: String) -> StepError? {
  func shown(_ spec: [String: Any]?) -> Bool { guard let spec else { return false }; var filled: [String: Any] = [:]; for (k, v) in spec { filled[k] = (v as? String)?.replacingOccurrences(of: "{project}", with: project) ?? v }; let l = Locator("projectShown", filled); return first { fits($0, l) } != nil }
  func ready() -> Bool { find(sendKey("composer")) != nil && chatRegion() == nil }
  let mode = shownSpace()
  // Pressing in a page that has gone over to another mode would start the chat there.
  func moved() -> StepError? { mode != nil && shownSpace() != mode ? StepError(code: "space_moved", message: "\(appName)离开了这个模式，没有新建聊天") : nil }
  if project.isEmpty {
    guard let new = find(sendKey("newChat")) else { return StepError(code: "no_new_page", message: "\(appName)的侧栏里没有找到新建聊天的按钮") }
    press(new)
    for attempt in 0..<24 {
      wait()
      if let error = moved() { return error }
      // A press that came while the page was still settling (just switched modes) is lost.
      if attempt == 10, !ready(), let again = find(sendKey("newChat")) { press(again) }
      guard ready() else { continue }
      // A page that keeps the last project (Codex: "Change project: network"): take it away.
      if !sendKey("inProject").isEmpty, find(sendKey("inProject")) != nil {
        if let none = find(sendKey("noProject")) { press(none); wait(0.4) }
        continue
      }
      if sendKey("newShown").isEmpty || find(sendKey("newShown")) != nil { return nil }
    }
    return StepError(code: "no_new_page", message: "没能在\(appName)里打开新聊天的页面")
  }
  let names = (sendSpec["project"] as? [String] ?? []).map { $0.replacingOccurrences(of: "{project}", with: project) }
  func button() -> AXUIElement? { names.lazy.compactMap({ wanted in first { role($0) == "AXButton" && name($0) == wanted } }).first }
  guard let start = button() else { return StepError(code: "no_project", message: "\(appName)的侧栏里没有「\(project)」这个项目，没能在里面新建聊天") }
  press(start)
  for attempt in 0..<24 {
    wait()
    if let error = moved() { return error }
    if ready(), shown(sendSpec["projectShown"] as? [String: Any]) { return nil }
    if attempt == 10, let again = button() { press(again) }
  }
  return StepError(code: "no_new_page", message: "没能在\(appName)里打开「\(project)」的新聊天页面")
}
if ["read-chat", "chat-new", "chat-send", "chat-stop"].contains(args.first ?? "") {
  guard !chatBox.isEmpty else { fail("usage", "\(appName)的配置里没有 chatRead") }
  let previous = current()
  var target = args.count > 1 ? args[1] : ""
  func back() { if !previous.isEmpty && previous != target { _ = show(previous) } }
  let seconds = args.count > 2 ? Double(args[2]) ?? 60 : 60
  switch args.first {
  case "chat-stop":
    guard args.count > 2, !target.isEmpty, let id = UUID(uuidString: args[2]) else { fail("usage", "缺少有效的会话 ID 或标题") }
    func onTarget() -> Bool { chatID() == id }
    guard onTarget() || show(target) else { back(); fail("not_found", "没能在\(appName)的侧栏里找到这个聊天") }
    for _ in 0..<16 where !onTarget() || chatRegion() == nil { wait() }
    guard onTarget(), chatRegion() != nil else { back(); fail("wrong_chat", "没能在\(appName)里确认打开的是要停止的聊天") }
    let buttons = stopButtons()
    guard !buttons.isEmpty else { back(); fail("not_running", "这个会话在\(appName)里已经没有在回复") }
    guard buttons.count == 1, let stop = buttons.first else { back(); fail("ambiguous_stop", "没能在\(appName)里确认哪个按钮会停止这条回复") }
    guard act(stop, kAXPressAction as String) == .success else { back(); fail("not_stopped", "没能按下\(appName)的停止按钮") }
    for _ in 0..<12 {
      wait()
      guard onTarget(), chatRegion() != nil else { back(); fail("wrong_chat", "没能在\(appName)里确认这条回复已停止") }
      if !answering() { let answer = chatAnswer(["interrupted": true]); back(); out(answer) }
    }
    back(); fail("not_stopped", "按了停止，但\(appName)还在回复")
  case "chat-new":
    let text = stdinText(), project = target == "-" ? "" : target
    guard !text.isEmpty else { fail("usage", "消息是空的") }
    target = ""
    if let error = openChatPage(project) { back(); fail(error.code, error.message) }
    if let error = sendText(text) { back(); fail(error.code, error.message) }
    progress(["sent": true])
    // The page becomes the chat once the desktop has made it.
    for _ in 0..<40 { wait(); if chatRegion() != nil { break } }
    awaitReply(seconds)
    // Not waiting for the reply: the desktop names a new chat a moment after its first message, and
    // that name is how the chat is found again (its sidebar row), so it is waited for here.
    if seconds <= 0 { for _ in 0..<40 where current().isEmpty { wait() } }
    target = current()
    let answer = seconds > 0 ? chatAnswer(["sent": true]) : ["ok": true, "sent": true, "running": answering(), "title": target, "url": pageURL()]
    back(); out(answer)
  case "chat-send":
    let text = stdinText()
    guard !target.isEmpty, !text.isEmpty else { fail("usage", "缺少会话标题或消息") }
    guard show(target) else { back(); fail("not_found", "没能在\(appName)的侧栏里找到这个聊天") }
    for _ in 0..<16 where chatRegion() == nil { wait() }
    if answering() { back(); fail("busy", "这个聊天正在\(appName)里回复，等它回复完再发") }
    if let error = sendText(text) { back(); fail(error.code, error.message) }
    progress(["sent": true])
    awaitReply(seconds)
    let answer = seconds > 0 ? chatAnswer(["sent": true]) : ["ok": true, "sent": true, "running": answering(), "title": target, "url": pageURL()]
    back(); out(answer)
  default:
    guard !target.isEmpty else { fail("usage", "缺少会话标题") }
    // Already the chat on the page (by its id, when one is given): nothing to open, whatever it is
    // named by now.
    let onIt = args.count > 2 && UUID(uuidString: args[2]).map { chatID() == $0 } == true
    guard onIt || show(target) else { back(); fail("not_found", "没能在\(appName)的侧栏里找到这个聊天") }
    for _ in 0..<16 where chatRegion() == nil { wait() }
    guard chatRegion() != nil else { back(); fail("no_messages", "\(appName)里这个聊天没有显示出消息") }
    wait(0.6) // the rest of the chat is drawn a moment later
    let answer = chatAnswer(); back(); out(answer)
  }
}

// ---- a question card in the chat: the agent's question, its options, Submit and Skip ----
// The desktop draws the question as a group named by the question itself; each option is a toggle
// named "<label> <description>". `option` nil presses Skip. The profile names the two buttons
// ("questionSubmit", "questionSkip"). The card leaving the page is the sign the answer was taken.
func questionCards() -> [AXUIElement] {
  let submit = setting("questionSubmit")
  let groups = every { role($0) == "AXGroup" && (attr($0, "AXSubrole") as? String) == "AXApplicationGroup" && !within($0, { role($0) == "AXButton" && name($0) == submit }).isEmpty }
  // A group around a card also holds its Submit: only the innermost ones are cards.
  return groups.filter { group in !groups.contains { other in !CFEqual(other, group) && !within(group, { CFEqual($0, other) }).isEmpty } }
}
func answerCard(question: String, option: String?) -> StepError? {
  // The card is drawn a moment after the session is shown.
  var cards = questionCards()
  for _ in 0..<32 where cards.isEmpty { wait(); cards = questionCards() }
  // By its question; a single card on the page is the one, however the desktop spaced its words.
  guard let card = cards.first(where: { name($0) == question }) ?? (cards.count == 1 ? cards.first : nil) else { return StepError(code: "no_question", message: "\(appName)里没有在等回答的这个问题") }
  if let option {
    func choice() -> AXUIElement? { within(card, { role($0) == "AXCheckBox" && named($0, option) }).first }
    guard let wanted = choice() else { return StepError(code: "no_option", message: "\(appName)的这个问题里没有「\(option)」这个选项") }
    // Pressing an option only moves the focus to it; Space is what picks it. Another option may
    // be picked already (the first one is, by default), so nothing is submitted until this one is.
    if !checked(wanted) { press(wanted); wait(); if let now = choice(), !checked(now) { key(.space); wait(0.3) } }
    guard let now = choice(), checked(now) else { return StepError(code: "not_picked", message: "没能在\(appName)的问题卡片上选中「\(option)」，没有提交") }
  }
  guard let done = within(card, { role($0) == "AXButton" && name($0) == setting(option == nil ? "questionSkip" : "questionSubmit") }).first else { return StepError(code: "no_submit", message: "\(appName)的问题卡片上没有找到提交按钮") }
  press(done)
  for _ in 0..<16 { wait(); if questionCards().count < cards.count { return nil } }
  return StepError(code: "not_taken", message: "\(appName)没有收下这个回答")
}

// ---- open-file: a file link in the chat, pressed in the desktop itself ----
//   open-file <title> <localId|-> <path> <absolute> [<label>]
// The console asked to see this file "in the desktop": the conversation is brought on screen, the
// chat's own link to the file is pressed (the desktop opens it the way a click there would), and
// the desktop comes to the front — the one command that does, since the person asked to go there.
// A link matches by the URL it points at, then by its text, then by the file's name; the newest
// one in the chat wins. Without a match the conversation is still shown, and `pressed` is false.
// A page that names the file elsewhere too (Antigravity: the tabs of the files it has open, after
// the chat) says what the chat's own links are with the profile's "fileLink" locator: only those count.
func fileLinks(path: String, absolute: String, text: String) -> [(AXUIElement, Int)] {
  let bare = path.replacingOccurrences(of: #":\d+(:\d+)?$"#, with: "", options: .regularExpression)
  let base = URL(fileURLWithPath: bare).lastPathComponent
  let shaped = locators["fileLink"] != nil
  var hits: [(AXUIElement, Int)] = []
  _ = walk(root()) { e in
    let kind = role(e)
    guard kind == "AXLink" || kind == "AXButton" else { return false }
    if shaped, !fits(e, "fileLink") { return false }
    let url = (attr(e, "AXURL").map { "\($0)" } ?? "").removingPercentEncoding ?? ""
    let own = label(e).trimmingCharacters(in: .whitespaces)
    var score = 0
    if !url.isEmpty, (!absolute.isEmpty && url.hasSuffix(absolute)) || url.hasSuffix("/" + bare) || url == bare { score = 3 }
    else if !text.isEmpty, own == text { score = 2 }
    else if !base.isEmpty, own == base || own == path || own == bare { score = 1 }
    if score > 0 { hits.append((e, score)) }
    return false
  }
  return hits
}
if args.first == "open-file" {
  guard args.count > 4 else { fail("usage", "缺少会话标题或文件") }
  let localId = args[2] == "-" ? "" : args[2]
  guard show(args[1], localId.isEmpty ? [:] : ["localId": localId]) else { fail("not_found", "没能在\(appName)里打开这个会话") }
  // The chat is drawn a moment after the conversation is shown.
  var hits = fileLinks(path: args[3], absolute: args[4], text: args.count > 5 ? args[5] : "")
  for _ in 0..<12 where hits.isEmpty { wait(); hits = fileLinks(path: args[3], absolute: args[4], text: args.count > 5 ? args[5] : "") }
  let best = hits.map { $0.1 }.max() ?? 0
  let link = hits.last(where: { $0.1 == best })?.0
  if let link { press(link); wait(0.3) }
  app.activate(options: [.activateAllWindows])
  out(["ok": true, "pressed": link != nil])
}
// The person asked to be taken to this conversation: it is shown (in its mode, which stays) and
// the desktop comes to the front.
if args.first == "show-session" {
  guard args.count > 1, !args[1].isEmpty else { fail("usage", "缺少会话标题") }
  let localId = args.count > 2 && args[2] != "-" ? args[2] : ""
  guard show(args[1], localId.isEmpty ? [:] : ["localId": localId]) else { fail("not_found", "没能在\(appName)里打开这个会话") }
  app.activate(options: [.activateAllWindows])
  out(["ok": true])
}

// ---- a new chat's page: what it asks for before the first message ----
// Read from the page as it shows them, after the heading the profile names ("newPageHeading"):
// menus named "<label>: <value>" ("Environment: This computer", "Folder: ~/work") and, after the
// "newPageTogglesAfter" locator (the composer), checkboxes ("Worktree"). Menus the console has
// pickers of its own for ("newPageSkip": Model, Permissions…) and checkboxes whose names start
// with one of "newPageSkipToggles" are not choices about the session.
// Those are the desktop's words. A profile can say the same by where things are, which holds in
// any language: "newPageStart" (a locator: the page's controls come after it, in place of the
// heading's words), "newPageMenusBefore" (a locator: the page's own menus end where it begins,
// the composer's follow) and "newPageSkipTogglesInside" (a locator: checkboxes in that box are
// the composer's). Where the profile names one and the page shows it, it decides; the words
// decide the rest. A menu's options are the
// rows of the box named like its button, under its section headings; rows that open something
// else instead of picking carry no checked state and are left out.
//
// The console asks for these one after another while the person chooses (read the page, read a
// menu, pick, read the next menu): with `--stay` the desktop is left on the page between them
// instead of being taken back to the person's conversation and brought here again each time. The
// answer then names that conversation (`previous`), and the server sends the desktop back to it
// (new-leave, or `--previous` on the next command of another kind) once the choosing is over.
struct PageControl { let element: AXUIElement; let kind: String; let label: String; let value: String; let title: String }
struct PageChoice { let element: AXUIElement; let label: String; let section: String; let selected: Bool }
// Checked while a pick settles: a question the desktop puts up then (a trust prompt) ends it.
var newPageWatch: () -> StepError? = { nil }
// Whether somebody is writing on the page (its message box holds text): set by the flow.
var newPageInUse: () -> Bool = { false }
// What the page's own composer menus show (the "newPageSkip" ones: model, permissions), as the
// flow reads them: { "model": "Fable 5.2 Medium", "mode": "Auto" }. Answered as `shown` with the
// controls, so the console's menus start on what the first message will really use.
var newPageShown: () -> [String: Any] = { [:] }
func pageControls() -> [PageControl] {
  let heading = setting("newPageHeading"), skip = settings("newPageSkip"), skipToggles = settings("newPageSkipToggles")
  let togglesAfter = find(setting("newPageTogglesAfter"))
  let startAt = find(setting("newPageStart")), menusEnd = find(setting("newPageMenusBefore"))
  let composerToggles = find(setting("newPageSkipTogglesInside")).map { within($0) { role($0) == "AXCheckBox" } } ?? []
  var menusOver = false
  var out: [PageControl] = [], started = false, afterPrompt = locators[setting("newPageTogglesAfter")] == nil, page: AXUIElement?
  _ = walkPages(root()) { e, area in
    let r = role(e)
    if !started, startAt.map({ CFEqual(e, $0) }) ?? (r == "AXHeading" && label(e).hasPrefix(heading)) { started = true; page = area }
    // Only the heading's own page: a web page the desktop shows beside it (Claude's browser
    // panel, open on this very console) is another page, with checkboxes of its own.
    guard started, sameElement(area, page) else { return false }
    if let togglesAfter, CFEqual(e, togglesAfter) { afterPrompt = true }
    if let menusEnd, CFEqual(e, menusEnd) { menusOver = true }
    if r == "AXPopUpButton", let (key, shown) = labelled(name(e)) {
      if !menusOver, !skip.contains(key) { out.append(PageControl(element: e, kind: "menu", label: key, value: shown, title: name(e))) }
    } else if r == "AXCheckBox" && afterPrompt && !skipToggles.contains(where: { name(e).hasPrefix($0) }) && !composerToggles.contains(where: { CFEqual($0, e) }) {
      out.append(PageControl(element: e, kind: "toggle", label: name(e), value: checked(e) ? "on" : "off", title: name(e)))
    }
    return false
  }
  return out
}
// Walks like `walk`, telling each element the web page it is in (its nearest AXWebArea, itself
// for a page): the desktop's own page and pages it embeds (a browser panel) are separate areas.
func walkPages(_ e: AXUIElement, _ area: AXUIElement? = nil, _ depth: Int = 0, _ visit: (AXUIElement, AXUIElement?) -> Bool) -> Bool {
  if depth > 60 { return false }
  let here = role(e) == "AXWebArea" ? e : area
  if visit(e, here) { return true }
  for c in (attr(e, "AXChildren") as? [AXUIElement] ?? []) { if walkPages(c, here, depth + 1, visit) { return true } }
  return false
}
func sameElement(_ a: AXUIElement?, _ b: AXUIElement?) -> Bool { a == nil ? b == nil : b != nil && CFEqual(a!, b!) }
func pageControl(_ label: String) -> PageControl? { pageControls().first { $0.label == label } }
func pageChoices(_ control: PageControl) -> [PageChoice] {
  let title = control.title
  guard let box = first({ role($0) == "AXGroup" && name($0) == title }) else { return [] }
  var out: [PageChoice] = [], header = ""
  func hasItems(_ e: AXUIElement) -> Bool { var hit = false; _ = walk(e) { if role($0) == "AXMenuItem" { hit = true; return true }; return false }; return hit }
  func collect(_ e: AXUIElement, _ section: String) {
    for child in (attr(e, "AXChildren") as? [AXUIElement] ?? []) {
      let r = role(child)
      if r == "AXMenuItem" {
        guard let state = attr(child, "AXValue").map({ "\($0)" }), state == "0" || state == "1", attr(child, "AXEnabled") as? Bool ?? true else { continue }
        // "agent-frontdesk , edit environment, right arrow": the name, then what its arrow does.
        let full = name(child), short = full.components(separatedBy: " , ").first ?? full
        out.append(PageChoice(element: child, label: short.trimmingCharacters(in: .whitespaces), section: section.isEmpty ? header : section, selected: state == "1"))
      } else if r == "AXGroup", !name(child).isEmpty, name(child) != title {
        if hasItems(child) { collect(child, name(child)) } else { header = name(child) }
      } else { collect(child, section) }
    }
  }
  collect(box, "")
  return out
}
func describe(_ control: PageControl, options: [PageChoice]?) -> [String: Any] {
  var out: [String: Any] = ["kind": control.kind, "label": control.label, "value": control.value]
  if let options { out["options"] = options.map { ["label": $0.label, "section": $0.section, "selected": $0.selected] } }
  return out
}
// Every control, and the options of the menus `read` accepts: a menu is opened to read them and
// closed again (about a second each), so menus nobody is about to choose in are left closed.
func listPageControls(read: (String) -> Bool = { _ in false }) -> [[String: Any]] {
  pageControls().map { item in
    guard item.kind == "menu", read(item.label) else { return describe(item, options: nil) }
    // Right after a pick the menu can still be closing: open it again once if it reads empty.
    var found: [PageChoice] = []
    for attempt in 0..<2 where found.isEmpty {
      if attempt > 0 { close({ pageControl(item.label)?.element }); wait(0.4) }
      guard open({ pageControl(item.label)?.element }) else { continue }
      found = pageControl(item.label).map(pageChoices) ?? []
    }
    close({ pageControl(item.label)?.element })
    return describe(pageControl(item.label) ?? item, options: found)
  }
}
// A folder option is listed by its name and shown on its button as a path ("~/work"): a path
// given as the option matches both.
func standardPath(_ value: String) -> String { URL(fileURLWithPath: value.hasPrefix("~") ? NSHomeDirectory() + value.dropFirst() : value).standardizedFileURL.path }
// (The button's own words for a folder, "~/work", are a path too: the console sends them back
// with the first message so the page is checked to still show them.)
func isPath(_ value: String) -> Bool { value.hasPrefix("/") || value.hasPrefix("~/") || value == "~" }
func shows(_ value: String, _ option: String) -> Bool { value == option || (isPath(option) && isPath(value) && standardPath(value) == standardPath(option)) }
func lists(_ label: String, _ option: String) -> Bool { label == option || (isPath(option) && label == URL(fileURLWithPath: standardPath(option)).lastPathComponent) }
func pickOnPage(_ label: String, _ option: String) -> StepError? {
  guard let item = pageControl(label) else { return StepError(code: "no_control", message: "\(appName)的新建会话页上现在没有「\(label)」这一项") }
  if item.kind == "toggle" {
    guard option == "on" || option == "off" else { return StepError(code: "usage", message: "开关只能选 on 或 off") }
    if item.value != option { press(item.element); until(1.2) { pageControl(label)?.value == option } }
    return pageControl(label)?.value == option ? nil : StepError(code: "not_set", message: "在 \(appName)里按了「\(label)」，但它没有变")
  }
  // Already showing it: nothing to open.
  if shows(item.value, option) { return nil }
  guard open({ pageControl(label)?.element }) else {
    return onScreen() ? StepError(code: "no_menu", message: "没能打开 \(appName)新建会话页上的「\(label)」菜单") : StepError(code: "hidden", message: "\(appName)的窗口不在屏幕上，没能打开新建会话页上的菜单：把窗口放到看得见的地方再试")
  }
  let found = pageControl(label).map(pageChoices) ?? []
  let shownName = isPath(option) ? URL(fileURLWithPath: standardPath(option)).lastPathComponent : option
  guard let choice = found.first(where: { lists($0.label, option) }) else { close({ pageControl(label)?.element }); return StepError(code: "unavailable", message: "\(appName)的「\(label)」菜单里没有「\(shownName)」") }
  if choice.selected { close({ pageControl(label)?.element }); return nil }
  press(choice.element)
  var stopped: StepError?
  let took = until(3.2) {
    if let error = newPageWatch() { stopped = error; return true }
    guard let now = pageControl(label) else { return true } // picking it took this control away (the page changed around it)
    return now.value != item.value
  }
  if let stopped { return stopped }
  close({ pageControl(label)?.element })
  return took ? nil : StepError(code: "not_set", message: "在 \(appName)里选了「\(shownName)」，但「\(label)」没有变")
}
// new-leave, for any flow that parks its desktop on a new-chat page (`--stay`): the conversation
// `--previous` names comes back, and the mode `--previous-space` names, but only from the page
// itself (a conversation on screen, or another mode, is where the person, or a command, went
// since), only while nobody is writing on it, and only while the person is not in the desktop app.
// `inUse`: the page's message box holds text. The person may have come to the desktop meanwhile
// and be starting a chat of their own there: that page is theirs now and is left alone, in the
// mode it is in (`front` / `inUse` in the answer).
func leaveNewPage(inUse: () -> Bool) {
  guard args.first == "new-leave" else { return }
  if app.isActive { beforeExit = nil; out(["ok": true, "left": false, "front": true]) }
  let onPage = current().isEmpty
  if onPage, inUse() { beforeExit = nil; out(["ok": true, "left": false, "inUse": true]) }
  if !onPage { beforeExit = nil }
  if onPage, !parkedPrevious.isEmpty { _ = show(parkedPrevious) }
  out(["ok": true, "left": onPage])
}
// The commands, for a flow that can open its desktop's new-chat page (`open`, nil when it is on
// screen). The page is opened once per command:
//   new-controls [<control>…]                    the controls as the page shows them, with the
//                                                options of the menus named ("*": of every menu)
//   new-pick <control> <option> [<control> <option>…]
//                                                picks each in turn, then lists the controls again
//                                                (one pick can bring up the next; no menu is opened
//                                                to read its options); answers `picked`
//   new-leave                                    the page is left for the conversation `--previous`
//                                                names (and the mode `--previous-space` names), if
//                                                the desktop is still on it (leaveNewPage)
// Afterwards the conversation that was on screen comes back, unless `--stay` asks for the page to
// be kept; either way the answer names it (`previous`, "" when the page was already on screen),
// and a page kept in a mode the person was not in names theirs (`previousSpace`).
func newPageCommands(open: () -> StepError?) {
  leaveNewPage(inUse: newPageInUse)
  guard let command = args.first, ["new-controls", "new-pick"].contains(command) else { return }
  let before = current()
  let previous = before.isEmpty ? parkedPrevious : before
  func goBack() { if !staying, !previous.isEmpty { _ = show(previous) } }
  // A page that did not open is not stayed on.
  if let error = open() { if !previous.isEmpty { _ = show(previous) }; fail(error.code, error.message) }
  trace("new page open")
  // A page just opened fills in for a moment (a toggle that depends on the folder comes after the
  // menus): it is read once its controls have stopped changing. One found on screen was read before.
  if !before.isEmpty {
    var last = "", since = Date()
    until(2.5, step: 0.1) {
      let now = pageControls().map { "\($0.label)=\($0.value)" }.joined(separator: " | ")
      if now != last { last = now; since = Date(); trace("page shows \(now)"); return false }
      return Date().timeIntervalSince(since) >= 0.4
    }
  }
  if command == "new-pick" {
    let pairs = Array(args.dropFirst())
    guard pairs.count >= 2, pairs.count % 2 == 0 else { if !previous.isEmpty { _ = show(previous) }; fail("usage", "缺少要选的项和选项") }
    var picked: [String] = [], moved = false
    func answer(_ error: StepError?) -> Never {
      // A menu that changed can change what the page's own menus show a moment later (another
      // environment brings its own model): they are read once they have stopped changing, so the
      // console does not take the old model for the page's and send it back as a choice.
      if moved {
        func words() -> String { newPageShown().map { "\($0.key)=\($0.value)" }.sorted().joined(separator: " | ") }
        var last = words(), since = Date()
        until(1.5, step: 0.15) {
          let now = words()
          if now != last { last = now; since = Date(); trace("page's menus show \(now)"); return false }
          return Date().timeIntervalSince(since) >= 0.3
        }
      }
      let shown = listPageControls(), menus = newPageShown(); goBack()
      var object: [String: Any] = ["ok": error == nil, "controls": shown, "picked": picked, "shown": menus, "previous": previous, "stayed": staying]
      if let error { object["code"] = error.code; object["error"] = error.message }
      out(object)
    }
    for index in stride(from: 0, to: pairs.count, by: 2) {
      let was = pageControl(pairs[index])
      if let error = pickOnPage(pairs[index], pairs[index + 1]) { answer(error) }
      if was?.kind == "menu", pageControl(pairs[index])?.value != was?.value { moved = true }
      trace("picked \(pairs[index])")
      picked.append(pairs[index])
    }
    answer(nil)
  }
  let named = Array(args.dropFirst())
  let shown = listPageControls { named.contains($0) || named.contains("*") }, menus = newPageShown()
  goBack()
  out(["ok": true, "controls": shown, "shown": menus, "previous": previous, "stayed": staying])
}
