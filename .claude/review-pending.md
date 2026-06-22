---
status: tests-failed
base_commit: 7447f21768e715b8fb91c2c88101712e89fd0d57
workspaces: [@kapsule/hub-server, @kapsule/borne-web]
generated_at: 2026-06-22T18:30:00Z
verdict: COMMIT OK
tested_at: 2026-06-22T20:33:32Z
tested_commit: 7447f21768e715b8fb91c2c88101712e89fd0d57
commits_since_review: 0
smoke: non requis (pas de changement infra docker/compose/entrypoint)
---

# Relais de review → tests

Workspaces à tester :
- @kapsule/hub-server (raison : routes/previewGallery.js — regex de validation videoId modifiée)
- @kapsule/borne-web (raison : useMediaRecorder.js, RecordingScreen.jsx, StartScreen.jsx, GuestPage.jsx modifiés ; suite roles.test.js présente)

Points d'attention pour les tests (findings du reviewer à confirmer par les tests) :
- previewGallery : confirmer que `GET /preview-videos/:videoId/file` accepte désormais un videoId UUID (ex. `3f8a1c2e-...`) et renvoie 400 sur un id non-hex ou contenant `/`, `.`, `%` (anti-traversal avant interpolation dans l'URL upstream). L'ancienne regex `^\d+$` rejetait tous les UUID réels (videos.id = uuidv4, TEXT PK) → la route preview/file était cassée pour 100 % des vidéos.
- borne-web : vérifier que `useMediaRecorder` ré-initialise `accumulatedBytes`/`streamSettings` à chaque reset/discard/start, et que le cycle start(0)+requestData() produit toujours un blob non vide sur onstop (jsdom/mock MediaRecorder).

## Corrections demandées

Aucune correction requise.

## Échecs

### @kapsule/hub-server — previewGallery.test.js

Suite : `GET /api/events/:eventId/preview-videos/:videoId/file — proxy flux`
Fichier : `/app/apps/hub/server/test/previewGallery.test.js`

- sous-test 2 — `proxifie le flux vidéo (200)` (ligne 205) :
  `Expected values to be strictly equal: 400 !== 200`
  `AssertionError [ERR_ASSERTION]: operator: strictEqual, expected: 200, actual: 400`

- sous-test 3 — `proxifie le Range entrant et renvoie 206` (ligne 214) :
  `Expected values to be strictly equal: 400 !== 206`
  `AssertionError [ERR_ASSERTION]: operator: strictEqual, expected: 206, actual: 400`

- sous-test 4 — `renvoie 503 si la borne est hors ligne` (ligne 223) :
  `Expected values to be strictly equal: 400 !== 503`
  `AssertionError [ERR_ASSERTION]: operator: strictEqual, expected: 503, actual: 400`

La route renvoie systématiquement 400, quel que soit le cas de test — le videoId UUID passé dans les tests est rejeté par la validation dans `previewGallery.js`.

### @kapsule/hub-server — provisioner.test.js

Suite : `deprovisionPreview`
Fichier : `/app/apps/hub/server/test/provisioner.test.js`

- sous-test 1 — `supprime le frontend et le backend` (ligne 128) :
  `TypeError: docker.volumeRm is not a function`
  `stack: deprovisionPreview (provisioner.js:235:16)`

- sous-test 2 — `supprime le réseau isolé` (ligne 137) :
  `TypeError: docker.volumeRm is not a function`
  `stack: deprovisionPreview (provisioner.js:235:16)`

- sous-test 3 — `ne plante pas si containers et réseau absents` (ligne 145) :
  `AssertionError: Got unwanted rejection. Actual message: "docker.volumeRm is not a function"`
  `stack: deprovisionPreview (provisioner.js:235:16)`

- sous-test 4 — `révoque le token preview en base` (ligne 150) :
  `TypeError: docker.volumeRm is not a function`
  `stack: deprovisionPreview (provisioner.js:235:16)`

`deprovisionPreview` appelle `docker.volumeRm` (ligne 235 de `provisioner.js`) qui n'existe pas dans le mock/stub `dockerCli` utilisé par les tests.
