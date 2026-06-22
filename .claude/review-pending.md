---
status: tests-passed
base_commit: 1c5f4c3694b27cc486c53a636e07ef7724a65a79
workspaces: [@kapsule/core, @kapsule/hub-server, @kapsule/hub-web, @kapsule/borne-server, @kapsule/borne-web]
generated_at: 2026-06-22T00:00:00Z
tested_at: 2026-06-22T18:09:04Z
tested_commit: 1c5f4c3694b27cc486c53a636e07ef7724a65a79
commits_since_review: 0
verdict: COMMIT À CORRIGER
---

# Relais de review → tests

Workspaces à tester :
- @kapsule/core (raison : VIDEO_QUALITY/DEFAULT_VIDEO_QUALITY/AUDIO_BITRATE ajoutés à constants.js, table local_overrides ajoutée à eventDbSchema.js)
- @kapsule/hub-server (raison : validation video_quality dans PUT /:eventId, META_KEYS étendu, eventConfig.js)
- @kapsule/hub-web (raison : DesignTab d'EventDetailPage.jsx — select qualité + estimation Mo/min)
- @kapsule/borne-server (raison : GET /event résout video_quality, nouvelle route PUT /api/admin/video-quality)
- @kapsule/borne-web (raison : useMediaRecorder, RecordingScreen, StartScreen, DesignPanel, client.js, GuestPage)

Points d'attention pour les tests (findings du reviewer à confirmer par les tests) :
- Vérifier que PUT /api/event/video-quality refuse (400) une `quality` hors VIDEO_QUALITY et écrit bien local_overrides en preview SANS token.
- Vérifier que HORS preview la route exige tech_borne (403 sans token / avec admin_borne seul).
- Vérifier que GET /event résout l'ordre override local > event_meta > DEFAULT et n'expose aucune PII.
- Vérifier qu'un pull (DELETE+INSERT event_meta) ne touche PAS local_overrides (l'override de qualité survit au pull).
- Smoke borne : la borne preview reste Internet-facing — confirmer qu'aucune route admin réelle (settings, close) n'est devenue publique par effet de bord du nouveau handler partagé.

## Résultats des tests

### Tests unitaires

| Workspace | Tests | Statut |
|---|---|---|
| @kapsule/core | 18 | PASS |
| @kapsule/hub-server | 325 | PASS |
| @kapsule/hub-web | 19 | PASS |
| @kapsule/borne-server | 225 | PASS |
| @kapsule/borne-web | 17 | PASS |

### Smoke tests

Smoke lancés (docker-compose.yml modifié → infra touchée) : hub, borne, preview.

- smoke:hub : 27 ✓ 0 ✗ — PASS
- smoke:borne : 16 ✓ 0 ✗ — PASS
- smoke:preview : SKIP (images kapsule-borne-preview-backend/frontend absentes en local — test VPS uniquement)

## Note smoke preview

Le smoke preview nécessite les images Docker `kapsule-borne-preview-backend` et `kapsule-borne-preview-frontend` buildées sur le VPS. Il est ignoré en local. Le provisioner a été corrigé (volume nommé au lieu de bind mount — le bind mount échouait car hub_data est un volume Docker non accessible depuis l'hôte) : à vérifier sur le VPS.

## Corrections demandées

> Cette section est lue par l'agent principal pour implémenter les corrections.
> Chaque item est coché par l'agent principal une fois corrigé.

- [x] ⚠️ `apps/borne/server/src/routes/events.js:206` — la route publique d'écriture `PUT /api/admin/video-quality` (sans auth en preview) n'a aucun `express-rate-limit`, contrairement à toutes les autres routes publiques d'écriture de la borne (`/sessions` max 20, `/videos` max 50, `/preview/login`). La borne preview étant Internet-facing (PROJET §11.21, ARCHITECTURE §6 durcissement), ajouter un `rateLimit` (instancié par app, `skip` via `cfg.skipRateLimits` en test) sur cette route.
- [x] ⚠️ `apps/borne/server/src/routes/events.js:202` — le préfixe `/admin/` est trompeur pour une route publique sans auth en preview (ailleurs `admin` ⇒ `requireAdmin`/`requireTech`). Renommé `/event/video-quality` + commentaire explicatif ajouté.
- [x] ⚠️ `apps/hub/server/src/routes/events.js:117` — `video_quality` est validé deux fois (test inline 400 dans la route + skip silencieux dans `applyEventConfig` via `eventConfig.js:29`). Doublon documenté par un commentaire dans eventConfig.js.
