# Capability paths: each capability, from the page to your desktop app

Claude and Codex are the most complete engines in Frontdesk. This file goes through each capability visible on the page: what the page shows, how the request travels, **what is already done (you just use it)**, **what you provide**, how Claude and Codex provide it, and how to check it. Exact field shapes are in the [plugin contract](plugin-contract.md); which route a message takes is in [Choosing channels](channels.md).

Keep this picture in mind:

```
Page (src/client/app.ts + src/client/kit + src/client/js/*)               ← all shared, you do not change it
  │  REST / SSE (src/server/server.ts, engine-agnostic)
  ▼
RunService (a turn's lifecycle, steer, queue, stop, approvals)  ← shared
SessionObserver / ActivityFeed / UsageService                  ← shared: desktop-started turns, speech bubble, quota
presentation.ts (presentHistory / bindEvents / questionCard)   ← shared: normalises your data and events
  ▼
src/server/plugins/<id>.plugin.ts   capabilities + method mapping      ← you write (a few dozen lines)
src/server/<id>-bridge.ts           read native records, use channels   ← you write (most of the work)
src/server/native/<id>-desktop.swift + profiles/<id>.json              ← only when you need the helper
src/client/public/skins/<id>/skin.css   --kit-* variables                  ← optional
```

The page never asks "which engine is this". It reads only the `capabilities`, `look`, `spaces` and `permissionModes` your plugin declares and the data you return. So **everything you do is "provide data / implement a method / turn on a capability flag"**, never changing the page.

---

## 1. Left sidebar: projects and chats

**Page**: a two-part sidebar ("Projects" with their chats, "Chats" for those in no project), projects collapsed by default and remembered, "Show more", loading older chats when scrolled to the end, search, drag to resize, status dots (running / needs attention / unread), sub-sessions under their parent, a mode switch at the top.

**Path**: `GET /api/sessions?engine=<id>` → your `list()`; `GET /api/projects` → your `projects()`; drawn by `src/client/js/sidebar.ts`.

**Already done**: grouping, collapsing, truncation, resizing, search, paging, the mode menu, unread dots. Do not draw your own.

**You provide**:
- `list()` complete in one go (every page of the official interface, de-duplicated by id), each with `metadata.group`: `{ id, name, cwd }` = in this project; `null` = in no project; absent = fall back to grouping by the `cwd` folder (only when your desktop app really groups by folder). **Do not guess projects from `cwd`**; first find where the desktop app records membership.
- `projects()`: every project in your desktop sidebar's order (empty ones too), with `id` equal to `group.id`.
- `status: 'busy'` backed by native evidence; `metadata.parentId` (sub-sessions), `metadata.attention` (orange dot).
- A mode switch at the top of your desktop sidebar: plugin `spaces`, session `metadata.space` / `bySpace`; see contract section 7, "The desktop's modes".

**How the two provide it**: Codex's projects come from the app-server's `project/list` plus membership in the desktop's state file (`src/server/services/codex-projects.ts`); Claude's from the folders in the desktop index. Both chat modes' lists come from lists the desktop app keeps on disk (`codex-chatgpt.ts`, `claude-chats.ts`).

**Check**: compare counts and order with the desktop app project by project; totals match; "Chats" contains no project the desktop app does not have.

## 2. Right panel: file preview, and opening in Finder / the desktop app

**Page**: file paths in replies (Markdown links, inline code like `src/server/a.ts:42`, folders, `file://`) are blue links; clicking previews them in the right panel (tabs, resizable, jumps to the line, folders list their contents); hovering shows a small box with "Show in Finder / Open in <you>", and the panel's title bar has the same two buttons.

**Path**: `POST /api/sessions/:engine/:id/file` (read-only preview, `src/server/services/file-preview.ts`); `POST …/reveal { where: 'finder' | 'desktop' }`.

**Already done**: link detection, preview, bounds checks (only the session's `cwd` and `fileRoots`; key files and `.git` refused), Finder.

**You provide**: the right `session.cwd` from `read()`. For "Open in the desktop app": `capabilities.openFile: true` + `openFile(id, { path, absolute, relative, label })`. If your desktop app saves documents outside `cwd`, implement `fileRoots(id)`.

**How the three provide it**: all use the shared driver's `open-file` (show this chat, press the chat's own link to the file, bring the desktop app to the front), one line: `this.desktop.openFile(...)`. Antigravity's app has been an agent window rather than an editor since 2.0 (a file handed to it with `open` is not opened), so it does the same, with its profile alone: its window opens the file in a tab beside the chat, as its own link does.

