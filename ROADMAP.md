# ROADMAP — avancement du développement

Document de travail : cocher chaque tâche terminée, commiter à chaque sous-lot.
Les cases 🧑 sont des **vérifications humaines** (matériel réel) — l'IA ne les coche jamais.
Référence : plan de phases PROJET.md §12, critères de fin inclus.

## Phase 0 — Socle

- [x] 0.1 `package.json` racine (npm workspaces), `.gitignore`, `.env.example`
- [x] 0.2 `@kapsule/core` : `constants.js`, `validate.js`, `checksum.js` (stream), `eventDbSchema.js` + `createEventDb()`, `index.js`
- [x] 0.3 Tests unitaires core : `createEventDb` idempotent + seed 4 questions, `sha256File`, validations
- [x] 0.4 Squelette serveur Borne : `index.js`, `config.js`, error handler, `GET /api/health` (statfs + activeEvent)
- [x] 0.5 Squelette serveur Hub : idem
- [x] 0.6 Dockerfiles, `docker-compose.borne.yml` / `docker-compose.hub.yml`, confs Nginx, `borne-entrypoint.sh`
- [x] 🧑 0.7 `docker compose up` sur chaque fichier → `/api/health` répond (vérifiable ici si Docker dispo, sinon humain) ✅ vérifié humain

**Terminé quand** : `npm test` passe ; les deux `/api/health` répondent.

## Phase 1 — Borne autonome

### 1a — Backend Borne
- [x] 1a.1 `registry.js` (local_events, push_state) + `eventDb.js` (cache BD événement actif)
- [x] 1a.2 `middleware/auth.js` (login, JWT 24h, `?token=`) + tests
- [x] 1a.3 `routes/events.js` (liste, création locale, activate, close, `GET /api/event` public, preflight) + tests
- [x] 1a.4 `routes/questions.js` (CRUD + reorder batch transactionnel) + tests
- [x] 1a.5 `routes/sessions.js` (création avec consentement obligatoire → 400 sinon, passage `live`, answers, complete, liste admin) + tests
- [x] 1a.6 `routes/videos.js` (upload multer + sha256 + remplacement transactionnel, stream Range, stream invité par session, CSV avant `/:id`, download, delete) + tests

### 1b — Kiosque, parcours minimal
- [x] 1b.1 `api/client.js`, `App.jsx`, routes
- [x] 1b.2 `hooks/useMediaRecorder.js` (détection MIME Safari/webm, chunks 1 s, auto-stop)
- [x] 1b.3 Parcours `start → name (consentement RGPD) → questions → done` avec enregistrement + upload XHR

### 1c — Kiosque, robustesse
- [x] 1c.1 `QuestionNav` (navigation libre, pastilles répondu/non répondu via `/answers`)
- [x] 1c.2 État `answered` : relecture + « Refaire cette réponse » (remplacement)
- [x] 1c.3 `RecapScreen` + `ThankYouScreen` (auto-retour 15 s)
- [x] 1c.4 Timeout d'inactivité (`idle_timeout`, modale 30 s, jamais pendant rec/upload)
- [x] 1c.5 Reprise après reload (`sessionStorage`, « Reprendre la session de {prénom} ? »)
- [x] 1c.6 Barre de progression d'upload réelle + retry 5× backoff + écran d'échec
- [x] 1c.7 Écran « événement terminé » si statut `closed`

### 1d — Admin Borne
- [x] 1d.1 `AdminLogin` + `AdminLayout` (onglets, indicateur disque permanent, rouge < 10 Go)
- [x] 1d.2 `EventPanel` (création locale, activation, clôture avec confirmation par saisie du nom)
- [x] 1d.3 `PreflightPanel` (config, test caméra local, disque, horloge `?client_time=`)
- [x] 1d.4 `QuestionManager` (form + table + drag-reorder HTML5 natif, mise à jour optimiste)
- [x] 1d.5 `VideoList` (filtre session, modal lecture Range, download, delete, export CSV)
- [x] 1d.6 `styles/app.css` (thème invité sombre tactile ≥ 80 px / admin clair)

### Vérifications humaines phase 1
- [ ] 🧑 Parcours invité complet sur iPad Safari réel (caméra, HTTPS auto-signé approuvé, codecs mp4)
- [ ] 🧑 Déploiement arm64 sur Raspberry réel, `DATA_DIR` sur SSD USB, module RTC DS3231 + chrony

**Terminé quand** : un événement entier se déroule sur iPad **sans aucun Hub**.

