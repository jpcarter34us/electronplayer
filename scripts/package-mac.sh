#!/usr/bin/env bash
# Builds ElectronPlayer.app, a .dmg and a .zip in release/ for each macOS
# architecture, ad-hoc signed (runs on your own Macs; Macs you hand it to
# need a Developer ID signature and notarization).
#
# Usage: package-mac.sh [x64|arm64 ...]   (default: both)
#
#   1. TypeScript and renderer bundles                 (npm run build)
#   2. Engine and native addon in app-bundle layout    (build-engine-bundle.sh <arch>)
#   3. Homebrew libraries copied in, every reference repointed (bundle-dylibs.py)
#   4. electron-builder assembles the app; scripts/adhoc-sign.cjs signs it
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
archs=("$@")
[[ ${#archs[@]} -gt 0 ]] || archs=(x64 arm64)

npm run --silent build
for arch in "${archs[@]}"; do
  bash scripts/build-engine-bundle.sh "$arch"
  python3 -I scripts/bundle-dylibs.py "build/stage/$arch/ElectronPlayer.app/Contents" "$arch"
  # The app's minimum macOS is the newest any bundled library was built for
  # (Homebrew builds for the macOS it runs on), so Finder says so up front.
  min=$(find "build/stage/$arch/ElectronPlayer.app/Contents/Frameworks/engine" -type f \( -name '*.dylib' -o -name '*.node' \) \
    -exec otool -l {} + | awk '/minos/{print $2}' | sort -V | tail -1)
  npx electron-builder --mac "--$arch" --publish never -c.mac.minimumSystemVersion="$min"
done
ls -1 release/*.dmg release/*.zip
