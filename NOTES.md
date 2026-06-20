# Notes techniques — observations en attente

Ce fichier recense des observations issues des revues de code (agent `kapsule-reviewer`)
qui ne sont **pas des bugs actifs** et **ne doivent pas être appliquées pour l'instant**.
Elles servent de référence pour le débogage futur si un comportement inattendu apparaît.

---

## Phase V2.9 — QuestionSheet / QuestionNav (revue kapsule-reviewer)

### `touchStartY.current` non réinitialisé dans `handleTouchEnd`

**Fichiers :** `QuestionSheet.jsx:17-20`, `QuestionNav.jsx:242-246`

**Observation :** Si `handleTouchEnd` est déclenché sans `handleTouchStart` préalable (événement
tactile partiel ou replay synthétique), `touchStartY.current` vaut `null` → `dy = null - clientY`
→ `NaN`. La comparaison `NaN > 60` est `false`, donc pas d'effet visible sur kiosque réel. Fragile
néanmoins si les handlers sont réutilisés dans un autre contexte.

**À ne pas corriger maintenant.**

---

### Absence de focus trap / fermeture Échap sur `QuestionSheet` (`role="dialog"`)

**Fichier :** `QuestionSheet.jsx`

**Observation :** Le panneau est marqué `role="dialog"` / `aria-modal="true"` mais n'implé-mente ni
focus trap ni fermeture par Échap. Sur kiosque tactile plein écran, l'impact est mineur (pas de
clavier physique, focus management non attendu). À revoir si l'accessibilité clavier devient un
critère (ex. borne avec clavier Bluetooth).

**À ne pas corriger maintenant.**

---

## Phase 6 (planification) — pistes écartées pour la refonte administration

Décisions prises lors du cadrage de la Phase 6 (admin client/tech + token=événement + aperçu).
Reportées dans PROJET.md §13 ; rappelées ici pour le contexte de mise en œuvre.

### Token « pur événement » sans table `box_tokens`
Modéliser le token directement comme une colonne `box_token_hash` sur `events` (1 token = 1 colonne)
aurait été plus minimal, mais empêche d'avoir **plusieurs tokens par événement** (le réel + l'essai)
et la révocation indépendante d'un token. Retenu : table `box_tokens` (§5.3).
**À ne pas reconsidérer maintenant** sauf si la gestion de plusieurs tokens s'avère inutile à l'usage.

### Lien de partage sans compte pour l'aperçu client
Un lien tokenisé ouvrant directement l'aperçu (sans login Hub) aurait évité au client de créer un
compte, mais ajoute un 2ᵉ système d'accès à maintenir. Retenu : onglet « Aperçu de la borne » dans
l'espace client existant. **À réévaluer** seulement si un client refuse de créer un compte.

