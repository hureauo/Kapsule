# PROJET : "Kapsule" — Borne vidéo d'événements (Raspberry + VPS)

Ce document est la spécification de référence du projet. Il est conçu pour être donné tel quel à un agent IA (Claude) ou à un développeur : il décrit l'architecture, les fichiers, les schémas, les API et l'ordre de développement. Il est **auto-suffisant** — aucune connaissance externe n'est requise.

---

## 1. Vision produit

Un système de **borne d'enregistrement de messages vidéo pour événements** (mariages, anniversaires, capsules temporelles), en deux applications :

- **La Borne** (Raspberry Pi) : serveur local **100% offline** pendant l'événement. Un iPad en Safari sur le même Wi-Fi sert de kiosque : l'invité saisit son prénom puis répond à une séquence de questions en se filmant. Un admin local permet d'ajuster les questions sur place et de visionner les vidéos brutes immédiatement.
- **Le Hub** (VPS) : interface web où le **client** (l'organisateur ; à terme plusieurs clients avec des comptes séparés) prépare ses événements et ses questions, puis consulte ses vidéos après coup. Le Hub reçoit les vidéos, génère miniatures et métadonnées, et accueillera plus tard du traitement lourd (fond vert…).

**Cycle de vie** : le client configure sur le Hub → la Borne **tire** (pull) la configuration → l'événement se déroule offline, **la Borne est maître** → de retour sur la fibre, on **pousse** (push, déclenchement manuel) vidéos + configuration finale vers le Hub → traitement → consultation → purge.

**Contraintes structurantes :**
- Multi-événements, multi-clients.
- **RGPD : cloisonnement strict par événement — une base SQLite et un dossier de fichiers indépendants par événement.** Effacer un événement = supprimer son dossier.
- **RGPD : consentement explicite de l'invité** — case à cocher obligatoire avant tout enregistrement (écran du prénom), texte configurable par événement, acceptation **horodatée en base** (preuve de consentement).
- La Borne doit être **utilisable seule** (mode autonome : créer un événement localement sans Hub).
- UI invité en **français**, UI admin/Hub en français aussi.
- Cible invité : iPad Safari → HTTPS obligatoire pour la caméra, codecs mp4, `playsInline`.
- L'invité peut **naviguer entre les questions et réenregistrer une réponse déjà confirmée** sans refaire sa session (un invité qui se trompe ne doit jamais avoir à tout recommencer).

---

## 2. Architecture

```
        AVANT                         PENDANT                          APRÈS
┌──────────────────┐          ┌─────────────────────┐          ┌──────────────────┐
│ HUB (VPS)        │   pull   │ BORNE (Raspberry)   │   push   │ HUB (VPS)        │
│ comptes clients  │ ───────► │ kiosque iPad (SPA)  │ ───────► │ manifest+sha256  │
│ CRUD événements  │   auto   │ admin local         │  manuel  │ worker ffmpeg    │
│ éditeur questions│          │ stockage offline    │          │ galerie client   │
│ galerie/jobs     │          │ visionnage brut     │          │ purge RGPD       │
└──────────────────┘          └─────────────────────┘          └──────────────────┘
```

- La Borne **initie toutes les communications** (pull et push) ; le Hub n'appelle jamais la Borne.
- Sur chaque machine : Nginx (TLS + statique + proxy `/api/*`) devant un backend Express. Orchestration docker-compose. Sur le Hub, un 3ᵉ processus : le worker de traitement.
- Machine à états d'un événement (stockée dans le registre du Hub ; sous-ensemble sur la Borne) :

```
draft → ready → loaded → live → closed → pushed → processed → purged
 hub     hub     pull    1ʳᵉ session  borne   push OK   worker    RGPD
```

**Règle anti-conflit (à respecter scrupuleusement)** : le pull automatique des questions n'opère que tant que l'événement local est en `loaded`. Dès la première session invitée (`live`), plus aucun pull ; au push, l'état de la Borne **écrase** celui du Hub pour cet événement (traçé dans `sync_log`). La Borne remonte ses transitions d'état (`live`, `closed`) au Hub en **best effort** quand elle est online (heartbeat, §7) — le Hub peut donc geler l'édition et informer le client, mais ne doit jamais *compter* sur cette information (la Borne peut être restée offline).

---

## 3. Stack technique (choix figés)

**Commun**
- Node 20 (alpine), modules **ESM** (`"type": "module"` partout).
- Express 4, `better-sqlite3` (synchrone), `multer` (upload disque), `jsonwebtoken`, `uuid` v4. Pas de package `cors` : frontend et API sont servis sur la même origine via Nginx, CORS n'entre jamais en jeu (le réintroduire avec une liste d'origines précise seulement si un vrai besoin cross-origin apparaît).
- Tests : `node:test` (runner natif) + `supertest` — voir §12, le protocole de synchro est couvert par des tests d'intégration.
- Monorepo **npm workspaces** (pas de turborepo/nx — rester simple).

**Frontends** : React 18 + Vite 5 (`@vitejs/plugin-react`), `react-router-dom` v6, CSS pur (un stylesheet par app, custom properties, pas de framework UI). Capture via l'API native `MediaRecorder` (pas de bibliothèque d'enregistrement).

