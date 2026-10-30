#!/usr/bin/env bash
# Builds libaudcore, the headless plugins and the native addon for the
# packaged app, laid out as they will sit inside ElectronPlayer.app/Contents:
#
#   MacOS/                     (bindir: the app executable lives here)
#   Frameworks/engine/         (libdir: libaudcore, libaudtag, audcore.node)
#   Frameworks/engine/audacious/<Type>/*.dylib   (plugins)
#   Resources/engine/          (datadir, locale)
#
# Usage: build-engine-bundle.sh [x64|arm64]   (default: this Mac's)
# Output: build/stage/<arch>/ElectronPlayer.app/Contents
#
# libaudcore rewrites its install paths relative to the running executable
# (set_install_paths in runtime.cc): it trims the trailing folders the
# build-time bindir and the real executable folder share (MacOS, Contents)
# and swaps the remaining prefix. With this layout the plugin folder lands
# inside whichever .app the engine runs from, with no patch to Audacious.
#
# Building arm64 on an Intel Mac cross-compiles against Homebrew's arm64
# bottles, fetched into build/deps-arm64 (scripts/fetch-arm64-deps.py).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
host_arch=$([[ "$(uname -m)" == arm64 ]] && echo arm64 || echo x64)
arch="${1:-$host_arch}"
[[ "$arch" == x64 || "$arch" == arm64 ]] || { echo "unknown arch: $arch" >&2; exit 1; }
contents="$root/build/stage/$arch/ElectronPlayer.app/Contents"
builds="$root/build/engine/$arch"

rm -rf "$root/build/stage/$arch"
mkdir -p "$builds"
export PKG_CONFIG_PATH="$contents/Frameworks/engine/pkgconfig:${PKG_CONFIG_PATH:-}"
layout=(--prefix="$contents" --bindir=MacOS --libdir=Frameworks/engine --datadir=Resources/engine
        --localedir=Resources/engine/locale --mandir=share/man --includedir=include --buildtype=release)
cross=()
if [[ "$arch" != "$host_arch" ]]; then
  [[ "$arch" == arm64 ]] || { echo "cross-building x64 is not set up (Homebrew has no Intel bottles to link)" >&2; exit 1; }
  deps="$root/build/deps-arm64"
  python3 -I "$root/scripts/fetch-arm64-deps.py" "$deps"
  # Only the arm64 libraries are visible to pkg-config, and their merged
  # include/lib folders are searched before the compiler's default
  # /usr/local (Intel Homebrew).
  shopt -s nullglob
  # Homebrew's .pc files for libraries macOS itself provides (libffi, zlib).
  macpc=$(ls -d "$(brew --repository)"/Library/Homebrew/os/mac/pkgconfig/* | sort -V | tail -1)
  pcdirs=("$contents/Frameworks/engine/pkgconfig" "$deps"/opt/*/lib/pkgconfig "$deps"/opt/*/share/pkgconfig "$macpc")
  shopt -u nullglob
  libdirs=$(printf "'%s'," "${pcdirs[@]}"); libdirs="${libdirs%,}"
  min=15.0  # newest minimum among the fetched bottles
  flags="'-arch', 'arm64', '-mmacosx-version-min=$min', '-I$deps/include', '-Wno-poison-system-directories'"
  ldflags="'-arch', 'arm64', '-mmacosx-version-min=$min', '-L$deps/lib', '-Wl,-headerpad_max_install_names'"
  cat > "$builds/cross.ini" <<EOF
[binaries]
c = ['clang', $flags]
cpp = ['clang++', $flags]
objc = ['clang', $flags]
objcpp = ['clang++', $flags]
ar = 'ar'
strip = 'strip'
pkg-config = 'pkg-config'

[built-in options]
c_link_args = [$ldflags]
cpp_link_args = [$ldflags]
objc_link_args = [$ldflags]
objcpp_link_args = [$ldflags]

[properties]
pkg_config_libdir = [$libdirs]

[host_machine]
system = 'darwin'
subsystem = 'macos'
kernel = 'xnu'
cpu_family = 'aarch64'
cpu = 'arm64'
endian = 'little'
EOF
  cross=(--cross-file="$builds/cross.ini")
  export PKG_CONFIG_LIBDIR="$(IFS=:; echo "${pcdirs[*]}")"
fi
reconf() { [[ -d "$1/meson-private" ]] && echo --reconfigure; }

meson setup $(reconf "$builds/audacious") "$builds/audacious" "$root/vendor/audacious" \
  ${cross[@]+"${cross[@]}"} "${layout[@]}" -Dgtk=false -Dqt=false -Ddbus=false
meson install -C "$builds/audacious" --quiet

plugin_opts=(-Dgtk=false -Dqt=false -Dmpris2=false)
meson setup $(reconf "$builds/audacious-plugins") "$builds/audacious-plugins" "$root/vendor/audacious-plugins" \
  ${cross[@]+"${cross[@]}"} "${layout[@]}" "${plugin_opts[@]}"
meson install -C "$builds/audacious-plugins" --quiet

# The native addon, linked against this libaudcore (built in a copy of
# native/ so the development addon in native/build stays as it is).
rm -rf "$builds/native" && mkdir -p "$builds/native"
cp -R "$root/native/binding.gyp" "$root/native/package.json" "$root/native/src" "$builds/native/"
ln -s "$root/native/node_modules" "$builds/native/node_modules"
(cd "$builds/native" && node_modules/.bin/node-gyp rebuild --arch="$arch" \
  --target="$(node -p "require('$root/node_modules/electron/package.json').version")" \
  --dist-url=https://electronjs.org/headers \
  --audcore_include="$contents/include" --audcore_lib="$contents/Frameworks/engine" >/dev/null)
cp "$builds/native/build/Release/audcore.node" "$contents/Frameworks/engine/audcore.node"

# Not shipped: headers, pkg-config files, the stock executables.
rm -rf "$contents/include" "$contents/Frameworks/engine/pkgconfig" "$contents/MacOS" "$contents/share"
echo "Engine ($arch) staged in $contents"
