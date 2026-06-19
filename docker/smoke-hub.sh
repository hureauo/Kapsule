#!/usr/bin/env bash
# Smoke test end-to-end du HUB : démarre le stack docker-compose.hub.yml et
# vérifie, par curl, que le SPA est servi et que toute la surface API répond
# les bons codes (y compris les gardes d'auth). Voir smoke-common.sh.
#
# Usage :  docker/smoke-hub.sh [--keep]
#   --keep : ne pas détruire le stack à la fin (debug).

set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=docker/smoke-common.sh
source docker/smoke-common.sh

COMPOSE="docker compose -f docker-compose.hub.yml -p smoke-hub"
BASE="https://localhost"
KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

# Identifiants seedés au boot via ADMIN_EMAIL / ADMIN_PASSWORD_HUB (seedAdminIfNeeded).
ADMIN_EMAIL="smoke-admin@kapsule.test"
ADMIN_PASS="smoke-admin-pass-123"

teardown() {
  if [ "$KEEP" -eq 1 ]; then
    echo "→ --keep : stack laissé debout ($COMPOSE)"
  else
    echo "→ teardown"
    $COMPOSE down -v >/dev/null 2>&1 || true
  fi
}
trap teardown EXIT

echo "=== SMOKE HUB ==="
# docker-compose.hub.yml fixe `container_name: hub-backend` (les bornes preview le
# joignent par ce nom) → c'est un singleton. On retire tout stack hub préexistant
# (run par défaut `kapsule` ou smoke antérieur) avant de démarrer, sinon conflit.
echo "→ nettoyage d'un éventuel stack hub préexistant"
docker compose -f docker-compose.hub.yml -p kapsule down >/dev/null 2>&1 || true
$COMPOSE down -v >/dev/null 2>&1 || true
docker rm -f hub-backend >/dev/null 2>&1 || true

echo "→ build & up"
ADMIN_EMAIL="$ADMIN_EMAIL" ADMIN_PASSWORD_HUB="$ADMIN_PASS" JWT_SECRET="smoke-secret" \
  $COMPOSE up -d --build >/dev/null

wait_ready "$BASE/api/health" 120

# ── 1. SPA servi par nginx ────────────────────────────────────────────────────
echo "[SPA]"
expect GET "$BASE/" 200 "GET / (index.html)"
HTML=$(http_body GET "$BASE/")
echo "$HTML" | grep -q '<div id="root"' && echo "  ✓ point de montage React présent" && PASS=$((PASS+1)) \
  || { echo "  ✗ <div id=root> absent du HTML"; FAIL=$((FAIL+1)); false; }
ASSET=$(echo "$HTML" | grep -o '/assets/[^"]*\.js' | head -1)
[ -n "$ASSET" ] && echo "  ✓ asset JS référencé : $ASSET" && PASS=$((PASS+1)) \
  || { echo "  ✗ aucun asset /assets/*.js référencé"; FAIL=$((FAIL+1)); false; }
expect GET "$BASE$ASSET" 200 "GET $ASSET (bundle)"
# Fallback SPA : une route non-API renvoie l'index, pas un 404.
expect GET "$BASE/events" 200 "fallback SPA /events"

# ── 2. Santé & auth ───────────────────────────────────────────────────────────
echo "[Auth]"
expect GET "$BASE/api/health" 200 "GET /api/health"
expect POST "$BASE/api/auth/login" 401 "login mauvais mdp" "" "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"WRONG\"}"
expect GET "$BASE/api/events" 401 "events sans token"

LOGIN=$(http_body POST "$BASE/api/auth/login" "" "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASS\"}")
TOKEN=$(json_get "$LOGIN" token)
[ -n "$TOKEN" ] && echo "  ✓ login admin → JWT" && PASS=$((PASS+1)) \
  || { echo "  ✗ login admin n'a pas renvoyé de token : $LOGIN"; FAIL=$((FAIL+1)); false; }

