#!/usr/bin/env bash
# Build the client locally, ship it to the vOffice box, (re)start that instance's service.
#
# Usage: scripts/deploy.sh [instance]        (default: prod)
#   Instances (name, port, owner, URL) live in scripts/instances.txt. Each one is fully separate:
#   its own folder, data, settings file and systemd service, so deploys never touch each other.
#     prod   -> /opt/the-deck,   the-deck.service,   /etc/the-deck.env
#     <name> -> /opt/deck-<name>, deck-<name>.service, /etc/deck-<name>.env
#   DECK_SSH_HOST overrides the ssh host (default: Hetzner2-vOffice, as in ~/.ssh/config).
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
case "$LOGIN" in
  sso) NETBIRD_AUTH=true;  OPEN_LOGIN=false ;; # "Continue as <you>" via NetBird sign-in
  pin) NETBIRD_AUTH=false; OPEN_LOGIN=true ;;  # any name, no password: the PIN on the proxy is the gate
  *) echo "instance '$NAME': login must be sso or pin, got '$LOGIN'" >&2; exit 1 ;;
esac

echo "→ deploying '$NAME' ($OWNER, login: $LOGIN) to $HOST:$PORT  →  $URL"
npm run build -w client
rsync -az --delete \
  --exclude node_modules --exclude data --exclude .claude --exclude '*.log' \
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
sudo systemctl daemon-reload
sudo systemctl enable $SVC >/dev/null 2>&1
sudo systemctl restart $SVC
sleep 2
systemctl is-active $SVC
curl -fsS http://$BIND:$PORT/api/health; echo
EOF
echo "✓ $NAME is up: $URL"
