---
status: tests-pending
base_commit: 32556707ec7fab6ce2f173bb183e513000f3c75e
workspaces: [@kapsule/core, @kapsule/hub-server, @kapsule/hub-web, @kapsule/borne-web]
generated_at: 2026-07-16T00:00:00Z
verdict: COMMIT OK
---

# Relais de review → tests

Workspaces à tester :
- @kapsule/core (raison : `packages/core/src/design.js` — `DESIGN_SCREENS`, `validateColorsObject`, `screenOverrides`, `resolveScreenColors`)
- @kapsule/hub-server (raison : tests de non-régression `designs.test.js` / `eventDesign.test.js` sur la revalidation et le snapshot de `screenOverrides`)
- @kapsule/hub-web (raison : `DesignEditor.jsx` / `DesignPreview.jsx` modifiés — pas de suite de tests React côté hub-web, mais suite existante à faire tourner)
- @kapsule/borne-web (raison : `applyDesign(design, screen)` et tests `test/design.test.js`)

Note : borne-server n'est pas touché fonctionnellement mais partage `validateDesign` de core (revalidation `resolveDesign`) — le lancer si l'infra core est considérée touchée.

Points d'attention pour les tests (findings du reviewer à confirmer par les tests) :
- Rétrocompatibilité : un design sans `screenOverrides` doit rendre exactement comme avant (couvert par les tests core + borne-web, à confirmer verts).
- Barrière anti-injection : `resolveScreenColors` avec une clé hostile en config directe ne doit jamais la propager (test core dédié présent).
- `GuestPage.jsx` n'a AUCUN test automatisé (pas de suite de composants React borne-web) : le retrait de `applyDesign` dans `loadEvent` au profit du `useEffect([screen, event])` reste à valider par un humain sur la borne réelle (design3.F, case 🧑). Non bloquant côté tests.

## Corrections demandées

Aucune correction requise.
