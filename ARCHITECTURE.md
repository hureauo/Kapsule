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
```
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
| `registry.js` | **Toute** la couche d'accès à `registry.sqlite` : schéma + migrations + helpers CRUD (users, events, box_tokens, event_users, registration_tokens, jobs, sync_log). Singleton `_db`. |
| `eventStore.js` | Cache **LRU (10)** de handles `db.sqlite` par événement. `openEventDb` / `closeEventDb` / `closeAllEventDbs`. `closeEventDb` **obligatoire** avant `rm -rf` ou écrasement (§11.11). |
| `eventConfig.js` | Logique d'application config partagée par les 3 sites (`events.js` PUT, `events.js` import, `sync.js` push). `META_KEYS` (source unique des clés `event_meta`) + `applyEventConfig(edb, {mode, meta, questions})` (overwrite/merge). `admin.js` dérive son `META_HASH_KEYS` de `META_KEYS`. |
| `middleware/auth.js` | `requireUser` (vérifie JWT → `req.user`), `requireOwner` (vérifie que `req.user` est superuser OU membre `event_users` → pose `req.event`). |
| `middleware/boxAuth.js` | `requireBox` : hash le header `X-Box-Token`, résout `box_tokens` → `req.box = {token_id, event_id, is_preview}`. Met à jour `last_seen_at`. |
| `middleware/validateParams.js` | `validateUuidParams(...names)` : 400 si un param d'URL n'est pas un UUID. |

### Routers (montés dans `index.js`)

| Mount | Fichier | Auth | Contenu |
|-------|---------|------|---------|
| `/api/auth` | `routes/auth.js` | publique (rate-limited) | login (JWT), register (si `ALLOW_REGISTER`), set-password (via registration token) |
| `/api/events` | `routes/events.js` | `requireUser` + `requireOwner` | CRUD événements, config (import depuis UI), owner, **preview/token + preview/status**, purge RGPD (DELETE). `POST /` réservé superuser (`requireAdmin` local). |
| `/api/events/:eventId/questions` | `routes/questions.js` | `requireUser` + `requireOwner` | CRUD questions + reorder |
| `/api/admin` | `routes/admin.js` | `requireUser` + **`requireSuperuser`** | gestion comptes clients, box_tokens (génération/liste/révocation), event_users (assignation), overview dashboard |
| `/api/sync` | `routes/sync.js` | **`requireBox`** (token borne) | pull (event/bundle), push (manifest/files/db/finalize), heartbeat status, config push |
| `/api/events/:eventId` | `routes/gallery.js` | `requireUser` + `requireOwner` + `requirePushed` | galerie : liste vidéos, file (Range-aware), download, thumbnail, archive zip, CSV, DELETE vidéo |

> **Deux chemins d'auth distincts, ne pas confondre :**
> `requireUser` (JWT humain : superuser/client) protège l'UI. `requireBox` (token borne) protège
> *uniquement* `/api/sync`. Une route preview/config existe en double : `/api/events/:id/config`
> (JWT admin) et `/api/sync/events/:id/config` (token borne) — c'est volontaire.

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
- `provisionPreview` : crée réseau isolé `preview-net-<slug>`, lance **2 containers**
  (`preview-backend-<slug>` = borne Express avec alias réseau `borne-preview-backend`,
  `preview-<slug>` = nginx SPA), connecte **les deux** à `kapsule_hub_net` (pour que l'edge
  les résolve), **puis** insère le box_token (après les `docker run` → pas d'orphelin si échec).
- `deprovisionPreview` : révoque le token, supprime les 2 containers + le réseau.
- Appelé best-effort par `POST /api/events` (création) et `DELETE /api/events/:id` (purge).

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
| `routes/events.js` | event actif (config publique pour le parcours invité), statut, close, pull/push déclenchés manuellement (tech) |
| `routes/questions.js` | CRUD questions (admin borne) |
| `routes/sessions.js` | création de session invité (publique, ou JWT general si preview avec login), answers, complete |
| `routes/videos.js` | upload vidéo (multipart), liste, stream Range-aware, remplacement (DELETE+INSERT transactionnel), suppression |
| `routes/sync.js` | endpoints déclenchant `pull.js`/`push.js`, status de progression |

### Sync (`sync/`)

| Fichier | Rôle |
|---------|------|
| `hubClient.js` | `hubFetch` / `hubFetchJson` : appels au Hub avec `X-Box-Token`, retry backoff `min(2000·2^(n-1), 30000)`, 5 essais, sur erreurs réseau uniquement (pas 4xx). |
| `pull.js` | `pullMyEvent` (récupère l'unique événement du token) → `pullEvent` (écrit questions/meta/users dans db.sqlite, DELETE+INSERT). Statut local vérifié **au moment d'appliquer** (§11.10). En preview : purge les anciens événements preview. |
| `push.js` | `pushConfig` (remonte la config vers le Hub) ; `pushEvent` (checkpoint WAL → manifest → upload des `missing` → upload db.sqlite → finalize → statut `pushed`). État de progression dans `_state`. |

### Frontend borne (`apps/borne/web/src/`)

- `api/client.js` : appels au backend borne + parcours invité.
- `api/roles.js` : décodage des rôles du JWT.
- `hooks/useMediaRecorder.js` : capture vidéo via MediaRecorder (codecs mp4 pour Safari, §11).

---

## 4. Core (`packages/core/src/`)

Importé via le barrel `index.js` qui **ne ré-exporte que** `constants.js` + `validate.js`
(les modules à dépendance native/node sont importés par chemin direct, pas depuis le barrel) :

| Fichier | Contenu | Exporté par le barrel ? |
|---------|---------|------------------------|
| `constants.js` | `EVENT_STATUS`, `STATUS_ORDER`, `JOB_TYPES`, `LIMITS`, `THEMES`, `DEFAULTS`, `TEXT_FIELDS` | ✅ |
| `validate.js` | validateurs (guest name, question…) | ✅ |
| `eventDbSchema.js` | `createEventDb(path)` : schéma complet de `db.sqlite` + seed des 4 questions par défaut | ❌ (import direct — better-sqlite3 natif) |
| `checksum.js` | `sha256File` | ❌ (import direct — node:crypto/fs) |

**Schéma de `db.sqlite`** (identique Borne/Hub) : `event_meta`, `questions`, `sessions`,
`videos` (UNIQUE session+question → 1 réponse par question/session), `derived`
(miniature/durée/dimensions, 1-1 avec videos), `event_users` (email/hash/roles — peuplé au pull).

---

## 5. Flux clés (de bout en bout)

**Cycle de vie d'un événement** (statuts) :
`draft → ready → loaded → live → closed → pushed → processed → purged`
- `draft/ready` : édition côté Hub.
- `loaded` : pullé sur la borne.
- `live/closed` : déroulement sur la borne (sessions invités).
- `pushed` : remonté au Hub.
- `processed` : jobs worker terminés (galerie disponible).
- `purged` : supprimé (RGPD).

**Pull (Hub → Borne)** : `pullMyEvent` → `GET /api/sync/event` (résout le token) →
`GET /api/sync/events/:id/bundle` (questions + meta + users, passe `ready`→`loaded`) →
écriture dans `db.sqlite` local. Les superusers reçoivent tous les rôles borne.

**Push (Borne → Hub)** : `pushEvent` → checkpoint WAL → `POST /manifest`
(le Hub renvoie `missing` recalculé par checksum — jamais confiance au `push_state` local, §11.12) →
upload des vidéos manquantes (retry) → upload `db.sqlite` (le Hub ferme son handle avant d'écraser, §11.11) →
`POST /finalize` (revérifie complétude, enfile les jobs, passe `pushed`). Idempotent/reprenable.

**Preview (essai client avant l'événement)** : à la création d'un événement, le Hub provisionne
2 containers Docker (borne + nginx) et un box_token preview. L'edge nginx route
`essai-<slug>.<domaine>` vers le container nginx. Accès client : login email/mot de passe
(comptes `event_users`), OU lien JWT signé par le Hub (`POST /api/events/:id/preview/token`,
payload `{roles:['general'], event_id}`). La borne preview vérifie `event_id` → cloisonnement.

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
