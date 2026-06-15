# Parcours invité — ergonomie

> ⚠️ **Statut** : les sections 1–6 décrivent la **refonte v1** (barre de progression
> basse), déjà implémentée. La **revue v2** (sections 7+) la fait évoluer : suppression
> des flèches, caméra live pendant le REC, bouton Accueil, textes éditables, etc.
> En cas de contradiction, **la v2 fait foi** (notamment : plus de flèches ◀ ▶).

## 1. Le problème actuel

Aujourd'hui, l'écran d'enregistrement empile **deux** indicateurs de progression, **en
haut** :

- la `QuestionNav` (flèches ◀ ▶ + pastilles) — barre supérieure ;
- le `renderHeader()` de `RecordingScreen` : « Question 1 sur 4 » + barre de remplissage.

Conséquences :
- la progression mange le haut de l'écran, là où l'œil cherche d'abord **la question**
  et **la caméra** ;
- deux composants disent la même chose (redondance) ;
- sur iPad tenu à deux mains, le bas du cadre est la zone la plus **accessible au pouce**
  — c'est là qu'on veut la navigation, pas en haut.

## 2. Ce que tu veux

> « Je veux le déroulé des questions (Question 1 sur 4) en bas. »

On déplace **toute la progression en bas**, dans une seule barre persistante, et on
libère le haut pour la question + la caméra.

## 3. Disposition proposée (écran d'enregistrement)

```
┌─────────────────────────────────────────┐
│                                         │  ← haut dégagé
│        « Quel est ton meilleur          │     la QUESTION respire
│          souvenir de la soirée ? »      │
│                                         │
│     ┌───────────────────────────┐       │
│     │                           │       │
│     │      [ caméra live ]      │       │     zone centrale = action
│     │                           │       │
│     └───────────────────────────┘       │
│                                         │
│           (  ●  Commencer  )            │  ← bouton pillow orange
│                                         │
├─────────────────────────────────────────┤
│  ◀     ●━━━○──○──○     Question 1 / 4  ▶ │  ← BARRE BASSE unique
└─────────────────────────────────────────┘
     zone pouce, navigation + déroulé
```

La **barre basse** fusionne ce qui était éclaté :

- flèches ◀ ▶ (aller question précédente / suivante) ;
- les **pastilles** d'état (• répondue / ○ vide / halo = courante) ;
- le texte **« Question 1 / 4 »** ;
- une fine **barre de remplissage** intégrée derrière les pastilles (progression
  globale), au lieu de la barre séparée du header.

> Le header haut (`renderHeader`) disparaît de l'écran d'enregistrement. Sa barre de
> progression est absorbée par la barre basse. Un seul endroit dit où on en est.

## 4. Implications composants

| Composant            | Changement |
|----------------------|-----------|
| `QuestionNav`        | descend en **bas** ; on y ajoute le label « Question X / N » et la barre de remplissage. C'est le composant unique de progression. |
| `RecordingScreen`    | on **retire** `renderHeader()` ; la question remonte en haut, la caméra prend la hauteur libérée. |
| `questions-layout`   | passe en `flex-direction: column` avec la nav en `order` final (`margin-top:auto`) pour la coller en bas. |
| `RecapScreen`        | inchangé sur le fond ; restylé Cutealism (cartes pastel, pastilles cohérentes avec la nav). |

## 5. Cohérence sur les autres écrans

