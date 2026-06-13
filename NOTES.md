# Notes techniques — observations en attente

Ce fichier recense des observations issues des revues de code (agent `kapsule-reviewer`)
qui ne sont **pas des bugs actifs** et **ne doivent pas être appliquées pour l'instant**.
Elles servent de référence pour le débogage futur si un comportement inattendu apparaît.

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
