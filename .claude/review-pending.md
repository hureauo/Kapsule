---
status: tests-pending
commit: c29abf56d01f8762b003d2ebc313fe058b43fee3
workspaces: [@kapsule/hub-server, @kapsule/hub-web]
generated_at: 2026-06-20T00:00:00Z
verdict: COMMIT À CORRIGER
---

# Relais de review → tests

Workspaces à tester :
- @kapsule/hub-server (raison : routes preview/start, preview/stop, preview/status + migration registry event_versions.author)
- @kapsule/hub-web (raison : AdminPage.jsx toggle preview + api/client.js previewStart/previewStop)

Points d'attention pour les tests (findings du reviewer à confirmer par les tests) :
- BLOQUANT — Le `dockerCli` réel (apps/hub/server/src/preview/provisioner.js) n'expose PAS les méthodes `running`, `start`, `stop` appelées par les routes preview/status, preview/start, preview/stop de events.js. Les tests existants passent car ils injectent un `mockDocker` avec ces méthodes ; en production `createApp` utilise le `dockerCli` réel → TypeError 500 sur chaque appel. Un test devrait instancier l'app SANS injecter de docker (défaut dockerCli) et vérifier que preview/status ne renvoie pas 500 — ce test échouera tant que dockerCli n'a pas running/start/stop.
- Migration registry event_versions.author : si un author non résoluble (id sans user correspondant) est rencontré, l'UPDATE pose author = NULL. Vérifier qu'aucune régression sur les versions existantes (un test idempotence migration serait utile).
