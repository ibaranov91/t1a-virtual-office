#!/usr/bin/env bash
# Creates the self-signed "T1A Deck" code-signing identity that build.sh signs with.
# A stable signer keeps macOS permissions (the microphone) across app updates; ad-hoc signing doesn't.
# Lives in its own keychain file (not your login keychain) under ~/.deck-signing.
#
#   macos/make-cert.sh                 create a new identity (once, on the machine that builds releases)
#   macos/make-cert.sh import <p12>    use an identity exported from another machine (password: DECK_P12_PASSWORD)
#
# Everyone who deploys must sign with the SAME identity, or installed apps won't accept the update.
set -euo pipefail
DIR="${DECK_SIGNING_DIR:-$HOME/.deck-signing}"
KC="$DIR/deck.keychain-db"
NAME="T1A Deck"
mkdir -p "$DIR"; chmod 700 "$DIR"

if [ -f "$KC" ] && [ "${1:-}" != import ]; then echo "Already set up: $KC"; exit 0; fi
[ -f "$DIR/keychain-password" ] || openssl rand -hex 16 > "$DIR/keychain-password"
chmod 600 "$DIR/keychain-password"
KCPW=$(cat "$DIR/keychain-password")

if [ "${1:-}" = import ]; then
  P12="$2"; P12PW="${DECK_P12_PASSWORD:?set DECK_P12_PASSWORD}"
else
  TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
  cat > "$TMP/cert.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $NAME
[ext]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
EOF
  /usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -config "$TMP/cert.cnf" -keyout "$TMP/key.pem" -out "$TMP/cert.pem" 2>/dev/null
  P12PW=$(openssl rand -hex 12)
  P12="$DIR/deck-signing.p12"
  /usr/bin/openssl pkcs12 -export -inkey "$TMP/key.pem" -in "$TMP/cert.pem" -name "$NAME" -out "$P12" -passout "pass:$P12PW"
  echo "$P12PW" > "$DIR/deck-signing.p12.password"; chmod 600 "$P12" "$DIR/deck-signing.p12.password"
fi

rm -f "$KC"
security create-keychain -p "$KCPW" "$KC"
security set-keychain-settings "$KC" # no auto-lock
security unlock-keychain -p "$KCPW" "$KC"
security import "$P12" -k "$KC" -P "$P12PW" -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple: -s -k "$KCPW" "$KC" >/dev/null
echo "✓ Signing identity '$NAME' is in $KC"
[ "${1:-}" = import ] || echo "  To let someone else deploy: give them $P12 and the password in $P12.password"
