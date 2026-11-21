# Security

## What Agent Control Center has access to

Agent Control Center is a local server that can read your desktop agents' chat history and send messages as you. Keep that in mind when deciding where to run it.

- **Loopback only, no login.** The server binds strictly to `127.0.0.1` and refuses requests whose `Host` is not `127.0.0.1`, `localhost`, or `[::1]`. It has no authentication: any local process or user who can reach the port can read your chats and drive your enabled agents. Do not forward or expose the port to a LAN or the public internet.
- **Same-origin writes.** Requests that change state are refused when they carry a cross-origin `Origin` header.
- **Scoped macOS Accessibility.** For desktop UI actions (such as Grok Bot chats or window controls), grant macOS Accessibility only to the dedicated **Agent Control Center Preview.app** bundle under `~/Applications`, rather than granting blanket permission to Terminal or Node.
- **Credentials.** Agent Control Center does not extract or transmit other apps' private tokens to the browser. Legacy Grok Routine webhooks (if configured) and Claude Code's own sign-in are read from the macOS Keychain on the server only when needed and are never sent to the page or written to logs.
- **Files & rendering.** File preview is restricted via real-path resolution to the active session's working directory and declared agent folders, with common secret files (`.env`, private keys, `.git/`) blocked. Uploads are served as downloads (`Content-Disposition: attachment`) rather than rendered inline, and remote images in Markdown replies are blocked.
- **Local data hygiene.** Your SQLite task ledger, logs, and exports may contain private chat content; never attach them to public issues.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's **Report a vulnerability** button under the repository's Security tab (private vulnerability reporting). Include what you found, how to reproduce it, and which release or commit you tested.

You should get a first reply within a week.
