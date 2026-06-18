#!/bin/sh
set -e

DOMAIN="${EDGE_DOMAIN:-kapsule.hureau.com}"
# Échappe les points pour la regex nginx dans server_name
DOMAIN_ESCAPED=$(echo "$DOMAIN" | sed 's/\./\\./g')

# Substitue le domaine dans le template
sed \
  -e "s/\${EDGE_DOMAIN}/${DOMAIN}/g" \
  -e "s/\${EDGE_DOMAIN_ESCAPED}/${DOMAIN_ESCAPED}/g" \
  /etc/nginx/templates/edge-nginx.conf.template \
  > /etc/nginx/conf.d/default.conf

# Si le certificat Let's Encrypt est absent, génère un cert auto-signé pour le dev
CERT_DIR="/etc/letsencrypt/live/kapsule"
if [ ! -f "${CERT_DIR}/fullchain.pem" ]; then
  echo "[edge] Cert absent — génération d'un cert auto-signé pour ${DOMAIN}"
  mkdir -p "${CERT_DIR}"
  openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
    -keyout "${CERT_DIR}/privkey.pem" \
    -out    "${CERT_DIR}/fullchain.pem" \
    -subj "/CN=${DOMAIN}" 2>/dev/null
fi

exec nginx -g "daemon off;"
