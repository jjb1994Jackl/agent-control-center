# Bringing desktop sending to Windows: where it stands

This is the hand-off for whoever continues the Windows port, in particular a Claude Code session on a Windows machine. Read it with `README.md` in this folder (the probe) and `skills/add-desktop-engine/references/channels.md` (how sending works today).

## Status

- **Done:** the analysis below, and the probe (`uia-probe.cs`, `probe.ps1`).
- **Step 1 runs:** on Windows 11 (build 26200, PowerShell 5.1, .NET 4.8.1) the helper compiles with `csc.exe` as written, and step 1 (read) runs end to end. The first run needed three fixes in `probe.ps1` and the helper: output paths past 260 characters, a second engine being handed the first engine's window, and a hidden Codex window being picked over its main one.
- **Probe phase closed.** Development happens on the `windows` branch, verified step by step against the real apps, in test chats only. The probe's open questions that were not run (settle, off screen) are answered as the port reaches them.
- **Where it stands (2026-11-18, after the round of real-app tests).** Development continues on the branch `windows-integrate`: PR 1 (lokic7123-star's Windows 11 support) with the `windows` branch merged in, then the round below. See "Integration with PR 1, and one quiet layer for every engine" and "The round of real-app tests" just below. `npm test` (171) and `npm run check` pass on Windows; CI has a Windows job (not run yet: nothing is pushed).
- **Left for the person, or for another machine** (each says why):
  - **A server at Medium integrity.** This machine has UAC off (`EnableLUA=0`), so every program runs at High. Trying it needs UAC on and a restart, a system security setting that is the person's to change, not a test's.
  - **More than one monitor.** This machine has one.
  - **A person moving to the app itself mid-park** (its taskbar button or Alt+Tab). It needs a real click during a park; a program cannot take the foreground on cue (measured again: `SetForegroundWindow` and `SwitchToThisWindow` from a background process were refused). The watchdog still takes such a move back, as it cannot tell it from the page's own grabs. A way to tell them apart, not built: a move the person makes goes through the shell first (taskbar, Alt+Tab switcher), a page's grab does not.
  - **On a Mac:** `claude-desktop.swift` now answers `queued` (written to match the C# flow, not compiled: it needs a Mac); route B's `thread-follower-start-turn` after a stopped turn (the same desktop code, not tried there); PR 1's Antigravity changes (tried on Windows: below).
  - **Claude's Code sessions are found by their title** in the sidebar, on both platforms. Two sessions with one title could be mixed up; the session link (`claude://…/<localId>`) would tell them apart. Both drivers would have to take it first where the title is not unique: a change to try on a Mac too. Main (merged after v0.2.0) gives the Mac driver a profile key for this, `sessionAddress` (a conversation found by the id in its page's address and its sidebar link, used by Antigravity); `uia-driver.cs` reads it now too (Antigravity, below); Claude's profile does not use it.
  - **Antigravity's window (main, after v0.2.0)**: "Open in Antigravity" and a file from its chat go through the shared driver's `show-session` / `open-file`, on Windows too now: `antigravity-desktop.cs` takes only those two (`sharedTaken`, so `check` names no chat-mode command), and `uia-driver.cs` reads main's `sessionAddress` and `fileLink`. Tried on the real app (Antigravity running its agent window, "Standalone"): its page's address is `https://127.0.0.1:<port>/c/<id>?project=…` and each sidebar row a link to `/c/<id>`, as on the Mac. The console's show for "Casual Greeting", from minimized: 0.9 s, the window in front on that chat; parked, a show by address took 0.18 s. `open-file` on "Clone And Run GitHub App": its file pills are buttons named the file's name and described by its whole path (`c:\…\ScreenSwitch.cs`), which `Label` joins to the name, so `FileLinks` matched none; it now matches the description as the path (and the name alone as the text): pressed in 0.5 s, the file opened in a tab beside the chat. Not tried: a list long enough to need scrolling (five conversations), two of one title, and a window the person closed (the Mac's reopen is not ported: with no window the command says the app is not running).
- **Before that (end of the second round of step 3).** Claude sends end to end through its window on Windows: send, steer and Send now, stop, model / effort changes (with the "Switch model?" question), a question card, a card's own button, from behind the person's window, which keeps the foreground. Details: "Step 3" and "Step 3, second round" below. For whoever continues:
  - **The console reads Claude's models, efforts and usage through Claude's CLI**, on Windows as on the Mac (`list_models`, `get_usage`, `auth status`). The Windows desktop signs its own sessions in through a local proxy, which the console must not use, so the CLI needs its own `claude auth login` once. Until then the model menu is empty and says why on hover.
  - ~~The Mac helper (`claude-desktop.swift`) does not answer `queued` yet~~ It does now, not compiled (above).
  - ~~Not tried: `new` through the console, `open-file`, the Claude-mode chat commands on a real chat, a park from minimized since the second round~~ Tried in the round of real-app tests (below). More than one monitor and a person moving to Claude mid-park: still not (above).
  - **The test machine's Claude window lost its normal bounds** to the maximized ones, through the first way of parking a maximized window (second round). Showing it normal once and sizing it back fixes it. It was left as it is.

## Integration with PR 1, and one quiet layer for every engine

**Why.** Claude can be reached only through its window, so it was where the way of working a window from behind was found and measured (below). Nothing in that way is Claude's: the three facts it answers are Chromium's on Windows, so they hold for Codex and for any Electron desktop added later:
1. any action that moves the page's focus makes the window take the foreground;
2. a fully covered window stops updating its accessibility tree (Send never shows);
3. a page's menus answer only while the app holds the foreground.

So it is one layer of the shared driver, which every engine's flow acts through, and the measured rule ("never take the foreground, never send input") is held there once.

**The layers** (`src/server/native/`):

| Layer | Where | What |
| --- | --- | --- |
| Engine flows | `<engine>-desktop.cs` (`claude-desktop.cs`, `codex-desktop.cs`) | Only the driver's actions; no Win32 call of their own |
| Actions | `uia-driver.cs` | Read, `Press`, `Fill`, `OpenMenu` / `CloseMenus`, a card's press (`Activate`), `BringForward` |
| The window | `uia-driver.cs`, between `// ==== the window` and `// ==== end of the window` | Park, watchdog (gives the foreground back, follows the person, keeps the corner up), `HoldForeground`, put back, park record and recovery, park lock |
| Locators | profiles + the role map | Sole, Confirmed (menuSigns), `via` |
| UIA | COM UIA3, one cache request per read | about 480 nodes in 60 ms |

What each kind of action costs the person, as measured (the layer decides it, not the flow):

| Action | Parked | Foreground | Measured |
| --- | --- | --- | --- |
| Read (`warm`, `probe`, `chat-status`) | no | untouched | nothing |
| Fill, then Send | yes | given straight back | each grab 31 to 63 ms |
| A menu: open, pick | yes | held while it is open | about 0.5 s, window still off screen |
| A card's own button | yes | `Activate()`, held for the press | about 0.45 s |
| `show-session`, `open-file` | no | brought forward: the person asked to go there | |
| The person is in the app | no, acts in place | as on the Mac | |

**Added in this round** (commit "one quiet layer for every engine's window"):
- **A park outlives its helper.** The server stops a helper that runs past its timeout, and a stopped process runs no clean-up. Before the window moves, how to put it back is written to `parked\<window>.json` next to the helper (`%LOCALAPPDATA%\agent-frontdesk`), and removed once it is back. Every helper start (any engine; the warm read comes every 10 s while the console is used) puts back a window whose record no live park owns, and the server runs `restore` right after a helper it had to stop (`unanswered` results). Tried on a Notepad window of the test's own, left off screen with a record: `restore` put its placement back exactly and removed the record.
- **One park at a time on the machine**, by a named mutex (`Local\agent-frontdesk-park`): Claude's and Codex's helpers, or two servers, no longer run two watchdogs against each other. A helper that ends while parked leaves it abandoned; the next one takes it and recovers. A park that cannot start in 15 s answers `busy`, and nothing is done.
- **The rule is a test** (`test/platform.test.ts`): no flow and no driver code sends keys, mouse input, the clipboard or UIA focus, and only the window section moves a window or the foreground.
- **What a park did not put back** (placement, z-order, foreground, a hold past 4 s) is logged and kept as the engine's last park (`EngineStatus.park`); the page's status line says when the window did not go back where it was.

**PR 1 against the `windows` branch**, file by file, and what was kept:

| Part | PR 1 | `windows` | Kept |
| --- | --- | --- | --- |
| Window helper | `win32/uia-driver/Program.cs`, .NET 8 SDK (`dotnet publish`), managed UIA. Fill by `SetFocus` + clipboard (not restored) + `SendKeys ^a ^v`; Enter, Esc and arrow keys by `SendKeys`; `warm` un-minimized the window every 10 s. Interactive parts tried in unit tests only (its description: Claude desktop was not installed) | `uia-driver.cs` + flows, the `csc.exe` Windows ships, COM UIA3, parked; tried on the real Claude | `windows`. PR 1's Codex flow was a port of the Swift with nothing Windows-specific; `codex-desktop.cs` is written from the Swift on the shared driver. `Program.cs` is removed |
| Places | in `config.ts`; `%APPDATA%\Claude`, `%LOCALAPPDATA%\Programs\…` (none of them exist on this machine's MSIX installs) | `services/desktop-places.ts`, MSIX through `Get-AppxPackage`, Claude-Data | `desktop-places.ts`, which now also tries PR 1's per-user installs, `~\.local\bin\claude.exe`, and Antigravity's icon in its app.asar |
| Starting CLIs | `winSpawnArgs`: a `.cmd`/`.bat` through `cmd /d /s /c` | `windowsHide` on every child | Both. (Its `%` → `%%` does not escape in a command line; harmless for the fixed arguments it gets) |
| Codex wake link | `cmd /c start` | `rundll32 url.dll,FileProtocolHandler` | `windows` (no cmd.exe, no escaping) |
| The page | Windows paths in links, `repoKey`, file previews, `C:\` roots | (open item) | PR 1 |
| Codex projects | separator- and case-insensitive roots | | PR 1, but a whole disk (`/`, `C:\`) is dropped again: it had come to match every chat |
| Claude CLI choice, tmpDir | config's newest-modified copy; tmpDir `os.tmpdir()` everywhere | | The bridge's own search again (newest version); tmpDir `/tmp` on macOS, `%TEMP%` on Windows, where every `%TEMP%\claude\<hash>\<id>` is a file root |
| Antigravity | conversation filtering as the desktop's list (archived, CLI, sub-agents, empty), grouping by worktree checkout, a turn completed only on the desktop's reply or notice, StartCascade with a model | `language_server.exe agentapi` started directly | Both. PR 1's changes here are on every platform: **to be checked on a Mac** |
| Tests | 149; `.cs` strings in the i18n scan | 154 | 163. The i18n scan reads a C# concatenation as one text |

**Codex on Windows now:**
- sending, steering, stopping, queuing: routes A and B, no window (verified earlier);
- an existing chat's model and effort: route B (`thread-follower-update-thread-settings`), brought back from `codex-ipc-settings`; with no window owning the chat, Windows does not send and says why;
- a new chat: `codex-desktop.cs` `new` / `new-shown` / `new-leave`, parked. An effort other than the New chat page's is refused before anything is touched (the slider takes only arrow keys). Tried on the real app (below).

## The round of real-app tests (2026-11-18)

Claude 6.6395, Codex 26.1111, Antigravity running; one monitor, UAC off. Test chats only: Codex's local "回复 OK" (`D:\af\codex-test`) and new chats there, Claude's "测试" and a new session in `D:\af`, Antigravity's "Casual Greeting", and, for the chat modes, one new ChatGPT-mode chat ("回复指定文本") and one new Claude-mode chat ("绿色鹦鹉 9047"), which stay in the person's accounts. Every turn was checked in its record. Server on port 4111.

**Codex with its window closed to the tray** (the app hides its window; found so at the start):
- Its page reads as 22 elements, and its main window (hidden and minimized) sits beside a second hidden window titled the same ("ChatGPT"), which `FindWindow` would pick. So a window command could not act, and nothing could tell which window to show: **every window command now refuses a hidden window** (`FailIfHidden`: the park, `open-file`, `show-session`, a page that reads empty) and says to open the window from the tray. Tried: the New chat options answered with that message.
- Route A (queue + wake): the desktop took the message from the tray and ran it.
- Route B, all of it, from the tray: read settings (7 ms), **stop** (`turn_aborted` within a second), **model change** (the next turn's `turn_context` has the new model), **an approval** (with the chat's `approvals_reviewer` set to `user` for the test, then back to `auto_review`: the card showed in the console, accept ran the command), **a question card** (in Plan mode for the test, then back to Default: the console's pick was the answer).
- **After a stopped turn, the desktop holds its queue**: each queued message shows paused until the person sends one (`pausedReason` while the last turn is `interrupted`, the desktop's own code). A message the console queued then waited for good; a new wake did not help. Now the window that owns the chat starts that turn over route B (`thread-follower-start-turn`, version 2), given only the message; the owner fills in cwd, model, mode and permissions (its `turn_context` matched the desktop's own turns). Stop, then send: the second message ran at once. With no window on the chat it is queued as before, and the waiting note says why it may wait.
- An existing chat's model and effort go over route B on Windows only; macOS keeps its menus (route B settings are not tried on a Mac). **Superseded by the merge of main (v0.2.0):** main's `pickInDesktop` sets them through the owning window on every platform, and opens a chat no window owns with the helper's `settings` first. On Windows `settings` brings the chat up and goes back (no menu: the slider takes keys). Tried after the merge: `settings` on its own (1.3 s park, all put back), a model change on an owned chat and back, a send right after a stop, and **a chat no window owns** (Codex restarted, so none of the test chats had an owner; Codex minimized): the console's message with GPT-6-Sol for "Reply OK in Frontdesk test" (on GPT-6-Luna) opened it in the background, the owner set the model, and the turn ran with it (`turn_context` `gpt-6-sol`), 4.1 s from send to done; the window went back minimized. The person's chat comes back only when there was one: started on the New chat page, Codex was left showing the opened chat (the Mac's `settings` does the same). **The menu as the fallback, model only:** when the router cannot, `settings --model` picks the model in the chat's own model menu, with no key: the pick from behind leaves the menu open, so the page's focus is moved into the composer (its text set again, or a space set and taken out), which closes it, and the button must show the model. Tried with the helper on "Reply OK in Frontdesk test": GPT-6-Luna and back to GPT-6-Sol, each a 2.3 s park with the foreground held 1.6 s for the menu, the owner then reading the new model, the composer left empty, the person's window keeping the foreground. An effort other than the chat's is refused (`--effort high` on a Medium chat: a 0.4 s park to read it, no menu); the same effort passes.

**Codex's new chat through its window** (parked from minimized, and from behind every window):
- In the project: created and completed (7.9 s park, 5 grabs of up to 102 ms, all given back).
- With another model: the pick is made, but from behind the model menu goes back to its first page and stays open, and the button shows the new model only once it closes. The flow goes on to the fill, which closes it, and presses Send only with no menu open and the model shown. GPT-6-Luna, then back to GPT-6-Sol: each turn ran with the model picked; the foreground is held 1 s at most for the menu (it was 4.5 s).
- A page Codex drew while fully covered can lack nodes (its composer was not in the tree): the command refuses ("bring its window to the front once"), as a cold Claude page does. Uncovered, the nodes came.
- The park report no longer calls a minimized window's z-order not put back.

**Claude:**
- **Kill recovery** on the real window: the helper killed 150 ms after its park record was written, the window left at the corner (`-2565,-1385`); `restore` put placement and rect back exactly and removed the record; the foreground never moved.
- **Two engines at once**: a Claude `settings` and a Codex `new-shown` started together: Claude parked 0 to 3.0 s, Codex waited on the park lock and parked 3.1 to 5.4 s; both put back exactly.
- **From minimized**: put back minimized. But a 1.1 s park left `window-state.json` with the corner's bounds (`x:-2031, y:-1094`): this Claude version saves about 1 s after the move. Repaired by hand (shown normal at its bounds until saved, maximized again: the file reads `x:0, y:0, 2054×1105, maximized`, as before). The driver now checks the saved bounds after every park from minimized (until 4 s after the move, or a save on screen since the park began).
- `new` through the console (a session in `D:\af`, completed), `open-file` (pressed, 1.2 s), `show-session` back to the session the tests ran in.
- **Chat mode**: a new chat, a message into it, and its reply stopped from the console (cut at 165 characters, read back as interrupted). The switch to the chat mode missed about one run in four (a press lost while the page settled): it is pressed again after 1.2 s; eight reads in a row then all worked, four of them on the second press.
- The park lock's failure answers `park_busy` now: its `busy` was what a Claude flow answers for a running chat, which the bridge steers into.

**Codex's ChatGPT mode** (the chat modes are shared code):
- A message for its ChatGPT chat "回复 OK" went to the Codex thread of that name: the mode's Recents list the Codex threads too, a sidebar row carries no id, and Codex's page address (`app://-/index.html`) none either. One chat is often listed twice (under its project and in Recents), so the driver cannot refuse on rows alone. **The console's chat mode** (`desktop-chat.ts`) now does not send to, read or show a chat whose title another entry of that sidebar has, and says to rename one. Tried: the console refused both, and nothing reached either chat.
- A new chat and its first message went through. In a chat already open, Send pressed from behind did nothing; with Codex in front the same press sent. So when the message stays in the composer, the window is activated (still off screen) for that press only, as for a card's buttons (held 0.9 s); the page draws Send anew around the press, so it is read again first. Sent; window back minimized, the person's window kept the foreground.
- **The fill took about 4 s** (its first set not taken), and Claude's chat mode had it too. Measured with a probe that fills and clears and never presses Send, in "回复指定文本" and "绿色鹦鹉 9047": the value pattern's set answers done, yet the box keeps what it held for as long as it is watched (3 to 4 s), so the page did not take it; set again, it takes within 0.2 s, replacing the text (never doubled). Codex missed the first set about one time in five on an empty box and nearly every time on a box that held text; Claude 4 of 22. The cost was `Fill`'s 4 s wait before its second set. Now `Put` (the driver) gives each set 0.6 s and sets again within the time it has; `Fill`, `Clear` and Claude's draft put back go through it, and an empty box is told by `HoldsText` (its placeholder reads as its value: Codex's "Work with ChatGPT"), which `Clear` did not do: its one set could leave the message in the composer, as the probe's first run did. Measured after: a fill 0.15 to 1 s (Codex two sets every time, Claude one or two), a clear 0.2 to 0.9 s and the box empty, and one real send in each chat ("只回复 OK", answered "OK"): Claude pressed Send 1.3 s after the command began, Codex 2.6 s. Why the page drops a set is not known. Not measured in Claude's Code mode (the same `Fill`): it would switch the session the person was using.

**Antigravity** (PR 1's changes run on every platform): a message to "Casual Greeting" from the console ran in the desktop and ended `completed` on its reply.

What the test machine was left as: Codex in its Codex mode, minimized (it was in the tray at the start; the console cannot hide it again without the decoy-window problem above), its New chat page on GPT-6-Sol; Claude maximized with its saved bounds as before; the test chats' settings as they were.

## Development on Windows

The runners and the foreground tool behind the measurements below are in `probes/windows/tools` (see its README: `build-tools.ps1`, then `node --import tsx probes\windows\tools\<runner>.mts`).

Order (status as of the round of real-app tests above):
1. The platform layer: done;
2. the C# driver's skeleton, read-only: done;
3. Claude sending: done, tried on the real app (its chat mode too);
4. the settings menus: Claude's done; Codex's through route B instead (Windows only);
5. a Codex new chat: done, tried on the real app (project and model picked from behind);
6. CI: a Windows job (compile + unit tests, no app driven); runs once the branch is pushed.

**Step 1, the platform layer.** Status: done for reading; sending: see step 3.

What changed:
- **`src/server/services/desktop-places.ts`** holds every per-platform place, and the bridges and plugins ask it:
  - Claude desktop's data folder. On Windows that is `%LOCALAPPDATA%\Claude-Data\claude_<id>`, the one holding `claude-code-sessions`. `%APPDATA%\Claude` now holds only a `.user-data-left` pointer.
  - Its own CLI, `claude-code\<version>\<build>\claude.exe`.
  - The apps' `app.asar`, the bundled `codex.exe`, and the app icons (the MSIX tile logo, a PNG). The MSIX install folder is asked of `Get-AppxPackage` once per package.
  - Codex's router pipe, `\\.\pipe\codex-ipc`.
  - The helper cache, `%LOCALAPPDATA%\agent-frontdesk`.
  - Opening a link: `rundll32 url.dll,FileProtocolHandler`, with no cmd.exe, so `&` and quotes need no escaping.
  - Antigravity's exe for opening a file.
  - PATH lookups with PATHEXT.
- **`npm run dev:server`** is a Node script, because cmd.exe has no `PORT=$((…))`.
- **`.gitattributes`** keeps every checkout LF. Git for Windows' `core.autocrlf=true` had turned the sources CRLF, which broke the tests that read the Swift sources.
- **File preview.** `relative` is now written with `/` on every platform. On Windows `.git\config` had slipped past the `INTERNAL` check, and nested secrets past `SECRET`.
- **`DesktopAutomation#check()`** on win32 says the window helper is still being ported. Nothing is pressed there yet.

How it was verified:
- `npm test` passes, 151 of 151, on Node 26.
- `npm run check` passes.
- The server reads history: Claude 13 sessions, Codex 152, Antigravity 4. A session of each opens with its turns, and the page draws.
- Codex's app-server, the bundled `codex.exe`, connects.
- Nothing was sent.

**Codex sending on Windows, verified in a test chat** (`D:\af\codex-test`, a local Codex chat). The server was started from a shell, and Claude stayed in front throughout. "onTop" means the window drawn over Codex's centre.
- **Route A** (`thread/queue/add` plus `codex://threads/wake/<id>` through `rundll32 url.dll,FileProtocolHandler`):
  - The desktop ran the queued message, and the record ended `completed` with `task_complete` evidence. The reply was correct.
  - The foreground and onTop stayed claude.exe at 2, 5 and 10 s. **The wake link does not bring Codex forward.**
- **Route B, steer** (`thread-follower-steer-turn` over `\\.\pipe\codex-ipc`, through the console's `mode: "steer"`):
  - The message joined the running turn, which then followed it (its reply ended with the asked-for line), and the record has the steer.
  - The foreground did not change.
- **Route B, settings** (`thread-follower-update-thread-settings`, version 2; `thread-follower-read-model-settings`, version 1):
  - `{effort: "low"}` with `condition: {ifEffortEquals: "medium"}` answered `{applied: true}`. The owner's read and the console's read of the thread both show `low`.
  - A condition that does not match answers `{applied: false}` and changes nothing.
  - The foreground did not change.
  - Not checked yet: that the next turn runs with the new effort. The bridge does not use this request yet; it still goes through the menus.
- **Creating the test chat** (step 5's deep link, tried early):
  - `codex://threads/new?prompt=…` fills the composer of a new chat and sends nothing.
  - With no `path`, the chat that results is a ChatGPT-space conversation, whose text is not stored locally. That happened twice by mistake, and two "回复 OK" ChatGPT chats were left.
  - `mode` is not the app mode: the app was already in Codex mode.
  - With `path=D:\af\codex-test`, Codex first asked "Trust this folder?". The person agreed, and the chat was then local, with that folder as its project.
  - Send was pressed through UIA (`Invoke` on the profile's `send`), which worked.
  - Opening the link brought Codex to the front. The shell that opened it was a child of the foreground Claude app, so the inherited-right caveat applies.

**Settings over route B, set aside.** Changing Codex's model and effort through `thread-follower-update-thread-settings` was built and verified: the next turn's `turn_context` had the new effort. That change is on the branch `codex-ipc-settings` and reverted on `windows`. The router reaches Codex only; Claude and any agent added later change settings through the desktop's menus, so the menus were measured first (below).

**Menus under real conditions** (the decisive measurement for every agent's settings). Setup:
- The helper was started by a node process, and in a cross-check by a one-off scheduled task ("interactive only", deleted afterwards), so the launcher was not the foreground process or a child of it.
- Notepad was put in front 12 s before each run.
- Each step recorded the foreground window and the window drawn at Codex's and Claude's centres (`ontop`, WindowFromPoint), and the person watched the screen.
- Only test chats were used:
  - Claude: a Code session of its own; the runner checked the window showed it, not the session running these tests.
  - Codex: the local test chat.

| Step | Claude | Codex |
| --- | --- | --- |
| Open the model menu with `Invoke` | No `Invoke` on the button | No `Invoke` on the button |
| Open it with `ExpandCollapse.Expand`, from behind Notepad | Opens. **Claude is raised and takes the foreground** | Opens. **Codex is raised and takes the foreground**, the same from node and from the scheduled task. The person saw it jump forward |
| `ExpandCollapse.Collapse` on the button | On a closed menu it throws, and still brings Claude forward | Does not close it |
| `LegacyIAccessible.DoDefaultAction` on the button | Did not open a closed menu | Does not close it |
| Submenu with `Expand` | Effort and More models both open | Select model is a row with `Invoke` only, which opens the model list in place |
| Pick the current choice with `Invoke` | Effort High: the menu closes, and the button still reads "Opus 5.5 High" | GPT-6 Sol: the menu goes back to its main page and stays open; the choice is unchanged |
| Pick with `SelectionItem.Select` | Opus 5.5 under More models: the menu stays open, nothing changes | (rows are radio buttons with `Invoke` and `SelectionItem`) |
| Power (effort) | (n/a) | A menuitem with `Invoke`; inside it, groups only, with no `RangeValue`, no `Value`, no tick elements. It says "Use Left and Right arrow keys to adjust power". **No UIA route** |
| Fill the composer with `Value.SetValue`, then `Invoke` Send | **Works**: Send appears after the fill, and the record has the turn, completed | (step 1: `Invoke` on Send worked on the new-chat page) |

**Hypothesis, not verified:** the grab may not be Claude's or Codex's own doing but Chromium's on Windows.
- When focus moves inside the page, Chromium activates its window, and it has a way to force the foreground (`ui/base/win/foreground_helper`). Then no launcher could prevent it.
- Any action that moves DOM focus could then take the foreground: opening a menu, `Collapse`, perhaps also `Value.SetValue` on the composer.
- That makes the next measurement decisive for whether Claude can send on Windows: fill and Send from behind, as two separately recorded steps.

**Fill and Send from behind, recorded as separate steps** (node launcher, Notepad in front, the Claude test session; guard as above):
- **`Value.SetValue` on the composer takes the foreground.** Foreground and onTop went from Notepad to claude.exe, and Send then appeared.
- After that, at a pause of its own, the person put Notepad back in front, and **Claude took the foreground back** before Send was pressed. The person saw it happen. So `Invoke` on Send could not be measured from behind.
- The message was sent; the record has the turn, completed.
- This fits the hypothesis above (focus moving inside the page activates the window). It means **Claude cannot send through its window on Windows without taking the foreground**, whatever launches the helper.

**The same with Claude's window on another virtual desktop** (moved there with Task View; the person on desktop 1 with Notepad in front; node launcher; the guard read the test session's title, so the page could still be read):
- The window reports `cloaked=2` (cloaked by the shell) and not on the current desktop.
- **Value.SetValue:** the screen stayed on desktop 1, with Notepad drawn on top. The person saw only Claude's taskbar button flash. The foreground did move, to a short-lived Claude window (`0x705d8`, not the main one), until the person clicked Notepad again: until then, typing would not have reached Notepad.
- **But Send did not appear after the fill, so nothing was sent.** Either the value never reached the page, or Chromium does not update a cloaked window's tree; this run cannot tell which.
- **Follow-up: the fill had landed.**
  - A later read found the composer holding exactly that text (37 characters), and the person saw it there.
  - Send was then in the tree: Chromium had updated the cloaked window's tree late, not at once.
- **`Invoke` on Send, with Claude still on desktop 2** and the person on desktop 1 with Notepad in front:
  - **The message was sent.** The record has the turn, completed, with reply "OK".
  - Notepad stayed drawn on top, and the desktop did not switch.
  - The foreground again went to the short-lived Claude window `0x705d8`.
- **So with Claude's window on another virtual desktop, fill + Send works without the window being raised or the screen switching.** What remains is that the keyboard focus leaves the person's app, for a window they cannot see, until they click back. Two other points:
  - A tree that updates late means a flow must wait for Send to appear, as `ax-driver.swift`'s fill already does.
  - Nothing yet keeps the focus from moving.
**Next round on desktop 2** (same setup; a foreground tool sampled the foreground every 50 ms on one clock; "switched" means Notepad was no longer on the current desktop, i.e. the screen went to desktop 2):

| Run | What was done | Foreground and desktop | Result |
| --- | --- | --- | --- |
| 1 | `SetValue`; Send not in the tree after 2.4 s, so `ScrollIntoView` on the composer; Send seen at 3.2 s; `Invoke` Send; foreground given back | At 0.2 s the foreground went to a short-lived Claude window, with no switch. At 3.4 s, after `ScrollIntoView`, the Claude main window took it **and the screen switched to desktop 2**. Given back at 3.7 s (in 19 ms), and the screen came back to desktop 1. Nothing moved for the next 16 s | Sent, completed. The person saw desktop 2 flash |
| 2 | The same, without `ScrollIntoView` (waiting up to 30 s) | At 0.2 s **the fill itself switched the screen to desktop 2** (Claude main window). Send was in the tree at once. Given back at 1.0 s (13 ms). (At about 10 s the screen went to desktop 2 again, by way of the shell; most likely the person, but not confirmed) | Sent, completed. The person saw desktop 2 flash |
| 3 | Model menu: `Expand`, Effort `Expand`, `Invoke` Medium; read the button; the same again to High; foreground given back | At 0.4 s, on opening the menu, the Claude main window took the foreground **and the screen switched to desktop 2**, until the foreground was given back at 5.8 s | **Every step worked.** The button read "Opus 5.5 Medium", then "Opus 5.5 High" again, and each pick closed the menus |

What this shows:
- **Giving the foreground back works** (`AttachThreadInput` to the foreground thread, then `SetForegroundWindow`, in 13 to 19 ms, with no input sent). It brings the screen back to the person's desktop, and Claude did not take it again afterwards.
- **Another desktop does not reliably stop the screen from switching.** The same fill was seen to move only the keyboard focus (twice) and to switch the screen (once). `ScrollIntoView` and opening a menu switched it every time they were tried.
- **Send can be late** in the tree when the screen does not switch (more than 2.4 s). The only nudge tried (`ScrollIntoView`) switches the screen, so a flow should rather wait.
- **On desktop 2, Claude's menus do change the settings**, as their button shows. So settings through menus work there, at the cost of the screen going to desktop 2 for as long as the change takes (about 5 s here), then coming back.

**A watchdog instead of another desktop.** Setup:
- Claude was back on the person's desktop, behind a maximized Notepad, showing its test session.
- A watchdog checked every 10 ms and, whenever a claude.exe window held the foreground, gave it straight back to Notepad (`AttachThreadInput` + `SetForegroundWindow`, no input). It also timed how long Claude's window was drawn on top at its centre.
- The run had two phases: A, fill + Send; B, the Effort menu to Medium and back to High.

| Phase | What happened | Numbers | What the person saw |
| --- | --- | --- | --- |
| A: fill | Claude took the foreground and was given it back | 1 grab, **47 ms** | "One frame" |
| A: Send | **Send never appeared in the tree in 15 s**, so nothing was sent. The text stays unsent in the test session's composer | (none) | (nothing) |
| B: menus | Every step worked: the button read "Opus 5.5 Medium", then "Opus 5.5 High". But the grab when the menu opened **could not be undone**: 389 of 390 give-backs failed while the menus were up | Claude on top from 18.1 s to the end, **about 6 s**, and still in front after the watchdog stopped | "Stayed a few seconds; still in front" |

What this shows:
- A fill's grab can be undone fast enough to be one frame.
- With the window behind another app, though, Chromium did not update the tree (or the page) to show Send. On another desktop it showed late; here it did not show at all.
- While Claude's menu is open, `SetForegroundWindow` to another window fails, attached or not. So a menu change keeps Claude in front for as long as the menus are open, and longer.

**Parked in a corner: Claude moved off the screen but for a few pixels, then put back.** The idea: Chromium stops updating a fully covered window, so leave a few pixels of it uncovered. Do that where the person does not look, by moving the window almost entirely off the virtual screen, act, then put everything back.

Setup:
- Claude on the person's desktop, showing the test session ("测试", opened with its `claude://claude.ai/epitaxy/<id>` link), behind a maximized Notepad that held the foreground (Chrome sat between them in the z-order from the second run on).
- Tool: `tools/corner.cs`, run by `tools/corner-run.mts`. One process does every step: it records, parks, runs the steps through `uia-probe seq` (one process, no fixed pause between steps), puts everything back and checks. The watchdog runs in it every 10 ms throughout.
- Screen: `tools/screencap.cs` records every frame the compositor presents (DXGI Desktop Duplication) and compares each with a baseline taken before anything moves. A GDI capture takes about 22 ms per frame at 2560×1440, too slow for a 16 ms grid.
- Times below are milliseconds from the run's first step.
- The frames stay under `probes\windows\out\` (not committed).

What the tool does, after the fixes the first runs called for:
1. **Record:**
   - `GetWindowPlacement`;
   - the window right above Claude (`GW_HWNDPREV`, which is Claude's own hidden IME window);
   - the nearest visible window above it that is not topmost and not Claude's (the one to put it back under);
   - the visible z-order;
   - the foreground.
2. **Maximized:** `SetWindowPlacement` with `SW_SHOWNOACTIVATE` (not `SW_SHOWNORMAL`, which activates) and `rcNormalPosition` = the maximized rect. The size does not change, so the page does not lay out again. Before this, DWM's transitions are switched off for the window with `DwmSetWindowAttribute(DWMWA_TRANSITIONS_FORCEDISABLED)`. That works across processes (S_OK).
3. **Move** with `SWP_NOZORDER | SWP_NOACTIVATE`, so the window's visible frame (`DWMWA_EXTENDED_FRAME_BOUNDS`) ends at (4, 4). The window rect is 12×12 on screen, because of its invisible resize borders. Then **wait 400 ms**, and only then raise it.
4. **Raise:**
   - `HWND_TOP` + `SWP_NOACTIVATE`. From a background process this usually leaves the window under the foreground window: it raised the corner in 1 of the 9 runs.
   - So the fallback is `HWND_TOPMOST` then `HWND_NOTOPMOST`, which leaves it at the top of the ordinary windows.
   - Then `WindowFromPoint(2, 2)` must be claude.exe, and it was in every run.
5. **While parked:**
   - Giving the foreground back raises Notepad over the corner again, so the watchdog re-raises Claude whenever the corner point is not Claude. That takes 12 to 123 ms per time.
   - When the plain give-back fails, the watchdog tries:
     - attaching to both threads, with `BringWindowToTop`;
     - then `SwitchToThisWindow`.
6. **Restore**, in this order:
   - foreground (if Claude still holds it, `SW_SHOWMAXIMIZED` would put it on top);
   - z-order under the recorded visible window;
   - `SetWindowPlacement(original)` (normal shown with `SW_SHOWNOACTIVATE`);
   - z-order again;
   - foreground;
   - `FlashWindowEx(FLASHW_STOP)`.

| Run | Case, watchdog | Result | Foreground | On screen | Put back |
| --- | --- | --- | --- | --- | --- |
| 1 | Maximized, fill + Send; first version (`HWND_TOP` only, placement restored before the foreground) | **Sent**, completed ("OK"). The corner had not been raised (`WindowFromPoint` gave Notepad). Send showed 70 ms after the fill, while the fill's grab had raised the corner | Fill: 47 ms. Send: **never undone**, 130 of 131 `SetForegroundWindow` calls returned false | Claude's corner (about 17×12 px with its shadow) from 314 to 564 ms. **Restoring `SW_SHOWMAXIMIZED` while Claude held the foreground put it over Notepad**, seen at the screen's centre from 0.94 s to the end of the run and after | Placement and rect exact; z-order not (Claude above Notepad) |
| 2 | Maximized, fill + Send; raised right after the move, corner not kept | **Not sent.** Send never showed in 15 s, and the text did not stay in the composer | Fill: 47 ms | **The maximized-to-normal animation was shown**: the whole Claude window slid to the corner, 90 to 330 ms, up to 270k px. The give-back at 375 ms raised Notepad over the corner, so Claude was fully covered again while the steps waited for Send. Claude's taskbar button was left red (attention) | Exact |
| 3 | Maximized, fill + Send; the tool as described | **Sent**, completed. Send showed 74 ms after the fill | 31 ms (fill), 46 ms (Send, by a short-lived claude.exe window; the plain give-back failed, `SwitchToThisWindow` worked). Corner re-raised 3 times | The corner, 40 px inside a 5×9 box, from 0.49 to 1.38 s. Notepad's title bar inactive while Claude held the foreground. The taskbar (the baseline already had the red button from run 2) | Exact |
| 4 | Maximized, menu; watchdog on | Model menu opened (seen 101 ms after `Expand`). **Effort's `Expand` did not open the submenu** in 6 s. The model menu was still open after the window was put back | 47 ms (menu), 138 ms (Effort) | Corner, title bar, taskbar | Exact |
| 5 | Maximized, close that menu: Effort → High (the current one); watchdog paused during the steps | Submenu in 90 ms; menus closed 73 ms after the pick; still "Opus 5.5 High" | Claude held it 0.65 s | Up to 349 px; back to the baseline when the run ended | Exact |
| 6 | Maximized, menu; **watchdog paused during the steps**, foreground given back after them | **Every step worked**: "Opus 5.5 Medium", then "Opus 5.5 High"; each menu seen in 63 to 89 ms, each pick closed the menus in 75 to 78 ms | Claude held it from 0.77 to 2.41 s (**1.64 s**); given back in one try | Up to 350 px, 0.49 to 2.65 s: the corner, Notepad's title bar inactive, the taskbar's active-app marks | Exact |
| 7 | Normal window, fill + Send; watchdog on | **Sent**, completed. Send showed 82 ms after the fill | 46 ms, 63 ms; corner re-raised twice | Up to 3.5k px: corner, title bar, then Claude's and Notepad's taskbar buttons until about 3.3 s (gone a little later) | Exact |
| 8 | Normal window, menu; watchdog on | **The model menu was never seen open** in 6 s; it was closed afterwards | 63 ms | Corner, title bar, taskbar until 9.3 s (2.3 s after the restore) | Exact |
| 9 | Normal window, menu; watchdog paused during the steps | **Every step worked**: Medium, then High; each menu seen in 80 to 98 ms | Claude held it from 0.76 to 2.54 s (**1.78 s**) | Up to 226 px, 0.47 to 2.83 s. `HWND_TOP` alone raised the corner this time | Exact |

"Exact" means all of these matched before and after:
- `GetWindowPlacement` (flags, showCmd, rcNormalPosition, every point);
- the window rect;
- the window right above;
- the visible window above;
- the whole visible z-order;
- the foreground.

Claude never showed at the screen's centre after run 1. Turning Claude normal for runs 7 to 9, and maximized again after them, used the same `SetWindowPlacement` with transitions off. Neither activated it or showed it.

Step times (from runs 3 and 6 to 9):

| Step | Time |
| --- | --- |
| Record | 9 to 14 ms |
| Maximized to normal | 5 to 12 ms |
| Move | 1 to 2 ms |
| The wait for the animation | 400 ms |
| Raise | 2 to 4 ms |
| Fill (`SetValue` plus a page read before and after) | 234 to 297 ms, then Send in 74 to 82 ms |
| Send | 240 to 245 ms |
| Each menu step | 160 to 250 ms, then 63 to 98 ms until the menus show the change |
| Restore (z-order, placement, z-order) | 3 to 40 ms |
| Park to restored | 1.4 s for fill + Send; 2.5 s for the menu change |

What this shows:
- **Leaving a few pixels uncovered keeps Claude's page live**: Send shows within 82 ms of the fill, and the message is sent. When the corner was covered (run 2), Send did not show, as behind Notepad in the watchdog round.
- The corner has to be kept up:
  - every give-back raises the other window over it;
  - `HWND_TOP` from the background does not reliably raise it;
  - raising it before DWM's animation is over shows the whole window.
- **Fill + Send works with the watchdog on**: two grabs of 31 to 63 ms, each undone. That is about two frames each, seen as Notepad's title bar and the taskbar changing, not as Claude.
- **The menus do not**:
  - When the foreground is given back, Claude's menus stop responding to `Expand`. Maximized, the Effort submenu did not open; normal, even the model menu was not seen.
  - With the watchdog paused during the steps, every step works. Claude then holds the keyboard focus for 1.6 to 1.8 s, with nothing of it on screen but the corner. Notepad's title bar shows inactive and the taskbar shows Claude active.
  - Unlike the watchdog round, the give-back after the menus succeeded at the first try.
- **Restoring a maximized window activates nothing when Claude does not hold the foreground** (runs 3 to 9). It puts Claude on top when Claude does (run 1). So the foreground must be given back first.
- Left unmeasured or unclear:
  - Whether the person sees the corner (40 px at the screen's top-left) and the title bar, which nobody watched in these runs.
  - What changed the taskbar for about 2 s after each restore (perhaps the reply finishing, or the taskbar's own animation).
  - Why the second fill's text vanished in run 2.
- **Claude saves the off-screen place** (measured after a restart of Claude by the person, with a watcher reading `window-state.json` in `%LOCALAPPDATA%\Claude-Data\claude_<id>` every 50 ms):
  - The file is written about **3.3 s after the window's state settles**, not when Claude quits. The quit left it untouched.
  - The coordinates are logical (125 %): `x`, `y`, `width`, `height` of the normal bounds, plus `isMaximized`.
  - Parked for 0.8 s, it was not written. Parked for 20 s, it was written 3.4 s after the move with `x:-2046, y:-1109, isMaximized:false`.
  - After the window was put back maximized, it was written again with `isMaximized:true` but **the same off-screen x and y**: a maximize does not save the normal bounds.
  - So after that run, the next start would open maximized, and un-maximizing would put the window off screen.
  - Repaired by showing it normal at its own `rcNormalPosition` for 5 s, which saved `x:365, y:146` (`SW_SHOWNOACTIVATE`), then maximized again.
  - So the port must:
    - keep a park under about 3 s;
    - or after any longer park, show the window normal at its original bounds for more than 3.3 s before maximizing it, with the window behind the other app;
    - or accept this risk.
  - In the earlier runs, the parks of 7 s and 15 s (runs 2 and 4) will have written off-screen bounds too. The normal-window runs and the final maximize happened to overwrite them; the file read `x:365, y:146` before the restart.
  - The previous version of this note said the file had been written hours before the runs. That was wrong: its time, 07:27, is at UTC−5, so during the runs.
- **The restart itself:** Claude came back maximized. Its `rcNormalPosition` grew by 7 px each way (448,183,2151,1358 → 448,183,2158,1365), a rounding of the logical bounds it saves.
- **A page that has not been built does not build while parked.** After the restart, with Claude behind Notepad, its tree was the cold shell of 24 nodes. Parked with the corner up for 20 s (777 reads), it stayed at 24 nodes. Parking keeps a built page live; it does not wake a cold one.
- **Computer use reshapes Claude's window.** The first computer-use call of a turn turned Claude from maximized into a 669×909 topmost window at the screen's top right, and rewrote its `rcNormalPosition`. When the turn ended Claude was maximized again, but `rcNormalPosition` had moved by 1 to 4 px (448,182,2149,1354 → 448,183,2151,1358). It also cannot act on Claude's window. So computer use cannot be used while Claude's window is measured, nor before a placement is compared.

- **Limit: the console cannot put the app on another desktop itself.** `IVirtualDesktopManager::MoveWindowToDesktop` moves only the calling process's own windows. So moving Claude (or Codex) to another desktop is the person's step; the console can only detect where the window is (`IsWindowOnCurrentVirtualDesktop`, `DWMWA_CLOAKED`) and say what to do.

What follows for the port:
- **Opening any of these menus takes the foreground**, under the conditions Frontdesk runs in, for both apps. So by the rule "never take the foreground", a model, effort or permission change through a menu is not made on Windows: nothing is sent, and the page says why.
- **Sending through Claude's window takes the foreground too**: filling its composer does (see "Fill and Send from behind"). Under the rule, Claude cannot send on Windows through its window. Whether the rule bends for this, or another channel is found, is the person's decision.
- **Parked in a corner** (above), Claude can be sent to with fill + Send from behind another app, with two grabs of under 65 ms each, undone. Nothing of Claude shows but a 5×9 px corner; Notepad's title bar and the taskbar flicker. The window is put back exactly. Its menus work only if Claude keeps the foreground for the 1.6 to 1.8 s they take. Whether either is acceptable under "never take the foreground" is the person's decision.
- **Codex's settings** keep route B (branch `codex-ipc-settings`) as the only way that does not take the foreground. Whether to bring it back is for the person to decide.
- After the tests, the Codex test chat's effort was put back to medium over route B, and its record says medium. Codex's model button still read "GPT-6 Sol Light", but the window was then showing a chat titled like the test chat, so which chat that button belonged to is not known.

Still open from step 1:
- **The page links only Unix-shaped local paths** (`LOCAL_ROOT` in `src/client/js/renderers.ts`), so `C:\…` in a reply is not a file link yet.
- **Codex's new-chat options** (`/api/new-options/codex`) answer 409 until the window helper exists.

**Step 3, Claude through its window on Windows.** Status: ported, tried on the real app in a test session.
- `src/server/native/uia-driver.cs` parks the window for every acting command (see "Parked in a corner" below). The window is parked from normal, maximized or minimized, and put back exactly (placement, z-order under the same window, foreground, taskbar flash), also when the command fails or crashes. A maximized window is only moved, never un-maximized (second round, below); saved bounds that a long park of a minimized window left off screen are repaired.
- It is not parked when Claude's own window is the foreground window: the person is in it, and the command acts in place, as on the Mac.
- The menus answer only while Claude holds the foreground. So a model, effort, mode or new-session menu change holds it for the change (about 0.5 s measured), with the window still off screen.
- A question card's option and Submit, and a wrap-up card's own buttons, take a press only while Claude's window is active: the window is activated (still off screen) and the foreground held for those presses, about half a second. No key is sent (second round, below).
- `src/server/native/claude-desktop.cs` ports every Claude command:
  - `send` (and steer);
  - `settings`;
  - `new`, `new-controls`, `new-pick`, `new-leave`;
  - `send-now`, `stop`, `answer`, `card`, `action`.
- The shared driver ports:
  - the Claude/Code mode switch;
  - `read-chat`, `chat-status`, `chat-new`, `chat-send`, `chat-stop`;
  - `open-file`, `show-session`.
- `check` says which commands are ported. The console counts an engine as able to send on Windows once `send` is among them.
- Windows differences found while porting:
  - every box reports the ARIA role "group";
  - a question card's options are buttons with `aria-pressed`, not checkboxes;
  - the session rows and the mode radios offer `Invoke`.
- Tried in the test session ("测试"), with the window parked from maximized and from minimized; each time it was put back:
  - send;
  - send refused as busy while a turn ran;
  - steer, then send-now (the reply followed the steer);
  - stop;
  - Effort to Medium and back;
  - answer a question card (the record has the answer);
  - read a wrap-up card;
  - new-controls with the Folder menu's options, new-pick, new-leave;
  - new (a session was created in `D:\af`);
  - the mode switch to Claude and back;
  - chat-status.
- Not tried on the real app:
  - `read-chat`, `chat-new`, `chat-send`, `chat-stop` on a real chat (no Claude-mode chat is cached on this machine, and making one would add a chat to the person's account). Paging a long chat uses `ScrollIntoView` instead of the Mac's arrow keys;
  - ~~`action` (pressing a card's own button)~~ tried in the second round (below);
  - `open-file`.
- ~~Open: the profile's `transcript` drifts on Windows~~ Fixed in the second round (below).

**Step 3, second round: fewer grabs, no keys** (2026-11-18, the test session "测试", Claude maximized behind a small window of the tester's own that held the foreground; every result checked in the record).

What was measured, and what the driver now does:

| Question | Measured | Now |
| --- | --- | --- |
| Does `LockSetForegroundWindow` (taken while attached to the foreground thread) stop the page's grabs? | Granted (`true`), but fill + Send still grabbed 4 times (up to 41 ms); the unlock was then refused (error 5) | Not used |
| Can the corner sit under the taskbar, so nothing shows? | No: Chromium counts the taskbar as covering. The session row needed a second press, Send took 4 s to show, the park ran 12 s | The corner stays in the work area |
| Can a maximized window be parked without un-maximizing it? | Yes. `SetWindowPos` moves it while it stays maximized: Send showed at once, the rect came back exact, and a 7.3 s park wrote nothing to `window-state.json` | Maximized windows are only moved. Their normal bounds never change, so nothing needs repairing |
| The old way (shown normal at the maximized rect) | Left Claude's `rcNormalPosition` and saved normal bounds equal to the maximized rect (`x:0, y:0, 2054×1105`, where they were `448,183,2158,1365` / `x:365, y:146`) | Gone. The saved-bounds repair is kept for minimized windows only, and no longer waits 4 s after every long park |
| A multi-line message | Recorded exactly, blank lines included | (no change) |
| A question card's option, pressed from behind | Not picked. Space and Enter through `SendInput` (also with the scan code) were not taken either. A Unicode `VK_PACKET` key does reach the page, so input is not blocked | See next row |
| The same with Claude's window activated first (foreground held, the window still off screen) | One press picks the option, one press of Submit is taken. Held 475 ms, park 0.7 s | `Activate()` + hold for the card's presses. **No key is sent anywhere any more**: `SendInput` is gone from the driver |
| A wrap-up card's own button (`action`) | Taken the same way (held 418 ms); the record has the reply the button sent | Same `Activate()` + hold |
| Effort through the menus | Hold 460 to 476 ms, nearly all of it the menus opening and closing (each read of ~500 nodes is 40 to 70 ms) | The hold now ends as soon as the menus close, not at the end of the settings step |
| A steer into a turn with no tool steps | The desktop kept it in its own queue ("Send now" shown) and wrote `enqueue` to the record only 30 s later, so the console's 12 s wait called it lost | The helper answers `queued` when "Send now" shows; the console then takes the steer |
| The Folder menu of the new-session page | "Open folder…" was listed as an option: UIA reports a toggle state (2) for every menu row | A row counts as a choice only if the page gives it a checked state (ARIA `checked`/`pressed`, or a checkbox or radio) |
| Claude's "Switch model?" question (a model change in a session with history) | Not seen: Chromium reports it as ControlType Window, ARIA role `alert`, `IsDialog` true, not `alertdialog`. The model was not switched, and the question stayed up and hid the menus from the next message | `Dialog()` takes either. A question left over is answered with Cancel before anything is picked. Through the console: Haiku 5.5 → Opus 5.5 confirmed and sent (park 1.9 s) |
| `transcript` (the chat list) | An ARIA `feed` on Windows | A Windows locator: `aria: "feed"` first (a new locator field, Windows only), the English name after it. `probe`: no drift, no differ |

Also fixed: every console process the server starts (the helper about every 10 s for `warm`, the Claude CLI, codex app-server, Antigravity's CLI) now starts with `windowsHide`. Without it, a server not running in a console window would flash a console window, which takes the foreground, on each start.

End to end through the console's API (server on port 4111, the page's own routes): a send with Effort changed (one 1.14 s park, completed), stop (`interrupted`, confirmed), steer then Send now (steered and delivered), all with the person's window keeping the foreground.

Not tried in this round: `new` (it adds a session; `new-controls` was tried), `open-file`, the Claude-mode chat commands, a minimized window.

Changed after the round, from reading the code:

- **Whose foreground it is.** The watchdog gave the foreground back to the window that held it when the park began, and the put-back forced it there at the end. So a person who moved to another window during a park was moved back. Now the watchdog follows the person: any visible window that is not Claude's and not one the shell holds on the way to another (taskbar, Alt+Tab, Task View) becomes the window given back to. The put-back only takes the foreground back from Claude (or from no window), never from a window the person went to. The park report counts these moves as `followed`.
- **Which corner.** The corner was looked for on the primary monitor first, so Claude on a second monitor was moved to the primary one, and at another scale it would get a DPI change (layout, and maybe a resize, twice). Now it is looked for on Claude's own monitor first (for a minimized window, the one it comes back on), then on the monitors at the same scale, primary first, then the rest.
- Checked by the helper alone: on this one-monitor machine the park is unchanged (corner at 2,2, foreground back, placement exact, `followed: 0`). A test window of the tester's own could not take the foreground on cue, so the move mid-park was tried by hand.
- Checked by hand through the console (server on 4111, rebuilt): a send to "测试" with Haiku 5.5 (the "Switch model?" question confirmed) and Effort Extra, and the person clicked another window right after Send in the console. The trace has `followed the person to 0x50962` at 388 ms, just after the park began. The model and effort changes held the foreground as before and still worked, the message was sent, and the park ended after 5.25 s with the window the person clicked still in front. Two other sends in the same run, with no move, parked 2.0 s and 7.7 s; in the 7.7 s one Send showed only 4.4 s after the park began (not looked into).
- Not checked: more than one monitor (this machine has one), and a person moving to Claude itself mid-park (Alt+Tab or its taskbar button: the watchdog still takes that back, since it cannot tell that move from the page's own grabs).

**Step 3, third round: the input method, and live before the first press** (2026-11-18; the console in Chrome with a Chinese input method in front, Claude minimized).

The report: typing Chinese in the console while it sends drops what is being composed. A watch of the foreground and the input method every 10 ms (`GetForegroundWindow`, the focused window's IME open state and conversion mode, the keyboard layout) during one send, with the person typing on:

| What | Measured |
| --- | --- |
| Grabs during one send | 14 in about 12 s, each 17 to 38 ms, all given back to the same Chrome window |
| The input method after each grab | Unchanged: open, Chinese mode, the same layout. So nothing is broken by the give-back itself (`AttachThreadInput` included) |
| Why it fails | Chrome loses the foreground at each grab, and ends the word being composed. About one grab a second is enough to make typing impossible |
| Who grabs | The page itself (`Chrome_RenderWidgetHostHWND`), at each action: `Invoke`, `SetValue`. Reading the page never grabs |

Why 14: a helper run of `settings 测试` with each grab traced (no message sent, the window parked, Chrome in front):

| Wait after the corner went up, before the first press | Presses | Grabs | Command |
| --- | --- | --- | --- |
| 0 (as built; two runs) | 3 | 3 | 4.0 s: the row's first press was lost, the retry 2 s later was taken |
| 0.4 s (two runs) | 4 | 4 | 5.2 s: the press on the way back was lost too |
| 1 s | 2 | 2 | 3.1 s: every press taken at once |

**Live before the first press.** A page just back on screen in its corner takes reads at once but loses presses for most of a second. Only a window minimized before the park was measured. What changed (uia-driver.cs, BeforeAct; ReturnTo):

- **Live before the first action.** First built as a fixed wait: the first action of a park waited until `windows.settleMs` (then 1000 ms) had passed since the corner went up. It was replaced by a nudge and a check, below. A row press not shown after 1.2 s, rather than 2 s, is pressed again.
- **The person's word first.** The page tells the server while the person composes with an input method (`compositionstart` to `compositionend`, renewed every 0.6 s; `POST /api/typing`, from this machine only). The server writes the time until which they are into `person-typing` next to the helper. Each action waits for it: at most 3 s for one action, 10 s for a command. The park report counts `settledMs` and `personMs`.
- **No going back while parked.** A command that parked the window leaves the desktop on the conversation it acted on, instead of pressing the one it started on again. That press cost a grab and, when lost, 2 s. The next command for the same conversation then presses nothing to show it. The new-chat page is never left on.
- **Answered before the saved bounds.** The helper writes its answer before it finishes a minimized window's saved bounds (FinishPark). The console reads an answer with a park report as soon as it is written.

Checked with the rebuilt helper (`settings 测试`, a `person-typing` mark 2.5 s ahead):
- **First run:** waited 880 ms for the page, then 1165 ms for the person. One press, taken at once. Left on 测试. 1 grab, 2.8 s.
- **Second run:** already shown. 0 presses, 0 grabs, 0.37 s.

Through the console, the person typing on without a pause after Send:
- **Both sends failed** with `fill_failed`. The wait for the person (3 s) came out of the fill's own 4 s, and the fill had no time left.
- **The fix:** every deadline outside the window section now runs on `ActClock`, the time since the command began less what BeforeAct waited.

A send after that fix, the person typing on, went out in 10.3 s. Two things were still slow:
- The first row press, 2.9 s after the park began, was lost.
- After Send, the composer was not seen to clear for the full 3 s.

**The page is stopped while Chromium counts it covered.** Claude was maximized behind Chrome, and its page was watched every 30 ms after the park. Two signals were watched:
- the documents' `IsOffscreen` and bounds: never changed;
- the app window's child windows: the `Chrome_RenderWidgetHostHWND` child, absent while the page is stopped, and visible once it is shown again.

| After the corner was raised | The page shown again | A press |
| --- | --- | --- |
| Nothing more (5 runs) | at 1.3 s, 2.1 s, 2.4 s, or not within 4 s | before it: lost; after it: taken |
| `HWND_TOPMOST` and back again | 0.85 s | |
| `ShowWindow(SW_SHOWNA)` | 0.3 to 0.6 s | |
| **Moved a pixel and back** (`SetWindowPos`, no z-order, no activation) | **0.1 s** | |

So Chromium recounts on a move, not on a z-order change made by another process. The same holds after every give-back:
- the person's window comes over the corner, and the page is stopped;
- the watchdog raises the corner again, and the page stays stopped.

That stopped page was why the composer did not seem to clear: its tree does not change while it is stopped.

What changed:
- `RaiseCorner` nudges, both when the park begins and at each re-raise by the watchdog.
- BeforeAct no longer waits a fixed second. Right before each action it checks `PageLive()`. If the page is stopped, it nudges again and waits for it, at most `windows.settleMs` (now 2500 by default), then acts anyway. The park report counts those as `notLive`.

Checked, Claude maximized behind another app:

| Run | Before | After |
| --- | --- | --- |
| `settings` to another conversation (4 runs, alternating) | 3 presses, 3 grabs, 4.0 s | 1 press, 1 grab, about 0.7 s, every time |
| A real send ("回复一个ok" to 测试) | 14 grabs, about 12 s, through the console | 3 grabs (row, fill, Send), 1.26 s. The composer cleared 0.22 s after Send |

Then through the console, the person typing on:
- **A plain send:** 2.9 s. It waited 0.65 s and 0.84 s for the person, then sent.
- **A send with a model and effort change failed** with `no_model_menu`. The model was picked and "Switch model?" confirmed. Then the effort menu's `Expand` failed twice with `UIA_E_ELEMENTNOTAVAILABLE` (0x80040201).
- **Not reproduced without typing:** the same change made by the helper alone (Sonnet 5.5 Low, then Medium, with "Switch model?") worked every time, in 1.0 to 1.8 s.
- **The likely cause:** while a menu holds the foreground, the person's keys go to the app's page. A page redrawn under them has a new menu button, so the one just found is gone.

What changed:
- The page now reports keys too (`keys`, lasting until a 0.8 s pause in typing), not only a word being composed. A hold waits for it before it starts, as every action does.
- A menu button gone when pressed is found again and pressed at once (twice at most), instead of 1.2 s later.

**Main's address for Claude's sessions (merged after this round).** Main told a Claude session apart from another of the same title by its page's address (`sessionAddress` `/epitaxy/{localId}`, `sessionRowsBy` `title`: each row with the title pressed until the address is the session's; folded rows unfolded; the deep link only for `open-file` / `show-session`; back and Stop by address). Merged as it was, the Windows driver read `sessionAddress` as Antigravity's (rows that are links to the address), found no such row among Claude's plain buttons and showed nothing: every Claude command for a session not already on screen would have failed `not_found`. Ported (`TitledRows`, `ShownAddress`, `IsShown`, `MayFront`, `ShowAt`; `claude-desktop.cs` goes back and watches Stop by address, through ReturnTo). A row press lost on a page not yet taking presses (nothing changed at all) presses that row once more before the next. Tried: the Windows page's document carries the address; `settings` to 测试 and back, by local id: row 1 each time, 1 grab, 0.7 to 0.8 s. Not tried: two sessions of one title, folded rows.

**A game in front.** Each grab takes the foreground from whatever the person is in, a full-screen game too.
- **Borderless full screen, or a window that leaves the taskbar in view:** a moment's stutter. The command goes ahead.
- **Exclusive full screen:** switched away from, as by Alt+Tab. It goes black, changes mode, and is often minimized. `SetForegroundWindow` does not restore a minimized window.
- **What changed:** Park asks `SHQueryUserNotificationState`. At `QUNS_RUNNING_D3D_FULL_SCREEN` (3) it does nothing and answers `fullscreen`.
- **The Claude bridge** shows the message as waiting and tries again every 3 s. It sends once the game is gone. Stop takes the message back meanwhile. A steer at that moment goes to the console's queue.
- **A chat mode's follower** just looks again later.
- **A command already parked when the person goes into a game** finishes: a second or two.
- Not tried with a real game. On this machine the call answers 5 (`QUNS_ACCEPTS_NOTIFICATIONS`) with nothing full screen.

Not checked yet: Codex and Antigravity (same driver, same Chromium window), and more than one monitor.

**Step 2, the C# driver's skeleton.** Status: read-only part done.
- `src/server/native/uia-driver.cs` is the twin of `ax-driver.swift`. It provides `check`, `probe`, `inspect` and `warm [check]`; any other command answers `not_ported`. It holds the three checks every flow gets: Sole, Confirmed (menuSigns) and `via`.
- Each profile has a `windows` section: the app's exe, plus locators the Windows app draws elsewhere (`chromeBar`, and `spaceSwitch` inside it).
- `desktop-automation.ts` compiles the driver with Windows' own `csc.exe` into `%LOCALAPPDATA%\agent-frontdesk`, per source hash.
- Verified on both apps:
  - `check` reports running, with the same integrity level as the console.
  - `probe` finds no drift. Claude's `newChat` is now found by its declared keys, read as Control.
  - `warm check` reads about 700 elements.
- Sending is still reported as not available on Windows.

## Findings so far (Windows 11 26200, Claude 5.11492, Codex 26.1111)

From step 1 (read) and read-only `act --do inspect` checks. Nothing was pressed.

**Locators and roles**

- **DOM classes:** `ClassName` carries the page's DOM classes on 363 of 476 web nodes. 7 of the Claude profile's 9 class tokens are found. The two missing ones, `group/menu-popup` and `text-on-primary`, belong to menus and dialogs and exist only while one is open. So the profiles can be shared (open question 1: yes).
- **haspopup:** `AriaProperties` carries haspopup (19 nodes), so popup buttons map as on the Mac. `modelMenu` is found by its first way.
- **Meta is written Control.** `newChat` is found by its mark only once `Meta+n` is read as `Control+n`. Claude's radio button in the Claude/Code switch carries `Control+Alt+ArrowLeft`. This becomes a rule in the Windows driver, not a profile edit (open question 2: yes, with Control for Meta).
- **spaceSwitch:** on Windows the Claude/Code switch (a `radiogroup`) is in `dframe-chrome-bar`. That is a 36px draggable bar across the top of `dframe-root`, a sibling of `dframe-sidebar`. It is not inside the sidebar, `epitaxy-titlebar` or the chat pane. So the profile needs a `windows` override with a `chromeBar` locator (class `dframe-chrome-bar`) for `spaceSwitch` to be found by its mark. The role mapping (`AXRadioGroup` to `radiogroup`) is right.
- **Radio buttons:** the space radio buttons offer `Invoke` and `SelectionItem`, but not `Toggle` or `ExpandCollapse`. They carry `checked=true|false` in `AriaProperties`. Which pattern replaces `AXPress` for them has not been tried.
- **automationIds:** base-ui automationIds (`base-ui-_r_30_`) are generated, so they are not stable and cannot be used in locators.

**Reading the page**

- **Speed:** a read of about 480 nodes takes 60 ms, in one round trip (a cache request over the raw view).
- **Cold shell:** Claude's page showed 24 nodes at first contact, then 462 to 480 nodes on the next read, under a minute later. The full curve (`settle`) has not been measured.
- **Minimized Codex:** Codex's window was minimized throughout, and showed 9 nodes. This is a minimized measurement only: Codex has no census yet with its window restored.
- **Background reads:** reads work while Claude is in the background, with another app in the foreground.

**Outside accessibility**

- **Codex's router pipe** is `codex-ipc` (route B's `socketPath()` on Windows).
- **Deep links:** `codex://` is declared only in the MSIX manifest, not under `Software\Classes`. The read step now lists manifest protocols. The two AUMIDs:
  - `OpenAI.Codex_2p2nqsd0c76g0!App` (`app/ChatGPT.exe`, protocol `codex`);
  - `Claude_pzs8sxrjxfjjc!Claude` (`app\Claude.exe`, protocol `claude`, also registered under Classes).
- **Both apps are MSIX packages.** Their window exes are `ChatGPT.exe` and `claude.exe`, under `C:\Program Files\WindowsApps`. The shell and both apps run at the same integrity level, High (12288 = 0x3000; Medium is 8192). They do because UAC is off on this machine (`EnableLUA=0`, and this is the built-in Administrator account), so every process runs elevated. That is not the usual setup, where both the person's apps and the server run at Medium.

**Codex, with the window maximized (census and act, in the person's conversation, with their agreement)**

- **Census:** 367 nodes. `ClassName` is set on 319 of 364 web nodes, and 5 of the profile's 9 class tokens are found. The missing ones are `ClearableSelectorTrigger-*`, `ClearableSelectorTriggerClearButton-*`, `ViewToggle-*` and `comboboxList-*`, which live in menus and pickers. haspopup is set on 15 nodes. These locators are found by their first way: `chatComposer`, `composer`, `composerBody`, `composerMain`, `modeSwitch`, `modelMenu`, `newChat`, `permissionsMenu`, `projectChooser`, `sidebar` and `sidebarHeader`. `send` and `stop` were absent: no run was going on, and the composer was not empty enough to show Send. `acceleratorKey` was empty on every node outside menus.
- **fill:** refused, because the composer already held 12 characters of the person's own text. The probe writes only into an empty box. So `Value.SetValue` is still unmeasured.
- **menu (`modelMenu`):** the button offers `ExpandCollapse` and `LegacyIAccessible`, but not `Invoke`.
  - `ExpandCollapse.Expand` opens the menu (menu rows 4 to 7), **and brings Codex to the front**. This happened both times it was tried, with Claude in the foreground beforehand.
  - Neither `ExpandCollapse.Collapse` nor `LegacyIAccessible.DoDefaultAction` closes it again: the button stays `expanded=true`. Only the person's Esc closed it.
  - `DoDefaultAction` sent to the closed button, with Codex in the background, fails with `0x80040200` (UIA_E_ELEMENTNOTENABLED). Nothing opens and the foreground does not change.
- **submenu:**
  - The Power row (`effortRow`, class `SliderKeyboardControl-*`) is a `menuitem` with `Invoke` only. It has **no `RangeValue`**, and its acceleratorKey is `ArrowLeft ArrowRight`: it is moved by keys alone.
  - The Select model row has no `ExpandCollapse`, but **`Invoke` opens its model list** in place (the menu stays open, and the rows go from 7 to 4) without changing the foreground.
- **focus:** `SetFocus` on the composer brings Codex to the front, as agent-desktop found.
- **The foreground grab is not an artifact of the setup.** The first runs were started from inside the Claude app, which was in front, and it could have handed Codex the right to take the foreground. So the menu run was repeated with the probe started from a standalone PowerShell window (Win+R) and an unrelated app (Chrome) in front. The foreground still went from chrome.exe to ChatGPT.exe the moment `Expand` opened the menu.
  - The foreground lock is on, and stricter than the default (`SPI_GETFOREGROUNDLOCKTIMEOUT` is 2147483647 ms), so a loose setting did not let Codex in.
  - After that run the person said they had not seen Codex come forward: they found the menu open and closed it with a click into Codex. Being the foreground window and being drawn on top are not the same thing, so the act results now also record which top-level window covers the target's centre (`onTop`, from `WindowFromPoint`). On the next run, under the same conditions (standalone PowerShell, Chrome in front), `onTop` went from chrome.exe to ChatGPT.exe the moment `Expand` opened the menu. **So Codex really is raised over the other windows, not only activated.** Why the earlier run looked different is not known; it may have been timing.
  - Whatever grants the right, UI Automation's call into Chromium or the page's own focus code, it would grant it to a background Frontdesk server just the same.
  - Caveat: on this machine everything runs at High integrity with UAC off. The Medium case has not been seen.
- **Codex's app-server** (bundled with Codex 26.1111 as `app\resources\codex.exe` 0.169.0-alpha.11.1, read-only look). `generate-json-schema` leaves experimental methods out unless it is given `--experimental`, and the bridge connects with `capabilities: { experimentalApi: true }`. With `--experimental`, the schema has:
  - `thread/queue/add`, `delete`, `list`, `reorder`, `start` and `update`. So route A's queue exists on Windows.
  - `thread/settings/update` (`ThreadSettingsUpdateParams`: `model` and `effort` "for subsequent turns", plus `approvalPolicy`, `collaborationMode`, `permissions`, `sandboxPolicy`, `serviceTier` and others).
  - Without `--experimental`, the only places to set the model and effort are `thread/start`, `thread/resume` and `turn/start`. `thread/settings/updated` is the server's notification of the result.
- **Codex's model and effort need no menus: route B.** The Windows desktop bundle (`app.asar` in the OpenAI.Codex package) carries the same window-to-window router as the Mac.
  - On win32 its endpoint is the named pipe `\\.\pipe\codex-ipc` (`path.join("\\\\.\\pipe", "codex-ipc")`). Elsewhere it is `<codex home>/ipc/ipc.sock`. Messages are framed as a 4-byte little-endian length followed by UTF-8 JSON.
  - The bundle has 18 `thread-follower-*` requests: steer-turn, interrupt-turn, start-turn, the queue ones, and the two that matter here:
    - **`thread-follower-update-thread-settings`.** A window that does not own the thread sends `{conversationId, threadSettings, activeTurnId?, condition?}`, where `condition` is `{ifModelEquals?, ifEffortEquals?}`. The owner calls its own app-server `thread/settings/update {threadId, ...threadSettings}`, updates its own state so its composer shows the change, and answers `{applied}`.
    - **`thread-follower-read-model-settings`.** It returns `{model, reasoningEffort, …}` from the owner.
  - So changing a Codex chat's model or effort goes through route B, like steer and interrupt in `src/server/codex-desktop.ts`. It avoids the menus, the foreground and the Power slider, on both platforms. Only `socketPath()` changes, as planned.
  - Sending one changes a real chat, so it has not been sent here. It is to be tried in a test chat, with the person's agreement.
  - Codex's new chat (project picker, new-chat button) is still UI-only, so it still meets the menu findings above. The deep link below may avoid that.
- **Codex's new-chat deep link** (read in the Mac's app.asar, not yet tried on Windows): `codex://threads/new?path=<absolute folder>&prompt=<text>`, or `projectId=<id>` in place of `path`.
  - `path` must stat as an existing folder. It becomes the new chat's working folder or project. `prompt` is filled into the composer.
  - So a new Codex chat may need no project menu at all.
  - Codex counts only a link with no parameters, or with `prompt` alone, as safe. A link with `path` may therefore raise a confirmation dialog: to be measured.
  - Whether opening it brings Codex to the front is open question 8.
- **Hypothesis, not yet tested: the foreground right may come from the launcher.** Windows lets a process bring a window forward only if it holds the foreground right. Every run so far started the helper from a terminal the person had just used. The helper may have inherited the right from it, or passed it to the app through the UIA call.
  - This is not the "started from inside Claude" hypothesis ruled out above.
  - In real use, a background Node server starts the helper, which then may hold no such right. Codex would then only flash in the taskbar.
  - Tests:
    - wait 10 s before pressing, with the foreground moved to an unrelated window meanwhile;
    - in development step 3, the Node server itself starts the helper, which answers it directly.

**Against the Mac driver and agent-desktop**

The Mac driver posts keys to the app's pid with `CGEvent.postToPid`, which works in the background. The keys are:
- Escape: closes every Codex menu, and Claude's when off screen;
- Right: opens Claude's Effort and More models submenus;
- Left and Right: move Codex's Power slider;
- Down: opens a Claude menu off screen;
- Space: ticks a question-card option;
- Up ×4: pages back through a long chat.

Windows has no counterpart to `postToPid`. `PostMessage` keys do nothing in Chromium, and `SendInput` goes to the foreground. agent-desktop (vercel-labs, Rust on the `uiautomation` crate) keeps every key and SetFocus behind `--headed`. It has no headless way to close a Chromium web menu either: its probes close one with a `SendInput` Esc while the app is in front (`probes/windows/FINDINGS.md`, A26-12). It never measured Invoke or Expand taking the foreground on Chromium. So on Windows, route by route:

| Mac | Windows, as measured here | What the port does |
| --- | --- | --- |
| Press a button (`AXPress`) | `Invoke` where offered; untested for the foreground on plain buttons | Use `Invoke` first, then `LegacyIAccessible` (agent-desktop's chain) |
| Open a menu (press) | Codex: `Expand` works but takes the foreground; `DoDefaultAction` in the background fails | **Breaks the "never take the foreground" rule**: refuse, unless a way is found that keeps the foreground |
| Close a menu (Escape) | No UIA action closes Codex's menu | Close menus only by pressing a row, which closes them on the Mac too. Otherwise refuse |
| Claude submenu (focus + Right) | Codex's Select model row opens with `Invoke`; Claude's rows are untested | Use `Invoke` on the row |
| Codex Power slider (Left/Right) | No `RangeValue`, only `Invoke` | Not through the UI. Use route B instead: `thread-follower-update-thread-settings` over `\\.\pipe\codex-ipc` (see above). Codex's model choice goes the same way, so its menus are not needed for settings |
| Focus (`AXFocused`) | `SetFocus` takes the foreground | Do not use |
| Fill (`AXValue`) | Untested (the box held text) | `Value.SetValue`, to be measured in an empty composer |

**Still open**

- **Fill:** `Value.SetValue` on Codex's composer, in an empty test conversation.
- **Opening a Codex menu without the foreground:** no way has been found yet (the setup was ruled out, see above). It is open whether giving the foreground back right afterwards is acceptable, and whether a server at Medium integrity behaves differently.
- **Closing a menu by pressing its current row:** whether pressing the already chosen row closes a menu with no change.
- **Settle curves (question 6):** for both apps. Claude's must be run from a standalone PowerShell window, since quitting Claude ends a session that runs inside it.
- **Off-screen states (question 6):** minimized, covered and other virtual desktop, and whether `ScrollIntoView` refreshes the page.
- **The act scenarios (questions 3, 4, 5):** Claude's scenarios (fill, menu, submenu, focus) and refresh, for both apps. Codex's menu, submenu and focus results are above. Run them in a test conversation, and only with the person's agreement. Also which of `Invoke` / `SelectionItem.Select` switches the space.
- **Deep link and foreground (question 8):** whether a deep link brings the app to the front.
- **Integrity levels (UIPI):** when the Frontdesk server runs at a lower level than an app (Medium against High, say), UIPI lets it read the app's UIA tree but not act on it. The port's `check()` should therefore compare the helper's integrity level with the target window's, and say so when they differ, in place of the Mac's `AXIsProcessTrusted` message. Act results from this machine show the same-level case only (High to High). The Medium-against-High case has not been measured.

## What has to be ported

Reading history and drawing the page are plain files and the shared kit, so they mostly carry over. Paths need work, see the last section. Sending is decided per action across three routes (`channels.md`):

- **A, the app's own interface:** Codex's `thread/queue/add` plus a `codex://threads/wake/<id>` link, and Antigravity's language server. These are cross-platform apart from how the link is opened.
- **B, Codex's window-to-window router:** `~/.codex/ipc/ipc.sock` on the Mac. On Windows it must be a named pipe, because Node and Electron cannot listen on a socket path there. `src/server/codex-desktop.ts` needs only a new `socketPath()`, since `net.createConnection` takes pipe names.
- **C, the accessibility driver:** everything Claude does, and Codex's new chat and settings. This is the real port.

Route C on the Mac is three files plus a TypeScript wrapper:

- `src/server/native/ax-driver.swift` holds the shared actions and three self-checks:
  - one control, or none, before anything is done to it;
  - a menu button found by its place has to prove itself (`menuSigns`);
  - every answer says which way found each control (`via`).
- `claude-desktop.swift` and `codex-desktop.swift` hold each app's steps.
- `profiles/<id>.json` says how each control is told apart.
- `src/server/core/desktop-automation.ts` compiles them with `swiftc`, caches the result by source hash, runs one command at a time and reads back one JSON object.

The native record, not the helper, decides whether a message went out.

**Plan: keep this shape on Windows.** Write the same driver, flows and output in C#, with the same three self-checks. Read the same profiles through a role-mapping table (`AXButton` becomes `Button`, and so on), with a `windows` override section only where the apps differ.

The helper should be compiled on the person's machine with the `csc.exe` that ships with .NET Framework 4.x (C# 5). That is the Windows twin of `swiftc`: nothing is downloaded, and no binary has to be signed or get past SmartScreen. UIA would be reached through hand-declared COM interfaces, the stack vercel-labs/agent-desktop uses and measured. The alternative is a Rust helper on the `uiautomation` crate, built in CI and shipped. It is more proven, but it brings binary distribution.

## Mac to Windows

| Mac (route C) | Windows | Status |
| --- | --- | --- |
| `AXUIElementCreateApplication(pid)`, `AXMainWindow` | The app's top-level `Chrome_WidgetWin_1` window, then `ElementFromHandle` | Straightforward |
| `AXManualAccessibility` / `AXEnhancedUserInterface` | Nothing to switch on: Chromium builds the tree once a UIA client asks. It starts as a shell of a dozen nodes and can take 10 to 25 s cold (agent-desktop's findings) | **Measure** (`settle`) |
| `AXUIElementCopyMultipleAttributeValues` | One cache request over the raw view | Straightforward |
| Role / subrole | `ControlType` plus `AriaRole` | The mapping is a guess the probe checks |
| `AXDOMClassList`, which most locators use | `ClassName`? Chromium raises a ClassName change event when the class changes, but agent-desktop found no class tokens | **Open, and decisive**: without it, locators fall back to names and break in other languages |
| `AXKeyShortcutsValue` | `AcceleratorKey`? And is `Meta+n` written `Control+n`? | **Measure** |
| `AXDOMIdentifier` | `AutomationId` | Probably |
| `AXURL` of the page | The Document's Value | Probably |
| `AXPress` | `Invoke` / `ExpandCollapse` / `LegacyIAccessible.DoDefaultAction` | **Measure** (`act menu`) |
| `AXValue` set on the composer, with `AXSelectedText` as fallback | `Value.SetValue` only, because UIA cannot write selected text | **Measure** (`act fill`) |
| `AXFocused` | `SetFocus` takes the foreground (agent-desktop) | **Do not use**; `act focus` confirms it for Chromium |
| `CGEvent.postToPid` keys: submenus, Codex's Power slider, Escape | **No counterpart**: `PostMessage` keys do nothing in Chromium, and `SendInput` needs the foreground | **Hardest part**: replace with `ExpandCollapse`, `RangeValue` or `Collapse` (`act submenu`). Where none works, do not send and say why |
| `AXScrollToVisible` to refresh an off-screen page | `ScrollItem.ScrollIntoView` | **Measure** (`act refresh`) |
| `CGWindowListCopyWindowInfo` (on screen?) | `IsIconic`, `DWMWA_CLOAKED`, `IVirtualDesktopManager` | Straightforward; whether the tree stays live in those states is **measured** |
| `AXIsProcessTrusted` | No permission; check that the integrity levels match (UIPI) | The message to the person changes |
| `open -g <link>` (does not activate the app) | `ShellExecute`; no "don't activate" flag | **Measure** (`link`) |

The rules do not change on Windows (`skills/add-desktop-engine/references/philosophy.md`):

- Never take the foreground and never send global input.
- Never fall back to a CLI process that runs the turn itself.
- When the desktop app cannot take an action, do not do it, and say why.

## Outside accessibility

- **Paths:**
  - Claude desktop's data is under `%APPDATA%\Claude`.
  - `~/.claude` and `~/.codex` live under `%USERPROFILE%`.
  - The helper cache goes to `%LOCALAPPDATA%\agent-frontdesk`.
  - `src/server/config.ts` (`findClaude`, the `app.asar` paths) and `src/server/claude-bridge.ts` hard-code `Library/Application Support`.
- **Apps:** the profiles' `bundleId` becomes an exe name or an AppUserModelID; the probe lists both, and whether each app is MSIX.
- **Antigravity:** `open -b` in `src/server/antigravity-bridge.ts` becomes starting its exe. `src/server/services/reveal.ts` already handles `win32`.
- **Platform gate:** `DesktopAutomation#check()` returns "only macOS" on any other platform. It becomes a choice between the Swift and C# helpers.
- **CI** runs on `macos-latest` only. A Windows job can compile the helper and run the unit tests, but it cannot reach the real apps.

## Open questions the probe answers

1. Does `ClassName` carry DOM classes, and how many of the profile's class tokens are found?
2. Is aria-keyshortcuts in `AcceleratorKey`, and in what spelling?
3. Do the menu buttons open with `Invoke` or `ExpandCollapse`, without taking the foreground?
4. Do Claude's Effort and More models submenus open without a key? Does Codex's Power row offer `RangeValue`?
5. Does `Value.SetValue` fill the composer so that Send appears?
6. How long does the page take to reach UIA? Does it stay live when the window is minimized, covered or on another virtual desktop? Does `ScrollIntoView` refresh it?
7. What are Codex's pipe name, the deep-link handlers, the data folders, and the exe and package names?
8. Does a deep link bring the app to the front?
