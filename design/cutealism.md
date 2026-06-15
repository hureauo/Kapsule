# Thème Cutealism

## 1. C'est quoi le Cutealism ?

Le **Cutealism** (mot-valise *cute* + *realism/brutalism*) est une tendance qui marie
des détails **mignons, inspirés du kawaii** avec une base **fonctionnelle et lisible**.
On garde la rigueur d'une interface utilitaire, mais on la réchauffe.

Caractéristiques récurrentes (synthèse de la recherche) :

- **Formes douces** : coins très arrondis, boutons « pillow / marshmallow », cartes qui
  flottent. Rien d'anguleux.
- **Textures tactiles** : effet *clay* (pâte à modeler), ombres douces et internes,
  légers dégradés qui donnent du volume sans réalisme photographique.
- **Typo *chunky*** : grasse, ronde, généreuse. La lisibilité passe avant la finesse.
- **Couleur** : fond **neutre et clair** (pas blanc pur, pas noir) + **blocs de couleur
  pastel/saturée** posés dessus. La couleur ponctue, elle n'envahit pas.
- **Émotion visée** : chaleur, jeu, mise en confiance — l'opposé de la froideur d'une
  borne technique. C'est exactement ce qu'on veut pour un invité qui doit oser parler
  face caméra.

**Pourquoi c'est pertinent ici** : la borne demande à un inconnu, dans un événement,
de s'enregistrer en vidéo. C'est intimidant. Un thème noir/rouge évoque l'alerte et le
« REC » anxiogène. Le Cutealism désamorce ça : il rend l'acte ludique et bienveillant.

## 2. Ta palette

```
#0388A6   bleu canard profond     (primaire)
#63D8F2   cyan clair lumineux      (primaire clair / accent doux)
#F2AC29   jaune doré               (accent chaud)
#F28705   orange                   (accent chaud)
#F27405   orange profond           (action / chaud appuyé)
```

### Lecture de la palette (théorie des couleurs)

Cette palette est un **split-complémentaire** quasi parfait, et c'est ce qui la rend
agréable et solide :

- Un **pôle froid bleu** (`#0388A6` → `#63D8F2`) : le bleu inspire le calme et la
  confiance. Idéal comme **couleur structurante** (fonds de zones, navigation, états
  neutres). Le calme est exactement ce qu'on veut autour d'un acte intimidant.
- Un **pôle chaud orange/jaune** (`#F2AC29` → `#F27405`) : énergie, chaleur, appel à
  l'action. Le bleu et l'orange sont **complémentaires** → contraste fort et lisible
  sans être agressif comme le rouge.

**Règle de mariage retenue — le 60 / 30 / 10 :**

- **60 % neutre** : un fond crème/blanc cassé (voir tokens). Le Cutealism *exige* un
  fond neutre clair ; poser les 5 couleurs vives partout fatiguerait l'œil.
- **30 % bleu** : `#0388A6` et `#63D8F2` portent la structure (barres, cartes,
  navigation des questions, éléments d'info).
- **10 % orange** : `#F27405` / `#F28705` réservés à **l'action principale** (bouton
  « Commencer », « Enregistrer »). La rareté de l'orange est ce qui le rend efficace :
  l'œil va droit à ce qu'il faut toucher.

> **Exception assumée — le rouge du REC est conservé.** Pendant l'enregistrement, le
> point « live » et le minuteur restent **rouges** (`#E63946`), même en thème Cutealism.
> Le rouge est le signal d'enregistrement universellement compris ; on ne sacrifie pas
> cette convention à l'esthétique. C'est le seul rouge de tout le thème, et il
> n'apparaît que pendant le REC — donc il ne casse pas l'ambiance générale.

### Rôles proposés (sémantique, pas juste « jolies couleurs »)

| Rôle                         | Couleur            | Justification |
|------------------------------|--------------------|---------------|
| Fond global                  | crème `#FFF8EE`    | neutre chaud, base Cutealism |
| Surface (cartes, barres)     | blanc `#FFFFFF`    | flotte au-dessus du crème |
| Texte principal              | encre `#0B3B45`    | bleu très foncé, pas noir pur → plus doux, contraste AA |
| Texte secondaire             | `#5B7B82`          | bleu-gris désaturé |
| Primaire / structure         | `#0388A6`          | navigation, accents froids |
| Primaire clair / surbrillance| `#63D8F2`          | états « répondu », halos doux |
| **Action principale**        | `#F27405`          | un seul bouton chaud par écran |
| Action — survol/pressé       | `#F28705`          | variation plus claire au toucher |
| Accent doux / récompense     | `#F2AC29`          | étoiles, validations, médailles |
| Enregistrement « live »      | rouge `#E63946` + pulse | **conservé** : le rouge est le signal d'enregistrement universellement compris |

