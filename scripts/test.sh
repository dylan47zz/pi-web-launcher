#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
[ "$(uname -s)" = Darwin ] || { echo 'macOS native build/plist checks require macOS.' >&2; exit 1; }
./scripts/build.sh
for file in scripts/*.sh; do /bin/sh -n "$file"; done
for file in src/*.mjs tests/*.mjs; do node --check "$file"; done
exec node --test --test-timeout=60000 tests/*.test.mjs
