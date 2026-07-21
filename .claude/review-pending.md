---
status: tests-pending
base_commit: 8d1391f293cf068fd30abaff26499c3db0a08202
workspaces: [@kapsule/borne-web, @kapsule/guest-ui]
generated_at: 2026-07-21T06:20:00Z
verdict: COMMIT À CORRIGER
---

# Relais de review → tests

Chantier designUI lots B+C+D+E (non commités, tout dans le même working tree).
Extraction du parcours invité vers `@kapsule/guest-ui` (écrans + hook + CSS + design.js),
consommé par la borne réelle (`apps/borne/web`). Aucun fichier Hub touché (lot F à venir).

Workspaces à tester :
- @kapsule/guest-ui (raison : nouveau package — screens/*.jsx, useMediaRecorder.js, design.js, guest.css, test/design.test.js)
- @kapsule/borne-web (raison : GuestPage.jsx importe le barrel guest-ui ; utils/design.js délègue à @kapsule/guest-ui/design ; App.jsx wrapper .kapsule-guest ; app.css restauré ; suppression de components/guest/ + hooks/)

Points d'attention pour les tests (findings du reviewer à confirmer par les tests) :
- Le build Vite borne-web doit passer (résolution du barrel `@kapsule/guest-ui` + du sous-export `/design` + de l'import CSS `@kapsule/guest-ui/guest.css`).
- `node --test` sur borne-web ne doit PAS traverser le barrel JSX : `apps/borne/web/test/design.test.js` importe `utils/design.js` → `@kapsule/guest-ui/design` (sans JSX). Un test qui importerait le barrel racine planterait « Unknown file extension .jsx ».
- Non-régression du parcours invité borne : `RecordingScreen` monté sans `showcase` (défaut false) — gardes `if(showcase) return` inertes, aucun changement de comportement caméra/upload attendu.
- Injection `createSession`/`onFinishSession`/`uploadVideo`/`guestVideoUrl` : le runtime borne doit rester identique (indirection pure, `resolveAssetUrl` par défaut = identité).
- Pas de smoke-test requis : aucun fichier infra/docker/nginx touché.

## Corrections demandées

> Cette section est lue par l'agent principal pour implémenter les corrections.
> Chaque item est coché par l'agent principal une fois corrigé.

- [ ] ⚠️ `PROJET.md:148` — l'arborescence §4 (contractuelle) liste toujours `apps/borne/web/src/hooks/useMediaRecorder.js`, supprimé par ce diff. Le retirer et mentionner que le hook vit désormais dans `packages/guest-ui/src/useMediaRecorder.js`.
- [ ] ⚠️ `PROJET.md:153-159` — l'arborescence §4 (contractuelle) liste toujours le dossier `apps/borne/web/src/components/guest/` et ses 6 écrans (`StartScreen`, `NameInput`, `QuestionNav`, `RecordingScreen`, `RecapScreen`, `ThankYouScreen`), supprimés par ce diff. Retirer ce bloc et renvoyer vers `packages/guest-ui/src/screens/` (déjà décrit au §4 guest-ui). Noter que `QuestionSheet` n'était de toute façon pas listé dans l'ancien bloc.
