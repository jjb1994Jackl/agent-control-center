# Matching the look (advanced, optional)

By default you do not need this file: Frontdesk's chat kit already draws the structure coding agents share (see SKILL and contract section 7). Only when the person explicitly asks for "exactly like my desktop app" do you screenshot, measure and match as described here. When matching, prefer the kit's `--kit-*` variables, then renderers, and only last extra styles.

Goal: with your desktop app and your page in Frontdesk side by side, structure, hierarchy, proportions, fonts, colours, icons and interaction all agree. The only differences are Frontdesk's own shared parts (the character, quota and speech bubble on the agent rail at the far left, the shared layout of the sidebar and chat header, the dictation button, approval cards).

## 1. Screenshots: which screens

Take each screen once in light and once in dark; keep the window size fixed (for example 1280 × 820) and note the display scale (Retina is usually 2x; divide screenshot pixels by 2 for CSS pixels).

1. The whole window, with a session open that has several turns and tool calls.
2. The left sidebar: the Projects and Chats areas, a normal row, a hovered row, the selected row, a running row, an unread row (for matching colours only; the layout is shared, see section 6).
3. The chat header: title, working folder or project (again for colours only).
4. Messages: the person's message; an ordinary AI answer; a long answer with headings, lists, code blocks, inline code, tables and links; the AI's progress notes midway.
5. Tool calls: collapsed, expanded, running, failed; how consecutive tools are grouped.
6. The thinking / typing indicator.
6a. Your native elements in a conversation: the step list (when listed, in progress, all done), a command and its output, a screenshot you took or an image you generated (thumbnail and opened), a file-change summary, the end-of-turn summary or next-step card, a multiple-choice question to the person. One screenshot each, noting where it sits in the conversation (after which message, pinned to the bottom or not).
7. Permission prompts (if you have them).
8. The composer: empty, with text, with attachments, focused; each button inside (attachment, model, effort, microphone, send, stop): shape, icon, size, position and layering.
9. The model picker open: option structure (descriptions, groups, ticks, shortcuts), width, position. Same for other pop-up menus.
10. Empty states: new chat, no sessions.

### How to take them

**Try once before you start.** Take a test screenshot before the end of step 1 to confirm screenshots work; do not find out in step 2:

- If you can control the screen (computer use or similar): open your desktop app and take them one by one from the list. Screens that need a click (model menu, expanded tools, empty states) you can open yourself.
- From a terminal: `screencapture -x -o -l <window number> out.png` captures one window. Find the window number with a few lines of Swift calling `CGWindowListCopyWindowInfo` (filter the main window by app name and width).
  - If it says `could not create image from window/display`, the app running you lacks "Screen & System Audio Recording" permission. Stop and tell the person: allow it in "System Settings → Privacy & Security → Screen & System Audio Recording" (usually Claude / Codex / Antigravity itself), or turn on computer use, then continue.
  - Terminal screenshots capture only the window as it is now. For screens that need a click, ask the person to open them one by one. With their consent you may run a background loop (say every 2 seconds) to catch them as they open them. Stop the loop as soon as you are done and make sure no process is left.
- If neither works: write the list into `docs/skins/<id>/source/SHOTLIST.md`, ask the person to put the screenshots in the same folder, then continue.

Screenshots contain the person's real chats (philosophy 18): images in `source/` never go into the repository (already in `.gitignore`); committed comparison images must be cropped of anything private, or taken in a session created just for screenshots with throwaway content.

Never match from memory or from images online. Versions differ and so do interfaces; the version installed on the person's machine is the reference.

### How to screenshot Frontdesk

