# Frontdesk on Windows

Frontdesk sends a message to Claude (and makes a new Codex chat, or changes the model of a Codex chat the app has not opened) by working the desktop app's own window: it fills in the composer and presses Send. On macOS this happens without the window ever taking the keyboard. On Windows it can't be done that way, and this page says what you will notice, what Frontdesk does about it, and where help would be welcome.

## Why Windows is different

Frontdesk reaches the window through UI Automation, the interface screen readers use. Claude and Codex are Chromium (Electron) apps, and Chromium on Windows moves the keyboard focus to its window whenever something is done in its page: a press, a value set, a menu opened. Reading the page does nothing of the kind; acting on it does, every time.

Two more things Chromium does on Windows shape the rest:

- A page whose window is fully covered is stopped: a press on it is lost, and what it shows does not change.
- A menu in the page answers only while the app holds the focus.

## What Frontdesk does about it

- **The window is parked.** For the second or so a command takes, the app's window is moved off screen except for a few pixels in a corner (so its page is not counted as covered). Each time the page takes the focus, it is given straight back to the window you were in, usually within 20–90 ms. Afterwards the window goes back exactly where it was, under the same window, maximized or minimized as before. If the server is stopped halfway, the next start puts it back.
- **Each step waits for the page.** Chromium does not notice by itself that a raised corner is uncovered. Frontdesk moves the window by a pixel and back, which makes it look again within about 0.1 s, and checks the page is shown before each press. Before this, a press was often lost and repeated two seconds later.
- **Each step waits for you.** While you type in Frontdesk's own page (a word in an input method, or keys), every step waits for a pause, at most 3 s per step and 10 s per message, so the message still goes out if you never stop.
- **As few steps as possible.** A message is three presses (open the conversation, fill in, Send), two when the conversation is already open. Frontdesk no longer switches the app back to the conversation you had open there when its window was behind yours; the app stays on the one it used last.
- **Exclusive full screen is left alone.** With a program in exclusive full screen in front, nothing is done: the message waits in Frontdesk, marked as waiting, and goes out a few seconds after you leave it. Stop takes it back meanwhile. A new chat waits the same way for up to two minutes; after that it is not made, and its message goes back into the composer to send again.
- **No key and no clipboard.** Frontdesk never sends a keystroke or a mouse event and never touches the clipboard. A test checks that only one part of the helper may move a window or hand the focus anywhere.

## Known issues

| What you notice | When | What helps |
| --- | --- | --- |
| A word you're composing with an input method is cut off, or a key is lost | You type in another app while a message goes out | Type in Frontdesk's page (it waits for you), or pause for a second after Send |
| What you type for about half a second goes to the app | A message changes the model, effort or permission mode: the app's menu needs the focus while it is open | Pick the settings before you start typing the next message |
| A short stutter | A borderless full-screen window is in front while a message goes out | Exclusive full screen avoids it: the message waits |
| The app shows a different conversation than before | Its window was behind yours or minimized when Frontdesk sent to another conversation | Intended: going back would cost another press |
| A message waits | An exclusive full-screen program is in front | Leave it, or press Stop to take the message back |
| A new chat is not made, and its message is back in the composer | An exclusive full-screen program stayed in front for two minutes | Leave it and send again |
| A few pixels of the app in a corner of the screen | While a command runs | They go away when it ends |
| You switch to the app yourself while Frontdesk works in it, and it is switched away again | You click its taskbar button or Alt+Tab during the second a command takes | Wait a moment and switch again |
| A command is refused | The app's window is closed to the tray, or runs as administrator while Frontdesk does not | Open its window (minimized is fine); run both with the same rights |

Codex's regular messages, steers, stops and most model changes go through its own channel and are not affected; a new Codex chat, and a model change for a chat Codex has not opened yet, go through its window as above. Antigravity's messages go through its local language server; only "Open in Antigravity" and opening a file from its chat use its window, and those bring it to the front anyway.

## What has been tried

- `LockSetForegroundWindow` while acting: the page still took the focus.
- Keys sent with `SendInput` to a page behind: not taken (and Frontdesk does not send keys any more).
- Hiding the corner under the taskbar: Chromium counts the taskbar as covering, and the page stops.
- Raising the corner by z-order alone: the page came back after 0.85 s to more than 4 s. A one-pixel move brings it back in 0.1 s.
- UI Automation's `SetFocus`: never used, since it is exactly what takes the focus.
- **A hidden desktop** (`CreateDesktop`, an app started on it): the most promising lead, not used by Frontdesk yet. Chrome and Edge on a test page, then a real Claude cold-started on that desktop, took a fill and Send through UI Automation with no foreground change at all on the person's desktop (sampled every 15 ms). Only a new chat was tried; an existing chat, the model menu and typing with an input method meanwhile were not. It needs the app started on that desktop, so the window the person uses is not that one. Probes: `probes/windows/tools/hidden-desktop-test.ps1`, `claude-hidden-test.ps1`.
- **A child session** (the "picture-in-picture" kind Power Automate uses): switched on for the test and off again after, but the RDP control's `Connect()` answered "invalid argument" on this machine. Probe: `probes/windows/tools/child-session-test.ps1`.

The measurements behind this page, run by run, are in [`probes/windows/PLAN.md`](../probes/windows/PLAN.md).

## Help wanted

If you know any of these, please open an issue or a pull request:

- A way to press a button or set a value in a Chromium/Electron page on Windows **without its window taking the focus**. This is the root of every item above.
- A way to tell **your own switch to the app** (taskbar, Alt+Tab) from the page taking the focus, so Frontdesk stops switching you back.
- A way to open and use a page's **menu without the focus**.
- Testing on a machine with **more than one monitor**, or with **UAC on** and Frontdesk running without administrator rights. The development machine has neither.
