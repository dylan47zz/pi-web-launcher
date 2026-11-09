#!/bin/sh
set -eu
[ "$(uname -s)" = Darwin ] || { echo 'macOS only.' >&2; exit 1; }
[ "$(id -u)" != 0 ] || { echo 'Do not use sudo/root.' >&2; exit 1; }
node=$(command -v node || true)
[ -n "$node" ] || { echo 'Node is missing from PATH.' >&2; exit 1; }
exec "$node" "$(dirname "$0")/../src/install.mjs" install "$@"
