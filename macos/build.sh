#!/usr/bin/env bash
# Builds the Mac app. Needs only the Command Line Tools, not Xcode.
#   macos/build.sh                  local build: macos/build/The Deck (dev).app (io.t1a.deck.dev: runs beside the
#                                   installed app with its own settings, never self-updates; point it with
#                                   defaults write io.t1a.deck.dev url <instance>, or the Instance menu)
#   macos/build.sh --dist           build and write macos/dist/The-Deck.zip + manifest.json
#                                   (served by every instance; scripts/deploy.sh runs this)
#   macos/build.sh --build-id       print the build id the app would get, without building
# There is one app, "The Deck" (io.t1a.deck), for every instance. The install command each instance serves
# points it at that instance, and it updates from whichever instance it points at.
# Signs with the "T1A Deck" identity from macos/make-cert.sh when present (keeps the mic permission
# across updates), otherwise ad-hoc.
set -euo pipefail
cd "$(dirname "$0")"
DIST=false
case "${1:-}" in --dist|--build-id) DIST=true ;; esac

# DeckBuild: changes only when the app's sources do, so a deploy without native changes doesn't offer an
# update, and instances running the same sources serve the same build. CFBundleVersion is just for "About".
BUILD=$(cat Package.swift Info.plist AppIcon.icns Sources/Deck/*.swift | shasum -a 256 | cut -c1-12)
if [ "${1:-}" = --build-id ]; then echo "$BUILD"; exit 0; fi

NAME="The Deck"; ID=io.t1a.deck # as in Info.plist
$DIST || { NAME="The Deck (dev)"; ID=io.t1a.deck.dev; } # a local build sits beside the installed one

swift build -c release
rm -rf build; mkdir -p build
APP="build/$NAME.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp AppIcon.icns "$APP/Contents/Resources/AppIcon.icns" # from make-icon.swift
cp "$(swift build -c release --show-bin-path)/Deck" "$APP/Contents/MacOS/Deck"
cp Info.plist "$APP/Contents/Info.plist"
P="$APP/Contents/Info.plist"

plutil -replace DeckBuild -string "$BUILD" "$P"
plutil -replace CFBundleVersion -string "$(git rev-list --count HEAD 2>/dev/null || echo 1)" "$P"
if ! $DIST; then # local builds never self-update
  plutil -replace DeckDev -bool YES "$P"
  plutil -replace CFBundleIdentifier -string "$ID" "$P"
  plutil -replace CFBundleName -string "$NAME" "$P"
  plutil -replace CFBundleDisplayName -string "$NAME" "$P"
fi

KC="${DECK_SIGNING_DIR:-$HOME/.deck-signing}/deck.keychain-db"
if [ -f "$KC" ]; then
  security unlock-keychain -p "$(cat "$(dirname "$KC")/keychain-password")" "$KC"
  codesign --force --keychain "$KC" --sign "T1A Deck" "$APP"
else
  echo "warning: no T1A Deck signing identity (macos/make-cert.sh); signing ad-hoc, so updates will re-ask for the mic" >&2
  codesign --force --sign - "$APP"
fi
echo "Built $PWD/$APP ($BUILD)"

if $DIST; then
  rm -rf dist; mkdir -p dist
  ditto -c -k --keepParent "$APP" dist/The-Deck.zip
  SHA=$(shasum -a 256 dist/The-Deck.zip | cut -d' ' -f1)
  printf '{"build":"%s","version":"%s","sha256":"%s","app":"%s","bundleId":"%s"}\n' "$BUILD" \
    "$(plutil -extract CFBundleShortVersionString raw "$P") ($(plutil -extract CFBundleVersion raw "$P"))" \
    "$SHA" "$NAME" "$ID" > dist/manifest.json
  echo "Packaged $PWD/dist/The-Deck.zip ($NAME)"
fi
