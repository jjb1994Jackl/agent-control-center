# Agent Control Center

[English](README.md) · [兼容性表](docs/compatibility.md) · [接入新 Agent](docs/add-agent.md)

一个运行在 Mac 上的本地工作台。你选桌面 Agent 和会话，在一个网页里派任务、看回复。不换模型、不替你分工，任务仍由原应用用你的账号、模型和权限执行。工作台免费，各家服务的用量仍按自己的账号计算。

## 安装

1. 安装 [Node.js 22.16 或更新版本](https://nodejs.org/)（需带 npm）和 Apple 命令行工具（终端运行 `xcode-select --install`）。要用哪家 Agent，就先装该应用并登录。
2. 下载源码 ZIP，解压后在目录里执行 `./install.sh`，按提示选择是否登录 Mac 后启动工作台及已启用的 Agent。不需要 `sudo`，也不需要关闭 Gatekeeper。4100 端口被占用时可使用 `PORT=4101 ./install.sh`，脚本不会停掉旧服务。
3. 在网页左侧点 **添加 Agent（+）**，只启用你要用的应用。用到桌面读取或点击时，在 **系统设置 → 隐私与安全性 → 辅助功能** 给 `~/Applications` 里的 **Agent Control Center Preview** 授权；不用给每家 Agent 或每个群重复授权。

## 发送第一条任务

在会话工作台选 Agent 和已有会话，先发一条简单的测试消息，在原会话对应的页面看回复。**全部任务**记录明确从任务页发出的派单，不会自动收录每条聊天。Grok 的一对一聊天和多 Bot 群组直接选会话；只有从任务页派给主 Bot 才需要配置自己的 Routine。详见 [Mac 使用与排障](docs/macos.md)。

## 排障与扩展

运行 `./doctor.sh` 检查连接；平时可在 `~/Applications` 打开 **Agent Control Center Preview**。安装完成后可以删除下载目录，[使用指南](docs/macos.md) 提供不依赖源码目录的诊断、升级和卸载方式。

[接入指南](docs/add-agent.md) 提供可运行的插件示例，以及[普通千问](docs/agents/qianwen.md)、[千问办公](docs/agents/qwenwork.md)、[Kimi](docs/agents/kimi.md)、[WorkBuddy](docs/agents/workbuddy.md) 的具体接入路线。**这四份是开发指南，不是已经可用的适配器。**

基于 [Agent Frontdesk 0.3.1](https://github.com/Phz-06/agent-frontdesk/tree/3151d8096813a01613a0fb1e71ef089f0e76a69f)，新增任务看板、Grok Bot 通道和 Mac 安装流程，保留 [MIT 许可](LICENSE)。本项目不是各 Agent 厂商的官方产品。
