#!/usr/bin/env bash
# Smoke test end-to-end de la BORNE PREVIEW auto-provisionnée.
#
# Vérifie le cycle complet, sur containers réels (docker.sock), qu'on ne peut PAS
# couvrir en `npm test` (pas de Docker dans les tests unitaires — cf. CLAUDE.md) :
#   1. créer un événement + le passer en statut 'preview'
#   2. démarrer la preview via POST /preview/start (provision docker.sock)
#   3. attendre que le container frontend réponde (pas de 502 du backend interne)
#   4. vérifier que la borne preview a un ÉVÉNEMENT ACTIF (pull Hub réussi)
#   5. arrêter la preview, vérifier l'état hors ligne
#   6. nettoyer (suppression event → deprovision)
#
# Le 502 « Bad Gateway » est le symptôme clé : il signifie que le frontend nginx
# ne joint pas son backend (backend crashé : TECH_PASSWORD manquant, etc.).
# On vérifie donc explicitement que /api/event répond 200 (et non 502/404).
#
# Usage :  docker/smoke-preview.sh [--keep]

set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=docker/smoke-common.sh
source docker/smoke-common.sh

COMPOSE="docker compose -f docker-compose.hub.yml -p smoke-preview"
BASE="https://localhost"
KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

ADMIN_EMAIL="smoke-preview-admin@kapsule.test"
ADMIN_PASS="smoke-preview-pass-123"

# Slug déterministe (sha256(eventId)[:8]) — doit suivre slugFor() côté Hub.
slug_for() { printf '%s' "$1" | sha256sum | cut -c1-8; }

CREATED_EID=""

teardown() {
  # Best-effort : supprimer l'event (deprovision les containers preview) + stack.
  if [ -n "$CREATED_EID" ] && [ -n "${TOKEN:-}" ]; then
    http_code DELETE "$BASE/api/events/$CREATED_EID" "$TOKEN" "{\"confirm\":\"Smoke Preview\"}" >/dev/null 2>&1 || true
  fi
  # Filet de sécurité : retirer tout container preview résiduel de ce smoke.
  if [ -n "$CREATED_EID" ]; then
    local s; s=$(slug_for "$CREATED_EID")
    docker rm -f "preview-$s" "preview-backend-$s" >/dev/null 2>&1 || true
    docker network rm "preview-net-$s" >/dev/null 2>&1 || true
  fi
  if [ "$KEEP" -eq 1 ]; then
    echo "→ --keep : stack laissé debout ($COMPOSE)"
  else
    echo "→ teardown"
    $COMPOSE down -v >/dev/null 2>&1 || true
  fi
}
trap teardown EXIT

echo "=== SMOKE PREVIEW ==="

# Les images borne preview doivent exister (le provisioner les lance par nom).
echo "→ vérification des images borne preview"
for img in kapsule-borne-preview-backend kapsule-borne-preview-frontend; do
  if docker image inspect "$img" >/dev/null 2>&1; then
    echo "  ✓ image présente : $img"
    PASS=$((PASS + 1))
  else
    echo "  ✗ image manquante : $img — lancer 'docker compose -f docker-compose.preview.yml -p kapsule build'"
    FAIL=$((FAIL + 1))
    exit 1
  fi
done

echo "→ nettoyage d'un éventuel stack hub préexistant"
docker compose -f docker-compose.hub.yml -p kapsule down >/dev/null 2>&1 || true
$COMPOSE down -v >/dev/null 2>&1 || true
docker rm -f hub-backend >/dev/null 2>&1 || true

echo "→ build & up"
ADMIN_EMAIL="$ADMIN_EMAIL" ADMIN_PASSWORD_HUB="$ADMIN_PASS" JWT_SECRET="smoke-secret" \
  TECH_PASSWORD_PREVIEW="smoke-tech-pass" \
  $COMPOSE up -d --build >/dev/null

wait_ready "$BASE/api/health" 120

# ── 1. Login + événement en statut preview ────────────────────────────────────
echo "[Setup]"
LOGIN=$(http_body POST "$BASE/api/auth/login" "" "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASS\"}")
TOKEN=$(json_get "$LOGIN" token)
[ -n "$TOKEN" ] && echo "  ✓ login admin → JWT" && PASS=$((PASS+1)) \
  || { echo "  ✗ login admin KO : $LOGIN"; FAIL=$((FAIL+1)); false; }

