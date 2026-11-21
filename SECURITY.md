# Security

## What Frontdesk has access to

Agent Frontdesk is a local server that can read your agents' chat history and send messages as you. Keep that in mind when you decide where to run it.

- **No login.** The server listens on `127.0.0.1` by default and has no authentication. Anyone who can reach its port can read your chats and drive your agents. If you set `HOST` to a LAN address so another device can use it, do so only on a network you trust, and never expose it to the internet.
- **Same-origin writes.** Requests that change anything are refused when they come from another web origin.
- **Accessibility.** For Codex and Claude, the terminal that runs Frontdesk needs the macOS Accessibility permission, which lets it operate those apps' windows.
- **Credentials.** Frontdesk does not read other programs' tokens. It reads Claude Code's own sign-in from the macOS keychain, on the server, at the moment voice input or quota needs it. The token is not sent to the page and is not logged.
- **Files.** File preview is limited to the folders of the session you are looking at. Uploads are stored in `uploads/` and are served as downloads, never executed in the page.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's **Report a vulnerability** button under the repository's Security tab (private vulnerability reporting). Include what you found, how to reproduce it, and which version or commit you tested.

You should get a first reply within a week.
