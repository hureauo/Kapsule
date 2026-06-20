#!/usr/bin/env bash
# setup-dev-certs.sh — installe mkcert et génère les certs TLS locaux pour le dev Hub.
#
# À lancer UNE SEULE FOIS sur ta machine (pas dans Docker).
# Crée docker/certs/ avec un wildcard *.kapsule.localhost signé par une CA locale.
# La CA est injectée dans le trust store du navigateur → HTTPS vert sans warning.
#
# Prérequis : mkcert installé (Debian/Ubuntu : apt install mkcert)
#
# Usage :
#   bash docker/setup-dev-certs.sh

set -euo pipefail
cd "$(dirname "$0")/.."

CERT_DIR="docker/certs"
DOMAIN="kapsule.localhost"

# ── 1. Vérifier que mkcert est disponible ────────────────────────────────────
if ! command -v mkcert &>/dev/null; then
  echo "❌  mkcert non trouvé. Installe-le d'abord :"
  echo "       # Debian / Ubuntu"
  echo "       sudo apt install mkcert"
  echo "       # macOS"
  echo "       brew install mkcert"
  exit 1
fi

# ── 2. Vérifier que certutil est disponible (requis pour Chromium sous Linux) ─
# Chromium/Chrome sur Linux utilisent un store NSS séparé (~/.pki/nssdb).
# mkcert -install n'y inscrit la CA que si certutil (paquet libnss3-tools) est présent.
if ! command -v certutil &>/dev/null; then
  echo "⚠️  certutil absent — nécessaire pour que Chromium accepte le cert."
  echo "    Installation de libnss3-tools..."
  sudo apt-get install -y libnss3-tools
fi

# ── 3. Installer la CA locale dans le trust store (une seule fois) ───────────
# Sans ça, le cert généré est inconnu du browser même s'il est valide structurellement.
# mkcert -install est idempotent : relancer ne pose pas de problème.
echo "→ Installation de la CA locale dans le trust store..."
mkcert -install

# ── 3. Générer le cert wildcard ───────────────────────────────────────────────
# On couvre :
#   - kapsule.localhost          → Hub principal
#   - *.kapsule.localhost        → previews  (essai-xxx.kapsule.localhost)
#   - localhost                  → accès direct sans domaine (smoke tests)
mkdir -p "$CERT_DIR"
echo "→ Génération du cert dans $CERT_DIR/ ..."
mkcert \
  -cert-file "$CERT_DIR/fullchain.pem" \
  -key-file  "$CERT_DIR/privkey.pem" \
  "$DOMAIN" "*.${DOMAIN}" "localhost" "127.0.0.1"

echo ""
echo "✅  Certs générés dans $CERT_DIR/"
echo "    fullchain.pem  — certificat (wildcard ${DOMAIN})"
echo "    privkey.pem    — clé privée"
echo ""
echo "Lance le Hub en mode dev avec :"
echo "    docker compose -f docker-compose.hub.yml -f docker-compose.hub.dev.yml up"
