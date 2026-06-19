#!/usr/bin/env bash
# Smoke test end-to-end de la BORNE en mode autonome (sans Hub) : démarre le
# stack docker-compose.borne.yml et vérifie, par curl, que le SPA est servi et
# que la surface API répond (public invité, auth, gardes de rôle, parcours
# session). Voir smoke-common.sh.
#
# La borne n'a pas de route HTTP de création d'événement (un événement vient
# normalement d'un pull Hub). Pour exercer le parcours invité sans Hub, on seede
# un événement local DANS le container via le vrai code registry (docker exec),
# puis on curl le serveur réel.
#
# Usage :  docker/smoke-borne.sh [--keep]

set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=docker/smoke-common.sh
source docker/smoke-common.sh

COMPOSE="docker compose -f docker-compose.borne.yml -p smoke-borne"
BASE="https://localhost"          # cert auto-signé → http_code/-k l'accepte
TECH_PASS="smoke-tech-pass-456"
KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

teardown() {
  if [ "$KEEP" -eq 1 ]; then
    echo "→ --keep : stack laissé debout ($COMPOSE)"
  else
    echo "→ teardown"
    $COMPOSE down -v >/dev/null 2>&1 || true
  fi
}
trap teardown EXIT

echo "=== SMOKE BORNE (autonome) ==="
echo "→ teardown préalable (stack résiduelle éventuelle)"
$COMPOSE down -v >/dev/null 2>&1 || true
echo "→ build & up"
# Pas de HUB_URL ni BOX_TOKEN → mode autonome. TECH_PASSWORD non-défaut requis.
TECH_PASSWORD="$TECH_PASS" JWT_SECRET="smoke-secret" \
  $COMPOSE up -d --build >/dev/null

wait_ready "$BASE/api/health" 120

# ── 1. SPA servi par nginx (cert auto-signé) ──────────────────────────────────
echo "[SPA]"
expect GET "$BASE/" 200 "GET / (index.html)"
HTML=$(http_body GET "$BASE/")
echo "$HTML" | grep -q '<div id="root"' && echo "  ✓ point de montage React présent" && PASS=$((PASS+1)) \
  || { echo "  ✗ <div id=root> absent du HTML"; FAIL=$((FAIL+1)); false; }
ASSET=$(echo "$HTML" | grep -o '/assets/[^"]*\.js' | head -1)
expect GET "$BASE$ASSET" 200 "GET $ASSET (bundle)"
expect GET "$BASE/admin" 200 "fallback SPA /admin"

# ── 2. API publique invité ────────────────────────────────────────────────────
echo "[Public]"
expect GET "$BASE/api/health" 200 "GET /api/health"

# ── 3. Auth admin (mode autonome → token tech via TECH_PASSWORD) ──────────────
echo "[Auth]"
expect POST "$BASE/api/admin/login" 401 "login mauvais mdp" "" '{"password":"WRONG"}'
LOGIN=$(http_body POST "$BASE/api/admin/login" "" "{\"password\":\"$TECH_PASS\"}")
TOKEN=$(json_get "$LOGIN" token)
[ -n "$TOKEN" ] && echo "  ✓ login autonome → JWT (tech)" && PASS=$((PASS+1)) \
  || { echo "  ✗ login autonome KO : $LOGIN"; FAIL=$((FAIL+1)); false; }

# ── 4. Seed d'un événement local 'live' actif ────────────────────────────────
# La borne n'a pas de route de création d'événement (vient d'un pull Hub). On
# seede via le vrai code registry (docker exec) pour exercer le parcours invité
# et les routes qui exigent un événement actif. Backend ESM ; WORKDIR container =
# /app/apps/borne/server (cf. Dockerfile).
echo "[Seed événement]"
EID=$($COMPOSE exec -T backend node --input-type=module -e '
  import { openRegistry, insertEvent, setActiveEvent } from "./src/registry.js";
  import { getActiveEventDb } from "./src/eventDb.js";
  import { randomUUID } from "node:crypto";
  import { mkdirSync } from "node:fs";
  import { join } from "node:path";
  const dataDir = process.env.DATA_DIR;
  openRegistry(dataDir);
  const id = randomUUID();
  insertEvent({ id, name: "Smoke Borne", origin: "local", status: "live" });
  setActiveEvent(id);
  mkdirSync(join(dataDir, "events", id), { recursive: true });
  getActiveEventDb(dataDir, { id });   // crée db.sqlite + questions par défaut
  process.stdout.write(id);
' 2>/dev/null | tr -d '[:space:]')

[ -n "$EID" ] && echo "  ✓ événement seedé ($EID)" && PASS=$((PASS+1)) \
  || { echo "  ✗ seed événement KO"; FAIL=$((FAIL+1)); false; }

# ── 5. Gardes d'auth (événement actif présent) ────────────────────────────────
echo "[Gardes]"
expect GET "$BASE/api/videos" 401 "videos sans token"
expect GET "$BASE/api/videos" 200 "videos avec token" "$TOKEN"
# Routes tech : le token autonome porte tech_borne (sur-ensemble) → 200.
expect GET "$BASE/api/sync/status" 200 "sync/status (tech)" "$TOKEN"
echo "  ℹ distinction admin_borne/tech_borne couverte par supertest (auth/sessions.test.js)"

# ── 6. Parcours invité ────────────────────────────────────────────────────────
echo "[Parcours invité]"
expect GET "$BASE/api/event" 200 "GET /api/event (actif)"
expect GET "$BASE/api/questions" 200 "GET /api/questions"

# Session : consentement obligatoire (400 sans consent, 201 avec).
expect POST "$BASE/api/sessions" 400 "session sans consentement" "" '{"guest_name":"Smoke"}'
SESS=$(http_body POST "$BASE/api/sessions" "" '{"guest_name":"Smoke","consent":true}')
SID=$(json_get "$SESS" id)
[ -n "$SID" ] && echo "  ✓ session créée ($SID)" && PASS=$((PASS+1)) \
  || { echo "  ✗ création session KO : $SESS"; FAIL=$((FAIL+1)); false; }
expect GET "$BASE/api/sessions/$SID/answers" 200 "réponses de session" "$TOKEN"

echo "  🧑 upload vidéo / capture MediaRecorder : non testable sans navigateur"

summary
