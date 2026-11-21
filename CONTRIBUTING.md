# Contributing to Agent Frontdesk

Thanks for helping. Issues and pull requests can be written in English or Chinese.

## Reporting a problem

Frontdesk talks to desktop apps through interfaces that change when those apps update, so a report is most useful when it says:

- which agent, and the desktop app's version
- your macOS or Windows version and your Node.js version
- what you did, what the page showed, and what the desktop app showed
- the server's terminal output around that moment (start it with `AX_TRACE=1 npm start` for Accessibility problems; in Windows PowerShell `$env:AX_TRACE=1; npm start`)

Remove anything private from logs and screenshots first. **Never attach raw screenshots of real chats.**

## Setting up

```sh
git clone https://github.com/Phz-06/agent-frontdesk.git
cd agent-frontdesk
npm ci
npm run dev
```

You need macOS or Windows 11 and Node.js 22.16 or later. `npm run dev` serves the page with HMR on `PORT` (4100) and runs the server under `tsx watch` on `PORT+1`. On macOS a server started this way is a child process without Accessibility permission, so anything that drives the Codex or Claude window has to be tried on an instance started with `npm start` from a terminal that has the permission. On Windows there is no permission to grant; run the server with the same rights as the desktop apps.

Before you open a pull request:

```sh
npm test         # no real agent is contacted; tests use stand-ins
npm run check    # type check + build
```

## How the code is laid out

| Path | What lives there |
| --- | --- |
| `src/shared/contract.ts` | The plugin contract, shared by server and page |
| `src/server/plugins/` | One plugin per agent: what it can do, and which method does it |
| `src/server/*-bridge.ts` | Each agent's data adapter |
| `src/server/core/`, `src/server/services/` | Shared server layer: plugin host, run lifecycle, events, file preview |
| `src/server/native/` | The shared drivers (Accessibility in Swift on macOS, UI Automation in C# on Windows), each agent's steps for each, and how its controls are recognised, as data |
| `src/client/kit/`, `src/client/js/` | The shared page: sidebar, composer, cards, rendering |
| `test/` | `node:test` suites |

[docs/architecture.md](docs/architecture.md) explains the design.

## Ground rules

These keep Frontdesk a window onto the desktop apps and nothing more. The reasons are in [the philosophy notes](skills/add-desktop-engine/references/philosophy.md).

1. **The desktop app is the source of truth.** Reproduce what it shows and do not invent what it does not. Show "completed" or "failed" only with evidence from the app's own record.
2. **Every message goes in through the desktop app.** Never run a turn in a separate CLI or SDK process. If the desktop app cannot take a message, do not send it, and say why.
3. **Local data is read-only.** Do not change or delete the desktop apps' files, and do not read another program's tokens.
4. **Fix by abstraction.** When one agent shows a problem, check the others, then fix it once in a shared layer. The page and the kit never test for a particular agent; per-agent differences belong in that agent's adapter and plugin.
5. **Do not copy other apps' images or fonts into the repository.** Read them at run time from the installed app.

## Adding an agent

Follow [the onboarding guide](skills/add-desktop-engine/SKILL.md). The quickest way is to let the agent do it: click **+** in the agent rail and paste the prompt into the agent you want to add. Check the result against [the acceptance checklist](skills/add-desktop-engine/references/acceptance.md) before you open the pull request.

## Pull requests

- Keep one change per pull request, and say how you tried it (which agent, which desktop app version).
- Add or update tests for parsing and protocol logic.
- User-facing text is written in Chinese in the source; add its English to `src/client/js/i18n.ts`.
- If you change the plugin contract, update `skills/add-desktop-engine/` and the prompt behind the rail's **+** (`onboardingPrompt` in `src/client/app.ts`) with it.
- Art and fonts of other apps are read from the installed app at run time. Do not commit them.
