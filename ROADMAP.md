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
- [ ] 1b.1 `api/client.js`, `App.jsx`, routes
- [ ] 1b.2 `hooks/useMediaRecorder.js` (détection MIME Safari/webm, chunks 1 s, auto-stop)
- [ ] 1b.3 Parcours `start → name (consentement RGPD) → questions → done` avec enregistrement + upload XHR

### 1c — Kiosque, robustesse
- [ ] 1c.1 `QuestionNav` (navigation libre, pastilles répondu/non répondu via `/answers`)
- [ ] 1c.2 État `answered` : relecture + « Refaire cette réponse » (remplacement)
- [ ] 1c.3 `RecapScreen` + `ThankYouScreen` (auto-retour 15 s)
- [ ] 1c.4 Timeout d'inactivité (`idle_timeout`, modale 30 s, jamais pendant rec/upload)
- [ ] 1c.5 Reprise après reload (`sessionStorage`, « Reprendre la session de {prénom} ? »)
- [ ] 1c.6 Barre de progression d'upload réelle + retry 5× backoff + écran d'échec
- [ ] 1c.7 Écran « événement terminé » si statut `closed`

### 1d — Admin Borne
- [ ] 1d.1 `AdminLogin` + `AdminLayout` (onglets, indicateur disque permanent, rouge < 10 Go)
- [ ] 1d.2 `EventPanel` (création locale, activation, clôture avec confirmation par saisie du nom)
- [ ] 1d.3 `PreflightPanel` (config, test caméra local, disque, horloge `?client_time=`)
- [ ] 1d.4 `QuestionManager` (form + table + drag-reorder HTML5 natif, mise à jour optimiste)
- [ ] 1d.5 `VideoList` (filtre session, modal lecture Range, download, delete, export CSV)
- [ ] 1d.6 `styles/app.css` (thème invité sombre tactile ≥ 80 px / admin clair)

### Vérifications humaines phase 1
- [ ] 🧑 Parcours invité complet sur iPad Safari réel (caméra, HTTPS auto-signé approuvé, codecs mp4)
- [ ] 🧑 Déploiement arm64 sur Raspberry réel, `DATA_DIR` sur SSD USB, module RTC DS3231 + chrony

**Terminé quand** : un événement entier se déroule sur iPad **sans aucun Hub**.

## Phase 2 — Hub minimal

- [ ] 2.1 `registry.js` Hub (users, boxes, events, jobs, sync_log) + script `create-admin`
- [ ] 2.2 Auth : login argon2 + JWT, **rate-limit 10/15 min/IP**, `requireUser`, `requireOwner` + tests de cloisonnement (2 comptes)
- [ ] 2.3 `eventStore.js` (cache LRU ~10 handles + `closeEventDb()`) + tests
- [ ] 2.4 `routes/events.js` (CRUD, transitions draft↔ready, assign, purge RGPD avec `{confirm: name}`) + tests
- [ ] 2.5 `routes/questions.js` + règle de gel d'édition (409 si statut ≥ `live`) + tests
- [ ] 2.6 Frontend : `LoginPage`, `EventsPage`, `EventDetailPage` (onglet Questions : éditeur + consent_text + idle_timeout + bandeaux gel/« modifs non récupérées »)

**Terminé quand** : deux comptes ne voient que leurs événements ; questions éditables en ligne.

## Phase 3 — Synchro

- [ ] 3.1 Hub : `middleware/boxAuth.js`, CRUD bornes super-admin (token affiché une fois), `last_seen_at`, `sync_log`
- [ ] 3.2 Hub : `GET /sync/assigned`, `GET /sync/events/:id/bundle` (ready→loaded), heartbeat `POST /status` (transitions avant uniquement)
- [ ] 3.3 Hub : `POST /manifest` (réponse `missing`), `PUT /files/:videoId` (recalcul sha256, 422 mismatch), `PUT /db` (fermer handle avant écrasement), `POST /finalize` (enfile les jobs)
- [ ] 3.4 Borne : `hubClient.js` (retry/backoff), `pull.js` (règle `loaded` vérifiée à l'application)
- [ ] 3.5 Borne : `autoPull.js` (intervalle, heartbeat best effort silencieux)
- [ ] 3.6 Borne : `push.js` (checkpoint → manifest → uploads manquants → db → finalize ; reprise via manifest ; exige `closed` → 409 sinon)
- [ ] 3.7 Borne : `routes/sync.js` (status avec progression, pull/push manuels, purge si `pushed` + confirmation)
- [ ] 3.8 UI : `SyncPanel` Borne (online/offline, PUSH avec progression, erreurs 401 token visibles) + onglet Synchro Hub (timeline, jobs, sync_log)
- [ ] 3.9 **Tests d'intégration du protocole** (supertest, Hub réel en mémoire de test) : pull → sessions → push → coupure simulée à mi-upload → relance → reprise via `missing` → finalize
- [ ] 🧑 3.10 Scénario manuel complet Borne réelle ↔ Hub

**Terminé quand** : scénario complet OK **et** tests d'intégration passent (reprise incluse).

## Phase 4 — Traitement & galerie

- [ ] 4.1 Worker : boucle de jobs (`pending` → `running` → `done|failed`), `ffmpeg.js` (spawn, pas de wrapper)
- [ ] 4.2 Jobs `probe` + `thumbnail` (t=1s → `derived/`) + `archive` (ZIP mode **store**) ; passage `processed` quand tout est `done`
- [ ] 4.3 `routes/gallery.js` (list + derived, stream Range, download, thumbnail, CSV avant `/:videoId`, archive 202 si pending, delete vidéo → ré-enfile `archive`) + tests
- [ ] 4.4 `routes/admin.js` overview (stockage/événement, disque libre, jobs failed, bornes)
- [ ] 4.5 Frontend : `VideoGallery` (miniatures, modal, ZIP grisé « préparation… », CSV, suppressions RGPD), `AdminPage`
- [ ] 🧑 4.6 Vérif bout en bout : push réel → miniatures → ZIP téléchargé → purge

**Terminé quand** : après un push, le client voit ses vidéos avec miniatures et télécharge le ZIP ; supprimer l'événement efface tout.

## Phase 5 — Évolutions (au fil de l'eau)

Machine de capture dédiée, job `chromakey`, portail invités, mode point d'accès Wi-Fi (hostapd).
