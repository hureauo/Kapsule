# Suivi revue v2 du parcours invité — reprise après redémarrage

> Point de reprise au 15/06/2026. La spec complète des 6 points est dans
> [parcours-invite.md](parcours-invite.md) **sections 7 à 16** (source de vérité).
> Ce fichier ne sert qu'à savoir **où on en est** et **quoi faire ensuite**.

## Contexte

- Branche de travail : **`feat/themes-parcours-invite`** (les thèmes cute/dark/modern
  sont déjà committés dessus : `db32702` feature + `5f0a0e2` doc).
- Mode de travail validé : **option A** = enchaîner les 8 sous-lots, tester + committer
  chacun, passer `kapsule-reviewer` avant chaque commit.
- Décision actée sur un point ouvert : **bouton Accueil autorisé (avec confirmation) en
  PREVIEW** (vidéo pas encore uploadée → « perdu » est exact).

## Les 8 sous-lots

- [x] **V2.1 — Backend textes** : `GET /event` + `PUT /settings` + 35 tests passants.
- [x] **V2.2 — Admin** : section « Textes du parcours » dans `EventPanel` (textarea par champ,
      sauvegarde via `updateEventSettings`, rollback optimiste).
- [x] **V2.3 — Invité** : `StartScreen` (welcome_title/subtitle), `NameInput` (name_prompt),
      `ThankYouScreen` (thanksText prop → event.thanks_text).
- [x] **V2.4 — Point 3** : bouton « En savoir plus » + popup modale dans `NameInput`
      (consomme `consent_details`, réutilise `.modal-overlay/.modal`).
- [x] **V2.5 — Point 5** : flèches ◀▶ retirées de `QuestionNav` ; bouton « ← Retour »
      retiré de `RecordingScreen` ; logique origine flow/recap dans `GuestPage`.
- [x] **V2.6 — Point 6** : caméra live en RECORDING (`videoPreviewRef` partagé INTRO+REC,
      effet `attachPreview` étendu, `<video>` ajouté dans la branche RECORDING).
- [x] **V2.7 — Point 1** : bouton Accueil 🏠 (fixed coin haut, masqué pendant navLocked)
      + modal confirmation « Tout effacer » → `handleRestart`.
- [x] **V2.8 — Point 2** : `IDLE_SCREENS = {NAME}` ; idle timer → `handleRestart` direct
      (via ref stable) ; `IdleModal` + `IDLE_MODAL_S` + `idleModalVisible` supprimés.

## Rappels de méthode (CLAUDE.md)

- Tout via Docker (aucune dépendance locale).
- Un endpoint n'est terminé que **testé** (nominal + ≥ 1 cas d'erreur).
- RGPD : ces textes sont des **configs d'événement** → `event_meta` de
  `events/<id>/db.sqlite`, **jamais** `registry.sqlite`. ✅
- Lancer `kapsule-reviewer` avant chaque commit de sous-lot ; sauver ses 💡 dans NOTES.md.
- Vérifs humaines (🧑) : rendu iPad Safari, caméra live réelle — ne jamais cocher comme
  testé ici.

## Pour reprendre

Au redémarrage : relire ce fichier + `parcours-invite.md` §7–16, puis **finir V2.1
étapes 3→6**, et enchaîner V2.2 … V2.8.
