---
status: tests-pending
base_commit: f3985f60a4074fddf0feaa86cbfbfa56161c8acd
workspaces: [@kapsule/borne-server, @kapsule/borne-web, @kapsule/hub-server]
generated_at: 2026-08-16T23:14:43Z
verdict: COMMIT À CORRIGER
---

# Relais de review → tests

Workspaces à tester :
- @kapsule/borne-server (raison : `routes/sync.js`, `sync/pull.js`, `index.js`, `config.js`, `borneIdentity.js`, `middleware/auth.js` modifiés — verrou d'appairage à 3 signaux, réordonnancement de `pullEvent`, `routerCfg` par `Object.create`)
- @kapsule/borne-web (raison : `OnboardingScreen.jsx` (`stopWhen`), `App.jsx`, `GuestPage.jsx`, `BornePage.jsx`, `AdminLogin.jsx`, `api/client.js` modifiés)
- @kapsule/hub-server (raison : `preview/provisioner.js` — retrait de `TECH_PASSWORD` injecté aux conteneurs preview)

Smoke à relancer (infra touchée) : `npm run smoke:borne` (réécrit — auth par PIN au lieu de `TECH_PASSWORD`, seed d'un `tech_pin`) et `npm run smoke:preview` (retrait de `TECH_PASSWORD_PREVIEW`).

Points d'attention pour les tests (findings du reviewer à confirmer par les tests) :
- Verrou `POST /sync/onboarding/pair` : le 3ᵉ signal (`getSetting('borne_token') !== null`) rend 403 toute borne seedée par `BORNE_TOKEN` en `.env` **avant** tout pull. Vérifier qu'aucune suite existante n'appairait par ce chemin.
- Branche **token d'événement** : après un appairage réussi, rien n'est persisté. Un test de redémarrage simulé (nouvelle `createApp` sur le même `dataDir`, `config.boxToken = ''`) doit montrer `hasToken:false` **et** `POST /sync/onboarding/pair` → 403 (cul-de-sac ⚠️ n°3 du rapport).
- Symétrique : une borne réelle avec `BOX_TOKEN` configuré et aucun pull abouti → `hasToken:true` mais `POST /sync/onboarding/pair` → **200** (trou ⚠️ n°4). À couvrir par un test.
- `routerCfg = Object.create(cfg)` : vérifier que `routes/sessions.js` (auth wall preview, `cfg.jwtSecret`) signe/vérifie bien avec la valeur **live** après `resolveJwtSecret()`, et qu'aucun test ne s'appuyait sur `routerCfg` énumérable/spreadable.
- `pullEvent()` réordonné : `sync.pull.test.js` doit vérifier qu'aucune ligne `local_events` ne subsiste après un échec **d'assets** ET que le cas nominal pose bien `pulled_at`. Attention aussi au cas « événement déjà existant en `loaded` » (l'`UPDATE pulled_at` en fin de fonction).
- `resolveTrustProxyHops('')` → 1 / 2 selon `PREVIEW_MODE` (nouveaux tests `config.test.js`).
- `@kapsule/borne-web` : échecs **pré-existants** connus sur `design.test.js` (`@kapsule/guest-ui` non lié dans l'image `dev` → `docker compose build dev` requis). Ne pas les imputer à ce lot ; en revanche vérifier qu'ils ne masquent pas un échec réel sur `roles.test.js`/`format.test.js`.

## Corrections demandées

> Cette section est lue par l'agent principal pour implémenter les corrections.
> Chaque item est coché par l'agent principal une fois corrigé.

- [x] ❌ `PROJET.md:548` et `PROJET.md:1165` — le verrou de `POST /sync/onboarding/pair` y est décrit comme un « OU de **deux** signaux » alors que `apps/borne/server/src/routes/sync.js:262` en teste **trois** (`paired_at`, `local_events`, `getSetting('borne_token')`). Réécrire §6, §6bis et §11.30 avec les trois signaux.
- [x] ❌ `PROJET.md` §6bis (« Le formulaire de l'écran d'onboarding est une **alternative** ») — l'affirmation « une borne dont le `BORNE_TOKEN` d'env n'a jamais mené à un pull réussi reste protégée par le **second** signal — présence d'au moins un `local_events` » est fausse : dans ce cas précis il n'y a aucune ligne `local_events`, c'est le 3ᵉ signal (`borne_token` persisté) qui protège. Corriger la phrase.
- [x] ❌ `docker-compose.hub.yml:10` et `:44` — `JWT_SECRET=${JWT_SECRET:-change-me}` (secret publiquement connu comme défaut dans un compose versionné) alors que `NODE_ENV` n'est posé **nulle part** pour le Hub (ni compose, ni `apps/hub/server/Dockerfile`) : `validateConfig(config, process.env.NODE_ENV)` (`apps/hub/server/src/index.js:90`) n'est jamais `strict` en production, donc le garde-fou ne se déclenche pas. Ajouter `NODE_ENV=production` aux services `backend` et `worker`, retirer le défaut `change-me`, et traiter la chaîne vide comme faible dans `apps/hub/server/src/config.js:23`.
- [x] ⚠️ `apps/borne/server/src/routes/sync.js:271-281` — `hubUrl` provient d'une requête **non authentifiée** et est passé tel quel à `hubFetch` sans validation de schéma/hôte (SSRF depuis le LAN ; le statut et le `body.error` distants reviennent dans `pull.error`). Valider par `new URL()` : schéma `https:` exigé (`http:` toléré uniquement pour `localhost`/`127.0.0.1`), rejeter le reste en 400, et ne pas réfléchir le message d'erreur distant tel quel.
- [x] ⚠️ `apps/borne/server/src/borneIdentity.js:54-58` — `resolveJwtSecret()` fait primer la valeur persistée sur l'env **sans échappatoire** : une rotation de `JWT_SECRET` n'a plus aucun effet après le premier boot. Sur une borne preview (qui reçoit le `JWT_SECRET` **du Hub** via `provisioner.js:146,200`), cela fige le secret Hub sur disque et empêche toute révocation des JWT `general` déjà signés. Faire primer une valeur d'env **non faible** sur la valeur persistée (et la persister), ne retomber sur persisté/généré que si l'env est vide/valeur d'exemple.
- [x] ⚠️ `apps/borne/server/src/routes/sync.js:83` vs `:262` — `hasToken` et le verrou d'appairage n'évaluent pas le même prédicat « appairée » (le verrou ignore `boxToken`, `hasToken` ignore `paired_at`/`local_events`). Conséquence a) borne réelle appairée par **token d'événement** : rien n'est persisté → au redémarrage `hasToken:false` remet l'`OnboardingScreen` devant le kiosque **et** `/borne`, alors que la route répond 403 → plus aucun écran atteignable après expiration du `tech_token` 24 h. Extraire un prédicat « appairée » unique partagé par les deux routes, et persister le token d'événement (ou refuser explicitement l'appairage par token d'événement depuis l'onboarding).
- [x] ⚠️ `apps/borne/server/src/routes/sync.js:262` — symétrique du point précédent : le verrou n'a pas de signal pour `boxToken`. Une borne réelle seedée avec `BOX_TOKEN` et sans pull abouti annonce `hasToken:true` (aucun formulaire proposé) mais laisse `POST /sync/onboarding/pair` **ouverte sans auth** sur le LAN — un tiers peut réappairer la machine sur son propre Hub et récupérer un JWT `tech_borne`. Ajouter le signal manquant (ou persister le `boxToken`).
- [x] ⚠️ `.env.example-rasp:39` et `README.md` (Étape 4, « les deux chemins sont équivalents ») — faux depuis le 3ᵉ signal du verrou, et contredit par PROJET.md §6bis. Un `BORNE_TOKEN` mal recopié dans le `.env` est persisté au boot sans validation → `hasToken:true` (pas de formulaire) **et** `POST /sync/onboarding/pair` → 403 : borne réparable seulement par SSH, sans qu'aucun PIN n'ait existé. Remplacer « équivalents » par un avertissement explicite.
- [x] ⚠️ `docker-compose.hub.yml:26-27` — `ports: "3001:3001"` publie l'API Hub en clair sur l'hôte, court-circuitant l'edge (pas de TLS, ni HSTS/CSP/X-Frame, ni filtrage par `Host`). Combiné à `app.set('trust proxy', 1)` (`apps/hub/server/src/index.js:36`), une connexion directe permet de falsifier `X-Forwarded-For` et de contourner `express-rate-limit` sur `/api/auth/login`. Le chemin légitime est `edge → hub-frontend → backend:3001` sur `kapsule_hub_net` : retirer le bloc `ports` ou le binder sur `127.0.0.1`.
- [x] ⚠️ `rapports/securite.md:22` et `:71-75` — les annotations « ✅ Résolu » ne précisent pas que `resolveJwtSecret()` est **borne-only** : lues telles quelles, elles laissent croire que le défaut `change-me` du Hub est traité. Scoper explicitement à la Borne et laisser le point Hub ouvert.
- [x] ⚠️ `docker-compose.preview.yml:16-19` — la note sur `JWT_SECRET` ne dit pas que sans lui les liens `preview/token` **signés par le Hub** seront rejetés par la borne (pas seulement « sessions invalidées »). Compléter.
