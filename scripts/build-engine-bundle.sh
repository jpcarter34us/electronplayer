#!/usr/bin/env bash
# Builds libaudcore and the headless plugins for the packaged app, laid out
# as they will sit inside ElectronPlayer.app/Contents:
#
#   MacOS/                     (bindir: the app executable lives here)
#   Frameworks/engine/         (libdir: libaudcore, libaudtag)
#   Frameworks/engine/audacious/<Type>/*.dylib   (plugins)
#   Resources/engine/          (datadir, locale)
#
# libaudcore rewrites its install paths relative to the running executable
# (set_install_paths in runtime.cc): it trims the trailing folders the
# build-time bindir and the real executable folder share (MacOS, Contents)
# and swaps the remaining prefix. With this layout the plugin folder lands
# inside whichever .app the engine runs from, with no patch to Audacious.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
contents="$root/build/stage/ElectronPlayer.app/Contents"
builds="$root/build/engine"

rm -rf "$root/build/stage"
export PKG_CONFIG_PATH="$contents/Frameworks/engine/pkgconfig:${PKG_CONFIG_PATH:-}"
layout=(--prefix="$contents" --bindir=MacOS --libdir=Frameworks/engine --datadir=Resources/engine
        --localedir=Resources/engine/locale --mandir=share/man --includedir=include --buildtype=release)
reconf() { [[ -d "$1" ]] && echo --reconfigure; }

meson setup $(reconf "$builds/audacious") "$builds/audacious" "$root/vendor/audacious" \
  "${layout[@]}" -Dgtk=false -Dqt=false -Ddbus=false
meson install -C "$builds/audacious" --quiet

plugin_opts=(-Dgtk=false -Dqt=false)
[[ "$(uname)" == Darwin ]] && plugin_opts+=(-Dmpris2=false)
meson setup $(reconf "$builds/audacious-plugins") "$builds/audacious-plugins" "$root/vendor/audacious-plugins" \
  "${layout[@]}" "${plugin_opts[@]}"
meson install -C "$builds/audacious-plugins" --quiet

# Not shipped: headers, pkg-config files, the stock executables.
rm -rf "$contents/include" "$contents/Frameworks/engine/pkgconfig" "$contents/MacOS" "$contents/share"
echo "Engine staged in $contents"
