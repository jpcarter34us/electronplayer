#!/usr/bin/env bash
# Builds libaudcore, the headless plugins and the native addon for the Windows
# package on Windows itself, without WSL or Docker: in MSYS2's UCRT64
# environment, with MinGW-w64 GCC as upstream Audacious's own Windows builds
# use, against MSYS2's libraries. The result has the same layout as
# build-engine-other.sh win-x64 stages (see there): build/stage/win-x64/app/engine.
#
# scripts/package-win-native.mjs (npm run dist:win:native) runs this with
# EP_ROOT set to the repository. Paths are passed to MinGW programs in mixed
# form (C:/...), which both they and MSYS2's own tools accept. FFmpeg can't be
# built in a folder with spaces, so when the repository is in one (C:\Users\
# First Last\...), the work happens in C:\electronplayer-build instead, or in
# EP_BUILD_DIR if set.
set -euo pipefail

[[ ${MSYSTEM:-} == UCRT64 ]] || { echo "Run this in MSYS2's UCRT64 environment (npm run dist:win:native does)." >&2; exit 1; }
target=win-x64
root=$(cygpath -m "$EP_ROOT")
work=${EP_BUILD_DIR:-$root/build/win-native}
if [[ $work == *' '* ]]; then
  work="${SYSTEMDRIVE:-C:}/electronplayer-build"
  echo "The repository path has spaces, which FFmpeg's build can't handle; building in $work"
fi
work=$(cygpath -m "$work")
app="$work/app"
builds="$work/engine"
deps="$work/deps"
src="$work/src"
stage="$root/build/stage/$target/app"
electron=$ELECTRON_VERSION
jobs=$(nproc)

# --- Toolchain and libraries (MSYS2 packages) --------------------------------
# The libraries match scripts/fetch-msys2-deps.py, which the container build uses.
p=mingw-w64-ucrt-x86_64-
pkgs=(make diffutils patch tar xz curl
      ${p}gcc ${p}lld ${p}meson ${p}ninja ${p}pkgconf ${p}nasm ${p}gettext-tools ${p}python)
for lib in glib2 gettext-runtime flac libvorbis libogg opus opusfile mpg123 lame libsndfile wavpack \
           libopenmpt libmodplug libsidplayfp fluidsynth faad2 libcue neon libsoxr libsamplerate \
           libbs2b libxml2 curl; do
  pkgs+=("$p$lib")
done
if [[ -n $(pacman -T "${pkgs[@]}" || true) ]]; then
  echo "Installing the MSYS2 packages the build needs (if MSYS2 updates itself and stops, run the build again)..."
  pacman -Syu --needed --noconfirm "${pkgs[@]}"
fi

