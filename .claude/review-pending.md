---
status: tests-pending
base_commit: 5e7fe15f5438367facb726432c5fe3d519347f48
workspaces: []
generated_at: 2026-06-21T12:00:00Z
verdict: COMMIT OK
---

# Relais de review → tests

Workspaces à tester :
- aucun — le diff ne touche que de l'infra/outillage dev (Makefile, docker-compose.hub.dev.yml, docker/edge-entrypoint.sh, docker/setup-dev-certs.sh, .gitignore). Aucun code applicatif testable par `node:test`.

Points d'attention pour les tests (findings du reviewer à confirmer par les tests) :
- Smoke : la branche `DEV_CERT_DIR` de `edge-entrypoint.sh` réécrit bien les deux blocs `server` (HSTS/redirection HTTP→HTTPS toujours présents) — vérifiable à l'œil via `make local-up` puis `curl -k https://kapsule.localhost`. Non couvert par `npm test`.

## Corrections demandées

Aucune correction requise.
