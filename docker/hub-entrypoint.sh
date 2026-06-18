#!/bin/sh
set -e

CERT=/etc/letsencrypt/live/default/fullchain.pem
KEY=/etc/letsencrypt/live/default/privkey.pem
SELF_DIR=/etc/nginx/certs

# Si le certificat Let's Encrypt est absent (dev local), génère un cert auto-signé
if [ ! -f "$CERT" ]; then
  mkdir -p "$SELF_DIR"
  if [ ! -f "$SELF_DIR/hub.crt" ]; then
    openssl req -x509 -nodes -days 730 -newkey rsa:2048 \
      -keyout "$SELF_DIR/hub.key" \
      -out    "$SELF_DIR/hub.crt" \
      -subj "/CN=hub.local"
  fi
  # Remplace les chemins Let's Encrypt par le cert auto-signé dans la conf nginx
  sed -i \
    -e "s|$CERT|$SELF_DIR/hub.crt|g" \
    -e "s|$KEY|$SELF_DIR/hub.key|g" \
    /etc/nginx/conf.d/default.conf
fi

exec nginx -g 'daemon off;'