## Phase 2 — Hub minimal

- [x] 2.1 `registry.js` Hub (users, boxes, events, jobs, sync_log) + script `create-admin`
- [x] 2.2 Auth : login argon2 + JWT, **rate-limit 10/15 min/IP**, `requireUser`, `requireOwner` + tests de cloisonnement (2 comptes)
- [x] 2.3 `eventStore.js` (cache LRU ~10 handles + `closeEventDb()`) + tests
- [x] 2.4 `routes/events.js` (CRUD, transitions draft↔ready, assign, purge RGPD avec `{confirm: name}`) + tests
- [x] 2.5 `routes/questions.js` + règle de gel d'édition (409 si statut ≥ `live`) + tests
- [x] 2.6 Frontend : `LoginPage`, `EventsPage`, `EventDetailPage` (onglet Questions : éditeur + consent_text + idle_timeout + bandeaux gel/« modifs non récupérées »)

**Terminé quand** : deux comptes ne voient que leurs événements ; questions éditables en ligne.

## Phase 3 — Synchro

> ⚠️ **Révisé en Phase 6** : le passage à token=événement réécrit le modèle `boxes`. Les cases
> 3.1/3.2/3.9 restent cochées (le travail a bien été fait et validé), mais leur implémentation est
> remplacée par `box_tokens` / `GET /sync/event` / `pullMyEvent()` en Phase 6C. Voir 6C.2–6C.3.

- [x] 3.1 Hub : `middleware/boxAuth.js`, CRUD bornes super-admin (token affiché une fois), `last_seen_at`, `sync_log` — *révisé 6C.2 (`box_tokens`)*
- [x] 3.2 Hub : `GET /sync/assigned`, `GET /sync/events/:id/bundle` (ready→loaded), heartbeat `POST /status` (transitions avant uniquement) — *`/assigned` révisé 6C.3 (`GET /sync/event`)*
- [x] 3.3 Hub : `POST /manifest` (réponse `missing`), `PUT /files/:videoId` (recalcul sha256, 422 mismatch), `PUT /db` (fermer handle avant écrasement), `POST /finalize` (enfile les jobs)
- [x] 3.4 Borne : `hubClient.js` (retry/backoff), `pull.js` (règle `loaded` vérifiée à l'application)
- [x] 3.5 Borne : `autoPull.js` (intervalle, heartbeat best effort silencieux)
- [x] 3.6 Borne : `push.js` (checkpoint → manifest → uploads manquants → db → finalize ; reprise via manifest ; exige `closed` → 409 sinon)
- [x] 3.7 Borne : `routes/sync.js` (status avec progression, pull/push manuels, purge si `pushed` + confirmation)
- [x] 3.8 UI : `SyncPanel` Borne (online/offline, PUSH avec progression, erreurs 401 token visibles) + onglet Synchro Hub (timeline, jobs, sync_log)
- [x] 3.9 **Tests d'intégration du protocole** (supertest, Hub réel en mémoire de test) : pull → sessions → push → coupure simulée à mi-upload → relance → reprise via `missing` → finalize
- [ ] 🧑 3.10 Scénario manuel complet Borne réelle ↔ Hub

**Terminé quand** : scénario complet OK **et** tests d'intégration passent (reprise incluse).

## Phase 4 — Traitement & galerie

- [x] 4.1 Worker : boucle de jobs (`pending` → `running` → `done|failed`), `ffmpeg.js` (spawn, pas de wrapper)
- [x] 4.2 Jobs `probe` + `thumbnail` (t=1s → `derived/`) + `archive` (ZIP mode **store**) ; passage `processed` quand tout est `done`
- [x] 4.3 `routes/gallery.js` (list + derived, stream Range, download, thumbnail, CSV avant `/:videoId`, archive 202 si pending, delete vidéo → ré-enfile `archive`) + tests
- [x] 4.4 `routes/admin.js` overview (stockage/événement, disque libre, jobs failed, bornes)
- [x] 4.5 Frontend : `VideoGallery` (miniatures, modal, ZIP grisé « préparation… », CSV, suppressions RGPD), `AdminPage`
- [ ] 🧑 4.6 Vérif bout en bout : push réel → miniatures → ZIP téléchargé → purge

**Terminé quand** : après un push, le client voit ses vidéos avec miniatures et télécharge le ZIP ; supprimer l'événement efface tout.

## Phase S — Sécurité (durcissement)

Plan de mitigation issu de l'audit [SECURITY.md](SECURITY.md) (2026-06-14). Ordre par
priorité décroissante ; chaque case référence le finding correspondant. Mêmes règles que les
autres phases : un correctif backend n'est terminé que **testé** (cas nominal + cas d'attaque
bloqué), relu par `kapsule-reviewer`, committé en sous-lot.

