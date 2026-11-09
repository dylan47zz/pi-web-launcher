#!/bin/sh
set -eu
[ "$(uname -s)" = Darwin ] || { echo 'macOS only.' >&2; exit 1; }
[ "$(id -u)" != 0 ] || { echo 'Do not use sudo/root.' >&2; exit 1; }
if [ "$#" != 1 ] || [ "$1" != --yes ]; then
  echo 'Uninstall stops ONLY the owned launchd job and may interrupt active tasks.' >&2
  echo 'Logs, Pi data, npm pi-web, and manual servers are preserved.' >&2
  echo 'Confirm explicitly: ./scripts/uninstall.sh --yes' >&2
  exit 1
fi
node=$(command -v node || true)
[ -n "$node" ] || { echo 'A working Node on PATH is required to safely uninstall.' >&2; exit 1; }
exec "$node" "$(dirname "$0")/../src/install.mjs" uninstall --yes
