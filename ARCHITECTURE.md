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

Deux applications + deux packages partagés :

| Composant | Rôle | Tourne sur |
|-----------|------|-----------|
| **Borne** (`apps/borne`) | Kiosque d'enregistrement vidéo, 100 % offline pendant l'événement | Raspberry Pi / iPad Safari |
| **Hub** (`apps/hub`) | Interface client (web), reçoit/traite/archive les vidéos | VPS |
| **Core** (`packages/core`) | Constantes, validation, schéma de la BD événement, checksum — partagés, **sans React** | importé par les deux serveurs + web |
| **Guest-UI** (`packages/guest-ui`) | Rendu du parcours invité partagé entre le kiosque borne et l'aperçu live de l'éditeur Hub (dépendances réseau/caméra injectées par props ; **pas d'iframe** — la CSP edge les bloque). Depuis **designUI.B** : `src/design.js` (fonction pure `designToVars(design, screen)` — résout un design en custom properties CSS, source **unique** partagée par le runtime borne et l'aperçu Hub, remplace la duplication `applyDesign`/`cssVarsFor` — plus `MANAGED_DESIGN_VARS` et `imageWidthStyle` migré tel quel depuis la borne, exporté séparément en `@kapsule/guest-ui/design` sans JSX) et `src/guest.css` (CSS des écrans invité migré depuis `apps/borne/web/src/styles/app.css`, règles préfixées `.kapsule-guest`). Depuis **designUI.C/D/E** : `src/screens/` (StartScreen, ThankYouScreen, NameInput, RecapScreen, QuestionNav, QuestionSheet, RecordingScreen) + `src/useMediaRecorder.js` — **tout le JSX du parcours invité vit désormais ici** ; `apps/borne/web/src/components/guest/` et `apps/borne/web/src/hooks/` ont été supprimés. Dépendances réseau/caméra injectées par props (`createSession`, `onFinishSession`, `uploadVideo`, `guestVideoUrl`, `resolveAssetUrl`) ; `RecordingScreen` a une prop `showcase` (aperçu Hub sans matériel : **aucun `getUserMedia`**, toutes les branches caméra court-circuitées). Le barrel `src/index.js` exporte fonctions pures **et** composants JSX — importer `@kapsule/guest-ui/design` (pas le barrel) hors Vite (node --test), sinon `Unknown file extension .jsx`. | importé par les deux `web` |

Chaque app = un **serveur Express** (`server/`) + un **frontend** (`web/`, React + Vite, servi par Nginx en prod).

**Le modèle de données central : un événement = un dossier.**
```
<DATA_DIR>/
  registry.sqlite          # métadonnées (PAS de données invité — RGPD §11)
  events/<id>/
    db.sqlite              # données de l'événement (sessions, vidéos, questions, users…)
    videos/<videoId>.mp4   # fichiers vidéo bruts
    derived/              # (Hub) miniatures, archive.zip
    design/               # assets du design APPLIQUÉ (copie snapshot §11.26) — Hub ET Borne.
                          #   Écrit par PUT /api/events/:id/design (Hub) ; reconstruit à chaque
                          #   pull côté Borne. Aucune PII invité. Purgé avec events/<id>/.
    push_manifest.json    # (Hub) état du push en cours
  previews/<slug>/         # (Hub) DATA_DIR bind-monté du container borne preview-<slug>
                           #   contient db.sqlite + vidéos d'essai (PII invité) — voir §2 Preview.
                           #   purgé par deprovisionPreview (rm -rf) à la suppression de l'événement.
  designs/<designId>/      # (Hub) images (une par écran start/thanks, design4) de la bibliothèque de designs (§9bis).
                           #   Aucune PII invité. Purgé par DELETE /api/designs/:id (rm -rf),
                           #   copié par POST /api/designs/:id/duplicate.
```

