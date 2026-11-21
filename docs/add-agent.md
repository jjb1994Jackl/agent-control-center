# 接入其他桌面 Agent（Mac）

一套插件契约适用于国内外产品。普通用户不执行插件代码；贡献者从源码开发并提 PR。不要从任意 URL 安装插件，插件与服务运行在同一用户权限下。

## 从示例开始

```sh
npm ci --ignore-scripts
node --import tsx --test test/task-board.test.ts
```

[可运行示例](../examples/minimal.plugin.ts) 是测试夹具，不造真实厂商的任务。测试向两个不同的已有会话提交不同任务，验证会话选项、派发、回复归属和重复提交。示例目录不在默认插件发现路径，也不展示为第五个 Agent。

1. 在 `src/server/plugins/<id>.plugin.ts` 建文件。参考示例导出 `about` 和 `setup`；放到插件目录时，把示例的两个导入改成 `../../shared/contract.js` 和 `../types.js`。`about.detect` 仅检测安装，`about.desktopBundle` 可选，返回真实 `.app` 路径给自启服务；不要在检测时打开应用。
2. 用官方安装包在自己的测试账号上核对 App 名称、Bundle ID、版本、芯片、界面语言。优先用能读写**同一个原生会话**的公开通道。官方 API 若只能另开模型对话，不能替代桌面通道。没有合规的公开同会话通道时，评估用户授权的 macOS 辅助功能；不能稳定辨认目标就不要发送。
3. 用 `list`、`read` 和 `status` 提供会话与连接状态。优先用原生稳定 ID；如果只能读到标题，重名时停止，不能按排序或窗口位置猜。原生独立运行可实现 `postMessage`，读取原回复后再对账；只有可靠终态证据才能完成。团队审批、额度、停止、新建与产物逐项验证再声明。不支持创建时设 `capabilities.create: false`，不可读取的额度不填零。
4. 在干净测试账号建两个测试会话，各发一条只需回显不同编号的消息。回到原应用对照两个会话，刷新工作台不得重发；应用离线、无权限、会话重名时不得误发。在本机运行 `npm run check` 和 `npm test`，用 [PR 模板](../.github/pull_request_template.md) 填上证据范围。

接口细节见[插件契约](../skills/add-desktop-engine/references/plugin-contract.md)和[通道选择](../skills/add-desktop-engine/references/channels.md)。不得提取厂商私有凭据，不代过登录、授权和桌面审批，不用另起 CLI 续跑原会话。只有网页的产品先列为候选，不承诺能走 Mac 原生适配器。

## 中文厂商接入目标

| 目标 | 路线 |
|---|---|
| 普通千问 | [桌面聊天](agents/qianwen.md) |
| 千问办公 | [QwenWork 桌面任务](agents/qwenwork.md) |
| Kimi | [Chat 和 Work 模式](agents/kimi.md) |
| 腾讯 WorkBuddy | [原应用任务和回传](agents/workbuddy.md) |
