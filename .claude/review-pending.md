---
status: tests-passed
commit: ac789ad84b8fcb2c7fb0f8bcf1c1c98bdd7fc7ea
workspaces: [@kapsule/hub-web]
generated_at: 2026-06-20T18:40:00Z
tested_at: 2026-06-20T18:30:12Z
tested_commit: ac789ad84b8fcb2c7fb0f8bcf1c1c98bdd7fc7ea
verdict: COMMIT OK
---

# Relais de review → tests

Workspaces à tester :
- @kapsule/hub-web (raison : EventsPage.jsx, EventDetailPage.jsx, SyncStatus.jsx, app.css modifiés — badges/labels/transitions preview+waiting)

Points d'attention pour les tests (findings du reviewer à confirmer par les tests) :
- Les 4 transitions déclenchées par l'UI (`draft→preview`, `preview→draft`, `preview→ready`, `ready→preview`) doivent toutes être acceptées par `PUT /api/events/:id/status` (déjà couvert côté hub-server WA.1-4) ; le front se contente d'appeler `api.setEventStatus`.
- `preview` n'est PAS dans `FROZEN_STATUSES` : QuestionEditor / Design doivent rester éditables en statut `preview` (cohérent avec PROJET.md §4 « édition autorisée en draft/preview/loaded »).

## Corrections demandées

Aucune correction requise.
