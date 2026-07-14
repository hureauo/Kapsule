---
status: tests-pending
base_commit: 21ec73e0994a38500005f92fa87fd73a8d0e65d0
workspaces: [@kapsule/core, @kapsule/hub-server]
generated_at: 2026-07-14T20:15:00Z
verdict: COMMIT OK
---

# Relais de review → tests

Workspaces à tester :
- @kapsule/core (raison : `packages/core/src/design.js` — `validateDesign` + whitelist racine `DESIGN_KEYS`, barrière anti-injection CSS §11.28 ; barrel `index.js` modifié)
- @kapsule/hub-server (raison : `routes/designs.js` monté dans `index.js`, tables `designs`/`design_versions` + seed dans `registry.js`)

Points d'attention pour les tests (findings du reviewer à confirmer par les tests) :
- Re-review du sous-lot design.B : les 5 findings de la review précédente (1 ❌ + 4 ⚠️) sont vérifiés corrigés dans le code réel. Aucun nouveau ❌ ni ⚠️.
- Confirmer que le cas « JSON > 16 Ko » (`packages/core/test/design.test.js:141`) passe bien sur le message `/octets/` (clé légitime `assets.logo` gonflée) et non sur « clé racine inconnue » — c'était la « bonne raison » demandée.
- Confirmer que le test de path traversal (`apps/hub/server/test/designs.test.js:282`) laisse le canari `events/canary.txt` intact (`designDir()` jette avant `join()`) et rend bien 404 sur les 4 formes.
- Non couvert par les tests (💡, non bloquant) : l'idempotence du seed sur un **second** `openRegistry` du même `DATA_DIR` (le garde-fou `COUNT(*) > 0` est correct par construction, mais aucun test ne rouvre un registre existant).
- Pas de smoke test requis : aucun changement Docker/nginx/env/package.json dans ce sous-lot.

## Corrections demandées

Aucune correction requise.