- **Countdown / Recording / Preview / Uploading** : ces sous-états centrés gardent la
  question en haut. La barre basse reste visible et **figée** pendant l'enregistrement
  (pas d'interaction — on ne change pas de question en plein REC), mais elle situe
  l'invité dans le parcours. Les flèches sont désactivées visuellement pendant le REC.
- **Recap** : la barre basse cède la place au bouton « J'ai terminé ✓ », puisqu'on est
  sorti du flux question-par-question.

## 6. Accessibilité conservée

- pastilles ≥ 44 px de cible tactile (invariant iPad), même si le point visible est plus
  petit ;
- `aria-current="step"` sur la question courante (déjà présent) ;
- contraste du texte « Question X / N » vérifié sur fond crème (token `--text-muted`).

---

# Revue v2 (à implémenter)

Issue d'une relecture du parcours. Décisions actées avec l'utilisateur. Rien n'est
codé tant que cette section n'est pas validée.

## 7. Vue d'ensemble des 6 changements

| # | Changement | Écran(s) concerné(s) |
|---|------------|----------------------|
| 1 | Bouton **Accueil** (retour début) avec confirmation « tout sera perdu » | tous sauf REC/upload |
| 2 | **Modale d'inactivité** réduite au seul écran « nom », et qui **retourne à l'accueil** | NameInput |
| 3 | Bouton **« En savoir plus »** sur le consentement → popup détaillée | NameInput / consentement |
| 4 | **Tous les textes éditables** depuis l'admin | accueil, nom, consentement, en savoir plus, merci |
| 5 | **Plus de flèches ni de bouton Retour** ; navigation par pastilles + récap | barre basse, RecordingScreen |
| 6 | **Caméra live pendant le REC** (question gardée au-dessus) | RecordingScreen (RECORDING) |

## 8. Point 1 — Bouton Accueil

- **Emplacement** : icône maison 🏠 discrète, **coin haut**, présente sur tous les écrans
  du parcours **sauf pendant l'enregistrement actif** (sous-états COUNTDOWN, RECORDING,
  UPLOADING) — on ne coupe jamais une captation en cours.
- **Comportement** : ouvre une **confirmation** avant d'agir :

  ```
  ┌──────────────────────────────────┐
  │   Revenir à l'accueil ?          │
  │   Tes réponses seront perdues.   │
  │                                  │
  │   [ Annuler ]   [ Tout effacer ] │
  └──────────────────────────────────┘
  ```

- À la confirmation : `clearSavedSession()` + retour `START` (réutilise `handleRestart`).
- **Pourquoi la confirmation** : le bouton est destructif (perte de la session en cours).
  On l'assume explicitement plutôt que de risquer un abandon accidentel.

## 9. Point 2 — Modale d'inactivité repensée

État actuel : `IDLE_SCREENS = {RESUME, START, NAME, RECAP, THANKS}` → la modale « Tu es
toujours là ? » peut surgir sur 5 écrans. C'est inutile sur la plupart (accueil, récap,
merci sont des écrans d'attente légitimes).

**v2** :
- La surveillance d'inactivité ne s'applique plus qu'à **l'écran « Comment vous
  appelez-vous ? » (NAME)**. C'est le seul écran où un invité peut « bloquer » la borne
  (champ ouvert, clavier affiché, personne devant).
- Après le délai : **plus de modale intermédiaire** — **retour direct à l'accueil**
  (`handleRestart`). Sur NAME il n'y a rien à perdre (pas encore de réponses), donc pas
  besoin de demander « tu continues ? ».
- Conséquence code : `IDLE_SCREENS` se réduit à `{NAME}` ; le timeout déclenche
  directement `handleRestart` au lieu d'afficher `IdleModal`. Le composant `IdleModal`
  peut être supprimé.

> Invariant conservé : l'inactivité n'est **jamais** active pendant les questions
> (REC/upload ne doivent pas être interrompus). C'était déjà le cas.

## 10. Point 3 — « En savoir plus » sur le consentement

- Sous le texte de consentement court, un bouton **« En savoir plus »** (style ghost).
- Ouvre une **popup** (modale) avec un texte détaillé sur l'usage de la vidéo
  (conservation, destinataire, durée, droits…). Texte **éditable en admin** (point 4).
