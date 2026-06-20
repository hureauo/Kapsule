---
status: tests-failed
base_commit: 5e7fe15f5438367facb726432c5fe3d519347f48
workspaces: []
generated_at: 2026-06-21T12:00:00Z
verdict: COMMIT OK
tested_at: 2026-06-20T23:18:13Z
tested_commit: 00dbbbd71663affc21aba7a3035167c6413195c2
commits_since_review: 1
smoke_lancés: "smoke:hub"
---

# Relais de review → tests

Workspaces à tester :
- aucun — le diff ne touche que de l'infra/outillage dev (Makefile, docker-compose.hub.dev.yml, docker/edge-entrypoint.sh, docker/setup-dev-certs.sh, .gitignore). Aucun code applicatif testable par `node:test`.

Points d'attention pour les tests (findings du reviewer à confirmer par les tests) :
- Smoke : la branche `DEV_CERT_DIR` de `edge-entrypoint.sh` réécrit bien les deux blocs `server` (HSTS/redirection HTTP→HTTPS toujours présents) — vérifiable à l'œil via `make local-up` puis `curl -k https://kapsule.localhost`. Non couvert par `npm test`.

## Corrections demandées

Aucune correction requise.

## Échecs

- smoke hub › création question après passage en `ready` (`docker/smoke-hub.sh`, section `[Questions]`) :
  `✗ création question KO : {"error":"Édition impossible : événement en statut ready"}`

  Cause : le smoke passe l'event en `ready` (draft→preview→ready) avant de tenter de créer une question. Le commentaire du smoke supposait que `ready` reste éditable (« ready est éditable, seul live+ gèle »), mais le backend refuse l'édition dans cet état. Il y a une incohérence entre le commentaire du smoke et la logique du backend. Deux correctifs possibles : (a) remettre l'event en `preview` avant de créer la question, ou (b) créer la question AVANT de passer en `ready`, ou (c) adapter le backend si `ready` doit effectivement rester éditable selon la spec (PROJET.md §à vérifier).