### S1 — Path traversal synchro Hub (H1, 🔴)
- [x] S1.1 Middleware `validateUuidParams` (regex UUID stricte sur `:id`/`:videoId` → 400) monté **avant** multer dans `routes/sync.js` ; test : `..`/`%2e%2e` rejeté avant toute écriture disque, UUID valide accepté

### S2 — Secrets par défaut refusés au démarrage (M3, 🟠) — ⏸ REPORTÉ EN FIN DE PROJET
> Décision : non prioritaire (durcissement de déploiement). À reprendre à la toute fin.
- [ ] S2.1 Hub : refus de booter si `JWT_SECRET` vaut `change-me` ou < N caractères, **hors tests** (garde dans `index.js`/`config.js`) + test
- [ ] S2.2 Borne : même garde sur `JWT_SECRET` et `ADMIN_PASSWORD` (`admin123`) + test
- [ ] 🧑 S2.3 Vérifier qu'un déploiement prod sans `.env` correct échoue explicitement (message clair)

### S3 — Limites d'upload + DoS disque Hub (M2, 🟠)
- [x] S3.1 `limits: { fileSize, files: 1 }` sur `uploadVideo` et `uploadDbFile` (`routes/sync.js`) + test (413/400 au-delà de la limite)

### S4 — Injection de formule CSV (M1, 🟠)
- [x] S4.1 Neutralisation des préfixes `= + - @ \t \r` dans l'échappement CSV (borne `videos.js` ET hub `gallery.js`) + test (prénom `=cmd…` exporté inerte)

### S5 — Durcissements défense en profondeur (L1–L3, 🟡)
- [x] S5.1 Épingler `algorithms: ['HS256']` dans tous les `jwt.verify` (hub + borne) + test
- [x] S5.2 Login admin Borne : `crypto.timingSafeEqual` au lieu de `!==` sur le mot de passe + test
- [x] S5.3 Error handler : message générique pour les 500 côté client, détail loggé serveur (hub + borne) + test (pas de fuite de chemin/erreur SQL)

> **L4** (JWT en `?token=` dans les logs Nginx) : risque **accepté**, déjà tracé PROJET.md §13.
> À réévaluer si un token média court (5 min) est introduit — hors périmètre de cette phase.

**Terminé quand** : H1 et M1–M3 corrigés et testés ; le tableau de suivi de SECURITY.md est à jour (statut « Corrigé » + n° de commit).

## Phase 6 — Refonte administration

Voir PROJET.md §12 (ligne « 6 — Refonte administration ») et les invariants §11.19–22.
Ordre conseillé : **6A → 6B → 6C → 6D → 6E**. 6A est autonome (Borne seule) ; 6C porte le
changement de schéma token=événement dont dépend 6D. Mêmes règles : un sous-lot backend n'est
terminé que **testé** (nominal + cas d'erreur/d'attaque), relu par `kapsule-reviewer` (`/verif-spec`),
committé en `phase 6X.Y: …`.

### 6A — Borne : admin client / tech
- [x] 6A.1 `config.js` : `TECH_PASSWORD`. `middleware/auth.js` : login signe `role:'client'|'tech'` selon le mot de passe (les deux comparés en `timingSafeEqual`, cf. S5.2) ; `requireTech` (accepte `tech`), `requireAdmin` = client OU tech + tests (login client→client, login tech→tech, 403 client sur route tech)
- [ ] 6A.2 Re-tagger les routes Borne : `requireTech` sur `/preflight`, `/events/:id/close`, tout `/sync/*` ; `requireAdmin` ailleurs (questions, vidéos, settings, activate) + tests (token client rejeté sur `/sync/push`, accepté sur `/questions`) — invariant §11.19
- [ ] 6A.3 Front : routing manuel (`window.location.pathname`) → `/admin` (client : Événement, Questions, Vidéos, Design) et `/admin/tech` (login séparé : Préflight, Synchro) ; deux logins, deux clés `localStorage` (`admin_token`/`tech_token`)
- [ ] 6A.4 `AdminLayout` paramétré par rôle (jeu d'onglets), bandeau « espace technicien » sur `/admin/tech` ; CSS des deux zones (réutilise l'existant)

