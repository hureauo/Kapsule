#!/bin/sh
set -e

CERT_DIR=/etc/nginx/certs

# Génère un certificat auto-signé si absent (nécessaire pour HTTPS — caméra iOS Safari l'exige)
if [ ! -f "$CERT_DIR/borne.crt" ]; then
  mkdir -p "$CERT_DIR"
  openssl req -x509 -nodes -days 730 -newkey rsa:2048 \
    -keyout "$CERT_DIR/borne.key" \
    -out    "$CERT_DIR/borne.crt" \
    -subj "/CN=borne.local"
fi

exec nginx -g 'daemon off;'
