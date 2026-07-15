---
status: tests-pending
base_commit: 4d697da80ef0b33692e1b3a3a234d302b7bf6bea
workspaces: [@kapsule/hub-web]
generated_at: 2026-07-15T00:00:00Z
verdict: COMMIT OK
---

# Relais de review → tests

Retouches UI post-test de la page Designs (candidat `phase design: retouches UI post-test`).
Diff 100% front Hub (`apps/hub/web/`) — aucun fichier serveur, core ni infra. Seule écriture
hors code : deux notes ARCHITECTURE.md rafraîchies par le reviewer (entrées de navigation vers
`/designs`, mécanisme d'échelle mesuré du DesignPreview, `hub-main--wide` + media query desktop).

Workspaces à tester :
- @kapsule/hub-web (raison : DesignPreview.jsx, VersionHistory.jsx, DesignsPage.jsx, AdminPage.jsx, EventDetailPage.jsx et app.css modifiés)

Note : pas d'infra de test front dans ce projet (CLAUDE.md). Aucun fichier serveur/core touché →
ni supertest ni smoke à déclencher. La validation réelle de ces retouches est visuelle (navigateur
desktop / iPad Safari), donc humaine — cf. points ci-dessous.

Points d'attention pour les tests (à confirmer par un humain, non automatisable ici) :
- Aperçu épinglé (`position: sticky`, `@media (min-width: 1100px)`) : vérifier sur desktop réel qu'il reste fixe pendant le défilement des réglages. Chaîne d'ancêtres vérifiée statiquement OK — les seuls `overflow:hidden` (`.designs-preview__viewport`, `.design-preview`) sont des DESCENDANTS du sticky, sans effet sur lui.
- Rafraîchissement de l'historique (`VersionHistory` dépend désormais de l'objet `design`, pas de `design.id`) : après « Enregistrer », la nouvelle version doit apparaître sans clignotement. Pas de boucle : le `load()` local de VersionHistory ne modifie pas le state `designs` de la page. Double-fetch ponctuel après un restore jugé acceptable à cette échelle.
- Facteur d'échelle mesuré (`ResizeObserver` + `useLayoutEffect`) : sur iPad Safari, vérifier que l'aperçu se réduit correctement et sans vide sous le cadre aux 3 largeurs (360/820/1280).

## Corrections demandées

Aucune correction requise.