- La popup est purement informative : un seul bouton « Fermer ». Elle ne bloque pas le
  consentement (la case reste sur l'écran principal).

```
  Consentement (écran NAME)
  ┌────────────────────────────────────────┐
  │  [texte court de consentement…]        │
  │  ( En savoir plus )   ← ouvre la popup  │
  │  ☐ J'accepte                            │
  └────────────────────────────────────────┘
```

## 11. Point 4 — Textes éditables en admin

Tous les textes du parcours deviennent des entrées `event_meta` (clé/valeur), comme
`consent_text` déjà existant. **Conforme RGPD** : ce sont des configs d'événement, pas
des données invité → restent dans `events/<id>/db.sqlite`, jamais dans `registry.sqlite`.

Clés proposées (avec valeurs par défaut dans `DEFAULTS` du core) :

| Clé `event_meta`        | Écran        | Défaut |
|-------------------------|--------------|--------|
| `welcome_title`         | accueil      | nom de l'événement |
| `welcome_subtitle`      | accueil      | 1ʳᵉ ligne du consentement (actuel) |
| `name_prompt`           | nom          | « Comment vous appelez-vous ? » |
| `consent_text`          | consentement | (déjà existant) |
| `consent_details`       | en savoir plus | nouveau texte long |
| `thanks_text`           | merci        | « Votre témoignage a bien été enregistré. » |

- **Backend** : ces clés s'ajoutent à `GET /event` (lecture) et à la route de réglages
  admin (écriture). On étend `PUT /events/:id/settings` (déjà créée pour le thème) pour
  accepter ces champs texte — une seule route « settings » générique.
- **Admin** : un panneau **« Textes »** (nouvel onglet ou section d'`EventPanel`) avec un
  `<textarea>` par champ. Chaque champ est testé (écriture + relecture) côté backend.
- **Validation** : longueur max raisonnable par champ (éviter un payload abusif),
  trim, fallback au défaut si vide.

## 12. Point 5 — Navigation par questions repensée

**Suppressions** :
- ❌ les **flèches ◀ ▶** de la barre basse ;
- ❌ le bouton **« ← Retour »** de l'écran d'enregistrement (sous-état INTRO).

**Conservé** : pastilles d'état + « Question X / N » + barre de remplissage.

**Comment on navigue alors** :
1. **Linéaire par défaut** : on enregistre une réponse → on passe automatiquement à la
   question suivante (déjà le cas via `onNext`). Plus de retour en arrière manuel pendant
   le flux.
2. **Par les pastilles** : cliquer une pastille de la barre basse saute à cette question
   (déjà câblé via `onGo`). **Désactivé pendant REC/upload** (locked).
3. **Depuis le récap final** : la liste permet de revenir sur n'importe quelle question
   pour la (re)faire.

**Retour à l'état d'origine après ré-enregistrement** :
- Si on arrive sur une question **depuis le récap** pour refaire une vidéo, alors une
  fois la nouvelle vidéo enregistrée + uploadée, on **revient au récap** (et pas à la
  question suivante).
- Si on arrive sur une question **dans le flux normal**, après enregistrement on passe à
  la **suivante** (comportement actuel).
- Implémentation : mémoriser l'**origine** d'entrée dans la question (`'flow'` vs
  `'recap'`). `RecapScreen.onGo` marque l'origine `'recap'` ; à la fin de l'upload,
  `RecordingScreen.onNext` consulte l'origine pour décider : récap ou question suivante.

```
  Barre basse v2 (plus de flèches) :
  ┌─────────────────────────────────────────┐
  │      ●━━━○──○──○        Question 2 / 4    │
  └─────────────────────────────────────────┘
        pastilles cliquables   +   label
```

## 13. Point 6 — Caméra live pendant l'enregistrement

État actuel : le preview caméra n'est attaché qu'en sous-état **INTRO**. Pendant
**RECORDING**, l'invité ne se voit plus (juste le minuteur + barre + Stop).

**v2** : afficher la **caméra en direct pendant le REC**, avec la **question gardée
au-dessus** (caméra légèrement plus petite pour laisser la place au texte).

```
  RECORDING (v2)
  ┌─────────────────────────────────────────┐
  │   « Quel est ton meilleur souvenir ? »   │  ← question gardée
  │   ● REC  00:12                           │  ← indicateur rouge
  │   ┌───────────────────────────┐          │
  │   │     [ caméra live ]        │          │  ← l'invité se voit
  │   └───────────────────────────┘          │
  │   ▓▓▓▓▓▓▓░░░░░░  (barre durée)            │
  │            ( ■ Stop )                     │
  ├─────────────────────────────────────────┤
  │      ●━━━○──○──○        Question 1 / 4    │
  └─────────────────────────────────────────┘
```

- Implémentation : garder le `<video>` de preview **monté et attaché au flux**
  (`recorder.attachPreview`) aussi en sous-état RECORDING, pas seulement INTRO. Le flux
  `getUserMedia` est déjà actif pendant le REC (c'est lui qu'on enregistre) — il suffit
  de réafficher l'élément vidéo miroir.
- **Safari** : `playsInline` + `muted` obligatoires sur ce `<video>` (invariant §11.5) —
  déjà la règle pour le preview d'intro, à conserver.

## 14. Impacts code (récapitulatif v2)

| Fichier | Changement |
|---------|-----------|
| `QuestionNav.jsx` | retirer les flèches ◀ ▶ ; ne garder que pastilles + label + remplissage |
| `RecordingScreen.jsx` | retirer le bouton « ← Retour » ; caméra live en RECORDING ; logique origine flow/recap pour `onNext` |
| `GuestPage.jsx` | bouton Accueil + confirmation ; `IDLE_SCREENS = {NAME}` + timeout → `handleRestart` direct ; mémoriser l'origine d'entrée question ; supprimer `IdleModal` |
| `NameInput.jsx` | bouton « En savoir plus » + popup ; libellés depuis `event` (name_prompt, consent_text, consent_details) |
| `StartScreen.jsx` | titre/sous-titre depuis `event` (welcome_title, welcome_subtitle) |
| `ThankYouScreen.jsx` | texte depuis `event` (thanks_text) |
| `events.js` (server) | nouvelles clés `event_meta` en lecture (`GET /event`) + écriture (`PUT /settings`) |
| `constants.js` (core) | défauts des nouveaux textes dans `DEFAULTS` |
| `EventPanel.jsx` / nouveau panneau | section/onglet « Textes » (textarea par champ) |
| `app.css` | styles bouton Accueil, popup « en savoir plus », layout RECORDING avec caméra |

## 15. Découpage en sous-lots (proposé)

Pour respecter « un endpoint n'est terminé que testé » et committer par incréments :

- **V2.1** — Backend : nouvelles clés texte dans `event_meta` (`GET /event` + `PUT
  /settings` étendu) + **tests supertest** (écriture/relecture/validation de chaque champ).
- **V2.2** — Admin : panneau « Textes » (textarea par champ).
- **V2.3** — Invité : brancher les écrans (Start/Name/Thanks) sur les textes de `event`.
- **V2.4** — Point 3 : « En savoir plus » + popup (consomme `consent_details`).
- **V2.5** — Point 5 : retirer flèches + bouton Retour ; logique origine flow/recap.
- **V2.6** — Point 6 : caméra live pendant le REC.
- **V2.7** — Point 1 : bouton Accueil + confirmation.
- **V2.8** — Point 2 : recentrer l'inactivité sur NAME → retour accueil ; retirer `IdleModal`.

Chaque sous-lot passe par `kapsule-reviewer` avant commit.

## 16. Points à valider / questions ouvertes

- **Onglet vs section** pour les textes en admin : nouvel onglet « Textes » (plus propre
  si beaucoup de champs) ou section dans `EventPanel` ? → à trancher en V2.2.
- **Longueur max** des champs texte (consent_details surtout) : fixer une limite.
- **Bouton Accueil pendant PREVIEW** (vidéo enregistrée pas encore uploadée) : autorisé
  (avec confirmation) ou bloqué comme pendant le REC ? Proposition : **autorisé avec
  confirmation** (rien n'est encore parti au serveur, donc « perdu » est exact).
