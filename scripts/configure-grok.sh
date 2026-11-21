#!/bin/sh
set -eu
test -t 0 || { echo '请在 Mac 的交互式终端内运行。' >&2; exit 1; }
service=AgentControlCenter.GrokRoutine
if [ "${1:-}" = --preview ]; then service=AgentControlCenter.Preview.GrokRoutine; fi
echo '从指定 Grok Bot 的 Routine → Webhook 中复制 POST to URL。在密码提示处粘贴（不会回显）。'
/usr/bin/security add-generic-password -U -s "$service" -a url -w
echo '在下一处密码提示中粘贴同一 Routine 的 key（不是整个 HTTP 请求头）。'
/usr/bin/security add-generic-password -U -s "$service" -a key -w
echo '凭据已保存到钥匙串。刷新看板后可做一次真实派单验证。'
