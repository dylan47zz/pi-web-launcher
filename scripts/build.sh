#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
[ "$(uname -s)" = Darwin ] || { echo 'macOS only.' >&2; exit 1; }
# Migrate only our old output; .noindex keeps build copies out of app search.
for dir in dist dist.noindex; do
  if [ -e "$dir" ] || [ -L "$dir" ]; then
    if [ -L "$dir" ] || [ ! -d "$dir" ] || [ -L "$dir/.pi-web-launcher-owner" ] || [ "$(head -n 1 "$dir/.pi-web-launcher-owner" 2>/dev/null || true)" != local.pi-web-launcher ]; then
      echo "Refusing to overwrite unowned $dir/." >&2; exit 1
    fi
  fi
done
stage=$(mktemp -d "$PWD/.build.XXXXXX")
trap 'rm -rf "$stage"' EXIT HUP INT TERM
app="$stage/Pi Web.app"
/usr/bin/osacompile -o "$app" apps/open.applescript
/usr/bin/plutil -insert CFBundleIdentifier -string local.pi-web-launcher "$app/Contents/Info.plist"
printf 'local.pi-web-launcher\n' > "$app/Contents/Resources/.pi-web-launcher-owner"
chmod -R go-w "$app"
# Seal all resources after changing metadata; no certificate or keychain access.
/usr/bin/codesign --force --sign - "$app"
/usr/bin/codesign --verify --deep --strict "$app"
printf 'local.pi-web-launcher\n' > "$stage/.pi-web-launcher-owner"
rm -rf dist dist.noindex
mv "$stage" dist.noindex
printf 'Built dist.noindex/Pi Web.app (not installed or launched).\n'
