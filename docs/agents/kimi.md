# Kimi 桌面端：Chat 和 Work

状态：接入指南，未开发适配器。[Kimi 官方下载](https://www.kimi.com/products/download)区分 Apple 芯片上的 Work 和 Intel Mac 客户端的 Chat；两种模式分开验收，不用 Kimi Code CLI 顶替。本机曾只读核对常规 `Kimi.app` 的 Bundle ID 为 `com.moonshot.kimichat`，其他安装版本以本机检查为准，不把另一个名为 KimiCU 的 App 自动视为同一产品。

1. 建议一个 `kimi` 插件分别声明 Chat 和 Work 两种模式，只有对应模式能稳定探测时才启用其能力。检查切换模式后目标 ID 是否复用或变化；只有网页身份或标题时，不猜测对应另一模式的任务。
2. Chat 先实现列会话、发送文本和读回；Work 另验证选择既有任务、请求确认、终态和产物。官方接口无公开同会话证据时，才验证授权后的 Mac 辅助功能。Work 的文件权限和审批保持原应用处理。
3. Chat 测 `KIMI-CHAT-A/B`，Work 测 `KIMI-WORK-A/B`；检查两个模式不串线。如果仅验证 Apple 芯片 Work，就不宣称 Intel Work 支持，也不把 Chat 结果写成 Work 验收。
