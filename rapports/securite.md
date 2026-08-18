# Rapport — audit de sécurité (focus surface non authentifiée)

**Date :** 2026-06-19
**Contexte :** avant exposition de l'infra (Hub + previews) sur Internet.
**Périmètre :** routes publiques (sans login), middlewares d'auth, secrets, DoS, en-têtes.
**Méthode :** lecture-seule. Recensement exhaustif des routes sans garde, puis examen
de chaque point d'entrée exposé (validation, IDOR, quota, secrets, headers).

> ⚠️ Diagnostic. Aucune correction appliquée. Sévérités : 🔴 critique · 🟠 élevé · 🟡 moyen · 🟢 info.
> Référentiel d'invariants : PROJET.md §11. Carte du code : ARCHITECTURE.md.

---

## Synthèse exécutive

La structure d'auth est **globalement correcte** : chaque router Hub a une garde, le parcours
invité de la Borne est public *par conception*. Mais avant exposition Internet, **plusieurs
durcissements sont nécessaires**, surtout côté Borne/preview (qui sera servie publiquement par
sous-domaine) et sur les protections transverses absentes (headers, rate-limit, taille de body).

**Top priorités avant exposition :**
1. 🔴 `JWT_SECRET` / `TECH_PASSWORD` avec valeurs par défaut (`change-me`, `tech123`). — ✅ **`TECH_PASSWORD` résolu** : retiré entièrement (Phase C, PROJET.md §11.30). ✅ **`JWT_SECRET` résolu des deux côtés, par des mécanismes différents** : côté **Borne**, généré/persisté automatiquement s'il est absent ou vaut une valeur d'exemple (`resolveJwtSecret()`, `borneIdentity.js`) — une machine de terrain ne doit jamais refuser de démarrer faute d'opérateur disponible pour éditer un `.env`. Côté **Hub**, à l'inverse, refus explicite de démarrer (`validateConfig()`, `apps/hub/server/src/config.js` + `NODE_ENV=production` dans `docker-compose.hub.yml`) — le Hub est configuré une fois, par un opérateur qui a toujours accès au `.env`, donc pas de justification à générer un secret à sa place.
2. 🔴 Aucune limite de taille sur `express.json()` (DoS trivial).
3. 🟠 Aucun en-tête de sécurité (pas de helmet : CSP, X-Frame-Options, HSTS, nosniff).
4. 🟠 Login Borne sans rate-limit (brute-force du mot de passe / compte).
5. 🟠 Upload vidéo public sans rate-limit ni lien session→consentement vérifié.

---

## 1. Surface PUBLIQUE recensée (sans aucun login)

### Hub (`/api`)
| Route | Garde | Note |
|-------|-------|------|
| `POST /api/auth/login` | rate-limit (10/15min) | ✅ correct |
| `POST /api/auth/register` | `ALLOW_REGISTER` (off par défaut) | ✅ si désactivé en prod |
| `POST /api/auth/set-password` | token d'enregistrement | ✅ |
| `GET /api/health` | aucune | 🟡 fuite d'info disque (cf. §6) |

Tout le reste du Hub est derrière `requireUser`/`requireBox`. **Bon.**

### Borne (`/api`) — surface publique large *par conception* (parcours invité)
| Route | Garde | Risque |
|-------|-------|--------|
| `GET /api/event` | aucune | config publique — OK, mais expose `requiresLogin`, statut |
| `GET /api/questions` | aucune | OK (questions = contenu affiché) |
| `POST /api/sessions` | aucune (sauf preview+general) | 🟠 création illimitée (cf. §3) |
| `GET /api/sessions/:id/answers` | UUID = capability | 🟡 IDOR si UUID fuite (cf. §4) |
| `PUT /api/sessions/:id/complete` | UUID = capability | 🟡 idem |
| `POST /api/videos` | aucune (quota global) | 🟠 upload public (cf. §3) |
| `GET /api/sessions/:sid/videos/:qid/file` | aucune | 🟡 lecture vidéo si UUID connu |
| `GET /api/health` | aucune | 🟡 fuite nom événement (cf. §6) |

> La Borne physique est censée être sur un réseau local fermé. **Mais la borne *preview* sera
> exposée publiquement** (`essai-<slug>.kapsule.hureau.com`) — donc cette surface devient
> Internet-facing. C'est le cœur du risque.

---

## 2. Secrets & configuration 🔴

