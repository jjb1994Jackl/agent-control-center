# Claude 皮肤还原记录

还原的对象：本机 Claude 桌面版的 **Code 标签页**（应用 4.23118.0，Claude Code 2.1.317）。截图是 Claude 在 2026-11-09 用 `screencapture -l <窗口号>` 自己截的，窗口 1512 × 949 pt，2 倍 Retina（截图 3024 × 1898 px，除以 2 就是 CSS 像素）。需要点击才能出现的画面（模型菜单、工具展开、空状态、深色），是用户按清单点开后，由后台每 2 秒一次的自动截图抓到的。

数值来源有三种：
- **截图取色**：用 `px` / `ink` 小工具读取像素（sRGB），见下面各节。
- **测量**：截图上量出的尺寸，已经换算成 CSS 像素。
- **安装包**：`/Applications/Claude.app/Contents/Resources/app.asar` 里的 `MainWindowPage-*.css`，以及 `@font-face`、颜色变量。只读，没有复制进项目。

截图都在 `source/`：

| 文件 | 内容 |
| --- | --- |
| window-light.png / window-dark.png | 整个窗口 |
| sidebar-light.png | 左侧栏 |
| header-light.png | 聊天头部 |
| composer-light.png | 输入框和下方状态行 |
| tools-running-light.png | 折叠的工具行，以及运行中的那一行 |
| tools-expanded-light.png / tools-dark.png | 工具组展开、单条命令展开（深色那张是折叠状态） |
| model-picker-light.png / model-picker-dark.png | 模型选择器打开后 |
| attach-menu-light.png | 「+」菜单 |
| empty-light.png | New session 空状态 |
| side-panel-light.png | 右侧面板（环境、上下文、产物） |
| wrapup-light.png | 一轮结束时的下一步卡片 |

## 整体
- 没有头像，也没有发言者名字。AI 的回答是正文直接排版，不加气泡。只有用户消息是靠右的灰色气泡。
- 配色是中性灰，不是 claude.ai 的米色。

| 区域 | 浅色 | 深色 |
| --- | --- | --- |
| 主区背景 | #ffffff | #212121 |
| 侧栏背景 | #fbfbfb | #292929 |
| 侧栏右边线 | #eaeaea | #3f3f3f |
| 头部下边线 | #e6e6e6 | #454545 |
| 正文 | #202020 | #f2f2f2 |
| 次要文字（工具行、分区标题） | #797979 / #777777 | #a6a6a6 / #afaeae |
| 选中行 | #e7e7e7 | #515151 |
| 用户气泡 | #f5f5f5 | #303030（截图里没有深色气泡，按灰阶推算） |
| 输入框 | 底 #ffffff，边 #e3e3e3 | 底 #3f3f3f，边 #515151 |
| 运行中的小点 | #d58f70（clay #d97757） | 同左 |
| 勾选（模型菜单） | #4f91e1 | 同左 |

- 字体：安装包的 `--font-anthropic-sans` 是 `"anthropic-sans", ui-sans-serif, -apple-system, …, "PingFang SC"`，字体文件是 AnthropicSans*.woff2。工作台在运行时从本机 `app.asar` 读取这些字体（`/api/characters/claude-font-*`，经 `registerAsset` 提供），不复制进项目。读不到时退回 -apple-system / PingFang SC。代码用 `ui-monospace, SFMono-Regular, Menlo`。

## 左侧栏（sidebar-light.png）
- 宽 287。顶部 44 高：左边是侧栏开关和前进、后退；右边是 Chat / Code 切换（一个分段按钮，选中的那段白底）。
- 导航：New、Search、Artifacts、Customize、More。每行图标 18 + 文字 15px，行距 34。
- 分区标题：12–13px，#777，后面跟一个 ⌄。手动分组（例如「中控台」）排在最前面，其余会话按仓库或文件夹名分组（例如 focus-ai）。
- 会话行：15px，行高 34，圆角 8，选中时 #e7e7e7。右侧状态点 6px：橙色 #f0a83a 表示等你处理，灰色表示正在运行或后台。子会话挂在父会话下面，前面有一条「╰」连接线，缩进 16。父会话标题后面带 ⌄，可以折叠。
- 底部：头像（首字母）、名字、Pro、⌄，以及设置齿轮；上面有一条边线。
- 工作台的做法：Chat/Code 切换、Artifacts、Customize、More、账户这几样工作台没有对应功能，所以不画。New 和 Search 用工作台自己的 `new-chat` 和 `session-search`。分组、子会话和状态点的数据都来自桌面版。

