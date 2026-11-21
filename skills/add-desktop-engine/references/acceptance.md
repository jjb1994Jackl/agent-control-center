# Acceptance checklist

Check every item before handing over. For anything you could not do, write why; never leave it out.

## Channels

- [ ] `progress.md` has the channel table: which route sending, steering, stopping, changing settings, new chats, answering cards, opening the chat in the desktop app and opening files each take, with evidence for each.
- [ ] Every action on route C says why routes A and B cannot carry it (what was looked for and found missing); every action on route A or B names its fallback, and that fallback was tried once.
- [ ] Every channel that writes to a session passes the three questions in [Choosing channels](channels.md): the turn is run by the desktop app's own process; the desktop app shows it right away as the person's own; no one else's token is used. None of them starts another process to run the turn.
- [ ] With the helper: in `probe`, every locator finds exactly one match and `differ` and `drift` are empty (its ways find the same control, and every way that goes by a mark still finds it), no control a flow presses or fills is in `several`, and a menu button found by its place has its menu's sign in `menuSigns`; every control that can be recognised without its name has such a way, and those that can only go by their names are listed in the handoff notes; it was tried once with the window not in front and in another Space; afterwards the desktop app is back on the original session and mode; the app was never activated and the keyboard never taken.
- [ ] Every "sent / joined / answered" is decided by the native record, not by the helper or an interface returning ok.
- [ ] Windows (if you use the helper there): `<id>-desktop.cs` ports every command your macOS flow has, or `progress.md` names the ones it lacks; `probe` passes on the Windows app as above; a real send left the window where it was (same place, maximized or minimized as before, no `issues` in the park report) and the foreground with the window the person was in; `takesFocus` (or `newTakesFocus`) is declared; with Frontdesk and the app at different rights the reason is shown. Without a Windows machine, write "not tried on Windows".

## Connection

