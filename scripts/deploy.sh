#!/usr/bin/env bash
# Build the client locally, ship it to the vOffice box, (re)start that instance's service.
#
# Usage: scripts/deploy.sh [instance]        (default: prod)
#   Instances (name, port, owner, URL) live in scripts/instances.txt. Each one is fully separate:
#   its own folder, data, settings file and systemd service, so deploys never touch each other.
#     prod   -> /opt/the-deck,   the-deck.service,   /etc/the-deck.env
#     <name> -> /opt/deck-<name>, deck-<name>.service, /etc/deck-<name>.env
#   DECK_SSH_HOST overrides the ssh host (default: Hetzner2-vOffice, as in ~/.ssh/config).
#   DECK_ALLOW_ADHOC=1 lets a deploy replace the instance's signed Mac app anyway (see the Mac app step).
set -euo pipefail
cd "$(dirname "$0")/.."

NAME="${1:-prod}"
HOST="${DECK_SSH_HOST:-Hetzner2-vOffice}"
BIND=10.200.142.211 # the box's NetBird address; the reverse proxy targets it

read -r PORT LOGIN OWNER URL < <(awk -v n="$NAME" '$1 == n { print $2, $3, $4, $5 }' scripts/instances.txt) || true
if [ -z "${PORT:-}" ]; then
  echo "Unknown instance '$NAME'. Known: $(awk '!/^#/ && NF { printf "%s ", $1 }' scripts/instances.txt)" >&2
  echo "Add it to scripts/instances.txt (and a NetBird proxy entry to http://$BIND:<port>)." >&2
  exit 1
fi
if [ "$NAME" = prod ]; then APP=/opt/the-deck; SVC=the-deck; ENVF=/etc/the-deck.env
else APP=/opt/deck-$NAME; SVC=deck-$NAME; ENVF=/etc/deck-$NAME.env; fi
SRC=/tmp/deck-src-$NAME
# INSTALL_URL: where `curl … | bash` can fetch the Mac app. The PIN page blocks curl, so PIN instances
# hand out their NetBird address instead (works for anyone on NetBird).
case "$LOGIN" in
  sso) NETBIRD_AUTH=true;  OPEN_LOGIN=false; INSTALL_URL=$URL ;; # "Continue as <you>" via NetBird sign-in
  pin) NETBIRD_AUTH=false; OPEN_LOGIN=true;  INSTALL_URL=http://$BIND:$PORT ;; # any name, no password: the PIN on the proxy is the gate
  *) echo "instance '$NAME': login must be sso or pin, got '$LOGIN'" >&2; exit 1 ;;
esac

echo "→ deploying '$NAME' ($OWNER, login: $LOGIN) to $HOST:$PORT  →  $URL"
npm run build -w client
# The Mac app ships with the instance (macos/dist). Only a Mac can build it; elsewhere, deploy without it.
# Installed apps only take an update from their own signer, so a deploy must never swap a signed app for an
# ad-hoc one (or none). Without the shared identity here, or if the build fails, keep the signed app the
# instance serves when it was built from the same sources (same build id); if they changed, stop.
rm -rf macos/dist
KC="${DECK_SIGNING_DIR:-$HOME/.deck-signing}/deck.keychain-db"
if [ "$(uname)" != Darwin ]; then echo "warning: not on macOS; deploying without the Mac app" >&2
elif [ -f "$KC" ] && macos/build.sh --dist "$NAME"; then :
else
  if [ -f "$KC" ]; then WHY="the Mac app build failed"; FIX="fix the build (macos/build.sh --dist $NAME)"; ANYWAY="without a Mac app"
  else WHY="this Mac has no T1A Deck signing identity"; ANYWAY="with an ad-hoc Mac app"
    FIX="import the shared identity, not a new one: DECK_P12_PASSWORD=… macos/make-cert.sh import <p12>"; fi
  SERVED=$(mktemp -d); trap 'rm -rf "$SERVED"' EXIT
  SIGNED=false
  if [ -n "$(ssh "$HOST" "cat $APP/macos/dist/manifest.json 2>/dev/null || true")" ]; then
    rsync -az "$HOST:$APP/macos/dist/" "$SERVED/"
    ditto -x -k "$SERVED/The-Deck.zip" "$SERVED/app" &&
      grep -q '^Authority=' <<<"$(codesign -dvv "$SERVED/app/"*.app 2>&1 || true)" && SIGNED=true
  fi
  HAVE=$(sed -n 's/.*"build":"\([^"]*\)".*/\1/p' "$SERVED/manifest.json" 2>/dev/null || true)
  WANT=$(macos/build.sh --build-id "$NAME")
  if $SIGNED && [ "$HAVE" = "$WANT" ]; then
    mkdir -p macos/dist && cp "$SERVED/manifest.json" "$SERVED/The-Deck.zip" macos/dist/
    echo "→ $WHY, but the Mac app is unchanged (build $WANT): '$NAME' keeps the signed one it serves"
  elif $SIGNED && [ "${DECK_ALLOW_ADHOC:-}" != 1 ]; then
    echo "✗ not deploying '$NAME': its Mac app changed (build $HAVE → $WANT) and $WHY." >&2
    echo "  Its signed app would be replaced, and installed apps refuse updates from another signer." >&2
    echo "  Either $FIX," >&2
    echo "  or deploy $ANYWAY: DECK_ALLOW_ADHOC=1 scripts/deploy.sh $NAME" >&2
    exit 1
  else
    $SIGNED && echo "warning: DECK_ALLOW_ADHOC=1: replacing the signed Mac app '$NAME' serves; installed apps won't take it" >&2
    if [ -f "$KC" ]; then echo "warning: Mac app build failed; deploying without it" >&2
    else macos/build.sh --dist "$NAME" || echo "warning: Mac app build failed; deploying without it" >&2; fi
  fi