## 3. The agent rail: character, connection dot, unread badge, speech bubble

**Page**: on the rail at the far left, a round avatar per AI (animated while it works, with an arc running round it), a connection dot at its corner (green / yellow / grey), and the count of replies not yet looked at on the opposite corner. When the AI speaks, a small bubble rises beside the avatar and types out what it says, leaves by itself once read, and fades from under the pointer; while the AI works with nothing new to say, three dots sit by the avatar. Clicking the avatar jumps to that chat. With the rail set wide ("Agent rail" in settings), each AI's last line stays in the rail.

**Path**:
- Avatar: plugin `character`; images read at run time from the installed app via `registerAsset` (`/api/characters/<name>`).
- Connection dot: your `status()`.
- Speech bubble: `ActivityFeed` gathers three sources → `/api/activity/events` → the page. ① In a turn Frontdesk started, `message.updated` (completed). ② For an open chat, `SessionObserver` reads `read()` every 3 seconds and sends `assistant.notice` for new messages. ③ **For chats that are not open, every 5 seconds it reads each session's `metadata.recentMessages` from `list()`**.

**Already done**: animation, bubble layout, de-duplication, "only what was said since this turn began".

**You provide**: `character` (sprite sheet or single image, rules in contract section 4); `status()`; **`metadata.recentMessages: [{ id, preview, phase, at }]` on every session in `list()`** (the last few things the AI itself said, `id` matching `read()`, `at` the message's own time) and `metadata.turnStartedAt`. Without `recentMessages`, what the AI says in a turn started in the desktop app never reaches the bubble.

**How the two provide it**: Claude takes the last 6 messages from the session record (`recentMessages()`); Codex reads the JSONL incrementally (`src/server/services/codex-lifecycle.ts`).

**Check**: send a message in the desktop app; within seconds the bubble shows the AI's progress notes and answer; tool calls and thinking do not appear.

## 4. Quota

**Page**: one segmented bar under the avatar (a segment per window you report; the one that is nearly used up turns red); hovering the avatar shows a card with each window's name, remaining and reset time; "Quota" in the user menu at the foot of the rail.

**Path**: `GET /api/usage` → `UsageService` (60-second cache, merged requests) → your `usage()`.

**You provide**: `usage()` → `{ available, windows: [{ id, label, windowMinutes, remainingPercent, usedPercent, resetsAt (seconds) }] }`; when unavailable, `{ available: false, short: '未登录', reason }`. Use only your own official quota interface; never estimate from token counts.

**How the two provide it**: Codex uses `account/rateLimits/read` on Frontdesk's app-server; Claude uses the official CLI's control request `get_usage` (a single query that persists nothing and runs no turn).

**Check**: the numbers match what the desktop app itself shows.

## 5. New chats, new chats in a project

**Page**: "New chat" (⌘N) is just an empty composer, no dialog; a project menu under the composer; a "+" appears beside a project name on hover to start a chat in that project; things the desktop's new-chat page asks for first (environment, folder, toggles) appear as cards, one at a time.

**Path**: when the first message is sent, `POST /api/sessions/:engine` → your `create(input)`; ordinary engines then go through `send`. For engines declaring `createRequiresPrompt`, the first message comes with `create`, you return `started: true`, and Frontdesk then calls `observe(id)` to follow the turn. Cards: `GET/POST /api/new-options/:engine` → `newOptions()` / `pickNewOptions()`.

**Which approach** (by what starting a chat looks like in your desktop app):

| When your desktop app starts a chat | You declare | Example |
| --- | --- | --- |
| An official interface creates sessions and takes a folder | `cwd: true`; `create` uses `input.cwd` | Antigravity |
| Only its own new-chat page can send the first message (anything else is another process) | `createRequiresPrompt: true`; `create` sends on the new-chat page via the helper, finds the new session's id in the native record, `observe` follows it | Claude, Codex |
| The new-chat page has choices to make before sending, which change with each other | Add `newOptions: true` (+ `newFolder`, so a project's "+" picks the folder in one go), implement `newOptions` / `pickNewOptions`; the driver uses `newPageCommands` | Claude |
| No choices on the new-chat page, but it keeps the last model used | `newSettings: true`; `newSettings()` reads what the page shows and the menus start from it | Codex |
| Projects exist and the new-chat page can pick one | In `create`, pick the project matching `input.cwd` (Codex: by name in the project menu, or "Don't work in a project"); if the folder is not a project in the desktop app, do not create, and say why | Codex |
| New chats in one of the modes (cloud chat) | `ChatMode.create(input, project)`, `input.space` / `input.projectId` | Both chat modes |

**Finding the new session**: after the helper sends, look in the native record for the session "that did not exist before and whose first user message is this one" (Codex checks `thread/list`, Claude the desktop index); if none is found, report why. Never return a guessed id.

**Check**: a fresh new chat, one from a project's "+", and one with a non-default model, each sent for real once (with consent); the desktop app shows each under the right project.

## 6. Opening a chat: history and live

**Page**: the person's messages (with pasted images), the AI's text, tool calls and cards, in true order; history and the running turn join seamlessly.

**Path**:
- History: `GET /api/sessions/:engine/:id` → your `read(id)` → `presentHistory()` → the page.
- Live: the EventEmitter from `send` / `observe` → `bindEvents()` normalises it to `message.updated` / `activity.upsert` / `approval.requested` / `run.*` → `EventHub` (with cursors, replayed after reconnects) → SSE → `src/client/js/store.ts`.
- Turns started in the desktop app: there is no emitter of yours, so `SessionObserver` reads `read()` every 3 seconds and sends `session.snapshot` when it changes. So `read()` must reflect the turn in progress (last turn `status: 'running'`, or session `status: 'busy'`).
- Deciding the end: only native evidence (a `completed` event, or this turn's `statusEvidence` + `completedAt` in `read()`). When you send `warning { awaitingEnd: true }` or `error { transport: true }`, RunService checks `read()` every 2 seconds until the native record gives a final state.

**You provide**: turns from `read()` (only a person's input starts a turn), `messages` (`assignPhases`), `timeline`, `steps`; live events per contract section 5. The same message or tool must have the same `id` live and in history, or it shows twice.

**How the two provide it**: after sending, Claude watches the JSONL from where the file ended before the send (`sendViaDesktop`) and turns what the desktop writes into events; Codex polls `thread/read` until the turn holding this message appears, then follows it to its end (`CodexLifecycle` trusts `task_complete` / `turn_aborted`).

**Every engine also provides "Open in <you>"**: the button at the top right of the chat header (`POST /api/sessions/:engine/:id/show`, and the "open it in the desktop app" button on a card that can only be answered there) takes the person to this very chat in your desktop app and brings the app to the front. Declare `capabilities.showInDesktop: true` and implement `show(id)`; without the flag there is no button, so leaving it out is a missing feature, not a neutral choice. Every engine so far does it with the shared driver's `show-session` (`DesktopAutomation#showSession({ title, localId })`), even one that writes through an interface of its own (Antigravity): a deep link that opens a given chat helps where your app has one (profile `sessionLink`, tried when no row in the sidebar opens the chat), but only `show-session` and `open-file` use it: a deep link can bring the desktop to the front even with `open -g` (Claude's does), and every other command must leave the desktop behind the person's app. If your app's page has an address for each chat (Antigravity: `/c/<id>`), give the profile `sessionAddress` (`"/c/{localId}"`) and `show` finds the chat by its id, not its title (two chats may share a title); where the rows themselves carry only the title (Claude: plain buttons, page at `/epitaxy/local_…`), add `"sessionRowsBy": "title"`, and each row with that title is pressed until the page's address is this chat's, after unfolding what the sidebar folds away (`moreSessions`, `nestedSessions` locators); the driver scrolls a sidebar drawn only near what is on screen until the row is there, and brings back a window the person closed (the Dock's reopen). When the chat cannot be shown, throw the reason (the page shows it).

## 7. How everything in a reply is rendered

All shared; you hand over raw data:

| Thing | You provide | Drawn by |
| --- | --- | --- |
| Markdown text, code blocks (language, copy, highlighting), tables, `$…$` maths | The original text (with ``` fences) | Shared `markdown()`, highlight.js, KaTeX |
| Mermaid diagrams | ```mermaid blocks in the text | `src/client/js/diagrams.ts` (loaded on demand) |
| File links | Paths in the text | See section 2 |
| One-line tool summaries ("Ran 3 commands, read 2 files") + expandable cards | `step.name` + `step.input` (native tool name and arguments) | `tool-catalog.ts`; for tools only you have, one `registerTool({ match, map })` rule |
| Commands and output | A command step's `output`, live `command_output` | The kit |
| Screenshots, generated images, pasted images | `step.images` / `turn.userImages`, with `url` served by your `media(id, key)` | The kit, the image viewer |
| Step list | A step with `plan` (only the latest per turn is shown) | The kit's step card |
| Changed files with added / removed lines | A step's `changes: [{ path, kind, diff }]` (the patch only has its lines counted on the server) | The kit, when `look.diffCard` is on |
| Artifact file cards | Only what your desktop app itself draws as a card (`artifacts` / `artifact` events) | The kit |
| "Worked for 3m" and the like | `turn.workedMs` / `durationMs`; `look.worked`, `workingLive` | The kit |

**`look`**: your desktop app's habits in writing a turn (whether the work is folded, whether captions carry counts, where times go); fill it in from the table in contract section 7. For a habit not in the table, first add a field to the kit (defaulting to today's behaviour), then turn it on in your plugin; never write `engine === '<id>'` in the kit.

**Chats read from the desktop window** (cloud chat modes): the shared driver turns `AXCodeStyleGroup` back into fenced code blocks and tables into Markdown; nothing for you to do.

## 8. Live cards: permissions, questions, summaries, steps

**Page**: cards drawn under this turn's reply, with buttons that work; when answered in the desktop app, the card on the page goes away.

| Card | How it appears | How it is answered |
| --- | --- | --- |
| Permission prompt | A live `approval { id, title, detail, decisions: ['accept', 'decline'] }` | Page `POST …/approvals/:id` → RunService → your `decide(id, decision)`; answered in the desktop app, send `approval_resolved { id }` |
| A question the AI asks | Same, with `decisions` from the shared `questionCard(id, questions, appName)` (one single-choice question gets buttons plus Skip; several questions or multiple choice say to answer in the desktop app) | Same; `decision` is `option:<id>` or `decline` |
| Summary / next-step card | A step of `type: 'summary'` (map your native tool with `registerTool`), `detail` the JSON `{ recap, ask, actions }` | A button without `app` sends its `label` as the next message |
| Step list | A step with `plan` / a live `tool_call { plan }` | Display only |

Answers go through the desktop app's own channel (that row in section 3 of [Choosing channels](channels.md)): Codex follows the window that owns the session to get the request it is waiting on and answers over IPC; Claude uses the helper to pick and submit on the desktop's own card (the driver's `answerCard`); Antigravity uses the language server's interface. **The answer counts once the native record shows it.** When you cannot answer, throw an error with the reason ("please do it in the desktop app"); never pretend.

Whether a card appears depends only on whether you send an `approval` event; `capabilities.approvals` is a declaration for humans ("permission prompts are answered on the page"), and the page does not read it. Claude declares `false` and never sends `approval` for permission prompts (they stay in the desktop app), yet its question cards still send `approval` and go through `decide`.

**Cards in a turn started in the desktop app**: they appear only if you read them from the native record or the window channel (Codex's `watch`). If you cannot, say in your report "only turns started from Frontdesk have cards".

## 9. Model, reasoning effort, permissions

**Page**: three menus under the composer, starting on this session's settings in the desktop app; only what the person picks by hand goes with the message.

**Path**: `GET /api/models` → `models()`; the session's `metadata.desktop: { model, effort, permissionMode }` sets the menus' starting point; plugin `permissionModes` sets the permission menu; sending carries `input.model / reasoningEffort / permissionMode`.

**You provide**:
- `models()`: only models you can discover; with `reasoningEfforts` / `defaultReasoningEffort`, the effort menu appears. Never make them up.
- Each session's `metadata.desktop` (read from wherever the desktop app keeps it).
- `permissionModes: [{ id, label, description }]` (`id` letters only).
- **At send time, a setting that differs from the desktop's current one means the person changed it on the page**: change it in the desktop app first, then send, so the desktop app shows and keeps it. How depends on the channel: an official interface that takes settings gets them directly (Antigravity's `requestedModel`); a window-to-window channel that sets them as the desktop's own menu does comes next (Codex: `thread-follower-update-thread-settings`, see `pickInDesktop`, with the menu as its fallback); otherwise the helper operates the desktop's menus (Claude: the Model menu, the Effort submenu, the permission menu; Codex: the model menu and the "Power" slider) and reads them back. **If any one fails, do not send**; return the reason.
- Write name mapping as one function: Frontdesk id → what the desktop's menu calls it (Claude's and Codex's `desktopSettings()`), and back, desktop text → id (`shownSettings()`; if not recognised, leave it out, never guess). Level names that differ go in the profile (Codex's `effortNames`).
- Modes without these settings (cloud chat): turn off `models` / `reasoning` / `permissions` in `spaces[].capabilities`.

## 10. Sending

**Path**: `POST /api/sessions/:engine/:id/messages` → first `blocked(id)` (non-empty means 409 with the reason shown) → `RunService.start` → your `send(id, input)` (returns the emitter synchronously and emits only after `queueMicrotask`). Frontdesk starts at most one turn per session at a time.

**You provide**: `send` follows [Choosing channels](channels.md); a message counts as sent once the native record shows it, after which you turn what the desktop writes into events. `blocked()` expresses only "this really cannot be sent" (not signed in, not installed, no Accessibility permission, desktop app not open); **never refuse because the session is running in the desktop app** (mark it with `isDesktopActive`). Attachments arrive as `input.attachments: [{ path, originalname, mimetype }]`; give them to the desktop app its own way if it accepts files, otherwise put the paths in the message and say so.

**Special case**: when sending reveals the desktop app is still running the turn (the page thought it had ended), do what the desktop's own composer does: hand the message over to join that turn, and send a `warning` explaining it (Claude's `busy` → `steer`).

## 11. Stop

**Page**: a stop button at the right of the composer while running. `capabilities.interrupt` enables it for turns Frontdesk tracks. Plugins that declare `desktopInterrupt: true` can also stop turns started in the desktop app.

**Path**: `POST …/interrupt` → `RunService.interrupt` → your `interrupt(id, emitter)`. Returning `{ pending: true }` means "I asked the desktop app to stop; I will report the final state from the native record"; otherwise RunService marks it stopped at once.

**How the two do it**: In Claude's Code mode the helper presses the desktop's Stop and the session record determines the final state. In Claude chat mode the helper verifies the conversation ID on the desktop page, presses Stop, and waits for the button to disappear. Codex uses IPC `thread-follower-interrupt-turn` (with `expectedTurnId`), and withdraws messages still waiting in the desktop's queue with `thread/queue/delete`.

## 12. Steer, queue, Send now

The composer is not locked while a turn runs. Messages go one of three ways, all through the shared `RunService`:

| The person | Request | What happens | What you do |
| --- | --- | --- | --- |
| Presses Enter while running (engine declares `capabilities.steer`) | `messages { mode: 'steer' }` | **Steer**: `RunService.steer` → your `steer(id, input, emitter)` joins the running turn | Implement `steer`; when it cannot join, throw an error with `{ fallback: 'queue' }`, and the message is queued automatically with the reason shown |
| Presses Tab while running, or Enter without `steer` | `messages { mode: 'queue' }` | **Queue**: kept in Frontdesk's memory (at most 20 per session); sent in order once this turn ends and `read()` shows the desktop app is not running either | Nothing; just make `read()` reflect "running" |
| Presses "Insert" on a queued item | `POST …/queue/:itemId/steer` | That queued message becomes a steer; if it cannot join, it goes back to its place | Same as steer |
| Edits / cancels a queued item | `DELETE …/queue/:itemId` | Taken back into the composer / removed | Nothing |
| Presses "Send now" on a message the desktop app is holding | `POST …/send-now` | Your `sendNow(id)` | Only if your desktop app has its own message queue and Send now |

- `steer` returning `{ shown: false }` means your live events already draw this message as a user message, so RunService draws no extra steer bubble; otherwise it adds one to this turn.
- A steer counts per the native record: Claude waits for a `queue-operation: enqueue` or this user input in the record (`waitForRecord`, 12 seconds); Codex waits for the IPC confirmation, and on timeout reports "check in the desktop app whether it was inserted" **without resending**; Antigravity uses `deliveryStrategy: NEXT_INVOCATION`.
- Messages the desktop app is holding: return them as `session.metadata.desktopQueue: [{ prompt, at }]` from `read()` (Claude replays the record's `queue-operation`s). `SessionObserver` sends `desktop.queue` when it changes, and the page shows "<your name> queued" with "Send now" above the composer.

## 13. Dictation

**Page**: the microphone in the composer. Every engine's speech-to-text is pooled, and the first one that can start is used, in this order: the pick in settings → the default (`BRIDGE_DICTATION_ENGINE`, default `claude`) → the current engine's → the other engines' → the browser's. When one cannot start, the next one is tried and the notice says why. "Dictation" in the settings panel picks "Automatic", one engine's, or the browser's. When none can be used the microphone is disabled, and hovering it shows why for each.

**You provide**: if your desktop app has its own speech-to-text, implement `dictate({ language, onText, onError, onEnd })` → `{ send(pcm), finish(), cancel() }` and `dictationReady()` → `{ ready, reason? }` (a cheap check only, such as whether the sign-in is there or the desktop app is running; no audio). Without one, implement neither: the microphone still has other engines or the browser (contract section 6).

## 14. Interface text and errors

Text you return for the person to read (`status().error`, `blocked()`, `usage().reason`, the `message` of errors you throw, card titles, permission mode descriptions) is written in Chinese, with the English added to `REPORTS` in `src/client/js/i18n.ts` (with variables, `REPORT_PATTERNS`). `npm test` checks nothing is missing. Every error must tell the person what to do next.

---

## Capability flags at a glance (the plugin's `capabilities`)

| Flag | Turning it on makes the page | You implement |
| --- | --- | --- |
| `cwd` | Show the project menu for new chats and "+" beside projects | `create` uses `input.cwd` |
| `attachments` | Show the attachment button | Handle `input.attachments` (files the server has already checked: `path`, `originalname`, `mimetype`). Where the channel takes text only, build it with `withAttachments(prompt, attachments, style)` (`src/server/core/attachments.ts`); do not format it yourself: `'mention'` where the desktop has its own way of referring to a file (Claude's `@path`, which it then attaches itself), `'note'` where it has none |
| `models` / `reasoning` | Show the model / effort menus | `models()`; change `input.model` / `reasoningEffort` in the desktop app |
| `permissions: false` | Hide the permission menu (by default it follows `permissionModes`) | — |
| `interrupt` | Show the stop button | `interrupt` |
| `steer` | Enter while running = steer; "Insert" on queued items | `steer` |
| `dictation` | Your speech-to-text becomes one of the microphone's sources | `dictate`, `dictationReady` |
| `createRequiresPrompt` | Give you the first message with `create` | `create` returns `started: true`; `observe` |
| `newOptions` / `newFolder` | Show option cards from the new-chat page | `newOptions`, `pickNewOptions` |
| `newSettings` | Start the new chat's menus from what the desktop's new-chat page shows | `newSettings` |
| `openFile` | Show "Open in <you>" on file links | `openFile` |
| `showInDesktop` | Show "Open in <you>" in the chat header (every engine has it), and on cards that can only be answered in the desktop app | `show` |
| `takesFocus` | Tell the person once, at the first send, that sending takes the keyboard focus for a moment (a link in Settings shows it again) | Nothing: declare it `process.platform === 'win32'` when your messages go through the helper |
| `newTakesFocus` | The same, said at the first new chat, for an engine whose other messages leave the focus alone | Nothing: declare it `process.platform === 'win32'` when only new chats go through the helper (Codex) |
| `cardActions` | The desktop's own buttons on a summary card (commit, open a PR…) can be clicked, named and counted as read off the desktop's card, and pressed there | `readCard`, `pressAction` |

The `send` and `approvals` flags are declarations only; the page does not read them: whether sending works depends on `blocked()`, whether cards appear depends on whether you send `approval` events. Fill them in truthfully so others can read your plugin.

Methods without a flag: `usage` (quota shows if present), `media` (images show if present), `projects`, `fileRoots`, `sendNow` ("Send now" shows if present), `blocked`, `observe`.
