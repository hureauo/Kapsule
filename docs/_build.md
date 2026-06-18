# Documentation Kapsule — Journal de construction

Ce fichier est interne au processus de génération. Il trace l'analyse du code et l'état d'avancement.

---

## État d'avancement

- [x] Lecture : `packages/core/` (constants, validate, eventDbSchema, checksum, index)
- [x] Lecture : `apps/hub/server/src/config.js`
- [x] Lecture : `apps/hub/server/src/registry.js`
- [x] Lecture : `apps/hub/server/src/eventStore.js`
- [x] Lecture : `apps/hub/server/src/middleware/auth.js`
- [x] Lecture : `apps/hub/server/src/middleware/boxAuth.js`
- [x] Lecture : `apps/hub/server/src/middleware/validateParams.js`
- [x] Lecture : `apps/hub/server/src/index.js`
- [x] Lecture : `apps/hub/server/src/routes/auth.js`
- [x] Lecture : `apps/hub/server/src/routes/events.js`
- [x] Lecture : `apps/hub/server/src/routes/questions.js`
- [x] Lecture : `apps/hub/server/src/routes/sync.js`
- [x] Lecture : `apps/hub/server/src/routes/gallery.js`
- [x] Lecture : `apps/hub/server/src/routes/admin.js`
- [x] Lecture : `apps/borne/server/src/config.js`
- [x] Lecture : `apps/borne/server/src/middleware/auth.js`
- [x] Lecture : `apps/borne/server/src/index.js`
- [x] Lecture : `apps/borne/server/src/registry.js`
- [x] Lecture : `apps/borne/server/src/eventDb.js`
- [x] Lecture : `apps/borne/server/src/routes/events.js`
- [x] Lecture : `apps/borne/server/src/routes/sessions.js`
- [x] Lecture : `apps/borne/server/src/routes/videos.js`
- [x] Lecture : `apps/borne/server/src/routes/questions.js`
- [x] Lecture : `apps/borne/server/src/routes/sync.js`
- [x] Lecture : `apps/borne/server/src/sync/push.js`
- [x] Lecture : `apps/borne/server/src/sync/pull.js`
- [x] Lecture : `apps/borne/server/src/sync/autoPull.js`
- [x] Lecture : `apps/borne/server/src/sync/hubClient.js`
- [x] Lecture : `apps/hub/server/src/worker/` (index, ffmpeg, probe, thumbnail, archive)
- [x] Lecture : `apps/hub/web/src/api/client.js`
- [x] Lecture : `apps/borne/web/src/api/client.js`
- [x] Lecture : `apps/borne/web/src/hooks/useMediaRecorder.js`
- [x] Lecture : fichiers de test (auth.test.js — pattern représentatif)
- [x] Lecture : `docker-compose.yml`
- [x] Lecture : `package.json` racine
- [x] Génération : ossature complète (index.html, assets/*, pages.js)
- [x] Génération : 51 pages de contenu (Démarrer + 7 sections)
- [x] Vérif : correspondance manifeste/fichiers (51=51, 0 manquant, 0 en trop)
- [x] Vérif : 0 lien interne mort
- [x] Vérif : rendu visuel (Chrome headless) — accueil, docker, eventDbSchema, invariants, mode deep
- [x] Ajout : toggle global Synthétique/Approfondi (localStorage, body.mode-synth/deep)

## TERMINÉ
Documentation complète et vérifiée. Pour lire : `cd docs && python3 -m http.server` puis localhost:8000.

## Sync incrémentale — db32702 (thèmes commutables du parcours invité)
- core-constants : ajout `THEMES` + `DEFAULTS.THEME`, encadré « liste blanche » + RGPD, ligne API.
- borne-routes-events : `theme` à la création, nouvelle section `PUT /events/:id/settings`
  (gardes 404/400/409/401, upsert event_meta), callout 409 (cache 1 slot) + callout config/RGPD,
  `theme` dans `GET /event`, ligne API.
- web-client-borne : ajout `updateEventSettings`, correction du test `Content-Type` d'`apiFetch`
  (corps plutôt que jeton), ligne API.
- pages.js : enrichi `js` de core-constants et borne-routes-events (recherche).
- Hors scope doc (aucune page UI) : app.css, QuestionNav.jsx, RecordingScreen.jsx, GuestPage.jsx,
  EventPanel.jsx ; tests events.test.js couverts par le pattern générique de tests-runner.
- Vérifs : manifeste/fichiers OK (0/0), liens internes OK, `node --check pages.js` OK.

## Sync incrémentale — V2 parcours invité (textes éditables + nav repensée)
- core-constants : ajout `DEFAULTS.WELCOME_*/NAME_PROMPT/CONSENT_DETAILS/THANKS_TEXT`,
  `TEXT_FIELD_MAX`, `TEXT_FIELDS` dans la lecture ; paragraphe « source unique + fallback dynamique »,
  ligne API TEXT_FIELDS/TEXT_FIELD_MAX.
- borne-routes-events : route `PUT /settings` étendue (validation des champs texte itérés sur
  TEXT_FIELDS, upsert préparé une fois rejoué, réponse résolue) ; `GET /event` enrichi des textes +
  explication des fallbacks dynamiques welcome_* ; API table mise à jour.
- borne-middleware-auth : `Buffer.from(String(a))` DÉJÀ documenté (conversion défensive) → aucun
  changement nécessaire (le diff applique exactement ce que la page décrit).
- pages.js : enrichi `js` de core-constants et borne-routes-events.
- Hors scope doc (aucune page UI dédiée) : GuestPage/NameInput/StartScreen/ThankYouScreen/
  QuestionNav/RecordingScreen/EventPanel.jsx, app.css ; design/parcours-invite.md (doc projet, pas docs/) ;
  tests events.test.js couverts par le pattern générique de tests-runner.
- Vérifs : manifeste/fichiers OK, liens internes OK, `node --check pages.js` OK.

## Sync incrémentale — Phase 6A (admin Borne client/tech) + V2.9 (nav parcours invité)
- Diff base : `302aeee..HEAD` (commits 6A.1→6A.4, V2.9). Périmètre code réellement implémenté =
  **Borne uniquement** (admin deux rôles + nav invité). Phases 6B/6C/6D (Hub, token=événement,
  preview) PAS codées dans ce lot (cases ROADMAP non cochées) → invariants §11.20/21/22 non documentés
  comme implémentés (note de périmètre ajoutée dans invariants.html).
- borne-config : ajout `techPassword`/`TECH_PASSWORD` (extrait + table env) ; callout « un seul admin »
  réécrit en « deux mots de passe par rôle » (§11.19).
- borne-middleware-auth : login signe `client|tech` (deux `safeCompare`, callout endpoint unique) ;
  `extractToken` factorisé ; `requireAdmin` accepte client OU tech, nouveau `requireTech` (403 jeton
  client) ; callout danger §11.19 ; callout S5.2 mis au pluriel ; table d'API.
- borne-index : `routerCfg` injecte aussi `requireTech` (extrait + js-note + callout).
- borne-routes-events : `/close` et `/preflight` re-taggés `authTech` (intro trois niveaux, extrait
  preflight, table d'API colonne auth client/tech).
- borne-routes-sync : auth = `requireTech` (callout danger §11.19 en tête + note avant table d'API).
- web-client-borne : section « deux jetons / deux wrappers » (apiFetch vs techApiFetch, save/clear/is*
  par rôle, mapping api.* client/tech) ; retrait du commentaire « pas de token » obsolète ; table d'API.
- invariants : nouvel item §11.19 + note de périmètre (§11.20/21/22 à venir) ; comptage « 18 » retiré.
- Hors scope doc (aucune page UI dédiée — convention : seuls client.js/hooks sont documentés côté front) :
  App.jsx (routing manuel), AdminPage/TechPage/DesignPanel/EventPanel/AdminLayout/AdminLogin.jsx,
  QuestionSheet.jsx (nouveau), QuestionNav.jsx, GuestPage.jsx (V2.9), app.css ; tests *.test.js couverts
  par le pattern générique de tests-runner.
- pages.js : inchangé (aucune notion JS nouvelle à indexer ; les fichiers touchés sont des composants UI
  sans page, et les pages existantes gardent leurs notions).
- Vérifs : manifeste/fichiers OK, liens internes OK, `node --check pages.js` OK.

## Sync incrémentale — Phase 6C (Hub : super-admin UI + modèle token=événement)
- Diff base : `git diff HEAD`. Périmètre code = **Hub** : `box_tokens` remplace `boxes` +
  `events.box_id`, `GET /sync/event` remplace `/assigned`, `req.box={token_id,event_id,is_preview}`,
  gardes 403 §11.20 sur chaque route sync, routes admin tokens (POST/GET /events/:id/tokens,
  DELETE/PUT /tokens/:tokenId), front `pullAssigned→pullMyEvent`, `getRole` + route `/admin`.
- hub-registry : schéma events sans `box_id` ; nouvelle section table `box_tokens` (ON DELETE
  CASCADE, token=événement, plusieurs tokens/événement, is_preview) ; `sync_log` sans `box_id` ;
  `updateEvent` allowed sans `box_id` ; inventaire fonctions `box_tokens` (insert/list/getById/
  getByHash/update/updateSeen/delete) ; intro tables users/box_tokens/events/jobs/sync_log.
- hub-middleware-box : import + extrait `requireBox` (getBoxTokenByHash/updateBoxTokenSeen,
  `req.box={token_id,event_id,is_preview}`), callout danger §11.20, table `boxes`→`box_tokens`,
  API table (req.box shape + last_seen_at sur box_tokens).
- hub-routes-admin : intro (tokens par événement) ; section génération token (POST /events/:id/tokens,
  404 event) ; callout « clair une fois » ; section lister/révoquer/renommer (GET/DELETE/PUT) +
  js-note destructuring rest mise à jour ; overview (box_tokens sous clé `boxes`) ; API table refaite.
- hub-routes-events : intro sans « assigner une borne » ; `/sync` renvoie `tokens` (plus `box`) ;
  ligne API `PUT /assign` supprimée.
- hub-routes-sync : table étapes (GET /event remplace /assigned, bundle 403) ; nouvelle section
  §11.20 (extrait GET /event + garde 403, callout danger).
- borne-sync-pull : section `pullAssigned`→`pullMyEvent` (extrait réel, GET /sync/event, 404→0) +
  js-note « 404 comme cas normal » ; intro + API table.
- borne-sync-autopull : intro + extrait runCycle (`pullMyEvent`).
- borne-routes-sync : pull manuel (`pullMyEvent`).
- web-client-hub : ajout `getRole` (extrait + js-note décodage JWT base64url, danger garde serveur) ;
  API table (getRole + méthodes createBoxToken/listBoxTokens/deleteBoxToken/updateBoxToken,
  `assignBox` disparu).
- flux-push-pull : Phase A (génération token par événement, plus d'assignation) ; Phase B
  (`pullMyEvent`, GET /sync/event).
- invariants : callout périmètre révisé (§11.20 désormais implémenté ; §11.21/22 restent à venir) ;
  nouvel item §11.20 dans Synchronisation.
- arch-deux-apps + glossaire : `boxes`→`box_tokens` dans la liste des tables registry Hub.
- pages.js : enrichi `js` de hub-registry, hub-middleware-box, hub-routes-admin, borne-sync-pull,
  web-client-hub (recherche).
- Hors scope doc (aucune page UI dédiée — convention : seuls client.js/hooks documentés côté front) :
  App.jsx (route /admin + RequireAdmin), AdminPage.jsx (onglets Overview/Events/Clients,
  TokenGenerator), app.css ; ROADMAP.md (cases 6C cochées, pas docs/) ; tous les *.test.js couverts
  par le pattern générique de tests-runner. RegisterPage.jsx : pas dans ce diff (déjà commité 6B).
- Vérifs : manifeste/fichiers OK (51/51), liens internes OK (0 mort), `node --check pages.js` OK.

## Sync incrémentale — Phase 6D (borne d'essai : preview / quota / reset)
- Diff base : `git diff HEAD`. Périmètre code = **Borne** (mode démo `previewMode`/`is_preview`,
  quota `MAX_DATA_BYTES`, route `reset-preview`, health `isPreview`) + Hub front (onglet Aperçu).
  Cases ROADMAP 6D.1→6D.5 cochées (6D.6 = vérif humaine). §11.21 désormais implémenté.
- borne-config : ajout `maxDataBytes`/`MAX_DATA_BYTES` + `previewMode`/`PREVIEW_MODE` (extrait + 2
  lignes table env) ; nouveau callout « borne d'essai (mode démo) » (preview compose, deux signaux).
- borne-index : health expose `isPreview` (extrait + formule `!!cfg.previewMode || !!active.is_preview`)
  + paragraphe (front lit /health pour le bandeau).
- borne-registry : colonne `is_preview` dans le schéma + bullet ; 3ᵉ ligne de migration douce (commentaire
  « Migrations douces ») + js-note ajusté ; `insertEvent({…, is_preview})` dans la table d'API.
- borne-routes-videos : intro (§11.21 ajouté) ; nouvelle section quota (`dirSize`/`checkQuota` extrait,
  callout danger §11.21 « avant multer », see-also dirSize→hub-routes-admin) ; ligne API POST /videos (507).
- borne-routes-sync : `isPreviewMode` + garde push 409 (extrait + callout danger §11.21) ; gardes avant
  push passées à 4 ; nouvelle section `reset-preview` (extrait, callout info logique, callout danger 403) ;
  table d'API (push mode démo, reset-preview).
- borne-sync-pull : extrait `pullMyEvent` + ligne `UPDATE … is_preview` ; paragraphe persistance du flag.
- invariants : callout périmètre révisé (§11.21 implémenté ; §11.22 implémenté mais pas encore détaillé) ;
  nouvel item §11.21 dans Synchronisation.
- arch-deux-apps : `local_events` mentionne `is_preview`.
- pages.js : inchangé (aucune notion JS nouvelle ; `dirSize`/`withFileTypes` déjà indexés sur
  hub-routes-admin et renvoyés en see-also ; les nouveaux termes sont métier, pas JS).
- Hors scope doc (composants UI sans page — convention : seuls client.js/hooks documentés côté front) :
  App.jsx (fetch /health + props isPreview), AdminLayout/AdminPage/TechPage/GuestPage.jsx (bandeaux),
  hub EventDetailPage.jsx (onglet Aperçu + previewTokens), app.css ; CLAUDE.md/ROADMAP.md/NOTES.md
  (pas docs/) ; docker-compose.preview.yml documenté via le callout borne-config + CLAUDE.md §Commandes ;
  *.test.js couverts par le pattern générique de tests-runner.
- Vérifs : manifeste/fichiers OK (51/51), liens internes OK (0 mort), `node --check pages.js` OK.

## Sync incrémentale — Phase 6E (token_clear, seed admin, assignation owner, trust proxy)
- Diff base : `git diff HEAD`. Périmètre code = **Hub** : `box_tokens.token_clear` (+ migration douce
  + `listAllBoxTokens`), seed admin au démarrage (`seedAdminIfNeeded`, env `ADMIN_EMAIL`/
  `ADMIN_PASSWORD_HUB`), `app.set('trust proxy', 1)`, création d'événement réservée admin
  (`requireAdmin` local), nouvelle route `PUT /events/:id/owner` (assigne client, crée compte sans
  mdp + lien d'enregistrement dérivé de `req.protocol`/`req.get('host')`), nouvelle route
  `GET /admin/tokens` (vue globale). Front : `listAllTokens`, `assignEventOwner`, redirection admin→
  /admin (LoginPage/App.jsx). §11.13 révisé (token stocké hash ET clair).
- hub-config : table env enrichie (`adminEmail`/ADMIN_EMAIL, `adminPassword`/ADMIN_PASSWORD_HUB) +
  paragraphe seed ; extrait config à jour.
- hub-index : `trust proxy` dans createApp (extrait + callout info reverse proxy/req.protocol) ;
  nouvelle section `seedAdminIfNeeded` (extrait, idempotence, argon2) ; démarrage `seedAdminIfNeeded().then()`.
- hub-registry : schéma box_tokens + `token_clear` (commentaires hash/clair) ; bullet « stocké en
  double » réécrit (§11.13b) ; nouvelle section migration douce token_clear (pragma table_info) ;
  inventaire fonctions + `listAllBoxTokens` (JOIN event_name).
- hub-routes-admin : POST tokens stocke+retourne `token_clear` (extrait + réponse) ; callout danger
  « une seule fois » → callout info « re-consultable, §11.13b » ; nouvelle route GET /tokens (extrait
  + paragraphe LEFT JOIN) ; GET /events/:id/tokens « avec token_clear » ; table d'API (POST/GET/+GET /tokens).
- hub-routes-events : POST `/` re-titré « réservée admin » (extrait `requireAdmin` local + paragraphe) ;
  nouvelle section `PUT /:eventId/owner` (extrait réel, 2 cas créé/existant, lien d'enregistrement,
  renvoi trust proxy, PUBLIC_URL disparu) ; table d'API (POST admin, +PUT /owner).
- hub-middleware-box : callout danger réécrit (auth ne compare que le hash ; clair stocké mais hors
  auth/synchro, §11.13b) — l'affirmation « ne contient que token_hash » corrigée.
- web-client-hub : table d'API api.* (+`listAllTokens`, +`assignEventOwner`). getRole déjà documenté
  (routing admin) → inchangé.
- invariants : §11.13b réécrit (hash auth ET clair consultation admin, exposé admin uniquement).
- arch-deux-apps : box_tokens « hash + clair du token ».
- flux-push-pull : Phase A étape 1 (admin crée + assigne owner, client édite) + étape 2 (clair
  re-consultable §11.13b ; « assignation de borne » précisé).
- pages.js : `js` enrichi sur hub-config (seed admin), hub-registry (token_clear migration),
  hub-index (trust proxy, seed), hub-routes-events (requireAdmin, assignation propriétaire).
- Hors scope doc (pas de page dédiée) : `docker/hub-entrypoint.sh` (script shell deploy : cert
  auto-signé dev / Let's Encrypt prod — la doc ne couvre que le code JS, pas nginx/openssl/Docker),
  hub/web Dockerfile + docker-compose.hub.yml + .env.example (déploiement), PROJET.md/ROADMAP.md ;
  App.jsx/LoginPage.jsx (routing UI → seul client.js documenté côté front), AdminPage.jsx ;
  tous les *.test.js couverts par le pattern générique de tests-runner.
- Vérifs : manifeste/fichiers OK (51/51), liens internes OK (0 mort), `node --check pages.js` OK.

## Sync incrémentale — refonte synchro Borne (suppression autoPull + remontée de config)
- Diff base : `git diff HEAD`. Périmètre code = **Borne** : `sync/autoPull.js` SUPPRIMÉ (plus de
  `setInterval`/heartbeats) ; `getLastPull`/`_lastPull` migrés dans `pull.js` ; pull one-shot au
  démarrage dans `index.js` (puis tout manuel) ; nouvelles routes `GET /sync/hub-config`,
  `POST /sync/token` (swap à chaud), `POST /sync/push-config` ; `POST /sync/pull` attend désormais et
  renvoie `{ ok, pulled, localConfig }` ; `GET /sync/status` renvoie `localConfig`+`isPreview` ;
  `pushConfig` ajouté à `push.js` ; `POST /events` (création locale) supprimée d'`events.js` ;
  `pull.js` écrase `event_meta` par DELETE+INSERT et autorise l'overwrite en preview (§11.10 nuancé) ;
  `config` : `pullIntervalMs` retiré, `hostPort` ajouté. Côté **Hub** : `POST /sync/events/:id/config`
  (réception de la remontée, requireBox, overwrite/merge, FROZEN ≥ live → 409, theme validé THEMES).
- PAGE SUPPRIMÉE : `borne-sync-autopull.html` (+ entrée pages.js) — fichier source disparu.
- borne-sync-pull : callout « plus de pull périodique » + extrait `getLastPull` ; garde §11.10
  `&& !config.previewMode` (extrait + exception preview) ; `event_meta` DELETE+INSERT (extrait +
  callout) ; `pullMyEvent` canPull preview + `_setLastPull` ; note 404 reformulée (plus de cycle) ;
  table d'API (getLastPull, nuance preview).
- borne-routes-sync : intro élargie + callout « plus de pull périodique / configHash » ; nouvelle
  section État/hub-config/token (extraits + callout swap config vivante) ; pull manuel réécrit
  (await + résultat) + push-config (autorisé démo, 409 autonome) ; table d'API complète (6 routes).
- borne-sync-push : nouvelle section `pushConfig` (extrait réel, overwrite, autorisé preview) +
  ligne API.
- borne-index : section démarrage réécrite (pull one-shot + bannière) ; callout autoPull→info
  « un seul pull au boot ».
- borne-config : `pullIntervalMs` retiré, `hostPort` ajouté (extrait + table) ; callout autonome
  corrigé (plus de création locale, pull one-shot sauté, push-config 409) ; lien autopull retiré.
- borne-routes-events : intro sans « création locale » + callout « ne crée plus d'événements » ;
  section `POST /events` supprimée ; table d'API (ligne POST /events retirée).
- hub-routes-sync : table étapes (+config, status reformulé) ; nouvelle section
  `POST /events/:id/config` (extrait, overwrite/merge, 409 FROZEN, requireBox §11.20).
- web-client-borne : `api.*` tech (getHubConfig/triggerPushConfig/updateToken ajoutés, createEvent
  retiré côté client) ; table d'API.
- web-client-hub : `importPreviewConfig` ajouté à la ligne api.*.
- flux-push-pull : table statuts (live local, closed remonté au push) ; Phase A (variante
  push-config) ; Phase B (one-shot + manuel, plus de 5 min) ; Phase C (heartbeats retirés).
- arch-demarrage : section Borne (pull one-shot, plus de startAutoPull, lien → pull.js).
- index-notions : ligne `setInterval`/`clearInterval` retirée (notion disparue du code).
- borne-routes-sessions : `live` désormais local (plus de heartbeat) ; closed remonté au push.
- core-constants : « heartbeats » → « route de transition de statut (POST /status) ».
- invariants : §11.10 nuancé (exception preview overwrite).
- pages.js : entrée autopull retirée ; `js` enrichi sur borne-sync-pull, borne-sync-push,
  borne-routes-sync.
- Sans impact doc : `hubClient.js` (ajout de `borneLog` — logging observable mais hors contrat
  d'API ; extrait de la page volontairement simplifié) ; bannière de boot détaillée d'`index.js`
  (cosmétique) ; tous les *.test.js (pattern générique tests-runner) ; composants UI (SyncPanel.jsx,
  EventPanel.jsx, AdminPage/EventDetailPage Hub, app.css) ; docker/nginx/compose (déploiement) ;
  PROJET.md/ROADMAP.md/README/.env.example. Changes Hub 6C/6D/6E (token_clear, seed admin, owner,
  trust proxy) déjà documentés (pages modifiées dans les passes précédentes).
- À surveiller : `importPreviewConfig` (hub web) cible `/api/events/:id/config` alors que la route
  serveur vit sous `/api/sync/events/:id/config` (sync router) — mismatch de chemin probable côté
  front, hors périmètre doc-sync (code).
- Vérifs : manifeste/fichiers OK (50/50), liens internes OK (0 mort), `node --check pages.js` OK.

---

## Conventions du site (décidées avec l'utilisateur)

- **Structure multi-fichiers** : `index.html` (coquille) + `assets/{style.css,app.js,pages.js,highlight.js}` + `pages/<slug>.html`. SPA par hash, chargement fetch. Validé : toutes ressources 200, scripts passent `node --check` via Docker.
- **Cours JS à 2 niveaux** : partie synthétique toujours visible + `<div class="js-deep">` masquée en mode synthétique. Toggle global dans la sidebar (Synthétique/Approfondi), persisté en localStorage, classe `body.mode-synth`/`mode-deep`.
- **Pas de diagrammes ASCII** : tout en prose/listes/tableaux (demande utilisateur).
- **Node absent en local** : valider la syntaxe via `docker compose run --rm --no-deps -T dev sh -c 'node --check …'`.
- Encadré JS = `<div class="js-note">` avec `.js-note-head` (badge + titre), table `.compare` pour Python/Go, `.js-deep` pour l'approfondi.
- Renvoi vers notion déjà vue = `<a class="see-also" href="#/slug">→ notion JS : X (vue dans Y)</a>`.
- Callouts : `.callout.info/.warn/.danger/.tip`.
- Badges statut ROADMAP : `.status-done/.status-todo/.status-human`.

## Plan des notions JS par page (où chaque notion est expliquée EN PREMIER)

- arch-monorepo : NPM, package.json, workspaces, dependencies/devDependencies, scripts, main/exports, private, "type":"module"
- arch-modules : import/export, named vs default, ESM vs CommonJS (require), pourquoi ESM ici, extensions .js obligatoires
- arch-docker : process.env, ?? (nullish), parseInt radix
- arch-demarrage : process.argv[1], import.meta.url, le guard "main module"
- core-index : barrel, export *
- core-constants : const exporté, objets comme enum, pas de freeze réel
- core-validate : fonction pure, Number()/Number.isInteger, throw/Error, retour null vs string
- core-eventdbschema : **better-sqlite3** (new Database, pragma, exec, prepare, run/get/all, transaction), template literals SQL, WAL, foreign_keys par connexion, forEach
- core-checksum : node: prefix, createHash, createReadStream, streams + .on('data'/'end'/'error'), Promise manuelle (new Promise(resolve,reject))
- hub-config : (renvoi process.env), objet config exporté
- hub-registry : singleton (let _db=null), pattern open/get/close, fonctions prennent db en param, SQL CHECK/FK, Object.keys/filter/map pour UPDATE dynamique
- hub-eventstore : **Map**, ordre d'insertion garanti, LRU via delete+set, entries().next().value, destructuring array
- hub-middleware-auth : **jsonwebtoken** (verify/sign), algorithms:['HS256'], optional chaining, ?token=, slice
- hub-middleware-box : createHash sha256 (renvoi), headers['x-...'] minuscules
- hub-middleware-validate : closure qui retourne un middleware (factory), RegExp literal + .test, rest params ...names
- hub-index : **express**, app.use, ordre de montage, sous-routeurs avec :param, error handler (err,req,res,next) 4 args, req/res/next, async handler + next(err), express.json()
- hub-routes-auth : **Router**, async/await + try/catch + next, **argon2** hash/verify, **express-rate-limit**, destructuring req.body, lastInsertRowid
- hub-routes-events : **Set** (FROZEN_STATUSES), **Map** (MANUAL_TRANSITIONS), spread dans réponse, new Date().toISOString(), ?? vs ||
- hub-routes-questions : mergeParams:true, construction SQL dynamique (fields/values arrays), ?? defaults dans destructuring
- hub-routes-sync : **multer** (diskStorage, destination/filename cb, limits, .single), JSON.parse/stringify fichier, renameSync atomique, for…of + await séquentiel, try{}catch{} vide (unlink best-effort)
- hub-routes-gallery : **Range requests** (206, Content-Range, createReadStream{start,end}.pipe), injection CSV (préfixe formule), arrow fn concises
- hub-routes-admin : randomBytes, récursion dirSize, withFileTypes, map qui retire un champ (rest destructuring _t)
- hub-worker : while(true)+sleep, **import() dynamique** + Promise.all, transaction pour claim atomique, process.exit
- hub-worker-ffmpeg : **child_process spawn**, Buffer.concat, events stdout/stderr/close, parseFloat, **archiver** + pipe + Promise sur close
- hub-create-admin : shebang #!, readline, process.stdin/stdout, ask = promisify question
- borne-config : (renvoi tout)
- borne-registry : migration douce (pragma table_info, ALTER), transaction multi-statements (setActiveEvent)
- borne-eventdb : cache 1 entrée, pourquoi (1 seul actif)
- borne-middleware-auth : **timingSafeEqual**, Buffer.from + length check, factory avec closure de config (diff vs hub qui importe config), pourquoi injecter config (testabilité)
- borne-index : injection cfg dans routers (vs hub import direct), spread routerCfg
- borne-routes-events : statfs disque, preflight, getActiveEvent pattern, parseInt sur meta
- borne-routes-sessions : capability token (UUID session = accès), machine à états loaded→live, consent===true strict
- borne-routes-videos : **fileFilter Safari** (mime générique + ext), **transaction DELETE+INSERT**, **unlink APRÈS commit** (§11.9), unlink(cb) callback-style fs, ordre des guards (req.file d'abord)
- borne-routes-questions : (renvois)
- borne-routes-sync : tâche de fond (.catch(()=>{})), pushEvent lancé sans await
- borne-sync-hubclient : **fetch natif** Node, backoff min(2000·2^(n-1),30000), Object.assign(new Error,{...}), spread headers, ne pas poser Content-Type si FormData
- borne-sync-pull : vérif statut à l'application (§11.10 + exception preview), DELETE+INSERT questions ET event_meta, Object.entries, getLastPull, pull one-shot au démarrage
- borne-sync-push : **état module partagé** {..._state}, **for await** sur createReadStream, **FormData/Blob**, finally pour running=false, marquage running synchrone avant await, pushConfig (remontée config overwrite)
- (borne-sync-autopull SUPPRIMÉ : autoPull.js retiré du code — plus de setInterval/heartbeats ; le pull est one-shot au boot puis manuel)
- web-client-hub : **fetch** navigateur, **localStorage**, objet de méthodes fléchées, ...opts, instanceof FormData, res.status 204
- web-client-borne : **XMLHttpRequest**, xhr.upload.onprogress (pourquoi pas fetch), FormData, File/Blob, new Promise wrapping XHR
- web-mediarecorder : **React hook**, useState/useRef/useCallback/useEffect, **useRef vs useState** (pas de re-render), **closure piège** (durationRef pour le timer), MediaRecorder.isTypeSupported, URL.createObjectURL/revokeObjectURL, cleanup au démontage
- tests-runner : **node:test** (describe/it/before/after), **node:assert/strict**, **supertest** (request(app) sans listen), mkdtempSync/tmpdir/rmSync, mutation config ESM partagé, test alg:none

## Notes d'analyse

### Architecture globale
- Monorepo NPM workspaces (champ `"workspaces"` dans `package.json` racine)
- `"type": "module"` à la racine → ESM partout (import/export, pas require)
- 3 packages : `packages/core`, `apps/hub/server`, `apps/borne/server`, `apps/hub/web`, `apps/borne/web`
- `@kapsule/core` : package partagé, importé par les deux serveurs
- Node ≥ 20 requis

### Deux bases SQLite distinctes par app
- **Hub** : `registry.sqlite` (users, boxes, events, jobs, sync_log) + un `db.sqlite` par événement (questions, sessions, videos, derived)
- **Borne** : `registry.sqlite` (local_events, push_state) + un `db.sqlite` par événement (même schéma que Hub via `createEventDb`)

### Patterns récurrents

#### Factory function pour les routers
Tous les routers sont des factory functions `makeXxxRouter(dataDir, cfg)` → retourne un `Router()`.
Permet d'injecter `dataDir` et la config sans variables globales, facilite les tests (on passe un dataDir temporaire).

#### Singleton SQLite avec lazy init
`registry.js` utilise un `let _db = null` + guard `if (_db) return _db`.
Reset possible via `closeRegistry()` → pattern utilisé dans les tests pour isoler les suites.

#### LRU cache pour les event DBs (Hub)
`eventStore.js` : Map ordonnée (insertion-order en JS), max 10 handles ouverts simultanément.
Refresh LRU : delete + re-insert en fin de Map.

#### Cache simple pour l'event DB (Borne)
`eventDb.js` : un seul handle `_cached = { id, db }` — la Borne n'a qu'un événement actif à la fois.

### Notions JS à expliquer (première occurrence)

| Notion | Première occurrence | Fichier |
|--------|-------------------|---------|
| ESM `import`/`export` | `packages/core/src/constants.js` | constants.js |
| `package.json` + NPM workspaces | `package.json` racine | Architecture |
| `process.env` + nullish coalescing `??` | `apps/hub/server/src/config.js` | config.js (hub) |
| `better-sqlite3` : new Database, pragma, exec, prepare/run/get/all, transaction | `packages/core/src/eventDbSchema.js` | eventDbSchema.js |
| `new Map()` + insertion-order LRU | `apps/hub/server/src/eventStore.js` | eventStore.js |
| `node:crypto` createHash + createReadStream (stream) + Promise manuelle | `packages/core/src/checksum.js` | checksum.js |
| Express : Router, app.use, middleware chain, ordre | `apps/hub/server/src/index.js` | index.js (hub) |
| `req`/`res`/`next` cycle de vie | `apps/hub/server/src/index.js` | index.js (hub) |
| Error handler 4-params Express | `apps/hub/server/src/index.js` | index.js (hub) |
| `async`/`await` + try/catch dans handler | `apps/hub/server/src/routes/auth.js` | auth.js (hub) |
| `jsonwebtoken` sign/verify + algorithms pin | `apps/hub/server/src/middleware/auth.js` | auth.js middleware |
| `argon2` hash/verify | `apps/hub/server/src/routes/auth.js` | auth.js (hub) |
| `express-rate-limit` | `apps/hub/server/src/routes/auth.js` | auth.js (hub) |
| `timingSafeEqual` node:crypto | `apps/borne/server/src/middleware/auth.js` | auth.js (borne) |
| `multer` diskStorage/fileFilter/limits | `apps/hub/server/src/routes/sync.js` | sync.js (hub) |
| `node:fs` createReadStream + Range requests | `apps/hub/server/src/routes/gallery.js` | gallery.js (hub) |
| `Set` JS | `apps/hub/server/src/routes/events.js` | events.js (hub) |
| `Map` JS | `apps/hub/server/src/routes/events.js` | events.js (hub) |
| Spread operator `...` | `apps/hub/server/src/routes/sync.js` | sync.js (hub) |
| `process.argv` + `import.meta.url` | `apps/hub/server/src/index.js` | index.js (hub) |
| XMLHttpRequest (à venir) | `apps/borne/web/src/api/client.js` | client.js (borne web) |
| `node:test` + `supertest` (à venir) | fichiers de test | test/* |

### Invariants critiques identifiés dans le code

1. **§11.1 — export/csv avant /:id** : visible dans `gallery.js:61` et `videos.js:210`
2. **§11.2 — ?token= query param** : visible dans `hub/middleware/auth.js:8` et `borne/middleware/auth.js:32`
3. **§11.3 — Range requests** : implémenté dans `gallery.js:25-49` et `videos.js:44-73`
4. **§11.4 — fileFilter Safari** : `videos.js:28-37` (mime générique + extension vidéo)
5. **§11.9 — transaction DELETE+INSERT + unlink après commit** : `videos.js:131-153`
6. **§11.11 — closeEventDb avant rm -rf** : `events.js:180` (hub), `sync.js:263` (hub)
7. **§11.12 — missing recalculé côté Hub** : `sync.js:301-307` (finalize)
8. **§11.13 — RGPD : données invité hors registry** : `registry.js` borne ne stocke pas guest_name/videos

### Modules supplémentaires notés

#### sync/push.js (Borne)
- Séquence : checkpoint WAL → POST manifest → liste missing → upload vidéos → upload db.sqlite → POST finalize → updateStatus local
- `_state` partagé : objet module-level lu par GET /sync/status (pas de classe, pas d'event emitter)
- `_setPushRunning()` exporté pour les tests (injection du flag sans lancer de vrai push)
- `backoffMs(n) = min(2000·2^(n-1), 30000)` — invariant §upload retry
- `globalThis.fetch` (pas `node-fetch`) — Node 18+ a fetch natif
- Lit les vidéos via `new Database(dbPath, { readonly: true })` — n'utilise pas le cache LRU

#### sync/pull.js (Borne)
- `pullEvent` : vérification du statut LOCAL au moment d'appliquer (pas au lancement) — invariant §11.10
- `pullAssigned` : itère sur `/api/sync/assigned`, pull uniquement si absent ou status=loaded

#### sync/autoPull.js (Borne)
- `setInterval` + premier cycle immédiat
- `sendHeartbeats` : envoie live/closed au Hub en best-effort (catch silencieux)
- Pas de pull si tous les events sont ≥ live (optimisation : ne pas polluer le Hub inutilement)

#### worker/index.js (Hub)
- Boucle infinie `while(true)` + sleep (pas de cron, pas de BullMQ)
- `claimNextJob` : SELECT + UPDATE dans une transaction → atomique, évite double-claim
- `recoverOrphans` : jobs laissés `running` par crash → remis `pending` au démarrage
- `maybeMarkProcessed` : si tous jobs done → event passe `processed`
- Import dynamique des handlers (`import()` dans `getHandlers`) : évite de charger archiver si non installé

#### worker/ffmpeg.js
- `spawn()` node:child_process : pas de wrapper ffmpeg externe
- Stdout collecté en chunks puis `Buffer.concat()` → JSON.parse

#### worker/jobs/archive.js
- `archiver` npm : mode `store` (pas de compression — vidéo déjà compressée)
- Pattern stream : `createWriteStream` → `archiver.pipe()` → Promise sur `output.on('close')`

#### useMediaRecorder.js (React hook)
- Détection MIME à la volée : `MediaRecorder.isTypeSupported()` — Safari n'a que mp4/avc1
- `useRef` pour stream/recorder/timer/duration : évite les re-renders, accès synchrone dans les callbacks
- `recorder.start(1000)` : chunks de 1s pour la robustesse
- `onstop` positionne STOPPED après avoir construit le blob (asynchrone par rapport à `.stop()`)
- `URL.revokeObjectURL` explicite → pas de fuite mémoire
- `playsInline` imposé dans `attachPreview` → invariant Safari §11

#### client.js Borne (web)
- `uploadVideo` via XHR : `xhr.upload.onprogress` n'existe pas sur `fetch`
- `localStorage` pour le token — clé `admin_token`
- URLs avec `?token=` pour `<video src>`, CSV, download (invariant §11.2)

#### client.js Hub (web)
- Même pattern `apiFetch` mais via `/api` préfixé (proxy Vite en dev)
- `localStorage` clé `hub_token`

### Décisions d'architecture identifiées

1. **Factory functions pour routers** → testabilité (injection dataDir temporaire)
2. **ESM (import/export) pas CJS** → `"type":"module"` dans package.json racine impose ESM à tous les enfants
3. **better-sqlite3 synchrone** → SQLite est en-process, pas de réseau → le blocage est ~µs, pas ms
4. **LRU 10 handles Hub** → éviter d'avoir trop de fichiers SQLite ouverts simultanément (limite OS)
5. **singleton registry Borne** → la Borne est mono-utilisateur, pas besoin de pool
6. **Guard `process.argv[1] === import.meta.url`** → le fichier `index.js` est à la fois un module importable (tests) ET un exécutable (prod) sans code dupliqué
7. **JWT ?token=** → `<video src="...?token=xxx">` : le navigateur ne peut pas ajouter un header Authorization sur une balise `<video src>`, donc le token passe en query param
8. **timingSafeEqual pour login Borne** → mot de passe unique en clair comparé, vulnérable aux timing attacks sans ça
9. **algorithms: ['HS256'] dans jwt.verify** → défense contre l'attaque alg:none (JWT sans signature accepté par des implémentations naïves)