fi
rsync -az --delete \
  --exclude node_modules --exclude data --exclude .claude --exclude '*.log' \
  --exclude macos/.build --exclude macos/build \
  ./ "$HOST:$SRC/"

ssh "$HOST" bash -s <<EOF
set -euo pipefail
# one deploy per instance at a time
exec 9>/tmp/deck-deploy-$NAME.lock
flock -w 300 9 || { echo "another deploy of '$NAME' is running" >&2; exit 1; }

# never let two instances share a port
for f in /etc/the-deck.env /etc/deck-*.env; do
  [ -f "\$f" ] && [ "\$f" != "$ENVF" ] && sudo grep -qx "DECK_PORT=$PORT" "\$f" && { echo "port $PORT is already used by \$f" >&2; exit 1; }
done

sudo id deck >/dev/null 2>&1 || sudo useradd --system --home /opt/the-deck --shell /usr/sbin/nologin deck
sudo mkdir -p $APP/data
sudo rsync -a --delete --exclude data --exclude node_modules $SRC/ $APP/
cd $APP && sudo npm ci --no-audit --no-fund --loglevel=error
sudo chown -R deck:deck $APP

if [ ! -f $ENVF ]; then # first deploy of this instance: same NetBird login as prod, its own port
  echo "DECK_TOKEN=\$(openssl rand -hex 6)" | sudo tee $ENVF >/dev/null
  printf 'DECK_PORT=$PORT\nDECK_HOST=$BIND\nBOTS=1\nNETBIRD_TRUSTED_CIDR=10.200.0.0/16\nNETBIRD_TRUSTED_PEER=^proxy-[a-z0-9]+-[0-9]+-[0-9]+[.]nb[.]t1a[.]internal[.]?\$\n' | sudo tee -a $ENVF >/dev/null
  sudo chmod 600 $ENVF
fi
# login mode comes from scripts/instances.txt and is re-applied on every deploy
setenv() { if sudo grep -q "^\$1=" $ENVF; then sudo sed -i "s|^\$1=.*|\$1=\$2|" $ENVF; else echo "\$1=\$2" | sudo tee -a $ENVF >/dev/null; fi; }
setenv NETBIRD_AUTH $NETBIRD_AUTH
setenv OPEN_LOGIN $OPEN_LOGIN
setenv DECK_PUBLIC_URL $URL
setenv DECK_INSTALL_URL $INSTALL_URL
# no bots on prod: drop the setting entirely (bots are opt-in); test instances keep BOTS=1
if [ "$NAME" = prod ]; then sudo sed -i '/^BOTS=/d;/^BOT_COUNT=/d' $ENVF; fi
sudo sed -i '/^TOKEN_LOGIN=/d' $ENVF

sudo tee /etc/systemd/system/$SVC.service >/dev/null <<UNIT
[Unit]
Description=The Deck virtual office ($NAME)
After=network-online.target
Wants=network-online.target

[Service]
User=deck
WorkingDirectory=$APP
EnvironmentFile=$ENVF
ExecStart=$APP/node_modules/.bin/tsx server/src/index.ts
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
# snapshot the state before the new code loads it (server/src/index.ts keeps daily copies there too); keep the last 10
if [ -f $APP/data/state.json ]; then
  sudo -u deck mkdir -p $APP/data/backups
  sudo -u deck cp -p $APP/data/state.json $APP/data/backups/state-predeploy-\$(date -u +%Y%m%dT%H%M%SZ).json
  ls -1 $APP/data/backups/state-predeploy-*.json | head -n -10 | xargs -r sudo rm -f
fi
sudo systemctl daemon-reload
sudo systemctl enable $SVC >/dev/null 2>&1
sudo systemctl restart $SVC
sleep 2
systemctl is-active $SVC
curl -fsS http://$BIND:$PORT/api/health; echo
EOF
echo "✓ $NAME is up: $URL"
