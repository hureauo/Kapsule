# Thèmes commutables depuis l'admin

## 1. Objectif

Le Cutealism ne **remplace pas** le thème sombre : il devient un thème **sélectionnable**.
L'admin choisit, dans le panneau d'administration de la borne, le design appliqué au
parcours invité. Le thème sombre actuel reste une option.

Thèmes prévus au départ :

- `cute` — Cutealism (nouveau, **défaut validé**) ;
- `dark` — le sombre noir/rouge actuel (conservé).

L'architecture laisse la porte ouverte à d'autres thèmes plus tard (un seul bloc de
tokens à ajouter).

## 2. Principe technique : un attribut + des blocs de tokens

Tout le thème invité passe déjà par des **variables CSS** (`--bg`, `--accent`…). On
exploite ça : chaque thème est un bloc de variables sélectionné par un attribut sur la
racine.

```css
/* défaut */
:root, [data-theme="cute"] { /* tokens Cutealism */ }
[data-theme="dark"]        { /* tokens sombres actuels */ }
```

En JS, on pose l'attribut sur `<html>` :

```js
document.documentElement.setAttribute('data-theme', theme); // 'cute' | 'dark'
```

**Pourquoi cette approche (le *pourquoi*)** : aucune logique conditionnelle dans les
composants, aucun re-render React lié au thème. Le navigateur recalcule juste les
variables. C'est le pattern standard de theming CSS, le plus simple à maintenir et le
moins coûteux à l'exécution — important sur un Raspberry/iPad.

> L'admin (thème clair) garde ses propres variables scopées sur `.admin-login` /
> `.admin-layout` : **il n'est pas affecté** par `data-theme`, conforme à la décision
> « l'admin garde son thème actuel ».

## 3. Où stocker le choix ? (et RGPD)

Le choix de thème est une **configuration d'événement**, pas une donnée invité. Il se
range donc dans la table clé/valeur `event_meta` de la base de l'événement
(`events/<id>/db.sqlite`), à côté de `idle_timeout`, `consent_text`, etc.

```
event_meta:  key='theme'  value='cute'
```

✅ **Conforme à l'invariant RGPD** (PROJET.md §11) : aucune donnée invité dans
`registry.sqlite`, et le thème n'est pas une donnée invité de toute façon. Il vit dans
`events/<id>/`, comme le reste de la config.

> Alternative écartée : stocker le thème dans le `localStorage` de la borne. Rejeté car
> le thème doit suivre l'événement (et donc le push/pull vers le Hub), pas l'appareil.

## 4. Flux proposé

1. **Backend** : exposer `theme` dans la réponse de `GET /event` (lu depuis
   `event_meta`, défaut `'cute'`). Ajouter sa mise à jour dans la route de config
   d'événement existante (PATCH/PUT). Test supertest : lecture défaut + écriture/relecture.
2. **Admin (web)** : dans `EventPanel`, un sélecteur « Thème de la borne » (Cutealism /
   Sombre) qui appelle l'API et persiste. Cible tactile ≥ 44 px.
3. **Invité (web)** : `GuestPage` lit `event.theme` au chargement et fait
   `document.documentElement.setAttribute('data-theme', event.theme)`. Défaut `cute` si
   absent.

## 5. Découpage en sous-lots (quand on codera)

Pour rester fidèle à la règle « un endpoint n'est terminé que testé » :

- **D1** — CSS : introduire `[data-theme]`, déplacer les tokens sombres sous
  `[data-theme="dark"]`, ajouter le bloc `cute`. (pas de test — pur style)
- **D2** — Refonte visuelle des écrans invités en Cutealism + barre de progression
  basse (cf. `parcours-invite.md`). (pas de test — pur style/markup)
- **D3** — Backend : `theme` dans `event_meta` + `GET /event` + écriture. (**tests
  supertest** : défaut + écriture/relecture + valeur invalide rejetée)
- **D4** — Admin : sélecteur de thème dans `EventPanel`.
- **D5** — Invité : application de `data-theme` au chargement.

> Ce découpage sera reporté dans `ROADMAP.md` (nouvelle phase) au moment de coder, pas
> avant — pour ne pas polluer la roadmap d'une feature non validée.
