#!/usr/bin/env bash
# Builds the Mac app. Needs only the Command Line Tools, not Xcode.
#   macos/build.sh                  local build: macos/build/The Deck.app (never self-updates)
#   macos/build.sh --dist <name>    build for instance <name> and write macos/dist/The-Deck.zip + manifest.json
#                                   (served by the instance; scripts/deploy.sh runs this)
# prod's app is "The Deck" (io.t1a.deck). Every other instance gets its own app, e.g. "The Deck (iva)"
# (io.t1a.deck.iva), with its own settings and login, so a branch on a test instance never replaces prod's
# app and both can be installed side by side.
# Signs with the "T1A Deck" identity from macos/make-cert.sh when present (keeps the mic permission
# across updates), otherwise ad-hoc.
set -euo pipefail
cd "$(dirname "$0")"
DIST=false; INSTANCE=prod
if [ "${1:-}" = --dist ]; then DIST=true; INSTANCE="${2:?usage: build.sh --dist <instance>}"; fi
if [ "$INSTANCE" = prod ]; then NAME="The Deck"; ID=io.t1a.deck
else NAME="The Deck ($INSTANCE)"; ID="io.t1a.deck.$INSTANCE"; fi

swift build -c release
rm -rf build; mkdir -p build
APP="build/$NAME.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp AppIcon.icns "$APP/Contents/Resources/AppIcon.icns" # from make-icon.swift
cp "$(swift build -c release --show-bin-path)/Deck" "$APP/Contents/MacOS/Deck"
cp Info.plist "$APP/Contents/Info.plist"
P="$APP/Contents/Info.plist"
plutil -replace CFBundleIdentifier -string "$ID" "$P"
plutil -replace CFBundleName -string "$NAME" "$P"
plutil -replace CFBundleDisplayName -string "$NAME" "$P"
plutil -replace DeckInstance -string "$INSTANCE" "$P"

# DeckBuild: changes only when the app's sources (or the instance) do, so a deploy without native
# changes doesn't offer an update. CFBundleVersion is just for people reading "About".
BUILD=$( (cat Package.swift Info.plist AppIcon.icns Sources/Deck/*.swift; echo "$INSTANCE") | shasum -a 256 | cut -c1-12)
plutil -replace DeckBuild -string "$BUILD" "$P"
plutil -replace CFBundleVersion -string "$(git rev-list --count HEAD 2>/dev/null || echo 1)" "$P"
$DIST || plutil -replace DeckDev -bool YES "$P" # local builds never self-update

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