- [ ] Session list: titles, working folders and update times match the desktop app; unused empty sessions do not appear.
- [ ] Opening a past session: the number of turns matches the desktop app (only a person's input starts a turn); the AI's words, tool calls and artifacts appear in true order; thinking does not appear.
- [ ] A real message sent from Frontdesk (the cheap way in step 4 of SKILL, with the person's consent first): it goes through the channel you chose; the desktop app shows the turn; no second, forked session appeared. If the person declined, write "not verified".
- [ ] A reply sent from Frontdesk is shown as it is written, not all at once at the end: while the desktop app writes it, the page's text grows within a second of the desktop's (where the desktop app keeps the text so far somewhere it can be read; if it does not, `progress.md` says where you looked).
- [ ] While a session runs in the desktop app, Frontdesk still allows sending; there is no read-only mode.
- [ ] Tasks sent from Frontdesk default to the session's model, reasoning effort and permission settings from the desktop app; ones changed under the composer are sent as changed.
- [ ] Running / completed / failed / stopped are shown only with native evidence; when unsure, "confirming" is shown.
- [ ] When sending is impossible (not signed in, app not running, no channel), the interface gives one sentence of reason and the next step, and never hangs on "sent".
- [ ] Stop, permission prompts, quota, dictation: what you built works; what you could not build is not declared, and the interface has no fake buttons.
- [ ] Steer: pressing Enter while running put the message into the running turn (also inside that turn in the desktop app); when it cannot join, it is queued automatically with one sentence of reason. For engines without `steer`, Enter queues.
- [ ] Queue: Tab while running adds to the queue; items can be edited, cancelled and "Inserted"; after the turn ends (including a turn started in the desktop app) they go out in order, never early while the desktop app is still running.
- [ ] If the desktop app has its own message queue: the messages it holds appear above the composer and "Send now" works.
- [ ] Changing model / reasoning effort / permissions on the page and sending: the desktop app's menus changed too; picking something the desktop app cannot change to sent nothing and the page explained why.
- [ ] Speech bubble on the agent rail: everything the AI says in the desktop app (including progress notes midway) appears in the bubble beside the avatar within seconds and leaves by itself once read; tool calls do not; while the AI works with nothing new to say, three dots sit by the avatar.
- [ ] Quota (if any): the bar under the avatar has a segment for every window you report; hovering the avatar shows each window's name, value and reset time; the numbers match what the desktop app shows.
- [ ] The character comes from your desktop app (read at run time) or is an original stand-in clearly marked as such; it moves while working.
- [ ] Dictation: if you wired up `dictate`, it works, including from other engines' pages; `dictationReady` reports the reason when signed out or not running, and the microphone then moves on to the next source.
- [ ] No other program's private token was read or saved; your own credentials are read on the server at the moment of use only; no token appears in the page, logs, tests or files.
- [ ] The desktop app's local data was not changed.

## Page (kit)

- [ ] The plugin declares `accent` and `character`.
- [ ] The sidebar is the shared one, not your own: sessions sit under "Projects" exactly as in the desktop app (counted project by project); sessions in no project are under "Chats", and no project the desktop app lacks appears (you gave `metadata.group: null`, not a guess from `cwd`); sub-sessions hang under their parent; running / needs-attention dots are right.
- [ ] `list()` is complete: every page of the official interface is fetched, the total matches the desktop app, nothing is duplicated.
- [ ] If the desktop app has a project list: `projects()` is implemented, in the desktop sidebar's order, empty projects included.
- [ ] If the desktop app has a mode switch: `spaces` is declared (the desktop's order and words); each mode is checked: projects and chats match that mode's desktop sidebar (counts, order, sessions in both modes); sessions whose messages cannot be read carry `contentUnavailable`; modes that cannot start chats carry `noNew`; the Accessibility profile has `spaces`, and the `space` command reads the same mode as the desktop app. For cloud chat modes connected through `ChatMode`: a fresh new chat, a new chat in a project (shown under that project in the desktop app too) and a message to an existing chat were each done from the page on the real app, each waited until the page showed the reply, and afterwards the desktop app was back in its original mode; this mode shows no model, permissions, attachments or stop.
- [ ] Projects are collapsed by default and stay expanded after a reload once expanded; long names are all truncated with the same ellipsis; the sidebar's right edge can be dragged wider and narrower.
- [ ] New chat: "New chat" gives an empty composer directly (no dialog); a project can be chosen under the composer; after the first message, the session appears under the chosen project in the sidebar and in the desktop app.
- [ ] Opening a session: the person's messages (with pasted images), the AI's text, tool calls merged into one line with expandable cards, step lists, and question / summary cards all appear in the right order, for both history and live turns.
- [ ] File paths in the text are blue links that preview in the right panel; the session's `cwd` is right; "Show in Finder" works; with `openFile` declared, "Open in <your name>" opens that file in this chat in the desktop app.
- [ ] The chat header has "Open in <your name>" (`showInDesktop`): tried on the real app, it shows this very chat in the desktop app and brings the app to the front, also for an old chat far down the desktop's sidebar, one of two chats with the same title, and with the desktop's window closed; a chat it cannot show gets one sentence of reason. If your app cannot do it at all, the reason is in `progress.md`.
- [ ] Code blocks (language name, copy, highlighting), tables, maths and Mermaid diagrams in replies display correctly (shared rendering; you only hand over the text).
- [ ] Question / permission cards: answered on the page, the desktop's record holds that answer; answered in the desktop app, the page's card disappears. The summary card appears only on the latest turn; with `cardActions`, clicking one of the desktop's own buttons on it (opening a PR, say) presses the same button on the desktop's card, and the page shows these buttons under the names and in the number the desktop's card draws (disabled until they have been read).
- [ ] Under the composer: model, reasoning effort (if any) and permission mode (if any) default to this session's desktop settings and can all be changed.
- [ ] The look was changed only through `--kit-*` variables and renderers, without copying kit styles; light and dark were both checked; nothing overflows on narrow screens.
- [ ] When switched to another engine, your skin has no effect at all; shared areas (agent rail, speech bubble, quota, the layout of the sidebar and chat header, dictation, approvals, settings panel) were not changed.

## One-to-one match (only when asked)

- [ ] `docs/skins/<id>/fidelity.md` is written, with screenshots, values and sources.
- [ ] Sidebar, chat header, messages, tool calls, native elements, composer and buttons, model picker and fonts were each compared with the desktop app.
- [ ] Side-by-side screenshots are saved in `docs/skins/<id>/`, and in the final round no difference in structure or proportion is visible.

## Process

- [ ] Steps were listed at the start and updated as work progressed.
- [ ] The page was actually opened and looked at (screenshots where possible), not just the code read.
- [ ] `docs/skins/<id>/progress.md` records each step's progress and how to continue.
- [ ] No background processes are left (screenshot loops, headless Chrome, temporary Frontdesk servers).
- [ ] Files to commit contain no raw screenshots; comparison images contain no private chats.
- [ ] Where the kit or shared code fell short (contract section 9), it is listed in the report as "extension points needed".

## Engineering

- [ ] `npm run build` and `npm run typecheck` pass: the plugin is `src/server/plugins/<id>.plugin.ts`, `setup` is typed `PluginSetup`, there is no `any`, native records are `unknown` until narrowed, and no `as` pretends to know a native format.
- [ ] `npm test` and `npm run check` pass; new parsing and protocol logic is covered with test doubles (`test/<id>.test.ts`).
- [ ] Other engines' plugins and the core were not changed; if a new extension point was truly needed, it is explained separately and has no effect on other engines.
- [ ] Hand-over report: files changed; capabilities done / not done and why; extension points needed; what the person still has to do (sign in, authorize, restart the server).
