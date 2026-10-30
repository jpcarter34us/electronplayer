#!/usr/bin/env bash
# Builds libaudcore and every non-GUI plugin from vendor/ into vendor/prefix,
# without GTK or Qt, for the native bridge to link against.
#
# macOS prerequisites:
#   brew install meson ninja pkg-config glib gettext \
#     ffmpeg flac libvorbis opus mpg123 libsndfile wavpack libopenmpt \
#     libmodplug libsidplayfp fluid-synth faad2 libcue neon libsoxr libsamplerate
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
prefix="$root/vendor/prefix"
build="$root/vendor/build"

export PKG_CONFIG_PATH="$prefix/lib/pkgconfig:${PKG_CONFIG_PATH:-}"

# --reconfigure only applies to an existing build dir.
reconf() { [[ -d "$1" ]] && echo --reconfigure; }

meson setup $(reconf "$build/audacious") "$build/audacious" "$root/vendor/audacious" \
  --prefix="$prefix" -Dgtk=false -Dqt=false -Ddbus=false
meson install -C "$build/audacious"

# GUI plugins (gtkui, qtui, skins, Qt/GTK general + vis plugins) drop out
# automatically with gtk/qt off; they are re-implemented in src/renderer.
plugin_opts=()
# MPRIS is D-Bus based and Linux-only; it fails to start on macOS.
[[ "$(uname)" == Darwin ]] && plugin_opts+=(-Dmpris2=false)

meson setup $(reconf "$build/audacious-plugins") "$build/audacious-plugins" "$root/vendor/audacious-plugins" \
  --prefix="$prefix" -Dgtk=false -Dqt=false "${plugin_opts[@]}"
meson install -C "$build/audacious-plugins"

echo "Installed to $prefix"
ls "$prefix/lib/audacious" 2>/dev/null || true
