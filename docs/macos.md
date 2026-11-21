# Mac 安装、升级与排障

## 日常使用

- 从 `~/Applications/Agent Control Center Preview.app` 或 `http://127.0.0.1:4100/` 打开总览。派单只在「工作台」：每个独立执行轮次会入表，运行中的补充不会重复计数。选了自启，则在**登录进 Mac 桌面后**运行。
- 第一次打开时启用你想用的 Agent。若启用了登录自启，工作台会尝试在后台打开已启用、已安装、尚未运行的应用；各家仍需要自己的账号。不开自启时，先打开所需桌面应用再派单。
- 辅助功能权限只授予 **Agent Control Center Preview**，不是 Terminal 或 Node。仅通过官方会话通道的功能可在无此权限时独立使用；依赖桌面 UI 的功能会受影响。安装器不代授权。

## 安装命令

```sh
./install.sh                    # 首次交互式安装时询问是否登录自启
./install.sh --login            # 或 --no-login，明确修改自启偏好
PORT=4101 ./install.sh          # 默认端口冲突时；后续升级默认保留端口
./doctor.sh
./uninstall.sh
```

下载新版源码包、解压后再运行安装命令即可升级，不覆盖已有任务、启用偏好或钥匙串项。升级前先处理正在派发或等待确认的任务。预览版是本机源码构建，没有自动更新，不是预签名、公证的 DMG。卸载不会关闭原 Agent，也不会删除它们的聊天。

已经删除源码目录，也能执行：

```sh
"$HOME/Library/Application Support/Agent Control Center Preview/control" doctor
"$HOME/Library/Application Support/Agent Control Center Preview/control" uninstall
```

诊断输出区分服务未运行、端口被占、辅助功能无授权、应用未安装、已禁用或待连接。若升级系统后原 Node 路径失效，从新源码目录重新执行安装，恢复服务即可。卸载默认保留 `data/` 和 `logs/`；日志、导出和任务库可能含私有内容，不要随 issue 上传。停止自启后可从 App 图标再次手动启动。

## Grok 会话和旧 Routine

在工作台选主 Bot 或群聊，不需要 Routine。群名重复时先在原应用区分名称。总览需要原会话证据来对应回复；群不在 Grok 桌面端当前视图时，打开对应群再查看。只能证明收到回复时显示「已回复」，不会标为完成。原应用离线或当前目标无法确认时，不要重试发送。

以前通过 Routine 发出的任务仍显示在总览，可点开查看回执。网页没有再次触发 Routine 的入口；保留兼容接口和旧任务回执。仅在维护现有旧配置时，使用下列命令更换自己的 Routine URL 和 key：

```sh
sh "$HOME/Library/Application Support/Agent Control Center Preview/runtime/scripts/configure-grok.sh" --preview
```

凭据留在本机钥匙串，不放在源码或日志里。HTTP 成功只表示受理；看板只有读到匹配编号的原生回执才更新完成。额度若不可读取则显示不可用。