### 6B — Hub : comptes clients
- [ ] 6B.1 Schéma `users` : `active INTEGER DEFAULT 1`, `password_hash` nullable ; table `registration_tokens` (token_hash, user_id, expires_at, used_at) + helpers registry
- [ ] 6B.2 `routes/admin.js` : `POST /api/admin/users` (compte sans mdp + token d'inscription +7 j, retourne `registration_url`), `GET /api/admin/users`, `PUT /api/admin/users/:id` (active/rename), `POST /api/admin/users/:id/registration-link` + tests (email dupliqué 409, désactivation)
- [ ] 6B.3 `routes/auth.js` : `POST /api/auth/set-password` `{ token, password }` (token non expiré/non utilisé → pose hash argon2, marque utilisé) ; login refuse `active=0` et `password_hash` NULL **sans appeler `argon2.verify(null,…)`** (invariant §11.22) + tests (token expiré 410, réutilisé 409, mdp court 400, login compte désactivé 401)
- [ ] 6B.4 Front : `RegisterPage` (`/register?token=`, pose le mot de passe) ; section « Clients » de l'admin Hub (créer, copier le lien, activer/désactiver)

### 6C — Hub : super-admin UI + modèle token=événement ⚠️ change le schéma
- [ ] 6C.1 `App.jsx` : câbler la route `/admin` (composant `AdminPage.jsx` existe, orphelin) gardée `role==='admin'`
- [ ] 6C.2 Schéma : **`box_tokens`** (event_id, token_hash, label, location, is_preview, last_seen_at) remplace `boxes` ; retirer `events.box_id`. Migrer `middleware/boxAuth.js` → `requireBox` charge la ligne et expose `req.box={token_id,event_id,is_preview}`. `routes/admin.js` : `POST/GET /api/admin/events/:id/tokens`, `DELETE/PUT /api/admin/tokens/:tokenId` + tests
- [ ] 6C.3 `routes/sync.js` Hub : `GET /sync/assigned` → `GET /sync/event` (singulier, 404 si non pullable) ; `bundle` rejette (403) si `:id` ≠ `req.box.event_id` (invariant §11.20). Borne : `pull.js` `pullAssigned()` → `pullMyEvent()`, adapter `autoPull.js` + **mettre à jour les tests d'intégration 3.9**
- [ ] 6C.4 Front super-admin : onglets Vue d'ensemble (existant), Événements (créer + générer token réel/essai avec token affiché une fois + location), Clients (6B)

### 6D — Aperçu distant (borne d'essai) — dépend de 6C
- [ ] 6D.1 Borne : `config.js` lit `MAX_DATA_BYTES` ; `routes/videos.js` refuse l'upload invité (507) si `dirSize(events/) ≥ MAX_DATA_BYTES` (vérif **avant** écriture, invariant §11.21) + test
- [ ] 6D.2 Borne : mode démo déduit du token `is_preview` (ou `PREVIEW_MODE`) → push refusé (409) + bandeau « BORNE D'ESSAI » (kiosque + admin) + test
- [ ] 6D.3 Borne : `POST /api/sync/reset-preview` (tech) — purge sessions/vidéos de l'événement actif sans toucher aux questions ; refusé hors mode démo + test
- [ ] 6D.4 Hub front : onglet client « Aperçu de la borne » dans `EventDetailPage` (visible si l'événement a un token `is_preview`) → lien/iframe vers l'URL de preview (proxy interne)
- [ ] 6D.5 `docker-compose.preview.yml` : service `borne-preview` (`BOX_TOKEN=<token-essai>`, `MAX_DATA_BYTES=1073741824`, port interne), documenté ; entrée dans CLAUDE.md §Commandes
- [ ] 🧑 6D.6 Vérif bout en bout : conteneur d'essai lancé avec un token → client valide la config à distance → reset → push bien refusé

### 6E — Documentation
- [ ] 6E.1 `kapsule-doc-sync` sur le site `docs/` au fil des sous-lots (déjà couvert par `/verif-spec`)
- [ ] 6E.2 Vérifier la cohérence finale PROJET.md ↔ code (schéma `box_tokens`, routes admin/sync, env)

**Terminé quand** : le client gère sa borne sans accès tech ; un compte client se crée via lien d'enregistrement ; lancer le conteneur d'essai avec un token le rattache à son événement ; le client valide sa config à distance (≤ 1 Go, push impossible).

## Phase 7 — Évolutions (au fil de l'eau)

Machine de capture dédiée, job `chromakey`, portail invités, mode point d'accès Wi-Fi (hostapd).
