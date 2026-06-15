# Parcours invité — ergonomie

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
