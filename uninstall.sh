#!/bin/sh
set -eu
home="$HOME/Library/Application Support/Agent Control Center Preview"
if [ ! -x "$home/control" ]; then echo 'Agent Control Center Preview is not installed.'; exit 0; fi
exec "$home/control" uninstall "$@"
