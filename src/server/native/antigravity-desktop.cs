// The Antigravity desktop app (its agent window) through UI Automation on Windows: the twin of
// antigravity-desktop.swift. Its own channels cannot do one thing: take the person to a conversation.
// Everything that writes to a conversation goes through its language server instead
// (src/server/antigravity-bridge.ts), so this flow has no steps of its own; it takes only the shared
// driver's (src/server/native/uia-driver.cs):
//   show-session <title> <id>                       the conversation shown, the app brought to the front
//   open-file <title> <id> <path> <absolute> [label] …and the chat's own link to that file pressed
//   check / probe / inspect / warm
// Its page has an address for each conversation, /c/<id>, which its sidebar's rows link to (the
// profile's "sessionAddress"), so a conversation is found by its id even where two share a title.
//
// Compiled with src/server/native/uia-driver.cs.
namespace Frontdesk.Driver
{
    public static partial class Helper
    {
        static partial void DeclareFlow()
        {
            foreach (string c in new[] { "show-session", "open-file" }) sharedTaken.Add(c);
        }
    }
}
