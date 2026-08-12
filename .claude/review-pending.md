---
status: tests-passed
base_commit: a84ec2be2bcc1e10a089c5d07c2d79b4bd2511de
workspaces: [@kapsule/hub-server, @kapsule/hub-web, @kapsule/borne-server, @kapsule/borne-web]
generated_at: 2026-08-11T00:00:00Z
verdict: COMMIT À CORRIGER
tested_at: 2026-08-12T08:18:13Z
tested_commit: a84ec2be2bcc1e10a089c5d07c2d79b4bd2511de
commits_since_review: 0
---

# Relais de review → tests

Workspaces à tester :
- @kapsule/hub-server (raison : registry.js migration 10 + helpers bornes, routes/admin.js CRUD bornes, routes/sync.js `boxHasEventAccess` + 3 routes borne, middleware/boxAuth.js, routes/events.js `GET /:eventId/sync`)
- @kapsule/hub-web (raison : AdminPage.jsx onglet Bornes, SyncStatus.jsx section Bornes physiques, api/client.js)
- @kapsule/borne-server (raison : borneIdentity.js, sync/heartbeat.js, sync/commandExecutor.js, sync/pull.js `pullMyEvents`, registry.js `borne_settings`, routes/sync.js, index.js)
- @kapsule/borne-web (raison : BornePage.jsx, IdentityPanel.jsx, EventPanel/PreflightPanel/SyncPanel/DesignPanel déplacés, api/client.js)

Points d'attention pour les tests (findings du reviewer à confirmer par les tests) :
- Non-régression preview : les 8 anciens `req.params.id !== req.box.event_id` remplacés par `boxHasEventAccess` — vérifier qu'un token preview reste 403 hors de son événement sur bundle, design/:filename, status, manifest, files, db, finalize, config.
- `GET /api/sync/event` et `POST /api/sync/event/login` doivent renvoyer 400 pour un token borne ; `GET /api/sync/borne/events`, `/borne/heartbeat`, `/borne/commands/:id/result` doivent renvoyer 400 pour un token preview.
- `clock_skew_ms` : vérifier qu'un `clock_skew_ms` envoyé par la borne dans le body est ignoré (seul `Date.now() - borne_time_ms` est stocké).
- `purge_event` (commandExecutor) : confirmer 'failed' si `confirm` absent, vide, ou ≠ `event.name`, et si `status !== 'pushed'`.
- `pullMyEvents` : un événement local `live`/`closed` doit être *skip* (jamais écrasé) ; activation bootstrap uniquement si aucun actif ET un seul pull réussi.
- `POST /api/sync/token` sur une borne SANS `BORNE_TOKEN` initial (cf. correction ⚠️ ci-dessous) — pas de test aujourd'hui, à ajouter avec le correctif.
- Suite complète `@kapsule/hub-server` : hang connu et pré-existant sur `eventDesign.test.js` (`triggerPreviewPull` sans timeout). Lancer fichier par fichier si le workspace bloque, et le signaler dans le verdict plutôt que de conclure « tests-failed » sur ce seul motif.
- Smoke tests recommandés (infra touchée : docker-compose.borne.yml) : `npm run smoke:borne`.

## Corrections demandées

> Cette section est lue par l'agent principal pour implémenter les corrections.
> Chaque item est coché par l'agent principal une fois corrigé.

- [x] ❌ `PROJET.md:83` (§4 arborescence) — les 5 fichiers ajoutés (`borneIdentity.js`, `sync/commandExecutor.js`, `sync/heartbeat.js`, `BornePage.jsx`, `IdentityPanel.jsx`), `registry.js`/`App.jsx` corrigés.
- [x] ❌ `README.md`/`PROJET.md` §10 (purge RGPD) — **résolu autrement que suggéré** : plutôt qu'une procédure de migration, le split de volumes `borne_data`/`borne_events` a été **abandonné** (`docker-compose.borne.yml` revert à un seul volume). Il masquait silencieusement les données existantes sur une borne déjà déployée, et même sur un déploiement neuf ne garantissait pas une purge cohérente du registre (`local_events`/`push_state` seraient restés orphelins) — ce n'était donc jamais un vrai raccourci de purge. La purge reste exclusivement `POST /api/sync/purge/:eventId`. Doc mise à jour (README, PROJET.md §10, ARCHITECTURE.md, ROADMAP.md B.7).
- [x] ⚠️ `apps/hub/server/src/routes/admin.js:302,313` (`token_clear`) — tranché : gardé (aligné sur le précédent `box_tokens`, §11.13 — consultable à tout moment par un superuser). `PROJET.md` §7 et §11.13 corrigés pour ne plus annoncer « une seule fois ».
- [x] ⚠️ `apps/borne/server/src/routes/sync.js:112` (appairage initial) — corrigé : la route détecte maintenant le TYPE du token (`GET /api/sync/borne/events` en sonde — 400 = token preview, sinon = token borne) avant de choisir la branche `borneToken`/`boxToken`, plutôt que de se fier à `config.borneToken` déjà renseigné.
- [x] ⚠️ `apps/hub/web/src/components/SyncStatus.jsx:55` (`BorneAssignment`) — conditionné au rôle superuser (`getRole() === 'superuser'`) : liste en lecture seule pour un client, formulaire d'assignation et bouton Retirer masqués, `api.listBornes()` non appelé.
- [x] ⚠️ `ROADMAP.md:481` (lien mort) — le plan copié dans `.claude/plans/enumerated-napping-sifakis.md` (dépôt).

