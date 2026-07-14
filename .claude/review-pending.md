---
status: tests-pending
base_commit: d885b9d9cb1bb29f1d43740b54488e4bc3a69629
workspaces: [@kapsule/core, @kapsule/hub-server, @kapsule/hub-web]
generated_at: 2026-07-14T22:30:00Z
verdict: COMMIT OK
---

# Relais de review → tests

Workspaces à tester :
- @kapsule/core (raison : `packages/core/src/design.js` — ajout de `RADIUS_PRESETS`/`FONT_PRESETS`, réexportés par le barrel ; `test/design.test.js` étendu)
- @kapsule/hub-server (raison : `registry.js#listDesigns` scindé en deux requêtes — la jointure `owner_email` n'existe plus que dans la branche superuser ; `routes/designs.js` — `canSeeAuthor`/`stripAuthor`, 409 seed sur `DELETE`, 409 no-op sur `promote`/`demote` ; `test/designs.test.js` étendu)
- @kapsule/hub-web (raison : `utils/format.js` — nouveau `formatSqlDate` ; `test/format.test.js` étendu de 3 cas)

Pas de smoke test requis : aucun changement Docker / nginx / .env / package.json / scripts. Aucune dépendance ajoutée (stack figée respectée) ; un seul stylesheet par app (`app.css` du Hub étendu en fin de fichier).

Points d'attention pour les tests (findings du reviewer à confirmer par les tests) :
- Re-review de design.C : les 4 findings (2 ❌ + 2 ⚠️) sont vérifiés corrigés **dans le code réel**, sans voie de contournement. `getDesign` est un `SELECT * FROM designs` nu (aucune jointure `users`) → `GET /api/designs/:id` sur un template promu ne peut pas fuiter d'email ; la table `designs` ne porte pas d'email, seulement `owner_id` (UUID).
- design.D : aucune valeur CSS libre n'atteint le DOM. `cssVarsFor()` itère sur `DESIGN_COLOR_KEYS` (jamais sur les clés reçues) et n'écrit que des **custom properties** (`--*`) ; aucun `url()` dans le CSS `dp-`/`design-preview` (donc pas de vecteur d'exfiltration par `var()` interpolée dans une `url()`), aucun `dangerouslySetInnerHTML`. Le seul `style={}` sur une propriété CSS **standard** (`DesignsPage.jsx:282`, `background`) est alimenté par la config **persistée**, donc déjà validée par `validateDesign` côté backend.
- Vérifier que les 3 nouveaux tests de `format.test.js` passent quelle que soit la TZ du conteneur de test (ils comparent deux formatages entre eux plutôt qu'à une chaîne littérale — a priori robustes, mais c'est le point le plus fragile du lot).
- `POST /api/designs/:id/restore` réapplique `version.snapshot` **sans repasser par `validateDesign`** (dette de design.B, non bloquante : tout snapshot a été validé à l'insertion). À garder en tête si les règles de validation se durcissent.

## Corrections demandées

Aucune correction requise.