- Start a separate Frontdesk server on a port that does not clash with the one the person uses (for example `npm run build && PORT=<free port> node dist/server/server.js`, in the background), and screenshot with headless Chrome over the DevTools protocol: device scale 2, the same window size as the desktop app, `prefers-color-scheme` to switch light and dark.
- A server started by a preview tool (Claude's browser pane, for example) may run in a sandbox headless Chrome cannot reach. In that case use the separate server above.
- Give the screenshot script a timeout, close Chrome even on timeout or failure, and check at the end that no Chrome or server processes are left.

## 2. Read exact values instead of estimating

Claude, Codex (the ChatGPT desktop app) and Antigravity are Electron apps; their styles are in the installed package:

- Use `readAsarFile()` from `src/server/services/app-assets.ts` (or an equally read-only way) to read the CSS / JS in `app.asar` for font families, sizes, weights, line heights, colour variables, corner radii, spacing, shadows and animation durations. Read-only, for matching on this machine only; never copy these files into the project.
- Fonts: the desktop app's font files are in the package too. Like character images, read them at run time from the installed package and serve them through `@font-face` (with `registerAsset`); never copy them into the project. If they cannot be read, use the closest system font and say so in fidelity.md.
- Icons: note which icon set the desktop app uses, stroke width and sizes. Frontdesk ships Lucide; if the style differs, swap in your desktop app's icons in your skin (also read at run time or redrawn as SVG, never copying the original files).

## 3. Write fidelity.md

`docs/skins/<id>/fidelity.md`, one section per area:

```
## Composer
Screenshots: source/composer-light.png, source/composer-dark.png
Structure: frame (radius 16, 1px border #e5e2db / dark #3a3a3a) > text area (15px/1.6, 16 horizontal padding) > bottom row (left: attachment + model picker; right: microphone + send)
Send button: 32 round, dark background, white arrow; 40% opacity when disabled
Model picker: text button "Opus 5.5 ⌄", 13px, light grey on hover; opens upward as a 280-wide card, each item: name 14px + one line of description 12px grey, tick on the right
Source of values: app.asar /…/main.css line ……
Differences from the Frontdesk default: ……
```

## 4. Order of work

1. Structure first (`turn:<id>`, `session-list:<id>` renderers), then styles. If the structure is wrong, no amount of styling makes it look right.
2. Styles from large to small: page layout and widths → fonts and sizes → colours → radii and spacing → icons → hover, expand, animation.
3. Compare light and dark separately.
4. Narrow screens (phone width): check whether your desktop app has a matching form; if not, make sure nothing overflows and buttons can be pressed.

## 5. Compare

- Open the same session in Frontdesk and your desktop app, same width and theme, take one screenshot of each, and save them joined side by side as `docs/skins/<id>/compare-<theme>.png`.
- List the differences area by area, fix them, take them again. At least: the same division into areas; the same text baselines, sizes and weights; the same button shapes, sizes, icons and positions; colours indistinguishable by eye.
- Where they cannot agree (the desktop app has a feature Frontdesk lacks, for example), explain why in fidelity.md.

## 6. The boundary with shared parts

- The agent rail at the far left belongs to Frontdesk as a whole: engine avatars, unread badges, quota bars, the speech bubble, the add button, the person's avatar and settings. Add nothing to it and do not change it.
- Inside the window, the layout of the sidebar and the chat header is one shared design for every engine (`src/client/style.css`: the head with the engine's name or mode menu, new chat, search, the project tree, chat rows; the chat header's title, working-folder tag, "Open in <you>" and the buttons on the right). A skin only gives them colours: the kit's `--kit-*`, and the sidebar's `--side-bg`, `--side-line`, `--side-select`, `--side-attention`. Where your desktop app has something of its own in those two places, add it with a renderer; do not change the shared layout.
- In the conversation area, whatever the desktop app draws itself is matched to the desktop app and is not redesigned, including when the request is to make things look better: a reply's content, tool rows ("Ran a command…"), "Thinking", "Worked for", the step list, the end-of-turn card and its buttons, the composer and the model / effort / permission row under it. Frontdesk adds only these, which no desktop app has, and their look is shared: the run-state tag and the "cannot send" note above the composer, the error notice at the top of a chat, the line shown while a chat is being read.
- The speech bubble, the quota bar and card, the dictation button's recording state and the meaning of approval card buttons keep Frontdesk's look; their colour follows your brand (the plugin's `accent`), their shape and behaviour do not change.
- Skin CSS is written only under `html[data-engine="<id>"]`. When switched to another engine, your styles must have no effect at all.