EV=$(http_body POST "$BASE/api/events" "$TOKEN" '{"name":"Smoke Preview"}')
CREATED_EID=$(json_get "$EV" id)
[ -n "$CREATED_EID" ] && echo "  ✓ création event ($CREATED_EID)" && PASS=$((PASS+1)) \
  || { echo "  ✗ création event KO : $EV"; FAIL=$((FAIL+1)); false; }

# ── 1b. Utilisateur 'general' assigné AVANT le start ──────────────────────────
# Assigner un user 'general' rend requiresLogin=true côté Hub. Cette valeur est
# pullée par la borne au démarrage → on assigne donc AVANT de lancer la preview,
# sinon l'auth wall ne serait pas actif au 1er pull.
echo "[User general]"
GUSER_EMAIL="smoke-guest-$RANDOM@kapsule.test"
GUSER_PASS="smoke-guest-pass-123"
NU=$(http_body POST "$BASE/api/admin/users" "$TOKEN" "{\"email\":\"$GUSER_EMAIL\",\"name\":\"Smoke Guest\"}")
REG_URL=$(json_get "$NU" registration_url)
# Le token d'enregistrement est en query (?token=...) — extraction sans jq.
REG_TOKEN=$(printf '%s' "$REG_URL" | sed -E 's/.*[?&]token=([^"&]+).*/\1/')
[ -n "$REG_TOKEN" ] && echo "  ✓ user créé + registration token" && PASS=$((PASS+1)) \
  || { echo "  ✗ pas de registration token : $NU"; FAIL=$((FAIL+1)); false; }

# Poser le mot de passe via le token d'enregistrement
expect POST "$BASE/api/auth/set-password" 200 "set-password guest" "" "{\"token\":\"$REG_TOKEN\",\"password\":\"$GUSER_PASS\"}"

# Récupérer l'id du user pour l'assignation
GUSER_ID=$(json_get "$(http_body GET "$BASE/api/admin/users" "$TOKEN" | tr '}' '\n' | grep "$GUSER_EMAIL")" id)
[ -n "$GUSER_ID" ] && echo "  ✓ user id résolu ($GUSER_ID)" && PASS=$((PASS+1)) \
  || { echo "  ✗ user id introuvable"; FAIL=$((FAIL+1)); false; }

# Assigner au rôle 'general' sur cet événement
expect POST "$BASE/api/admin/events/$CREATED_EID/users" 201 "assignation general" "$TOKEN" \
  "{\"user_id\":$GUSER_ID,\"roles\":[\"general\"]}"

expect PUT "$BASE/api/events/$CREATED_EID/status" 200 "statut → preview" "$TOKEN" '{"status":"preview"}'

SLUG=$(slug_for "$CREATED_EID")
echo "  ℹ slug preview : $SLUG (container preview-$SLUG)"

# ── 2. Démarrer la preview (provision via docker.sock) ────────────────────────
echo "[Start]"
START=$(http_body POST "$BASE/api/events/$CREATED_EID/preview/start" "$TOKEN")
echo "$START" | grep -q '"up":true' && echo "  ✓ POST /preview/start → up:true" && PASS=$((PASS+1)) \
  || { echo "  ✗ /preview/start KO : $START"; FAIL=$((FAIL+1)); false; }

# Le container backend doit être Up (pas Restarting : symptôme TECH_PASSWORD manquant).
echo "→ attente backend preview Up (30s max)…"
i=0
until [ "$(docker inspect -f '{{.State.Running}}' "preview-backend-$SLUG" 2>/dev/null)" = "true" ]; do
  i=$((i+1)); [ "$i" -ge 30 ] && { echo "  ✗ backend preview pas Up en 30s"; FAIL=$((FAIL+1)); docker logs "preview-backend-$SLUG" --tail 15 2>&1 || true; break; }
  sleep 1
done
if [ "$(docker inspect -f '{{.State.Running}}' "preview-backend-$SLUG" 2>/dev/null)" = "true" ]; then
  echo "  ✓ backend preview Up après ${i}s"; PASS=$((PASS+1))
fi

# ── 3. Pas de 502 + événement actif (pull Hub réussi) ─────────────────────────
# On interroge le frontend nginx du container preview via le réseau hub_net.
# Depuis l'hôte, on n'a pas le sous-domaine essai-<slug> ; on tape donc le
# container frontend directement (port 80 interne) via `docker exec` sur lui-même.
echo "[Preview HTTP]"
echo "→ attente /api/event (pull Hub, 30s max)…"
i=0; CODE=""
until [ "$CODE" = "200" ]; do
  CODE=$(docker exec "preview-$SLUG" sh -c 'wget -qO- -S http://localhost/api/event 2>&1 | grep "HTTP/" | tail -1 | grep -o "[0-9][0-9][0-9]"' 2>/dev/null | tail -1 || true)
  i=$((i+1))
  if [ "$i" -ge 30 ]; then break; fi
  [ "$CODE" = "200" ] || sleep 1
