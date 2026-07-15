---
status: tests-pending
base_commit: 039c72e7aa50965655d1027038946db7f1eac1ac
workspaces: [@kapsule/core, @kapsule/hub-server, @kapsule/hub-web]
generated_at: 2026-07-15T00:00:00Z
verdict: COMMIT OK
---

# Relais de review → tests

Workspaces à tester :
- @kapsule/core (raison : DESIGN_FONTS/FONT_PRESETS étendus, design.test.js mis à jour)
- @kapsule/hub-server (raison : registry.js table event_design_refs + helpers, routes/events.js materializeEventDesign/provenance, routes/designs.js refreshPreviewEvents + GET /:id/usage, routes/sync.js exclusion bundle, tests designs/eventDesign)
- @kapsule/hub-web (raison : DesignEditor.jsx, DesignPreview.jsx, DesignsPage.jsx, client.js, app.css — pas de test unitaire mais build/lint pertinent)

Points d'attention pour les tests (findings du reviewer à confirmer par les tests) :
- Rafraîchissement borne d'essai : seuls les events `status === 'preview'` doivent être re-matérialisés ; un event `ready` ne doit JAMAIS bouger (couvert par eventDesign.test.js « éditer le design rafraîchit un événement preview mais PAS un événement ready »).
- `design_source_id` absent du bundle de pull (couvert par « design_source_id reste Hub-only »).
- Purge de `event_design_refs` par ON DELETE CASCADE à la suppression d'un événement (couvert).
- GET /api/designs/:id/usage : cas nominal + 404 + 403 (couvert par designs.test.js).
- Core : le test « chaque valeur d'enum a son preset » doit rester vert avec les 8 polices.

## Corrections demandées

Aucune correction requise.