# ── 3. Événements (CRUD + statut) ─────────────────────────────────────────────
echo "[Events]"
expect GET "$BASE/api/events" 200 "liste events" "$TOKEN"
EV=$(http_body POST "$BASE/api/events" "$TOKEN" '{"name":"Smoke Event"}')
EID=$(json_get "$EV" id)
[ -n "$EID" ] && echo "  ✓ création event ($EID)" && PASS=$((PASS+1)) \
  || { echo "  ✗ création event KO : $EV"; FAIL=$((FAIL+1)); false; }
expect GET "$BASE/api/events/$EID" 200 "détail event" "$TOKEN"
expect PUT "$BASE/api/events/$EID" 200 "update event" "$TOKEN" '{"name":"Smoke Event 2"}'
expect PUT "$BASE/api/events/$EID/status" 200 "statut draft→ready" "$TOKEN" '{"status":"ready"}'

# ── 4. Questions (CRUD + reorder) ─────────────────────────────────────────────
echo "[Questions]"
QB="$BASE/api/events/$EID/questions"
# ready gèle l'édition ? Non : ready est éditable, seul live+ gèle. On crée donc une question.
Q=$(http_body POST "$QB" "$TOKEN" '{"text":"Question smoke ?","max_duration":60,"countdown":3}')
QID=$(json_get "$Q" id)
[ -n "$QID" ] && echo "  ✓ création question ($QID)" && PASS=$((PASS+1)) \
  || { echo "  ✗ création question KO : $Q"; FAIL=$((FAIL+1)); false; }
expect GET "$QB" 200 "liste questions" "$TOKEN"
expect PUT "$QB/$QID" 200 "update question" "$TOKEN" '{"text":"Question smoke éditée ?","max_duration":90,"countdown":3}'
expect DELETE "$QB/$QID" 204 "suppression question" "$TOKEN"

# ── 5. Tokens de borne ────────────────────────────────────────────────────────
echo "[Tokens]"
TK=$(http_body POST "$BASE/api/admin/events/$EID/tokens" "$TOKEN" '{"label":"smoke"}')
echo "$TK" | grep -q '"token_clear"' && echo "  ✓ token_clear renvoyé" && PASS=$((PASS+1)) \
  || { echo "  ✗ token_clear absent : $TK"; FAIL=$((FAIL+1)); false; }
TID=$(json_get "$TK" id)
expect GET "$BASE/api/admin/events/$EID/tokens" 200 "liste tokens event" "$TOKEN"
expect GET "$BASE/api/admin/tokens" 200 "liste tokens globale" "$TOKEN"
expect DELETE "$BASE/api/admin/tokens/$TID" 204 "révocation token" "$TOKEN"

# ── 6. Users + garde-fou + overview ───────────────────────────────────────────
echo "[Users]"
expect GET "$BASE/api/admin/users" 200 "liste users" "$TOKEN"
NU=$(http_body POST "$BASE/api/admin/users" "$TOKEN" '{"email":"smoke-client@kapsule.test","name":"Smoke Client"}')
echo "$NU" | grep -q 'registration_url' && echo "  ✓ création user (registration_url)" && PASS=$((PASS+1)) \
  || { echo "  ✗ registration_url absent : $NU"; FAIL=$((FAIL+1)); false; }
expect GET "$BASE/api/admin/overview" 200 "overview" "$TOKEN"

# ── 7. Garde de rôle (client ≠ superuser) ─────────────────────────────────────
echo "[Rôle client]"
# Le client n'a pas de mot de passe (pas de set-password ici) → on ne peut pas
# obtenir son JWT sans le flux d'enregistrement. On vérifie au minimum que la
# création d'event exige bien un token (déjà fait : 401 sans token).
echo "  ℹ garde superuser=requireAdmin couverte par supertest (admin.test.js)"

# ── 8. Nettoyage event ────────────────────────────────────────────────────────
echo "[Cleanup]"
expect DELETE "$BASE/api/events/$EID" 200 "suppression event" "$TOKEN" '{"confirm":"Smoke Event 2"}'

summary