## 聊天头部（header-light.png）
- 高 44，底边 1px。标题 15px #202020，后面跟一个 ⌄。右侧 6 个图标按钮，间距 32（任务、终端、改动、浏览器、文件夹、更多）。
- 工作台只做标题、工作目录、`session-info`（放在 ⋯ 的位置），以及 `toggle-sidebar`。没有对应功能的终端、浏览器、改动按钮不放，不放假按钮。

## 消息
- 内容列宽 768（与输入框同宽），左右内边距 18。AI 正文最大宽度约 676。
- 正文 15px，行高约 1.65（列表行距 25）。加粗用 600。行内代码：等宽 13px，底 #f3f3f3，圆角 4，左右内边距 4。
- 用户消息：靠右，底 #f5f5f5，圆角 16，内边距 10 / 16，最大宽度约 80%。
- 一轮里的段落和工具行按真实顺序排列，没有头像。

## 工具调用（tools-running-light.png、tools-expanded-light.png）
- 连续的工具调用合成一行，文字是按种类汇总的，例如「Ran 3 commands」「Read 5 files」「Ran a command, read 2 files」「Ran 6 commands (1 failed)」，后面跟 ›。颜色 #797979，字号和正文一样是 15px，行距 34。
- 截图类的结果：缩略图 48 × 32、圆角 4、1px 边框，排在这一行最右边；超过 3 张时显示「+N」。
- 展开后：组下面是一张卡片，1px 边 #e6e6e6，圆角 12。卡片里每条工具一行（「Ran a command ⌄」）。展开的命令：代码块 1px 边，圆角 8，`$ ` 加命令，等宽 13px，带语法着色；输出直接放在卡片里，等宽 13px，#555。
- 运行中：三个 clay 色小点在动，文字是「Running a command」「Reading xxx.png」，后面跟已用时间（例如「6s」「2m 17s」）。

## 执行步骤清单
- 桌面版的任务清单（`mcp__ccd_turn__update_plan`）在这一轮正在运行时，截图里看不到（会话头部的列表图标打开的是另一个面板）。工作台把它画成本轮最后一段文字下面的一张简洁清单：每个步骤前有一个圈，进行中的步骤用 clay 色，已完成的步骤打勾、文字变灰。这一点是推断，**没有截图依据**。

## 结尾的下一步卡片（wrapup-light.png）
- 1px 边 #e6e6e6，圆角 12，内边距 16 / 20。总结文字 15px #6b6b6b；问题 15px #202020；按钮是深色底白字、圆角 6 的小按钮（深色主题下反过来）。
- 数据来自 `mcp__ccd_turn__wrap_up` 的 recap / ask / actions。在工作台里只展示，按钮不可点（不能代用户在桌面版里点）。

## 输入框（composer-light.png、attach-menu-light.png）
- 宽 768，居中；高 45（单行），圆角 16，1px 边，阴影很轻（0 1px 2px #0000000d）。
- 左边「+」（18，细线），打开菜单。右边依次是话筒（工作台共用的听写按钮，样子换成桌面版的话筒图标），运行时是停止键（实心圆角方块 14），空闲时没有发送按钮（按 Enter 发送）。
- 输入框下方右对齐一行 13–14px：「Opus 5.5」（#202020）、「Medium」（#6b6b6b）、「Auto」（权限模式），再加一个额度小圆环。点「Opus 5.5 Medium」打开模型菜单。
- 占位文字：会话里是「Type / for commands」，新会话是「Describe a task or ask a question」，颜色 #999。
- 工作台的做法：发送按钮保留（#send 必须存在），但样式改成和停止键同位置的实心小按钮，只在有内容时出现。额度条属于 Agent 栏的共用部分，这里不重复画。