> **RGPD — où vivent les données invité.** Hors `registry.sqlite` (invariant strict), les PII
> invité vivent dans `events/<id>/` (après push) **et**, pendant la phase preview, dans
> `previews/<slug>/` sur le filesystem du Hub (bind mount du container borne d'essai). Les deux
> chemins sont supprimés par `DELETE /api/events/:id` (deprovision → `rm previews/<slug>` puis
> `closeEventDb` → `rm events/<id>`). Toute nouvelle localisation de PII doit garantir cette purge.
>
> **Côté Borne physique**, `<DATA_DIR>` reste un **volume Docker unique**
> (`docker-compose.borne.yml`, `borne_data:/app/data`) : registre machine (`local_events`,
> `push_state`, `borne_settings` — Phase B) et `events/<id>/` (PII invité) y cohabitent. Un split
> en deux volumes (registre / événements) a été envisagé puis **abandonné en revue Phase B** :
> monter un second volume nommé sur le sous-chemin `events/` **masque silencieusement** les
> données déjà présentes à cet endroit sur une borne existante (toujours sur le disque, mais plus
> lisibles ni purgeables par l'app) — et même sur un déploiement neuf, un `docker volume rm` du
> sous-volume ne nettoie pas les lignes `local_events`/`push_state` du registre : ce n'aurait
> jamais été un vrai raccourci de purge. La purge RGPD de référence reste exclusivement
> applicative : `POST /api/sync/purge/:eventId` (confirmation par nom) → `closeEventDb` →
> `rm -rf events/<id>` + `push_state`, **et** met le registre à jour de façon cohérente.
Deux **bases SQLite distinctes** par design :
- `registry.sqlite` : index global, **jamais** de nom/vidéo/session invité (invariant RGPD).
- `events/<id>/db.sqlite` : tout le contenu invité, isolé par événement, transférable d'un bloc.

Le schéma de `db.sqlite` est **identique** Borne et Hub (généré par le même `createEventDb` de core).

---

## 2. Hub (`apps/hub/server/src/`)

Point d'entrée : `index.js` → `createApp(dataDir, opts, { docker, resolvePreviewBase, mailer })` monte les routers et l'error handler global. Le `mailer` (défaut `createNullMailer()`) est passé à `makeAuthRouter({ mailer })` et `makeAdminRouter(dataDir, { mailer })`.
Process séparé optionnel : `worker/index.js` (boucle de jobs).

### Modules transversaux

| Fichier | Responsabilité |
|---------|---------------|
| `config.js` | Lecture des variables d'env (port, jwtSecret, adminEmail…) |
| `registry.js` | **Toute** la couche d'accès à `registry.sqlite` : schéma + migrations + helpers CRUD (users, events, box_tokens, event_users, registration_tokens, jobs, sync_log, **event_versions**, **email_logs**, **designs**, **design_versions**, **event_design_refs**). `designs` (id UUID, `owner_id` NULL pour les templates, `config_json`, `is_template`) + `design_versions` (`ON DELETE CASCADE`, snapshot append-only) portent la bibliothèque de designs (§9bis) — **RGPD : config d'apparence rattachée à un COMPTE client, jamais de donnée invité**. `event_design_refs` (`event_id` PK `→events(id) ON DELETE CASCADE`, `design_id` **sans FK** — un design supprimé détache l'événement, ne le casse pas) est une **trace de provenance** (design2) : `setEventDesignRef`/`deleteEventDesignRef`/`listEventsByDesignSource` retrouvent les événements `preview` à rafraîchir quand un design source est édité — **RGPD : deux ids, aucune donnée invité**. `seedDesignTemplates(db)` (appelé après `runMigrations`, no-op si la table est non vide) insère les 3 templates `Cutealism`/`Sombre`/`Moderne`, couleurs transcrites des blocs `data-theme` de `apps/borne/web/src/styles/app.css`. `updateDesign` filtre les champs par whitelist (`name`, `config_json`, `is_template` — **`owner_id` volontairement exclu** : la propriété d'un design ne se transfère pas, une duplication crée une nouvelle ligne). `listDesigns` a **deux requêtes distinctes** : la branche superuser fait un `LEFT JOIN users` et expose **`owner_email`** (email de COMPTE, jamais d'invité — groupement par propriétaire de la vue superuser) ; la branche client est un `SELECT *` **nu** sur `designs`. ⚠️ **Ne jamais fusionner les deux** : la clause de visibilité client (`owner_id = ? OR is_template = 1`) laisse un client lire les **templates**, or un design promu **garde son `owner_id`** — toute colonne jointe dans la branche client serait donc divulguée d'un client à l'autre (c'est exactement la fuite d'`owner_email` corrigée en design.C). `defaultDesignConfig()` expose la config par défaut (Cutealism) **dérivée du tableau de seed, pas d'un `SELECT … WHERE name = 'Cutealism'`** — les templates sont renommables. `email_logs` (migration #9 + bloc CREATE initial) journalise les envois SMTP — **RGPD : emails de COMPTES (clients/admin) uniquement, jamais d'invité** (`insertEmailLog` / `listEmailLogs`). `events.preview_desired` (`running`/`stopped`) porte l'état désiré de la borne preview ; `listEventsPreviewDesired` alimente la réconciliation. **Phase B** — `bornes` (identité persistante d'une borne physique : `id`, `token_hash`/`token_clear`, `active`, télémétrie du dernier heartbeat écrasée à chaque battement — `agent_version`, `disk_free_bytes`, `disk_total_bytes`, `clock_skew_ms`, `active_event_id`), **distincte** de `box_tokens` (token = événement, réservé aux bornes d'essai — provisioner inchangé). `borne_events` (PK composite `borne_id, event_id`, table de jonction plutôt que `events.borne_id` pour permettre plusieurs bornes par événement, cf. PROJET.md §13) porte l'assignation N-N. `borne_commands` (`type` ∈ `pull`/`activate_event`/`close_event`/`purge_event`, `status` `pending`→`sent`→`done`/`failed`) est la file Hub → Borne : la borne n'étant jamais joignable directement, elle dépose une commande que `claimPendingCommands` marque `sent` **et re-sélectionne** (jamais renvoyer les lignes du `SELECT` initial — instantané pré-`UPDATE`, sinon l'appelant croit `status` encore `pending`) au battement de heartbeat suivant. Helpers : `insertBorne`/`listBornes` (sans `token_hash`/`token_clear`)/`getBorneById`/`getBorneByHash`/`updateBorne`/`deleteBorne`/`updateBorneHeartbeat`, `listBorneEvents`/`listEventBornes`/`getBorneEvent`/`assignBorneEvent`/`unassignBorneEvent`, `insertBorneCommand`/`claimPendingCommands`/`completeBorneCommand`/`listBorneCommands`. Singleton `_db`. **Migrations versionées** : tableau `MIGRATIONS` appliqué via `runMigrations` + table `schema_migrations` (chaque migration jouée une seule fois ; idempotence interne conservée). |
| `versioning.js` | Historique de config éditoriale. `readSnapshot(edb)` lit **uniquement** `event_meta` + `questions` (jamais sessions/vidéos/invités — RGPD). `captureSnapshot` insère une version si le contenu a changé ; `resolveAuthor` résout l'email depuis `req.user`. Appelé par `events.js` (PUT/config) et `versions.js` (restore). |
| `eventStore.js` | Cache **LRU (10)** de handles `db.sqlite` par événement. `openEventDb` / `closeEventDb` / `closeAllEventDbs`. `closeEventDb` **obligatoire** avant `rm -rf` ou écrasement (§11.11). |
| `eventConfig.js` | Logique d'application config partagée par les 3 sites (`events.js` PUT, `events.js` import, `sync.js` push). `META_KEYS` (source unique des clés `event_meta`) + `applyEventConfig(edb, {mode, meta, questions})` (overwrite/merge). `admin.js` dérive son `META_HASH_KEYS` de `META_KEYS`. |
| `middleware/auth.js` | `requireUser` (vérifie JWT → `req.user`), `requireOwner` (vérifie que `req.user` est superuser OU membre `event_users` → pose `req.event`). |
| `middleware/boxAuth.js` | **Phase B** — `requireBox` résout le header `X-Box-Token` contre **deux** tables : `box_tokens` (preview, token = événement, comportement inchangé) → `req.box = {kind:'preview', token_id, event_id, is_preview}`, `last_seen_at` mis à jour à **chaque requête** ; `bornes` (machine physique) → `req.box = {kind:'borne', borne_id, event_ids:[...]}` (401 si `active=0`) — `last_seen_at`/télémétrie **jamais** touchés ici, uniquement par `POST /borne/heartbeat` (sinon un simple pull nullerait la télémétrie entre deux battements). `boxHasEventAccess(box, eventId)` porte l'invariant §11.20 réécrit (preview : `event_id` unique ; borne : appartenance à `event_ids`) — appelée explicitement à l'endroit exact de chacun des 8 anciens `req.params.id !== req.box.event_id` de `routes/sync.js` (pas un middleware générique : préserve l'ordre existence→scope et les messages d'erreur propres à chaque route). |
| `middleware/validateParams.js` | `validateUuidParams(...names)` : 400 si un param d'URL n'est pas un UUID. |
| `email/mailer.js` | Façade d'envoi (Null Object Pattern). `createMailer(config)` = transport nodemailer SMTP réel ; `createNullMailer()` = no-op qui retourne `{ ok:false, skipped:true }`. Interface : `sendRegistrationLink({to,name,url})` / `sendPasswordReset(...)`. **Injecté via le 3e arg de `createApp(dataDir, opts, { mailer })`** — défaut `createNullMailer()` (aucun test ne touche un SMTP réel ; en démarrage réel, `createMailer(config)` si `smtpHost` sinon null). En cas d'échec SMTP la promesse **rejette** (l'appelant journalise `failed`). |
| `email/render.js` | Moteur de template minimal (`{{var}}`). `renderTemplate(name, data)` charge `templates/<name>.txt`, 1re ligne `Subject:` = sujet, reste = corps → `{ subject, text }`. Variable absente → chaîne vide (jamais de `{{…}}` brut envoyé). |
| `email/url.js` | `buildRegistrationUrl(req, token)` → `…/register?token=<clair>`. Factorise une triple duplication (admin.js ×2 + events.js). Dérive l'origine de `req.protocol` + `req.get('host')` (derrière nginx, `trust proxy=1`) plutôt que d'une variable d'env. |

### Routers (montés dans `index.js`)

| Mount | Fichier | Auth | Contenu |
|-------|---------|------|---------|
| `/api/auth` | `routes/auth.js` | publique (rate-limited) | login (JWT), register (si `ALLOW_REGISTER`), set-password (via registration token), **forgot-password**. `makeAuthRouter({ mailer })` consomme le `mailer`. **`POST /forgot-password`** `{ email }` : réponse **toujours générique** `{ ok, message }` 200 (anti-énumération — jamais de fuite sur l'existence du compte). N'agit que pour un compte **réel ET actif** : crée un `registration_token` court (**1 h**) réutilisant la page `/register?token=`/`set-password`, puis envoi SYNCHRONE `mailer.sendPasswordReset` journalisé `email_logs` (`sent`/`skipped`/`failed`). Aucun token ni log pour un email inconnu/inactif (RGPD). Limites : `forgotLimiter` **10/15 min/IP** + garde **5 min/email** (via `getLatestRegistrationToken`, `created_at` SQLite normalisé en ISO avant calcul). 400 si email absent. |
| `/api/events` | `routes/events.js` | `requireUser` + `requireOwner` | **`PUT /:eventId/design` `{design_id}`** (application d'un design, §11.26) et **`DELETE /:eventId/design`** : 409 si `isContentFrozen(status)`, 403/404 selon la visibilité du design (owner ∪ template ∪ superuser), 409 si un fichier référencé manque côté bibliothèque. **Copie snapshot** : vide `events/<id>/design/`, recopie les fichiers depuis `designs/<designId>/`, puis écrit `event_meta.design` = config sérialisée — **aucun `design_id` n'est conservé côté événement**. ⚠️ `'design'` n'est **PAS** dans `META_KEYS` : ces deux routes écrivent/suppriment la clé `event_meta.design` **directement** (seul endroit autorisé), ce qui garantit le **sens unique Hub → Borne** (un `push-config` borne passe par `applyEventConfig`, qui itère sur `META_KEYS` et ignore donc `design` en lecture comme en écriture). Puis `captureSnapshot` + `triggerPreviewPull`. — Le reste : CRUD événements, config (route `/config` JWT admin, sans appelant UI depuis le retrait du write-back preview), owner, **preview/token + preview/status** (owner), **preview/start + preview/stop** (superuser only — `requireAdmin`), **suppression totale (DELETE, superuser only)** : chaîne `requireUser → requireOwner → requireAdmin` (requireOwner résout `req.event` → 404 prioritaire sur 403). DELETE déprovisionne le container, `closeEventDb` puis `rm -rf events/<id>`, journalise `sync_log` action `delete`, puis `deleteEventVersions` + `deleteJobsForEvent` + `deleteEvent` (ligne registre). `box_tokens`/`event_users`/`event_versions` partent via `ON DELETE CASCADE` ; `jobs` (pas de FK) et `sync_log` (orphelin volontaire, sans PII) sont gérés explicitement. `POST /` réservé superuser (`requireAdmin` local) ; **provisionne la preview dès la création** (statut initial `preview`). Le router accepte un `docker` injectable (`makeEventsRouter(dataDir, { docker })`) — défaut `dockerCli`. **`GET /:eventId/sync`** (Phase B) renvoie en plus `bornes: listEventBornes(db, event.id)` — bornes physiques assignées, à côté de `tokens` (box_tokens événement). |
| `/api/events/:eventId/questions` | `routes/questions.js` | `requireUser` + `requireOwner` | CRUD questions + reorder |
| `/api/admin` | `routes/admin.js` | `requireUser` + **`requireSuperuser`** | gestion comptes clients, box_tokens (génération/liste/révocation), event_users (assignation), overview dashboard, **journal des emails**, **bornes (Phase B)**. **`/bornes`** : `POST` crée (id `randomUUID()`, token `randomBytes(32)`+sha256, `token_clear` retourné une seule fois — même schéma que `POST /events/:id/tokens`) ; `GET` liste (`listBornes`, sans token) ; `GET /:id` fiche = borne + `listBorneEvents` + `listBorneCommands` (20 dernières), sans `token_hash` — mais **avec `token_clear`** : le token en clair reste relisible par un superuser (même précédent que `GET /api/admin/tokens` pour `box_tokens`), le « affiché une seule fois » ne vaut donc que pour l'UI, pas pour l'API ; `PUT /:id` whitelist `name`/`location`/`active` (délégué à `updateBorne`) ; `DELETE /:id` cascade `borne_events`/`borne_commands`. `POST /:id/events` `{event_id}` assigne (**404** événement inconnu, **409** déjà assigné — vérifié via `getBorneEvent` avant insert plutôt que de compter sur l'exception `PRIMARY KEY`) ; `DELETE /:id/events/:eventId` retire. `POST /:id/commands` `{type, payload}` dépose une commande (`type` whitelist `pull`/`activate_event`/`close_event`/`purge_event`, 400 sinon), consommée par le heartbeat borne (§B.3). **`POST /users/:id/send-registration`** : génère un token + URL (`buildRegistrationUrl`) **et** envoie l'email (envoi SYNCHRONE, try/catch englobant, journalisé `email_logs` en `sent`/`skipped`/`failed`), **rate-limited 20/h** (`sendRegistrationLimiter`, anti-amplification d'envoi). Renvoie **toujours** `{ registration_url, email_sent }` — un échec SMTP ne fait jamais échouer la requête (fallback lien copiable). **`GET /email-logs`** : 100 derniers `email_logs` (`listEmailLogs`) pour l'onglet « Gestion email » du front — **RGPD : emails de COMPTES uniquement, aucune PII invité ni token**. |
| `/api/designs` | `routes/designs.js` | `requireUser` | **Bibliothèque de designs (§9bis)**. CRUD (`GET /`, `POST /`, `GET/PUT/DELETE /:id`), **`GET /:id/usage`** (design2 — `canRead` ; liste `{event_id,name,status}` des événements issus du design via `listEventsByDesignSource`, alimente l'avertissement d'usage de l'éditeur), `POST /:id/duplicate`, `POST /:id/promote` + **`POST /:id/demote`** (**superuser only** tous les deux ; `demote` → **409 si `owner_id` est NULL** : un template seed rétrogradé ne serait plus visible de personne), historique (`GET /:id/versions[/:vid]`, `POST /:id/restore`). Gardes locales : `canRead` = owner ∪ template ∪ superuser ; `canWrite` = owner ∪ superuser, et **un template n'est modifiable QUE par un superuser** ; `isSeedTemplate` (= `is_template=1 && owner_id=null`) → **409 sur `DELETE` et sur `demote`** (le seed est un no-op dès que la table est non vide : il ne reviendrait jamais ; et sans propriétaire, un seed rétrogradé serait invisible de tous). `promote`/`demote` renvoient aussi **409 sur no-op** (déjà template / pas template). ⚠️ **Cloisonnement des emails de comptes** : `GET /` renvoie les lignes telles quelles (`withParsedConfig`, sans filtrage) — c'est `listDesigns` qui ne joint `owner_email` que pour un superuser. Pour l'historique, les deux routes de versions passent par **`canSeeAuthor(design, user)`** (superuser ∪ propriétaire) + **`stripAuthor()`** : un client qui lit l'historique d'un **template promu** (donc lisible de tous, mais qui garde son `owner_id`) reçoit `author: null`. Toute nouvelle colonne exposée par ces routes doit être passée au même crible. Toute config entrante repasse par `validateDesign` (core) → 400 (⚠️ **sauf `restore`**, qui réapplique un snapshot déjà validé à l'insertion — si les règles de `validateDesign` se durcissent, un vieux snapshot les contournerait). Historique **append-only** : chaque `PUT` versionne le nouvel état ; `restore` re-versionne l'état courant AVANT de le remplacer (rien n'est perdu) ; `version_id` doit être un entier (sinon 400, pas un 500 de bind SQLite). `POST /` sans `config` repart de `defaultDesignConfig()` (constante, robuste au renommage des templates). Effets disque : `DELETE` fait `rm -rf dataDir/designs/<id>/`, `duplicate` copie le dossier (`cpSync`) — l'id vient **toujours de la base** (ligne trouvée par `getDesign`, 404 sinon), et `designDir()` revalide la forme UUID avant tout accès disque (défense en profondeur anti path-traversal). **Images (design4)** : une seule image par écran (`start`/`thanks`), 3 modes (`centered`/`cover`/`none`). `POST /:id/assets?screen=start\|thanks` (multer disque, **whitelist stricte de mimetypes** `image/png\|jpeg\|webp` — pas de SVG, §11.28 —, nom généré par nous `randomUUID()` + extension **dérivée du mimetype**, limite 2 Mo → 413 via l'error handler ; la garde `loadWritableDesign` est montée **AVANT multer** pour qu'un upload non autorisé ne soit jamais écrit sur disque). L'upload **fixe le mode** : conserve le mode existant s'il est ≠ `none`, sinon `centered` par défaut ; l'ancien fichier de l'écran est supprimé **après** l'écriture en base, §11.9. `DELETE /:id/assets/:screen` retire le fichier **et remet `mode:'none', filename:null`** (cohérence mode/filename imposée par `validateDesign` : jamais un mode ≠ none sans fichier). `GET /:id/assets/:filename` (`requireUser` + `canRead`, **anti path-traversal : le filename doit figurer dans `config.images.<screen>.filename`** — le paramètre d'URL n'est jamais concaténé à un chemin sans avoir été confronté à la config). Le runtime kiosque `apps/borne/server` consomme désormais **le même schéma `images`** (design4, cf. §3 `resolveDesign`). |
| `/api/events/:eventId/versions` | `routes/versions.js` (mergeParams) | `requireUser` + `requireOwner` | liste des versions de config, snapshot + diff champ par champ, **restore** (superuser only). Monté **avant** `/api/events/:eventId` (gallery) pour éviter la capture du segment `versions` comme `videoId`. |
| `/api/sync` | `routes/sync.js` | **`requireBox`** (token preview OU borne) | pull (event/bundle), push (manifest/files/db/finalize), heartbeat status, config push. Le **bundle** (handler `async`) expose en plus **`design_assets: [{filename, size, checksum}]`** (sha256 via `sha256File` de core, tableau vide sans design) ; **`GET /events/:id/design/:filename`** sert chaque asset (403 si l'événement n'est pas dans le scope du token, §11.20 ; **anti path-traversal par confrontation au listing réel du dossier** — `readdirSync` ne rend que des basenames, un `../` ne matche jamais). `GET /event` et `POST /event/login` restent **réservées aux tokens preview** (400 sinon, `req.box.kind==='borne'`) — un token borne n'a pas un seul `event_id`. **Phase B** — routes dédiées aux tokens borne (400 pour un token preview, symétrique) : `GET /borne/events` (liste les événements assignés dont le statut est `ready`/`loaded`, remplace `GET /event` pour ce cas) ; `POST /borne/heartbeat` (`{agent_version, disk:{free,total}, borne_time_ms, active_event_id}` → `updateBorneHeartbeat` + `claimPendingCommands` retourné en `{commands:[...]}` ; **`clock_skew_ms` est calculé côté Hub** (`Date.now() - borne_time_ms`), jamais transmis par la borne — sans RTC (§11.16) elle n'a aucune horloge de référence fiable, seul le Hub (VPS) en a une — **ne touche jamais un statut d'événement**, la transition `ready→loaded` reste portée par `bundle`, par événement §11.10) ; `POST /borne/commands/:id/result` (`{status:'done'\|'failed', result}`, 404 si la commande n'appartient pas à la borne authentifiée — `completeBorneCommand`). |
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
  les **provisionne** s'ils n'existent pas. Cas supplémentaire : si le container existe mais
  qu'un de ses réseaux a disparu (ex. `kapsule_hub_net` recréé par un `docker compose down`/`up`
  du Hub sans reconnexion des previews — `docker start` échouerait alors avec « network … not
  found »), `docker.networksOk(name)` le détecte (comparaison de l'ID réseau attaché au
  container avec l'ID actuel du réseau nommé) et `startPreview` **reprovisionne** : `rm` des 2
  containers + `networkRm` du réseau isolé, puis `provisionPreview` (le volume de données
  `preview-data-<slug>` est **conservé** — pas de purge RGPD sur une simple réparation réseau).
  `networksOk` est optionnel côté client Docker (les mocks de test qui ne l'implémentent pas
  sautent la vérification). Partagé par la route `preview/start` et le script `reconcile-previews`.
  La route `POST .../preview/start` renvoie `provisioned` = `true` sauf si le frontend tournait
  déjà (`exists && running`) au moment de l'appel.
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

Point d'entrée : `index.js` → `createApp(dataDir, cfg)` (ouvre le registre), puis **Phase B** `resolveBorneIdentity()` (lit/sème l'identité persistante). Au boot, deux chemins mutuellement exclusifs selon l'identité résolue : **borne physique** (`hubUrl && borneToken`) → pull one-shot `pullMyEvents()` puis `startHeartbeat()` (boucle `PULL_INTERVAL_MS`, pulls suivants + commandes automatiques) ; **preview / token=événement** (`hubUrl && boxToken`, `borneToken` absent) → pull one-shot `pullMyEvent()` inchangé, pulls suivants déclenchés manuellement depuis `/borne`. Ni l'un ni l'autre → mode autonome.

### Modules transversaux

| Fichier | Responsabilité |
|---------|---------------|
| `config.js` | Env (port, jwtSecret, hubUrl, boxToken, previewMode, maxDataBytes…). **Phase B** — `borneToken` (`BORNE_TOKEN`, identité de borne physique, distincte de `boxToken`) et `pullIntervalMs` (`PULL_INTERVAL_MS`, déf. 300000 — ressuscite une variable déclarée dans `docker-compose.borne.yml` mais lue par aucun code avant Phase B). |
| `registry.js` | Accès à `registry.sqlite` **local** (différent du Hub) : table `local_events` (1 seul `active=1` à la fois) + `push_state`. Helpers `getActiveEvent`, `setActiveEvent`, `updateEventStatus`. **Phase B** — `borne_settings` (`key TEXT PRIMARY KEY, value TEXT`) porte l'identité persistante de la machine (`borne_token`, `hub_url`) ; `getSetting`/`setSetting` (upsert `ON CONFLICT`). |
| `borneIdentity.js` | **Phase B** — `resolveBorneIdentity()` : à appeler après `openRegistry()`, avant tout appel Hub. Au premier démarrage sème `borne_settings` depuis `config.borneToken`/`config.hubUrl` (valeurs d'env) ; aux démarrages suivants la base **prime sur l'env** (mute `config.borneToken`/`config.hubUrl` en place) — permet de faire tourner le token sans redéployer. `hub_url` n'est seedé que si `config.borneToken` est renseigné : no-op total pour une preview (jamais de `BORNE_TOKEN`) et le mode autonome. |
| `eventDb.js` | Cache **mono-handle** du `db.sqlite` de l'événement **actif** (≠ LRU du Hub : la borne ne sert qu'un événement). `getActiveEventDb` / `closeEventDb`. |
| `middleware/auth.js` | `makeAuthRouter` (login → JWT), `requireRole(role)` factory → `requireAdmin`/`requireTech`. Auth par compte nominatif (`event_users` du db.sqlite, pull depuis Hub) avec **fallback `TECH_PASSWORD`** si aucun user (mode autonome). |

### Routers (tous montés sur `/api`)

| Fichier | Contenu |
|---------|---------|
| `routes/events.js` | event actif (`GET /event` config publique — inclut `video_quality` **et `video_orientation`** résolus **override local > event_meta > défaut core**, valeurs normalisées, + `video_width/height/bitrate` issus de `resolvePreset(quality, orientation)`), statut, close, pull/push déclenchés manuellement (tech). **`PUT /api/event/video-quality`** écrit `local_overrides.video_quality` et/ou `local_overrides.video_orientation` (body `{quality?, orientation?}` — les deux optionnels et indépendants, body vide → 400 ; la réponse relit la cascade complète et renvoie le preset effectif) : **sans auth en preview** (borne d'essai démo), garde `requireTech` hors preview, protégée par un `rateLimit` (30 req/min, désactivable en test via `cfg.skipRateLimits`) car la borne preview est Internet-facing. **Design (§9bis, design4)** : `GET /api/event` expose `design` via `resolveDesign(event_meta.design)` — JSON parsé puis **revalidé par `validateDesign`** (→ `null` si corrompu ou hors contrat : le kiosque retombe sur les thèmes figés au lieu de planter). `resolveDesign` reconstruit `images: { start: {mode, filename, widthPercent?}, thanks: {mode, filename, widthPercent?} }` en itérant sur `DESIGN_IMAGE_SCREENS` — chaque `filename` non-null devient une URL `/api/event/design/<filename>` (le front consomme `image.filename` comme `src`/`backgroundImage`), `widthPercent` (design5) n'est propagé que s'il est un entier (`Number.isInteger`, déjà validé en amont par `validateDesign`), et transmet aussi `screenOverrides` au kiosque (corrige un bug préexistant design3 : il n'était jamais propagé côté borne réelle). **`GET /api/event/design/:filename`** (**publique**, comme `GET /api/event`, donc Internet-facing en preview) sert l'image : elle passe elle aussi par **`resolveDesign`** (donc `validateDesign` → une meta corrompue ne sert plus de whitelist pour un `sendFile` arbitraire), dérive sa whitelist des `design.images.<screen>.filename`, **et** ajoute une double garde `isValidAssetFilename(req.params.filename)` (uuid + extension raster) avant de construire le chemin — le paramètre d'URL n'atteint jamais un `join` sans avoir franchi ces deux barrières. |
| `routes/questions.js` | CRUD questions (admin borne) |
| `routes/sessions.js` | création de session invité (publique, ou JWT general si preview avec login), answers, complete, **`POST /api/preview/login`** (proxy auth wall vers Hub, §11.24) |
| `routes/videos.js` | upload vidéo (multipart), liste, stream Range-aware, remplacement (DELETE+INSERT transactionnel), suppression |
| `routes/sync.js` | endpoints déclenchant `pull.js`/`push.js`, status de progression. **Phase B** — `GET /sync/status` expose `tokenKind: 'borne'\|'event'` (identité machine persistante vs token d'événement preview/legacy) en plus du token masqué ; `POST /sync/token` persiste via `setSetting('borne_token', …)` **et** déclenche `pullMyEvents()` quand `config.borneToken` est défini, sinon comportement inchangé (mute `config.boxToken` en mémoire + `pullMyEvent()`). |

### Sync (`sync/`)

| Fichier | Rôle |
|---------|------|
| `hubClient.js` | `hubFetch` / `hubFetchJson` : appels au Hub avec `X-Box-Token`, retry backoff `min(2000·2^(n-1), 30000)`, 5 essais, sur erreurs réseau uniquement (pas 4xx). **`hubFetchBuffer`** (design.E) : même chemin, corps rendu en `Buffer` (assets binaires du design) ; lève sur statut ≥ 400. |
| `pull.js` | `pullMyEvent` (preview/token=événement — récupère l'unique événement du token, **active explicitement** après `pullEvent` pour préserver le comportement historique) → `pullEvent` (écrit questions/meta/users dans db.sqlite, DELETE+INSERT ; **depuis Phase B, ne pose plus `active=1` lui-même** — sorti pour que puller un second événement ne bascule jamais le kiosque hors d'un premier `live`). **Filtre les users `general` du bundle** (seuls `admin_borne`/`tech_borne` sont stockés en `event_users`) et écrit `requires_login` dans `event_meta` (§11.24). Statut local vérifié **au moment d'appliquer** (§11.10). En preview : purge les anciens événements preview. **Étape 6 — `pullDesignAssets`** (§9bis) : `events/<id>/design/` est **rasé puis reconstruit à chaque pull** (un asset d'un design retiré côté Hub ne survit pas), chaque fichier de `bundle.design_assets` est téléchargé (`hubFetchBuffer`) puis **vérifié par sha256 ; un mismatch fait ÉCHOUER le pull** (throw) après avoir supprimé le dossier (invariant §11.27). Le filename de chaque asset (venu du réseau) est **validé par `isValidAssetFilename` AVANT** tout `join`/`writeFileSync` — un `../db.sqlite` fait échouer le pull, jamais une écriture arbitraire. Un bundle sans `design_assets` (Hub non migré) est toléré (`?? []`). `event_meta.design` est écrit à l'étape 5, **avant** le téléchargement, mais un échec (checksum OU filename invalide) déclenche `dropDesignMeta(eventDir)` avant de propager l'erreur → la clé `design` est retirée, le kiosque retombe sur le thème figé au lieu de servir des images 404 (pas d'état partiel). **Phase B — `pullMyEvents(dataDir)`** (borne physique, plusieurs événements assignés) : `GET /api/sync/borne/events` puis boucle `pullEvent()` par événement, chacun protégé individuellement par §11.10 (un événement `live`/`closed` local est *skip*, pas d'erreur globale). N'active **jamais** un événement au détriment d'un autre — seule exception : aucun actif ET un seul pull réussi → activation bootstrap (évite qu'une borne neuve reste bloquée sur l'écran de chargement) ; dès que ≥ 2 événements coexistent, l'activation redevient un choix explicite (console `/borne` ou commande Hub `activate_event`). 400 Hub (route utilisée avec un token preview) → `{pulled:0, results:[]}`, pas une erreur. |
| `push.js` | `pushConfig` (remonte la config vers le Hub) ; `pushEvent` (checkpoint WAL → manifest → upload des `missing` → upload db.sqlite → finalize → statut `pushed`). État de progression dans `_state`. |
| `commandExecutor.js` | **Phase B** — `runCommand(command, dataDir)` exécute une commande reçue au heartbeat (`pull`/`activate_event`/`close_event`/`purge_event`) ; ne lève **jamais** (retourne `{status:'done'|'failed', result}`) pour ne pas faire tomber le heartbeat appelant. Reprend **exactement** les mêmes gardes que les routes HTTP équivalentes (`PUT /events/:id/activate`, `PUT /events/:id/close`, `POST /sync/purge/:eventId`) — en particulier `purge_event` **exige `payload.confirm === event.name`**, la même confirmation par saisie du nom que la route : un déclenchement à distance ne doit jamais contourner cette sécurité (donnée invité supprimée, aucun retour arrière). |
| `heartbeat.js` | **Phase B** — `beat(dataDir)` : un battement = `POST /api/sync/borne/heartbeat` (`agent_version` lu une fois depuis `package.json`, disque via `statfs`, `borne_time_ms: Date.now()` — **jamais de `clock_skew_ms` calculé côté borne**, cf. `boxAuth.js` Hub, §11.16) → exécute chaque commande reçue via `runCommand` → `POST /api/sync/borne/commands/:id/result` (best-effort, `.catch` avalé). **Toujours silencieuse à l'appelant** (try/catch englobant tout le battement) : un Hub injoignable n'est jamais une erreur pour l'opérateur sur place. `startHeartbeat(dataDir)`/`stopHeartbeat()` gèrent un `setInterval(config.pullIntervalMs)` singleton (`unref()` — ne bloque jamais l'arrêt du process), démarré depuis `index.js` uniquement si `hubUrl && borneToken` (borne physique). |

### Frontend borne (`apps/borne/web/src/`)

- **Phase B — deux consoles, deux sessions localStorage, deux auth distinctes** (`App.jsx` route sur `window.location.pathname`, toujours pas de react-router) :
  - **`/admin`** (`AdminPage.jsx`, `admin_token`, rôle `admin_borne`) : ne porte plus que le contenu de l'événement **actif** — onglets Questions (`QuestionManager`), Vidéos (`VideoList`), Design (`DesignPanel`, thème + textes du parcours uniquement).
  - **`/borne`** (`BornePage.jsx`, ex-`TechPage.jsx`, `tech_token`, rôle `tech_borne`, §11.19 inchangé) — la **console machine** : Identité (`IdentityPanel.jsx`, nouveau — connexion Hub, token masqué + rotation, `GET/POST /api/sync/status` et `/token` ; **Phase B étend `/sync/status`** avec `tokenKind: 'borne'|'event'` pour adapter le libellé, et **`/sync/token` persiste désormais en base** — `setSetting('borne_token', …)` — quand `config.borneToken` est défini, au lieu de ne muter que la mémoire comme pour le token preview), Événements (`EventPanel.jsx`, déplacé — active/**clôture** (`api.closeEvent`, câblage du bouton qui n'existait nulle part avant Phase B)/**purge** (déplacée depuis `SyncPanel`, même confirmation par saisie du nom)), Machine (`PreflightPanel.jsx`, déplacé + section Qualité/orientation d'enregistrement déménagée depuis `DesignPanel` — c'est un override **local à la borne**, jamais écrasé par le pull, et `api.setVideoSettings` était de toute façon déjà tech-authentifié), Synchro (`SyncPanel.jsx`, allégé — token/purge partis dans les onglets ci-dessus).
  - **`AdminLayout.jsx`** (partagé) : `fetchHealthFn` paramétrable (`api.adminHealth` client vs `api.techAdminHealth` tech — deux tokens, deux routes santé) ; lien de navigation croisée dans le header (`role==='tech' ? '/admin' : '/borne'`).
  - **`client.js`** : toute méthode consommée par `/borne` doit passer par `techApiFetch` (`api.tech*`), jamais `apiFetch` — `/borne` n'a **jamais** `admin_token` en mémoire (deux sessions localStorage indépendantes). C'était déjà un piège latent avant Phase B (`SyncPanel`/`AdminLayout` sur `/admin/tech` appelaient des méthodes `admin_token`, invisible tant qu'un même navigateur restait connecté aux deux consoles) — corrigé en même temps que le déplacement (`techListEvents`, `techActivateEvent`, `techAdminHealth`). **Seule exception subsistante** : `PreflightPanel` appelle `api.getEvent` (`apiFetch`) — toléré parce que `GET /api/event` est **publique** (aucun middleware d'auth, route kiosque), donc l'absence d'`admin_token` est sans effet ; toute route authentifiée doit rester en `api.tech*`.
  - Pas de « journal des commandes » dans Synchro : les `borne_commands` (§B.3) sont exécutées par le heartbeat en tâche de fond sans trace locale persistée — le journal vit côté Hub (fiche borne, onglet Bornes, §B.6).
- `api/client.js` : appels au backend borne + parcours invité.
- `api/roles.js` : `decodeJwtPayload` + `getRole` (tableau `roles[]`). Testé isolément (`test/roles.test.js`).
- **Écrans du parcours invité + hook caméra : déménagés dans `@kapsule/guest-ui` (designUI.C/D/E).** `apps/borne/web/src/components/guest/` et `apps/borne/web/src/hooks/` n'existent plus. `GuestPage.jsx` importe tous les écrans depuis le barrel `@kapsule/guest-ui` et leur injecte les dépendances borne (`api.createSession`, `api.completeSession`, `uploadVideo`, `guestVideoUrl`) ; `RecordingScreen` est monté **sans** `showcase` (défaut `false`) → comportement kiosque identique à avant. Le hook `useMediaRecorder` (codecs mp4 Safari §11, `resolvePreset` → contraintes `getUserMedia` en `ideal`, `streamSettings.orientation`/`.orientationMismatch`) vit désormais dans `packages/guest-ui/src/useMediaRecorder.js`.
- **`utils/design.js`** (design.F, design3, §9bis ; **designUI.B** : fine couche au-dessus de `@kapsule/guest-ui`) — runtime kiosque du design. `applyDesign(design, screen?)` **nettoie d'abord toutes les `MANAGED_DESIGN_VARS`** de `@kapsule/guest-ui` (sinon les couleurs d'un design précédent survivraient aux clés absentes du suivant) sur `<html>`, puis pose chaque entrée de **`designToVars(design, screen)`** (`@kapsule/guest-ui/src/design.js`) via `setProperty`. `designToVars` est la source **unique** partagée avec l'aperçu Hub (qui la pose en inline sur son wrapper `.kapsule-guest`) : couleurs résolues par **`resolveScreenColors` de core** (surcharge écran > global > absent, design3) qui **itère sur `DESIGN_COLOR_KEYS`, jamais sur les clés reçues** (une clé hostile ne peut pas devenir une custom property, §11.28) ; rayons/police depuis `RADIUS_PRESETS`/`FONT_PRESETS` de **core**. Le 2ᵉ paramètre `screen` est **optionnel** (omis/inconnu → couleurs globales, comportement d'avant design3, rétrocompatible). `applyDesign(null)` retire tout → le thème figé (`data-theme`) reprend la main. `imageWidthStyle` est ré-exporté depuis `@kapsule/guest-ui` (déplacé là, design5 inchangé).
- **Scope CSS `.kapsule-guest` (designUI.B)** : le CSS des écrans invité vit dans `@kapsule/guest-ui/guest.css` (importé par `main.jsx` **avant** `app.css`), chaque règle **préfixée `.kapsule-guest`**. `App.jsx` enveloppe la seule branche `<GuestPage>` dans `<div className="kapsule-guest">` — l'admin/tech borne (`.admin-layout`, `AdminLogin`) est **hors** de ce wrapper. ⚠️ **Conséquence** : les classes génériques (`.btn`, `.btn--primary/secondary/large/small/ghost`, `.text--muted/error`, `.screen*`, `.name-form*`) utilisées **à la fois** par le parcours invité et par l'admin doivent rester **aussi** définies non préfixées dans `app.css` (même précédent que `.btn--danger`/`.modal*`, dupliqués volontairement), sinon l'admin (hors wrapper) perd leur style. Le thème (`[data-theme]` sur `<html>`) est hérité normalement par `.kapsule-guest`, descendant DOM normal. Appelé par un `useEffect([screen, event])` de `GuestPage` qui **réévalue le design à chaque changement d'écran** (une surcharge par écran ne prend effet que si `applyDesign` est rappelée avec l'écran courant — via la table `DESIGN_SCREEN_BY_STATE` état runtime → `DESIGN_SCREENS`) ; l'appel unique d'antan dans `loadEvent` a été retiré. Un état sans entrée dans la table (LOADING/ERROR/CLOSED/…) passe `screen=undefined` → couleurs globales, pas de crash. Testé isolément (`test/design.test.js`).
- Image par écran (`design.images.<screen>`, design4) : `StartScreen` et `ThankYouScreen` lisent `design.images.start`/`.thanks` = `{mode, filename, widthPercent?}`, 3 modes (`centered`/`cover`/`none`). En `cover` l'image est posée en fond (inline `backgroundImage: url("…")`) ; en `centered` en `<img className="screen__image">` ; en `none` rien (rendu identique à avant les designs). La classe racine devient `start--<mode>`/`thanks--<mode>`. L'URL (`image.filename`) vient de `resolveDesign` (donc d'un filename validé) — jamais une chaîne libre. **`widthPercent` (design5, mode `centered` uniquement)** : `imageWidthStyle(image)` (`utils/design.js`) produit un style inline `{width, maxWidth: '<n>%', maxHeight: 'none'}` — largeur prioritaire qui lève le plafond `max-height` par défaut de `.screen__image` ; absent → `undefined`, CSS par défaut inchangé. Le pourcentage n'est jamais concaténé dans une expression CSS, seulement en `<n>%` (§11.28). Le layout `split` (et `.start__aside`/`.start__logo`) a été retiré.
- ⚠️ **Isolation de l'admin borne** : `.admin-login, .admin-layout` redéfinit **tous les tokens** (couleurs + `--radius`/`--radius-pill`) sur un élément plus profond que `<html>` → un design est neutralisé par héritage CSS. **Mais la police** est appliquée par `body { font-family: var(--font-body, <stack historique>) }` : elle n'est pas un token de ce bloc, donc un design en « rounded » déteindrait sur l'admin. Le bloc `.admin-login, .admin-layout` **refixe donc `font-family` explicitement**. Ne pas retirer cette ligne. Le fallback de `var(--font-body, …)` garantit qu'un événement **sans design** rend exactement comme avant.

### Frontend Hub (`apps/hub/web/src/`)

- `api/client.js` : appels au backend Hub (fetch + token Bearer). Ré-importe `roles.js` pour `getRole`.
- `api/roles.js` : `decodeJwtPayload` + `getRole` (scalaire `role` — ≠ borne qui retourne un tableau `roles`). Testé dans `test/roles.test.js`.
- `utils/format.js` : formateurs purs (`formatBytes`, `formatDate`, **`formatSqlDate`**, `formatDuration`, `formatSize`, `isPortrait`) extraits de `AdminPage.jsx`/`VideoGallery.jsx`. Testés dans `test/format.test.js`.
- `pages/AdminPage.jsx` et `components/VideoGallery.jsx` importent `format.js` (plus d'inline).
- **`pages/AdminPage.jsx` — onglet Bornes (Phase B)**, remplace l'ancien placeholder : `BornesTab` (liste, pattern accordéon `ev-row` réutilisé de `EventsTab`) → `BornePanel` par ligne dépliée (assignation d'événements avec commandes Activer/Clôturer inline, dépôt de commande `pull`, journal des `borne_commands` de la fiche `GET /admin/bornes/:id`, suppression). `CreateBorneForm` affiche le `token_clear` **une seule fois** (même pattern que `TokensTab`/`dockerCmd`, `BORNE_TOKEN=… docker compose -f docker-compose.borne.yml …`). Pastille en ligne/hors ligne calculée **côté front** (`isBorneOnline`, seuil fixe 10 min — le Hub ne connaît pas `PULL_INTERVAL_MS`, réglage borne). Le Dashboard renomme ses cartes `boxes` (`box_tokens`) en « Tokens événement »/« Tokens d'essai » pour ne plus entrer en collision avec cette nouvelle notion de borne physique.
- **`components/SyncStatus.jsx` (onglet Synchro d'un événement)** — section « Bornes physiques » (`BorneAssignment`, miroir de `BornePanel` : assigner/retirer une borne parmi celles sans assignation) alimentée par `GET /api/events/:eventId/sync` étendu (`bornes: listEventBornes(...)`, Phase B). Corrigé au passage un bug pré-existant : la section « Borne assignée » lisait `info.box`, un champ **jamais renvoyé** par cette route (seul `tokens`, un tableau, existe) — toujours vide en pratique. Remplacée par une vraie section « Tokens de borne » sur `tokens`.
- `pages/DesignsPage.jsx` (route `/designs`, sous `RequireAuth` ; lien « Designs » dans l'en-tête d'`EventsPage`, `AdminPage` et `EventDetailPage`) : bibliothèque de designs (§9bis). Le `<main>` porte `hub-main--wide` (1400px au lieu des 960px standard — form + aperçu + historique n'y tiennent pas sinon). **Pas de router imbriqué** — un state `selectedId` bascule liste ↔ détail. Liste : « Mes designs » / « Templates » / (superuser) « Tous les designs » **groupés par `owner_email`** (champ que seul un superuser reçoit — cf. `listDesigns`). Cartes → Dupliquer / Renommer / Supprimer / Promouvoir / Rétrograder (`window.prompt`/`confirm`). Détail : `DesignEditor` + `VersionHistory`. Les gardes front (`canEdit`, `isSeed`) **miroitent** `canWrite`/`isSeedTemplate` du backend mais ne s'y substituent pas (le backend refuse en 403/409 de son côté).
- `components/designs/` (§9bis) :
  - `DesignEditor.jsx` — formulaire contrôlé des tokens. **Aucune saisie CSS libre** : couleurs par `<input type="color">` natif (+ champ hex texte pour l'alpha, l'input color ignorant le canal alpha → `toPickerValue()` ne lui montre que les 6 premiers hex), rayons/police par `<select>`, layouts par radios — les listes viennent des enums de core. La validation client utilise **`validateDesign` de core, la même fonction que le backend** (aucun écart de règle possible) ; « Enregistrer » est désactivé tant que la config est invalide, et un échec serveur restaure la config précédente. **Onglets Couleurs (design3)** : « Global » (édite `colors` racine, JSX inchangé) + un onglet par `DESIGN_SCREENS` (édite `screenOverrides.<screen>.colors`) ; sur un onglet écran chaque couleur affiche un badge « Hérite (valeur résolue) » + bouton « Détacher », ou l'état détaché (picker/hex + « Re-hériter »). `unsetScreenColor` fait un `delete` explicite (pas d'`undefined`). L'aperçu bascule sur l'écran de l'onglet actif.
  - `DesignPreview.jsx` — **monte les VRAIS écrans du parcours invité** (`StartScreen`/`NameInput`/`RecordingScreen`/`ThankYouScreen` de `@kapsule/guest-ui`, chantier designUI.F) au lieu d'une maquette `.dp-*` indépendante (l'ancienne réimplémentation et son CSS `.dp-*` ont été supprimés ; seul `.dp-pulse`/`@keyframes dp-pulse` — outil d'éditeur, pas du rendu — survit). Pas d'iframe (la CSP edge bloque `frame-ancestors`) : les écrans sont montés directement dans l'arbre React du Hub, dans un wrapper `<div className="kapsule-guest design-preview">` — double classe : `.kapsule-guest` applique le scope CSS partagé (`guest.css`, importé par `main.jsx` **avant** `app.css`), `.design-preview` porte l'aspect-ratio 4/3 + `overflow:hidden` (app.css, Hub). Le design édité est posé en **custom properties INLINE** sur ce wrapper via **`designToVars(config, screen)`** de `@kapsule/guest-ui` (remplace `cssVarsFor`, supprimée) — **jamais sur `document.documentElement`**, donc aucune pollution du reste du Hub ; `designToVars` résout les couleurs par `resolveScreenColors` de core (surcharge écran > global > absent) en itérant sur `DESIGN_COLOR_KEYS`, jamais sur les clés reçues, et lit rayons/polices dans `RADIUS_PRESETS`/`FONT_PRESETS` de core — c'est la **source unique** partagée avec le runtime kiosque (`applyDesign`), plus de dérive possible. Bascule de largeur 360/820/1280 (cadre à la largeur cible, réduit par `transform: scale()` dans un wrapper `overflow:hidden`) ; facteur d'échelle **mesuré** sur le conteneur (`ResizeObserver` + `useLayoutEffect`, `clientWidth / target.width`, pas de nombre magique CSS) ; hauteur du viewport = `target.width * 3/4 * scale`. Sur desktop (`@media (min-width: 1100px)`), `.designs-editor` passe en 2 colonnes (réglages 420px à gauche, aperçu `position: sticky` à droite). Contenu de démonstration : `DEMO_EVENT`/`DEMO_QUESTION` (données **fictives**, mêmes textes que l'ancienne maquette — aucune PII invité réelle, tout client-side, rien de persisté). `RecordingScreen` est monté avec la prop **`showcase`** (aucun `getUserMedia`, placeholder caméra) ; `NameInput` reçoit `createSession={fakeCreateSession}` (id factice, zéro réseau) + `onSession`/`onBack`/`onClosed` no-op ; `ThankYouScreen` reçoit `onRestart` no-op (son décompte 15 s boucle silencieusement, accepté). `resolveAssetUrl` = `designId ? (f) => api.designAssetUrl(designId, f) : (f) => f` — sans `designId` (design pas encore sauvegardé) l'identité est passée, pas de crash ; la route `GET /api/designs/:id/assets/:filename` (`requireUser`, `?token=`) sert le vrai asset. Pulsation d'aide à l'édition : `hoverTarget = {screen, key}` (posé au clic sur une ligne couleur de `DesignEditor`, table `COLOR_TARGET`) bascule l'aperçu sur l'écran et pulse (`.dp-pulse`) l'élément marqué `data-color-target={key}` trouvé par `querySelector` dans `previewRef` (le wrapper `.kapsule-guest`). Les écrans réels portent désormais ces `data-color-target` (ajoutés designUI.F sur `StartScreen`/`NameInput`/`RecordingScreen`/`ThankYouScreen`/`QuestionNav`) — **inertes côté kiosque** (jamais lus par le CSS/JS borne). ⚠️ **Dégradation silencieuse volontaire** : un couple `{screen,key}` sans `data-color-target` atteignable ne pulse simplement rien (`if (!el) return`). Cas connus pour l'écran `recording` (5 cibles dans `COLOR_TARGET`) : l'auto-pulse tire au moment du clic, alors que `RecordingScreen` est à son sous-état INTRO — seul `surface-alt` (placeholder caméra) y porte un `data-color-target`, donc seul lui pulse. `text-error` (barre REC) EST désormais rendu en `showcase` — la branche `S.RECORDING` est atteignable depuis designUI (cycle simulé intro→countdown→recording factice→preview→intro, sans caméra ni enregistrement réel) — mais uniquement après que l'utilisateur a manuellement cliqué « Commencer » puis attendu le décompte ; il ne pulse donc pas via l'auto-pulse. `primary`/`primary-tint` (`QuestionNav`) et `accent-soft` (aucun `data-color-target`) ne pulsent pas non plus.
  - `VersionHistory.jsx` — liste des versions (badge « Actuelle » sur la 1re), bouton Restaurer ; affiche « inconnu » quand `author` est `null` (cas d'un client lisant l'historique d'un template promu).
- ⚠️ **Dates SQLite** : `designs`/`design_versions`/`event_versions` stockent `datetime('now')` (UTC **sans suffixe `Z`**). `formatDate` fait `new Date(d)` → interprété en heure **locale** : à ne PAS utiliser sur ces colonnes — utiliser **`formatSqlDate`** (ajoute le `Z`), employé par `DesignsPage` et `VersionHistory`. Reste une duplication inline dans `EventDetailPage.jsx:409` (versions d'événement) — dette connue.

> **Différence borne vs hub pour `roles.js`** : la borne encode un tableau `roles: ['admin_borne', 'tech_borne']` ; le Hub encode un scalaire `role: 'superuser'`. Les deux `roles.js` ont la même API (`getRole`) mais ne sont pas interchangeables.

---

## 4. Core (`packages/core/src/`)

Importé via le barrel `index.js` qui **ne ré-exporte que** `constants.js` + `validate.js` + `design.js`
(les modules à dépendance native/node sont importés par chemin direct, pas depuis le barrel) :

| Fichier | Contenu | Exporté par le barrel ? |
|---------|---------|------------------------|
| `constants.js` | `EVENT_STATUS`, `STATUS_ORDER`, `JOB_TYPES`, `LIMITS`, `THEMES`, `DEFAULTS`, `TEXT_FIELDS`, **`VIDEO_QUALITY`** — table **indexée par orientation** : `VIDEO_QUALITY[orientation][qualityKey] → {label,width,height,videoBitrate}` (orientations `paysage`/`portrait`, presets `eco`/`standard`/`haute`/`max`) —, **`VIDEO_ORIENTATIONS`** (`['paysage','portrait']`), **`DEFAULT_VIDEO_ORIENTATION`** (`paysage`), **`QUALITY_KEYS`**, **`DEFAULT_VIDEO_QUALITY`** (`standard`), **`AUDIO_BITRATE`**, **`resolvePreset(qualityKey, orientation)`** (retombe toujours sur le défaut, jamais `undefined`), **`mbPerMinFromKey(qualityKey, orientation?)`** — source unique partagée Hub/Borne/kiosque | ✅ |
| `validate.js` | validateurs (guest name, question…) | ✅ |
| `design.js` | Contrat d'un design (§9bis) : `DESIGN_COLOR_KEYS` (18), `DESIGN_RADIUS`, `DESIGN_FONTS`, `DESIGN_SCREENS` (design3 : `['start','name','recording','thanks']`), `DESIGN_IMAGE_SCREENS` (design4 : `['start','thanks']`), `DESIGN_IMAGE_MODES` (`['centered','cover','none']`), `DESIGN_IMAGE_WIDTH_MIN`/`DESIGN_IMAGE_WIDTH_MAX` (design5 : `10`/`100`, bornes du `widthPercent` — source unique partagée par le `<input type="range">` de l'éditeur et la validation), `DESIGN_KEYS` (whitelist **racine** : `version`/`colors`/`radius`/`font`/`images`/`screenOverrides` — `layouts`/`assets` retirés design4), `DESIGN_VERSION`, `DESIGN_MAX_JSON` (16384), **`RADIUS_PRESETS` / `FONT_PRESETS`** (preset d'enum → valeur CSS réelle : source **unique** partagée par l'aperçu de l'éditeur Hub et le runtime kiosque — un test core garde l'invariant « chaque valeur d'enum a son preset », sinon le runtime resterait sans valeur CSS) + **`validateDesign(obj)`** → `{ok:true} \| {ok:false,error}` + **`resolveScreenColors(config, screen)`** (design3 : couleurs effectives d'un écran = surcharge `screenOverrides.<screen>` > `colors` global > absent ; itère sur `DESIGN_COLOR_KEYS`, jamais sur les clés reçues — source **unique** partagée par le runtime kiosque et l'aperçu Hub). La validation des `screenOverrides` réutilise le helper factorisé `validateColorsObject` (mêmes règles que `colors` racine). **C'est LA barrière anti-injection CSS (§11.28)** : hex strict (`#rrggbb[aa]`), enums fermées, `images.<screen>.filename` au format `<uuid>.png\|jpg\|webp` (jamais de chemin, jamais de SVG ; cohérence stricte mode/filename : `none` ⇒ `filename` null, tout autre mode ⇒ fichier obligatoire), **`images.<screen>.widthPercent` (design5, seul champ numérique du contrat)** : entier strict borné `[10,100]`, permis **uniquement** en mode `centered` — sûr au même titre qu'une enum (jamais interprété comme CSS libre, consommé seulement en `<n>%`), taille ≤ 16 Ko. La validation itère sur **nos** listes de clés (jamais sur les clés reçues) et rejette toute clé inconnue. Fonction **pure, sans dépendance node** → importable par le backend Hub *et* les deux fronts (l'éditeur Hub valide avant envoi, le backend revalide toujours). | ✅ |
| `eventDbSchema.js` | `createEventDb(path)` : schéma complet de `db.sqlite` + seed des 4 questions par défaut | ❌ (import direct — better-sqlite3 natif) |
| `checksum.js` | `sha256File` | ❌ (import direct — node:crypto/fs) |

**Schéma de `db.sqlite`** (identique Borne/Hub) : `event_meta`, `questions`, `sessions`,
`videos` (UNIQUE session+question → 1 réponse par question/session), `derived`
(miniature/durée/dimensions, 1-1 avec videos), `event_users` (email/hash/roles — peuplé au pull),
`local_overrides` (key/value — **réglages locaux à la borne, jamais écrasés par le pull** ;
contrairement à `event_meta` que `pull.js` fait `DELETE`+`INSERT`). Clés actuelles : `video_quality`
et `video_orientation` (réglages d'enregistrement choisis sur place, survivent aux pulls de config Hub).

> ⚠️ **Piège `VIDEO_QUALITY`** : la table est indexée **par orientation**, donc
> `Object.keys(VIDEO_QUALITY)` retourne `['paysage','portrait']`, **pas** les clés de qualité.
> Pour valider une `video_quality`, utiliser **`QUALITY_KEYS`** ; pour lire un preset, utiliser
> **`resolvePreset(qualityKey, orientation)`** (jamais `VIDEO_QUALITY[qualityKey]`, forme à plat
> qui n'existe plus).

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
`GET /api/sync/events/:id/bundle` (questions + meta + users + `design_assets`, passe `ready`→`loaded`) →
écriture dans `db.sqlite` local → **téléchargement des assets du design** (`GET /api/sync/events/:id/design/:filename`,
un par un, **checksum sha256 vérifié ; mismatch = échec du pull**, §11.27) dans `events/<id>/design/`.
Les superusers reçoivent tous les rôles borne.

**Design (Hub → Borne, sens unique, §9bis / §11.26)** : bibliothèque `designs/<designId>/` +
`registry.designs` (Hub) → `PUT /api/events/:id/design` **copie** config + fichiers dans
`event_meta.design` + `events/<id>/design/` (**snapshot, la copie reste figée**) → bundle de pull
→ `events/<id>/design/` de la Borne → `GET /api/event` (`resolveDesign` revalide) → `applyDesign()`
pose les custom properties sur `<html>` du kiosque. **Rien ne remonte** : `'design'` est hors
`META_KEYS`, donc `push-config` (Borne → Hub) ne peut ni écrire ni effacer `event_meta.design`.
La logique de copie fichiers+config vit dans **un seul helper exporté `materializeEventDesign()`**
(`routes/events.js`) — partagé par l'application manuelle et le rafraîchissement automatique ci-dessous.

**Trace de provenance + borne d'essai vivante (design2, §9bis)** : `PUT /api/events/:id/design` pose
en plus une **provenance** — `event_meta.design_source_id` (dans la db événement) **et** une ligne
`event_design_refs` (registre, `event_id`→`design_id`). Ce n'est **PAS** une référence vivante : la
copie reste figée (§11.26). La provenance sert uniquement à retrouver les événements **en statut
`preview`** issus d'un design quand celui-ci est édité : après `PUT /api/designs/:id` (si `config`
change) ou un upload/suppression d'asset, `refreshPreviewEvents()` (`routes/designs.js`) re-matérialise
via `materializeEventDesign()` **uniquement les events `preview`** (`status !== 'preview'` → ignoré,
un événement `ready`+ n'est **jamais** touché — invariant §11.26) puis déclenche `triggerPreviewPull`.
`DELETE /api/designs/:id` **détache** les refs (la copie figée survit, l'événement n'est plus
rafraîchissable) ; la suppression d'un événement purge la ref par `ON DELETE CASCADE`.
**`design_source_id` est Hub-only** : le bundle de pull le `delete` explicitement de `meta`
(`routes/sync.js`) — la Borne ne le reçoit jamais (testé). `restoreEventDesign` restaure
`design_source_id` (event_meta) mais **PAS `event_design_refs`** (registre non disponible à cet
endroit) : limite assumée et documentée (au pire un rafraîchissement preview mal ciblé, jamais une
altération d'un événement non-preview ni une fuite). **RGPD** : `event_design_refs` = deux ids, zéro
donnée invité.

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
- **3 routes servent des fichiers de design** — aucune ne construit un chemin depuis l'URL sans confrontation préalable : `GET /api/designs/:id/assets/:filename` (Hub, vs `config.images.<screen>.filename`), `GET /api/sync/events/:id/design/:filename` (Hub, vs `readdirSync` du dossier), `GET /api/event/design/:filename` (Borne, **publique**, vs `event_meta.design.images.<screen>.filename`). Toute nouvelle route servant un fichier doit suivre le même patron (whitelist, jamais `join(dir, req.params.x)` nu).
- **Design = snapshot, jamais référence** (§11.26) et **`'design'` hors `META_KEYS`** (sens unique Hub → Borne) — casser l'un des deux réintroduit un couplage entre bibliothèque et événements passés.