- **`JWT_SECRET` défaut `'change-me'`** dans 4 fichiers (`hub/config.js`, `borne/config.js`,
  `provisioner.js:85`, `events.js:296`). Si non surchargé en prod → **n'importe qui peut forger
  un JWT valide** (admin Hub OU rôle borne). Compromission totale.
  → **Action : refuser le démarrage en production si `JWT_SECRET` vaut `change-me`** (fail-fast),
  pas seulement un warning console.
- **`TECH_PASSWORD` défaut `'tech123'`** (`borne/config.js:5`) + `ADMIN_PASSWORD_PREVIEW:-admin123`,
  `TECH_PASSWORD_PREVIEW:-tech123` (`docker-compose.preview.yml`). Sur une preview publique, c'est
  un accès admin/tech borne en clair dans le repo.
  → **Action : pas de défaut ; échec au démarrage si absent en preview exposée.**
  → ✅ **Résolu** (Phase C, PROJET.md §11.30) : `TECH_PASSWORD`/`ADMIN_PASSWORD_PREVIEW`/
  `TECH_PASSWORD_PREVIEW` retirés du code et des composes — plus aucun défaut en clair. Auth
  Borne entièrement passée au PIN partagé (`event_meta.admin_pin`/`tech_pin`, régénérable
  depuis le Hub) + session `tech_borne` auto-émise par `POST /sync/onboarding/pair` à la
  fenêtre pré-premier-pull.