**Hub en plus** : `argon2` (hash mots de passe), `express-rate-limit` (anti brute force sur le login), `ffmpeg`/`ffprobe` appelés via `child_process.spawn` (pas de wrapper npm), `archiver` (génération des ZIP d'export, mode store).

**Infra** : Docker + docker-compose. Borne = images **arm64** (`node:20-alpine` multi-arch). Nginx alpine. OpenSSL pour le cert auto-signé de la Borne ; Let's Encrypt (certbot) ou cert fourni pour le Hub.

---

## 4. Arborescence du monorepo

```
kapsule/
├── package.json                      # workspaces: ["packages/*", "apps/*/server", "apps/*/web"]
├── .env.example
├── docker-compose.borne.yml
├── docker-compose.hub.yml
├── PROJET.md                         # ce document
├── packages/
│   └── core/                         # @kapsule/core — tout ce qui est partagé
│       ├── package.json
│       └── src/
│           ├── index.js              # ré-exporte tout
│           ├── constants.js          # EVENT_STATUS, JOB_TYPES, LIMITS (500 MB, durées…)
│           ├── eventDbSchema.js      # SQL de la BD "événement" + createEventDb(filePath)
│           ├── validate.js           # validateQuestion(), validateGuestName(), assertStatus()
│           └── checksum.js           # sha256File(path) → Promise<hex> (stream, pas de readFile)
├── apps/
│   ├── borne/
│   │   ├── server/
│   │   │   ├── Dockerfile
│   │   │   ├── package.json
│   │   │   └── src/
│   │   │       ├── index.js          # bootstrap Express, montage des routes, error handler
│   │   │       ├── config.js         # lecture env + valeurs par défaut
│   │   │       ├── registry.js       # registre local (local_events, push_state)
│   │   │       ├── eventDb.js        # getActiveEventDb() — ouvre/cache la BD de l'événement actif
│   │   │       ├── middleware/auth.js
│   │   │       ├── routes/
│   │   │       │   ├── events.js     # admin : gestion des événements locaux, activation, clôture
│   │   │       │   ├── questions.js  # CRUD + reorder (sur l'événement actif)
│   │   │       │   ├── sessions.js
│   │   │       │   ├── videos.js     # upload/replace, stream, download, csv, delete
│   │   │       │   └── sync.js       # admin : état synchro, déclenchement pull/push, purge
│   │   │       └── sync/
│   │   │           ├── hubClient.js  # fetch vers le Hub avec token borne + retry/backoff
│   │   │           ├── pull.js       # pullEvent(hubEventId) ; pullAssigned()
│   │   │           ├── push.js       # pushEvent(eventId) — manifest, uploads, finalize, reprise
│   │   │           └── autoPull.js   # setInterval : pull auto si statut ≤ loaded + heartbeat
│   │   │                             # best-effort des transitions live/closed vers le Hub
│   │   └── web/
│   │       ├── package.json, vite.config.js, index.html
│   │       └── src/
│   │           ├── main.jsx, App.jsx # routes : "/" → GuestPage, "/admin/*" → AdminPage
│   │           ├── api/client.js
│   │           ├── hooks/useMediaRecorder.js
│   │           ├── pages/GuestPage.jsx
│   │           ├── pages/AdminPage.jsx
│   │           ├── components/guest/
│   │           │   ├── StartScreen.jsx
│   │           │   ├── NameInput.jsx
│   │           │   ├── QuestionNav.jsx      # ◀ ▶ + pastilles répondu/non-répondu
│   │           │   ├── RecordingScreen.jsx
│   │           │   ├── RecapScreen.jsx      # récap avant "terminé", accès réenregistrement
│   │           │   └── ThankYouScreen.jsx
│   │           ├── components/admin/
│   │           │   ├── AdminLogin.jsx, AdminLayout.jsx
│   │           │   ├── EventPanel.jsx       # événement actif, création locale, activation, clôture
│   │           │   ├── PreflightPanel.jsx   # checklist pré-événement (config, caméra, disque, horloge)
│   │           │   ├── QuestionManager.jsx  # table + drag-reorder (HTML5 natif)
│   │           │   ├── VideoList.jsx        # grille, modal de lecture, download, delete
│   │           │   └── SyncPanel.jsx        # état pull/push, bouton PUSH, progression, purge
│   │           └── styles/app.css           # thème sombre tactile invité / clair admin
│   └── hub/
│       ├── server/
│       │   ├── Dockerfile                   # sert aussi au worker (CMD différent)
│       │   ├── package.json
│       │   └── src/
│       │       ├── index.js, config.js
│       │       ├── registry.js              # users, boxes, events, jobs, sync_log
│       │       ├── eventStore.js            # openEventDb(eventId) avec cache LRU + closeEventDb()
│       │       ├── middleware/auth.js       # requireUser (JWT), requireOwner(eventId)
│       │       ├── middleware/boxAuth.js    # requireBox : header X-Box-Token → sha256 → boxes
│       │       ├── routes/
│       │       │   ├── auth.js              # login/register
│       │       │   ├── events.js            # CRUD événements du client + transitions d'état
│       │       │   ├── questions.js         # CRUD questions (écrit dans la BD de l'événement)
│       │       │   ├── admin.js             # super-admin : bornes (token affiché une fois),
│       │       │   │                        # overview (stockage/événement, jobs en erreur, bornes)
│       │       │   ├── gallery.js           # vidéos : list, stream (Range), download, zip, csv
│       │       │   └── sync.js              # endpoints appelés par la Borne (dont heartbeat)
│       │       └── worker/
│       │           ├── index.js             # boucle : prend un job 'pending', l'exécute
│       │           ├── ffmpeg.js            # runFfprobe(file), makeThumbnail(file, out)
│       │           └── jobs/
│       │               ├── probe.js         # durée, résolution → table derived
│       │               ├── thumbnail.js     # JPEG à t=1s → events/<id>/derived/
│       │               └── archive.js       # ZIP de toutes les vidéos (mode store) → derived/
│       └── web/
│           ├── package.json, vite.config.js, index.html
│           └── src/
│               ├── main.jsx, App.jsx
│               ├── api/client.js
│               ├── pages/LoginPage.jsx
│               ├── pages/EventsPage.jsx     # liste + création + statuts
│               ├── pages/EventDetailPage.jsx# onglets : Questions | Synchro | Galerie
│               ├── pages/AdminPage.jsx      # super-admin : bornes, stockage, jobs, tous les événements
│               ├── components/QuestionEditor.jsx
│               ├── components/VideoGallery.jsx
│               ├── components/SyncStatus.jsx
│               └── styles/app.css
└── docker/
    ├── borne-nginx.conf, borne-entrypoint.sh   # cert auto-signé CN borne.local
    └── hub-nginx.conf
```

---

## 5. Stockage et modèles de données

### 5.1 Disposition disque (identique Borne et Hub)

```
DATA_DIR/
├── registry.sqlite               # la SEULE base transverse — AUCUNE donnée invité dedans
└── events/
    └── <event-id>/               # event-id = uuid v4, généré par le Hub (ou la Borne en autonome)
        ├── db.sqlite             # questions, sessions, vidéos de CET événement
        ├── videos/               # fichiers bruts (<uuid>.<ext>)
        └── derived/              # Hub uniquement : miniatures <video-id>.jpg + archive zip
```

Toutes les bases : `PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;`. Schémas créés au démarrage avec `CREATE TABLE IF NOT EXISTS` (idempotent).

### 5.2 BD événement — `events/<id>/db.sqlite` (définie dans `@kapsule/core`)

```sql
event_meta (                       -- rend le dossier auto-portant (transféré tel quel au push)
  key TEXT PRIMARY KEY,            -- 'event_id', 'name', 'event_date', 'origin' ('hub'|'local'),
  value TEXT                       -- 'consent_text' (texte RGPD affiché à l'invité, défaut générique),
                                   -- 'idle_timeout' (secondes d'inactivité kiosque avant reset, défaut 120)
);

questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  max_duration INTEGER NOT NULL DEFAULT 60,    -- secondes, auto-stop
  countdown INTEGER NOT NULL DEFAULT 3,        -- secondes avant enregistrement
  order_index INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,          -- désactiver sans supprimer
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

sessions (
  id TEXT PRIMARY KEY,                         -- uuid ; sert de capability token côté invité
  guest_name TEXT,
  consent_at DATETIME NOT NULL,                -- horodatage de l'acceptation RGPD (preuve) ; pas de
                                               -- session sans consentement, donc NOT NULL
  started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME
);

videos (
  id TEXT PRIMARY KEY,                         -- uuid
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  question_id INTEGER REFERENCES questions(id) ON DELETE SET NULL,
  question_text TEXT NOT NULL,                 -- dénormalisé : survit à la suppression de la question
  filename TEXT NOT NULL UNIQUE,               -- <uuid>.<mp4|webm>
  mime_type TEXT NOT NULL DEFAULT 'video/mp4',
  size INTEGER,
  checksum TEXT,                               -- sha256 hex, calculé à l'upload sur la Borne
  recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(session_id, question_id)              -- UNE vidéo active par (session, question)
);

derived (                                      -- rempli par le worker du Hub uniquement
  video_id TEXT PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
  thumbnail TEXT,                              -- chemin relatif dans derived/
  duration_s REAL, width INTEGER, height INTEGER,
  probed_at DATETIME
);
```

**Réenregistrement** : l'upload d'une vidéo pour un couple (session, question) déjà répondu **remplace** l'existante — transaction : `DELETE` ancienne ligne + `INSERT` nouvelle ; l'ancien fichier est `unlink` **après commit**. C'est ce mécanisme qui permet à un invité de refaire une réponse sans recommencer sa session.

**Seed** : à la création d'un événement (Hub ou Borne), insérer 4 questions par défaut si la table est vide.

### 5.3 Registre du Hub — `registry.sqlite`

```sql
users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,                 -- argon2id
  name TEXT,
  role TEXT NOT NULL DEFAULT 'client' CHECK(role IN ('admin','client')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

boxes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,             -- sha256(token) ; le token clair n'est montré qu'une fois
  last_seen_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

events (
  id TEXT PRIMARY KEY,                         -- uuid
  owner_id INTEGER NOT NULL REFERENCES users(id),
  box_id INTEGER REFERENCES boxes(id),         -- borne assignée (NULL = pas encore)
  name TEXT NOT NULL,
  event_date DATE,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK(status IN ('draft','ready','loaded','live','closed','pushed','processed','purged')),
  pulled_at DATETIME, pushed_at DATETIME, processed_at DATETIME, purged_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  video_id TEXT,
  type TEXT NOT NULL,                          -- 'probe' | 'thumbnail' | 'archive' | (futur: 'chromakey'…)
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','done','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  started_at DATETIME, finished_at DATETIME
);

sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT, box_id INTEGER,
  action TEXT NOT NULL,                        -- 'pull','status','push_manifest','push_file','finalize','purge'
  detail TEXT,                                 -- JSON libre
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

**RGPD** : aucun nom d'invité, aucune vidéo, aucun contenu dans le registre — uniquement des comptes clients et des métadonnées d'orchestration. La purge d'un événement : `rm -rf events/<id>` + `status='purged'` + ligne `sync_log`.

### 5.4 Registre de la Borne — `registry.sqlite`

```sql
local_events (
  id TEXT PRIMARY KEY,                         -- même uuid que sur le Hub si origin='hub'
  name TEXT NOT NULL,
  origin TEXT NOT NULL CHECK(origin IN ('hub','local')),
  status TEXT NOT NULL DEFAULT 'loaded'
    CHECK(status IN ('loaded','live','closed','pushed','purged')),
  active INTEGER NOT NULL DEFAULT 0,           -- un seul événement actif servi au kiosque
  pulled_at DATETIME, pushed_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

push_state (                                   -- permet la reprise d'un push interrompu
  event_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  checksum TEXT NOT NULL,
  uploaded_at DATETIME,                        -- NULL = pas encore confirmé par le Hub
  PRIMARY KEY (event_id, video_id)
);
```

---

## 6. API — Borne (`apps/borne/server`)

Base `/api`. JSON partout sauf flux de fichiers. Gestionnaire d'erreurs global → `{ error }` + status. `GET /api/health` → `{ ok: true, activeEvent: <id|null>, disk: { free_bytes, total_bytes } }` (via `fs.statfs` sur `DATA_DIR` — l'admin affiche une alerte rouge sous 10 Go).

**Auth admin local** (`middleware/auth.js`) :
- `POST /api/admin/login` `{ password }` vs env `ADMIN_PASSWORD` → `{ token }` JWT (`JWT_SECRET`, `{ role:'admin' }`, 24h).
- `requireAdmin` : accepte `Authorization: Bearer` **ou** `?token=` (indispensable pour `<video src>`, downloads, CSV).

**Événements locaux** (`routes/events.js`) — admin :
- `GET /api/events` — liste du registre local.
- `POST /api/events` `{ name, event_date? }` — création **autonome** (origin `local`) : crée `events/<uuid>/` + `db.sqlite` + questions par défaut.
- `PUT /api/events/:id/activate` — désactive les autres, active celui-ci. Refusé pendant un push en cours.
- `PUT /api/events/:id/close` — **clôture** (`live → closed`) : le kiosque cesse d'accepter de nouvelles sessions (écran « événement terminé »). Réservé à l'admin local = l'**opérateur** ; le client n'a jamais accès à l'admin Borne. Signalé au Hub via le heartbeat quand online.
- `GET /api/event` — **public** : `{ id, name, status, consent_text, idle_timeout }` de l'événement actif (consommé par le kiosque ; `consent_text` et `idle_timeout` viennent d'`event_meta`, avec défauts génériques). 404 si aucun.
- `GET /api/preflight` — admin : checklist agrégée `{ event: {loaded, pulled_at}, questions_count, disk_ok, clock_ok }` (la vérification caméra se fait côté iPad dans `PreflightPanel`). `clock_ok` compare l'heure de la Borne à l'heure envoyée par le navigateur admin (`?client_time=`) — alerte si écart > 2 min.

**Questions** (`routes/questions.js`) — opèrent sur la BD de l'événement actif :
- `GET /api/questions` — **public**, `WHERE enabled=1 ORDER BY order_index, id`.
- `POST /api/questions` `{ text, max_duration=60, countdown=3 }` — admin, `order_index = max+1`.
- `PUT /api/questions/:id` — admin, mise à jour partielle (dont `enabled`), bump `updated_at`.
- `DELETE /api/questions/:id` — admin.
- `PUT /api/questions/reorder/batch` `{ order:[{id, order_index}] }` — admin, en transaction.

**Sessions** (`routes/sessions.js`) :
- `POST /api/sessions` `{ guest_name, consent: true }` — **public** → **400 si `consent` n'est pas `true`** ; stocke `consent_at = now` ; crée la session, **passe l'événement en `live` si premier**, retourne la ligne.
- `GET /api/sessions/:id/answers` — **public** (le uuid de session fait office de jeton) : `[{ question_id, video_id, recorded_at }]` — permet au kiosque d'afficher répondu/non-répondu et le récap.
- `PUT /api/sessions/:id/complete` — **public**.
- `GET /api/sessions` — admin, avec `video_count` (LEFT JOIN) et `consent_at` (visible aussi dans l'export CSV des vidéos, colonne jointe depuis la session).

**Vidéos** (`routes/videos.js`) :
- `POST /api/videos` — **public**. `multer().single('video')`, stockage disque dans `events/<id>/videos/`, nom `<uuid>.<ext>`, limite **500 MB**. fileFilter : mimetype `video/*` OU (mime générique `text/plain`/`application/octet-stream` ET extension `.mp4|.webm|.mov|.avi|.mkv`) — Safari envoie parfois un mime générique. Champs : `session_id` (requis), `question_id`, `question_text` (requis), `recorded_at`. Calcule le sha256 (stream), applique la logique **remplacement** (§5.2). Sur erreur BD : `unlink` du fichier. Retourne la ligne.
- `GET /api/sessions/:sessionId/videos/:questionId/file` — **public restreint à la session** : stream Range-aware de la vidéo du couple (session, question). Permet à l'invité de revoir sa réponse avant de la refaire. 404 sinon.
- `GET /api/videos?session_id=` — admin, JOIN `guest_name`, tri `uploaded_at DESC`.
- `GET /api/videos/export/csv` — admin. **Déclaré AVANT les routes `/:id`.** Colonnes : id, session_id, guest_name, consent_at, question_id, question_text, recorded_at, uploaded_at, size, filename, mime_type. Valeurs échappées entre guillemets, `Content-Disposition: attachment`.
- `GET /api/videos/:id/file` — admin, **Range-aware** (206 + `Content-Range`/`Accept-Ranges`, sinon 200).
- `GET /api/videos/:id/download` — admin, `Content-Disposition: attachment`.
- `DELETE /api/videos/:id` — admin, unlink + delete.

**Synchro** (`routes/sync.js`) — admin :
- `GET /api/sync/status` — `{ online, hubUrl, lastPull, push: { running, total, done, currentFile } }`.
- `POST /api/sync/pull` — pull manuel immédiat (sinon `autoPull.js` toutes les 5 min si statut ≤ `loaded` ; le même cycle envoie en **best effort** les transitions `live`/`closed` au Hub — un échec est silencieux et retenté au cycle suivant).
- `POST /api/sync/push/:eventId` — **409 si l'événement n'est pas `closed`** (message : « Clôturez l'événement avant le push ») ; sinon lance `push.js` en tâche de fond ; la progression se lit via `GET /api/sync/status`.
- `POST /api/sync/purge/:eventId` — refusé si `status != 'pushed'` ; demande une confirmation explicite (`{ confirm: name }`).

---

## 7. API — Hub (`apps/hub/server`)

Base `/api`. `GET /api/health`.

**Auth utilisateurs** (`routes/auth.js`, `middleware/auth.js`) :
- `POST /api/auth/login` `{ email, password }` → `{ token }` JWT 24h `{ sub: user.id, role }`. Vérif argon2. **`express-rate-limit` : 10 essais / 15 min / IP** (le Hub est exposé sur Internet).
- `POST /api/auth/register` — **désactivé par défaut** (`ALLOW_REGISTER=false`) ; le premier compte se crée via script `npm run create-admin` (prompt email/mdp).
- `requireUser` : JWT header ou `?token=`. `requireOwner(eventId)` : 403 si `events.owner_id != user.id` (sauf `role='admin'`). **Toutes les routes événement passent par ce contrôle — c'est le cloisonnement client.**

**Événements** (`routes/events.js`) — user :
- `GET /api/events` — ceux du user (tous si admin).
- `POST /api/events` `{ name, event_date }` → uuid, statut `draft`, crée `events/<id>/db.sqlite` avec questions par défaut.
- `PUT /api/events/:id` — métadonnées, dont `consent_text` et `idle_timeout` (écrits dans `event_meta` de la BD événement, donc transférés à la Borne via le bundle) ; `PUT /api/events/:id/status` `{ status:'ready' }` (seules transitions manuelles : `draft→ready`, `ready→draft`). Même règle de gel d'édition que les questions (voir ci-dessous).
- `PUT /api/events/:id/assign` `{ box_id }`.
- `DELETE /api/events/:id` — **purge RGPD** : `rm -rf events/<id>` + `status='purged'` + `sync_log`. Confirmation `{ confirm: name }`.

**Questions** (`routes/questions.js`) — user + owner ; mêmes routes que la Borne mais sur `eventStore.openEventDb(eventId)` : `GET/POST/PUT/DELETE /api/events/:id/questions`, `PUT /api/events/:id/questions/reorder/batch`.

**Règle de gel d'édition (Hub)** — le Hub ne voit pas l'événement passer `live` en temps réel (la Borne est offline) ; il l'apprend par le heartbeat best effort ou au push. Donc :
- Édition **autorisée** en `draft`, `ready` et `loaded` (c'est ce qui permet la synchro automatique des questions jusqu'au jour J).
- Édition **refusée (409)** dès que le Hub connaît un statut ≥ `live` (heartbeat reçu ou push effectué).
- Si `updated_at > pulled_at`, l'UI affiche un bandeau **« Modifications non encore récupérées par la borne »** — le client sait que ses changements ne s'appliqueront que si la Borne re-pull avant l'événement. Au push, l'état de la Borne écrase de toute façon celui du Hub (la Borne est maître).

**Galerie** (`routes/gallery.js`) — user + owner, disponible après push :
- `GET /api/events/:id/videos` — JOIN `derived` (miniature, durée).
- `GET /api/events/:id/videos/export/csv` — avant les routes `/:videoId`.
- `GET /api/events/:id/videos/:videoId/file` — Range-aware ; `/download` ; `/thumbnail`.
- `GET /api/events/:id/archive` — télécharge le **ZIP de toutes les vidéos** généré par le job `archive` (Range-aware, donc reprenable par le navigateur). `202 { pending: true }` si le job n'est pas encore terminé.
- `DELETE /api/events/:id/videos/:videoId` — invalide l'archive (ré-enfile un job `archive`).

**Super-admin** (`routes/admin.js`) — rôle `admin` uniquement (l'opérateur ; les clients n'y ont pas accès) :
- `POST /api/admin/boxes` `{ name }` → génère token (32 octets hex), stocke `sha256(token)`, **retourne le token en clair une seule fois**.
- `GET /api/admin/boxes`, `DELETE /api/admin/boxes/:id`.
- `GET /api/admin/overview` — vue d'ensemble : tous les événements (tous clients), espace disque consommé par événement (`du` sur `events/<id>/`), disque libre du volume, jobs `failed` récents, bornes et leur `last_seen_at`.

**Synchro** (`routes/sync.js`) — `requireBox` (header `X-Box-Token`) ; chaque appel met à jour `boxes.last_seen_at` et écrit `sync_log` :
- `GET /api/sync/assigned` — événements `status IN ('ready','loaded')` assignés à cette borne : `[{ id, name, event_date, status, updated_at }]`.
- `GET /api/sync/events/:id/bundle` — `{ event: {…}, questions: […] }`. Passe `ready→loaded`, set `pulled_at`.
- `POST /api/sync/events/:id/status` `{ status: 'live'|'closed' }` — **heartbeat best effort** envoyé par la Borne quand elle est online : met à jour le statut du registre (transitions avant uniquement, jamais de retour en arrière) pour que le Hub gèle l'édition et informe le client. Le Hub ne doit jamais dépendre de cet appel pour fonctionner.
- `POST /api/sync/events/:id/manifest` — body `{ files: [{ video_id, filename, size, checksum }], db: { size, checksum } }`. Réponse : `{ missing: [video_id…] }` (ceux non encore reçus ou de checksum différent) → **c'est ce qui rend le push reprenable et idempotent**.
- `PUT /api/sync/events/:id/files/:videoId` — upload multipart d'UN fichier ; le Hub recalcule le sha256, 422 si mismatch (la Borne retentera).
- `PUT /api/sync/events/:id/db` — upload du `db.sqlite` final (après `wal_checkpoint`, voir §11). **Le Hub ferme d'abord le handle de l'`eventStore` (cache LRU) avant d'écraser le fichier** — écraser une base ouverte = corruption.
- `POST /api/sync/events/:id/finalize` — vérifie que tout le manifest est reçu, passe en `pushed`, set `pushed_at`, **enfile les jobs** (`probe` + `thumbnail` par vidéo + un job `archive` pour l'événement). Quand tous les jobs sont `done` → le worker passe l'événement en `processed`.

### Côté Borne, `sync/push.js` (algorithme)

0. Précondition : événement `closed` (l'API refuse sinon, voir §6).
1. `wal_checkpoint(TRUNCATE)` sur la BD événement, puis sha256 de chaque vidéo (réutiliser `videos.checksum`) et du `db.sqlite`.
2. `POST manifest` → liste `missing`.
3. Pour chaque manquant : upload avec **retry backoff exponentiel** `min(2000·2^(n-1), 30000)` ms, 5 essais ; marquer `push_state.uploaded_at`.
4. Upload du `db.sqlite`, puis `finalize`.
5. Statut local `pushed`, `pushed_at`. En cas d'interruption : relancer le push refait 1→4, le manifest dédoublonne.

---

## 8. Frontend Borne — kiosque invité

**Machine à états de `GuestPage.jsx`** : `start → name → questions → recap → done`.

- Au montage : `GET /api/event` puis `GET /api/questions` (états loading / erreur / vide). Si l'événement est `closed` : écran « L'événement est terminé », aucune nouvelle session.
- **Timeout d'inactivité** (kiosque partagé — un invité parti ne doit pas bloquer le suivant) : après `idle_timeout` secondes (configurable par événement, défaut 120) sans interaction tactile, **hors enregistrement ou upload en cours**, modale « Tu es toujours là ? » pendant 30 s, puis retour à l'accueil. La session abandonnée reste en base ; ses vidéos déjà envoyées sont conservées.
- **Reprise après crash/reload** : `{ session_id, guest_name, questionIndex }` persisté en `sessionStorage` à chaque étape ; au rechargement avec une session non complétée, proposer « Reprendre la session de {prénom} ? » / « Recommencer ». Nettoyé à la complétion et au timeout d'inactivité.
- `StartScreen` : intro brandée (nom de l'événement), bouton « Commencer ».
- `NameInput` : prénom (« Comment tu t'appelles ? ») + **bloc consentement RGPD** : le `consent_text` de l'événement (scrollable si long) et une **case à cocher** « J'accepte que mes vidéos soient enregistrées et transmises à l'organisateur » — case large et tactile (≥ 44 px), **non pré-cochée**, le bouton « Continuer » reste désactivé tant qu'elle n'est pas cochée. `POST /sessions` avec `consent: true`. Bouton retour accueil.
- **`questions`** : `RecordingScreen` keyé par `questionIndex` (remount à chaque question) + **`QuestionNav`** : flèches ◀ ▶ et pastilles d'état (●répondu / ○non répondu) alimentées par `GET /sessions/:id/answers`. On peut passer une question et y revenir.
- `RecordingScreen` — sous-états : `answered | intro → countdown → recording → preview → uploading`. Barre de progression globale + « Question N sur M », texte de la question affiché.
  - `answered` : si la question a déjà une réponse, lecture de la vidéo enregistrée (`GET /sessions/:sid/videos/:qid/file`, `controls`, `playsInline`) + boutons « Refaire cette réponse » (→ `intro`) et « Garder » (→ question suivante).
  - `intro` : aperçu caméra miroir (`transform: scaleX(-1)`), « Durée max : {n}s », bouton rouge « ● Commencer » (désactivé tant que la caméra n'est pas prête).
  - `countdown` : chiffre pulsant (`question.countdown` s) puis démarrage auto.
  - `recording` : REC clignotant, timer `m:ss`, barre de progression, bouton « ■ Stop » ; auto-stop à `max_duration`.
  - `preview` : lecture du blob local ; « Recommencer » / « Parfait ✓ ».
  - `uploading` : **vraie barre de progression** — l'upload utilise `XMLHttpRequest` (et non `fetch`, qui n'expose pas `upload.onprogress`) pour afficher le pourcentage réel envoyé ; **retry 5× backoff exponentiel** `min(2000·2^(n-1), 30000)` ms ; en échec final : « Réessayer l'upload » / « Recommencer ». Le fichier envoyé est un `File` nommé `recording.<mp4|webm>` construit depuis le blob + mime, avec les champs `session_id/question_id/question_text/recorded_at`.
- `RecapScreen` : liste des questions avec état ; toucher une ligne ramène dessus ; bouton « J'ai terminé ✓ » → `PUT /sessions/:id/complete`.
- `ThankYouScreen` : message + **auto-retour à l'accueil après 15 s** + bouton manuel.
- Nettoyage du flux caméra au démontage de chaque écran qui l'utilise.

**`hooks/useMediaRecorder.js`** — gère caméra + cycle d'enregistrement :
- États `idle → requesting → ready → recording → stopped` ; `getUserMedia({ video:{ facingMode:'user', width:{ideal:1280}, height:{ideal:720} }, audio:true })` ; messages d'erreur dédiés `NotAllowedError`/`NotFoundError`.
- Détection MIME : Safari/iOS → `video/mp4;codecs=avc1,mp4a.40.2` puis `video/mp4` ; sinon `video/webm;codecs=vp9,opus` → vp8 → webm (probe `MediaRecorder.isTypeSupported`).
- Options : `videoBitsPerSecond: 500_000`, `audioBitsPerSecond: 96_000`, `recorder.start(1000)` (chunks de 1 s pour la robustesse). Collecte des chunks ; au stop, construire un `Blob` + object URL. Auto-stop par timer 1 s quand `duration >= maxDuration`. `attachPreview` branche le flux live sur un `<video>` (muted, autoplay, **playsInline**). Expose `requestPermission/startRecording/stopRecording/resetRecording/cleanup` + `status/error/duration/blob/blobUrl/mimeType`.

**Admin Borne** (`/admin`) : login → layout à onglets **Événement | Préflight | Questions | Vidéos | Synchro**, avec dans l'en-tête un **indicateur d'espace disque permanent** (rouge sous 10 Go). C'est l'interface de l'**opérateur** — le client n'y a jamais accès (mot de passe distinct de tout compte Hub).
- `EventPanel` : événement actif, création locale, activation, et bouton **« Clôturer l'événement »** (confirmation par saisie du nom ; le kiosque passe en « événement terminé »).
- `PreflightPanel` : checklist pré-événement verte/rouge — config chargée (`pulled_at` + nombre de questions), **test caméra** (lance `getUserMedia` depuis l'appareil courant), disque OK, horloge OK (`GET /api/preflight?client_time=`).
- `QuestionManager` : formulaire ajout/édition (texte, `max_duration` 10–300, `countdown` 0–10) + table ; **drag-to-reorder** en HTML5 natif (refs `dragItem`/`dragOver`), mise à jour optimiste puis `PUT /questions/reorder/batch` ; suppression avec confirmation (avertir que les vidéos déjà enregistrées gardent leur texte).
- `VideoList` : barre d'outils avec filtre par session (`<select>`), Export CSV, Rafraîchir ; grille de cartes (badge invité, taille KB/MB, question, date) avec actions Lire / Télécharger / Supprimer ; **lecture dans une modal** `<video>` branchée sur la route `/file` Range-aware (scrubbing fluide).
- `SyncPanel` : statut online/offline, dernier pull, bouton « PUSH vers le Hub » avec barre de progression `done/total`, purge avec confirmation par saisie du nom.

**API client** (`api/client.js`) : wrapper `fetch` fin — lit `admin_token` dans `localStorage`, attache l'en-tête `Authorization` ; les `FormData` passent sans content-type JSON ; les URLs de stream/download/CSV ajoutent `?token=` pour que le navigateur puisse les charger directement (`videoStreamUrl(id)`, `videoDownloadUrl(id)`). L'upload invité utilise `XMLHttpRequest` (progression).

**Styles** : un seul `app.css` ; thème invité sombre, haut contraste, plein écran fixe, cibles tactiles ≥ 80 px, sélection de texte désactivée hors inputs ; thème admin clair. Palette en CSS custom properties. `index.html` : viewport `maximum-scale=1, user-scalable=no`, `apple-mobile-web-app-capable` (kiosque plein écran), favicon emoji 🎬 inline SVG.

---

## 9. Frontend Hub

- `LoginPage` → `POST /auth/login`, token dans `localStorage` (`hub_token`).
- `EventsPage` : tableau (nom, date, statut avec badge coloré, borne assignée), bouton « Nouvel événement ».
- `EventDetailPage` — onglets :
  - **Questions** : `QuestionEditor` = le `QuestionManager` de la Borne (composant dupliqué mais même logique) + un champ **« Texte de consentement RGPD »** (textarea, pré-rempli avec le texte générique par défaut) et le réglage du timeout d'inactivité. Bandeau « lecture seule — événement en cours sur la borne » si le Hub connaît un statut ≥ `live` ; bandeau « **Modifications non encore récupérées par la borne** » si `updated_at > pulled_at` (voir la règle de gel, §7).
  - **Synchro** : timeline du statut (`draft → … → processed`), dates `pulled_at/pushed_at/processed_at`, assignation de borne, état des jobs (`x/y terminés`), `sync_log` récent.
  - **Galerie** (statut ≥ `pushed`) : grille de cartes avec **miniatures** (`derived`), durée, invité, question ; modal `<video>` range-aware ; download unitaire ; bouton **« Tout télécharger (ZIP) »** (grisé avec « préparation en cours… » tant que le job `archive` n'est pas terminé) ; export CSV ; suppression unitaire ; bouton « Supprimer l'événement (RGPD) » avec confirmation par saisie du nom.
- `AdminPage` (rôle `admin` uniquement) : vue d'ensemble super-admin — tous les événements avec leur taille disque, disque libre du volume, jobs en erreur, bornes (`last_seen_at`, création avec modal affichant le token une seule fois + bouton copier, révocation).

---

## 10. Docker / Nginx / TLS / Environnement

### docker-compose.borne.yml (déployé sur le Raspberry, arm64)
- `backend` : build `apps/borne/server`, env `ADMIN_PASSWORD JWT_SECRET HUB_URL BOX_TOKEN DATA_DIR=/app/data PORT=3001`, volume `borne_data:/app/data`, réseau interne seulement, `restart: unless-stopped`.
- `frontend` : build `apps/borne/web` (multi-stage Vite → `nginx:alpine` + openssl), ports `80:80` `443:443`, `depends_on: backend`, volume `borne_certs:/etc/nginx/certs`.
- `borne-entrypoint.sh` : génère un cert auto-signé si absent (`openssl req -x509 -nodes -days 730 -newkey rsa:2048`, CN `borne.local`) puis `nginx -g 'daemon off;'`.
- `borne-nginx.conf` : `client_max_body_size 600M` ; 80 → redirect 443 ; `/api/` → `proxy_pass http://backend:3001` avec headers forwardés, timeouts read/send **600s**, `proxy_request_buffering off` ; `/` → SPA fallback `try_files $uri $uri/ /index.html`.

### docker-compose.hub.yml (VPS)
- `backend` : build `apps/hub/server`, env `JWT_SECRET DATA_DIR=/app/data ALLOW_REGISTER PORT=3001`, volume `hub_data:/app/data`.
- `worker` : **même image** que backend, `command: node src/worker/index.js`, même volume. L'image installe `ffmpeg` (`apk add ffmpeg`).
- `frontend` : nginx + build Vite, ports `80/443`, certs Let's Encrypt montés `/etc/letsencrypt:ro`. Mêmes réglages proxy que la Borne (`client_max_body_size 600M`, timeouts 600s, buffering off — le push passe par là).

### Dockerfile backend (les deux) : `node:20-alpine`, `apk add python3 make g++` (build natif better-sqlite3 — fonctionne en arm64), `npm ci --omit=dev` au niveau workspace, copie de `packages/core` + `src`, `CMD node src/index.js`.

### Variables d'environnement

| Variable | App | Défaut | Rôle |
|---|---|---|---|
| `ADMIN_PASSWORD` | Borne | `admin123` | Admin local |
| `JWT_SECRET` | Borne+Hub | `change-me` | Signature JWT |
| `DATA_DIR` | Borne+Hub | `/app/data` | Racine stockage |
| `PORT` | Borne+Hub | `3001` | Port backend |
| `HUB_URL` | Borne | _(vide = mode autonome)_ | URL du Hub |
| `BOX_TOKEN` | Borne | _(vide)_ | Token d'appairage |
| `ALLOW_REGISTER` | Hub | `false` | Ouvrir l'inscription |
| `PULL_INTERVAL_MS` | Borne | `300000` | Période du pull auto |

> **TLS / iPad** : iOS Safari exige HTTPS pour la caméra. Faire confiance au certificat auto-signé sur l'iPad (Réglages → Général → VPN et gestion de l'appareil) ou fournir un vrai cert. Utiliser Accès Guidé + « Ajouter à l'écran d'accueil » pour le mode kiosque.

---

## 11. Pièges d'implémentation (à respecter)

1. Déclarer `GET …/export/csv` **avant** les routes `/:id` (sinon Express matche `export` comme id).
2. `requireAdmin`/`requireUser` doivent accepter `?token=` — `<video src>`, downloads et CSV ne peuvent pas envoyer de header.
3. Les **Range requests** sur les routes `/file` sont ce qui rend le scrubbing possible — ne pas les sauter.
4. Safari : codecs mp4 pour MediaRecorder + mimetype d'upload parfois générique → fileFilter tolérant (extension vidéo + mime générique).
5. Tous les `<video>` avec `playsInline`, sinon iOS force le plein écran.
6. `question_text` dénormalisé dans `videos` : supprimer une question n'orpheline pas les enregistrements.
7. Upload avec retry + backoff exponentiel : indispensable sur le Wi-Fi d'événement.
8. **`wal_checkpoint(TRUNCATE)` avant de checksummer/transférer un `db.sqlite`** — sinon le fichier est incomplet (les écritures vivent dans le `-wal`).
9. Remplacement de vidéo : `DELETE`+`INSERT` en transaction, `unlink` de l'ancien fichier **après** commit seulement.
10. Le pull auto ne doit **jamais** écrire si le statut local n'est pas `loaded` — vérifier le statut au moment d'appliquer, pas au moment de lancer la requête.
11. `eventStore` du Hub : cache LRU des handles SQLite (~10 ouverts max), et **fermer le handle avant toute purge `rm -rf` ET avant d'écraser un `db.sqlite` reçu au push** — écrire par-dessus une base ouverte = corruption.
12. Le push est repris via le manifest (`missing`) — toujours recalculer côté Hub, ne jamais faire confiance au `push_state` local seul.
13. Le token de borne n'est stocké qu'en hash ; toute réponse 401 du Hub sur la synchro doit s'afficher clairement dans `SyncPanel` (token révoqué ?).
14. Raspberry : monter `DATA_DIR` sur **SSD USB**, pas sur la carte SD (usure + corruption = perte de souvenirs irremplaçables).
15. Tester chaque phase sur **iPad Safari réel** (caméra, HTTPS auto-signé à faire confiance dans Réglages → Général → VPN et gestion de l'appareil, Range, retry) — pas seulement Chrome desktop.
16. **Le Raspberry n'a pas d'horloge RTC** : sans Internet, l'heure dérive ou repart du dernier arrêt — or `consent_at` est la **preuve légale RGPD** et tous les timestamps en dépendent. Matériel requis : module **RTC DS3231** (~5 €, I2C) + chrony ; le Préflight vérifie l'écart d'horloge avec l'appareil admin.
17. Le ZIP d'archive se génère **sans compression** (mode store) : la vidéo est déjà compressée, recompresser brûle du CPU sur le VPS pour 0 % de gain.
18. Progression d'upload côté kiosque : `fetch` n'expose pas la progression d'envoi — utiliser `XMLHttpRequest` (`xhr.upload.onprogress`).

---

## 12. Plan de développement (phases avec critère de fin)

| Phase | Contenu | Terminé quand |
|---|---|---|
| **0 — Socle** | Monorepo npm workspaces, `@kapsule/core` (schémas + `createEventDb` + checksum) **avec ses tests unitaires (`node:test`)**, squelettes Express des deux serveurs, docker-compose ×2, `.env.example` | `docker compose up` sur chaque fichier → `/api/health` répond ; `npm test` passe |
| **1 — Borne autonome** | Registre local, création d'événement local, **clôture**, routes questions/sessions/vidéos (avec remplacement), kiosque complet (navigation + réenregistrement + récap + **timeout d'inactivité + reprise de session + barre de progression d'upload**), admin local avec **indicateur disque** et **Préflight** (sans SyncPanel), HTTPS auto-signé | Un événement entier se déroule sur iPad Safari **sans aucun Hub** ; test arm64 sur le Raspberry réel (avec RTC installé) |
| **2 — Hub minimal** | Registre Hub, `create-admin`, auth argon2/JWT **+ rate limiting**, CRUD événements + questions avec cloisonnement `requireOwner`, frontend (login, events, éditeur questions), règle de gel d'édition (§7) | Deux comptes ne voient que leurs événements respectifs ; questions éditables en ligne |
| **3 — Synchro** | `boxes` + tokens, `GET assigned` + `bundle` + pull (auto et manuel) avec règle `loaded`, **heartbeat live/closed**, push complet (manifest/upload/db/finalize, exige `closed`) avec reprise, `SyncPanel`, onglet Synchro du Hub (avec bandeau « modifs non récupérées »), purge Borne, **tests d'intégration du protocole** (pull → uploads → coupure simulée → reprise → finalize, via supertest) | Scénario manuel complet OK **et les tests d'intégration passent** (reprise incluse) |
| **4 — Traitement & galerie** | Worker (boucle jobs), `probe` + `thumbnail` + **`archive` (ZIP)** (ffmpeg/archiver), passage `processed`, galerie Hub (miniatures, lecture range, download, **« Tout télécharger »**, CSV), suppression RGPD côté Hub, **page super-admin** (overview stockage/jobs/bornes) | Après un push, le client voit ses vidéos en ligne avec miniatures et télécharge le ZIP complet ; supprimer l'événement efface tout |
| **5 — Évolutions** | Machine de capture dédiée (appareil photo), job `chromakey` (fond vert), portail invités, mode point d'accès Wi-Fi de la Borne (hostapd) | Au fil de l'eau |

**Ordre interne conseillé pour chaque phase** : schéma BD → routes backend → client API frontend → écrans → CSS → test iPad.

---

## 13. Décisions ouvertes (à trancher, n'empêchent pas de démarrer)

- Wi-Fi de l'événement : routeur dédié vs la Borne en point d'accès (phase 5).
- Politique de rétention exacte sur la Borne après push (manuel pour l'instant ; échéance automatique plus tard ?).
- Sauvegarde du Hub lui-même (snapshot VPS, rclone vers stockage froid ?) — hors périmètre code, à documenter dans le README.
- **JWT en `?token=` sur le Hub public** : le token peut finir dans les logs Nginx du VPS — risque accepté pour l'instant ; mitigation possible plus tard (token média court de 5 min pour les URLs `<video src>`/download, ou `log_format` sans query string).

### Pistes écartées pour l'instant (réévaluables)

- Filtres de la galerie Hub par invité / par question.
- Politique de retry formalisée du worker (max attempts, bouton « Relancer », reprise des jobs `running` orphelins au démarrage).
- Verrouillage de `QuestionNav` pendant `recording`/`uploading`.
- `ON DELETE SET NULL` explicite sur `events.box_id` à la suppression d'une borne.
