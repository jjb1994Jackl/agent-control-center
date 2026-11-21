// Uses the shared accessibility driver; no private app storage or credentials.
let grokTitle = "Grok Bot"
let receiptID = try! NSRegularExpression(pattern: #"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b"#, options: .caseInsensitive)
func grokText(_ e: AXUIElement) -> String {
  let shown = value(e)
  return (shown.isEmpty ? name(e) : shown).trimmingCharacters(in: .whitespacesAndNewlines)
}
func grokParent(_ e: AXUIElement) -> AXUIElement? { attr(e, "AXParent") as! AXUIElement? }
func grokSidebarRows() -> [(row: AXUIElement, title: String)] {
  guard let side = find("grokSidebar") else { return [] }
  return within(side, { role($0) == "AXButton" }).compactMap { row in
    guard let label = within(row, { role($0) == "AXStaticText" }).first.map(grokText), !label.isEmpty else { return nil }
    return (row, label)
  }
}
func grokCurrent() -> String { find("grokHeading").map(name) ?? "" }
func grokChatDrawn(_ title: String) -> Bool {
  guard grokCurrent() == title, let history = find("grokHistory") else { return false }
  var ancestor = grokParent(history)
  for _ in 0..<6 {
    guard let box = ancestor else { break }
    if attr(box, "AXSubrole") as? String == "AXLandmarkMain" { return name(box) == title }
    ancestor = grokParent(box)
  }
  return false
}
func grokOpen(_ title: String, activate: Bool) -> Bool {
  let matches = grokSidebarRows().filter { $0.title == title }
  guard matches.count == 1, let match = matches.first else { return false }
  if grokChatDrawn(title) { return true }
  guard activate, act(match.row, kAXPressAction as String) == .success else { return false }
  guard until(5, { grokChatDrawn(title) }) else { return false }
  wait(0.25)
  return grokChatDrawn(title)
}
func grokOffline() -> Bool {
  let labels = Set(settings("offlineLabels"))
  return first { role($0) == "AXStaticText" && labels.contains(grokText($0)) } != nil
}
func grokReadText(_ root: AXUIElement) -> String {
  let text = within(root) { role($0) == "AXStaticText" }.map(grokText).filter { !$0.isEmpty }
  return text.joined(separator: "\n")
}
func grokRowSpeaker(_ message: AXUIElement) -> (String, String)? {
  var possible = grokParent(message)
  for _ in 0..<7 {
    guard let row = possible else { break }
    if classes(row).contains("sand-transcript-row") {
      let label = name(row)
      if let stamp = label.range(of: #"\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s+[AP]M)?$"#, options: [.regularExpression, .caseInsensitive]) {
        return (String(label[..<stamp.lowerBound]), String(label[stamp]))
      }
      return nil
    }
    possible = grokParent(row)
  }
  return nil
}
func grokChatMessages() -> [[String: Any]] {
  guard let chat = find("grokHistory") else { return [] }
  let own = Set(settings("userLabels"))
  return within(chat) { classes($0).contains("sand-message") }.suffix(85).compactMap { message in
    let prose = within(message, { classes($0).contains("sand-message-prose") }).first
    let bodyNodes = Set(prose.map { within($0) { _ in true } } ?? [])
    let labels = within(message, { role($0) == "AXStaticText" && !bodyNodes.contains($0) }).map(grokText)
    let speaker = grokRowSpeaker(message)
    guard let author = speaker?.0 ?? labels.first, !author.isEmpty else { return nil }
    let words = labels.first == author ? Array(labels.dropFirst()) : labels
    var text = prose.map(grokReadText) ?? words.joined(separator: "\n")
    if text.isEmpty, name(message).hasPrefix(author + " ") {
      text = String(name(message).dropFirst(author.count + 1))
    }
    guard !text.isEmpty else { return nil }
    return ["author": String(author.prefix(120)), "user": own.contains(author), "text": String(text.prefix(32000)), "stamp": speaker?.1 ?? ""]
  }
}
func grokPrimaryChat() -> AXUIElement? {
  return grokChatDrawn(grokTitle) ? find("grokHistory") : nil
}
func grokMessages(_ ids: Set<String>) -> [String] {
  guard !ids.isEmpty, let chat = grokPrimaryChat() else { return [] }
  return within(chat) { classes($0).contains("sand-message") }.suffix(45).compactMap { message in
    guard let prose = within(message, { classes($0).contains("sand-message-prose") }).first else { return nil }
    let parts = within(prose) { ["AXStaticText", "AXLink"].contains(role($0)) }.map(grokText)
    let body = parts.filter { !$0.isEmpty }.joined(separator: "\n")
    let ns = body as NSString
    let matched = receiptID.matches(in: body, range: NSRange(location: 0, length: ns.length))
    guard matched.contains(where: { ids.contains(ns.substring(with: $0.range).lowercased()) }) else { return nil }
    // The sender label must live outside the prose, so quoting "Grok Bot" in a user's message cannot match.
    let proseNodes = Set(within(prose) { _ in true })
    guard within(message, { role($0) == "AXStaticText" && !proseNodes.contains($0) && grokText($0) == grokTitle }).count == 1 else { return nil }
    // Preserve the receipt marker even if the user asked for a long response.
    if body.count <= 12000 { return body }
    return String(body.prefix(9000)) + "\n…\n" + String(body.suffix(3000))
  }
}
func grokQuota() -> [String: Any]? {
  guard find("grokUsagePane") != nil else { return nil }
  guard let meter = first({ e in
    let summary = (attr(e, "AXDescription") as? String ?? name(e)).lowercased()
    return ["AXProgressIndicator", "AXLevelIndicator"].contains(role(e))
      && settings("weeklyLabels").contains { summary.contains($0) }
  }), let used = (attr(meter, "AXValue") as? NSNumber)?.doubleValue, (0...100).contains(used) else { return nil }
  var scope = grokParent(meter)
  var reset: String?
  for _ in 0..<3 {
    guard let group = scope, reset == nil else { break }
    reset = within(group) { role($0) == "AXStaticText" }.map(grokText).first { text in
      text.count < 90 && settings("resetWords").contains { text.lowercased().contains($0) }
    }
    scope = grokParent(group)
  }
  var data: [String: Any] = ["usedPercent": used]
  if let reset { data["resetLabel"] = reset }
  return data
}
func grokOpenSettings() {
  // Direct the shortcut to Grok only; never activate it or type into the foreground app.
  for down in [true, false] {
    let event = CGEvent(keyboardEventSource: CGEventSource(stateID: .hidSystemState), virtualKey: 43, keyDown: down)
    event?.flags = .maskCommand
    event?.postToPid(app.processIdentifier)
  }
}

switch args.first {
case "list-chats":
  guard find("grokSidebar") != nil else { fail("no_sidebar", "Grok 的会话列表未打开") }
  out(["ok": true, "chats": grokSidebarRows().map { $0.title }])
case "grok-chat-read", "grok-chat-peek":
  let title = stdinText()
  guard grokOpen(title, activate: args.first == "grok-chat-read") else {
    fail("wrong_chat", "无法确认所选 Grok 会话，请刷新会话列表")
  }
  out(["ok": true, "messages": grokChatMessages(), "offline": grokOffline()])
case "grok-chat-send":
  struct GrokSendInput: Decodable { let title: String; let prompt: String }
  guard let raw = stdinText().data(using: .utf8), let input = try? JSONDecoder().decode(GrokSendInput.self, from: raw),
        !input.prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { fail("input", "缺少任务内容") }
  guard grokOpen(input.title, activate: true), !grokOffline() else {
    fail("wrong_chat", "无法确认所选 Grok 会话在线，消息未发出")
  }
  guard let box = find("grokComposer"), !holdsText(box) else {
    fail("draft_exists", "Grok 原应用有未发送的草稿，消息未发出")
  }
  let normalize: (String) -> String = { $0.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ") }
  let expected = normalize(input.prompt)
  let before = grokChatMessages().filter { $0["user"] as? Bool == true && normalize($0["text"] as? String ?? "") == expected }.count
  insert(box, input.prompt)
  if !until(1, { find("grokComposer").map { normalize(value($0)) == expected } == true && find("grokSend") != nil }) {
    if let editor = find("grokComposer"), !holdsText(editor) {
      setValue(editor, input.prompt)
    }
  }
  guard until(2, { find("grokComposer").map { normalize(value($0)) == expected } == true && find("grokSend") != nil }),
        grokOpen(input.title, activate: false), !grokOffline(), let send = find("grokSend") else {
    fail("no_send", "无法确认 Grok 原应用的输入内容，消息未发出")
  }
  let pressed = act(send, kAXPressAction as String)
  guard pressed == .success else {
    out(["ok": true, "delivery": "uncertain"])
  }
  let seen = until(4) {
    grokCurrent() == input.title && grokChatMessages().filter {
      $0["user"] as? Bool == true && normalize($0["text"] as? String ?? "") == expected
    }.count > before
  }
  // Capture the new user message while the target is still confirmed, before another group can open.
  let observed = seen && grokChatDrawn(input.title) ? grokChatMessages().filter { $0["user"] as? Bool == true } : []
  out(["ok": true, "delivery": seen ? "sent" : "uncertain", "observed": observed])
case "receipts":
  let ids = Set(stdinText().split(separator: "\n").prefix(48).map { $0.lowercased() })
  guard grokPrimaryChat() != nil else { fail("no_primary", "请保持 Grok Bot 的主对话打开以同步回传") }
  // Never read a partial message as a final receipt while the Bot is still writing.
  let busy = first { e in
    let status = grokText(e).lowercased()
    return settings("workingLabels").contains(status)
      || (role(e) == "AXButton" && settings("stopButtons").contains(name(e)))
  } != nil
  out(["ok": true, "messages": busy ? [] : grokMessages(ids)])
case "quota", "refresh-quota":
  if let quota = grokQuota() { out(["ok": true, "quota": quota]) }
  guard args.first == "refresh-quota" else { fail("no_quota", "尚未读取 Grok 本周额度") }
  let wasInSettings = find("grokUsagePane") != nil
  if !wasInSettings {
    grokOpenSettings()
    guard until(3, { find("grokUsagePane") != nil }) else {
      fail("no_settings", "无法打开 Grok 用量面板，请确认桌面应用保持运行")
    }
    beforeExit = {
      if let closeButton = find("grokSettingsClose") { press(closeButton) }
      return nil
    }
  }
  if let pane = find("grokUsagePane") { press(pane) }
  var quota: [String: Any]?
  _ = until(5) { quota = grokQuota(); return quota != nil }
  guard let quota else { fail("no_quota", "Grok 的当前用量页面未返回每周剩余额度") }
  out(["ok": true, "quota": quota])
default:
  fail("usage", "未知的 Grok 桌面读取命令")
}
