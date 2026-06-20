---
status: tests-passed
commit: uncommitted
workspaces: [@kapsule/hub-server, @kapsule/borne-server]
generated_at: 2026-06-20T12:30:00Z
tested_at: 2026-06-20T18:20:45Z
tested_commit: 508077ff69456addae299c766ff2dd83f5603ab3
verdict: COMMIT À CORRIGER
---

# Relais de review → tests

Workspaces à tester :
- @kapsule/borne-server (raison : routes/sessions.js, routes/sync.js, routes/events.js, sync/pull.js modifiés + tests events/sessions)

Points d'attention pour les tests (findings du reviewer à confirmer par les tests) :
- Le test `POST /api/preview/login` passe uniquement parce que le mock Hub fabrique un champ `requiresLogin` sur `GET /api/sync/event` — alors que le vrai endpoint Hub (`apps/hub/server/src/routes/sync.js:142-146`) ne renvoie PAS ce champ. Un test d'intégration borne↔Hub réel renverrait 403 systématiquement. À confirmer : ajouter un test borne qui mocke la réponse RÉELLE de `/api/sync/event` (sans `requiresLogin`).
- Vérifier qu'aucun test ne couvre le cas « user Hub valide mais NON assigné `general` à cet événement » — c'est le trou d'autorisation §11.24. Un tel test devrait échouer avec l'implémentation actuelle (elle accepterait n'importe quel compte Hub valide).

## Corrections demandées

> Cette section est lue par l'agent principal pour implémenter les corrections.
> Chaque item est coché par l'agent principal une fois corrigé.

- [x] ❌ `apps/borne/server/src/routes/sessions.js:178-197` — §11.24 : corrigé par Option B — nouveau endpoint Hub `POST /api/sync/event/login` (protégé par box token) qui authentifie ET vérifie l'assignation `general` en un seul appel. La borne ne délègue plus que ce seul appel.
- [x] ❌ `apps/borne/server/src/routes/sessions.js:182-197` — corrigé : la borne n'appelle plus `GET /api/sync/event`. Le seul appel est `POST /api/sync/event/login` (endpoint réel existant). Mock borne aligné sur la vraie interface (status 200/401/403).

<!-- ── Review 2026-06-20T12:30 (Option B, findings nouveaux) ─────────────── -->

Workspaces à tester (review 2) :
- @kapsule/hub-server (nouveau endpoint `POST /api/sync/event/login` + tests sync.test.js)
- @kapsule/borne-server (sessions/sync/events/pull alignés Option B + tests)

Points d'attention (review 2) :
- Hub : `POST /api/sync/event/login` → 403 si event non `preview` (token réel `loaded`), 401 email inconnu / mdp incorrect / compte sans hash, 403 user valide mais NON assigné `general`, 200 sinon. Le trou d'autorisation §11.24 (compte Hub valide non assigné) doit désormais donner 403.
- Borne : `POST /api/preview/login` ne fait qu'UN appel Hub (`/api/sync/event/login`) ; le mock reflète la vraie interface (status seul + `{ ok: true }`), plus aucun champ `requiresLogin` fabriqué.
- Borne : pull.js n'écrit plus aucun user `general` dans `event_users` et pose `event_meta.requires_login` ; `GET /api/sync/status` et `GET /api/event` lisent `requires_login` depuis `event_meta`.

Corrections demandées (review 2) :
- [x] ❌ `PROJET.md:610` (§11.24) et `PROJET.md:483` (§10 bundle) — mis à jour : §11.24 décrit l'Option B (un seul appel `POST /api/sync/event/login`, auth+assignation côté Hub) ; nouvel endpoint ajouté dans la liste §10.
- [ ] ⚠️ `apps/hub/server/src/routes/sync.js:513,523,533` — ignoré volontairement (période de test, à traiter avant commercialisation).