### Auto-détection du mode démo via le token vs `PREVIEW_MODE`
Le mode démo est **déduit du token `is_preview`** (le token porte déjà l'info) ; `PREVIEW_MODE` reste
un override d'env optionnel. Ne pas dupliquer la source de vérité : si un jour les deux divergent,
le token (côté Hub) prime sur l'env (côté conteneur).

---

## Phase V2 — revue parcours invité

### `??` vs `||` incohérent sur les champs texte dans `GET /event`

**Fichier :** [events.js (borne)](apps/borne/server/src/routes/events.js) — handler `GET /event`

**Observation :** `welcome_title`/`welcome_subtitle` utilisent `||` (chaîne vide → fallback dynamique),
mais `consent_text`/`name_prompt`/`consent_details`/`thanks_text` utilisent `??` (chaîne vide stockée
→ servie telle quelle). Conséquence : si l'admin enregistre un `consent_text` vide, les invités voient
un consentement vide. Risque RGPD réel.

**Correction simple :** remplacer `??` par `||` pour tous ces champs dans `GET /event`, ou refuser
un `consent_text` vide à l'écriture (validation dans `PUT /settings`).

**À ne pas corriger maintenant.**

---

## Phase 4.5 — Frontend Hub VideoGallery + AdminPage

### Duplication de helpers de formatage entre VideoGallery et AdminPage

**Fichiers :** [VideoGallery.jsx](apps/hub/web/src/components/VideoGallery.jsx), [AdminPage.jsx](apps/hub/web/src/pages/AdminPage.jsx)

**Observation :** `formatSize`/`formatBytes` et `formatDate` sont définis dans les deux composants séparément. Factorisable dans un util frontend partagé.

**À ne pas corriger maintenant.**

---

## Phase 4.3 — routes/gallery.js

### Pas de 416 Range Not Satisfiable

**Fichier :** [gallery.js:32-34](apps/hub/server/src/routes/gallery.js#L32)

**Observation :** le parsing Range ne gère pas les bornes invalides ou hors taille du fichier — un Range malformé retourne 206 incohérent plutôt que 416. Même comportement que `videos.js` côté Borne (cohérence interne). Le cas ne se produit pas avec les clients navigateur standard.

**À ne pas corriger maintenant.**

---

### Test du 409 `requirePushed` manquant

**Fichier :** [gallery.test.js](apps/hub/server/test/gallery.test.js)

**Observation :** aucun test ne couvre le cas où la galerie est demandée sur un événement en statut `< pushed` (ex. `draft`/`loaded`), qui devrait retourner 409. Le garde existe et est correct.

**À ne pas corriger maintenant.**

---

## Phase 4.1 — Worker boucle de jobs + ffmpeg.js

### `archive.js` : détection de la présence du ZIP côté galerie

**Fichier :** [archive.js:42-45](apps/hub/server/src/worker/jobs/archive.js#L42)

**Observation :** le job `archive` ne stocke pas le chemin du ZIP dans une colonne dédiée du registre — la galerie (4.3) devra détecter la présence du fichier via l'existence physique de `derived/archive.zip` et le statut `done` du job `archive`. C'est à clarifier explicitement lors de l'implémentation de `routes/gallery.js`.

**À ne pas corriger maintenant.**

---

### `recoverOrphans` rejette sans plafond d'attempts

**Fichier :** [worker/index.js](apps/hub/server/src/worker/index.js)

**Observation :** un job qui crashe le worker en boucle sera rejoué indéfiniment car `recoverOrphans` ne plafonne pas `attempts`. La politique de retry/max-attempts est explicitement une piste écartée pour l'instant (PROJET.md §13). Si un job poison apparaît, la seule sortie est une intervention manuelle (supprimer ou passer le job en `failed` en base).

**À ne pas corriger maintenant.**

---

### `process.argv[1]` fragile pour détection du point d'entrée

**Fichier :** [worker/index.js](apps/hub/server/src/worker/index.js)

**Observation :** `process.argv[1] === new URL(import.meta.url).pathname` peut échouer si lancé via symlink ou chemin non canonique. `fileURLToPath(import.meta.url)` serait plus robuste.

**À ne pas corriger maintenant.**

---

## Phase 3.9 — Tests d'intégration du protocole

### Heartbeat `closed` envoyé par `push.js` peut sauter la phase `live` sur le Hub

**Fichier :** [push.js:126-129](apps/borne/server/src/sync/push.js#L126)

**Observation :** avant d'envoyer le manifest, `pushEvent` envoie un heartbeat `POST /status {closed}` best-effort. Si la Borne est restée offline pendant l'événement (pas de heartbeat `live`), le Hub verra l'event passer directement de `loaded` à `closed`. La transition est autorisée par `statusRank` (loaded=2 → closed=4), mais le bandeau Hub "événement en cours" ne se sera jamais affiché. PROJET.md ne l'interdit pas.

**À ne pas corriger maintenant.**

---

### `.catch(() => {})` sur le heartbeat avale les 401

**Fichier :** [push.js:130](apps/borne/server/src/sync/push.js#L130)

**Observation :** si le token borne est révoqué, le heartbeat retourne 401 mais l'erreur est silencieuse. Le manifest suivant lèvera aussi une 401 et sera capturé par le `catch` global avec le message « Token borne révoqué ». L'erreur n'est donc pas perdue — simplement diagnostiquée au prochain appel. Un commentaire dans le code le préciserait.

**À ne pas corriger maintenant.**

---

### Patch global de `setTimeout` dans le test de coupure

**Fichier :** [integration.sync.test.js:373](apps/hub/server/test/integration.sync.test.js#L373)

**Observation :** `globalThis.setTimeout = (fn) => { fn(); return 0; }` est restauré ligne 393 mais reste global pendant la coupure. Si `node:test` parallélise des suites un jour (aujourd'hui elles sont séquentielles car elles partagent `eventId`), ce patch pourrait perturber d'autres tests.

**À ne pas corriger maintenant.**

---

## Phase 3.8 — SyncPanel Borne + onglet Synchro Hub

### `online` signifie « Hub configuré » et non « Hub joignable »

**Fichier :** [routes/sync.js:17](apps/borne/server/src/routes/sync.js#L17), [SyncPanel.jsx:91](apps/borne/web/src/components/admin/SyncPanel.jsx#L91)

**Observation :** `online = !!hubUrl` — le badge « En ligne » s'affiche dès qu'une URL Hub est configurée, même si le réseau est coupé. Les boutons Pull/PUSH sont activés dans ce cas.

**À ne pas corriger maintenant.** Pour une vraie détection : stocker le timestamp du dernier appel réussi dans `autoPull.js` et l'exposer via `GET /sync/status`.

---

### SyncPanel ne recharge pas la liste des events après push réussi

**Fichier :** [SyncPanel.jsx:79-80](apps/borne/web/src/components/admin/SyncPanel.jsx#L79)

**Observation :** `closedEvents`/`pushedEvents` sont filtrés depuis `events` rechargé uniquement au montage. Après un push (closed→pushed), la liste ne se met à jour qu'au remount suivant.

**À ne pas corriger maintenant.** Ajouter un `loadEvents()` quand `push.running` passe de `true` à `false` (via un `useEffect` sur `status?.push?.running`).

---

### SyncStatus Hub : `JSON.parse(l.detail)` sans try/catch

**Fichier :** [SyncStatus.jsx:127](apps/hub/web/src/components/SyncStatus.jsx#L127)

**Observation :** si un `detail` non-JSON apparaissait dans `sync_log` (ex. bug futur), le rendu crasherait.

**À ne pas corriger maintenant.** Ajouter un `try/catch` ou `?? l.detail` en fallback si ce cas se présente.

---

## Phase 3.7 — routes/sync.js (Borne)

### `online` reflète la présence de hubUrl, pas la connectivité réelle

**Fichier :** [routes/sync.js:17](apps/borne/server/src/routes/sync.js#L17)

**Observation :** `online = !!(cfg.hubUrl)` vaut toujours `true` si un Hub est configuré, même si le réseau est coupé. Le SyncPanel (3.8) affiche « online/offline » — ce champ donnera une information trompeuse si le Hub est temporairement injoignable.

**Alternative :** dériver `online` du résultat du dernier appel réussi (stocker un timestamp dans `autoPull`).

**À ne pas corriger maintenant.** Pour 3.8, documenter que `online` signifie « Hub configuré ». Une vraie détection de connectivité peut être ajoutée si le retour terrain le demande.

---

### push en tâche de fond sans propagation d'erreur vers le client

**Fichier :** [routes/sync.js:53](apps/borne/server/src/routes/sync.js#L53)

**Observation :** `pushEvent(...).catch(() => {})` avale toute erreur silencieusement. Un push qui échoue (401 token révoqué, erreur réseau…) est indistinguable d'un push réussi dans `GET /sync/status`. Le SyncPanel ne peut pas afficher l'erreur token (§11.13).

**À ne pas corriger maintenant.** Pour 3.8 : ajouter un champ `lastError` dans `_state` de `push.js`, populé en cas d'échec, et l'exposer dans `getPushState()`.

---

## Phase 3.6 — push.js (Borne)

### uploadFileWithRetry charge tout le fichier en mémoire

**Fichier :** [push.js:36-39](apps/borne/server/src/sync/push.js#L36)

**Observation :** `for await ... chunks.push(chunk)` puis `new Blob(chunks)` bufferise tout le fichier avant chaque tentative. Sur Raspberry Pi avec des vidéos ~500 MB et plusieurs retries, ça peut faire exploser la RAM.

**Alternative :** passer un `ReadableStream` / `Readable` comme body avec `duplex: 'half'`. Mais `FormData + ReadableStream` n'est pas universellement supporté en Node 20 sans polyfill.

**À ne pas corriger maintenant.** À surveiller si des OOM apparaissent lors des tests réels sur Raspberry.

---

### Test §11.8 : WAL pas forcément non-vide avant checkpoint

**Fichier :** [sync.push.test.js:328-348](apps/borne/server/test/sync.push.test.js#L328)

**Observation :** `walExists` est calculé mais non asserté. Si SQLite fait un auto-checkpoint avant le test, il n'y a pas de WAL à vider, et le test passe même sans `wal_checkpoint(TRUNCATE)`. Pour rendre le test déterministe : désactiver l'auto-checkpoint via `PRAGMA wal_autocheckpoint=0` avant d'écrire, puis asserter que le WAL existe avant et est vide après.

**À ne pas corriger maintenant.**

---

## Phase 3.5 — autoPull.js (Borne)

### Test "lastPull reste null si le pull échoue" sans vraie assertion

**Fichier :** [sync.autoPull.test.js:211-224](apps/borne/server/test/sync.autoPull.test.js#L211)

**Observation :** le test n'asserte rien sur `getLastPull()` — il fait `assert.doesNotReject(async () => {})` qui est toujours vrai. `_lastPull` étant un état module-level partagé entre suites, la valeur peut être polluée par le test précédent. Le cas erreur n'est pas réellement couvert.

**Alternative à envisager :** exposer un `resetLastPull()` pour les tests, ou exporter `runCycle` et l'`await` directement (supprimerait aussi la dépendance aux `setTimeout(50ms)`).

**À ne pas corriger maintenant.** Le comportement silencieux du pull échoué est bien testé indirectement (le cycle ne plante pas).

---

### Heartbeat : headers `Content-Type` redondants

**Fichier :** [autoPull.js:27](apps/borne/server/src/sync/autoPull.js#L27)

**Observation :** `hubFetch` pose déjà `Content-Type: application/json` si `body` est une string (hubClient.js:27-29). Le `headers` explicite dans `sendHeartbeats` est redondant mais inoffensif.

**À ne pas corriger maintenant.**

---

## Phase 3.3 — Hub push endpoints (manifest/files/db/finalize)

### Nettoyage WAL/SHM avant remplacement de db.sqlite

**Fichier :** [sync.js](apps/hub/server/src/routes/sync.js) — PUT /db

**Observation :** après `closeEventDb`, un `db.sqlite-wal` ou `db.sqlite-shm` résiduel (laissé par un crash antérieur) pourrait être rejoué par SQLite par-dessus la nouvelle base au prochain `openEventDb`. La correction appliquée : `unlink` best-effort de `dest + '-wal'` et `dest + '-shm'` avant `renameSync`.

**Résolu en 3.3.**

---

## Phase 3.1 — boxAuth.js + routes/admin.js Hub

### boxAuth : branches critiques non couvertes par les tests en 3.1

**Résolu en 3.2** : `sync.test.js` couvre désormais toutes les branches de `requireBox` (401 header absent, 401 token invalide, `last_seen_at` mis à jour, absence de double sync_log sur `GET /assigned`).

---

### boxAuth : `req._syncLogAction` convention implicite

**Résolu en 3.2** : le `insertSyncLog` a été retiré du middleware. Chaque route pose son propre log avec l'action précise (`'pull'`, `'status'`). `GET /assigned` n'écrit aucun log (pas d'action métier à tracer).

---

## Phase 2.6 — Frontend Hub

### consent_text/idle_timeout : pré-remplissage par défaut, pas par la valeur réelle

**Fichier :** [EventDetailPage.jsx:42-49](apps/hub/web/src/pages/EventDetailPage.jsx#L42)

**Observation :** `consentText` et `idleTimeout` sont initialisés aux `DEFAULTS` au montage, jamais à la valeur stockée dans `event_meta`. Si l'utilisateur ouvre un événement déjà configuré et clique « Sauvegarder » sans rien toucher, il **écrase le texte RGPD personnalisé par le texte par défaut** silencieusement.

**Cause racine :** `GET /api/events/:id` lit uniquement le registre, pas `event_meta` du `db.sqlite` événement. L'exposer nécessite un appel à `openEventDb` dans cette route.

**À ne pas corriger maintenant.** Deux corrections possibles en phase 2.4+ :
1. Enrichir `GET /api/events/:id` pour lire `event_meta` via `openEventDb`.
2. N'envoyer dans le `PUT` que les champs effectivement modifiés par l'utilisateur (state dirty).

---

### QuestionEditor : erreurs d'API avalées silencieusement

**Fichier :** [QuestionEditor.jsx:75](apps/hub/web/src/components/QuestionEditor.jsx#L75)

**Observation :** les `catch {}` sur `handleAdd`/`handleEdit`/`onDragEnd` n'affichent rien à l'utilisateur. Un 409 de gel d'édition ou un 403 passera inaperçu.

**À ne pas corriger maintenant.** Ajouter un state `error` et un message visible si le comportement est rapporté.

---

## Phase 2.5 — routes/questions.js Hub

### GET questions Hub : questions disabled non testées explicitement

**Fichier :** [questions.test.js](apps/hub/server/test/questions.test.js)

**Observation :** contrairement à la Borne (filtre `WHERE enabled=1`), le Hub retourne toutes les questions (enabled ou non) pour l'éditeur. Aucun test ne couvre ce comportement explicitement.

**À ne pas corriger maintenant.** Si une régression introduit un filtre `enabled=1`, un test nominal suffit (créer une question disabled, vérifier qu'elle apparaît dans GET Hub).

---

### reorder/batch : pas de vérification de l'ordre persisté

**Fichier :** [questions.test.js](apps/hub/server/test/questions.test.js)

**Observation :** le test `reorder/batch` vérifie seulement `{ ok: true }`, pas que `order_index` est bien persisté après le PUT.

**À ne pas corriger maintenant.**

---

## Phase 2.4 — routes/events.js Hub

### Dossier orphelin si insertEvent échoue après mkdirSync

**Fichier :** [events.js:42-46](apps/hub/server/src/routes/events.js#L42)

**Observation :** si `insertEvent` lève (ex. contrainte UNIQUE sur l'id uuid — quasi impossible, mais théorique), le dossier `events/<id>/` reste orphelin sur le disque.

**À ne pas corriger maintenant.** Les UUIDs v4 ne collisionnent pas en pratique. Si ce bug se manifeste, ajouter un `rmSync(eventDir, { recursive: true, force: true })` dans le `catch` avant de propager l'erreur.

---

### Gel d'édition non testé sur PUT /:eventId (metadata)

**Fichier :** [events.test.js](apps/hub/server/test/events.test.js)

**Observation :** le gel 409 (statut ≥ live) est testé sur `PUT /status` mais pas sur `PUT /` (name/consent_text). Le code `events.js:66` le gère correctement mais sans test direct.

**À ne pas corriger maintenant.** La logique `isFrozen` est la même fonction dans les deux handlers.

---

## Phase 2.3 — eventStore.js

### Seed automatique à surveiller au push (phase 3)

**Fichier :** [eventStore.js:34](apps/hub/server/src/eventStore.js#L34)

**Observation :** `openEventDb` appelle `createEventDb` qui seede 4 questions par défaut si la table est vide. Côté Hub, si `openEventDb` est appelé avant réception/écrasement du `db.sqlite` au push, le Hub crée une base parasitée à 4 questions de mariage. Le `closeEventDb` doit impérativement précéder l'écrasement du fichier (invariant §11.11) — et `openEventDb` ne doit pas être appelé avant que le vrai `db.sqlite` soit en place.

**À ne pas corriger maintenant.** À vérifier au câblage de `PUT /api/sync/events/:id/db` en phase 3 : l'ordre doit être `closeEventDb(id)` → écrasement fichier → `openEventDb(id)` si nécessaire.

---

### `openEventDb` ne crée pas le répertoire `events/<id>/`

**Fichier :** [eventStore.js:21](apps/hub/server/src/eventStore.js#L21)

**Observation :** `better-sqlite3` lève si le dossier parent n'existe pas. Les appelants (création d'événement Hub) doivent garantir l'existence du dossier avant le premier appel.

**À ne pas corriger maintenant.** Contrat à vérifier au câblage de `routes/events.js` (phase 2.4) : `mkdirSync` avant `openEventDb`.

---

## Phase 2.1 — registry.js Hub + create-admin

### Mot de passe en clair dans create-admin

**Fichier :** [create-admin.js](apps/hub/server/src/scripts/create-admin.js)

**Observation :** `readline` affiche le mot de passe en clair pendant la saisie (pas de masquage). Conforme à la spec (« prompt email/mdp »), mais un prompt masqué (`process.stdin.setRawMode` ou `process.stdout.write('\x1b[?25l')`) serait plus sûr.

**À ne pas corriger maintenant.** Script utilisé une fois par déploiement, en accès shell direct au conteneur.

---

### `updateEvent` recompute deux fois le filtre des champs

**Fichier :** [registry.js:125-130](apps/hub/server/src/registry.js#L125)

**Observation :** `Object.keys(fields).filter(k => allowed.includes(k))` est évalué deux fois (une pour `updates`, une pour `values`). Sans incidence fonctionnelle — les tests couvrent l'anti-injection et l'ignorance des champs inconnus.

**À ne pas corriger maintenant.**

---

## Phase 1c.5 — Reprise après reload / sessionStorage

### `questionIndex` restauré sans vérification de borne

**Fichier :** [GuestPage.jsx:156](apps/borne/web/src/pages/GuestPage.jsx#L156)

**Observation :** à la restauration depuis `sessionStorage`, `questionIndex` est appliqué tel quel
sans vérifier qu'il est dans les bornes de `questions`. Si la configuration de l'événement a changé
entre le crash et le reload (questions désactivées ou supprimées, tableau `questions` plus court),
`questions[questionIndex]` serait `undefined` et `q.id` lèverait une exception au rendu.

**Pourquoi ce n'est pas un problème aujourd'hui :** le scénario requiert un rechargement de la SPA
ET une modification simultanée des questions par l'admin — deux opérations rares simultanées. De
plus le rendu `S.QUESTIONS` est gardé par `questions.length > 0` mais `questionIndex` hors borne
passerait quand même.

**Quand ça pourrait devenir un problème :** si un admin supprime des questions pendant qu'un invité
a une session en cours (iPad crashé puis rechargé).

**À ne pas corriger maintenant.** Si ce bug se manifeste, appliquer
`Math.min(saved.questionIndex, questions.length - 1)` à la ligne de restauration (~156).

---

## Phase 1c.4 — Timeout d'inactivité / modale IdleModal

### `idleModalVisible` non remis à `false` à la sortie de IDLE_SCREENS

**Fichier :** [GuestPage.jsx:135-149](apps/borne/web/src/pages/GuestPage.jsx#L135)

**Observation :** l'effet qui quitte `IDLE_SCREENS` (entrée dans `QUESTIONS`) annule le timer
mais ne remet pas `idleModalVisible` à `false`. Si la modale était visible au moment de la transition,
elle resterait affichée sur QUESTIONS.

**Pourquoi ce n'est pas un problème aujourd'hui :** la modale est plein écran (z-index 100) et bloque
toute interaction sous-jacente. Il est donc impossible de déclencher `handleSession` (qui mène à
QUESTIONS) tant que la modale est affichée — la transition NAME→QUESTIONS ne peut pas se produire
avec la modale ouverte.

**Quand ça pourrait devenir un problème :** si on ajoute une transition automatique (ex. redirection
après login) ou si on retire l'overlay full-screen de la modale.

**À ne pas corriger maintenant.** Si ce bug se manifeste, ajouter `setIdleModalVisible(false)` dans
la branche `!IDLE_SCREENS.has(screen)` de l'effet (ligne ~137).

---

### Pattern compte-à-rebours dupliqué entre `IdleModal` et `ThankYouScreen`

**Fichiers :** [GuestPage.jsx:50-65](apps/borne/web/src/pages/GuestPage.jsx#L50),
[ThankYouScreen.jsx:9-13](apps/borne/web/src/components/guest/ThankYouScreen.jsx#L9)

**Observation :** les deux composants implémentent le même pattern `setTimeout/remaining--` inline.
Candidat à un hook `useCountdown(seconds, onExpire)` si le motif réapparaît une troisième fois.

**À ne pas extraire maintenant** (deux occurrences, la règle « three similar lines » de CLAUDE.md
n'est pas atteinte).

---

## Phase 1c.1 — QuestionNav / navigation entre questions

### `refreshAnswers()` sans `await` avant `setQuestionIndex`

**Fichiers :** [GuestPage.jsx:130](apps/borne/web/src/pages/GuestPage.jsx#L130),
[GuestPage.jsx:136](apps/borne/web/src/pages/GuestPage.jsx#L136)

**Observation :** `refreshAnswers()` est appelée sans `await` juste avant `setQuestionIndex`.
Il existe une fenêtre courte où l'écran de destination monte avec les anciens `answers`
(avant que `setAnswers` ait résolu).

**Pourquoi ce n'est pas un problème aujourd'hui :** `RecordingScreen` est keyé par
`questionIndex` dans `GuestPage` (`key={sessionId-qN}`), ce qui force un remount complet
à chaque changement de question. `existingVideoId` est recalculé depuis `answers` à chaque
montage — la valeur fraîche arrive dès que `setAnswers` résout, avant le prochain render utile.

**Quand ça pourrait devenir un problème :** si on retire ou change la stratégie de `key`
sur `RecordingScreen`, l'état `answered` pourrait être stale lors de la navigation.

**À ne pas corriger maintenant.** Si ce bug se manifeste, ajouter un `useEffect` sur
`questionIndex` dans `GuestPage` qui attend `refreshAnswers()` avant de laisser `RecordingScreen`
se monter (ex. via un état `answersReady`).

---

---

## Phase 1d.6 — Styles

### `body` sans `-moz-user-select`

**Fichier :** [app.css](apps/borne/web/src/styles/app.css)

**Observation :** `user-select: none` sur `body` ne porte pas le préfixe `-moz-`. Non bloquant : cible iPad Safari uniquement, `-webkit-user-select` suffit.

**À ne pas corriger maintenant.**

---

## Phase 1d.5 — VideoList

### Échec silencieux de `loadSessions`

**Fichier :** [VideoList.jsx:38](apps/borne/web/src/components/admin/VideoList.jsx#L38)

**Observation :** `loadSessions` absorbe toute erreur silencieusement. L'admin n'a aucun retour si la liste des sessions échoue (le filtre sera vide mais les vidéos s'affichent). Non critique.

**À ne pas corriger maintenant.**

---

## Phase 1d.4 — QuestionManager

### `onDragEnd` : stale closure potentielle sur `questions`

**Fichier :** [QuestionManager.jsx:158](apps/borne/web/src/components/admin/QuestionManager.jsx#L158)

**Observation :** `onDragEnd` lit `questions` par closure. `onDragEnter` met à jour `questions` via `setQuestions` fonctionnel, mais la closure de `onDragEnd` peut capturer l'état précédant la dernière réorganisation. L'ordre envoyé à `reorderQuestions` peut alors être stale si plusieurs `onDragEnter` se déclenchent rapidement avant `onDragEnd`.

**Quand ça pourrait devenir un problème :** drag très rapide avec plusieurs survols successifs. Le rollback `await load()` en cas d'erreur rattraperait visuellement.

**À ne pas corriger maintenant.** Si ce bug se manifeste, utiliser un ref partagé (ex. `orderedRef.current = questions` mis à jour dans `setQuestions`) pour que `onDragEnd` lise toujours le dernier ordre.

---

### Drag HTML5 natif non supporté par touch iOS Safari

**Fichier :** [QuestionManager.jsx](apps/borne/web/src/components/admin/QuestionManager.jsx)

**Observation :** les événements `dragstart`/`dragenter` HTML5 ne se déclenchent pas sur iOS Safari (touch). Si l'admin opère depuis l'iPad, le drag-reorder sera inopérant — il faudra réordonner depuis un desktop ou implémenter un fallback touch (`touchstart`/`touchmove`/`touchend`).

**À ne pas corriger maintenant.** Le spec dit « HTML5 natif » et l'admin peut utiliser un autre appareil. À documenter si un opérateur remonte ce problème.

---

## Phase 1d.3 — PreflightPanel

### Deux `useEffect` sur `cameraStream` pourraient être fusionnés

**Fichier :** [PreflightPanel.jsx:53-57](apps/borne/web/src/components/admin/PreflightPanel.jsx#L53)

**Observation :** cleanup (arrêt tracks) et branchement `srcObject` sont dans deux effets séparés dépendant de `cameraStream`. Fusionnable, mais la séparation actuelle est lisible et correcte — aucune fuite.

**À ne pas corriger maintenant.**

---

## Phase 1d.2 — EventPanel

### Erreur de chargement remplace tout le panneau

**Fichier :** [EventPanel.jsx:104](apps/borne/web/src/components/admin/EventPanel.jsx#L104)

**Observation :** sur erreur transitoire de `listEvents`, le rendu d'erreur remplace l'intégralité du panneau — l'opérateur perd l'accès au formulaire de création. Une bannière d'erreur non-bloquante (contenu conservé) serait mieux.

**À ne pas corriger maintenant.** Rare en pratique (même réseau que le backend).

---

### Modale de clôture : pas de fermeture à l'overlay ni Échap

**Fichier :** [EventPanel.jsx:189](apps/borne/web/src/components/admin/EventPanel.jsx#L189)

**Observation :** mineur pour une borne tactile.

**À ne pas corriger maintenant.**

---

## Phase 1d.1 — AdminLogin + AdminLayout

### Simplification possible de `intervalRef` dans `AdminLayout`

**Fichier :** [AdminLayout.jsx:40-41](apps/borne/web/src/components/admin/AdminLayout.jsx#L40)

**Observation :** l'intervalle de polling disque est stocké dans `intervalRef` mais `fetchDisk` est
mémoïsé (`useCallback` deps vides), donc l'effet ne se re-déclenche pas — correct. On pourrait
simplifier en supprimant `intervalRef` au profit d'une variable locale capturée par le cleanup,
sans changement de comportement.

**À ne pas corriger maintenant.** L'état actuel est correct et plus explicite pour la lisibilité.

---

### `guestVideoUrl` sans cache-buster sur la `<video>` en état `ANSWERED`

**Fichier :** [RecordingScreen.jsx:135](apps/borne/web/src/components/guest/RecordingScreen.jsx#L135)

**Observation :** l'URL `guestVideoUrl(sessionId, question.id)` est stable (pas de
query param aléatoire). Si un invité refait une réponse pour la même question
(`question_id` identique), l'URL reste la même — le navigateur pourrait servir
l'ancienne vidéo depuis son cache HTTP.

**Pourquoi ce n'est pas un problème aujourd'hui :** le `key={sessionId-qN}` sur
`RecordingScreen` force un remount à chaque navigation, ce qui recrée l'élément `<video>`
et déclenche un nouveau chargement réseau.

**Quand ça pourrait devenir un problème :** si on retire le remount par `key`, ou si on
ajoute un composant persistent de lecture vidéo sans remount.

**À ne pas corriger maintenant.** Si ce bug se manifeste, ajouter un cache-buster à
`guestVideoUrl` (ex. `?t=<uploaded_at>` récupéré depuis les `answers`).

---

## Audit — correctif §6 (activate refusé pendant un push)

### 409 non discriminé entre « event pushed/purged » et « push en cours »

**Fichier :** [events.js:62](apps/borne/server/src/routes/events.js#L62)

**Observation :** le garde « push en cours » renvoie le même code 409 que le contrôle
`pushed/purged` juste au-dessus. Conforme à §6, mais le front ne peut distinguer les deux
causes que par parsing du message d'erreur.

**À ne pas corriger maintenant.** Si l'UI doit un jour réagir différemment (ex. proposer
« réessayer dans quelques secondes » seulement pour le push en cours), ajouter un champ
`code` discriminant dans le body de la réponse (ex. `{ error, code: 'push_in_progress' }`).

---

## Phase S — S4 : sanitizeCsv dupliquée entre Borne et Hub

**Fichiers :** [videos.js:227](apps/borne/server/src/routes/videos.js#L227), [gallery.js:54](apps/hub/server/src/routes/gallery.js#L54)

**Observation :** la fonction `sanitizeCsv` (regex `/^[=+\-@\t\r]/` + préfixe apostrophe) est définie à l'identique dans les deux apps. PROJET.md §4 ne prévoit pas de util CSV partagé entre les deux workspaces ; la duplication est donc conforme à l'arborescence contractuelle.

**À ne pas factoriser maintenant.** Si un troisième endroit l'utilise, envisager d'ajouter un helper dans `@kapsule/core`.

---

## Phase S — S3 : err?.name vs err.name dans le handler MulterError

**Fichier :** [index.js:41](apps/hub/server/src/index.js#L41)

**Observation :** `err.name === 'MulterError'` suppose `err` non-nul/objet. Un rejet non-objet ferait planter le handler avant le fallback. En pratique Express n'invoque ce handler qu'avec une vraie erreur, donc risque théorique ; `err?.name` serait marginalement plus robuste.

**À ne pas corriger maintenant.** Express garantit que `err` est l'argument passé à `next(err)`, toujours un objet dans les routes actuelles.

---

## Phase S — S1 : regex UUID v4 stricte vs permissive

**Fichier :** [validateParams.js:9](apps/hub/server/src/middleware/validateParams.js#L9)

**Observation :** SECURITY.md (H1) proposait une regex permissive `/^[0-9a-f-]{36}$/`.
L'implémentation retenue est plus stricte : UUID v4 complet (impose version `4` et
variant `8/9/a/b`). C'est volontaire et meilleur (rejette davantage), puisque `events.id`
et `videos.id` viennent toujours de `uuidv4()` en production.

**À ne pas corriger maintenant.** Écart assumé vs le correctif proposé. Si un jour un
identifiant non-v4 devait légitimement transiter par ces routes (très improbable), il
faudrait assouplir la regex — mais ce serait un changement de contrat à réévaluer.

---

## Phase 6D — Aperçu distant (revue kapsule-reviewer)

### Garde `isPreviewMode` positionnelle dans la route plutôt que dans `pushEvent`

**Fichier :** `apps/borne/server/src/routes/sync.js:48`, `apps/borne/server/src/sync/push.js`

**Observation :** L'invariant §11.21 (push interdit en mode démo) est gardé uniquement dans
la route `POST /api/sync/push/:eventId`, pas dans la fonction `pushEvent()` elle-même.
Acceptable car `pushEvent` n'a qu'un seul appelant (la route) et `autoPull.js` ne déclenche
jamais de push. Un futur appelant direct contournerait la protection.

**À ne pas corriger maintenant.** Si un push automatique est ajouté plus tard (phase 7),
déplacer la garde dans `pushEvent` ou vérifier `is_preview` en tête de cette fonction.

### Chevauchement visuel `.guest-preview-banner` / bouton Accueil

**Fichier :** `apps/borne/web/src/styles/app.css`, `apps/borne/web/src/pages/GuestPage.jsx`

**Observation :** Le bandeau `position: fixed; top: 0` peut masquer visuellement le bouton 🏠
sur petit écran iPad. `pointer-events: none` préserve la fonctionnalité mais pas la lisibilité.

**À ne pas corriger maintenant.** Vérification visuelle 🧑 à faire sur iPad réel. Si masquage
confirmé, décaler le bouton 🏠 vers `top: 1.8rem` lorsque `isPreview` est actif.

### `dirSize()` synchrone sur l'event loop

**Fichier :** `apps/borne/server/src/routes/videos.js:15`

**Observation :** `dirSize()` utilise `readdirSync`/`statSync` — bloque l'event loop sur un
gros dossier. Acceptable pour une borne d'essai (quota 1 Go, faible volume).

**À ne pas corriger maintenant.** Si la borne de production adopte aussi un quota, migrer
vers une approche incrémentale (compteur mis à jour à chaque upload/suppression).

---

## Phase 8C — Smoke tests / extraction pure logique hub-web

### `roles.js` dupliqué borne/hub (scalaire vs tableau)

**Fichiers :** `apps/borne/web/src/api/roles.js`, `apps/hub/web/src/api/roles.js`

**Observation :** Les deux modules ont la même API (`getRole(token)`) mais une sémantique
différente — la borne encode `roles: ['admin_borne']` (tableau), le Hub encode `role: 'superuser'`
(scalaire). La duplication est défendable aujourd'hui. Un module partagé `@kapsule/core-web`
(isomorphique, zéro dépendance native) permettrait de factoriser à terme, si d'autres utilitaires
frontend partagés émergent.

**À ne pas corriger maintenant.**