- **`JWT_SECRET` partagé Hub ↔ Borne** (même variable d'env). C'est **voulu** (le Hub signe les
  tokens preview que la borne vérifie, cf. ARCHITECTURE.md §5). Acceptable, mais à documenter :
  un secret unique compromis casse les deux. Acceptable vu l'archi ; ne pas « corriger » sans réflexion.

## 3. DoS / absence de limites 🔴🟠

- 🔴 **`express.json()` sans `limit`** (Hub + Borne). Défaut Express = 100 kb, mais aucune
  limite explicite → un body JSON volumineux (ex. import config avec 100k questions) passe.
  → **Action : `express.json({ limit: '1mb' })`** (ou adapté), partout.
- 🟠 **`POST /api/sessions` (Borne) sans rate-limit** : création de sessions illimitée par un
  anonyme → remplit la table, et chaque session devient une clé d'upload.
- 🟠 **`POST /api/videos` (Borne) sans rate-limit** : upload public plafonné seulement par
  `MAX_DATA_BYTES` **global** (quota disque), pas par IP ni par session. Sur preview publique
  (`MAX_DATA_BYTES=1 Go`), un attaquant peut saturer le Go en uploads de 500 Mo (`VIDEO_MAX_BYTES`).
  → **Action : rate-limit par IP sur `/sessions` et `/videos` ; envisager un plafond par session.**
- 🟡 La fonction `dirSize()` (quota) parcourt tout le disque à **chaque** upload — coûteux, et
  exploitable pour ralentir le service quand beaucoup de fichiers existent.

## 4. Contrôle d'accès / IDOR 🟡

- **`GET /api/sessions/:id/answers` et `/complete`** : le commentaire dit « UUID = capability
  token ». Vrai *si* l'UUID reste secret. Mais il est renvoyé par `POST /sessions` et transite
  dans le front. Un UUID v4 est non-devinable (OK), mais il n'expire jamais et n'est pas lié à
  une auth. Risque réel **faible** (il faut connaître l'UUID), mais à garder en tête : ces routes
  exposent `guest_name` indirectement et permettent de marquer `complete` une session d'autrui.
- **`GET /api/sessions/:sid/videos/:qid/file`** : sert la vidéo d'une session si on connaît les
  deux UUID. Même modèle capability. Acceptable pour le parcours invité, **mais** sur preview
  publique ça signifie que toute vidéo de test est lisible par quiconque a les UUID.
- ✅ **Pas d'IDOR sur le Hub** : `requireOwner` vérifie le membership `event_users` (ou superuser).
- ✅ **Cloisonnement preview** : JWT scopé `event_id` vérifié dans `requireRole` ET `POST /sessions`.

## 5. Injection / traversal ✅ (globalement bon)

- ✅ **SQL** : tout passe par des requêtes paramétrées (`?`), y compris les routes publiques.
  Pas de concaténation de variables user dans du SQL. (Les `UPDATE ... SET ${keys}` de
  `registry.js`/`questions.js` interpolent des **noms de colonnes filtrés par allow-list**, pas
  des valeurs — sûr.)
- ✅ **Path traversal sur `filename`** : à l'upload, `filename = uuidv4()+ext` (non user-controlled).
  Au sync, le Hub réécrit `filename = videoId+ext`. **Vérifier toutefois** que `videoId` est validé
  UUID (il l'est via `validateUuidParams`) — OK.
- ✅ **CSV injection** : neutralisée (préfixe `'` sur `=+-@`) dans gallery.js et videos.js.
- ✅ **Upload fileFilter** : tolérant (Safari) mais borné aux mimes vidéo + extensions connues.
- 🟡 **`extname(file.originalname)`** : l'extension vient du client. Limitée à un set connu côté
  borne (`VIDEO_EXTENSIONS`) mais pas côté hub sync (`|| '.mp4'`). Risque faible (jamais exécuté).

## 6. Fuite d'information 🟡

- **`GET /api/health` (Borne)** renvoie `activeEvent` (id), `eventName`, `isPreview`, espace disque.
  Sur preview publique → fuite le nom de l'événement et l'occupation disque à un anonyme.
  → **Action : réduire `/health` public au strict `{ ok: true }` ; détails derrière auth.**
- **`GET /api/health` (Hub)** renvoie l'espace disque total/libre du VPS. Idem, à restreindre.
- Messages d'erreur : ✅ corrects (les 500 renvoient un message générique, pas de stack).

## 7. En-têtes & transport 🟠

- **Aucun en-tête de sécurité** (pas de `helmet`) : pas de `Content-Security-Policy`,
  `X-Frame-Options` (clickjacking), `X-Content-Type-Options: nosniff`, `Strict-Transport-Security`.
  → **Action : ajouter `helmet` sur les deux serveurs** (ou poser ces headers dans l'edge nginx).
  ⚠️ `helmet` n'est PAS dans la stack figée (PROJET.md §3) → **demander avant d'ajouter la dépendance**,
  ou poser les headers via nginx (sans nouvelle dépendance npm).
- **CORS** : aucune config explicite. Comme front et API sont même origine (servis par nginx),
  c'est OK *tant que* ça reste same-origin. Ne pas ouvrir CORS sans raison.
- **TLS** : géré par l'edge nginx (wildcard Let's Encrypt). ✅ Vérifier HSTS au niveau nginx.

## 8. Auth — détails ✅ avec une réserve

- ✅ JWT vérifié avec `algorithms: ['HS256']` explicite (pare l'attaque `alg:none`).
- ✅ Login Hub : `active` + `password_hash` non-null vérifiés avant `argon2.verify` (§11.22).
- ✅ argon2id pour le hashage. ✅ `timingSafeEqual` pour le PIN partagé (`TECH_PASSWORD`, cité ici à l'origine, a depuis été retiré — Phase C).
- 🟠 **Login Borne sans rate-limit** (contrairement au Hub). Brute-force possible sur
  `POST /api/admin/login` (mot de passe tech, ou comptes nominatifs).
  → **Action : appliquer un `rateLimit` comme sur le Hub.**

---

## Plan de durcissement priorisé (avant exposition)

| # | Sévérité | Action | Fichier(s) | Dépendance ? |
|---|----------|--------|-----------|--------------|
| 1 | 🔴 | Fail-fast si `JWT_SECRET === 'change-me'` en prod | les 2 `config.js` | non |
| 2 | 🔴 | ✅ Résolu (Phase C) — Supprimer défauts `tech123`/`admin123` ; échec si absent (preview) | `borne/config.js`, compose preview | non |
| 3 | 🔴 | `express.json({ limit: '1mb' })` | les 2 `index.js` | non |
| 4 | 🟠 | Rate-limit login Borne | `borne/middleware/auth.js` | express-rate-limit (déjà présent côté hub) |
| 5 | 🟠 | Rate-limit `POST /sessions` + `POST /videos` (Borne) | routes borne | express-rate-limit |
| 6 | 🟠 | En-têtes sécurité (helmet OU nginx) | edge nginx de préférence | nginx (pas de dépendance npm) |
| 7 | 🟡 | Réduire `/health` public à `{ok:true}` | les 2 `index.js` | non |
| 8 | 🟡 | Plafond uploads par session (anti-saturation preview) | `borne/routes/videos.js` | non |

**Notes de mise en œuvre :**
- Les actions 1-3, 7-8 sont **sans nouvelle dépendance** → conformes à la stack figée, faisables tout de suite.
- `express-rate-limit` est **déjà** une dépendance (utilisée par le Hub) → actions 4-5 OK sans demande.
- `helmet` **n'est pas** dans la stack → privilégier les headers **au niveau edge nginx** (action 6)
  pour ne pas toucher PROJET.md §3 ; sinon demander validation explicite avant `npm i helmet`.
- Respecter la règle de travail : un correctif testé (supertest) par lot, `/verif-spec`, commit `phase X.Y`.
