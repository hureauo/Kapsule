---
status: tests-pending
base_commit: b37a0d5b098ac0a8224f9749ab15de7aecc4a5f2
workspaces: [@kapsule/core, @kapsule/hub-server, @kapsule/hub-web, @kapsule/borne-server, @kapsule/borne-web]
generated_at: 2026-07-20T17:28:00Z
verdict: COMMIT OK
---

# Relais de review → tests

Re-review du chantier design4 (« une seule image par écran, centrée/plein écran/aucune »).
Les 3 bloquants du premier passage sont résolus ; aucun nouveau bloquant. Diff app-code + doc
uniquement, aucun fichier d'infra (docker/nginx/.env) touché.

Workspaces à tester :
- @kapsule/core (raison : `packages/core/src/design.js` — contrat `images`/`DESIGN_IMAGE_SCREENS`/`DESIGN_IMAGE_MODES`, retrait `layouts`/`assets`)
- @kapsule/hub-server (raison : `routes/designs.js` `?screen=`, `routes/events.js` `materializeEventDesign`/`restoreEventDesign`, `registry.js` seed)
- @kapsule/hub-web (raison : `DesignEditor.jsx`, `DesignPreview.jsx`, `api/client.js` migrés `images`)
- @kapsule/borne-server (raison : `routes/events.js` `resolveDesign` migré `images` + ajout `screenOverrides` — c'est la suite qui échouait avant)
- @kapsule/borne-web (raison : `StartScreen.jsx`/`ThankYouScreen.jsx` lisent `images.<screen>`)

Points d'attention pour les tests (à confirmer) :
- borne-server : `GET /api/event` doit exposer `design.images.start.filename` en URL `/api/event/design/<filename>` et `design.screenOverrides` (nouvel ajout) ; `GET /api/event/design/:filename` doit servir l'image et 404 hors whitelist.
- hub-server : `POST /api/designs/:id/assets?screen=start` fixe `mode:'centered'` par défaut (ou conserve le mode ≠ none) ; `DELETE .../assets/:screen` remet `mode:'none', filename:null` ; upload d'un mode incohérent rejeté par `validateDesign` (400).
- core : `validateDesign` rejette `mode !== 'none'` sans filename valide, et `mode === 'none'` avec filename non-null.
- Un `npm run smoke` n'est PAS requis : aucun fichier d'infra (compose/nginx/edge) n'est touché.

## Corrections demandées

Aucune correction requise.
