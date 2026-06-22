# Kapsule — carte du code

> **Ce fichier décrit le code *tel qu'il est*, pas l'intention.**
> L'intention vit dans [PROJET.md](PROJET.md) (la spec, source de vérité métier).
> Ici : où vit chaque responsabilité, qui appelle qui, et les flux/pièges réels observés
> dans le code. Pensé comme carte de navigation pour Claude Code et pour le développeur.

## Quand et comment mettre à jour ce fichier

**Ne PAS le mettre à jour à chaque commit.** Une carte d'architecture est stable :
ajouter une route dans un fichier existant ne la change pas. On la régénère uniquement
lors d'un **changement structurel** :

- nouveau module / fichier source, ou suppression d'un module
- une responsabilité déménage d'un fichier à un autre
- un flux change (ex. l'ordre du push, le mécanisme d'auth)
- ressenti « Claude se reperd » → signal qu'il est temps de régénérer la section concernée

La carte est découpée par **sections** (Vue d'ensemble / Hub / Borne / Core / Flux / Pièges).
On régénère **juste la section touchée**, pas tout le fichier — relire le code concerné
puis réécrire la section. Coût ponctuel, pas récurrent (≠ l'ancien `kapsule-doc-sync`).

---

## 1. Vue d'ensemble

Monorepo npm workspaces (`packages/*`, `apps/*/server`, `apps/*/web`). Node ≥ 20, ESM, pas de TypeScript.

Deux applications + un package partagé :

| Composant | Rôle | Tourne sur |
|-----------|------|-----------|
| **Borne** (`apps/borne`) | Kiosque d'enregistrement vidéo, 100 % offline pendant l'événement | Raspberry Pi / iPad Safari |
| **Hub** (`apps/hub`) | Interface client (web), reçoit/traite/archive les vidéos | VPS |
| **Core** (`packages/core`) | Constantes, validation, schéma de la BD événement, checksum — partagés | importé par les deux |

Chaque app = un **serveur Express** (`server/`) + un **frontend** (`web/`, React + Vite, servi par Nginx en prod).

**Le modèle de données central : un événement = un dossier.**
```
<DATA_DIR>/
  registry.sqlite          # métadonnées (PAS de données invité — RGPD §11)
  events/<id>/
    db.sqlite              # données de l'événement (sessions, vidéos, questions, users…)
    videos/<videoId>.mp4   # fichiers vidéo bruts
    derived/              # (Hub) miniatures, archive.zip
    push_manifest.json    # (Hub) état du push en cours
  previews/<slug>/         # (Hub) DATA_DIR bind-monté du container borne preview-<slug>
                           #   contient db.sqlite + vidéos d'essai (PII invité) — voir §2 Preview.
                           #   purgé par deprovisionPreview (rm -rf) à la suppression de l'événement.
```

> **RGPD — où vivent les données invité.** Hors `registry.sqlite` (invariant strict), les PII
> invité vivent dans `events/<id>/` (après push) **et**, pendant la phase preview, dans
> `previews/<slug>/` sur le filesystem du Hub (bind mount du container borne d'essai). Les deux
> chemins sont supprimés par `DELETE /api/events/:id` (deprovision → `rm previews/<slug>` puis
> `closeEventDb` → `rm events/<id>`). Toute nouvelle localisation de PII doit garantir cette purge.
Deux **bases SQLite distinctes** par design :
- `registry.sqlite` : index global, **jamais** de nom/vidéo/session invité (invariant RGPD).
- `events/<id>/db.sqlite` : tout le contenu invité, isolé par événement, transférable d'un bloc.

Le schéma de `db.sqlite` est **identique** Borne et Hub (généré par le même `createEventDb` de core).

---

## 2. Hub (`apps/hub/server/src/`)

Point d'entrée : `index.js` → `createApp(dataDir)` monte les routers et l'error handler global.
Process séparé optionnel : `worker/index.js` (boucle de jobs).

### Modules transversaux

| Fichier | Responsabilité |
|---------|---------------|
| `config.js` | Lecture des variables d'env (port, jwtSecret, adminEmail…) |
| `registry.js` | **Toute** la couche d'accès à `registry.sqlite` : schéma + migrations + helpers CRUD (users, events, box_tokens, event_users, registration_tokens, jobs, sync_log, **event_versions**). `events.preview_desired` (`running`/`stopped`) porte l'état désiré de la borne preview ; `listEventsPreviewDesired` alimente la réconciliation. Singleton `_db`. **Migrations versionées** : tableau `MIGRATIONS` appliqué via `runMigrations` + table `schema_migrations` (chaque migration jouée une seule fois ; idempotence interne conservée). |
| `versioning.js` | Historique de config éditoriale. `readSnapshot(edb)` lit **uniquement** `event_meta` + `questions` (jamais sessions/vidéos/invités — RGPD). `captureSnapshot` insère une version si le contenu a changé ; `resolveAuthor` résout l'email depuis `req.user`. Appelé par `events.js` (PUT/config) et `versions.js` (restore). |
| `eventStore.js` | Cache **LRU (10)** de handles `db.sqlite` par événement. `openEventDb` / `closeEventDb` / `closeAllEventDbs`. `closeEventDb` **obligatoire** avant `rm -rf` ou écrasement (§11.11). |
| `eventConfig.js` | Logique d'application config partagée par les 3 sites (`events.js` PUT, `events.js` import, `sync.js` push). `META_KEYS` (source unique des clés `event_meta`) + `applyEventConfig(edb, {mode, meta, questions})` (overwrite/merge). `admin.js` dérive son `META_HASH_KEYS` de `META_KEYS`. |
| `middleware/auth.js` | `requireUser` (vérifie JWT → `req.user`), `requireOwner` (vérifie que `req.user` est superuser OU membre `event_users` → pose `req.event`). |
| `middleware/boxAuth.js` | `requireBox` : hash le header `X-Box-Token`, résout `box_tokens` → `req.box = {token_id, event_id, is_preview}`. Met à jour `last_seen_at`. |
| `middleware/validateParams.js` | `validateUuidParams(...names)` : 400 si un param d'URL n'est pas un UUID. |

### Routers (montés dans `index.js`)

| Mount | Fichier | Auth | Contenu |
|-------|---------|------|---------|
| `/api/auth` | `routes/auth.js` | publique (rate-limited) | login (JWT), register (si `ALLOW_REGISTER`), set-password (via registration token) |
| `/api/events` | `routes/events.js` | `requireUser` + `requireOwner` | CRUD événements, config (route `/config` JWT admin, sans appelant UI depuis le retrait du write-back preview), owner, **preview/token + preview/status** (owner), **preview/start + preview/stop** (superuser only — `requireAdmin`), **suppression totale (DELETE, superuser only)** : chaîne `requireUser → requireOwner → requireAdmin` (requireOwner résout `req.event` → 404 prioritaire sur 403). DELETE déprovisionne le container, `closeEventDb` puis `rm -rf events/<id>`, journalise `sync_log` action `delete`, puis `deleteEventVersions` + `deleteJobsForEvent` + `deleteEvent` (ligne registre). `box_tokens`/`event_users`/`event_versions` partent via `ON DELETE CASCADE` ; `jobs` (pas de FK) et `sync_log` (orphelin volontaire, sans PII) sont gérés explicitement. `POST /` réservé superuser (`requireAdmin` local) ; **provisionne la preview dès la création** (statut initial `preview`). Le router accepte un `docker` injectable (`makeEventsRouter(dataDir, { docker })`) — défaut `dockerCli`. |
| `/api/events/:eventId/questions` | `routes/questions.js` | `requireUser` + `requireOwner` | CRUD questions + reorder |
| `/api/admin` | `routes/admin.js` | `requireUser` + **`requireSuperuser`** | gestion comptes clients, box_tokens (génération/liste/révocation), event_users (assignation), overview dashboard |
| `/api/events/:eventId/versions` | `routes/versions.js` (mergeParams) | `requireUser` + `requireOwner` | liste des versions de config, snapshot + diff champ par champ, **restore** (superuser only). Monté **avant** `/api/events/:eventId` (gallery) pour éviter la capture du segment `versions` comme `videoId`. |
| `/api/sync` | `routes/sync.js` | **`requireBox`** (token borne) | pull (event/bundle), push (manifest/files/db/finalize), heartbeat status, config push |
| `/api/events/:eventId` | `routes/previewGallery.js` | `requireUser` + `requireOwner` | galerie **preview** : proxy Hub → backend borne d'essai. `GET /preview-videos` (liste relayée), `GET /preview-videos/:id/file` (proxy Range-aware, accepte `?token=`), `GET /preview-storage` (used/quota depuis `/api/admin/health` borne). Monté **avant** `gallery.js` (préfixes distincts `preview-*` → pas de collision). Aussi : `triggerPreviewPull(eventId)` exporté, fire-and-forget appelé après chaque modif config/questions. |
| `/api/events/:eventId` | `routes/gallery.js` | `requireUser` + `requireOwner` + `requirePushed` | galerie : liste vidéos, file (Range-aware), download, thumbnail, archive zip, CSV, DELETE vidéo |

> **Deux chemins d'auth distincts, ne pas confondre :**
> `requireUser` (JWT humain : superuser/client) protège l'UI. `requireBox` (token borne) protège
> *uniquement* `/api/sync`. Une route config existe en double : `/api/events/:id/config`
> (JWT admin) et `/api/sync/events/:id/config` (token borne) — c'est volontaire.
> La config circule **dans un seul sens** Hub → borne (la borne preview *pull* la config du Hub,
> source de vérité). Le write-back preview → Hub a été retiré : `/api/sync/push-config` est
> interdit (403) en mode preview, et l'UI Hub n'importe plus la config d'une borne d'essai
> (l'onglet « Aperçu » d'`EventDetailPage` a été supprimé ; l'état de la borne d'essai est
> désormais une box d'en-tête `PreviewBox` — lien + statut, sans import de config). La route
> JWT `/api/events/:id/config` n'a plus d'appelant dans l'UI mais reste exposée (auth admin).

### Worker (`worker/`)

Process à boucle (`loop`), polling de la table `jobs` :
- `index.js` : `claimNextJob` (transaction atomique pending→running), `processJob`, `recoverOrphans`
  (running→pending au démarrage), `maybeMarkProcessed` (tous les jobs done → événement `processed`).
- `jobs/probe.js` : ffprobe → durée/dimensions dans `derived`.
- `jobs/thumbnail.js` : ffmpeg → miniature jpeg.
- `jobs/archive.js` : zip de toutes les vidéos.
- `ffmpeg.js` : wrappers d'appel ffmpeg/ffprobe.

Jobs enfilés par `POST /api/sync/.../finalize` (probe+thumbnail par vidéo, + 1 archive).
Réinvalidés : supprimer une vidéo ré-enfile un job `archive`.

### Preview (`preview/provisioner.js`)

Auto-provisioning Docker d'une borne d'essai par événement. Contrôle le démon Docker via
`/var/run/docker.sock` monté (CLI `docker` dans l'image backend).
- `slugFor(eventId)` : 8 hex du sha256, DNS-safe, stable. Sert de nom de container + sous-domaine.
- `provisionPreview` : **insère d'abord le box_token** (purge les `preview-auto` orphelins du
  même event, puis insert), crée le réseau isolé `preview-net-<slug>`, lance **2 containers**
  (`preview-backend-<slug>` = borne Express avec alias réseau `borne-preview-backend`,
  `preview-<slug>` = nginx SPA), connecte **les deux** à `kapsule_hub_net`. ⚠️ Le token est
  inséré **avant** les `docker run` : la borne pull dès le boot, le token doit déjà être valide
  (sinon 401 « Token borne invalide » → « aucun événement actif »). Fournit `TECH_PASSWORD`
  au backend (sinon il refuse de démarrer → 502). Un token sans container est inoffensif.
- `startPreview` : idempotent — démarre les containers s'ils existent et sont arrêtés,
  les **provisionne** s'ils n'existent pas. Partagé par la route `preview/start` et le script
  `reconcile-previews`.
- `deprovisionPreview(eventId, docker, dataDir)` : révoque le token, supprime les 2 containers + le réseau, puis **purge les données preview** : `rm -rf previews/<slug>` si `dataDir` fourni (prod), sinon `docker volume rm preview-data-<slug>` (fallback sans bind mount).
- **DATA_DIR du container borne preview** : monté en `--mount type=bind,source=<dataDir>/previews/<slug>,target=/app/data` (visible/sauvegardable sur le filesystem Hub). `startPreview`/`provisionPreview`/`deprovisionPreview` prennent `dataDir` en 3ᵉ argument ; le script `reconcile-previews` passe `config.dataDir`.
- **Provisioning déclenché à la création** (`POST /api/events` : statut initial `preview`, `startPreview` best-effort puis `preview_desired='running'`). `preview → ready` arrête les containers (données conservées). La suppression totale (`DELETE`) déprovisionne et efface `previews/<slug>`.
- **Cycle de vie start/stop + état désiré** : les routes `POST .../preview/start|stop`
  (superuser) démarrent/arrêtent les containers ET écrivent `events.preview_desired`
  (`running`/`stopped`). Cet **état désiré** (en base) est distinct de l'**état réel** (Docker) :
  le script `scripts/reconcile-previews.js` (lancé au boot / `make vps-up`) relance via
  `startPreview` uniquement les events `preview_desired='running'` — une preview éteinte
  volontairement n'est jamais ressuscitée. `preview/status` reflète l'état réel (`docker.running`).
  ⚠️ Ces routes appellent `docker.running/start/stop`, méthodes qui doivent exister sur le
  `dockerCli` injecté.

---

## 3. Borne (`apps/borne/server/src/`)

Point d'entrée : `index.js` → `createApp(dataDir, cfg)`. Pull one-shot au démarrage si `HUB_URL`+`BOX_TOKEN`.

### Modules transversaux

| Fichier | Responsabilité |
|---------|---------------|
| `config.js` | Env (port, jwtSecret, hubUrl, boxToken, previewMode, maxDataBytes…) |
| `registry.js` | Accès à `registry.sqlite` **local** (différent du Hub) : table `local_events` (1 seul `active=1` à la fois) + `push_state`. Helpers `getActiveEvent`, `setActiveEvent`, `updateEventStatus`. |
| `eventDb.js` | Cache **mono-handle** du `db.sqlite` de l'événement **actif** (≠ LRU du Hub : la borne ne sert qu'un événement). `getActiveEventDb` / `closeEventDb`. |
| `middleware/auth.js` | `makeAuthRouter` (login → JWT), `requireRole(role)` factory → `requireAdmin`/`requireTech`. Auth par compte nominatif (`event_users` du db.sqlite, pull depuis Hub) avec **fallback `TECH_PASSWORD`** si aucun user (mode autonome). |

### Routers (tous montés sur `/api`)

| Fichier | Contenu |
|---------|---------|
| `routes/events.js` | event actif (`GET /event` config publique — inclut désormais `video_quality` résolu **override local > event_meta > DEFAULT** + `video_width/height/bitrate`), statut, close, pull/push déclenchés manuellement (tech). **`PUT /api/admin/video-quality`** écrit `local_overrides.video_quality` : **sans auth en preview** (borne d'essai démo), garde `requireTech` hors preview. ⚠️ Route publique d'écriture en preview **sans rate-limit** (≠ `/sessions`, `/videos`, `/preview/login` qui en ont un) — borne preview Internet-facing. |
| `routes/questions.js` | CRUD questions (admin borne) |
| `routes/sessions.js` | création de session invité (publique, ou JWT general si preview avec login), answers, complete, **`POST /api/preview/login`** (proxy auth wall vers Hub, §11.24) |
| `routes/videos.js` | upload vidéo (multipart), liste, stream Range-aware, remplacement (DELETE+INSERT transactionnel), suppression |
| `routes/sync.js` | endpoints déclenchant `pull.js`/`push.js`, status de progression |

### Sync (`sync/`)

| Fichier | Rôle |
|---------|------|
| `hubClient.js` | `hubFetch` / `hubFetchJson` : appels au Hub avec `X-Box-Token`, retry backoff `min(2000·2^(n-1), 30000)`, 5 essais, sur erreurs réseau uniquement (pas 4xx). |
| `pull.js` | `pullMyEvent` (récupère l'unique événement du token) → `pullEvent` (écrit questions/meta/users dans db.sqlite, DELETE+INSERT). **Filtre les users `general` du bundle** (seuls `admin_borne`/`tech_borne` sont stockés en `event_users`) et écrit `requires_login` dans `event_meta` (§11.24). Statut local vérifié **au moment d'appliquer** (§11.10). En preview : purge les anciens événements preview. |
| `push.js` | `pushConfig` (remonte la config vers le Hub) ; `pushEvent` (checkpoint WAL → manifest → upload des `missing` → upload db.sqlite → finalize → statut `pushed`). État de progression dans `_state`. |

### Frontend borne (`apps/borne/web/src/`)

- `api/client.js` : appels au backend borne + parcours invité.
- `api/roles.js` : `decodeJwtPayload` + `getRole` (tableau `roles[]`). Testé isolément (`test/roles.test.js`).
- `hooks/useMediaRecorder.js` : capture vidéo via MediaRecorder (codecs mp4 pour Safari, §11).

### Frontend Hub (`apps/hub/web/src/`)

- `api/client.js` : appels au backend Hub (fetch + token Bearer). Ré-importe `roles.js` pour `getRole`.
- `api/roles.js` : `decodeJwtPayload` + `getRole` (scalaire `role` — ≠ borne qui retourne un tableau `roles`). Testé dans `test/roles.test.js`.
- `utils/format.js` : formateurs purs (`formatBytes`, `formatDate`, `formatDuration`, `formatSize`) extraits de `AdminPage.jsx`/`VideoGallery.jsx`. Testés dans `test/format.test.js`.
- `pages/AdminPage.jsx` et `components/VideoGallery.jsx` importent `format.js` (plus d'inline).

> **Différence borne vs hub pour `roles.js`** : la borne encode un tableau `roles: ['admin_borne', 'tech_borne']` ; le Hub encode un scalaire `role: 'superuser'`. Les deux `roles.js` ont la même API (`getRole`) mais ne sont pas interchangeables.

---

## 4. Core (`packages/core/src/`)

Importé via le barrel `index.js` qui **ne ré-exporte que** `constants.js` + `validate.js`
(les modules à dépendance native/node sont importés par chemin direct, pas depuis le barrel) :

| Fichier | Contenu | Exporté par le barrel ? |
|---------|---------|------------------------|
| `constants.js` | `EVENT_STATUS`, `STATUS_ORDER`, `JOB_TYPES`, `LIMITS`, `THEMES`, `DEFAULTS`, `TEXT_FIELDS`, **`VIDEO_QUALITY`** (presets `eco`/`standard`/`haute`/`max` → `{label,width,height,videoBitrate}`), **`DEFAULT_VIDEO_QUALITY`** (`standard`), **`AUDIO_BITRATE`** — source unique partagée Hub/Borne/kiosque | ✅ |
| `validate.js` | validateurs (guest name, question…) | ✅ |
| `eventDbSchema.js` | `createEventDb(path)` : schéma complet de `db.sqlite` + seed des 4 questions par défaut | ❌ (import direct — better-sqlite3 natif) |
| `checksum.js` | `sha256File` | ❌ (import direct — node:crypto/fs) |

**Schéma de `db.sqlite`** (identique Borne/Hub) : `event_meta`, `questions`, `sessions`,
`videos` (UNIQUE session+question → 1 réponse par question/session), `derived`
(miniature/durée/dimensions, 1-1 avec videos), `event_users` (email/hash/roles — peuplé au pull),
`local_overrides` (key/value — **réglages locaux à la borne, jamais écrasés par le pull** ;
contrairement à `event_meta` que `pull.js` fait `DELETE`+`INSERT`). Première clé : `video_quality`
(override de la qualité d'enregistrement choisi sur place, survit aux pulls de config Hub).

---

## 5. Flux clés (de bout en bout)

**Cycle de vie d'un événement** (statuts) :
`preview → ready → loaded → live → closed → pushed → processed → waiting`
- `preview` (**statut initial** à la création) : test sur la borne d'essai (`is_preview=1`) ;
  édition encore possible ; transitions manuelles `preview→ready` (« Valider la configuration »,
  gèle le contenu) et `ready→preview`. Le statut `draft` a été supprimé (migration registry 8).
- `ready` : config gelée, un token réel peut puller ; `ready→preview` possible (retour en preview).
- `loaded` : pullé sur la borne (édition à nouveau possible jusqu'au jour J).
- `live/closed` : déroulement sur la borne (sessions invités).
- `pushed` : remonté au Hub.
- `processed` : jobs worker terminés (galerie disponible).
- `waiting` : état terminal d'attente, données disponibles.
- **Suppression** : `DELETE /api/events/:id` (superuser only) est désormais une **suppression totale**
  (container + `rm -rf events/<id>` + ligne registre), non plus une purge laissant la ligne en `waiting`.

> Côté front : `EventsPage`/`EventDetailPage`/`SyncStatus` mappent ces statuts en libellés FR
> (`STATUS_LABEL`/`STATUS_TIMELINE_LABEL`) et badges CSS `status-badge--<status>` ;
> `FROZEN_STATUSES` (gel d'édition) = `{live, closed, pushed, processed, waiting}` — `preview` reste éditable.

**Pull (Hub → Borne)** : `pullMyEvent` → `GET /api/sync/event` (résout le token) →
`GET /api/sync/events/:id/bundle` (questions + meta + users, passe `ready`→`loaded`) →
écriture dans `db.sqlite` local. Les superusers reçoivent tous les rôles borne.

**Push (Borne → Hub)** : `pushEvent` → checkpoint WAL → `POST /manifest`
(le Hub renvoie `missing` recalculé par checksum — jamais confiance au `push_state` local, §11.12) →
upload des vidéos manquantes (retry) → upload `db.sqlite` (le Hub ferme son handle avant d'écraser, §11.11) →
`POST /finalize` (revérifie complétude, enfile les jobs, passe `pushed`). Idempotent/reprenable.

**Preview (essai client avant l'événement)** : à la création d'un événement, le Hub provisionne
2 containers Docker (borne + nginx) et un box_token preview. L'edge nginx route
`essai-<slug>.<domaine>` vers le container nginx. **Auth wall preview (§11.24)** : si un user
Hub avec le rôle `general` est assigné, le bundle pullé porte `requiresLogin: true` (stocké dans
`event_meta.requires_login` côté borne — le rôle `general` n'est **jamais** pullé dans
`event_users`). Le login invité passe par `POST /api/preview/login {email,password}` sur la borne,
qui délègue en **un seul appel** au Hub `POST /api/sync/event/login` (protégé par le box token) :
le Hub authentifie email/mot de passe **et** vérifie l'assignation `general` sur l'événement du
token, puis répond `200` / `401` / `403` sans jamais divulguer la liste des emails à la borne.
Sur `200`, la borne signe et retourne un JWT local `{email, roles:['general'], event_id}` (8 h),
et vérifie `event_id` à la création de session → cloisonnement. (Mécanisme antérieur — lien JWT
signé via `preview/token` — conservé en parallèle.)

**Auth** :
- *Hub* : JWT `{sub, role}` (superuser/client), 24 h. `requireUser` puis `requireOwner` (membership event_users).
- *Borne* : JWT `{email, roles}` (admin_borne/tech_borne/general), 24 h. `tech_borne` ⊇ `admin_borne` (§11.19).
  Fallback `TECH_PASSWORD` si aucun compte (mode autonome).
- *Sync* : `X-Box-Token` (token opaque hashé), un token = un événement (§11.20).

---

## 6. Pièges & invariants observés dans le code

Liste complète et justifiée dans **PROJET.md §11** — voici les points qui se *voient* dans le code
et qu'il ne faut pas casser en refactorant :

- **Routes `…/export/csv` déclarées AVANT `/:videoId`** (sinon Express capture `csv` comme un id) — `gallery.js`.
- **`requireUser`/`requireRole` acceptent `?token=`** (pour `<video src>`, downloads, CSV) — middlewares auth.
- **Routes `/file` Range-aware** (206 + Content-Range) sinon pas de scrubbing vidéo — `gallery.js`/`videos.js`.
- **`closeEventDb` avant tout `rm -rf` / écrasement de `db.sqlite`** — `eventStore.js` (Hub), `eventDb.js` (Borne).
- **`wal_checkpoint(TRUNCATE)` avant checksum/transfert du `db.sqlite`** — `push.js`.
- **Pull : statut vérifié au moment d'appliquer, pas au lancement** — `pull.js` (§11.10).
- **Push : `missing` recalculé côté Hub par checksum** — `sync.js` Hub + `push.js` Borne (§11.12).
- **RGPD : aucune donnée invité dans `registry.sqlite`** — vérifier à chaque ajout de colonne.
- **Login : vérifier `active` + `password_hash` non-null AVANT `argon2.verify`** — `auth.js` (§11.22).
- **Upload kiosque en XMLHttpRequest avec retry backoff** — frontend borne.
- **JWT preview scopé par `event_id`** vérifié dans `requireRole` ET `POST /api/sessions` (borne).
- **Durcissement exposition publique** (Hub + Borne preview Internet-facing) : `express.json({ limit: '1mb' })`, `trust proxy 1`, `express-rate-limit` (Hub login 10/15min ; Borne login 10, sessions 20, uploads 50 — `skip` via `cfg.skipRateLimits` en test), en-têtes de sécurité (HSTS/X-Frame/nosniff/CSP) posés au niveau **edge** et borne-nginx, TLS terminé par le service `edge`. `validateConfig` **refuse de démarrer** si `JWT_SECRET`/`TECH_PASSWORD` restent par défaut en production/preview.
- **`/api/health` public minimal** (`{ok:true}`) ; les infos disque passent par `/api/admin/health` (authentifié) — ne pas réexposer le disque sans auth.
