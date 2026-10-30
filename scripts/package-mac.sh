#!/usr/bin/env bash
# Builds ElectronPlayer.app and a .dmg in release/ (macOS, this Mac's
# architecture, ad-hoc signed: it runs on this Mac; other Macs need a
# Developer ID signature and notarization).
#
#   1. TypeScript and renderer bundles      (npm run build)
#   2. Native addon                         (npm run build:native)
#   3. Engine in app-bundle layout          (build-engine-bundle.sh)
#   4. Homebrew libraries copied in, every reference repointed (bundle-dylibs.py)
#   5. electron-builder assembles the app; scripts/adhoc-sign.cjs signs it
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
contents="build/stage/ElectronPlayer.app/Contents"

npm run --silent build
[[ -f native/build/Release/audcore.node ]] || npm run --silent build:native
bash scripts/build-engine-bundle.sh
cp native/build/Release/audcore.node "$contents/Frameworks/engine/audcore.node"
python3 -I scripts/bundle-dylibs.py "$contents"
npx electron-builder --mac --publish never
