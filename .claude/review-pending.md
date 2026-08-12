---
status: tests-failed
base_commit: 4787055a08cf855a2105807ac3196d09ce837456
workspaces: [@kapsule/borne-server, @kapsule/borne-web, @kapsule/hub-server, @kapsule/hub-web]
generated_at: 2026-08-12T21:15:08Z
verdict: COMMIT OK
tested_at: 2026-08-12T21:22:19Z
tested_commit: 4787055a08cf855a2105807ac3196d09ce837456
commits_since_review: 0
---

# Relais de review → tests

Sous-lot Phase C (4ᵉ passe) : auth PIN admin_borne/tech_borne partagé, onboarding
pré-appairage, split `.env.example` → `.env.example-hub`/`.env.example-rasp`,
durcissement des gardes de config (TECH_PASSWORD / ADMIN_PASSWORD_HUB = `change-me`).

Workspaces à tester :
- @kapsule/borne-server (raison : middleware/auth.js login PIN, config.js garde change-me, routes/sync.js pairing-status, sync/pull.js purge event_users, initLog.js)
- @kapsule/borne-web (raison : AdminLogin.jsx, BornePage.jsx, OnboardingScreen.jsx, api/client.js, GuestPage.jsx)
- @kapsule/hub-server (raison : routes/events.js ensurePins/redactPins/roles, eventConfig.js META_KEYS, routes/admin.js VALID_ROLES, routes/sync.js bundle sans users, config.js garde change-me)
- @kapsule/hub-web (raison : AdminPage.jsx, EventDetailPage.jsx)

Infra touchée (docker-compose.hub.yml : PREVIEW_BACKEND_IMAGE, HUB_URL_INTERNAL,
TECH_PASSWORD_PREVIEW) → lancer aussi les smoke tests (`npm run smoke`) avant déploiement.

Points d'attention pour les tests (à confirmer) :
- Login borne : `{ pin }` doit essayer `tech_pin` AVANT `admin_pin` ; fallback `{ password }`
  refusé (401) dès qu'un `admin_pin` OU `tech_pin` existe sur l'événement actif.
- `GET /api/sync/pairing-status` : réponse complète (hubUrl + logs) UNIQUEMENT si `hasToken=false` ;
  réponse minimale `{hasToken:true, hasActiveEvent}` une fois appairée (pas de fuite topologie/logs).
- `GET /api/event` (borne, public/Internet-facing preview) ne doit JAMAIS exposer `admin_pin`/`tech_pin`
  (whitelist de champs explicite — vérifié en revue, mais un test de non-régression serait utile).
- Hub : un membre `event_users` à rôle `general` seul (auth wall preview) doit recevoir un événement
  SANS `admin_pin`/`tech_pin` (redactPins) et un 403 s'il tente de les modifier.
- `pull.js` : `DELETE FROM event_users` inconditionnel à chaque pull (purge résidu pré-Phase C) ;
  le bundle ne transporte plus `users`.

## Corrections demandées

Aucune correction requise.

> Un point mineur (💡, non bloquant) subsiste, laissé à l'appréciation de l'agent principal :
> `.env.example-hub:74` — le commentaire dit que le backend borne refuse de démarrer si
> `TECH_PASSWORD` vaut `"tech123"` ; la garde rejette désormais AUSSI `"change-me"`. Reformuler
> « vaut le défaut "tech123" » en « vaut une valeur d'exemple ("tech123"/"change-me") ».

## Verdict tests (kapsule-tester)

`base_commit` vérifié : existe, ancêtre de HEAD. `git rev-list --count base_commit..HEAD` = 0
(uniquement des changements non commités dans le working tree, cohérent avec la correction
mineure `.env.example-hub` mentionnée par le reviewer). `git diff base_commit --stat` confirme
les 4 workspaces listés + `apps/borne/server/src/config.js` et `apps/hub/server/src/config.js`
(couverts par les runs de workspace complets ci-dessous, pas de fichier testable non couvert).

Tests unitaires (par workspace, séquentiel) :
- @kapsule/borne-server : 293 tests, 293 ok, 0 échec
- @kapsule/borne-web : 28 tests, 28 ok, 0 échec
- @kapsule/hub-server : 510 tests, 510 ok, 0 échec (run complet du workspace, pas seulement
  les fichiers listés dans le relais)
- @kapsule/hub-web : 29 tests, 29 ok, 0 échec

Smoke tests (`npm run smoke` = smoke-hub + smoke-borne + smoke-preview), requis car
`docker-compose.hub.yml` est dans le diff (PREVIEW_BACKEND_IMAGE/HUB_URL_INTERNAL/
TECH_PASSWORD_PREVIEW) :
- smoke-hub : ÉCHEC — `statut draft→preview → attendu 200, reçu 400`
- smoke-borne : 16/16 ok
- smoke-preview : ÉCHEC — `statut → preview → attendu 200, reçu 400`

**Diagnostic (pour info, pas une correction faite par moi) :** ces deux échecs ne sont PAS
liés au diff de ce sous-lot. `docker/smoke-hub.sh` et `docker/smoke-preview.sh` sont
inchangés depuis `base_commit` (`git diff base_commit --stat` : aucune ligne pour ces
fichiers). Les deux scripts tentent une transition manuelle de statut vers `'preview'`
(`PUT /api/events/:id/status {"status":"preview"}`), en supposant qu'un événement fraîchement
créé est en statut `draft`. Or le statut `draft` a été supprimé par une migration
antérieure à `base_commit` (`remove_draft_status`, commit `e82a439`) : un événement démarre
désormais directement en `preview` (`apps/hub/server/src/registry.js:372-373`). La table
`MANUAL_TRANSITIONS` (`apps/hub/server/src/routes/events.js:162-165`, inchangée dans ce
diff) n'autorise que `preview→ready` et `ready→preview` — pas `preview→preview` — d'où le
400. Contrairement à la review VPS (pas de Docker rapide, smoke non lancés), c'est la
première fois que ces deux smoke scripts tournent depuis la suppression de `draft` ; le
décalage script/produit était donc invisible jusqu'ici. `docker-compose.hub.yml` lui-même
(le vrai objet de l'infra touchée par ce sous-lot) n'est pas en cause : le stack démarre,
le SPA est servi, l'auth et le flux events/questions/users fonctionnent jusqu'à cette ligne
précise dans les deux scripts.

Nettoyage : les 3 stacks smoke (hub/borne/preview) ont été correctement démontés en fin de
script (`docker ps -a` vide pour les 3 projets après coup) malgré l'échec en cours de route.

## Échecs

- smoke-hub › `docker/smoke-hub.sh:95` : `expect PUT "$BASE/api/events/$EID/status" 200
  "statut draft→preview" "$TOKEN" '{"status":"preview"}'` → `✗ statut draft→preview →
  attendu 200, reçu 400`
- smoke-preview › `docker/smoke-preview.sh:122` : `expect PUT
  "$BASE/api/events/$CREATED_EID/status" 200 "statut → preview" "$TOKEN"
  '{"status":"preview"}'` → `✗ statut → preview → attendu 200, reçu 400`
