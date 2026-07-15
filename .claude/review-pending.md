---
status: tests-pending
base_commit: ee012d12a4bf016130d80ed86f1b5db0fda16519
workspaces: [@kapsule/core, @kapsule/hub-server, @kapsule/borne-server, @kapsule/hub-web, @kapsule/borne-web]
generated_at: 2026-07-15T00:00:00Z
verdict: COMMIT OK
---

# Relais de review → tests

Re-review des corrections design.E+F. Le ❌ (écriture arbitraire au pull) et les
5 ⚠️ de la review précédente ont été vérifiés dans le code réel et sont corrigés.
Seule dérive résiduelle trouvée : deux notes obsolètes dans ARCHITECTURE.md décrivant
l'ancien comportement vulnérable — corrigées par le reviewer (doc only, pas de code).

Workspaces à tester :
- @kapsule/core (raison : `isValidAssetFilename` ajouté à `packages/core/src/design.js`)
- @kapsule/hub-server (raison : `restoreEventDesign` dans `routes/events.js`, import dans `routes/versions.js`, ordre vérif/rmSync dans `PUT /:eventId/design`, `routes/sync.js` design)
- @kapsule/borne-server (raison : `pull.js` validation filename + `dropDesignMeta`, `routes/events.js` `GET /event/design/:filename` durci)
- @kapsule/hub-web (raison : DesignEditor.jsx / EventDetailPage.jsx / client.js modifiés)
- @kapsule/borne-web (raison : `utils/design.js` nouveau, StartScreen/ThankYouScreen/GuestPage modifiés)

Points d'attention pour les tests (findings du reviewer à confirmer par les tests) :
- Pull avec `filename: '../db.sqlite'` → doit rejeter ET laisser db.sqlite intact (test présent sync.pull.test.js:454).
- Pull avec checksum invalide → `event_meta.design` doit être absent après échec (test présent sync.pull.test.js:466).
- `PUT /:eventId/design` aux images source manquantes → 409 SANS détruire le design déjà appliqué (test présent eventDesign.test.js:141).
- Restore d'une version antérieure au design → retire le design ; restore d'une version avec design → réapplique (tests présents eventDesign.test.js:212/234).
- Route publique borne `GET /api/event/design/:filename` : un filename légitime reste servi en 200 (non-régression à confirmer).
- Absence de cycle d'import versions.js ↔ events.js confirmée par lecture (events.js n'importe pas versions.js).

## Corrections demandées

Aucune correction requise.
