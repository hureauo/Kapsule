---
status: tests-failed
base_commit: fb208222ebbad785f9fa9d4102ef46e976200590
workspaces: [@kapsule/hub-server, @kapsule/hub-web, @kapsule/borne-server, @kapsule/borne-web]
generated_at: 2026-06-21T00:00:00Z
tested_at: 2026-06-21T18:36:19Z
tested_commit: fb208222ebbad785f9fa9d4102ef46e976200590
commits_since_review: 0
verdict: COMMIT OK
---

# Relais de review → tests

Workspaces à tester :
- @kapsule/hub-server (raison : nouveau router previewGallery.js + test, provisioner.js bind mount + dataDir, events.js transitions preview, questions.js triggerPreviewPull, index.js mount)
- @kapsule/hub-web (raison : PreviewGallery.jsx nouveau, client.js routes preview, EventDetailPage.jsx galerie conditionnelle)
- @kapsule/borne-server (raison : index.js expose storage dans /api/admin/health, videos.js exporte dirSize)
- @kapsule/borne-web (raison : GuestPage.jsx polling config en preview)

Infra touchée (Makefile : vps-restart/local-restart, montages bind preview) → lancer aussi les smoke tests (npm run smoke:hub).

Points d'attention pour les tests (findings du reviewer à confirmer par les tests) :
- previewGallery.test.js couvre 401/403/404/200/503 + Range 206 + JWT tech_borne : vérifier qu'il passe (cœur de la nouvelle surface authentifiée).
- Vérifier que le proxy /preview-videos/:videoId/file propage bien Range (206 + Content-Range) — invariant §11.3.
- Vérifier que DELETE /api/events/:id purge previews/<slug> (deprovision avec dataDir) AVANT rm events/<id> — RGPD.
- borne /api/admin/health : confirmer que storage.{used_bytes,quota_bytes} est renvoyé et que la route reste gardée par requireAdmin.

## Résultats des tests

| Workspace | Tests | Pass | Fail |
|---|---|---|---|
| @kapsule/hub-server | 326 | 322 | 4 |
| @kapsule/hub-web | 19 | 19 | 0 |
| @kapsule/borne-server | 225 | 225 | 0 |
| @kapsule/borne-web | 17 | 17 | 0 |

Smoke : `smoke:hub` lancé (infra preview touchée) → 27 ✓ 0 ✗ — PASS.

## Échecs

- **@kapsule/hub-server** › `POST /api/events` › `retourne preview_url dans la réponse (null si docker absent en test)` (`events.test.js:74`) :
  `AssertionError [ERR_ASSERTION]: preview_url doit être présent dans la réponse` — expected: `true`, actual: `false`, operator: `==`

- **@kapsule/hub-server** › `GET /api/events/:eventId/preview-videos/:videoId/file — proxy flux` › `proxifie le flux vidéo (200)` (`previewGallery.test.js:205`) :
  `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: 400 !== 200` — expected: `200`, actual: `400`, operator: `strictEqual`

- **@kapsule/hub-server** › `GET /api/events/:eventId/preview-videos/:videoId/file — proxy flux` › `proxifie le Range entrant et renvoie 206` (`previewGallery.test.js:214`) :
  `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: 400 !== 206` — expected: `206`, actual: `400`, operator: `strictEqual`

- **@kapsule/hub-server** › `GET /api/events/:eventId/preview-videos/:videoId/file — proxy flux` › `renvoie 503 si la borne est hors ligne` (`previewGallery.test.js:223`) :
  `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: 400 !== 503` — expected: `503`, actual: `400`, operator: `strictEqual`

## Corrections demandées

> Cette section est lue par l'agent principal pour implémenter les corrections.
> Chaque item est coché par l'agent principal une fois corrigé.

- [ ] ⚠️ `apps/hub/server/src/routes/previewGallery.js:144` — `:videoId` interpolé tel quel dans l'URL upstream sans validation UUID ; ajouter `validateUuidParams('videoId')` (ou équivalent) en amont du proxy /file pour éviter une injection de path vers le backend borne.
- [ ] ⚠️ `apps/hub/server/src/routes/previewGallery.js:75` — `httpRequest` ne pose aucun timeout : une borne qui accepte la connexion mais ne répond jamais fait pendre la requête Hub (et le navigateur admin). Ajouter `req.setTimeout(...)` + rejet propre → 503/504.
- [ ] ⚠️ `PROJET.md §4 / §11` — la spec indique « tout vit dans events/<id>/ » ; les données invité preview vivent désormais dans `previews/<slug>/` (bind mount Hub). Documenter ce chemin et sa purge dans PROJET.md (§4 arborescence + §11 RGPD) pour rester contractuel (ARCHITECTURE.md déjà mis à jour par le reviewer).
