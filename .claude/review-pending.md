---
status: tests-passed
commit: db77f6596ea1cdf58e4d3784a3733b6d0124ded2
workspaces: [@kapsule/hub-server, @kapsule/hub-web, @kapsule/borne-server, @kapsule/borne-web]
generated_at: 2026-06-20T10:34:19Z
verdict: COMMIT À CORRIGER
tested_at: 2026-06-20T11:02:00Z
tested_commit: db77f6596ea1cdf58e4d3784a3733b6d0124ded2
---

# Relais de review → tests

Workspaces à tester :
- @kapsule/hub-server (raison : registry migrations versionées, versioning.js + routes/versions.js, provisioner start/stop, events.js preview, config.js validateConfig, body limit)
- @kapsule/hub-web (raison : AdminPage.jsx, EventDetailPage.jsx, format.js + tests, roles.js)
- @kapsule/borne-server (raison : rate-limiting login/sessions/uploads, validateConfig strict, JWT event_id scoping, plafond uploads par session, /api/admin/health)
- @kapsule/borne-web (raison : App.jsx, api/client.js, AdminLayout.jsx)

Points d'attention pour les tests (findings du reviewer à confirmer par les tests) :
- Borne : vérifier que les rate-limiters sont bien désactivés en test via cfg.skipRateLimits (sinon faux 429 dans les suites). Confirmer 429 quand le plafond uploads/session est atteint.
- Borne/Hub : validateConfig doit throw en production/preview si JWT_SECRET=change-me ou TECH_PASSWORD=tech123 (couvert par config.test.js).
- Hub : ordre de montage /versions AVANT /:eventId (gallery) — un GET /api/events/:id/versions ne doit pas tomber sur la galerie.
- Hub : runMigrations idempotent sur une DB déjà migrée (schema_migrations) — pas de double application.
- Cloisonnement cross-preview : un JWT avec event_id ≠ événement actif → 403 (auth.js requireRole + POST /api/sessions).
- Le bloquant du relais précédent (dockerCli sans running/start/stop) est RÉSOLU dans ce diff : le test de contrat d'interface dockerCli doit passer.

## Corrections demandées

> Cette section est lue par l'agent principal pour implémenter les corrections.
> Chaque item est coché par l'agent principal une fois corrigé.

- [x] ⚠️ `PROJET.md:63` — Stack §3 : `express-rate-limit` est déclaré « Hub en plus » alors qu'il est désormais dépendance de `apps/borne/server` (borne preview Internet-facing). Mettre à jour le libellé §3 pour inclure la Borne.
- [x] ⚠️ `PROJET.md §4` — Arborescence contractuelle incomplète : ajouter les nouveaux modules backend (`apps/hub/server/src/eventConfig.js`, `versioning.js`, `routes/versions.js`, `preview/provisioner.js`) et les scripts infra (`docker/edge-nginx.conf.template`, `docker/edge-entrypoint.sh`, `docker/Dockerfile.edge`, `docker/preview-start.sh`, `docker/preview-stop.sh`, `docker/smoke-*.sh`). Mentionner aussi la table `event_versions` / `schema_migrations` si §4 décrit le schéma registry.
- [x] ⚠️ `apps/hub/server/src/routes/events.js:87` — `provisionPreview(id)` (et `deprovisionPreview(event.id)` ligne 341) sont appelés sans passer le `docker` injecté du routeur (`makeEventsRouter(..., { docker })`) : ils retombent sur le `dockerCli` réel. Incohérent avec start/stop/status qui utilisent `docker` injecté. Passer `provisionPreview(id, docker)` / `deprovisionPreview(event.id, docker)` pour rester testable et homogène.