**Bonus (trouvé hors rapport, corrigé)** : `apps/borne/server/src/sync/hubClient.js` et `sync/push.js` envoyaient toujours `config.boxToken` en `X-Box-Token`, jamais `config.borneToken` — une borne physique aurait envoyé un token vide à chaque appel Hub (pull, heartbeat, push vidéo). Masqué par des fixtures de test qui réglaient le mauvais champ (corrigées). Test de non-régression ajouté (`hubClient — hubFetch / hubFetchJson`).

**💡 Suggestions appliquées** : normalisation `active` en 0/1 (`updateBorne`), validation immédiate `payload.event_id`/`confirm` à la création d'une commande (400 au lieu d'un `failed` différé), typage/troncature `agent_version` + confrontation `active_event_id` aux événements assignés (heartbeat), redirection explicite `/admin/tech` → `/borne`. Écartée : `validateUuidParams('id')` sur `/bornes/:id` (routes sans accès disque, la protection ne s'applique pas, aurait cassé des tests pour un bénéfice nul).

**Tests** : 249/249 (`@kapsule/hub-server`, 4 fichiers ciblés) + 285/285 (`@kapsule/borne-server`, suite complète) verts après corrections. Builds Vite Hub + Borne OK.

## Verdict kapsule-tester (2026-08-12T08:18:13Z)

Tout est en modifications locales non commitées (`commits_since_review: 0`, `base_commit` = HEAD). Reconstitution du sous-lot via `git diff a84ec2be2bcc1e10a089c5d07c2d79b4bd2511de --stat` : 39 fichiers modifiés/ajoutés, cohérent avec les 4 workspaces annoncés dans le relais.

**Tests unitaires — tous verts :**
- `@kapsule/hub-server` : suite complète NON lancée (hang connu et documenté sur `eventDesign.test.js` / `triggerPreviewPull` sans timeout réseau — pré-existant, sans rapport avec ce sous-lot). Lancé fichier par fichier à la place : `registry.test.js` + `admin.test.js` + `sync.test.js` + `events.test.js` → **249/249 pass**, 0 fail, 0 skip.
- `@kapsule/hub-web` : **29/29 pass**.
- `@kapsule/borne-server` : suite complète (`npm test -w @kapsule/borne-server`) → **285/285 pass**, 0 fail, 0 skip.
- `@kapsule/borne-web` : **28/28 pass**.

**Smoke test — bloqué par l'environnement local (pas par le code) :**
`docker-compose.borne.yml` étant touché par le diff, `npm run smoke:borne` a été lancé. Échec au démarrage du stack, AVANT tout test applicatif :
```
Error response from daemon: failed to set up container networking: driver failed programming external connectivity on endpoint smoke-borne-frontend-1 (...): Bind for 0.0.0.0:80 failed: port is already allocated
```
Cause : les ports 80/443 de la machine sont déjà occupés par une autre pile Kapsule tournant en continu sur cette machine (`kapsule-edge-1`, `kapsule-worker-1`, `hub-frontend`, `hub-backend` — `docker ps` : up 18h). Ce conflit est **indépendant du diff testé** (le diff ne touche ni les ports ni les bindings — vérifié via `git diff … -- docker-compose.borne.yml`, seuls `BORNE_TOKEN` et le volume unique `borne_data` changent). `smoke:hub` et `smoke:preview` n'ont pas été tentés (probablement bloqués par le même conflit de port). Je n'ai pas arrêté la pile `kapsule-edge-1` en cours (semble être un déploiement actif, décision hors de mon périmètre).

Ceci correspond au rappel « config locale à revérifier » en mémoire (rebasculement du dev en local, infra pas encore revérifiée) : **à traiter avant de pouvoir conclure sur les smoke tests** — soit libérer les ports 80/443, soit les rebinder ailleurs pour les runs smoke, soit confirmer que `kapsule-edge-1` peut être arrêté pendant les tests locaux.

**Verdict global : `tests-failed`** — uniquement à cause du smoke non exécutable (conflit de port infra), PAS d'une régression de code : les 4 workspaces unitaires sont 100 % verts. Ce `tests-failed` ne doit pas déclencher de correction de code ; il faut résoudre le conflit d'environnement puis relancer `/run-tests` pour valider le smoke.

## Suivi — smoke:borne débloqué (2026-08-12)

Ports de `docker-compose.borne.yml` (service `frontend`) rendus paramétrables : `${BORNE_HTTP_PORT:-80}:80` / `${BORNE_HTTPS_PORT:-443}:443` (défaut inchangé pour un vrai déploiement). `docker/smoke-borne.sh` utilise désormais des ports non-standards par défaut (`18080`/`18443`, surchargeables via `SMOKE_BORNE_HTTP_PORT`/`SMOKE_BORNE_HTTPS_PORT`) pour ne plus jamais entrer en conflit avec un déploiement réel sur la même machine.

Relancé : `bash docker/smoke-borne.sh` → **16 ✓ / 0 ✗** (SPA, santé, auth autonome, gardes de rôle, parcours invité jusqu'à la création de session). Aucune interférence avec la pile `kapsule-edge-1`/`hub-*` en cours.

**Statut final : `tests-passed`** — 591/591 tests unitaires + smoke borne verts.
