# Design Kapsule — dossier de réflexion

Ce dossier rassemble la réflexion design **avant** de toucher au code. Une fois une
direction validée, son contenu sert de base à la page de doc correspondante (`docs/`).

## Contenu

- [`cutealism.md`](cutealism.md) — la charte du thème **Cutealism** : ce qu'est ce
  style, la palette, les principes appliqués, les tokens CSS proposés.
- [`parcours-invite.md`](parcours-invite.md) — refonte de l'ergonomie du parcours
  invité, en particulier le déroulé des questions placé **en bas** de l'écran.
- [`themes-commutables.md`](themes-commutables.md) — architecture proposée pour rendre
  le design **sélectionnable depuis le panneau admin** (Cutealism ⇄ thème sombre actuel).

## État

🟢 **Validé et implémenté** (15/06/2026). La direction décrite ici est appliquée au code :
thème Cutealism par défaut, barre de progression basse, sélecteur de thème dans l'admin,
thème stocké dans `event_meta` et appliqué via `data-theme` sur `<html>`. Le thème sombre
reste sélectionnable. Tests backend verts (`apps/borne/server/test/events.test.js`).

## Décisions prises (15/06/2026)

1. Refonte de **tout le parcours invité** ; l'admin garde son thème clair actuel.
2. Design conçu d'abord ici → validation → puis code + ajout à la doc.
3. Le Cutealism ne **remplace pas** le thème sombre : il devient un thème **sélectionnable**
   depuis le panneau admin. Le sombre actuel reste disponible.
4. **Cutealism = thème par défaut** des nouveaux événements.
5. **Le rouge du REC est conservé** dans tous les thèmes (signal d'enregistrement
   universel) — seule couleur rouge du thème Cutealism, visible uniquement pendant le REC.
