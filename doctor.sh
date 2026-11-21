#!/bin/sh
set -eu
home="$HOME/Library/Application Support/Agent Control Center Preview"
if [ ! -x "$home/control" ]; then echo 'Agent Control Center Preview is not installed. Run ./install.sh first.' >&2; exit 1; fi
exec "$home/control" doctor "$@"
