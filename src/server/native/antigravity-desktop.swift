// The Antigravity desktop app (Antigravity.app, its agent window) through macOS Accessibility, for
// the one thing its own channels cannot do: take the person to a conversation. Everything that
// writes to a conversation goes through its language server instead (src/server/antigravity-bridge.ts),
// so this flow has no steps of its own; it uses only the shared driver's commands
// (src/server/native/ax-driver.swift):
//   show-session <title> <id>                       the conversation shown, the app brought to the front
//   open-file <title> <id> <path> <absolute> [label] …and the chat's own link to that file pressed
//   check / probe / inspect / warm
// The app has no deep link to a conversation (antigravity://open takes a prompt or a project, nothing
// else), but its page has an address for each one, /c/<id>, which its sidebar's rows link to: the
// profile's "sessionAddress" (src/server/native/profiles/antigravity.json), so a conversation is
// found by its id even where two share a title.
//
// Compiled after src/server/native/ax-driver.swift.

fail("usage", "未知命令")
