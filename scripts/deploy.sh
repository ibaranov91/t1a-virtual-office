#!/usr/bin/env bash
# Build the client locally, ship to the vOffice box, restart the service.
# Usage: scripts/deploy.sh [ssh-host]   (default: Hetzner2-vOffice)
set -euo pipefail
HOST="${1:-Hetzner2-vOffice}"
APP=/opt/the-deck
cd "$(dirname "$0")/.."

npm run build -w client
rsync -az --delete \
  --exclude node_modules --exclude data --exclude .claude --exclude '*.log' \
  ./ "$HOST:/tmp/the-deck-src/"

ssh "$HOST" bash -s <<EOF
set -euo pipefail
sudo id deck >/dev/null 2>&1 || sudo useradd --system --home $APP --shell /usr/sbin/nologin deck
sudo mkdir -p $APP/data
sudo rsync -a --delete --exclude data --exclude node_modules /tmp/the-deck-src/ $APP/
cd $APP && sudo npm ci --no-audit --no-fund --loglevel=error
sudo chown -R deck:deck $APP
if [ ! -f /etc/the-deck.env ]; then
  echo "DECK_TOKEN=\$(openssl rand -hex 6)" | sudo tee /etc/the-deck.env >/dev/null
  printf 'DECK_PORT=8080\nDECK_HOST=10.200.142.211\nBOTS=1\nNETBIRD_AUTH=true\nNETBIRD_TRUSTED_CIDR=10.200.0.0/16\nNETBIRD_TRUSTED_PEER=^proxy-[a-z0-9]+-[0-9]+-[0-9]+[.]nb[.]t1a[.]internal[.]?\$\n' | sudo tee -a /etc/the-deck.env >/dev/null
  sudo chmod 600 /etc/the-deck.env
fi
sudo tee /etc/systemd/system/the-deck.service >/dev/null <<'UNIT'
[Unit]
Description=The Deck virtual office
After=network-online.target
Wants=network-online.target

[Service]
User=deck
WorkingDirectory=/opt/the-deck
EnvironmentFile=/etc/the-deck.env
ExecStart=/opt/the-deck/node_modules/.bin/tsx server/src/index.ts
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable the-deck >/dev/null 2>&1
sudo systemctl restart the-deck
sleep 2
systemctl is-active the-deck
curl -fsS http://10.200.142.211:8080/api/health; echo
EOF
