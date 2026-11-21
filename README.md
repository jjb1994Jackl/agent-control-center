# Agent Control Center

[下载 Mac 预览版 / Download](https://github.com/jjb1994Jackl/agent-control-center/releases) · [中文使用指南](README.zh-CN.md) · [Compatibility](docs/compatibility.md) · [Add an Agent](docs/add-agent.md)

**一个网页，统一使用 Mac 上的多个 AI Agent。** 在「工作台」选 Agent 和会话，派任务、看回复；在「总览」看派单记录、任务进展和可读取的用量。任务仍在各自的原应用里执行，沿用原账号、模型和权限，不需要额外的统一模型 API。

## Mac 快速开始

1. 安装 [Node.js 22.16+](https://nodejs.org/) 和 Apple 命令行工具（`xcode-select --install`），并登录你要使用的 Agent 桌面应用。
2. 在 [Releases](https://github.com/jjb1994Jackl/agent-control-center/releases) 下载 `agent-control-center-mac-preview.zip`，解压后在该目录运行 `./install.sh`。默认地址为 `http://127.0.0.1:4100`。
3. 点击「添加 Agent（+）」启用应用；按需给 **Agent Control Center Preview** 授予 macOS 辅助功能权限。到「工作台」选择 Agent 和会话，发出第一条消息。

已接入 **Codex、Antigravity、Grok Bot、Claude**，各家能力见[兼容性表](docs/compatibility.md)。Grok 主 Bot 和群组都可在工作台选择，不需要 Routine；Grok 硬停未通过真机验收。千问、千问办公、Kimi 和 WorkBuddy 目前只有接入指南。下载包以 Release 标签为准，`main` 可能包含尚未打包的改动。

## English Quick Start

Agent Control Center is a local macOS workbench for sending tasks to existing desktop agents, reading replies and checking progress and available usage. Each agent runs the task in its own app with its own account, model and permissions.

1. Install [Node.js 22.16+](https://nodejs.org/) and the Apple command-line tools (`xcode-select --install`). Install and sign in to the agent apps you use.
2. Download the Mac preview ZIP from [Releases](https://github.com/jjb1994Jackl/agent-control-center/releases), unzip it and run `./install.sh` in that directory.
3. Under **Add Agent (+)**, enable the apps you use and grant macOS Accessibility to **Agent Control Center Preview** when needed. Select a chat in **Workbench** to send your first task.

Adapters: **Codex, Antigravity, Grok Bot, Claude**. See the [compatibility table](docs/compatibility.md) for limits. Grok supports direct and group chats without a Routine; hard stop for Grok is not verified. Release downloads may lag behind `main`.

[Mac troubleshooting](docs/macos.md) · [Build an adapter](docs/add-agent.md) · [MIT license](LICENSE)

Built on [Agent Frontdesk 0.3.1](https://github.com/Phz-06/agent-frontdesk/tree/3151d8096813a01613a0fb1e71ef089f0e76a69f). Not affiliated with the agent vendors.
