#!/usr/bin/env bash
# Applies patches/<submodule>/*.patch to the vendor/ sources, once: a patch
# that is already applied is skipped. Every engine build script runs this.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
shopt -s nullglob
for dir in "$root"/patches/*/; do
  name=$(basename "$dir")
  for patch in "$dir"*.patch; do
    if git -C "$root/vendor/$name" apply --reverse --check "$patch" 2>/dev/null; then
      continue
    fi
    git -C "$root/vendor/$name" apply "$patch"
    echo "Applied $(basename "$patch") to vendor/$name"
  done
done
