---
status: tests-pending
base_commit: f7454c9
workspaces: [@kapsule/hub-server, @kapsule/hub-web]
generated_at: 2026-06-21T10:00:00Z
verdict: COMMIT OK
---

# Relais de review → tests

Workspaces à tester :
- @kapsule/hub-server (raison : registry.js migration 7 `preview_desired`, routes/events.js preview start/stop + auto-provision, preview/provisioner.js `startPreview`, scripts/reconcile-previews.js)
- @kapsule/hub-web (raison : EventDetailPage.jsx — onglet Aperçu retiré, PreviewBox ajoutée)

Points d'attention pour les tests (findings du reviewer à confirmer par les tests) :
- Migration 7 idempotente : double garde (table `schema_migrations` + `cols.includes('preview_desired')`). Vérifier qu'un double `openRegistry` ne casse pas.
- `POST /preview/start` sur container absent → 200 `{provisioned:true}` (test events.test.js mis à jour, l'ancien cas 404 a été remplacé).
- `preview_desired` correctement écrit à 'running' (création + start) et 'stopped' (stop + purge).
- Pas de fuite RGPD : `preview_desired` est une métadonnée sur `events` dans registry.sqlite — aucune donnée invité.

## Corrections demandées

Aucune correction requise.
