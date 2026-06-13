# Notes techniques — observations en attente

Ce fichier recense des observations issues des revues de code (agent `kapsule-reviewer`)
qui ne sont **pas des bugs actifs** et **ne doivent pas être appliquées pour l'instant**.
Elles servent de référence pour le débogage futur si un comportement inattendu apparaît.

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
