---
status: tests-pending
base_commit: fc80afe72cea0bf3b3cdf94ccd2463717b8125af
workspaces: [@kapsule/core, @kapsule/hub-server, @kapsule/borne-server, @kapsule/hub-web, @kapsule/borne-web]
generated_at: 2026-07-20T00:00:00Z
verdict: COMMIT OK
---

# Relais de review → tests

Workspaces à tester :
- @kapsule/core (raison : validation widthPercent ajoutée dans design.js + tests)
- @kapsule/hub-server (raison : bugfix upload spread previousEntry dans routes/designs.js + tests de régression)
- @kapsule/borne-server (raison : resolveDesign propage widthPercent dans routes/events.js + test)
- @kapsule/hub-web (raison : DesignEditor.jsx slider + DesignPreview.jsx style — build vite)
- @kapsule/borne-web (raison : imageWidthStyle + StartScreen/ThankYouScreen — build vite)

Points d'attention pour les tests (findings du reviewer à confirmer par les tests) :
- Non-régression du bugfix upload (spread previousEntry) : remplacement de fichier conserve widthPercent, changement de mode centered→cover→centered ne persiste pas de widthPercent invalide (validateDesign rejette widthPercent hors centered). Couvert par les tests ajoutés de designs.test.js.
- resolveDesign borne : widthPercent absent (non-entier) → non exposé. Couvert par events.test.js.

## Corrections demandées

Aucune correction requise.
