---
status: tests-pending
base_commit: d2259144d3ecece6e6d2a091df970c44772280bf
workspaces: [@kapsule/hub-web, @kapsule/borne-web]
generated_at: 2026-07-21T00:00:00Z
verdict: COMMIT À CORRIGER
---

# Relais de review → tests

Workspaces à tester :
- @kapsule/hub-web (raison : apps/hub/web/package.json — ajout dependency @kapsule/guest-ui)
- @kapsule/borne-web (raison : apps/borne/web/package.json — ajout dependency @kapsule/guest-ui)

Note : ce sous-lot (designUI.A) n'ajoute aucun code testable (guest-ui = squelette `export {}`).
`npm test` sur les deux web ne fait que confirmer la non-régression. Le vrai point de
vérification est le **build Docker** des images web (multi-stage vite), non couvert par `npm test` —
voir points d'attention. Lancer `npm run smoke:hub` / `npm run smoke:borne` si possible pour
exercer le build Docker réel.

Points d'attention pour les tests (findings du reviewer à confirmer par les tests) :
- Le build **Docker** des images web (apps/borne/web/Dockerfile, apps/borne/web/Dockerfile.preview,
  apps/hub/web/Dockerfile) ne copie PAS packages/guest-ui avant `npm ci`/`npm run build`. À ce lot,
  aucun import réel de guest-ui n'existe → le build passe probablement encore. Mais la correction du
  COPY doit être vérifiée AVANT que les lots C/D/E introduisent un vrai import (sinon build cassé).
  Un `npm run smoke:*` (qui reconstruit l'image) est le seul test qui exerce ce chemin.
- Le build vite LOCAL a déjà été validé (hash bundle borne identique = pas de code mort). Les tests
  n'ont pas à re-vérifier l'absence de la sonde temporaire : git diff sur main.jsx est déjà vide.

## Corrections demandées

> Cette section est lue par l'agent principal pour implémenter les corrections.
> Chaque item est coché par l'agent principal une fois corrigé.

- [ ] ⚠️ `apps/hub/web/Dockerfile:7,12` — ajouter `COPY packages/guest-ui/package.json ./packages/guest-ui/` avant `npm ci` et `COPY packages/guest-ui/src ./packages/guest-ui/src` avant `npm run build` (calquer sur les lignes `packages/core`). Sinon le build vite Docker ne résoudra pas `@kapsule/guest-ui` dès le premier import réel (lots C/D/E).
- [ ] ⚠️ `apps/borne/web/Dockerfile:7,12` — même correction : copier `packages/guest-ui/package.json` puis `packages/guest-ui/src` avant, respectivement, `npm ci` et `npm run build`.
- [ ] ⚠️ `apps/borne/web/Dockerfile.preview:9,14` — même correction (image borne preview, exposée publiquement).
- [ ] ⚠️ `PROJET.md:95` — la §4 arborescence (contractuelle) ne liste que `packages/core/` ; ajouter `packages/guest-ui/` (@kapsule/guest-ui — écrans invité React partagés) pour lever l'écart doc introduit par ce lot.
