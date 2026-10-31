#!/usr/bin/env bash
# Builds libaudcore, the headless plugins and the native addon for a Linux
# or Windows package, laid out as they will sit in the installed app folder:
#
#   <app>/                         (bindir: the app executable lives here)
#   <app>/engine/                  (libdir: libaudcore, audcore.node, libraries)
#   <app>/engine/audacious/<Type>/ (plugins)
#   <app>/engine/share/            (datadir, locale)
#
# As on macOS (see build-engine-bundle.sh), libaudcore relocates its install
# paths from the build-time bindir to the running executable's folder, so the
# plugins are found wherever the app is installed or the AppImage is mounted.
#
# Runs inside the build containers (docker/Dockerfile); scripts/package-other.sh
# starts it. Usage: build-engine-other.sh linux-x64|linux-arm64|win-x64|win-arm64
# Output: build/stage/<target>/app/engine
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
bash "$root/scripts/apply-patches.sh"
target="$1"
case "$target" in
  linux-x64)   os=linux;   arch=x64;   triple=x86_64-linux-gnu ;;
  linux-arm64) os=linux;   arch=arm64; triple=aarch64-linux-gnu ;;
  win-x64)     os=windows; arch=x64;   triple=x86_64-w64-mingw32 ;;
  win-arm64)   os=windows; arch=arm64; triple=aarch64-w64-mingw32 ;;
  *) echo "unknown target: $target" >&2; exit 1 ;;
esac
cpu=$([[ $arch == x64 ]] && echo x86_64 || echo aarch64)
app="$root/build/stage/$target/app"
builds="$root/build/engine/$target"
deps="$root/build/deps-$target"
electron=$(node -p "require('$root/node_modules/electron/package.json').version")
jobs=$(nproc)

rm -rf "$root/build/stage/$target"
mkdir -p "$builds" "$deps"

# --- Toolchain ---------------------------------------------------------------
pcdirs=("$app/engine/pkgconfig" "$deps/ffmpeg/lib/pkgconfig")
if [[ $os == linux ]]; then
  if [[ $arch == x64 ]]; then cc=gcc; cxx=g++; else cc=$triple-gcc; cxx=$triple-g++; fi
  ar=$([[ $arch == x64 ]] && echo ar || echo $triple-ar)
  strip=$([[ $arch == x64 ]] && echo strip || echo $triple-strip)
  pcdirs+=("/usr/lib/$triple/pkgconfig" /usr/share/pkgconfig)
  system=linux
