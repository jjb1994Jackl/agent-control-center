# Agent Control Center

[English](README.md) · [下载 Mac 预览版](https://github.com/jjb1994Jackl/agent-control-center/releases) · [兼容性表](docs/compatibility.md) · [接入新 Agent](docs/add-agent.md)

一个运行在 Mac 上的本地工作台。你选桌面 Agent 和会话，在一个网页里派任务、看回复。不换模型、不替你分工，任务仍由原应用用你的账号、模型和权限执行。工作台免费，各家服务的用量仍按自己的账号计算。

## 安装

1. 安装 [Node.js 22.16 或更新版本](https://nodejs.org/)（需带 npm）和 Apple 命令行工具（终端运行 `xcode-select --install`）。要用哪家 Agent，就先装该应用并登录。
2. 在 Releases 下载 `agent-control-center-mac-preview.zip`，解压后在目录里执行 `./install.sh`。按提示选择是否登录 Mac 后启动工作台及已启用的 Agent。不需要 `sudo`，也不需要关闭 Gatekeeper。4100 端口被占用时可使用 `PORT=4101 ./install.sh`，脚本不会停掉旧服务。下载包以 Release 标签为准，`main` 可能包含尚未打包的改动。
3. 在网页左侧点 **添加 Agent（+）**，只启用你要用的应用。用到桌面读取或点击时，在 **系统设置 → 隐私与安全性 → 辅助功能** 给 `~/Applications` 里的 **Agent Control Center Preview** 授权；不用给每家 Agent 或每个群重复授权。

## 发送第一条任务

打开控制中心先看**总览**：待处理的任务、最近回执以及已启用 Agent 的额度。点**工作台**，选择 Agent 和已有会话并发送；从工作台发出的独立执行轮次会自动进入总览，从原应用发出的消息不会导入。Grok 的主 Bot 和群组都在工作台里选择，不需要配置 Routine。详见 [Mac 使用与排障](docs/macos.md)。

侧栏区分原应用置顶与仅在当前浏览器置顶。**停止当前任务**走原应用的停止通道；**暂停队列**只拦住该会话里尚未发出的工作台消息。Grok 主 Bot 真机运行时未出现可操作的原生停止按钮，硬停未验收。

## 排障与扩展

运行 `./doctor.sh` 检查连接；平时可在 `~/Applications` 打开 **Agent Control Center Preview**。安装完成后可以删除下载目录，[使用指南](docs/macos.md) 提供不依赖源码目录的诊断、升级和卸载方式。

[接入指南](docs/add-agent.md) 提供可运行的插件示例，以及[普通千问](docs/agents/qianwen.md)、[千问办公](docs/agents/qwenwork.md)、[Kimi](docs/agents/kimi.md)、[WorkBuddy](docs/agents/workbuddy.md) 的具体接入路线。**这四份是开发指南，不是已经可用的适配器。**

基于 [Agent Frontdesk 0.3.1](https://github.com/Phz-06/agent-frontdesk/tree/3151d8096813a01613a0fb1e71ef089f0e76a69f)，新增任务看板、Grok Bot 通道和 Mac 安装流程，保留 [MIT 许可](LICENSE)。本项目不是各 Agent 厂商的官方产品。
