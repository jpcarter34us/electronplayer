#!/usr/bin/env bash
# Builds the Linux and Windows packages in release/, from macOS (or any host
# with Docker): AppImage, .deb and .tar.gz for Linux; an installer and a .zip
# for Windows; each for x64 and arm64.
#
# Usage: package-other.sh [linux-x64 linux-arm64 win-x64 win-arm64 ...]   (default: all)
#
#   1. TypeScript and renderer bundles                 (npm run build, on the host)
#   2. Build containers                                (docker/Dockerfile; cached after the first run)
#   3. Engine, FFmpeg and native addon per target      (build-engine-other.sh, in its container)
#   4. electron-builder packages each target           (in the windows container, which has Wine)
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
targets=("$@")
[[ ${#targets[@]} -gt 0 ]] || targets=(linux-x64 linux-arm64 win-x64 win-arm64)
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    echo "On Windows, build the Windows package natively with: npm run dist:win:native (see README)." >&2
    echo "For the Linux packages, run this from WSL 2 instead, with Docker Desktop's WSL integration on." >&2
    exit 1 ;;
esac
[[ "$root" != /mnt/[a-z]/* ]] || echo "Warning: building from a Windows drive ($root) is very slow, and symlinks may fail. Clone into the WSL file system instead." >&2
command -v docker >/dev/null || { echo "Docker is needed (on macOS: brew install colima docker && colima start)" >&2; exit 1; }

image() {  # image <stage> [DEB_ARCH]
  docker build -q --target "$1" ${2:+--build-arg DEB_ARCH=$2} -t "electronplayer-build:$1" docker >/dev/null
}
run() {  # run <stage> <command...>
  local stage=$1; shift
  mkdir -p build/cache/home
  docker run --rm --init -v "$root:$root" -w "$root" -e HOME="$root/build/cache/home" -e WINEPREFIX=/tmp/wine -e WINEDEBUG=-all -e WINEDLLOVERRIDES="mscoree,mshtml=" \
    -e ELECTRON_CACHE="$root/build/cache/electron" -e ELECTRON_BUILDER_CACHE="$root/build/cache/electron-builder" \
    "electronplayer-build:$stage" "$@"
}

npm run --silent build
image windows
# NSIS runs a 32-bit Windows stub under Wine. Docker VMs (Colima, Docker
# Desktop) register QEMU to run foreign binaries, i386 included, which on an
# x86_64 VM takes over from the native loader and makes Wine crawl. Turn that
# one handler off; it is not needed on x86_64 (the VM re-registers it on restart).
docker run --rm --privileged electronplayer-build:windows sh -c '
  f=/proc/sys/fs/binfmt_misc/qemu-i386
  [ "$(uname -m)" = x86_64 ] || exit 0
  [ -f $f ] || mount -t binfmt_misc binfmt_misc /proc/sys/fs/binfmt_misc 2>/dev/null
  if [ -f $f ] && grep -q enabled $f; then echo 0 > $f; echo "Disabled the qemu-i386 binfmt handler in the Docker VM"; fi'
for target in "${targets[@]}"; do
  case "$target" in
    linux-x64)   stage=linux-x64;   image linux-x64 amd64 ;;
    linux-arm64) stage=linux-arm64; image linux-arm64 arm64 ;;
    win-x64|win-arm64) stage=windows ;;
    *) echo "unknown target: $target" >&2; exit 1 ;;
  esac
  run "$stage" bash scripts/build-engine-other.sh "$target"
  os=${target%-*}; arch=${target#*-}
  # Wine (for the NSIS uninstaller) needs a display, hence Xvfb.
  run windows xvfb-run -a npx electron-builder "--$([[ $os == win ]] && echo win || echo linux)" "--$arch" --publish never
done
ls -1 release/*.AppImage release/*.deb release/*.tar.gz release/*.exe release/*.zip 2>/dev/null | grep -v -- '-mac\|darwin' || true
