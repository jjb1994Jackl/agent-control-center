# 腾讯 WorkBuddy

状态：接入指南，未开发适配器。[Mac 官方安装指南](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Installation-Mac-Guide)提供 macOS 12+ 及 Apple 芯片、Intel 版本。本机只读观察到 `WorkBuddy.app` 的 Bundle ID 为 `com.tencent.workbuddy.mac`；其他版本自行核对。WorkBuddy 和 CodeBuddy IDE 是不同接入目标。

1. 建议插件 ID `workbuddy`。选用已登录的官方桌面版，核实工作空间、任务列表和历史。先在两个独立任务中验证标识和消息可读；优先同一任务的官方通道，没有证据时再评估授权的辅助功能。
2. 原任务负责执行，工作台只提交文本并读取结果。发送前核对工作区与原任务身份；遇到同名、登录页面、草稿或不可读取时暂停。运行、等确认和完成只有在原任务证据足够时才声明；模型配置不能替代任务通道。
3. 真机验收让两个任务分别返回 `WB-A`、`WB-B`，关闭并重新打开工作台仍对应正确，也不重复发送。没有实测产物、额度或后台启动时，把对应项目标为待验证。