> ⚠️ **Important sur le `REC`** : on **abandonne le rouge** `#e63946`. Le point
> d'enregistrement et le minuteur passent en orange `#F27405` avec une pulsation douce.
> Symboliquement on garde « ça tourne » sans le code couleur d'alerte/danger.

## 3. Principes visuels appliqués

1. **Rayons généreux** : `--radius` de 16 px (cartes) à 28 px (boutons « pillow »).
2. **Ombres douces colorées** : pas de noir transparent dur, mais une ombre teintée
   bleu très diluée → l'objet « pose » sur le fond sans trou noir.
3. **Boutons pillow** : padding vertical large, rayon fort, micro-déplacement vers le
   bas au `:active` (effet « on appuie sur un coussin »).
4. **Typo chunky** : titres en `font-weight: 800`, taille généreuse, `letter-spacing`
   légèrement négatif pour l'effet rond et compact.
5. **Mascotte / emoji discret** : un petit visage 🫧/🎬 sur l'accueil et le merci pour
   l'âme kawaii, sans charger les écrans d'action.
6. **Mouvement doux** : transitions 0.15–0.2 s, un léger « squish » au toucher. Jamais
   d'animation pendant l'enregistrement (on ne distrait pas l'invité).

## 4. Tokens CSS proposés

Ces variables remplaceront le bloc de thème invité dans `app.css`. Elles sont nommées
pour cohabiter avec le mécanisme de thème commutable (voir `themes-commutables.md`) :
le sombre actuel devient `[data-theme="dark"]`, le Cutealism `[data-theme="cute"]`.

```css
[data-theme="cute"] {
  /* Fonds & surfaces */
  --bg:               #FFF8EE;  /* crème neutre chaud */
  --surface:          #FFFFFF;  /* cartes, barres */
  --surface-alt:      #FDEFD9;  /* zone secondaire douce */

  /* Texte */
  --text:             #0B3B45;  /* encre bleu nuit (pas noir) */
  --text-muted:       #5B7B82;  /* bleu-gris */
  --text-error:       #C0532B;  /* terracotta — erreur sans rouge agressif */

  /* Structure froide */
  --primary:          #0388A6;
  --primary-soft:     #63D8F2;
  --primary-tint:     #E3F7FC;  /* halo très clair (états répondu) */

  /* Action chaude */
  --accent:           #F27405;
  --accent-hover:     #F28705;
  --accent-soft:      #F2AC29;
  --accent-tint:      #FDE9CF;

  /* Enregistrement — rouge conservé (convention universelle), valable tous thèmes */
  --rec:              #E63946;

  /* Champs */
  --input-bg:         #FFFFFF;
  --input-border:     #F2D2A6;
  --input-border-focus:#0388A6;

  /* Boutons secondaires */
  --btn-secondary-bg:    #E3F7FC;
  --btn-secondary-hover: #C8EEF7;

  /* Forme & profondeur */
  --radius:           16px;
  --radius-pill:      28px;
  --shadow-soft:      0 6px 18px rgba(3,136,166,0.15);
  --shadow-press:     0 2px 6px  rgba(3,136,166,0.20);
}
```

> Note : le code actuel utilise tantôt `--accent`, tantôt `--primary`/`--error`/
> `--success` (incohérence existante dans `app.css`). La refonte unifiera ces noms.

## 5. Avant / après (résumé)

| Élément        | Avant (sombre)            | Après (Cutealism)                    |
|----------------|---------------------------|--------------------------------------|
| Fond           | `#111` quasi noir         | crème `#FFF8EE`                      |
| Action         | rouge `#e63946`           | orange `#F27405`, bouton pillow      |
| REC            | point rouge clignotant    | point rouge conservé (`--rec`), pulsation douce |
| Cartes         | gris `#1e1e1e`, coins 12px | blanc, coins 16px, ombre bleutée     |
| Titres         | 600/700                   | 800, plus ronds                      |
| Ressenti       | technique, « alerte »     | chaleureux, ludique, rassurant       |
