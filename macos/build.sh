#!/usr/bin/env bash
# Builds macos/build/The Deck.app. Needs only the Command Line Tools, not Xcode.
#   macos/build.sh          build + sign
#   macos/build.sh --dist   also write macos/dist/The-Deck.zip + manifest.json (served by the instance;
#                           scripts/deploy.sh runs this)
# Signs with the "T1A Deck" identity from macos/make-cert.sh when present (keeps the mic permission
# across updates), otherwise ad-hoc.
set -euo pipefail
cd "$(dirname "$0")"
swift build -c release
APP="build/The Deck.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp AppIcon.icns "$APP/Contents/Resources/AppIcon.icns" # from make-icon.swift
cp "$(swift build -c release --show-bin-path)/Deck" "$APP/Contents/MacOS/Deck"
cp Info.plist "$APP/Contents/Info.plist"

# DeckBuild: changes only when the app's sources do, so a deploy without native changes doesn't
# offer an update. CFBundleVersion is just for people reading "About".
BUILD=$(cat Package.swift Info.plist AppIcon.icns Sources/Deck/*.swift | shasum -a 256 | cut -c1-12)
plutil -replace DeckBuild -string "$BUILD" "$APP/Contents/Info.plist"
plutil -replace CFBundleVersion -string "$(git rev-list --count HEAD 2>/dev/null || echo 1)" "$APP/Contents/Info.plist"
[ "${1:-}" = --dist ] || plutil -replace DeckDev -bool YES "$APP/Contents/Info.plist" # local builds never self-update

KC="${DECK_SIGNING_DIR:-$HOME/.deck-signing}/deck.keychain-db"
if [ -f "$KC" ]; then
  security unlock-keychain -p "$(cat "$(dirname "$KC")/keychain-password")" "$KC"
  codesign --force --keychain "$KC" --sign "T1A Deck" "$APP"
else
  echo "warning: no T1A Deck signing identity (macos/make-cert.sh); signing ad-hoc, so updates will re-ask for the mic" >&2
  codesign --force --sign - "$APP"
fi
echo "Built $PWD/$APP ($BUILD)"

if [ "${1:-}" = --dist ]; then
  rm -rf dist; mkdir -p dist
  ditto -c -k --keepParent "$APP" dist/The-Deck.zip
  SHA=$(shasum -a 256 dist/The-Deck.zip | cut -d' ' -f1)
  printf '{"build":"%s","version":"%s","sha256":"%s"}\n' "$BUILD" \
    "$(plutil -extract CFBundleShortVersionString raw "$APP/Contents/Info.plist") ($(plutil -extract CFBundleVersion raw "$APP/Contents/Info.plist"))" \
    "$SHA" > dist/manifest.json
  echo "Packaged $PWD/dist/The-Deck.zip"
fi
