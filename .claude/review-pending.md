---
status: tests-passed
commit: uncommitted
workspaces: [@kapsule/borne-server, @kapsule/borne-web, @kapsule/hub-web]
generated_at: 2026-06-20T19:00:00Z
verdict: COMMIT À CORRIGER
tested_at: 2026-06-20T21:14:30Z
tested_commit: f945ee6906f243c37468b19fa5c650355d8a056b
---

# Relais de review → tests

Workspaces à tester :
- @kapsule/borne-server (raison : gate `isPreviewMode` ajouté sur `POST /api/sync/push-config` dans `routes/sync.js` + nouveau test 403 dans `test/sync.routes.test.js`)
- @kapsule/borne-web (raison : `SyncPanel.jsx` masque le bouton « Push config » en mode preview)
- @kapsule/hub-web (raison : `client.js` retire `importPreviewConfig` ; `EventDetailPage.jsx` supprime le bloc d'import de config preview et le chargement de `getSyncInfo`/`tokens`)

Points d'attention pour les tests (findings du reviewer à confirmer par les tests) :
- Le nouveau test borne-server crée `previewApp` sans `seedAuthUsers` : la connexion `{ password: 'tech-test' }` passe par le fallback `TECH_PASSWORD` (auth.js:51-56) et doit émettre un token `tech_borne` valide, qui atteint bien le gate 403. Confirmer que le test passe vraiment au 403 (et non un 401 dû à un token absent).
- Vérifier qu'aucun test existant de `push-config` (cas nominal borne réelle) ne tournait en mode preview et ne casse avec le nouveau 403.
- hub-web : confirmer que `EventDetailPage` se charge sans `getSyncInfo`/`tokens`/`previewTokens` (aucune référence résiduelle à `importPreviewConfig`, `previewBorne`, `onConfigImported`).

## Corrections demandées

> Cette section est lue par l'agent principal pour implémenter les corrections.
> Chaque item est coché par l'agent principal une fois corrigé.

- [x] ⚠️ `PROJET.md:431` — Corriger la description de `POST /api/sync/push-config` : remplacer « Autorisé en mode preview » par « Interdit en mode preview (403) — réservé à la borne réelle ; la config Hub reste la source de vérité ». Le code (sync.js:124) renvoie désormais 403 en preview ; la doc contractuelle (PROJET.md fait foi) ne doit pas mentir.