else
  cc=$triple-clang; cxx=$triple-clang++; ar=llvm-ar; strip=llvm-strip
  repo=$([[ $arch == x64 ]] && echo clang64 || echo clangarm64)
  python3 -I "$root/scripts/fetch-msys2-deps.py" "$repo" "$deps/msys2"
  # MSYS2's .pc files say prefix=/clang64; point them at where they were unpacked.
  sed -i "s|^prefix=/$repo\$|prefix=$deps/msys2/$repo|" "$deps/msys2/$repo"/lib/pkgconfig/*.pc "$deps/msys2/$repo"/share/pkgconfig/*.pc 2>/dev/null || true
  pcdirs+=("$deps/msys2/$repo/lib/pkgconfig" "$deps/msys2/$repo/share/pkgconfig")
  system=windows
fi
export PKG_CONFIG_LIBDIR="$(IFS=:; echo "${pcdirs[*]}")"

q() { printf "'%s'," "$@" | sed 's/,$//'; }
cflags=(-I"$deps/ffmpeg/include")
ldflags=(-L"$deps/ffmpeg/lib")
if [[ $os == windows ]]; then
  cflags+=(-I"$deps/msys2/$repo/include")
  ldflags+=(-L"$deps/msys2/$repo/lib" -lpthread)  # libaudcore uses pthread TLS directly
fi
cat > "$builds/cross.ini.new" <<EOF
[binaries]
c = '$cc'
cpp = '$cxx'
ar = '$ar'
strip = '$strip'
pkgconfig = 'pkg-config'
$([[ $os == windows ]] && echo "windres = '$triple-windres'")

[built-in options]
c_args = [$(q "${cflags[@]}")]
cpp_args = [$(q "${cflags[@]}")]
c_link_args = [$(q "${ldflags[@]}")]
cpp_link_args = [$(q "${ldflags[@]}")]

[properties]
pkg_config_libdir = [$(q "${pcdirs[@]}")]

[host_machine]
system = '$system'
cpu_family = '$cpu'
cpu = '$cpu'
endian = 'little'
EOF
# Meson reads a cross file only at setup, so start over when it changes.
if ! cmp -s "$builds/cross.ini.new" "$builds/cross.ini"; then
  rm -rf "$builds/audacious" "$builds/audacious-plugins"
  mv "$builds/cross.ini.new" "$builds/cross.ini"
else
  rm "$builds/cross.ini.new"
fi

# --- FFmpeg, audio only ------------------------------------------------------
# Distribution FFmpeg builds pull in every video codec and hardware API;
# this one has the demuxers and decoders and nothing else external.
FFMPEG=7.1.1
if [[ ! -f "$deps/ffmpeg/.done-$FFMPEG" ]]; then
  src="$root/build/cache/ffmpeg-$FFMPEG"
  if [[ ! -d "$src" ]]; then
    mkdir -p "$root/build/cache"
    curl -fsSL "https://ffmpeg.org/releases/ffmpeg-$FFMPEG.tar.xz" | tar -xJ -C "$root/build/cache"
  fi
  rm -rf "$builds/ffmpeg" "$deps/ffmpeg" && mkdir -p "$builds/ffmpeg"
  ff=(--prefix="$deps/ffmpeg" --enable-shared --disable-static --enable-pic --disable-autodetect
      --disable-programs --disable-doc --disable-debug --disable-network --disable-avdevice
      --disable-avfilter --disable-swscale --disable-postproc --disable-encoders --disable-muxers
      --disable-hwaccels --disable-devices --disable-bsfs --enable-bsf=aac_adtstoasc,mp3_header_decompress
      --disable-protocols --enable-protocol=file,pipe)
  [[ $os == linux && $arch == arm64 ]] && ff+=(--enable-cross-compile --target-os=linux --arch=aarch64 --cross-prefix=$triple-)
  [[ $os == windows ]] && ff+=(--enable-cross-compile --target-os=mingw32 --arch=$cpu --cross-prefix=$triple-
                              --cc=$cc --cxx=$cxx --ar=llvm-ar --nm=llvm-nm --ranlib=llvm-ranlib --strip=llvm-strip)
  (cd "$builds/ffmpeg" && "$src/configure" "${ff[@]}" >/dev/null && make -j"$jobs" >/dev/null && make install >/dev/null)
  touch "$deps/ffmpeg/.done-$FFMPEG"
fi

# --- Audacious ---------------------------------------------------------------
layout=(--prefix="$app" --bindir=. --libdir=engine --datadir=engine/share --localedir=engine/share/locale
        --includedir=include --mandir=share/man --buildtype=release --cross-file="$builds/cross.ini")
reconf() { [[ -f "$1/meson-private/coredata.dat" ]] && echo --reconfigure; }

meson setup $(reconf "$builds/audacious") "$builds/audacious" "$root/vendor/audacious" \
  "${layout[@]}" -Dgtk=false -Dqt=false -Ddbus=false
meson install -C "$builds/audacious" --quiet

plugin_opts=(-Dgtk=false -Dqt=false -Dmac-now-playing=false)
# Not wanted, or not buildable from these libraries.
plugin_opts+=(-Dadplug=false -Dcdaudio=false -Dmms=false -Dlirc=false -Dnotify=false -Dsdlout=false
              -Doss=false -Dsndio=false -Dqtaudio=false -Dladspa=false -Dhotkey=false -Daosd=false)
[[ $os == windows ]] && plugin_opts+=(-Dmpris2=false -Dalsa=false -Dpulse=false -Dpipewire=false -Djack=false)
meson setup $(reconf "$builds/audacious-plugins") "$builds/audacious-plugins" "$root/vendor/audacious-plugins" \
  "${layout[@]}" "${plugin_opts[@]}"
meson install -C "$builds/audacious-plugins" --quiet

# Windows puts DLLs in bindir; keep the app folder to Electron's own files.
if [[ $os == windows ]]; then
  mv "$app"/*.dll "$app/engine/"
fi

# --- Native addon ------------------------------------------------------------
napi_inc=$(node -p "require('$root/native/node_modules/node-addon-api').include_dir")
if [[ $os == linux ]]; then
  rm -rf "$builds/native" && mkdir -p "$builds/native"
  cp -R "$root/native/binding.gyp" "$root/native/package.json" "$root/native/src" "$builds/native/"
  ln -s "$root/native/node_modules" "$builds/native/node_modules"
  (cd "$builds/native" && CC=$cc CXX=$cxx LINK=$cxx AR=$ar node_modules/.bin/node-gyp rebuild --arch="$arch" \
    --target="$electron" --dist-url=https://electronjs.org/headers \
    --audcore_include="$app/include" --audcore_lib="$app/engine" >/dev/null)
  cp "$builds/native/build/Release/audcore.node" "$app/engine/audcore.node"
else
  # node-gyp cannot target Windows from Linux, so compile it directly. N-API
  # functions are exported by the Electron executable; node-gyp's delay-load
  # hook points imports from "node.exe" at whatever executable loaded us.
  headers="$root/build/cache/electron-headers-$electron"
  if [[ ! -d "$headers/include/node" ]]; then
    mkdir -p "$headers"
    curl -fsSL "https://electronjs.org/headers/v$electron/node-v$electron-headers.tar.gz" | tar -xz -C "$headers" --strip-components=1
  fi
  nodelib="$headers/win-$arch-node.lib"
  [[ -f "$nodelib" ]] || curl -fsSL -o "$nodelib" "https://electronjs.org/headers/v$electron/win-$arch/node.lib"
  hook="$root/native/node_modules/node-gyp/src/win_delay_load_hook.cc"
  $cxx -shared -O2 -std=c++17 -DNAPI_VERSION=9 -DNAPI_DISABLE_CPP_EXCEPTIONS -DBUILDING_NODE_EXTENSION -DHOST_BINARY=\"node.exe\" \
    -I"$napi_inc" -I"$headers/include/node" -I"$app/include" \
    "$root/native/src/addon.cc" "$hook" -o "$app/engine/audcore.node" \
    -L"$app/engine" -laudcore "$nodelib" -Wl,--delayload=node.exe -ldelayimp -static-libgcc
fi

# --- Bundle libraries, strip, tidy -------------------------------------------
python3 -I "$root/scripts/bundle-libs-other.py" "$app/engine" "$target" "$deps"
rm -rf "$app/include" "$app/engine/pkgconfig" "$app/share" "$app/engine/share/applications" \
  "$app/engine/share/icons" "$app/engine/share/metainfo" "$app/engine/share/man"
find "$app" -maxdepth 1 -type f -delete   # the stock audacious/audtool executables
find "$app/engine" -name '*.a' -delete
echo "Engine ($target) staged in $app/engine"
