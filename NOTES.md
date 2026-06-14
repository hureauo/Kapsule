# Notes techniques — observations en attente

Ce fichier recense des observations issues des revues de code (agent `kapsule-reviewer`)
qui ne sont **pas des bugs actifs** et **ne doivent pas être appliquées pour l'instant**.
Elles servent de référence pour le débogage futur si un comportement inattendu apparaît.

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
