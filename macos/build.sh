#!/usr/bin/env bash
# Builds macos/build/The Deck.app (ad-hoc signed). Needs only the Command Line Tools, not Xcode.
set -euo pipefail
cd "$(dirname "$0")"
swift build -c release
APP="build/The Deck.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp "$(swift build -c release --show-bin-path)/Deck" "$APP/Contents/MacOS/Deck"
cp Info.plist "$APP/Contents/Info.plist"
codesign --force --sign - "$APP"
echo "Built $PWD/$APP"