done

if [ "$CODE" = "502" ]; then
  echo "  ✗ /api/event → 502 Bad Gateway (frontend ne joint pas son backend)"
  FAIL=$((FAIL+1))
  docker logs "preview-backend-$SLUG" --tail 15 2>&1 || true
elif [ "$CODE" = "200" ]; then
  echo "  ✓ /api/event → 200 (pas de 502, backend joignable)"; PASS=$((PASS+1))
  BODY=$(docker exec "preview-$SLUG" sh -c 'wget -qO- http://localhost/api/event' 2>/dev/null || true)
  if echo "$BODY" | grep -q "\"id\":\"$CREATED_EID\""; then
    echo "  ✓ événement actif sur la borne (id concorde)"; PASS=$((PASS+1))
  else
    echo "  ✗ pas d'événement actif attendu : $BODY"; FAIL=$((FAIL+1))
  fi
else
  echo "  ✗ /api/event → code inattendu '$CODE' (attendu 200 ; 404 = pull pas fait)"
  FAIL=$((FAIL+1))
  docker logs "preview-backend-$SLUG" --tail 15 2>&1 || true
fi

# ── 4. Statut preview via l'API Hub ───────────────────────────────────────────
echo "[Status API]"
PS=$(http_body GET "$BASE/api/events/$CREATED_EID/preview/status" "$TOKEN")
echo "$PS" | grep -q '"up":true' && echo "  ✓ preview/status → up:true" && PASS=$((PASS+1)) \
  || { echo "  ✗ preview/status pas up : $PS"; FAIL=$((FAIL+1)); }

# ── 4b. Auth wall : login d'un invité 'general' sur la borne preview ──────────
# POST /api/preview/login délègue au Hub (POST /api/sync/event/login) qui vérifie
# identifiants + assignation 'general' sur cet event. On teste depuis l'intérieur
# du container frontend (réseau hub_net), 3 cas : succès, mauvais mdp, non-assigné.
echo "[Auth wall preview]"

# Helper : POST JSON sur la borne preview via le container frontend, renvoie "code|body".
preview_post() {
  docker exec "preview-$SLUG" sh -c \
    "wget -qO- -S --header='Content-Type: application/json' --post-data='$1' http://localhost/api/preview/login 2>&1" || true
}

# Succès : bon email + bon mdp + assigné general → token
LOGIN_OK=$(preview_post "{\"email\":\"$GUSER_EMAIL\",\"password\":\"$GUSER_PASS\"}")
if echo "$LOGIN_OK" | grep -q '"token"'; then
  echo "  ✓ login invité valide → token"; PASS=$((PASS+1))
else
  echo "  ✗ login invité valide a échoué : $(echo "$LOGIN_OK" | tail -2)"; FAIL=$((FAIL+1))
fi

# Mauvais mot de passe → 401
LOGIN_BAD=$(preview_post "{\"email\":\"$GUSER_EMAIL\",\"password\":\"WRONG-PASS\"}")
if echo "$LOGIN_BAD" | grep -q 'HTTP/.* 401'; then
  echo "  ✓ mauvais mot de passe → 401"; PASS=$((PASS+1))
else
  echo "  ✗ mauvais mdp pas rejeté en 401 : $(echo "$LOGIN_BAD" | grep HTTP/ | tail -1)"; FAIL=$((FAIL+1))
fi

# Utilisateur non assigné à l'event → 403 (on réutilise l'admin, jamais 'general' sur cet event)
LOGIN_UNASSIGNED=$(preview_post "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASS\"}")
if echo "$LOGIN_UNASSIGNED" | grep -q 'HTTP/.* 403'; then
  echo "  ✓ utilisateur non assigné → 403"; PASS=$((PASS+1))
else
  echo "  ✗ user non assigné pas rejeté en 403 : $(echo "$LOGIN_UNASSIGNED" | grep HTTP/ | tail -1)"; FAIL=$((FAIL+1))
fi

