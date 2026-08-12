# Phase B — Bornes comme entités de premier plan

## Context

Aujourd'hui **il n'existe aucune entité « Borne »** dans Kapsule. Une borne n'est matérialisée
que par une ligne `box_tokens` au Hub, c'est-à-dire un couple *(token, événement)* — décision
6C « token = événement » (invariant §11.20). Conséquences constatées dans le code :

- Le Hub ne peut ni créer, ni supprimer, ni administrer une borne — l'onglet `BornesTab`
  ([AdminPage.jsx:758](apps/hub/web/src/pages/AdminPage.jsx#L758)) est un placeholder vide, et
  le Dashboard compte des *lignes de tokens* qu'il appelle « bornes ».
- Un Raspberry est figé sur **un** événement par `BOX_TOKEN` au boot :
  `pullMyEvent()` ([pull.js:169](apps/borne/server/src/sync/pull.js#L169)) appelle
  `GET /api/sync/event` (singulier) et le Hub déduit l'événement du seul token.
- Le Hub ne sait **rien** d'une borne entre deux syncs : pas de heartbeat, pas de boucle
  périodique. `PULL_INTERVAL_MS` est déclaré dans `docker-compose.borne.yml:15` mais **lu par
  aucun code** — variable morte.
- Le token changé à chaud (`POST /api/sync/token`) n'est **pas persisté** — perdu au redémarrage.
- Bug annexe : `api.closeEvent` ([client.js:136](apps/borne/web/src/api/client.js#L136)) n'est
  appelé par **aucun composant**. La clôture est pourtant le prérequis du push (409 sinon) :
  **le chemin « clôturer puis pousser » est inatteignable depuis l'UI**.

À l'inverse, la Borne **sait déjà** héberger plusieurs événements : `local_events` a une colonne
`active` et `setActiveEvent()` est transactionnel ([registry.js:79](apps/borne/server/src/registry.js#L79)).
Ce qui manque est côté Hub (l'identité machine) et dans le protocole de sync.

**Résultat visé** : une Borne devient une machine persistante, créée et administrée depuis le Hub,
à laquelle on assigne des événements. Elle expose sa propre **console** locale (`/borne`) pour la
gestion machine, distincte de l'admin d'événement (`/admin`). Le Hub la voit vivre (heartbeat) et
peut lui envoyer des commandes.

### Décisions actées

1. **Un seul couple de containers** sur le Raspberry (pas de container par événement) — séparation
   *logique* par espaces + séparation *physique* des volumes de données. Pas de `docker.sock`
   sur le Pi : la fiabilité offline le jour J prime sur l'isolation par container.
2. **Token = borne** (identité machine persistante) pour les bornes physiques. Les **previews
   gardent `box_tokens` inchangé** (token = événement) — le provisioner Hub n'est pas touché.
3. **Heartbeat + file de commandes** : la Borne poll le Hub (ressuscite `PULL_INTERVAL_MS`),
   remonte son état et récupère les commandes en attente.

### Hors périmètre

Console SSH distante, métriques temps réel (WebSocket), mode point d'accès Wi-Fi, container par
événement, création d'événement en local sur la borne.

---

## B.1 — Hub : schéma `bornes`

`apps/hub/server/src/registry.js`. Suivre **exactement** le pattern de migration existant :
tableau `MIGRATIONS` (l. 157-370) + runner `runMigrations` (l. 372-388). Dernière version = 9,
donc **version 10**. Modèle d'ajout de table : migration 9 `email_logs` (l. 349-369) — le
`CREATE TABLE IF NOT EXISTS` est dupliqué dans le bloc initial d'`openRegistry` **et** dans le `up`.

```sql
CREATE TABLE IF NOT EXISTS bornes (
  id            TEXT PRIMARY KEY,           -- uuid
  name          TEXT NOT NULL,
  location      TEXT,
  token_hash    TEXT UNIQUE NOT NULL,
  token_clear   TEXT UNIQUE NOT NULL,       -- consultable admin (cohérent §11.13)
  active        INTEGER NOT NULL DEFAULT 1,
  last_seen_at  DATETIME,
  -- télémétrie du dernier heartbeat (écrasée à chaque battement)
  agent_version    TEXT,
  disk_free_bytes  INTEGER,
  disk_total_bytes INTEGER,
  clock_skew_ms    INTEGER,
  active_event_id  TEXT,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS borne_events (           -- assignation N-N
  borne_id   TEXT NOT NULL REFERENCES bornes(id)  ON DELETE CASCADE,
  event_id   TEXT NOT NULL REFERENCES events(id)  ON DELETE CASCADE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (borne_id, event_id)
);

CREATE TABLE IF NOT EXISTS borne_commands (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  borne_id   TEXT NOT NULL REFERENCES bornes(id) ON DELETE CASCADE,
  type       TEXT NOT NULL CHECK(type IN ('pull','activate_event','close_event','purge_event')),
  payload    TEXT,                                  -- JSON
  status     TEXT NOT NULL DEFAULT 'pending'
             CHECK(status IN ('pending','sent','done','failed')),
  result     TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  claimed_at DATETIME,
  done_at    DATETIME
);
```

`borne_events` est une table de jonction (pas `events.borne_id`) pour préserver la raison d'être
de `box_tokens` documentée en PROJET.md §13 : plusieurs bornes possibles sur un même événement.

Helpers à ajouter, calqués sur ceux de `box_tokens` (l. 508-555) : `insertBorne`, `listBornes`,
`getBorneById`, `getBorneByHash`, `updateBorne` (whitelist `['name','location','active']`),
`deleteBorne`, `updateBorneHeartbeat`, `listBorneEvents`, `assignBorneEvent`, `unassignBorneEvent`,
`listEventBornes`, `insertBorneCommand`, `claimPendingCommands`, `completeBorneCommand`.

**Tests** (`apps/hub/server/test/registry.test.js`) : insertion + non-fuite de `token_hash` dans
`listBornes` (le test existant l. 195-230 sur `box_tokens` est le modèle), cascade de suppression,
idempotence de la migration 10 (double `openRegistry`).

## B.2 — Hub : routes admin bornes

`apps/hub/server/src/routes/admin.js` — le routeur est déjà **entièrement superuser** via
`router.use(requireUser, requireSuperuser)` (l. 54), rien à ajouter côté garde.

| Route | Effet |
|---|---|
| `POST /api/admin/bornes` | `{name, location}` → crée + `randomBytes(32).hex`, retourne le token en clair (**201**) |
| `GET /api/admin/bornes` | Liste + télémétrie + nb d'événements assignés |
| `GET /api/admin/bornes/:id` | Fiche : borne + événements assignés + 20 dernières commandes |
| `PUT /api/admin/bornes/:id` | Renommer / déplacer / désactiver |
| `DELETE /api/admin/bornes/:id` | Suppression (cascade assignations + commandes) |
| `POST /api/admin/bornes/:id/events` | `{event_id}` → assigne (**409** si déjà assigné, **404** si event inconnu) |
| `DELETE /api/admin/bornes/:id/events/:eventId` | Retire l'assignation |
| `POST /api/admin/bornes/:id/commands` | `{type, payload}` → enfile une commande |

Réutiliser le générateur de token de `POST /events/:id/tokens` (l. 208-232) — même schéma
`randomBytes(32)` + `sha256`, même stockage clair+hash.

**Tests** (`apps/hub/server/test/admin.test.js`) : nominal, 403 pour un client non-superuser,
404 sur borne/événement inconnu, 409 double assignation. Setup existant l. 1-35 comme modèle.

## B.3 — Hub : protocole de sync borne

`apps/hub/server/src/middleware/boxAuth.js` — **ne pas casser les previews.** `requireBox` résout
aujourd'hui uniquement `box_tokens`. Le faire résoudre les deux tables et normaliser :

- token trouvé dans `box_tokens` → `req.box = { kind:'preview', token_id, event_id, is_preview }`
  *(comportement actuel strictement inchangé)*
- token trouvé dans `bornes` → `req.box = { kind:'borne', borne_id, event_ids:[…] }`, refuse si
  `active = 0`

**Refactor à faire au passage** : l'invariant « un token ne touche que son propre événement » est
recopié **à la main dans 8 handlers** de `apps/hub/server/src/routes/sync.js` (l. 98, 209, 305,
340, 365, 406, 452, 502), avec deux messages d'erreur différents. Extraire un middleware
`requireEventScope` qui autorise `req.box.event_id` (preview) **ou** l'appartenance à
`req.box.event_ids` (borne). Il porte le nouvel invariant §11.20 en un seul endroit.

Nouvelles routes :

- `GET /api/sync/borne/events` — liste des événements assignés et pullables. Remplace
  `GET /api/sync/event` **pour les bornes seulement** (l'ancienne route reste pour les previews).
- `POST /api/sync/borne/heartbeat` — body `{ agent_version, disk:{free,total}, clock_skew_ms,
  active_event_id, events:[{id,status}] }` → écrit la télémétrie, retourne
  `{ commands: [...] }` (les passe en `sent`).
- `POST /api/sync/borne/commands/:id/result` — `{ status:'done'|'failed', result }`.

⚠️ La règle `ready → loaded` + `pulled_at` (l. 216) est aujourd'hui déclenchée par le bundle.
Avec plusieurs événements par borne elle reste **par événement** — ne pas la déplacer au heartbeat.

**Tests** (`apps/hub/server/test/sync.test.js`) : token borne accepté / token preview toujours
accepté (non-régression), borne inactive → 401, accès à un événement non assigné → 403,
heartbeat écrit la télémétrie, commande `pending` → `sent` → `done`.

## B.4 — Borne : identité persistante, pull multi-événements, heartbeat

**Token persistant** — `apps/borne/server/src/registry.js`, nouvelle table :

```sql
CREATE TABLE IF NOT EXISTS borne_settings (key TEXT PRIMARY KEY, value TEXT);
```
Clés : `borne_token`, `hub_url`. L'env (`BORNE_TOKEN`, `HUB_URL`) sert de **seed au premier
démarrage** ; ensuite la base fait foi. Corrige le fait que `POST /api/sync/token`
([sync.js:98](apps/borne/server/src/routes/sync.js#L98)) ne mute que la mémoire.

Garder `BOX_TOKEN` tel quel : c'est ce qu'injecte le provisioner preview
([provisioner.js:199](apps/hub/server/src/preview/provisioner.js#L199)). `BORNE_TOKEN` est la
nouvelle variable des bornes physiques ; si les deux sont absents → mode autonome.

**`pullMyEvents(dataDir)`** dans `apps/borne/server/src/sync/pull.js`, à côté de `pullMyEvent`
(conservé pour les previews) : `GET /api/sync/borne/events` puis boucle sur `pullEvent()`.

> ⚠️ **Changement de comportement le plus délicat du lot.** `pullEvent` appelle aujourd'hui
> `setActiveEvent(hubEventId)` en dur ([pull.js:43](apps/borne/server/src/sync/pull.js#L43)).
> En multi-événements c'est dangereux : puller l'événement B basculerait le kiosque alors que A
> est `live`. Sortir `setActiveEvent` de `pullEvent` et en faire une action explicite. Seule
> exception conservée : si **aucun** événement n'est actif et qu'un seul est pullé, l'activer.
> La garde §11.10 (l. 31-33, ne jamais écraser un `live`/`closed`) reste inchangée.

**`apps/borne/server/src/sync/heartbeat.js`** (nouveau) : `setInterval` de `PULL_INTERVAL_MS`
(défaut 300000) — à ajouter à `config.js`, aujourd'hui absent. Chaque battement : POST du
heartbeat, exécution séquentielle des commandes reçues, POST du résultat. Best-effort et
**silencieux** en cas d'échec réseau (la borne doit fonctionner offline). Démarré depuis
`index.js` à côté du pull one-shot existant (l. 102-105), uniquement si `hubUrl && borneToken`.

Réutiliser les métriques déjà calculées, ne pas les réécrire : `statfs` de
`GET /api/admin/health` ([index.js:54-60](apps/borne/server/src/index.js#L54)) et l'écart
d'horloge du préflight ([events.js:230-237](apps/borne/server/src/routes/events.js#L230)).

**Tests** (`apps/borne/server/test/`) : token lu depuis `borne_settings` avant l'env, pull de 2
événements sans changer l'actif, exécution d'une commande `close_event`, heartbeat silencieux si
le Hub est injoignable.

## B.5 — Borne : console machine `/borne`

`/admin/tech` **devient** `/borne` : l'espace technicien *est* l'espace machine. Routing manuel
dans [App.jsx:22-31](apps/borne/web/src/App.jsx#L22) (pas de react-router), nginx sert déjà le
même bundle sur tous les chemins (`try_files … /index.html`, `docker/borne-nginx.conf:44`).
Garde inchangée : `tech_borne`, clé `localStorage` `tech_token`.

| Onglet | Contenu |
|---|---|
| **Identité** | Nom/lieu, token (masqué + rotation, réutilise l'UI existante `SyncPanel.jsx:180-218`), URL du Hub, état en ligne |
| **Événements** | Liste des événements de la borne + **Activer** / **Clôturer** / **Purger**. Déplace `EventPanel` ici depuis `/admin` |
| **Machine** | Disque, horloge, caméra — `PreflightPanel` déplacé tel quel |
| **Synchro** | Pull / push / journal des commandes — `SyncPanel` déplacé |

`/admin` ne garde que le contenu de l'**événement actif** : Questions, Vidéos, Design. En
corollaire, déplacer l'override local qualité/orientation
([DesignPanel.jsx:156-190](apps/borne/web/src/components/admin/DesignPanel.jsx#L156)) vers
l'onglet Machine — c'est un réglage borne, pas un réglage d'événement.

**Corrige le bug de clôture** : câbler `api.closeEvent` (mort aujourd'hui) sur un bouton
« Clôturer l'événement » avec confirmation par saisie du nom, dans l'onglet Événements.

Ajouter un lien de navigation entre `/admin` et `/borne` — aujourd'hui il faut taper l'URL.

## B.6 — Hub : onglet Bornes réel

Remplacer le placeholder [AdminPage.jsx:758-775](apps/hub/web/src/pages/AdminPage.jsx#L758).
Suivre le canevas d'onglet du fichier (`TokensTab` l. 588-682 est le plus proche) :
`useState` data/loading/error, `load` en `useCallback`, `<section className="panel-section">`,
`<table className="admin-table responsive-table">` avec `data-label` sur chaque `<td>`.

- Liste : nom, lieu, pastille en ligne/hors ligne (`last_seen_at` < 2× l'intervalle), disque,
  version, événement actif, nb d'événements assignés.
- Créer une borne → token affiché avec `CopyButton` (+ la commande docker, comme `dockerCmd`
  l. 618-623).
- Fiche : assigner/retirer des événements, boutons de commande (Pull, Clôturer, Purger),
  journal des commandes.
- Dans `EventDetailPage`, onglet Synchro : afficher et choisir la ou les bornes de l'événement.

Ajouter les méthodes correspondantes dans `apps/hub/web/src/api/client.js` (bloc l. 55-66).

## B.7 — Infra

`docker-compose.borne.yml` : séparer les volumes — `borne_data:/app/data` (registre, identité)
et **`borne_events:/app/data/events`** (montage imbriqué, données invités). Purger toutes les
données RGPD devient `docker volume rm borne_events` sans perdre l'identité de la borne.

`.env.example` + README §4 : `BORNE_TOKEN`, `PULL_INTERVAL_MS` (enfin fonctionnelle), procédure
« créer la borne au Hub → copier le token → assigner des événements ».

## B.8 — Documentation

- **PROJET.md §1** : « une Borne ne sert qu'un seul événement » → *un seul événement **actif à la
  fois**, mais peut en héberger plusieurs*.
- **§5.3** : ajouter `bornes`, `borne_events`, `borne_commands`. **§5.4** : `borne_settings`.
- **§7** : nouvelles routes admin + sync borne. **§10** : `BORNE_TOKEN`, `PULL_INTERVAL_MS`, volumes.
- **§11.20 réécrit** : « Token = **borne** (physique, plusieurs événements assignés) ou
  **événement** (preview). `requireEventScope` est le seul point de contrôle. »
- ARCHITECTURE.md (modules + flux sync), ROADMAP.md (section Phase B), `/sync-doc` pour `docs/`.

---

## Vérification

Chaque sous-lot : `/verif-spec` avant commit, puis tests du workspace touché —
`docker compose run --rm dev ./docker/test.sh -w @kapsule/hub-server` (idem `borne-server`).
**Toujours borner par un `timeout` explicite**, sinon la session bloque.

Non-régressions à surveiller en priorité :

1. **Previews intactes** — c'est le risque principal, le provisioner Hub crée des `box_tokens`.
   `npm run smoke:preview` (cycle complet sur containers réels) doit rester vert, ainsi que
   `apps/hub/server/test/sync.test.js` et `provisioner.test.js` **sans modification**.
2. **Protocole de sync** — `integration.sync.test.js` (pull → sessions → push → coupure →
   reprise → finalize) doit passer inchangé pour le chemin preview, et être doublé d'un
   scénario borne multi-événements.
3. `npm run smoke:borne` (stack borne réel, mode autonome) après B.7.

Bout en bout, à faire sur le VPS + un Raspberry : créer une borne au Hub → copier le token dans
le `.env` de la Borne → assigner deux événements → vérifier que la console `/borne` les liste,
qu'activer l'un ne perturbe pas l'autre, que le heartbeat remonte disque et horloge dans l'onglet
Bornes, et qu'une commande « Pull » envoyée depuis le Hub s'exécute au battement suivant.

Les cases 🧑 de ROADMAP.md restent des vérifications humaines (iPad Safari réel, arm64, RTC).
