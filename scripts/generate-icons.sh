#!/usr/bin/env bash
# Regenerate every platform icon in src-tauri/icons from the vector master.
#
# The master is assets/brand/localacp-app-icon.svg. Run this after editing it;
# the generated PNG/ICNS/ICO files are committed, so `tauri build` never needs
# ImageMagick.
#
# Requires ImageMagick (`brew install imagemagick`).
set -euo pipefail

cd "$(dirname "$0")/.."

master="assets/brand/localacp-app-icon.svg"
staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT

command -v magick >/dev/null || {
  echo "error: ImageMagick (magick) is required. brew install imagemagick" >&2
  exit 1
}

# 1024x1024 is what `tauri icon` wants as input; it derives every other size.
magick -background none "$master" -resize 1024x1024 "$staging/icon-1024.png"
npx tauri icon "$staging/icon-1024.png"

echo "Regenerated src-tauri/icons from $master"
