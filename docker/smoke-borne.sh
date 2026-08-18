#!/usr/bin/env bash
# Smoke test end-to-end de la BORNE sans Hub : démarre le stack
# docker-compose.borne.yml et vérifie, par curl, que le SPA est servi et que
# la surface API répond (public invité, auth, gardes de rôle, parcours
# session). Voir smoke-common.sh.
#
# La borne n'a pas de route HTTP de création d'événement (un événement vient
# normalement d'un pull Hub). Pour exercer le parcours invité sans Hub, on seede
# un événement local (avec un tech_pin, pour l'auth) DANS le container via le
# vrai code registry (docker exec), puis on curl le serveur réel. Plus de
# TECH_PASSWORD (retiré du code, PROJET.md §11.30) : l'auth de ce smoke test
# passe par le même PIN que la vraie console /borne.
#
# Usage :  docker/smoke-borne.sh [--keep]

set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=docker/smoke-common.sh
source docker/smoke-common.sh

COMPOSE="docker compose -f docker-compose.borne.yml -p smoke-borne"
# Ports non-standards par défaut (surchargeable) : évite tout conflit avec un
# vrai déploiement (Hub edge ou borne réelle) qui occuperait 80/443 sur la
# même machine. BORNE_HTTP_PORT/BORNE_HTTPS_PORT paramètrent docker-compose.borne.yml.
HTTP_PORT="${SMOKE_BORNE_HTTP_PORT:-18080}"
HTTPS_PORT="${SMOKE_BORNE_HTTPS_PORT:-18443}"
BASE="https://localhost:${HTTPS_PORT}"   # cert auto-signé → http_code/-k l'accepte
TECH_PIN="654321"
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

echo "=== SMOKE BORNE (sans Hub) — ports ${HTTP_PORT}/${HTTPS_PORT} ==="
echo "→ teardown préalable (stack résiduelle éventuelle)"
$COMPOSE down -v >/dev/null 2>&1 || true
echo "→ build & up"
JWT_SECRET="smoke-secret" \
  BORNE_HTTP_PORT="$HTTP_PORT" BORNE_HTTPS_PORT="$HTTPS_PORT" \
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

# ── 3. Seed d'un événement local 'live' actif, avec tech_pin ─────────────────
# La borne n'a pas de route de création d'événement (vient d'un pull Hub). On
# seede via le vrai code registry (docker exec) pour exercer le parcours invité
# et les routes qui exigent un événement actif — ainsi qu'un tech_pin dans
# event_meta, pour pouvoir se logger sans Hub (plus de TECH_PASSWORD). Backend
# ESM ; WORKDIR container = /app/apps/borne/server (cf. Dockerfile).
echo "[Seed événement]"
EID=$($COMPOSE exec -T backend node --input-type=module -e "
  import { openRegistry, insertEvent, setActiveEvent } from './src/registry.js';
  import { getActiveEventDb } from './src/eventDb.js';
  import { randomUUID } from 'node:crypto';
  import { mkdirSync } from 'node:fs';
  import { join } from 'node:path';
  const dataDir = process.env.DATA_DIR;
  openRegistry(dataDir);
  const id = randomUUID();
  insertEvent({ id, name: 'Smoke Borne', origin: 'local', status: 'live' });
  setActiveEvent(id);
  mkdirSync(join(dataDir, 'events', id), { recursive: true });
  const edb = getActiveEventDb(dataDir, { id });   // crée db.sqlite + questions par défaut
  edb.prepare(\"INSERT INTO event_meta (key, value) VALUES ('tech_pin', ?)\").run('$TECH_PIN');
  process.stdout.write(id);
" 2>/dev/null | tr -d '[:space:]')

[ -n "$EID" ] && echo "  ✓ événement seedé ($EID)" && PASS=$((PASS+1)) \
  || { echo "  ✗ seed événement KO"; FAIL=$((FAIL+1)); false; }

# ── 4. Auth (PIN partagé — plus de TECH_PASSWORD) ─────────────────────────────
echo "[Auth]"
expect POST "$BASE/api/admin/login" 401 "login mauvais PIN" "" '{"pin":"000000"}'
LOGIN=$(http_body POST "$BASE/api/admin/login" "" "{\"pin\":\"$TECH_PIN\"}")
TOKEN=$(json_get "$LOGIN" token)
[ -n "$TOKEN" ] && echo "  ✓ login PIN → JWT (tech)" && PASS=$((PASS+1)) \
  || { echo "  ✗ login PIN KO : $LOGIN"; FAIL=$((FAIL+1)); false; }

# ── 5. Gardes d'auth (événement actif présent) ────────────────────────────────
echo "[Gardes]"
expect GET "$BASE/api/videos" 401 "videos sans token"
expect GET "$BASE/api/videos" 200 "videos avec token" "$TOKEN"
# Routes tech : le token PIN porte tech_borne (sur-ensemble) → 200.
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
