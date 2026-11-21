# Agent Control Center

[简体中文](README.zh-CN.md) · [Compatibility](docs/compatibility.md) · [Add an Agent](docs/add-agent.md)

A local macOS workbench for sending tasks to your existing desktop agents and reading their replies. Each agent keeps its own account, model, permissions and conversation. This preview does not install vendor apps or include model usage.

## Install on Mac

1. Install [Node.js 22.16 or newer](https://nodejs.org/) with npm and Apple's command-line tools (`xcode-select --install`). Install and sign in to the agent apps you use.
2. Download and unzip the source archive. Run `./install.sh` inside it. Choose whether the workbench and enabled agents should start after you log in to macOS. No `sudo` or Gatekeeper changes are required. An existing service on port 4100 is left untouched; use `PORT=4101 ./install.sh` if needed.
3. Under **Add Agent (+)**, turn on the apps you want. For actions that need Accessibility, grant it to **Agent Control Center Preview** in **System Settings → Privacy & Security → Accessibility** (the app is in `~/Applications`). You do not need to grant it separately to each agent or group.

## Send your first task

Select an Agent and an existing chat in the workbench. Send a small prompt and look for the reply in that same chat. **All Tasks** records explicit task dispatches, not every message sent from the chat composer. Grok Bot direct and group chats use its desktop app; an optional Routine is a separate way to dispatch work to the main Bot, not a requirement for chats. See [operations and Grok configuration](docs/macos.md).

## Troubleshoot or contribute

Run `./doctor.sh` from the source directory, or open **Agent Control Center Preview** from `~/Applications` to launch the installed workbench. The [operations guide](docs/macos.md) also covers upgrades and uninstalling after you delete the source directory.

To add another vendor, follow the [adapter guide](docs/add-agent.md). It includes a runnable example and concrete implementation checklists for [Qianwen Chat](docs/agents/qianwen.md), [QwenWork](docs/agents/qwenwork.md), [Kimi](docs/agents/kimi.md) and [WorkBuddy](docs/agents/workbuddy.md). They are **guides, not installed integrations**.

Built on [Agent Frontdesk 0.3.1](https://github.com/Phz-06/agent-frontdesk/tree/3151d8096813a01613a0fb1e71ef089f0e76a69f). This preview adds the task board, Grok Bot channels and a macOS installer. [MIT license](LICENSE). Not affiliated with the agent vendors.
