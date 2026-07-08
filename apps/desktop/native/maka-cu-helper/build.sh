#!/bin/bash
# Build the Phase-1 Computer Use dispatch helper.
# Dev build is ad-hoc signed; PRODUCTION must Developer-ID sign + notarize with a
# stable identity (TCC Accessibility/Screen-Recording grants bind to code identity),
# and ship hardened-runtime + the usage-description Info.plist keys (see README).
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="$DIR/build/maka-cu-helper"
mkdir -p "$DIR/build"
swiftc -O \
  -framework Cocoa -framework ApplicationServices -framework CoreGraphics -framework ImageIO \
  -o "$OUT" "$DIR/Sources/main.swift"
codesign --force --sign - "$OUT" 2>/dev/null || true   # ad-hoc for dev; real identity in CI
echo "built: $OUT"
