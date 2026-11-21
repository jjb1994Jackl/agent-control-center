#!/bin/sh
set -eu
if [ "$(uname -s)" != Darwin ]; then echo 'This preview supports macOS only.' >&2; exit 1; fi
if ! command -v node >/dev/null 2>&1; then echo 'Install Node.js 22.16+ (including npm): https://nodejs.org/' >&2; exit 1; fi
root=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
exec node "$root/scripts/macos/manage.mjs" install "$@"
