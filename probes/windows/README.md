# Windows probe

Before the desktop driver is ported to Windows, this probe measures, on a real Windows machine with the Claude and Codex desktop apps, whether each thing the Mac driver relies on (`src/server/native/ax-driver.swift`) has a Windows counterpart. On Windows the driver would use UI Automation (UIA), reached through its COM interfaces the way Narrator reaches it, and would be compiled on the person's machine with the `csc.exe` every Windows 10/11 ships. That is the Windows twin of compiling with `swiftc` on a Mac. The probe is built and run the same way, so a probe that runs also shows that this setup works.

Two files:

- `uia-probe.cs` is the helper. Each command prints one JSON object.
- `probe.ps1` compiles the helper once per source version into `%LOCALAPPDATA%\agent-frontdesk\probe\`, runs the steps, writes everything to `probes\windows\out\<time>-<step>\` (not committed) and prints a summary (`summary.txt`). Where the checkout is so deep that those paths would pass 260 characters (which neither the helper nor Windows PowerShell can write unless long paths are switched on), it writes to `%LOCALAPPDATA%\agent-frontdesk\probe\out\<time>-<step>\` instead; the last line says which.

## What it answers

| The Mac driver relies on | What the probe checks on Windows | Step |
| --- | --- | --- |
| `AXDOMClassList`: most locators go by DOM classes (`dframe-sidebar`, `ProseMirror`, `ComposerLayoutBody-*`) | Does UIA `ClassName` carry the page's DOM classes? How many of the profile's class tokens are seen? | read |
| `AXKeyShortcutsValue` (aria-keyshortcuts: `Enter`, `Escape`, `Meta+n`, `ArrowLeft ArrowRight`) | Does `AcceleratorKey` carry it, and is `Meta` written as `Control` on Windows? | read |
| `AXDOMIdentifier` (Codex `app-shell-sidebar`) | Is it `AutomationId`? | read |
| Subroles (`AXDocumentArticle`, …) and `AXHasPopup` | `AriaRole`, and `haspopup` in `AriaProperties` | read |
| `AXURL` of the page (`https://claude.ai/epitaxy`) | The Document's Value (shown as origin plus first path segment only) | read |
| The profiles as a whole | The Mac `probe` on this page: per locator, how many each way finds, `differ` / `several` | read |
| `AXManualAccessibility` / `AXEnhancedUserInterface` to build the tree | Nothing to switch on: how long the tree takes to appear after the first UIA client asks | settle |
| `AXPress` | `Invoke`, or `ExpandCollapse` for buttons that open a menu, or `LegacyIAccessible.DoDefaultAction` | act menu |
| A submenu opened with `focus` + right arrow (Claude's Effort and More models) | Does `ExpandCollapse.Expand` (or a press) open it, with no key and no foreground? | act submenu |
| Codex's Power slider moved with arrow keys | Does the row offer `RangeValue`? | act submenu |
| Filling the composer with `AXValue`, or with `AXSelectedText` as a fallback | `Value.SetValue` on the composer (UIA cannot write selected text), and whether Send then appears | act fill |
| `AXFocused` | Does `SetFocus` bring the app to the front? (The Mac driver never takes the foreground.) | act focus |
| Off-screen refresh with `AXScrollToVisible` | Census with the window minimized, covered, or on another virtual desktop, before and after `ScrollItem.ScrollIntoView` | census, act refresh |
| `open -g <deep link>` (does not activate the app) | Does a deep link bring the app to the front? | link |
| `~/.codex/ipc/ipc.sock` | Named pipes that look like the apps' | read |
| Paths under `~/Library/...`, `bundleId` | Data folders, CLIs, MSIX packages, deep-link handlers, exe names and window titles | read |
| `AXIsProcessTrusted` | No permission needed. Is the shell's integrity level the same as the app's? (A lower one could read but not act.) | read |

## Running it

Run from the repository root in a normal (not administrator) PowerShell window. The apps should be signed in and open on a conversation.

1. Read-only, presses nothing:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File probes\windows\probe.ps1
   ```

2. How long the page takes to reach UIA. Quit the app first, start this, then start the app within two minutes:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File probes\windows\probe.ps1 -Step settle -Engine claude
   powershell -NoProfile -ExecutionPolicy Bypass -File probes\windows\probe.ps1 -Step settle -Engine codex
   ```

3. Off screen. Put the window in that state first, then run, once per state:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File probes\windows\probe.ps1 -Step census -Label minimized
   powershell -NoProfile -ExecutionPolicy Bypass -File probes\windows\probe.ps1 -Step act -Scenario refresh -Label covered
   ```

   The states to try are `minimized`, `covered` (another window over it) and `otherdesktop` (Win+Tab, moved to another desktop).

4. Pressing controls. Use a test conversation with an empty composer. Send is never pressed, and the composer is only written to when it is empty:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File probes\windows\probe.ps1 -Step act -Engine claude -Scenario fill
   powershell -NoProfile -ExecutionPolicy Bypass -File probes\windows\probe.ps1 -Step act -Engine claude -Scenario menu
   powershell -NoProfile -ExecutionPolicy Bypass -File probes\windows\probe.ps1 -Step act -Engine claude -Scenario submenu
   powershell -NoProfile -ExecutionPolicy Bypass -File probes\windows\probe.ps1 -Step act -Engine claude -Scenario focus
   ```

   Then run the same four with `-Engine codex`. `focus` may bring the app to the front, which is what it measures. The submenu scenario finds Claude's rows by their English names (`Effort`, `More models`), so run it with the app in English.

5. Deep link, optional. Use a link to a test chat:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File probes\windows\probe.ps1 -Step link -Link "claude://claude.ai/epitaxy/<localId>"
   ```

Options:

- `-Engine claude|codex` picks one app.
- `-Hwnd 0x…` with one `-Engine` is for when the probe picks the wrong window (step 1 lists them).
- `-Yes` skips the prompt.
- `-Names` adds the names of buttons, menu rows and headings to the census, for your own reading only.

## What to send back

Send the `summary.txt` of each run, and the `*-census.json` / `*-act-*.json` files if the summary raises questions.

The probe prints no message text, no draft, and no full window title: names and values are compared inside the helper, and only counts leave it. Window titles keep only what follows their last ` - `, and addresses keep their origin and first path segment. What it does print, and what you should still look over before sharing:

- DOM class names, aria-keyshortcuts and ARIA roles, which are the app's own code.
- Folder names under the apps' data folders (not under `projects` / `sessions`).
- Named-pipe names that match the apps.
- The exe names of other open Chromium apps.

Never commit `out\`, and never share output made with `-Names`.

## Credit

The declarations of the core UIA COM interfaces in `uia-probe.cs` follow those in [vercel-labs/agent-desktop](https://github.com/vercel-labs/agent-desktop)'s `probes/windows` (Apache-2.0), which checked them against the Windows SDK's `UIAutomationClient.h`. That project's `probes/windows/FINDINGS.md` is the background for several checks here: Chromium shows a shell of a dozen nodes at first contact, `SetFocus` takes the foreground, and `PostMessage` keys do nothing in Chromium.
