# PROJET : "Kapsule" — Borne vidéo d'événements (Raspberry + VPS)

Ce document est la spécification de référence du projet. Il est conçu pour être donné tel quel à un agent IA (Claude) ou à un développeur : il décrit l'architecture, les fichiers, les schémas, les API et l'ordre de développement. Il est **auto-suffisant** — aucune connaissance externe n'est requise.

---

## 1. Vision produit

Un système de **borne d'enregistrement de messages vidéo pour événements** (mariages, anniversaires, capsules temporelles), en deux applications :

- **La Borne** (Raspberry Pi) : serveur local **100% offline** pendant l'événement. Un iPad en Safari sur le même Wi-Fi sert de kiosque : l'invité saisit son prénom puis répond à une séquence de questions en se filmant. Un admin local permet d'ajuster les questions sur place et de visionner les vidéos brutes immédiatement.
- **Le Hub** (VPS) : interface web où le **client** (l'organisateur ; à terme plusieurs clients avec des comptes séparés) prépare ses événements et ses questions, puis consulte ses vidéos après coup. Le Hub reçoit les vidéos, génère miniatures et métadonnées, et accueillera plus tard du traitement lourd (fond vert…).

**Cycle de vie** : le client configure sur le Hub → valide via la **borne preview** (conteneur d'essai, étape officielle) → marque l'événement prêt → la Borne **tire** (pull) la configuration → l'événement se déroule offline, **la Borne est maître** → de retour sur la fibre, on **pousse** (push, déclenchement manuel) vidéos + configuration finale vers le Hub → traitement → consultation → purge manuel.

**Contraintes structurantes :**
- Multi-événements, multi-clients **côté Hub** ; **une Borne (un Raspberry) n'a qu'un seul événement ACTIF à la fois** — mais, depuis la Phase B, une borne est une **machine persistante** (table `bornes`, §5.3) à laquelle le Hub peut assigner plusieurs événements dans le temps (table de jonction `borne_events`) : pas besoin de régénérer un token entre deux événements sur le même Raspberry, seulement de choisir (localement, ou via une commande Hub) lequel activer. Deux mécanismes d'appairage coexistent : le **token de borne** (`bornes.token_hash`) identifie la machine ; le **token d'événement** (`box_tokens`, inchangé depuis 6C) reste réservé aux bornes d'essai — un conteneur preview est provisionné pour un seul événement, sans notion de machine persistante.
- **RGPD : cloisonnement strict par événement — une base SQLite et un dossier de fichiers indépendants par événement.** Effacer un événement = supprimer son dossier.
- **RGPD : consentement explicite de l'invité** — case à cocher obligatoire avant tout enregistrement (écran du prénom), texte configurable par événement, acceptation **horodatée en base** (preuve de consentement).
- **La Borne doit fonctionner hors ligne pendant l'événement.** Une fois la configuration **tirée** (pull) depuis le Hub — ce qui nécessite Internet, à ce moment-là seulement — la Borne n'a plus besoin d'aucune connectivité pour dérouler l'événement (enregistrement, admin local, visionnage brut). C'est la contrainte structurante de l'architecture (§2, AVANT/PENDANT/APRÈS) : Internet uniquement avant (pull) et après (push), jamais pendant. Elle vaut pour **toute** Borne appairée — aucun mode « sans Hub du tout » n'est requis pour ça, ni n'existe dans le code (§11.29 : `POST /api/events`, la seule route qui aurait permis de créer un événement local sans jamais impliquer de Hub, a été retirée en phase 6E et jamais restaurée).
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
preview → ready → loaded → live → closed → pushed → processed → waiting
 hub       hub    pull    1ʳᵉ session  borne   push OK   worker    manuel
```

États Hub uniquement : `preview`, `ready`, `processed`, `waiting`.
États Borne : `loaded`, `live`, `closed`, `pushed`.

- `preview` : **statut initial** d'un événement à sa création. Le client configure (questions, consent, timeout…) et teste via la borne d'essai (conteneur `docker-compose.preview.yml`), auto-provisionnée dès la création (voir §2 état désiré). Édition libre. La borne d'essai associée (token `is_preview=1`) peut puller et recevoir des sessions de test — données jetables. Transition `preview → ready` (bouton « Valider la configuration »). Il n'existe plus d'état `draft` antérieur : un événement naît directement en `preview`.
  - **État désiré de la borne preview** : indépendant du statut de l'événement, `events.preview_desired` (`running`/`stopped`) mémorise si le conteneur d'essai *doit* tourner. Les boutons « Démarrer / Éteindre » du Hub le basculent ; il passe `running` à la création (provision auto réussie). Au démarrage du serveur ou via `make vps-up`, le script `reconcile-previews` relance uniquement les previews `running` — une borne éteinte volontairement n'est jamais ressuscitée. Distinguer cet **état désiré** (en base) de l'**état réel** du conteneur (Docker) est ce qui rend la réconciliation correcte après un reboot.
- `ready` : configuration gelée. Le Hub peut générer un token de borne réelle. Seule transition possible : `ready → loaded` (au premier pull de la borne réelle).
- `loaded` → `live` → `closed` → `pushed` : sur la Borne (voir ci-dessous).
- `processed` : worker a terminé ses jobs (miniatures, ZIP). Vidéos consultables par le client.
- `waiting` : état terminal d'attente. Les données sont disponibles. La **suppression** d'un événement reste **manuelle** (pas de RGPD automatique pendant la période de test) et se fait via `DELETE /api/events/:id` (voir §7) : suppression *totale* — dossier `events/<id>/` + conteneur preview + ligne du registre. Réservée aux superusers.

**Règle anti-conflit (à respecter scrupuleusement)** : le pull n'opère que tant que l'événement local est en `loaded`. Dès la première session invitée (`live`), plus aucun pull ; au push, l'état de la Borne **écrase** celui du Hub pour cet événement (tracé dans `sync_log`). Le Hub connaît le statut `live`/`closed` uniquement au moment du push — entre temps, il gèle l'édition dès `loaded` (voir §7).

**Auth wall preview** : le mécanisme est le rôle `general` dans `event_users` (voir §7D). Si au moins un utilisateur Hub avec le rôle `general` est assigné à l'événement et inclus dans le bundle, le kiosque de la borne d'essai affiche un login (email + mot de passe) avant d'accéder au parcours invité. Ce compte `general` est typiquement partagé entre toutes les personnes autorisées à tester. Le kiosque de la borne réelle (physique, Wi-Fi local) n'a jamais d'auth wall.

---

## 3. Stack technique (choix figés)

**Commun**
- Node 20 (alpine), modules **ESM** (`"type": "module"` partout).
- Express 4, `better-sqlite3` (synchrone), `multer` (upload disque), `jsonwebtoken`, `uuid` v4. Pas de package `cors` : frontend et API sont servis sur la même origine via Nginx, CORS n'entre jamais en jeu (le réintroduire avec une liste d'origines précise seulement si un vrai besoin cross-origin apparaît).
- Tests : `node:test` (runner natif) + `supertest` — voir §12, le protocole de synchro est couvert par des tests d'intégration.
- Monorepo **npm workspaces** (pas de turborepo/nx — rester simple).

**Frontends** : React 18 + Vite 5 (`@vitejs/plugin-react`), `react-router-dom` v6, CSS pur (un stylesheet par app, custom properties, pas de framework UI). Capture via l'API native `MediaRecorder` (pas de bibliothèque d'enregistrement).

**Hub en plus** : `argon2` (hash mots de passe), `express-rate-limit` (anti brute force sur login, sessions et uploads), `ffmpeg`/`ffprobe` appelés via `child_process.spawn` (pas de wrapper npm), `archiver` (génération des ZIP d'export, mode store), `nodemailer` (envoi SMTP des emails : lien de définition de mot de passe, notifications).

**Borne preview en plus** : `express-rate-limit` (la borne d'essai est Internet-facing : même protection que le Hub sur les sessions et uploads).

**Infra** : Docker + docker-compose. Borne = images **arm64** (`node:20-alpine` multi-arch). Nginx alpine. OpenSSL pour le cert auto-signé de la Borne ; Let's Encrypt (certbot) ou cert fourni pour le Hub.

---

## 4. Arborescence du monorepo

```
kapsule/
├── package.json                      # workspaces: ["packages/*", "apps/*/server", "apps/*/web"]
├── .env.example-hub                  # gabarit .env pour le VPS (Hub)
├── .env.example-rasp                 # gabarit .env pour le Raspberry Pi (Borne), HUB_URL prérempli
├── docker-compose.yml                # dev local (services dev:borne, dev:hub)
├── docker-compose.borne.yml          # déploiement Borne (production Raspberry)
├── docker-compose.hub.yml            # déploiement Hub (production VPS)
├── docker-compose.preview.yml        # borne d'essai manuelle (BOX_TOKEN_PREVIEW + HUB_URL)
├── Makefile                          # raccourcis VPS : vps-build/up/down, hub-reset (voir §10)
├── PROJET.md                         # ce document
├── packages/
│   ├── core/                         # @kapsule/core — tout ce qui est partagé, sans React
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.js              # ré-exporte tout
│   │       ├── constants.js          # EVENT_STATUS, JOB_TYPES, LIMITS (500 MB, durées…)
│   │       ├── eventDbSchema.js      # SQL de la BD "événement" + createEventDb(filePath)
│   │       ├── validate.js           # validateQuestion(), validateGuestName(), assertStatus()
│   │       ├── checksum.js           # sha256File(path) → Promise<hex> (stream, pas de readFile)
│   │       └── design.js             # DESIGN_COLOR_KEYS/RADIUS/FONTS/LAYOUTS, validateDesign()
│   │                                  # (fonction pure, §9bis) — partagé Hub + Borne
│   └── guest-ui/                     # @kapsule/guest-ui — écrans React du parcours invité
│       ├── package.json              # (chantier designUI) partagés Borne (kiosque réel) et
│       ├── test/design.test.js       # aperçu live Hub — react/react-dom en peerDependency ;
│       └── src/                      # dépendances réseau/caméra injectées par props, jamais
│           ├── index.js              # importées en dur (mêmes composants prod + aperçu).
│           ├── design.js             # designToVars/MANAGED_DESIGN_VARS/imageWidthStyle (pur,
│           │                          # sans JSX — exporté séparément en "./design" pour
│           │                          # rester importable par node --test sans traverser le
│           │                          # barrel JSX)
│           ├── useMediaRecorder.js   # hook caméra (getUserMedia/MediaRecorder)
│           ├── screens/              # StartScreen, NameInput, QuestionNav, QuestionSheet,
│           │                          # RecordingScreen (prop `showcase`), RecapScreen,
│           │                          # ThankYouScreen
│           └── guest.css             # CSS des écrans, toutes règles préfixées .kapsule-guest
│                                      # (scope anti-collision avec le CSS du Hub/admin borne)
├── apps/
│   ├── borne/
│   │   ├── server/
│   │   │   ├── Dockerfile
│   │   │   ├── package.json
│   │   │   └── src/
│   │   │       ├── index.js          # bootstrap Express, montage des routes, error handler
│   │   │       ├── config.js         # lecture env + valeurs par défaut
│   │   │       ├── registry.js       # registre local (local_events, push_state, borne_settings — Phase B)
│   │   │       ├── borneIdentity.js  # Phase B : resolveBorneIdentity() — sème/résout le token de
│   │   │       │                     # borne physique persistant (borne_settings, prime sur l'env)
│   │   │       ├── eventDb.js        # getActiveEventDb() — ouvre/cache la BD de l'événement actif
│   │   │       ├── initLog.js        # Phase C : journal d'init en mémoire (logInit/getInitLog),
│   │   │       │                     # exposé sans auth par GET /api/sync/pairing-status
│   │   │       ├── middleware/auth.js
│   │   │       ├── routes/
│   │   │       │   ├── events.js     # admin : gestion des événements locaux, activation, clôture
│   │   │       │   ├── questions.js  # CRUD + reorder (sur l'événement actif)
│   │   │       │   ├── sessions.js   # sessions invités (rate-limit, cloisonnement event)
│   │   │       │   ├── videos.js     # upload/replace (rate-limit), stream (Range), download, csv, delete
│   │   │       │   └── sync.js       # admin : état synchro, déclenchement pull/push, purge, rotation token
│   │   │       └── sync/
│   │   │           ├── hubClient.js       # fetch vers le Hub + retry/backoff + borneLog. X-Box-Token =
│   │   │           │                      # config.borneToken (borne physique) sinon config.boxToken (preview)
│   │   │           ├── pull.js            # pullMyEvent() : pull one-shot (preview) ; pullMyEvents()
│   │   │           │                      # Phase B (borne physique, plusieurs événements) ; pullEvent(id) : écrit bundle
│   │   │           ├── push.js            # pushEvent(eventId) + pushConfig(eventId) — manifest, uploads, finalize, reprise
│   │   │           ├── commandExecutor.js # Phase B : runCommand() — exécute pull/activate_event/
│   │   │           │                      # close_event/purge_event reçues au heartbeat
│   │   │           └── heartbeat.js       # Phase B : beat()/startHeartbeat() — battement périodique
│   │   │                                  # (PULL_INTERVAL_MS), télémétrie + exécution des commandes
│   │   └── web/
│   │       ├── Dockerfile.preview    # image borne preview (SPA + nginx, arm64/amd64)
│   │       ├── package.json, vite.config.js, index.html
│   │       └── src/
│   │           ├── main.jsx, App.jsx # routes : "/" → GuestPage (dans <div class="kapsule-guest">
│   │           │                      # pour le scope CSS partagé), "/admin" → AdminPage (événement
│   │           │                      # actif), "/borne" → BornePage (Phase B, console machine —
│   │           │                      # remplace l'ancien "/admin/tech")
│   │           ├── api/client.js
│   │           ├── utils/design.js    # applyDesign() : pose les tokens d'un design sur <html>
│   │           │                      # (whitelist DESIGN_COLOR_KEYS, §9bis) — fine couche
│   │           │                      # au-dessus de designToVars() (@kapsule/guest-ui)
│   │           ├── pages/GuestPage.jsx # importe les 7 écrans du parcours invité depuis
│   │           │                      # @kapsule/guest-ui (chantier designUI) — plus aucun
│   │           │                      # composant guest ni hook caméra dans cette app
│   │           ├── pages/AdminPage.jsx # "/admin" — événement ACTIF uniquement : Questions, Vidéos, Design
│   │           ├── pages/BornePage.jsx # Phase B, "/borne" — console machine : Identité, Événements,
│   │           │                      # Machine, Synchro (ex TechPage.jsx)
│   │           ├── components/admin/
│   │           │   ├── AdminLogin.jsx, AdminLayout.jsx
│   │           │   ├── OnboardingScreen.jsx # Phase C : écran /borne sans auth tant qu'aucun
│   │           │   │                        # token n'est configuré (usePairingStatus)
│   │           │   ├── IdentityPanel.jsx    # Phase B : connexion Hub, token de borne masqué + rotation
│   │           │   ├── EventPanel.jsx       # tous les événements de la borne : activer, clôturer, purger
│   │           │   ├── PreflightPanel.jsx   # checklist (config, caméra, disque, horloge) + qualité/
│   │           │   │                        # orientation d'enregistrement (override local, Phase B)
│   │           │   ├── QuestionManager.jsx  # table + drag-reorder (HTML5 natif)
│   │           │   ├── VideoList.jsx        # grille, modal de lecture, download, delete
│   │           │   └── SyncPanel.jsx        # état pull/push, bouton PUSH, progression
│   │           └── styles/app.css           # thème sombre tactile invité / clair admin
│   └── hub/
│       ├── server/
│       │   ├── Dockerfile                   # sert aussi au worker (CMD différent)
│       │   ├── package.json
│       │   └── src/
│       │       ├── index.js, config.js
│       │       ├── registry.js              # users, box_tokens, events, event_users, jobs,
│       │       │                            # sync_log, event_versions, email_logs, bornes,
│       │       │                            # borne_events, borne_commands (Phase B),
│       │       │                            # schema_migrations + runMigrations() versionné
│       │       ├── eventStore.js            # openEventDb(eventId) avec cache LRU + closeEventDb()
│       │       ├── versioning.js            # saveVersion(), listVersions(), restoreVersion()
│       │       ├── eventConfig.js           # readSnapshot(), applyConfig() — lecture/écriture config événement
│       │       ├── middleware/auth.js       # requireUser (JWT), requireOwner(eventId), requireAdmin
│       │       ├── middleware/boxAuth.js    # requireBox : header X-Box-Token → sha256 → box_tokens
│       │       ├── routes/
│       │       │   ├── auth.js              # login/register/set-password/forgot-password
│       │       │   ├── events.js            # CRUD événements + transitions d'état + routes preview
│       │       │   │                        # (status/token : owner ; start/stop : superuser)
│       │       │   ├── questions.js         # CRUD questions (écrit dans la BD de l'événement)
│       │       │   ├── versions.js          # historique config : list, get, restore
│       │       │   ├── admin.js             # super-admin : comptes clients, tokens d'événement
│       │       │   │                        # (token affiché une fois), bornes physiques (Phase B —
│       │       │   │                        # CRUD, assignation d'événements, commandes), overview
│       │       │   ├── gallery.js           # vidéos : list, stream (Range), download, zip, csv
│       │       │   ├── designs.js           # CRUD designs, versions, duplication, promotion,
│       │       │   │                        # assets (§9bis) — monté sur /api/designs
│       │       │   └── sync.js              # endpoints appelés par la Borne (requireBox)
│       │       ├── preview/
│       │       │   └── provisioner.js       # DockerClient (typedef + dockerCli réel), slugFor(),
│       │       │                            # provisionPreview/startPreview/deprovisionPreview()
│       │       ├── email/                   # envoi d'emails (injecté via 3e arg de createApp)
│       │       │   ├── mailer.js            # createMailer(config) (nodemailer) + createNullMailer() no-op
│       │       │   ├── render.js            # renderTemplate(name,data) → { subject, text } ({{var}})
│       │       │   ├── url.js               # buildRegistrationUrl(req, token) — factorise l'URL /register
│       │       │   └── templates/           # registration.txt, password_reset.txt (1re ligne = Subject:)
│       │       ├── scripts/
│       │       │   ├── create-admin.js      # crée le 1er compte superuser (prompt email/mdp)
│       │       │   └── reconcile-previews.js# démarre les previews preview_desired='running' (boot/vps-up)
│       │       └── worker/
│       │           ├── index.js             # boucle : prend un job 'pending', l'exécute
│       │           ├── ffmpeg.js            # runFfprobe(file), makeThumbnail(file, out)
│       │           └── jobs/
│       │               ├── probe.js         # durée, résolution → table derived
│       │               ├── thumbnail.js     # JPEG à t=1s → events/<id>/derived/
│       │               └── archive.js       # ZIP de toutes les vidéos (mode store) → derived/
│       └── web/
│           ├── package.json, vite.config.js, index.html
│           ├── src/
│           │   ├── main.jsx, App.jsx
│           │   ├── api/
│           │   │   ├── client.js            # getToken/saveToken/getRole (ré-importe roles.js)
│           │   │   └── roles.js             # decodeJwtPayload + getRole (scalaire) — testable seul
│           │   ├── utils/
│           │   │   └── format.js            # formatBytes/formatDate/formatDuration/formatSize
│           │   ├── pages/LoginPage.jsx
│           │   ├── pages/EventsPage.jsx     # liste + création + statuts
│           │   ├── pages/EventDetailPage.jsx# onglets : Questions | Synchro | Galerie | Versions
│           │   ├── pages/AdminPage.jsx      # super-admin : bornes, stockage, jobs, tous les événements
│           │   ├── pages/DesignsPage.jsx     # bibliothèque de designs (§9bis) : liste, éditeur, historique
│           │   ├── components/QuestionEditor.jsx
│           │   ├── components/VideoGallery.jsx
│           │   ├── components/SyncStatus.jsx
│           │   ├── components/designs/
│           │   │   ├── DesignEditor.jsx      # formulaire tokens (couleurs/rayon/police/images)
│           │   │   ├── DesignPreview.jsx     # maquettes statiques, bascule mobile/iPad/desktop
│           │   │   └── VersionHistory.jsx    # historique + restauration
│           │   └── styles/app.css
│           └── test/
│               ├── roles.test.js            # node:test — decodeJwtPayload + getRole
│               └── format.test.js           # node:test — les 4 formateurs
└── docker/
    ├── borne-nginx.conf              # nginx borne (cert auto-signé, proxy /api/*)
    ├── borne-entrypoint.sh           # génère cert auto-signé CN=borne.local au démarrage
    ├── hub-nginx.conf                # nginx Hub interne (proxy /api/* → backend:3001)
    ├── hub-entrypoint.sh             # attend que le backend soit prêt avant de démarrer nginx
    ├── edge-nginx.conf.template      # edge TLS : Hub principal + bornes preview (essai-<slug>)
    │                                 # server_tokens off, HSTS, resolver Docker, proxy paresseux
    ├── edge-entrypoint.sh            # substitue EDGE_DOMAIN dans le template au démarrage
    ├── Dockerfile.edge               # image edge nginx (envsubst + template)
    ├── preview-nginx.conf            # nginx borne preview (proxy vers borne-preview-backend:3001)
    ├── preview-start.sh              # opérateur : provisionne + démarre une borne preview
    ├── preview-stop.sh               # opérateur : arrête + déprovisionne une borne preview
    ├── smoke-hub.sh                  # smoke tests Hub (curl health + auth + endpoint garde)
    ├── smoke-borne.sh                # smoke tests Borne (curl health + endpoint garde)
    ├── smoke-preview.sh              # smoke e2e borne preview (provision, auth wall, reconcile)
    └── smoke-common.sh               # helpers partagés (assert_status, wait_for)
```

---

## 5. Stockage et modèles de données

### 5.1 Disposition disque (identique Borne et Hub)

```
DATA_DIR/
├── registry.sqlite               # la SEULE base transverse — AUCUNE donnée invité dedans
├── events/
│   └── <event-id>/               # event-id = uuid v4, généré par le Hub
│       ├── db.sqlite             # questions, sessions, vidéos de CET événement
│       ├── videos/               # fichiers bruts (<uuid>.<ext>)
│       ├── derived/              # Hub uniquement : miniatures <video-id>.jpg + archive zip
│       └── design/               # assets du design appliqué à CET événement (§9bis) — copie
│                                  # snapshot, pas de lien vers designs/<designId>/
├── designs/                      # Hub uniquement — bibliothèque de designs (§9bis)
│   └── <design-id>/              # design-id = uuid v4 ; images du design (une par écran, §9bis)
└── previews/
    └── <slug>/                   # Hub uniquement — données de la borne d'essai (bind-mount dans le container)
        └── events/<event-id>/    # même structure que ci-dessus ; PII invité isolée ici (vidéos de test)
```

**RGPD** : `previews/<slug>/` contient des données invité (vidéos de test, sessions). Il est purgé automatiquement lors du `DELETE /api/events/:id` (via `deprovisionPreview`) et lors de la suppression du container preview. Ne jamais déplacer ces données vers `events/<id>/` ou le registre.

Toutes les bases : `PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;`. Schémas créés au démarrage avec `CREATE TABLE IF NOT EXISTS` (idempotent).

### 5.2 BD événement — `events/<id>/db.sqlite` (définie dans `@kapsule/core`)

```sql
event_meta (                       -- rend le dossier auto-portant (transféré tel quel au push)
  key TEXT PRIMARY KEY,            -- 'event_id', 'name', 'event_date', 'origin' ('hub'|'local'),
  value TEXT                       -- 'consent_text' (texte RGPD affiché à l'invité, défaut générique),
                                   -- 'idle_timeout' (secondes d'inactivité kiosque avant reset, défaut 120),
                                   -- 'design' (JSON du design appliqué, voir §9bis — clé optionnelle)
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

**Questions à la création** : aucune question n'est seedée par défaut. Un événement neuf démarre avec une table `questions` vide ; le client (Hub) ou le technicien (Borne) ajoute ses questions explicitement.

### 5.3 Registre du Hub — `registry.sqlite`

```sql
users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT,                           -- argon2id ; NULL tant que le client n'a pas posé son
                                                -- mot de passe via le lien d'enregistrement (compte créé par l'admin)
  name TEXT,
  role TEXT NOT NULL DEFAULT 'client' CHECK(role IN ('admin','client')),
  active INTEGER NOT NULL DEFAULT 1,            -- compte désactivable sans suppression (login refusé si 0)
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

registration_tokens (                          -- lien d'inscription / réinitialisation de mot de passe
  token_hash TEXT PRIMARY KEY,                 -- sha256(token) ; le token clair n'apparaît que dans l'URL (email + affichage)
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at DATETIME NOT NULL,                -- défaut +7 jours (création) ; +1 h pour un reset (forgot-password)
  used_at DATETIME,                            -- NULL = encore valable ; usage unique
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

email_logs (                                   -- journal des envois SMTP (lien mot de passe, notifications)
  id INTEGER PRIMARY KEY AUTOINCREMENT,        -- RGPD : emails de COMPTES (clients/admin) uniquement, jamais d'invité
  recipient_email TEXT NOT NULL,
  type TEXT NOT NULL,                          -- 'registration' | 'password_reset' | (futur)
  subject TEXT,
  status TEXT NOT NULL DEFAULT 'sent' CHECK(status IN ('sent','failed','skipped')),
  error TEXT,                                  -- message d'erreur si status='failed'
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

box_tokens (                                   -- token = ÉVÉNEMENT (§1) : un jeton initialise une Borne sur CET événement.
  id INTEGER PRIMARY KEY AUTOINCREMENT,        -- plusieurs tokens possibles par événement (ex. réel + essai).
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  token_hash TEXT UNIQUE NOT NULL,             -- sha256(token) — utilisé pour l'auth (X-Box-Token)
  token_clear TEXT UNIQUE NOT NULL,            -- token en clair — stocké pour permettre la ré-consultation et la copie (décision Phase 6E)
  label TEXT,                                  -- libellé libre (« Borne salle des fêtes », « Démo client »)
  location TEXT,                               -- lieu du Raspberry (les bornes sont à des endroits différents)
  is_preview INTEGER NOT NULL DEFAULT 0,       -- 1 = token d'essai : la Borne se met en mode démo (push interdit, quota, bandeau)
  last_seen_at DATETIME,                       -- mis à jour à chaque appel sync (remplace boxes.last_seen_at)
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

bornes (                                       -- Phase B : identité MACHINE persistante, distincte
  id TEXT PRIMARY KEY,                         -- de box_tokens (token = événement, réservé aux bornes
  name TEXT NOT NULL,                          -- d'essai — provisioner Hub inchangé).
  location TEXT,
  token_hash TEXT UNIQUE NOT NULL,
  token_clear TEXT UNIQUE NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,           -- désactivée = 401 sur toute route sync (sans supprimer)
  last_seen_at DATETIME,                       -- mis à jour UNIQUEMENT par le heartbeat (pas à chaque
                                                -- requête, sinon une télémétrie stale écraserait la vraie)
  agent_version TEXT, disk_free_bytes INTEGER, disk_total_bytes INTEGER,
  clock_skew_ms INTEGER,                       -- calculé côté HUB (Date.now() - borne_time_ms reçu) :
                                                -- la borne n'a pas d'horloge de référence fiable sans RTC (§11.16)
  active_event_id TEXT,                        -- dernier événement actif rapporté par le heartbeat
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

borne_events (                                 -- assignation N-N : une borne peut servir plusieurs
  borne_id TEXT NOT NULL REFERENCES bornes(id) ON DELETE CASCADE,   -- événements dans le temps ; un
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,   -- événement peut avoir plusieurs
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,                    -- bornes (table de jonction plutôt
  PRIMARY KEY (borne_id, event_id)                                  -- que events.borne_id).
);

borne_commands (                               -- file Hub → Borne : la borne n'est jamais joignable
  id INTEGER PRIMARY KEY AUTOINCREMENT,        -- directement (Wi-Fi événement, pas d'entrée réseau) —
  borne_id TEXT NOT NULL REFERENCES bornes(id) ON DELETE CASCADE,   -- elle dépose une commande, la
  type TEXT NOT NULL CHECK(type IN ('pull','activate_event','close_event','purge_event')),
  payload TEXT,                                -- JSON libre ({event_id, confirm?}, …)
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','done','failed')),
  result TEXT,                                 -- JSON libre — détail de l'échec/succès
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  claimed_at DATETIME, done_at DATETIME
);                                              -- borne la récupère et l'acquitte au heartbeat suivant.

events (
  id TEXT PRIMARY KEY,                         -- uuid
  owner_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,                          -- (plus de box_id : le lien Borne↔événement vit dans box_tokens, §1)
  event_date DATE,
  status TEXT NOT NULL DEFAULT 'preview'
    CHECK(status IN ('preview','ready','loaded','live','closed','pushed','processed','waiting')),
  preview_desired TEXT NOT NULL DEFAULT 'stopped', -- 'running'|'stopped' : état DÉSIRÉ de la borne preview,
                                                   -- réconcilié au boot/vps-up (≠ état réel du container, §3)
  pulled_at DATETIME, pushed_at DATETIME, processed_at DATETIME,
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

event_design_refs (                            -- trace de provenance « cet événement vient du design X »
  event_id  TEXT PRIMARY KEY                   -- un événement ↔ au plus un design source
            REFERENCES events(id) ON DELETE CASCADE,
  design_id TEXT NOT NULL,                      -- id du design de la bibliothèque (pas de FK : un design
                                                -- supprimé détache l'événement, il ne le casse pas)
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);                                             -- RGPD : deux ids, AUCUNE donnée invité. Sert à retrouver
                                               -- les événements 'preview' à rafraîchir quand un design est
                                               -- édité (§9bis « Rafraîchissement de la borne d'essai »).
```

**RGPD** : aucun nom d'invité, aucune vidéo, aucun contenu dans le registre — uniquement des comptes clients et des métadonnées d'orchestration. `registration_tokens` ne stocke que des hash ; `box_tokens` stocke à la fois le hash (auth) et le token en clair (consultation admin, cf. §11.13). Jamais de donnée invité dans le registre. La suppression d'un événement (`DELETE /api/events/:id`) est **totale** : conteneur preview déprovisionné, `rm -rf events/<id>`, puis suppression de la ligne `events` du registre. Le `ON DELETE CASCADE` (`box_tokens`, `event_users`, `event_versions`, `event_design_refs`) retire au passage tout ce qui dépend de l'événement ; `jobs` (sans FK) est vidé explicitement. Seule une ligne `sync_log` action `delete` subsiste comme trace d'audit — elle ne contient aucune donnée invité (juste l'id et le nom de l'événement).

### 5.4 Registre de la Borne — `registry.sqlite`

```sql
local_events (
  id TEXT PRIMARY KEY,                         -- même uuid que sur le Hub si origin='hub'
  name TEXT NOT NULL,
  origin TEXT NOT NULL CHECK(origin IN ('hub','local')),
  status TEXT NOT NULL DEFAULT 'loaded'
    CHECK(status IN ('loaded','live','closed','pushed','waiting')),
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

borne_settings (                               -- Phase B/C : secrets locaux de CETTE machine (plus
  key TEXT PRIMARY KEY,                        -- seulement l'identité). Clés : 'borne_token', 'hub_url'
  value TEXT                                   -- (seedées depuis BORNE_TOKEN/HUB_URL au premier
);                                              -- démarrage, ensuite la base fait foi — rotation sans
                                                -- redéployer/éditer le .env) ; 'jwt_secret' (généré par
                                                -- resolveJwtSecret() si absent, jamais affiché/saisi —
                                                -- signe les JWT locaux de cette machine) ; 'paired_at'
                                                -- (posé au premier pull réussi — verrou PERSISTÉ de
                                                -- POST /sync/onboarding/pair, §11.30 : à la différence
                                                -- d'un singleton en mémoire, survit à un redémarrage).
                                                -- Un `registry.sqlite` copié hors de la borne emporte
                                                -- donc de quoi forger des sessions admin localement.
```

---

## 6. API — Borne (`apps/borne/server`)

Base `/api`. JSON partout sauf flux de fichiers. Gestionnaire d'erreurs global → `{ error }` + status. `GET /api/health` → `{ ok: true, activeEvent: <id|null>, disk: { free_bytes, total_bytes } }` (via `fs.statfs` sur `DATA_DIR` — l'admin affiche une alerte rouge sous 10 Go).

**Auth admin local** (`middleware/auth.js`) — ni `admin_borne` ni `tech_borne` n'ont de compte
nominatif (Phase C) : les deux s'authentifient par un code à 6 chiffres partagé, régénérable
depuis le Hub, plus simple qu'un compte email/mdp pour un usage partagé sur place. **Plus de
TECH_PASSWORD (retiré, §11.30)** — un seul chemin :
- `POST /api/admin/login` `{ pin }` : comparé à `event_meta.tech_pin` de l'événement actif (rôle
  le plus élevé, essayé en premier) puis `event_meta.admin_pin` ; JWT `{ roles: ['tech_borne'] }`
  ou `{ roles: ['admin_borne'] }` selon le code saisi — jamais d'email dans le payload. 401 si
  `pin` absent du corps ou si aucun des deux ne correspond (y compris si aucun événement actif —
  pas de PIN à comparer).
- `requireAdmin = requireRole('admin_borne')` — accepte `admin_borne` **ou** `tech_borne` (sur-ensemble). Accepte `Authorization: Bearer` **ou** `?token=` (indispensable pour `<video src>`, downloads, CSV).
- `requireTech = requireRole('tech_borne')` — réservé préflight, synchro, clôture.
- **La fenêtre avant le premier PIN** (juste après appairage, avant que le premier pull ait
  rapatrié un événement) n'a **pas** de mot de passe de secours : elle est couverte directement par
  `POST /sync/onboarding/pair` (ci-dessous), qui émet lui-même une session `tech_borne` dès que le
  token borne est validé par le Hub — voir §11.30.
- `GET /api/sync/pairing-status` — **public, aucune auth** (Phase C), rate-limitée (60/min,
  `skipRateLimits` en test). Réponse à **deux formes** selon `hasToken` — pour ne jamais
  divulguer la topologie interne du Hub ni le journal d'init une fois la borne appairée
  (a fortiori sur une borne d'essai, Internet-facing) :
  - `hasToken: false` (avant appairage) → `{ hasToken, hubUrl, hasActiveEvent: false, lastPull: null, logs }` (`logs` = `initLog.js`, ~100 dernières lignes en mémoire), consommé par l'écran d'onboarding `/borne`.
  - `hasToken: true` (appairée) → `{ hasToken, hasActiveEvent }` uniquement.
- `POST /api/sync/onboarding/pair` — **public, aucune auth**, même rate-limit que ci-dessus,
  **refusée (404) en mode preview** (surface Internet-facing — pas de formulaire d'appairage
  public vers un Hub arbitraire, §11.21). Appairage **initial** depuis l'écran d'onboarding :
  `{ token, hubUrl? }` → **403** si le token actuel a déjà été **validé** — verrou **persisté**,
  OU de **trois** signaux (§11.30) : `borne_settings.paired_at !== null` (posé au premier pull
  réussi) **ou** au moins une ligne `local_events` (couvre une borne mise à niveau depuis une
  version antérieure à `paired_at`, dont les événements pullés avant cette colonne en sont une
  preuve tout aussi valable) **ou** `borne_settings.borne_token !== null` (couvre une borne seedée
  par `BORNE_TOKEN` en `.env` — persisté au boot par `resolveBorneIdentity()` **sans** round-trip
  Hub, donc sans jamais poser les deux signaux précédents ; ce chemin suppose déjà un accès
  SSH/`.env`, la correction s'y fait, pas par ce formulaire public). Jamais `getLastPull()` seul,
  un singleton en mémoire qui reviendrait à `null` après chaque redémarrage — une borne offline
  pendant l'événement, cas nominal §1, rouvrirait sinon cette route sans auth ; tant qu'aucun des
  trois signaux n'est vrai, un nouvel essai (token corrigé) écrase le précédent — un token mal
  recopié ne verrouille jamais la borne. La ligne `local_events` elle-même n'est écrite qu'**après**
  un pull complet et réussi (questions, `event_meta` **et** assets de design) — jamais avant, sinon
  un premier appairage dont le pull échoue après ce point verrouillerait définitivement la route
  (`sync/pull.js`, `pullEvent()`). Un token d'**événement** (`box_tokens`, réservé aux bornes
  d'essai, §1) est **refusé** ici sur une borne réelle plutôt que silencieusement accepté sans
  persistance : l'accepter aurait recréé la même classe de cul-de-sac (rien à persister côté
  `boxToken`, jamais de PIN, verrouillage au premier pull réussi d'un token corrigé ensuite) — voir
  `applyNewToken()`, `routes/sync.js`. `hubUrl` soumis (le body vient d'une requête **sans auth**)
  est validé **avant tout usage** — schéma `https:` exigé, `http:` toléré uniquement vers
  `localhost`/`127.0.0.1` (dev), 400 sinon — pour ne jamais faire de cette route un relais SSRF vers
  une machine arbitraire du LAN/Internet. Comme le token, il est ensuite mutée en mémoire pour le
  round-trip Hub mais **persistée seulement si le pull réussit** — sinon une requête non
  authentifiée réécrirait durablement l'identité de la machine sur un simple essai raté (si fourni,
  sinon celui déjà préconfiguré par `.env`, non revalidé — 400 si aucun des deux). Détecte le
  type de token exactement comme `POST /sync/token` (§ci-dessous), lance le pull, et répond
  `{ ok: true, tokenKind: 'borne'|'event', pull: { ok, pulled?, error? }, hasActiveEvent, token }` —
  jamais un `{ok:true}` de façade : le token peut être **accepté sans être persisté** si le pull
  échoue (Hub injoignable) — il reste seulement en mémoire pour ce process, retentable en
  corrigeant et resoumettant depuis ce même écran, mais **aucun re-essai automatique** en tâche de
  fond (`startHeartbeat()` n'est déclenché que si `pull.ok`) ; `token` (la session) reste `null`
  dans ce cas. **`token`** : un JWT `{ roles: ['tech_borne'] }`, émis **si et seulement si**
  `pull.ok` (le Hub a validé ce token précis) — la preuve d'autorisation est le round-trip Hub
  abouti lui-même, pas un secret séparé à connaître en plus (§11.30).
- `POST /api/sync/token` — **authentifiée** (`requireTech`) : rotation d'un token déjà en place, même détection/persistance/pull que ci-dessus, réponse `{ ok: true }` (l'onglet Identité n'a pas besoin du détail du pull).

**Événements locaux** (`routes/events.js`) — admin :
- `GET /api/events` — liste du registre local (tous les événements **pullés depuis le Hub** — aucune route de création locale : retirée en Phase 6E, jamais restaurée, cf. §11.29).
- `PUT /api/events/:id/activate` — désactive les autres, active celui-ci. Refusé pendant un push en cours.
- `PUT /api/events/:id/close` — **clôture** (`live → closed`) : le kiosque cesse d'accepter de nouvelles sessions (écran « événement terminé »). Réservé à l'admin local = l'**opérateur** ; le client n'a jamais accès à l'admin Borne. Le Hub apprend la clôture au moment du push.
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
- `POST /api/sync/pull` — pull manuel immédiat.
- `POST /api/sync/push-config` — pousse questions + `event_meta` de l'événement actif vers le Hub (overwrite). Interdit en mode preview (403) — réservé à la borne réelle ; la config Hub reste la source de vérité.
- `POST /api/sync/push/:eventId` — **409 si l'événement n'est pas `closed`** (message : « Clôturez l'événement avant le push ») ; sinon lance `push.js` en tâche de fond ; la progression se lit via `GET /api/sync/status`.
- `POST /api/sync/purge/:eventId` — refusé si `status != 'pushed'` ; demande une confirmation explicite (`{ confirm: name }`).

### 6bis. Premier démarrage d'une borne physique (Phase C)

Objectif : un `.env` non modifié doit suffire à démarrer (`cp .env.example-rasp .env && docker
compose -f docker-compose.borne.yml up -d --build`) — tout ce qui reste à fournir (le
`BORNE_TOKEN`) se fait ensuite **depuis le navigateur**, sans SSH ni redémarrage de conteneur, et
sans aucun mot de passe à connaître nulle part (`TECH_PASSWORD` retiré, §11.30).

```
Boot du conteneur backend
┌───────────────────────────────────────────────────────────────────────┐
│ resolveJwtSecret()      JWT_SECRET : génère + persiste (borne_settings)│
│                         si absent/valeur d'exemple — jamais affiché,   │
│                         jamais saisi par un humain                    │
│ resolveBorneIdentity()  BORNE_TOKEN vide → no-op, pas encore appairée │
│ validateConfig()        filet de sécurité — ne rejette plus jamais    │
│                         un déploiement non modifié                   │
└───────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
     Technicien ouvre https://<ip-borne>/ OU /borne — AUCUN mot de passe
     (rien de sensible n'existe encore sur la machine à ce stade ; les deux
      routes affichent le MÊME écran tant que non appairée, cf. App.jsx)
                                    │
   ┌────────────────────────────────────────────────────────────────┐
   │ OnboardingScreen — sonde GET /sync/pairing-status toutes les 4s │
   │  1. Serveur borne   la réponse elle-même en fait foi            │
   │  2. Hub             préconfiguré (.env) ou à saisir             │
   │  3. Token            à coller (Hub → onglet Bornes)             │
   │  4. Événement        en attente du token                       │
   └────────────────────────────────────────────────────────────────┘
                                    │  le technicien colle le token, soumet
                                    ▼
        POST /sync/onboarding/pair { token, hubUrl? }
                                    │
                    ┌───────────────┴────────────────┐
                    │ applyNewToken()                 │
                    │  1. GET Hub /sync/borne/events   │── 400 → token ÉVÉNEMENT (preview/legacy)
                    │     200/autre → token BORNE      │
                    │  2. pull (pullMyEvents/Event)    │
                    │  3. SI pull.ok : persiste         │  ordre inversé vs. avant fix — la
                    │     (borne_settings) + startHeart-│  persistance ne doit jamais précéder
                    │     beat() (borne)                │  la preuve (le round-trip Hub abouti)
                    │     SINON : rien n'est écrit,     │
                    │     le candidat reste seulement   │
                    │     en mémoire (retentable)       │
                    └───────────────┬────────────────┘
                                    ▼
   200 { ok, tokenKind, pull:{ok,pulled?,error?}, hasActiveEvent, token }
                                    │
   ┌────────────────────────────────────────────────────────────────┐
   │ OnboardingScreen affiche le résultat CONCRET (pas un ok:true    │
   │ de façade) :                                                    │
   │  pull.ok && hasActiveEvent  → événement chargé, prêt — DÉJÀ     │
   │                                connecté (session tech_borne     │
   │                                émise dans `token`, sauvegardée) │
   │  pull.ok && !hasActiveEvent → assignez un événement depuis le   │
   │                                Hub, onglet Bornes — déjà connecté│
   │  !pull.ok                   → échec (token invalide, Hub        │
   │                                injoignable…). PAS de session     │
   │                                émise, mais PAS de verrou non     │
   │                                plus (borne_settings.paired_at    │
   │                                reste nul) : le formulaire        │
   │                                redevient disponible, corrigez    │
   │                                et réessayez                     │
   └────────────────────────────────────────────────────────────────┘
                                    │  clic « Continuer » (pull.ok uniquement)
                                    ▼
              Console /borne — déjà authentifié tech_borne
              (aucun login à refaire ; le token de session a été
               sauvegardé dès la réponse de /onboarding/pair)
```

Le formulaire de l'écran d'onboarding est une **alternative**, pas un remplacement : coller
`BORNE_TOKEN` dans le `.env` puis redémarrer le conteneur reste possible — mais **pas** par le même
chemin ni avec les mêmes garanties. Ce chemin passe par `resolveBorneIdentity()` (au boot, avant
tout appel Hub), qui **persiste le token immédiatement, sans round-trip Hub, sans poser
`paired_at`** — une confiance implicite dans l'accès `.env`/SSH, à la différence
d'`applyNewToken()` qui ne persiste qu'après validation. Aucune session auto-ouverte dans ce cas
(pas de requête HTTP à répondre) : la première connexion se fait par PIN une fois le pull effectué.
Cette asymétrie est précisément ce qui a nécessité un **troisième** signal au verrou d'appairage
(§11.30) : une borne dont le `BORNE_TOKEN` d'env n'a encore jamais mené à un pull réussi n'a
**aucune** ligne `local_events` (le second signal) ni `paired_at` — seul le troisième signal,
`borne_settings.borne_token !== null` (posé par `resolveBorneIdentity()` elle-même, sans attendre
de pull), ferme le verrou dans ce cas précis. Sans lui, cette route resterait ouverte sans auth sur
une machine dont l'identité est pourtant déjà fixée par `.env`.

**Sur l'interopérabilité borne-web / borne-server** : les deux ne sont **jamais versionnés
indépendamment** — même commit, même `docker compose … --build`, mêmes conteneurs redémarrés
ensemble. Il n'y a donc pas de scénario où un ancien frontend doit rester compatible avec un
nouveau backend (ou l'inverse) au sens d'une API publique à versionner, hormis un onglet resté
ouvert pendant un redéploiement — cas général à toute SPA, pas spécifique à l'onboarding, et sans
conséquence ici (la fenêtre d'appairage est courte et non répétée). La frontière qui **existe
réellement** est **Borne ↔ Hub** : un Raspberry déployé une fois peut rester des mois sur un
ancien build pendant que le Hub (VPS) est redéployé en continu. C'est déjà repéré — `agent_version`
remonté à chaque battement (§B.3/heartbeat) — mais **à titre informatif uniquement** : aucune
négociation de version, aucune garantie de compatibilité ascendante de l'API Hub n'est faite
aujourd'hui. `POST /sync/onboarding/pair` ne fait qu'appeler les endpoints Hub déjà utilisés par
le pull historique (`/sync/borne/events`, `/sync/events/:id/bundle`) — il n'élargit donc pas cette
surface, mais ne la résout pas non plus. À traiter le jour où une Borne reste durablement en
service avec un agent significativement plus vieux que le Hub qu'elle contacte (hors périmètre
Phase C).

---

## 7. API — Hub (`apps/hub/server`)

Base `/api`. `GET /api/health`.

**Auth utilisateurs** (`routes/auth.js`, `middleware/auth.js`) :
- `POST /api/auth/login` `{ email, password }` → `{ token }` JWT 24h `{ sub: user.id, role }`. Vérif argon2. **`express-rate-limit` : 10 essais / 15 min / IP** (le Hub est exposé sur Internet).
- `POST /api/auth/register` — **désactivé par défaut** (`ALLOW_REGISTER=false`) ; le premier compte se crée via script `npm run create-admin` (prompt email/mdp).
- `POST /api/auth/set-password` `{ token, password }` — pose le mot de passe via un `registration_token` (création de compte **ou** réinitialisation). Vérifie `expires_at` + `used_at` (usage unique). 410 lien expiré/invalide, 409 déjà utilisé.
- `POST /api/auth/forgot-password` `{ email }` — **réponse toujours générique (200)**, ne révèle jamais si l'adresse existe (anti-énumération). Pour un compte réel et actif : crée un `registration_token` court (**1 h**) et envoie un email de réinitialisation (journalisé `email_logs`). **`express-rate-limit` : 10 / 15 min / IP** + garde **5 min / email** (pas de second envoi sous 5 min). Aucun token ni log pour un email inconnu.
- `requireUser` : JWT header ou `?token=`. `requireOwner(eventId)` : 403 si l'événement n'appartient pas au user (sauf `role='superuser'`). **Toutes les routes événement passent par ce contrôle — c'est le cloisonnement client.**

**Événements** (`routes/events.js`) — user :
- `GET /api/events` — ceux du user (tous si admin).
- `POST /api/events` `{ name, event_date }` → uuid, statut **`preview`** (plus de `draft`), crée `events/<id>/db.sqlite` (table `questions` vide) et **provisionne le conteneur de borne d'essai** (`preview_desired='running'`). Réservé aux superusers (`requireAdmin`).
- `PUT /api/events/:id` — métadonnées, dont `consent_text` et `idle_timeout` ; `PUT /api/events/:id/status` `{ status }` (transitions manuelles Hub : `preview→ready`, `ready→preview`). Même règle de gel d'édition que les questions (voir ci-dessous).
- (Plus de `PUT …/assign` : avec token = événement, le lien Borne↔événement se crée en générant un token de borne pour l'événement, voir le super-admin ci-dessous. La Borne s'auto-rattache via son token au moment du pull.)
- `DELETE /api/events/:id` — **suppression totale** (réservée aux superusers, `requireAdmin`) : déprovisionne le conteneur preview, `rm -rf events/<id>`, supprime versions + jobs + la ligne `events` du registre (cascade sur `box_tokens`/`event_users`/`event_versions`), écrit une ligne `sync_log` action `delete`. Confirmation `{ confirm: name }`. Chaîne d'auth : `requireUser → requireOwner` (résout l'événement, 404 si absent) `→ requireAdmin` (403 pour un non-superuser, même propriétaire).

**Questions** (`routes/questions.js`) — user + owner ; mêmes routes que la Borne mais sur `eventStore.openEventDb(eventId)` : `GET/POST/PUT/DELETE /api/events/:id/questions`, `PUT /api/events/:id/questions/reorder/batch`.

**Règle de gel d'édition (Hub)** — le Hub ne voit pas l'événement passer `live` en temps réel (la Borne est offline) ; il l'apprend au push. Donc :
- Édition **autorisée** en `preview` et `loaded` (c'est ce qui permet d'ajuster les questions jusqu'au jour J).
- Édition **refusée (409)** en `ready` (configuration gelée, le token borne réelle peut avoir été distribué) et dès que le Hub connaît un statut ≥ `live` (push effectué).
- Si `updated_at > pulled_at`, l'UI affiche un bandeau **« Modifications non encore récupérées par la borne »** — le client sait que ses changements ne s'appliqueront que si la Borne re-pull avant l'événement. Au push, l'état de la Borne écrase de toute façon celui du Hub (la Borne est maître).

**Galerie** (`routes/gallery.js`) — user + owner, disponible après push :
- `GET /api/events/:id/videos` — JOIN `derived` (miniature, durée).
- `GET /api/events/:id/videos/export/csv` — avant les routes `/:videoId`.
- `GET /api/events/:id/videos/:videoId/file` — Range-aware ; `/download` ; `/thumbnail`.
- `GET /api/events/:id/archive` — télécharge le **ZIP de toutes les vidéos** généré par le job `archive` (Range-aware, donc reprenable par le navigateur). `202 { pending: true }` si le job n'est pas encore terminé.
- `DELETE /api/events/:id/videos/:videoId` — invalide l'archive (ré-enfile un job `archive`).

**Super-admin** (`routes/admin.js`) — rôle `superuser` uniquement (l'opérateur ; les clients `client` n'y ont pas accès) :
- **Comptes clients** (l'URL d'enregistrement est envoyée par email si SMTP configuré, **et** renvoyée à l'admin comme fallback copiable) :
  - `POST /api/admin/users` `{ email, name? }` → crée un compte `client` **sans mot de passe** (`password_hash` NULL), génère un `registration_token` (expire +7 j, usage unique), **retourne `{ user, registration_url }`** — l'URL `…/register?token=<clair>`.
  - `POST /api/admin/users/:id/send-registration` → génère un lien **et l'envoie par email** (envoi synchrone, journalisé dans `email_logs`, **rate-limit 20/h**). **Retourne toujours `{ registration_url, email_sent }`** : un échec SMTP ne fait pas échouer la requête (fallback lien copiable + `email_sent:false`).
  - `GET /api/admin/users` — liste (email, name, role, active, a-un-mot-de-passe).
  - `PUT /api/admin/users/:id` `{ active?, name? }` — désactive/réactive (login refusé si `active=0`), renomme. Régénération d'un lien d'enregistrement : `POST /api/admin/users/:id/registration-link` → nouveau token + URL.
- **Utilisateurs par événement** (`event_users`) — orchestre quels comptes ont accès à quelle borne :
  - `GET /api/admin/events/:id/users` — liste des users assignés avec leurs rôles borne (`roles: ['general']` — `admin_borne`/`tech_borne` ne sont plus assignables, PIN partagé).
  - `POST /api/admin/events/:id/users` `{ user_id, roles }` — assigne ou met à jour les rôles (upsert). Valide les rôles : seul `general` est accepté (accès Hub de l'assignation lui-même indépendant du contenu de `roles`, cf. `requireOwner`).
  - `DELETE /api/admin/events/:id/users/:userId` — retire l'association.
- **Tokens de borne, par événement** (token = événement, §1) :
  - `POST /api/admin/events/:id/tokens` `{ label?, location?, is_preview? }` → génère token (32 octets hex), stocke `sha256(token)` + `token_clear` dans `box_tokens` lié à `:id`, retourne `token_clear` (consultable à tout moment via `GET /api/admin/tokens`).
  - `GET /api/admin/events/:id/tokens` (sans le hash), `DELETE /api/admin/tokens/:tokenId` (révocation), `PUT /api/admin/tokens/:tokenId` `{ label?, location? }`.
- **Bornes physiques** (Phase B — table `bornes`, identité machine persistante, distincte des tokens ci-dessus) :
  - `POST /api/admin/bornes` `{ name, location? }` → crée (id `randomUUID()`), génère un token (32 octets hex, même schéma que les tokens de borne), retourne `token_clear`.
  - `GET /api/admin/bornes` — liste (sans token), avec télémétrie du dernier heartbeat et nombre d'événements assignés.
  - `GET /api/admin/bornes/:id` — fiche : borne + événements assignés + 20 dernières commandes. Retourne **`token_clear`** (pas `token_hash`) : comme pour `box_tokens` (§11.13), le token en clair reste consultable/copiable à tout moment par un superuser, ce n'est pas un affichage à usage unique.
  - `PUT /api/admin/bornes/:id` `{ name?, location?, active? }` — même retour que `GET /:id`, `DELETE /api/admin/bornes/:id` (cascade assignations + commandes).
  - `POST /api/admin/bornes/:id/events` `{ event_id }` — assigne (409 si déjà assigné) ; `DELETE /api/admin/bornes/:id/events/:eventId` — retire.
  - `POST /api/admin/bornes/:id/commands` `{ type, payload? }` — dépose une commande (`pull`/`activate_event`/`close_event`/`purge_event`), récupérée et exécutée au heartbeat suivant. `purge_event` **exige `payload.confirm` = nom exact de l'événement** — même garde que la purge locale (§11), jamais contournable à distance.
- `GET /api/admin/overview` — vue d'ensemble : tous les événements (tous clients), espace disque consommé par événement (`du` sur `events/<id>/`), disque libre du volume, jobs `failed` récents, et pour chaque événement ses tokens de borne (label, location, `is_preview`, `last_seen_at`).
- `GET /api/admin/email-logs` — journal des 100 derniers envois d'emails (onglet « Gestion email ») : `recipient_email`, `type`, `subject`, `status` (`sent`/`failed`/`skipped`), `error`, `created_at`.

**Synchro** (`routes/sync.js`) — `requireBox` (header `X-Box-Token`) résout le token contre **deux** tables (Phase B) et normalise `req.box` :
- trouvé dans `box_tokens` (token = événement) → `req.box = { kind:'preview', token_id, event_id, is_preview }`, `last_seen_at` mis à jour **à chaque requête** — comportement inchangé depuis 6C.
- trouvé dans `bornes` (token = machine) → `req.box = { kind:'borne', borne_id, event_ids:[…] }` (401 si `active=0`) ; `last_seen_at`/télémétrie **jamais** touchés ici, uniquement par `POST /sync/borne/heartbeat` (sinon un simple pull nullerait la télémétrie entre deux battements).

L'invariant §11.20 (« un token ne touche que son propre scope ») est porté par une fonction unique `boxHasEventAccess(box, eventId)` : `box.event_id === eventId` (preview) ou `box.event_ids.includes(eventId)` (borne).

- `GET /api/sync/event` — **réservée aux tokens preview** (400 sinon) : l'**unique** événement de ce token s'il est `status IN ('preview','ready','loaded')` : `{ id, name, event_date, status, updated_at, is_preview }`. **404** si l'événement n'est plus pullable (en attente, ou déjà ≥ `live`). Un token `is_preview=1` ne peut puller que si le statut est `preview` ; un token réel ne peut puller qu'en `ready` ou `loaded`.
- `GET /api/sync/borne/events` — **réservée aux tokens borne** (400 sinon) : liste des événements assignés dont le statut est `ready`/`loaded`. Remplace `GET /event` pour ce cas — une borne physique peut avoir plusieurs événements en jeu.
- `POST /api/sync/borne/heartbeat` — **réservée aux tokens borne**. Body `{ agent_version?, disk?: {free,total}, borne_time_ms, active_event_id? }` → écrit la télémétrie (`clock_skew_ms` **calculé côté Hub**, `Date.now() - borne_time_ms` — la borne n'a pas d'horloge de référence fiable sans RTC, §11.16) et retourne les commandes en attente `{ commands: [{id, type, payload}] }` (marquées `sent` dans la foulée). Ne touche **jamais** au statut d'un événement — la transition `ready→loaded` reste portée par `bundle`, par événement.
- `POST /api/sync/borne/commands/:id/result` — **réservée aux tokens borne**. Body `{ status: 'done'|'failed', result? }` — 404 si la commande n'appartient pas à la borne authentifiée.
- `POST /api/sync/event/login` `{ email, password }` — auth wall preview (§11.24). Protégé par `X-Box-Token`. Vérifie les credentials Hub de l'utilisateur **et** son assignation à l'événement du token avec le rôle `general`. Répond `200 { ok: true }` si les deux conditions sont remplies, `401` si credentials invalides, `403` si l'utilisateur n'est pas assigné `general` ou si l'événement n'est pas en statut `preview`. Rate-limit : 10 essais / 15 min / IP.
- `GET /api/sync/events/:id/bundle` — `{ event: { …, meta }, questions: […], requiresLogin, design_assets: […] }`. **403 si `!boxHasEventAccess(req.box, :id)`** (token preview hors de son événement, ou token borne sur un événement qui ne lui est pas assigné). Passe `ready→loaded` (token réel) ou ne change pas le statut (token preview, qui reste en `preview`), set `pulled_at`. Plus aucun compte nominatif transporté (Phase C, `admin_borne`/`tech_borne` passés au PIN partagé) : `meta.admin_pin`/`meta.tech_pin` voyagent comme n'importe quelle autre clé `event_meta`. Les utilisateurs avec le rôle `general` ne sont **pas** inclus dans le bundle : leur auth est proxiée vers le Hub à chaque login (§11.24). `requiresLogin: true` si au moins un user `general` est assigné à l'événement.
- `POST /api/sync/events/:id/status` `{ status: 'live'|'closed' }` — envoyé par la Borne au moment du push (transitions avant uniquement, jamais de retour en arrière) ; met à jour le statut dans le registre Hub pour déclencher le gel d'édition.
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

**`useMediaRecorder.js`** (`@kapsule/guest-ui`, chantier designUI) — gère caméra + cycle d'enregistrement :
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
  - **Synchro** : timeline du statut (`preview → … → processed`), dates `pulled_at/pushed_at/processed_at`, assignation de borne, état des jobs (`x/y terminés`), `sync_log` récent.
  - **Galerie** (statut ≥ `pushed`) : grille de cartes avec **miniatures** (`derived`), durée, invité, question ; modal `<video>` range-aware ; download unitaire ; bouton **« Tout télécharger (ZIP) »** (grisé avec « préparation en cours… » tant que le job `archive` n'est pas terminé) ; export CSV ; suppression unitaire. La **suppression totale de l'événement** se fait depuis le panneau d'administration (onglet Événements → panneau déplié → « Supprimer l'événement », superuser uniquement), avec confirmation par saisie du nom exact.
- `AdminPage` (rôle `admin` uniquement) : vue d'ensemble super-admin — tous les événements avec leur taille disque, disque libre du volume, jobs en erreur, bornes (`last_seen_at`, création avec modal affichant le token une seule fois + bouton copier, révocation).

---

## 9bis. Designs personnalisables par événement

> Numérotation `9bis` pour ne pas décaler les nombreux renvois `§10`/`§11.x`/`§12`/`§13` déjà
> présents dans ce document, ARCHITECTURE.md, CLAUDE.md et ROADMAP.md.

Aujourd'hui le design du parcours invité = 3 thèmes figés (`cute`/`dark`/`modern`, custom
properties CSS dans `apps/borne/web/src/styles/app.css`) + 6 champs texte. Cette section
introduit des designs **entièrement personnalisables** : chaque client crée, édite, duplique et
**versionne** ses designs depuis une page « Designs » du Hub ; les superusers voient tous les
designs et peuvent promouvoir un design en **template** public partagé.

**Décisions de conception :**
1. Tokens (couleurs, rayons, police, layout) + variantes de layout **prédéfinies** — pas de
   builder drag & drop.
2. Aperçu live dans l'éditeur Hub, via des maquettes statiques (bascule mobile/iPad/desktop).
3. Designs privés par client + templates publics promus par un superuser.
4. Historique versionné avec restauration, même pattern que `event_versions` (§9 « Codé en
   live », voir ROADMAP.md).
5. Appliquer un design à un événement = **copie snapshot**, jamais une référence — modifier le
   design d'origine par la suite n'affecte pas les événements auxquels il a déjà été appliqué.
6. Typographie v1 = presets de stacks système. Pas d'upload de police.
7. Pas d'édition de design côté admin Borne en v1 — le design arrive uniquement par le pull ;
   `DesignPanel` (admin Borne) reste inchangé.

### Schéma JSON d'un design (contrat, version 1)

```json
{
  "version": 1,
  "colors": {
    "bg": "#1a1a2e", "surface": "#232342", "surface-alt": "#2b2b52",
    "text": "#f0f0f0", "text-muted": "#a0a0b8", "text-error": "#ff6b6b",
    "primary": "#e94560", "primary-soft": "#e9456033", "primary-tint": "#e9456014",
    "accent": "#53bf9d", "accent-hover": "#42a385", "accent-soft": "#53bf9d33", "accent-tint": "#53bf9d14",
    "input-bg": "#1f1f3a", "input-border": "#3a3a5c", "input-border-focus": "#53bf9d",
    "btn-secondary-bg": "#2b2b52", "btn-secondary-hover": "#33335f"
  },
  "radius": "soft",
  "font": "sans",
  "images": {
    "start": { "mode": "cover", "filename": "3f2a….png" },
    "thanks": { "mode": "centered", "filename": "9c1e….png", "widthPercent": 60 }
  },
  "screenOverrides": {
    "start": { "colors": { "text": "#0000ff" } },
    "recording": { "colors": { "primary": "#ff0000", "text-error": "#aa0000" } }
  }
}
```

**Règles de validation (STRICTES — c'est la barrière anti-injection CSS) :**
- `version` : doit valoir `1`.
- `colors` : objet dont **chaque clé appartient à `DESIGN_COLOR_KEYS`** (les 18 clés ci-dessus —
  les custom properties existantes de `app.css` sans le préfixe `--`, à l'exclusion de
  `--radius`, `--radius-pill`, `--shadow-soft`, `--shadow-press`, `--rec` qui ne sont pas des
  couleurs). Chaque valeur doit matcher `/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/` (hex 6 ou 8
  caractères). Clés manquantes autorisées (fallback thème). **Clé inconnue → design invalide.**
- `radius` : enum `['sharp', 'soft', 'round']`.
- `font` : enum `['sans', 'serif', 'rounded', 'mono']` (stacks système, voir runtime kiosque).
- `images` (design4) : objet dont **chaque clé appartient à `DESIGN_IMAGE_SCREENS`**
  (`['start', 'thanks']` — une seule image par écran, pas de distinction logo/fond). Chaque entrée
  `images.<screen>` n'admet que 3 clés : `mode` (enum `['centered', 'cover', 'none']`), `filename`
  et `widthPercent` (design5, optionnelle). Règle de cohérence stricte : `mode === 'none'` ⇒
  `filename` doit être `null` ; tout autre mode ⇒ `filename` **obligatoire**, matchant
  `/^[0-9a-f-]{36}\.(png|jpg|webp)$/` (UUID + extension — jamais de chemin, jamais de SVG). Écran
  absent → aucune image sur cet écran (comportement identique à avant l'introduction des designs
  personnalisables). Remplace l'ancien couple `assets{logo,background}` + `layouts{centered,cover,
  split}` : un seul système au lieu de deux à coordonner, et le layout `split` (logo à gauche,
  texte à droite) est retiré — il n'avait de sens que séparé du texte, ce qui n'existe plus avec
  une image unique par écran.
  - `widthPercent` (design5) : entier borné dans `[DESIGN_IMAGE_WIDTH_MIN, DESIGN_IMAGE_WIDTH_MAX]`
    = `[10, 100]`, autorisé **uniquement** si `mode === 'centered'` (rejeté sinon — `cover` occupe
    déjà tout l'écran, `none` n'a pas d'image). Absent → rendu inchangé (CSS par défaut,
    `max-height` plafonné). Présent → largeur prioritaire : le plafond de hauteur est retiré,
    l'image grandit selon son ratio naturel à la largeur demandée (`width`/`max-width: <n>%`).
    Premier champ numérique du contrat, aussi sûr que les enums : borné, entier strict, jamais
    interprété comme du CSS libre (consommé uniquement comme `<n>%` d'une largeur, jamais
    concaténé dans `url()`/`expression()`).
- `screenOverrides` (design3) : objet dont **chaque clé appartient à `DESIGN_SCREENS`**
  (`['start', 'name', 'recording', 'thanks']` — les 4 écrans du parcours invité). Chaque entrée
  `screenOverrides.<screen>` n'admet que la clé `colors`, validée avec **exactement les mêmes
  règles** que `colors` racine (whitelist `DESIGN_COLOR_KEYS`, hex strict). Écran ou couleur
  absent(e) → hérite de la valeur globale correspondante, résolu par `resolveScreenColors(config,
  screen)` (`packages/core/src/design.js`) : surcharge de l'écran si présente, sinon `colors`
  global, sinon absent (fallback thème CSS). Objet `screenOverrides` entier optionnel — absent =
  comportement identique à avant design3 (rétrocompatible avec tous les designs existants).
- Taille totale du JSON sérialisé ≤ 16 384 octets (mesuré : un design avec 18 couleurs globales +
  surcharges complètes sur les 4 écrans reste ≈ 2,5 Ko, largement sous la limite).
- **Jamais de valeur CSS libre** : toute chaîne arbitraire hors des règles ci-dessus est refusée.

Validation portée par une fonction pure `validateDesign(obj)` (`packages/core/src/design.js`),
sans dépendance Node, importable aussi bien par le backend que par les deux frontends
(l'éditeur Hub valide côté client avant envoi, le backend revalide systématiquement). La
résolution `colors` global + `screenOverrides` → couleurs effectives d'un écran est portée par la
même fonction pure `resolveScreenColors`, réutilisée par le runtime kiosque (application des
custom properties CSS à chaque écran) et par l'aperçu live de l'éditeur Hub — source unique, pas
de divergence possible entre ce qu'un client voit dans l'éditeur et ce que la borne rend.

### Principe : copie snapshot, jamais référence

Appliquer un design à un événement **copie** sa configuration JSON (dans `event_meta.design`)
et ses fichiers assets (dans `events/<id>/design/`) au moment de l'application. Le design
source (bibliothèque) et l'événement n'ont ensuite plus aucun lien : modifier ou supprimer le
design d'origine n'affecte jamais un événement auquel il a déjà été appliqué. C'est le même
principe que la configuration existante (questions, `event_meta`) transférée par le bundle de
pull — voir §7 (`GET /api/sync/events/:id/bundle`). **Cet invariant (§11.26) tient sans
exception** : un événement `ready`/`loaded`/`live`/… garde sa copie figée.

### Rafraîchissement de la borne d'essai (événements en preview)

Le principe copie-figée ci-dessus est parfait le jour J, mais gênant *pendant la configuration* :
le client règle son design dans la bibliothèque et veut voir sa **borne d'essai** se mettre à jour
sans devoir re-cliquer « Appliquer » à chaque retouche. On rafraîchit donc — **uniquement pour les
événements en statut `preview`** (données jetables, borne d'essai) — leur copie de design quand le
design source change. Les événements non-`preview` ne sont jamais touchés : **§11.26 reste vrai**.

Mécanisme, sans introduire de référence vivante (la copie reste autonome) :
- À l'application (`PUT /api/events/:eventId/design`), on écrit **en plus** une *trace de
  provenance* : `event_meta.design_source_id` (l'id du design source) et une ligne dans la table
  registre `event_design_refs (event_id, design_id)`. Ce n'est pas un lien vivant — juste
  l'information « cette copie vient du design X », qui permet de retrouver les événements concernés
  sans scanner tous les `events/<id>/db.sqlite`. RGPD : deux ids, aucune donnée invité.
- Après une édition de design (`PUT /api/designs/:id` ou une modification d'asset), le Hub liste
  via `event_design_refs` les événements **en `preview`** issus de ce design, **re-matérialise**
  leur `event_meta.design` (config + fichiers copiés à neuf depuis la bibliothèque) et déclenche
  `triggerPreviewPull` — la borne d'essai re-tire et s'actualise. Les événements d'un autre statut
  sont ignorés.
- Supprimer un design (`DELETE /api/designs/:id`) **détache** les événements (retrait des lignes
  `event_design_refs`) : leur copie figée subsiste, ils ne sont simplement plus rafraîchissables.
- La table `event_design_refs` est purgée à la suppression d'un événement (`ON DELETE CASCADE`).

**`design_source_id` reste Hub-only.** C'est une notion de bibliothèque (le registre Hub), sans
usage pour la borne, qui ne connaît que sa copie `event_meta.design`. Le constructeur du bundle
(`GET /api/sync/events/:id/bundle`, §7) doit donc **exclure `design_source_id`** des `meta`
transmises — comme il exclut déjà le rôle `general` (§11.24). Ne jamais le laisser fuiter dans la
BD événement de la borne.

**Sens unique Hub → Borne.** Le design ne circule que par le bundle de pull (Hub → Borne) ; il
ne doit **jamais** remonter par `POST /api/sync/events/:id/config` (le flux `push-config`,
Borne → Hub, qui pousse `event_meta` en overwrite pour laisser la Borne ajuster questions/textes
sur place). Concrètement : **`'design'` n'entre pas dans `META_KEYS`**
(`apps/hub/server/src/eventConfig.js`) — `applyEventConfig` itère sur cette whitelist (jamais sur
les clés reçues), donc une clé absente de `META_KEYS` est ignorée en lecture *et* en écriture,
même si le payload `push-config` de la Borne la contient. Le design se gère uniquement via
`PUT /api/events/:eventId/design` (Hub) ; `event_meta.design` n'est écrit que par cette route.
**`captureSnapshot`** (historique `event_versions`, voir « Codé en live » de ROADMAP.md) capture
déjà l'intégralité d'`event_meta` sans filtrage par `META_KEYS` (`readSnapshot` fait
`SELECT key, value FROM event_meta` sans restriction) — `event_meta.design` est donc tracé dans
l'historique de versions **sans adaptation** de ce mécanisme. La **restauration** d'une version,
en revanche, demande un traitement dédié : `applyEventConfig` itère sur `META_KEYS` (où `design`
n'est pas), donc restaurer ne rétablirait pas le design du snapshot. `restoreEventDesign`
(`routes/events.js`, appelée par `routes/versions.js`) comble ce trou : elle réécrit
`event_meta.design` depuis le snapshot (ou retire la clé si le snapshot n'en avait pas) et purge
les images orphelines du dossier de l'événement. **Limite assumée** : les fichiers images ne sont
pas re-téléchargés depuis la bibliothèque — même si le snapshot conserve désormais
`design_source_id` (design2), une restauration doit rétablir la *copie de l'époque*, pas la version
actuelle (potentiellement modifiée ou supprimée) du design source. On restaure donc ce qui est
encore dans `events/<id>/design/`. Une image supprimée entre-temps donne un
design *dégradé* (config restaurée, image absente), jamais un échec — cohérent avec le fait qu'un
design appliqué est une **copie autonome**.

### Canal de transfert des assets (bundle + download + checksum)

Contrairement au reste de `event_meta` (texte pur), les assets d'un design sont des fichiers
binaires. Le bundle de pull Hub→Borne (`GET /api/sync/events/:id/bundle`, §7) est étendu avec un
tableau `design_assets: [{ filename, size, checksum }]` (checksum sha256 via
`packages/core/src/checksum.js`, tableau vide si l'événement n'a pas de design). La Borne
télécharge ensuite chaque fichier manquant via un nouvel endpoint dédié
(`GET /api/sync/events/:id/design/:filename`, garde `requireBox`) et vérifie son checksum avant
de considérer le pull réussi — un échec de checksum est un échec de pull explicite, cohérent
avec la philosophie du manifest de push (§11.12).

### Nouvelles routes

- **Hub, bibliothèque de designs** (`apps/hub/server/src/routes/designs.js`, monté sur
  `/api/designs`, `requireUser`) : CRUD (`GET/POST/PUT/DELETE /api/designs[/:id]`),
  `POST /api/designs/:id/duplicate`, `POST /api/designs/:id/promote` (superuser), historique
  (`GET /api/designs/:id/versions[/:vid]`, `POST /api/designs/:id/restore`), assets — une image
  par écran (design4) : `POST /api/designs/:id/assets?screen=start|thanks` (upload, fixe
  `mode: 'centered'` par défaut sauf mode déjà ≠ `none`), `DELETE /api/designs/:id/assets/:screen`
  (retire l'image, remet `mode: 'none'`), `GET /api/designs/:id/assets/:filename`.
- **Hub, application à un événement** (`apps/hub/server/src/routes/events.js`) :
  `PUT /api/events/:eventId/design` `{design_id}` (409 si statut gelé, copie snapshot),
  `DELETE /api/events/:eventId/design` (retour aux thèmes figés).
- **Hub, synchro** (`apps/hub/server/src/routes/sync.js`) :
  `GET /api/sync/events/:id/design/:filename` (`requireBox`, anti path-traversal).
- **Borne, service kiosque** (`apps/borne/web` consommé via `apps/borne/server`) :
  `GET /api/event/design/:filename` (public, anti path-traversal, comme `GET /api/event`).

Détail des routes CRUD, gardes et codes d'erreur : voir ROADMAP.md phase design (sous-lots
design.B et design.E), qui font foi pour l'implémentation.

---

## 10. Docker / Nginx / TLS / Environnement

### docker-compose.borne.yml (déployé sur le Raspberry, arm64)
- `backend` : build `apps/borne/server`, env `JWT_SECRET HUB_URL BOX_TOKEN BORNE_TOKEN PULL_INTERVAL_MS MAX_DATA_BYTES PREVIEW_MODE TRUST_PROXY_HOPS DATA_DIR=/app/data PORT=3001`, **un seul volume** `borne_data:/app/data` (identité machine — `local_events`, `push_state`, `borne_settings` — **et** `events/<id>/` : un split en deux volumes a été envisagé puis abandonné en revue Phase B, un montage imbriqué sur le sous-chemin `events/` masquant silencieusement les données déjà présentes sur une borne existante sans même garantir une purge propre du registre sur un déploiement neuf). La purge RGPD reste exclusivement applicative : `POST /api/sync/purge/:eventId`, §11. Réseau interne seulement, `restart: unless-stopped`.
- `frontend` : build `apps/borne/web` (multi-stage Vite → `nginx:alpine` + openssl), ports `80:80` `443:443`, `depends_on: backend`, volume `borne_certs:/etc/nginx/certs`.
- `borne-entrypoint.sh` : génère un cert auto-signé si absent (`openssl req -x509 -nodes -days 730 -newkey rsa:2048`, CN `borne.local`) puis `nginx -g 'daemon off;'`.
- `borne-nginx.conf` : `client_max_body_size 600M` ; 80 → redirect 443 ; `/api/` → `proxy_pass http://backend:3001` avec headers forwardés, timeouts read/send **600s**, `proxy_request_buffering off` ; `/` → SPA fallback `try_files $uri $uri/ /index.html`.

### docker-compose.hub.yml (VPS) — architecture edge

Le Hub est exposé derrière un **reverse proxy frontal unique** (`edge`) qui termine TLS et
route par `Host`. Le frontend Hub et les bornes preview passent en **HTTP interne** (plus de
ports hôte ni de TLS dupliqué). Tous les services partagent le réseau `kapsule_hub_net`
(nommé en dur, indépendant du projet Compose) ; le frontal les joint par nom de container.

- `backend` : build `apps/hub/server`, `container_name: hub-backend` (nom fixe : les bornes preview le joignent par `http://hub-backend:3001`). Env `JWT_SECRET DATA_DIR PORT ALLOW_REGISTER ADMIN_EMAIL ADMIN_PASSWORD_HUB EDGE_DOMAIN PREVIEW_IMAGE`. Volumes `hub_data:/app/data` **et `/var/run/docker.sock`** (auto-provisioning preview, §10 ci-dessous). Port `3001` publié pour debug.
- `worker` : **même image** que backend, `command: node src/worker/index.js`, même volume. L'image installe `ffmpeg`.
- `frontend` : `container_name: hub-frontend`, nginx + build Vite, **plus de ports ni de TLS** — joint par l'edge via le DNS Docker (`proxy_pass http://hub-frontend`).
- `edge` : build `docker/Dockerfile.edge` (`nginx:alpine` + openssl). **Seul service exposant `80/443`** et seul détenteur du cert. Monte `/etc/letsencrypt:ro`, env `EDGE_DOMAIN`.

**edge — routing par Host** (`docker/edge-nginx.conf.template`, substitué au démarrage) :
- `${EDGE_DOMAIN}` / `www.${EDGE_DOMAIN}` → `hub-frontend`
- `essai-<slug>.${EDGE_DOMAIN}` → container `preview-<slug>` (nom déterministe)
- Comme les sous-domaines preview apparaissent/disparaissent dynamiquement, l'upstream est **variabilisé** (`set $up …; proxy_pass http://$up;`) + `resolver 127.0.0.11` (DNS Docker) : la résolution devient **paresseuse, par requête** — pas besoin de reload nginx quand une preview va et vient. En-têtes sécurité au niveau edge (HSTS, X-Frame-Options, nosniff, CSP), `server_tokens off`, `client_max_body_size 600M`, timeouts 600s.
- `edge-entrypoint.sh` : si le cert Let's Encrypt (`/etc/letsencrypt/live/kapsule/`) est absent (dev/local), génère un cert **auto-signé** dans un répertoire écrivable ; sinon utilise le vrai cert monté en lecture seule.

### Auto-provisioning de la borne preview (Hub pilote Docker via `docker.sock`)

À la création d'un événement, le backend Hub provisionne **un conteneur preview par
événement** (cloisonnement RGPD : data dir + db.sqlite séparés) via le socket Docker monté.
`preview/provisioner.js` (voir ARCHITECTURE.md) : `slugFor(eventId)` → identité DNS-safe
servant de **sous-domaine** (`essai-<slug>`) et de **nom de container** (`preview-<slug>`).
Lance deux containers sur un réseau isolé `preview-net-<slug>`, tous deux raccordés à
`kapsule_hub_net` pour que l'edge les résolve. Les boutons « Démarrer / Éteindre » (superuser)
et l'**état désiré** `events.preview_desired` pilotent leur cycle de vie (§3) ;
`reconcile-previews` les relance au boot/`make vps-up`. Images preview à **construire sur le
VPS** avant le 1er déploiement : `docker compose -f docker-compose.preview.yml build`.

> **Pourquoi monter `docker.sock` est acceptable** : ça donne au backend un pouvoir
> équivalent root sur l'hôte. Ici le Hub est de confiance (notre propre admin, périmètre
> contrôlé) et l'alternative (cron/agent externe) ajoute latence + composant hors-app.
> Risque accepté et documenté.

### Certificat wildcard (Let's Encrypt, DNS-01 manuel)

DNS : **CNAME wildcard** `*.${EDGE_DOMAIN} → ${EDGE_DOMAIN}` (n'importe quel sous-domaine
atterrit sur le VPS). Cert wildcard + apex, challenge DNS-01 manuel (renouvellement ~60 j ;
plugin DNS auto = amélioration future) :
```bash
sudo certbot certonly --manual --preferred-challenges dns --cert-name kapsule \
  -d "${EDGE_DOMAIN}" -d "*.${EDGE_DOMAIN}"
# → créer le TXT _acme-challenge.${EDGE_DOMAIN}, vérifier (dig TXT) puis valider
```
Le cert atterrit dans `/etc/letsencrypt/live/kapsule/` → monté `:ro` dans le service `edge`.

### Raccourcis `make` (voir Makefile)

`make vps-build` (images Hub + preview) · `make vps-up` (up + réconciliation des previews) ·
`make vps-down` (Hub + containers/réseaux preview hors compose) · `make hub-reset` (reset
volumes/réseaux — tests uniquement, jamais en prod). Le projet Docker est fixé à `-p kapsule`
(les previews joignent `hub-backend` par nom, le nom de projet doit être stable).

### Dockerfile backend (les deux) : `node:20-alpine`, `apk add python3 make g++` (build natif better-sqlite3 — fonctionne en arm64), `npm ci --omit=dev` au niveau workspace, copie de `packages/core` + `src`, `CMD node src/index.js`.

### Variables d'environnement

| Variable | App | Défaut | Rôle |
|---|---|---|---|
| `JWT_SECRET` | Borne+Hub | `change-me` (Hub) / _(vide = généré)_ (Borne) | Signature JWT. **Phase C, Borne uniquement** — `resolveJwtSecret()` génère + persiste (`borne_settings`) au premier démarrage si absent/valeur d'exemple ; côté Hub reste une valeur à fixer manuellement en prod |
| `DATA_DIR` | Borne+Hub | `/app/data` | Racine stockage |
| `PORT` | Borne+Hub | `3001` | Port backend |
| `HUB_URL` | Borne | _(vide)_ | URL du Hub — laissée vide, la Borne n'a aucune route pour créer un événement local (§11.29) : elle reste sans événement jusqu'à un appairage |
| `BOX_TOKEN` | Borne | _(vide)_ | Token d'appairage = **événement** — réservé aux bornes d'essai (§1) |
| `BORNE_TOKEN` | Borne | _(vide)_ | **Phase B** — identité de borne **physique** (machine persistante, plusieurs événements assignés). Seed uniquement : après le premier démarrage, `borne_settings` (base) prime — une rotation depuis `/borne` (onglet Identité) survit à un redémarrage sans toucher au `.env` |
| `PULL_INTERVAL_MS` | Borne | `300000` | **Phase B** — période du pull + heartbeat automatiques d'une borne physique (`BORNE_TOKEN` défini). Sans effet en mode preview/token=événement (pull manuel uniquement) |
| `MAX_DATA_BYTES` | Borne | _(vide = illimité)_ | Quota disque de l'événement (essai : `1073741824` = 1 Go) ; upload invité → 507 au-delà |
| `PREVIEW_MODE` | Borne | _(déduit du token `is_preview`)_ | Force le mode démo (bandeau « BORNE D'ESSAI », push interdit). Override optionnel ; normalement déduit du token |
| `TRUST_PROXY_HOPS` | Borne | _(déduit de `PREVIEW_MODE`)_ | Nombre de reverse proxies devant le backend, pour `req.ip`/rate-limiting (1 borne réelle, 2 preview — §11.31). Override seulement si la topologie change |
| `ALLOW_REGISTER` | Hub | `false` | Ouvrir l'inscription publique (indépendant des comptes créés par l'admin) |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD_HUB` | Hub | _(vide)_ | Seed du 1er compte superuser au démarrage si absent (évite `create-admin`) |
| `EDGE_DOMAIN` | Hub | `kapsule.hureau.com` | Domaine principal : routing wildcard de l'edge + URLs preview (`essai-<slug>.<domaine>`) |
| `PREVIEW_IMAGE` / `PREVIEW_BACKEND_IMAGE` | Hub | `kapsule-borne-preview-frontend` / `-backend` | Images lancées par le provisioner pour chaque preview |
| `HUB_URL_INTERNAL` | Hub | `http://hub-backend:3001` | URL interne du backend, injectée aux containers preview (réseau `hub_net`) |

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
10. Le pull ne doit **jamais** écrire si le statut local n'est pas `loaded` (exception : mode preview, où les données sont jetables) — vérifier le statut au moment d'appliquer la réponse, pas au lancement de la requête.
11. `eventStore` du Hub : cache LRU des handles SQLite (~10 ouverts max), et **fermer le handle avant toute purge `rm -rf` ET avant d'écraser un `db.sqlite` reçu au push** — écrire par-dessus une base ouverte = corruption.
12. Le push est repris via le manifest (`missing`) — toujours recalculer côté Hub, ne jamais faire confiance au `push_state` local seul.
13. Le token de borne est stocké **en hash** (`token_hash`, pour l'auth `requireBox`) **et en clair** (`token_clear`, pour la consultation et la copie depuis l'interface admin). `token_clear` n'est jamais exposé aux routes synchro borne ni aux clients — uniquement aux routes superuser `GET /api/admin/tokens`, `GET /api/admin/events/:id/tokens` et, depuis Phase B, `GET/PUT /api/admin/bornes/:id` (même règle pour `bornes` que pour `box_tokens` — consultable à tout moment par un superuser, pas un affichage à usage unique). Toute réponse 401 du Hub sur la synchro doit s'afficher clairement dans `SyncPanel` (token révoqué ?).
14. Raspberry : monter `DATA_DIR` sur **SSD USB**, pas sur la carte SD (usure + corruption = perte de souvenirs irremplaçables).
15. Tester chaque phase sur **iPad Safari réel** (caméra, HTTPS auto-signé à faire confiance dans Réglages → Général → VPN et gestion de l'appareil, Range, retry) — pas seulement Chrome desktop.
16. **Le Raspberry n'a pas d'horloge RTC** : sans Internet, l'heure dérive ou repart du dernier arrêt — or `consent_at` est la **preuve légale RGPD** et tous les timestamps en dépendent. Matériel requis : module **RTC DS3231** (~5 €, I2C) + chrony ; le Préflight vérifie l'écart d'horloge avec l'appareil admin.
17. Le ZIP d'archive se génère **sans compression** (mode store) : la vidéo est déjà compressée, recompresser brûle du CPU sur le VPS pour 0 % de gain.
18. Progression d'upload côté kiosque : `fetch` n'expose pas la progression d'envoi — utiliser `XMLHttpRequest` (`xhr.upload.onprogress`).
19. **Auth Borne à deux niveaux** : `requireAdmin` (rôle `admin_borne`) ≠ `requireTech` (rôle `tech_borne`). Le tech est sur-ensemble : un token `tech_borne` est accepté par `requireAdmin`. Mais un token `admin_borne` doit recevoir **403** sur préflight, clôture et toute la synchro — re-tagger chaque route, ne pas se contenter de cacher l'onglet côté front. Les deux rôles s'authentifient par PIN partagé (`event_meta.admin_pin`/`tech_pin`) — `POST /api/admin/login { pin }` essaie `tech_pin` avant `admin_pin`. La session émise directement par `POST /sync/onboarding/pair` (§6bis, §11.30) contient elle aussi `roles: ['tech_borne']`.
20. **Token = borne (physique) ou événement (preview), réécrit Phase B** : `requireBox` résout `X-Box-Token` contre **deux** tables et normalise `req.box` — `{kind:'preview', event_id, is_preview}` (token = événement, `box_tokens`, comportement 6C inchangé) ou `{kind:'borne', borne_id, event_ids:[…]}` (token = machine, `bornes`, plusieurs événements assignés). **`boxHasEventAccess(box, eventId)` est le seul point de contrôle** de l'invariant « un token ne touche que son propre scope » — `box.event_id === eventId` (preview) ou `box.event_ids.includes(eventId)` (borne) ; **rejeter (403) toute route `…/events/:id/…`** où ce test échoue. `GET /sync/event` (preview) et `GET /sync/borne/events` (borne, plusieurs) sont deux routes distinctes, chacune 400 si appelée avec le mauvais type de token.
21. **Borne d'essai** : une borne dont le token est `is_preview=1` (ou `PREVIEW_MODE=true`) **ne doit jamais pouvoir push** (409) — ce sont des données jetables. Quota `MAX_DATA_BYTES` vérifié **avant** d'écrire le fichier d'upload invité (507 si plein), sinon un client peut saturer le disque du VPS via l'aperçu.
22. **Compte client sans mot de passe** : `users.password_hash` est NULL tant que le client n'a pas suivi le lien d'enregistrement. Le login (argon2) doit gérer ce cas **avant** d'appeler `argon2.verify(null, …)` (sinon exception) ; un compte `active=0` ou sans hash → 401 « identifiants invalides » (ne pas divulguer lequel).
23. **`event_users` Borne** : table historique, **plus jamais peuplée depuis Phase C** — `admin_borne`/`tech_borne` sont passés au PIN partagé (`event_meta.admin_pin`/`tech_pin`), `pull.js` n'y écrit plus jamais de compte. Une borne mise à niveau depuis une version antérieure peut porter d'anciennes lignes (`email`, `password_hash` argon2) : `pull.js` les **purge à chaque pull** (`DELETE FROM event_users` inconditionnel) — aucune donnée invité n'y transite (RGPD non impacté), et ce résidu ne survit jamais plus d'un cycle de synchro.
24. **Preview requiresLogin (rôle `general`)** : si le bundle indique `requiresLogin: true` (au moins un user `general` assigné côté Hub), la borne stocke `requires_login=true` dans `event_meta` au pull. Le kiosque de la borne d'essai doit alors exiger un login avant d'afficher le parcours invité. Le login est **proxié vers le Hub via un seul appel** : `POST /api/preview/login` `{ email, password }` sur la borne → la borne appelle `POST /api/sync/event/login` du Hub (protégé par `X-Box-Token`). Le Hub vérifie les credentials **ET** que l'utilisateur est assigné à CET événement précis avec le rôle `general` — il répond `200 { ok: true }` / `401` / `403`. En cas de succès, la borne émet un JWT local `{ email, roles: ['general'], event_id }` (8 h). Ce JWT est stocké en `sessionStorage` (durée de session navigateur uniquement) et envoyé en Bearer à `POST /api/sessions`. **Le rôle `general` n'est jamais pullé dans le bundle ni stocké dans `event_users` borne** — la vérification de l'assignation se fait entièrement côté Hub à chaque login (la borne preview est toujours connectée).
25. **Transitions d'état `preview`** : un token `is_preview=1` ne peut puller que si le statut Hub est `preview`. Un token réel (`is_preview=0`) ne peut puller que si le statut est `ready` ou `loaded`. `requireBox` doit vérifier cette cohérence et retourner 403 si le type de token ne correspond pas au statut attendu.
26. **Design appliqué = snapshot copié** (§9bis) : `PUT /api/events/:id/design` copie la config JSON et les fichiers assets du design vers `event_meta.design` et `events/<id>/design/` au moment de l'application. La copie est **autonome** : le rendu d'un événement ne dépend jamais, à la lecture (bundle, kiosque), du design source. Une *trace de provenance* (`event_meta.design_source_id` + table registre `event_design_refs`) est conservée, mais ce n'est **pas** une référence vivante — elle sert uniquement à rafraîchir la copie des événements **en statut `preview`** quand le design source est édité (borne d'essai, §9bis « Rafraîchissement de la borne d'essai »). Un événement de tout autre statut (`ready`+) n'est **jamais** modifié par une édition ou une suppression du design source.
27. **Assets de design vérifiés par checksum au pull** (§9bis) : le bundle expose `design_assets: [{filename, size, checksum}]` ; la Borne calcule le sha256 de chaque fichier téléchargé et compare — **un mismatch est un échec de pull explicite**, jamais un fichier silencieusement corrompu.
28. **Jamais de SVG ni de valeur CSS libre dans un design** (§9bis) : `validateDesign()` n'accepte que des couleurs hex strictes, des enums fermées (`radius`, `font`, `images.<screen>.mode`), des noms de fichiers `images.<screen>.filename` au format UUID+extension raster (`png`/`jpg`/`webp`), et un unique champ numérique borné `images.<screen>.widthPercent` (entier `[10,100]`, design5, autorisé seulement en mode `centered`, consommé uniquement comme `<n>%` d'une largeur — jamais concaténé dans `url()`/`expression()`) — toute autre valeur est un design invalide, y compris `url(...)`, `expression(...)` ou tout SVG (vecteur = risque XSS via balises `<script>`/`on*` embarquées).
29. **Pas de création d'événement locale sans Hub** : `POST /api/events` (Borne) a existé (phase 1a.3) puis a été retiré (phase 6E, 18/06) sans être remplacé — tout événement vient désormais exclusivement d'un pull Hub (`origin='hub'` uniquement en pratique ; le schéma tolère encore `'local'` mais plus aucun code n'écrit cette valeur). Ne pas la réintroduire sans une décision explicite : PROJET.md §1 distingue le fonctionnement **hors ligne pendant l'événement** (garanti pour toute Borne appairée, ne dépend pas de cette route) du **mode autonome** (create-sans-Hub — capacité aujourd'hui non fonctionnelle, à ne pas confondre avec le premier).
30. **Plus de `TECH_PASSWORD`** (retiré) : le seul chemin d'auth Borne est le PIN partagé
    (`event_meta.admin_pin`/`tech_pin`, §6). La fenêtre avant le premier PIN — juste après
    appairage, avant que le premier pull ait rapatrié un événement — n'a **pas** de mot de passe
    de secours : `POST /sync/onboarding/pair` (§6bis) émet lui-même une session `tech_borne`
    directement, **si et seulement si `pull.ok`** (un round-trip Hub authentifié a abouti avec CE
    token précis) — c'est la preuve d'autorisation elle-même, pas besoin d'un second secret à
    connaître en plus du token. Corollaire : le verrou de re-appairage de cette route se base sur
    l'**OU de trois signaux persistés** — `borne_settings.paired_at !== null` (un pull a **réussi**
    au moins une fois, posé par `pull.js` au premier succès) **ou** au moins une ligne
    `local_events` (couvre une borne mise à niveau depuis une version antérieure à `paired_at`)
    **ou** `borne_settings.borne_token !== null` (couvre une borne seedée par `BORNE_TOKEN` en
    `.env` — persisté au boot par `resolveBorneIdentity()` **sans** round-trip Hub, donc sans
    jamais poser les deux signaux précédents ; ce chemin suppose déjà un accès SSH/`.env`, la
    correction s'y fait, pas par ce formulaire public) — pas sur la simple présence d'un token en
    config, et surtout **pas** sur `getLastPull()` seul (singleton en mémoire, remis à zéro à
    chaque redémarrage — insuffisant vu que la borne est censée fonctionner offline pendant
    l'événement, §1 : un redémarrage sur place ne doit jamais rouvrir cette route sans auth sur une
    machine qui porte déjà token et vidéos d'invités). La ligne `local_events` n'est écrite qu'
    **après** un pull entièrement réussi (`pullEvent()`, §11.10 et §11.27) — jamais avant, sinon un
    premier appairage dont le pull échoue en cours de route (assets de design corrompus, réseau)
    laisserait une ligne orpheline qui verrouillerait définitivement la route sans qu'aucun PIN
    n'ait jamais existé. Un token mal recopié (pull échoué, donc rien de persisté) ne verrouille
    jamais la borne, un nouvel essai avec un token corrigé reste accepté — sauf s'il s'agit d'un
    token d'**événement** (`box_tokens`), réservé aux bornes d'essai (§1) et **refusé d'emblée**
    sur une borne réelle (`applyNewToken()`) : l'accepter aurait recréé la même classe de
    cul-de-sac côté `boxToken`, qui n'est jamais persisté (contrairement à `borne_token`). Cette route
    est en outre **refusée en mode preview** (§11.21) : Internet-facing, elle ne doit jamais
    exposer de formulaire « appairez-moi à n'importe quel Hub ». Ce même retrait s'applique côté
    Hub : le provisioner preview n'injecte plus `TECH_PASSWORD`/`TECH_PASSWORD_PREVIEW` (un
    événement preview a toujours un `admin_pin`/`tech_pin` généré à sa création, disponible dès le
    premier pull one-shot au boot du conteneur preview).
31. **`trust proxy` doit refléter la vraie chaîne de reverse proxies**, pas une valeur fixe : sur
    une borne réelle, un seul nginx est devant le backend (`borne-nginx → backend`, 1 hop) ; sur
    une preview, deux (`edge-nginx → preview-nginx → backend`, 2 hops, §2 `docker/edge-nginx.conf.template`).
    Se tromper dans le sens « trop petit » (ex. figer `1` partout) fait que `req.ip` vaut l'IP d'un
    nginx interne pour **tous** les visiteurs Internet d'une preview — donc que tous les
    `express-rate-limit` (login, sessions, uploads, `pairing-status`) partagent un seul seau global,
    inopérant face à plusieurs visiteurs simultanés. `config.trustProxyHops` (Borne) se déduit de
    `PREVIEW_MODE` par défaut, surchageable par `TRUST_PROXY_HOPS` si la topologie change.

---

## 12. Plan de développement (phases avec critère de fin)

| Phase | Contenu | Terminé quand |
|---|---|---|
| **0 — Socle** | Monorepo npm workspaces, `@kapsule/core` (schémas + `createEventDb` + checksum) **avec ses tests unitaires (`node:test`)**, squelettes Express des deux serveurs, docker-compose ×2, `.env.example` | `docker compose up` sur chaque fichier → `/api/health` répond ; `npm test` passe |
| **1 — Borne autonome** ⚠️ historique, voir note | Registre local, ~~création d'événement local~~ (`POST /api/events` — retirée phase 6E, jamais restaurée, §11.29), **clôture**, routes questions/sessions/vidéos (avec remplacement), kiosque complet (navigation + réenregistrement + récap + **timeout d'inactivité + reprise de session + barre de progression d'upload**), admin local avec **indicateur disque** et **Préflight** (sans SyncPanel), HTTPS auto-signé | *À l'époque* : un événement entier se déroulait sur iPad Safari **sans aucun Hub**. Ce n'est plus le cas aujourd'hui — tout événement vient d'un pull Hub (§1, §11.29). Le reste de la ligne (kiosque, admin local, HTTPS) reste d'actualité. |
| **2 — Hub minimal** | Registre Hub, `create-admin`, auth argon2/JWT **+ rate limiting**, CRUD événements + questions avec cloisonnement `requireOwner`, frontend (login, events, éditeur questions), règle de gel d'édition (§7) | Deux comptes ne voient que leurs événements respectifs ; questions éditables en ligne |
| **3 — Synchro** | `box_tokens`, `GET /sync/event` + bundle, pull avec règle `loaded`, push complet (manifest/upload/db/finalize, exige `closed`) avec reprise, `SyncPanel`, onglet Synchro du Hub (avec bandeau « modifs non récupérées »), purge Borne, **tests d'intégration du protocole** (pull → uploads → coupure simulée → reprise → finalize, via supertest) | Scénario manuel complet OK **et les tests d'intégration passent** (reprise incluse) |
| **4 — Traitement & galerie** | Worker (boucle jobs), `probe` + `thumbnail` + **`archive` (ZIP)** (ffmpeg/archiver), passage `processed`, galerie Hub (miniatures, lecture range, download, **« Tout télécharger »**, CSV), suppression RGPD côté Hub, **page super-admin** (overview stockage/jobs/bornes) | Après un push, le client voit ses vidéos en ligne avec miniatures et télécharge le ZIP complet ; supprimer l'événement efface tout |
| **6 — Refonte administration** | Borne : **admin client / tech** (deux mots de passe, deux rôles, re-tagging des routes, routing manuel). Hub : **comptes clients** (création + lien d'enregistrement affiché + activation), **modèle token=événement** (`box_tokens` remplace `boxes` + `events.box_id` ; `GET /sync/event` remplace `/assigned`), **super-admin UI** (événements, tokens réel/essai, clients), **aperçu distant** (borne d'essai `is_preview`, quota 1 Go, push interdit, onglet client, `docker-compose.preview.yml`) | Le client gère sa borne sans voir le tech ; un compte client se crée via lien ; lancer le conteneur d'essai avec un token le rattache à son événement ; le client valide sa config à distance (≤ 1 Go, sans push) |
| **7 — Évolutions** | Machine de capture dédiée (appareil photo), job `chromakey` (fond vert), portail invités, mode point d'accès Wi-Fi de la Borne (hostapd) | Au fil de l'eau |

> **Note** : la Phase 6 a rétroactivement réécrit le modèle de la Phase 3 (`boxes` → `box_tokens`, `GET /assigned` → `GET /sync/event`, `pullAssigned` → `pullMyEvent`). L'implémentation courante reflète cet état final.

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
- **Token éphémère « pur événement » sans entité `box_tokens`** (un token = une colonne sur `events`) : écarté au profit de `box_tokens` (§5.3) qui autorise plusieurs tokens par événement (réel + essai) et la révocation indépendante.
- **Lien de partage sans compte pour l'aperçu client** : écarté au profit d'un onglet dans l'espace client (compte Hub) — un seul système d'accès à maintenir. À réévaluer si un client refuse de créer un compte.
