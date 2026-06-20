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

# Cert Let's Encrypt attendu en prod (volume monté en lecture seule).
LE_CERT="/etc/letsencrypt/live/kapsule/fullchain.pem"
LE_KEY="/etc/letsencrypt/live/kapsule/privkey.pem"

# DEV_CERT_DIR permet d'injecter un répertoire de certs alternatif (ex: mkcert)
# sans monter dans /etc/letsencrypt (qui est en lecture seule dans l'image nginx).
# Utilisé par docker-compose.hub.dev.yml.
if [ -n "${DEV_CERT_DIR:-}" ] && [ -f "${DEV_CERT_DIR}/fullchain.pem" ]; then
  echo "[edge] Certs dev détectés dans ${DEV_CERT_DIR} — mode dev local"
  sed -i \
    -e "s|$LE_CERT|${DEV_CERT_DIR}/fullchain.pem|g" \
    -e "s|$LE_KEY|${DEV_CERT_DIR}/privkey.pem|g" \
    /etc/nginx/conf.d/default.conf

# En dev/local, si le volume Let's Encrypt est absent → cert auto-signé.
elif [ ! -f "$LE_CERT" ]; then
  echo "[edge] Cert Let's Encrypt absent — cert auto-signé pour ${DOMAIN} (dev)"
  SELF_DIR="/etc/nginx/certs"
  mkdir -p "$SELF_DIR"
  if [ ! -f "$SELF_DIR/fullchain.pem" ]; then
    openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
      -keyout "$SELF_DIR/privkey.pem" \
      -out    "$SELF_DIR/fullchain.pem" \
      -subj "/CN=${DOMAIN}" 2>/dev/null
  fi
  sed -i \
    -e "s|$LE_CERT|$SELF_DIR/fullchain.pem|g" \
    -e "s|$LE_KEY|$SELF_DIR/privkey.pem|g" \
    /etc/nginx/conf.d/default.conf
fi

exec nginx -g "daemon off;"