## 模型选择器（model-picker-light.png / -dark.png）
- 向上弹出，宽约 270，圆角 12，1px 边 #e5e5e5（深色是 #484848），底 #fff（深色是 #3f3f3f），阴影 popover。
- 每行 28 高，只有名称（15px），**没有说明文字**。当前模型右侧是蓝色 ✓，其他模型右侧是快捷编号 2/3/4（#797979）。Fable 后面带一个「Requires usage credits」小标签。
- 分隔线下面是「Effort Medium ›」「More models ›」，再往下是「Fast mode」分组。
- 工作台的做法：用工作台自己的菜单组件（`data-for="model"`），名称来自 SDK 的 `list_models`。`description` 照样返回，但皮肤里把它隐藏，和桌面版一致。推理强度是另一个菜单（`#effort`），样式改成同一套。Fast mode、More models 工作台没有，不画。

## 空状态（empty-light.png）
- 头部标题是「New session」，正中间是像素 Clawd 和一张文件夹选择卡片，下方是「Waiting …」的会话提示。
- 工作台的做法：保留 `data-action="new-chat"` 按钮。用居中的简洁空状态和桌面版的占位文案，不画环境选择。

## 与工作台默认样式的差异（总结）
去掉头像和发言者、去掉 AI 气泡；工具改为汇总成一行，展开后是卡片；侧栏按桌面版分组；输入框改为药丸形，模型和推理强度放到输入框下方右侧；中性灰配色；字体用 Anthropic Sans。

## 做不到 / 不一致的地方
- 桌面版的 Chat/Code 切换、Artifacts、Customize、终端、浏览器、改动面板、Fast mode、环境选择：工作台没有这些功能，不画假按钮。
- 深色下的展开工具和深色空状态没有截到（用户在深色下没有打开它们），按同一套灰阶推算。
- 任务清单在桌面版里的确切样子没有截到，见上文。

## 并排对比（最后一轮）
- `compare-light.png`：左边是桌面版，右边是工作台，打开同一个会话（这次排练会话本身），窗口都是 1512 × 949、2 倍分辨率。
- `compare-dark.png`：左边是桌面版深色（自动截图循环拍下的同一会话），右边是工作台深色。
- `workbench-narrow-light.png`：390 宽，没有横向溢出。
- `other-engine-unaffected.png`：切到 Codex 后皮肤完全不生效（字体 Inter、侧栏 260、输入框两行，「Auto」那行隐藏）。
- 工作台的截图工具：用无头 Chrome 的 DevTools 协议，设备缩放 2，用 `prefers-color-scheme` 切换浅色和深色。

对比中修掉的地方：
- 侧栏行字号 15 → 14、行高 34 → 32；
- 任务清单卡片改成和整列同宽，已完成的步骤用实心勾、文字变灰，待办的步骤用虚线圈，进行中的用转动的半圈；
- 输入框改成单行（46 高，桌面版 45）；
- 「Opus 5.5 Medium」和「Auto」放到同一行，间距 17；
- 单条命令的工具行写成「Ran sed…」。

剩下的差别（有意保留或做不到）：
- Agent 栏（角色、额度、对话框）在页面最左边，是工作台共用的部分；窗口四周留 8 px 边距，所以工作台里的页面比桌面版窄一条栏宽（紧凑时 72 px）。
- 侧栏和聊天头部的布局现在是所有引擎共用的一套（头部的头像和模式菜单、带边框的新建聊天、填充式搜索框、带展开箭头的项目树、48 px 高的聊天头部和「在 Claude 打开」按钮），不再按桌面版逐像素还原；上面「左侧栏」「聊天头部」两节里量的尺寸只作记录。对话区里桌面版自己画的东西（回复正文、工具行、Thinking、步骤清单、收尾卡片、输入框和模型行）仍按桌面版还原，不重新设计。
- 正文宽度：桌面版的 Anthropic Sans 比工作台宽约 2%，原因可能是桌面版的 rem 缩放，没有再去追。
- 工具行的动词：浏览器类工具，桌面版写成「opened a page」「started preview」这样的具体说法，工作台统一写成「used N tools」，因为工作台的公开事件里不带原始工具名。
- 运行时长（「2m 8s」）：工具事件里没有开始时间，所以不显示。
- 桌面版的「Approaching 5-hour limit」横幅：工作台没有，额度在 Agent 栏头像下的额度条里显示。工作台自己的「正在执行 · 请在桌面端停止任务」和「不能发送」的说明保留，这是工作台必须说清楚的状态。
- 会话正在桌面版里运行时，输入框占位文字是「此会话当前只读」，桌面版是「⏎ to send」。