# --- Sources -----------------------------------------------------------------
# Exported from the submodules with LF line endings (Git for Windows may have
# checked them out with CRLF), with patches/ applied. The submodules
# themselves are left as they are. Exported again only when a submodule's
# commit or its patches change, so later builds are incremental.
mkdir -p "$src" "$builds" "$deps"
for name in audacious audacious-plugins; do
  [[ -f "$root/vendor/$name/meson.build" ]] || {
    echo "vendor/$name is empty. Run: git submodule update --init --depth 1" >&2; exit 1; }
  shopt -s nullglob; patches=("$root/patches/$name"/*.patch); shopt -u nullglob
  stamp="$(git -C "$root/vendor/$name" rev-parse HEAD) $(cat "${patches[@]}" /dev/null | tr -d '\r' | sha256sum | cut -c1-16)"
  if [[ ! -f "$src/$name/.stamp" || $(<"$src/$name/.stamp") != "$stamp" ]]; then
    rm -rf "$src/$name" "$builds/$name" && mkdir -p "$src/$name"
    git -C "$root/vendor/$name" -c core.autocrlf=false archive HEAD | tar -x -C "$src/$name"
    for patch in "${patches[@]}"; do
      tr -d '\r' < "$patch" | patch -p1 -s -d "$src/$name"
      echo "Applied $(basename "$patch") to $name"
    done
    echo "$stamp" > "$src/$name/.stamp"
  fi
done

# --- FFmpeg, audio only (as in build-engine-other.sh) -------------------------
FFMPEG=7.1.1
if [[ ! -f "$deps/ffmpeg/.done-$FFMPEG" ]]; then
  ffsrc="$work/cache/ffmpeg-$FFMPEG"
  if [[ ! -d "$ffsrc" ]]; then
    mkdir -p "$work/cache"
    curl -fsSL "https://ffmpeg.org/releases/ffmpeg-$FFMPEG.tar.xz" | tar -xJ -C "$(cygpath -u "$work/cache")"
  fi
  rm -rf "$builds/ffmpeg" "$deps/ffmpeg" && mkdir -p "$builds/ffmpeg"
  ff=(--prefix="$deps/ffmpeg" --enable-shared --disable-static --enable-pic --disable-autodetect
      --disable-programs --disable-doc --disable-debug --disable-network --disable-avdevice
      --disable-avfilter --disable-swscale --disable-postproc --disable-encoders --disable-muxers
      --disable-hwaccels --disable-devices --disable-bsfs --enable-bsf=aac_adtstoasc,mp3_header_decompress
      --disable-protocols --enable-protocol=file,pipe)
  echo "Building FFmpeg (configure takes a few minutes on Windows)..."
  (cd "$builds/ffmpeg" && "$(cygpath -u "$ffsrc")/configure" "${ff[@]}" >/dev/null && make -j"$jobs" >/dev/null && make install >/dev/null)
  touch "$deps/ffmpeg/.done-$FFMPEG"
fi

# --- Audacious ---------------------------------------------------------------
export PKG_CONFIG_PATH="$app/engine/pkgconfig;$deps/ffmpeg/lib/pkgconfig"
layout=(--prefix="$app" --bindir=. --libdir=engine --datadir=engine/share --localedir=engine/share/locale
        --includedir=include --mandir=share/man --buildtype=release
        -Dc_args="-I$deps/ffmpeg/include" -Dcpp_args="-I$deps/ffmpeg/include"
        -Dc_link_args="-L$deps/ffmpeg/lib -lpthread" -Dcpp_link_args="-L$deps/ffmpeg/lib -lpthread")
reconf() { [[ -f "$1/meson-private/coredata.dat" ]] && echo --reconfigure; }

meson setup $(reconf "$builds/audacious") "$builds/audacious" "$src/audacious" \
  "${layout[@]}" -Dgtk=false -Dqt=false -Ddbus=false
meson install -C "$builds/audacious" --quiet

plugin_opts=(-Dgtk=false -Dqt=false -Dmac-now-playing=false)
plugin_opts+=(-Dadplug=false -Dcdaudio=false -Dmms=false -Dlirc=false -Dnotify=false -Dsdlout=false
              -Doss=false -Dsndio=false -Dqtaudio=false -Dladspa=false -Dhotkey=false -Daosd=false
              -Dmpris2=false -Dalsa=false -Dpulse=false -Dpipewire=false -Djack=false)
meson setup $(reconf "$builds/audacious-plugins") "$builds/audacious-plugins" "$src/audacious-plugins" \
  "${layout[@]}" "${plugin_opts[@]}"
meson install -C "$builds/audacious-plugins" --quiet

# Windows puts DLLs in bindir; keep the app folder to Electron's own files.
shopt -s nullglob; dlls=("$app"/*.dll); shopt -u nullglob
(( ${#dlls[@]} == 0 )) || mv "${dlls[@]}" "$app/engine/"

# --- Native addon ------------------------------------------------------------
# Compiled directly, as in the container build: node-gyp would use MSVC, whose
# C++ library can't mix with the engine's. lld does the delay-loading of
# node.exe that win_delay_load_hook.cc redirects to the running executable.
headers="$work/cache/electron-headers-$electron"
if [[ ! -d "$headers/include/node" ]]; then
  mkdir -p "$headers"
  curl -fsSL "https://electronjs.org/headers/v$electron/node-v$electron-headers.tar.gz" | tar -xz -C "$(cygpath -u "$headers")" --strip-components=1
fi
nodelib="$headers/win-x64-node.lib"
[[ -f "$nodelib" ]] || curl -fsSL -o "$nodelib" "https://electronjs.org/headers/v$electron/win-x64/node.lib"
g++ -shared -O2 -std=c++17 -DNAPI_VERSION=9 -DNAPI_DISABLE_CPP_EXCEPTIONS -DBUILDING_NODE_EXTENSION \
  -I"$(cygpath -m "$NAPI_INC")" -I"$headers/include/node" -I"$app/include" \
  "$root/native/src/addon.cc" "$root/native/src/win_delay_load_hook.cc" -o "$app/engine/audcore.node" \
  -L"$app/engine" -laudcore "$nodelib" -fuse-ld=lld -Wl,--delayload=node.exe -ldelayimp

# --- Bundle libraries, strip, tidy -------------------------------------------
BUNDLE_LIB_DIRS="$(cygpath -m "$MINGW_PREFIX/bin")" OBJDUMP=objdump STRIP=strip \
  python3 "$root/scripts/bundle-libs-other.py" "$app/engine" "$target" "$deps"
rm -rf "$app/include" "$app/engine/pkgconfig" "$app/share" "$app/engine/share/applications" \
  "$app/engine/share/icons" "$app/engine/share/metainfo" "$app/engine/share/man"
find "$app" -maxdepth 1 -type f -delete   # the stock audacious/audtool executables
find "$app/engine" -name '*.a' -delete

rm -rf "$stage" && mkdir -p "$stage"
cp -r "$app/engine" "$stage/engine"
echo "Engine ($target) staged in $stage/engine"
