---
status: tests-pending
base_commit: a21b603cae44a6b3eff68590556117d891979e0f
workspaces: [@kapsule/hub-web, @kapsule/hub-server]
generated_at: 2026-07-15T00:00:00Z
verdict: COMMIT OK
---

# Relais de review → tests

Workspaces à tester :
- @kapsule/hub-web (raison : `roles.js` + `roles.test.js` — nouvelle fonction `getUserId`)
- @kapsule/hub-server (raison : `provisioner.js` nouvelle branche `networksOk`/reprovision + refactor route `preview/start` dans `events.js`, couverts par `provisioner.test.js`)

Points d'attention pour les tests (findings du reviewer à confirmer par les tests) :
- `getUserId` doit renvoyer un `number` (sub JWT) qui matche `owner_id` (number better-sqlite3) — vérifier que les 3 nouveaux tests couvrent bien l'extraction de `sub` numérique (déjà le cas : `sub: 42`).
- `startPreview` : les 2 nouveaux tests couvrent le cas réseaux sains (pas de reprovision) et le cas réseau disparu (reprovision + rm + networkRm). Vérifier qu'ils passent et que le mock `networksOk` reflète bien la sémantique optionnelle.
- Le refactor de `POST /preview/start` (idempotence via `startPreview`) ne doit pas casser les tests d'intégration existants de la route (champ `provisioned` désormais dérivé de `wasRunning`).

## Corrections demandées

Aucune correction requise.
