# Foreground and menu test tools

The runners behind the "Menus under real conditions", "virtual desktop" and "watchdog" findings in `../PLAN.md`. They press controls in the real Claude and Codex apps, so use test chats only, and only with the person's agreement for each round.

## Build

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File probes\windows\tools\build-tools.ps1
```

This builds `uia-probe.exe`, `uia-driver.exe`, `fgtool.exe`, `corner.exe` and `screencap.exe` into `%LOCALAPPDATA%\agent-frontdesk\tools`. Set `FRONTDESK_TOOLS` to use another folder.

## Run

From the repository root, with Node 22.16 or later:

```powershell
$env:FRONTDESK_OWN_TITLE = '<title of the chat running the tests>'   # Claude runs refuse to act while the Claude window shows it
node --import tsx probes\windows\tools\menu-run.mts probes\windows\tools\plans\claude2.json out.json
node --import tsx probes\windows\tools\focus-run.mts out.json          # fill, wait for Send, Send, give the foreground back
node --import tsx probes\windows\tools\menu2-run.mts out.json          # Effort to Medium and back, then give it back
node --import tsx probes\windows\tools\guard-run.mts out.json          # the same with the 10 ms watchdog
```

Each runner beeps, waits so the person can set the scene (Claude showing its test chat, the other app in front), beeps again, then acts and writes what happened to `out.json`.
- The Claude window is found anew on each run.
- `focus-run` reads `NUDGE=0`, `LIMIT=<ms>` and `TEXT=<message>` from the environment.

## What each piece does

| File | What it is |
| --- | --- |
| `common.mts` | Paths (repository, tools, profiles), the main-window lookup, and the own-chat title guard |
| `menu-run.mts` | Runs a plan of `uia-probe act` steps. Before and after each step it logs the foreground and the window drawn at Codex's and Claude's centres. A step can have a `waitSeconds` pause of its own |
| `focus-run.mts` | Fill, then wait for Send to show in the tree (optionally nudged with `ScrollIntoView`), then Send, then give the foreground back. `fgtool watch` logs every foreground change on one clock |
| `menu2-run.mts` | Effort to Medium and back to High through Claude's menus, then gives the foreground back |
| `guard-run.mts` | Runs fill + Send and the menus while `fgtool guard` gives the foreground back every 10 ms |
| `settings-test.mts` | Codex's route B: reads the thread's settings, then changes them with a condition, through `thread-follower-update-thread-settings`. Usage: `<repo> <threadId> <effort> [<expected current effort>]` |
| `corner-run.mts` | `fill`, `menu` or `close` with Claude parked off screen but for a corner (`corner.exe`), with the screen recorded. Reads `FRONTDESK_OWN_TITLE`, `ONLY_IF_CURRENT` (unsent text of an earlier run the fill may replace), `GUARD_STEPS=off` (the watchdog only logs during the steps), `TAIL=<ms>` |
| `corner-summary.mts` | Prints a `corner-run` result with times relative to its first step |
| `corner.cs` | `info <hwnd>`; `place <hwnd> <showCmd>` (normal or maximized without activating); `run`: record, park, `uia-probe seq`, put back and check, with the watchdog in a thread. See the top of the file |
| `screencap.cs` | Every frame DWM presents (DXGI Desktop Duplication; GDI as a fallback), compared with a baseline. The frames show the person's screen: keep them under `probes\windows\out\` |
| `fgtool.cs` | `fg`; `restore <hwnd>` (`AttachThreadInput` + `SetForegroundWindow`, no input); `watch <ms> <hwnd>`; `guard <ms> <original> <claude>` |
| `plans/*.json` | The plans the recorded rounds used |

## Other ways to act without the focus

Probes for routes Frontdesk does not use yet (`docs/windows.md`, "What has been tried"). Run them with Windows PowerShell.

| File | What it is |
| --- | --- |
| `hidden-desktop-test.ps1` | Makes a desktop of its own (`CreateDesktop`), starts Chrome or Edge on it (`-BrowserName`) with a local test page and a temporary profile, fills in and presses Send through UI Automation, and counts the person's foreground changes meanwhile. `-LibraryOnly` only declares its Win32 helpers, for the script below |
| `claude-hidden-test.ps1` | The same with the real Claude: Claude must be fully quit first; it is started on the hidden desktop with a new chat whose message asks for "OK", and Send is pressed once. **Sends a real message** (a little quota, a test chat left in Claude): only with the person's agreement. Afterwards start Claude again on the normal desktop |
| `child-session-test.ps1` | Switches child sessions on (`WTSEnableChildSessions`), tries to connect the RDP control to one, logs off only the child it made and switches the setting off again. Refuses to run when child sessions are already on. Run with `-STA` |
