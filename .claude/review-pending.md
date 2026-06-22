---
status: tests-passed
base_commit: 2285e8cb951fbd3e7ad19eca7a17bd3d775e9ded
workspaces: [@kapsule/hub-server, @kapsule/borne-server, @kapsule/core]
generated_at: 2026-06-23T00:20:00Z
verdict: COMMIT À CORRIGER
tested_at: 2026-06-22T22:19:45Z
tested_commit: 2285e8cb951fbd3e7ad19eca7a17bd3d775e9ded
commits_since_review: 0
---

# Relais de review → tests

Workspaces à tester :
- @kapsule/hub-server (raison : registry.js migration 8 + deleteJobsForEvent, routes/events.js DELETE total + provision à la création, sync.js STATUS_ORDER ; tests events/registry/sync/gallery/questions/worker.jobs/eventConfig adaptés)
- @kapsule/borne-server (raison : tests questions.test.js + sync.routes.test.js adaptés — seed explicite des questions suite au retrait de DEFAULT_QUESTIONS)
- @kapsule/core (raison : constants.js EVENT_STATUS/STATUS_ORDER — suppression de draft ; core.test.js adapté)

Points d'attention pour les tests (findings du reviewer à confirmer par les tests) :
- Migration 8 (remove_draft_status) : vérifier idempotence (re-run sur DB déjà migrée → no-op via le garde `'draft'` dans currentCheck) et que preview_desired survit à la reconstruction de table (réajout par ALTER après le rebuild).
- DELETE total : après suppression, GET /api/events/:id → 404 (plus de ligne 'waiting'). Vérifier que box_tokens/event_users/event_versions partent par CASCADE et que jobs est bien vidé (deleteJobsForEvent), et que la trace sync_log 'delete' (event_id orphelin, sans PII) subsiste.
- Ordre middlewares DELETE : client assigné → 403 (requireAdmin), event inexistant → 404 (requireOwner avant requireAdmin).
- Provision à la création : POST /api/events crée l'event en statut 'preview' (plus 'draft') et déclenche startPreview (best-effort, ne doit pas faire échouer le 201 si Docker indispo).
- Retrait DEFAULT_QUESTIONS : confirmer qu'aucun test n'insère encore une video avec question_id pointant une question seedée disparue (FK videos.question_id), côté hub et borne.

## Résultats des tests

- @kapsule/core : 18 tests, 18 ok, 0 échec (wall: 1s)
- @kapsule/hub-server : 324 tests, 324 ok, 0 échec (wall: 26s)
- @kapsule/borne-server : 225 tests, 225 ok, 0 échec (wall: 67s)
- Smoke : non requis (pas de changement infra — aucun docker-compose*.yml, docker/*.conf, Dockerfile, ni routes preview touchés)

## Corrections demandées

- [x] ⚠️ `PROJET.md` (§2 cycle de vie ~l.45-58, §5 schéma events ~l.342-343, §7 endpoints ~l.461-464) — doc contractuelle devenue fausse : le statut `draft` est supprimé (events créés directement en `preview`, provision Docker à la création), `POST /api/events` ne seed plus de questions par défaut, et `DELETE /api/events/:id` n'est plus une « purge RGPD » laissant la ligne en `waiting` mais une **suppression totale** réservée aux superusers. Mettre à jour : diagramme du cycle de vie, liste des transitions manuelles (plus de `draft↔preview`), CHECK du schéma `events` (sans `draft`), description de `POST /api/events` et de `DELETE`. → FAIT : §2 (cycle `preview → … → waiting`, états Hub sans `draft`, `preview` = statut initial, `waiting`/suppression totale), §5.2 (plus de seed questions), §5.3 (CHECK sans `draft` + note RGPD suppression totale), §6 (POST borne sans seed), §7 (POST=`preview`+provision+superuser, transitions `preview↔ready` seulement, DELETE total + chaîne d'auth), §13 timeline + emplacement du bouton suppression.
- [x] ⚠️ `apps/hub/web/src/pages/AdminPage.jsx:354` et `:460` — les deux blocs `event-panel__section` portent le même commentaire `{/* Bloc actions sur l'événement */}` alors que le premier expose « Paramètres de l'évenement » (lien Configurer) et le second « Actions » (bouton Supprimer). Commentaire trompeur + faute d'orthographe « évenement » dans le label visible. Corriger commentaire + label. → FAIT : commentaires distincts (« Bloc configuration » / « Bloc actions destructives »), label corrigé « Paramètres de l'événement ».
- [x] 💡 `registry.js` migration 7 — commentaire devenu trompeur (« preview ne tourne que sur action explicite, pas dès la création ») : ajout d'une note précisant que depuis le retrait de `draft`, `POST /api/events` provisionne dès la création.