# ── 4c. Reprovision idempotente ───────────────────────────────────────────────
# Rappeler /preview/start alors que la preview tourne déjà ne doit PAS créer de
# 2e jeu de containers ni de 2e token preview-auto (bug corrigé : purge avant insert).
echo "[Idempotence]"
http_code POST "$BASE/api/events/$CREATED_EID/preview/start" "$TOKEN" >/dev/null 2>&1 || true
sleep 1
NB_CONTAINERS=$(docker ps -a --filter "name=preview-$SLUG" --format '{{.Names}}' | wc -l | tr -d ' ')
# preview-<slug> + preview-backend-<slug> = exactement 2
if [ "$NB_CONTAINERS" -eq 2 ]; then
  echo "  ✓ reprovision idempotente : 2 containers (pas de doublon)"; PASS=$((PASS+1))
else
  echo "  ✗ $NB_CONTAINERS containers preview-$SLUG (attendu 2)"; FAIL=$((FAIL+1))
fi

# ── 4d. Versioning : modifier puis restaurer la config ────────────────────────
echo "[Versioning]"
# Modifier le design (crée une version)
expect PUT "$BASE/api/events/$CREATED_EID" 200 "modif design (version)" "$TOKEN" '{"theme":"dark"}'
VLIST=$(http_body GET "$BASE/api/events/$CREATED_EID/versions" "$TOKEN")
# La version la plus récente porte un auteur = email admin (pas un id numérique "2.0")
if echo "$VLIST" | grep -q "\"author\":\"$ADMIN_EMAIL\""; then
  echo "  ✓ auteur de version résolu en email"; PASS=$((PASS+1))
else
  echo "  ✗ auteur non résolu (id numérique ?) : $(echo "$VLIST" | head -c 200)"; FAIL=$((FAIL+1))
fi
# Restaurer la version la plus ancienne (1er id de la liste triée DESC = dernier élément)
VID=$(printf '%s' "$VLIST" | grep -o '"id":[0-9]*' | tail -1 | grep -o '[0-9]*')
[ -n "$VID" ] && echo "  ✓ version à restaurer : $VID" && PASS=$((PASS+1)) \
  || { echo "  ✗ aucune version trouvée"; FAIL=$((FAIL+1)); }
expect POST "$BASE/api/events/$CREATED_EID/versions/$VID/restore" 200 "restauration version" "$TOKEN"

# ── 5. Arrêt de la preview ────────────────────────────────────────────────────
echo "[Stop]"
STOP=$(http_body POST "$BASE/api/events/$CREATED_EID/preview/stop" "$TOKEN")
echo "$STOP" | grep -q '"up":false' && echo "  ✓ POST /preview/stop → up:false" && PASS=$((PASS+1)) \
  || { echo "  ✗ /preview/stop KO : $STOP"; FAIL=$((FAIL+1)); }

PS2=$(http_body GET "$BASE/api/events/$CREATED_EID/preview/status" "$TOKEN")
echo "$PS2" | grep -q '"up":false' && echo "  ✓ preview/status → up:false après stop" && PASS=$((PASS+1)) \
  || { echo "  ✗ preview/status toujours up après stop : $PS2"; FAIL=$((FAIL+1)); }

# ── 6. Deprovision complet via suppression d'événement ────────────────────────
# DELETE /events/:id appelle deprovisionPreview : containers + réseau + token
# preview-auto doivent disparaître. C'est aussi la garantie d'un 502/404 propre
# sur essai-<slug> (plus de container = l'edge ne route plus vers rien).
echo "[Deprovision]"
expect DELETE "$BASE/api/events/$CREATED_EID" 200 "suppression event" "$TOKEN" '{"confirm":"Smoke Preview"}'
sleep 1
LEFT=$(docker ps -a --filter "name=preview-$SLUG" --format '{{.Names}}' | wc -l | tr -d ' ')
if [ "$LEFT" -eq 0 ]; then
  echo "  ✓ containers preview supprimés (deprovision complet)"; PASS=$((PASS+1))
else
  echo "  ✗ $LEFT container(s) preview-$SLUG résiduel(s) après suppression"; FAIL=$((FAIL+1))
fi
# Le réseau isolé doit aussi avoir disparu
if docker network inspect "preview-net-$SLUG" >/dev/null 2>&1; then
  echo "  ✗ réseau preview-net-$SLUG résiduel"; FAIL=$((FAIL+1))
else
  echo "  ✓ réseau isolé supprimé"; PASS=$((PASS+1))
fi
# L'événement supprimé empêche son token déjà supprimé ; on évite le double-delete au teardown
CREATED_EID=""

summary
