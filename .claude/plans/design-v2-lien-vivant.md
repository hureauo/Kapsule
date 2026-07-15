# Plan — Designs v2 : preview vivante, avertissement d'usage, highlight au survol, polices

> Suite du chantier `design` (A→F, commités). Quatre demandes utilisateur.
> **L'invariant §11.26 (design appliqué à un ÉVÉNEMENT = copie figée) est CONSERVÉ.**
> Le « live » ne concerne QUE la borne d'essai (conteneur preview), pas les
> événements réels. À découper en sous-lots relus/testés.

## Décisions actées (validées par l'utilisateur)

1. **Borne d'essai vivante.** Éditer un design dans la bibliothèque doit mettre à
   jour la/les **borne(s) d'essai** des événements `preview` qui utilisent ce
   design — **sans** re-cliquer « Appliquer ». Les événements eux-mêmes gardent
   leur copie figée (invariant §11.26 inchangé) ; on ne « rafraîchit » que la
   copie des événements en statut `preview` (données jetables), puis on déclenche
   `triggerPreviewPull`.
2. **Avertissement à l'édition** : si le design est appliqué à des événements, les
   lister (nom + statut) + prévenir. Pour les `preview` : « seront mis à jour ».
   Pour les autres : « gardent leur version actuelle (copie figée) ». Proposer
   « Continuer » / « Dupliquer d'abord ». Informatif, non bloquant.
3. **Survol d'une couleur** dans l'éditeur → l'aperçu (maquettes de la page Designs)
   bascule sur l'écran pertinent ET l'élément concerné pulse (outline flashy).
4. **Plus de polices** (stacks système, pas d'upload).

## Ce qui NE change pas

- **Invariant §11.26** : appliquer un design à un événement reste une COPIE
  (`event_meta.design`). Modifier le design n'affecte PAS un événement `ready`/
  `loaded`/`live`/… — uniquement les `preview`, et via un rafraîchissement
  explicite de leur copie (pas une référence vivante permanente).
- La **borne** (physique ou preview) est inchangée : elle consomme
  `event_meta.design` comme aujourd'hui.
- Pas de figeage au pull, pas de nouvelle machine à états.

## Mécanisme (léger)

À l'application d'un design à un événement (`PUT /events/:id/design`), on écrit
**en plus** `event_meta.design_source_id` = l'id du design source. C'est une simple
**trace de provenance** (« cette copie vient du design X »), pas une référence
vivante — l'invariant tient : la copie reste autonome et figée.

Pour retrouver vite « quels événements viennent du design X » sans scanner toutes
les `events/<id>/db.sqlite`, on maintient une table registre légère
`event_design_refs (event_id PRIMARY KEY, design_id)` (deux ids, zéro PII, RGPD OK,
vidée à la suppression d'événement).

Après édition d'un design (`PUT /designs/:id` + routes assets) : pour chaque
événement **en statut `preview`** dont `design_source_id = :id`, re-matérialiser sa
copie `event_meta.design` (+ fichiers) depuis le design mis à jour, puis
`triggerPreviewPull(eventId)`. Les événements non-preview sont **laissés
intacts** (invariant).

---

## Sous-lot design2.A — Spec

- PROJET.md §9bis : ajouter une sous-section « Rafraîchissement de la borne
  d'essai » décrivant `design_source_id` (trace de provenance), la table
  `event_design_refs`, et la règle « seuls les événements `preview` sont
  rafraîchis à l'édition du design ; les autres gardent leur copie figée ».
  **Ne PAS toucher §11.26** — ajouter une phrase qui confirme qu'il tient (la
  provenance n'est pas une référence vivante).
- ROADMAP.md : phase `design2`, cases A→E.

## Sous-lot design2.B — Backend : provenance + rafraîchissement preview

- Registre : table `event_design_refs (event_id PRIMARY KEY REFERENCES events(id)
  ON DELETE CASCADE, design_id TEXT)` + helpers `setEventDesignRef`,
  `deleteEventDesignRef`, `listEventsByDesignSource(db, designId)` (JOIN events
  pour name+status).
- `routes/events.js` :
  - `PUT /:eventId/design` : après matérialisation, écrire aussi
    `event_meta.design_source_id` + `setEventDesignRef`. Extraire un helper
    `materializeEventDesign(dataDir, eventId, design)` (copie config+fichiers).
  - `DELETE /:eventId/design` : retirer la clé source + `deleteEventDesignRef`.
- `routes/designs.js` : après un `PUT /:id` ou une modif d'asset réussie, appeler
  un helper `refreshPreviewEvents(db, dataDir, designId)` : liste les events
  `preview` via `listEventsByDesignSource`, re-matérialise chacun, `triggerPreviewPull`.
  - `DELETE /designs/:id` : détacher (supprimer les refs) — les copies restent.
- Tests : PUT écrit la ref ; éditer le design rafraîchit un event `preview` (meta
  re-matérialisée) mais PAS un event `ready` ; delete design détache ;
  `listEventsByDesignSource` ; suppression d'événement vide la ref (cascade).

## Sous-lot design2.C — Front : avertissement d'usage

- `api/client.js` : `designUsage(id)` → `GET /api/designs/:id/usage`
  (`[{event_id, name, status}]`). Route backend requireUser + canRead.
- `DesignEditor.jsx` : au montage, charger l'usage. Non vide → bandeau : « Utilisé
  sur N événements. Les événements en préparation (preview) seront mis à jour ; les
  autres gardent leur version. » + bouton « Dupliquer ce design ». Non bloquant.

## Sous-lot design2.D — Front : highlight au survol

- Table `COLOR_TARGET` (clé couleur → {screen, selector}) dans `DesignEditor.jsx`.
- Survol d'une ligne couleur → `onHoverColor(key)` → `DesignPreview` bascule sur
  l'écran cible + pose `data-pulse` sur l'élément → animation CSS `dp-pulse`
  (outline magenta clignotant ~1s en boucle tant que survolé). Sortie → retire le
  pulse, garde l'écran. Couplage maquette documenté par commentaire.

## Sous-lot design2.E — Plus de polices

- `packages/core/src/design.js` : étendre `DESIGN_FONTS` + `FONT_PRESETS` (stacks
  système, zéro dépendance, testées iPad/Safari) :
  - `humanist` : "'Optima', 'Segoe UI', 'Helvetica Neue', sans-serif"
  - `grotesk` : "'Helvetica Neue', Arial, sans-serif"
  - `slab` : "'Rockwell', 'Courier Bold', Georgia, serif"
  - `elegant` : "'Didot', 'Bodoni MT', Georgia, serif"
  (+ sans/serif/rounded/mono existants → ~8).
- `DesignEditor.jsx` : libellés FR dans `FONT_LABELS`.
- Test core « chaque valeur d'enum a son preset » : s'étend tout seul (vérifier vert).

## Hors périmètre (ne PAS faire)

Upload de polices. Référence vivante permanente / figeage au pull (l'invariant
§11.26 reste : événement = copie figée). Rafraîchissement des événements non-preview.
Édition de design côté borne.

## Vérification finale

- Tests core / hub-server / borne-server / hub-web verts.
- Parcours manuel : appliquer un design à un événement preview (borne d'essai
  lancée) → éditer le design → la borne d'essai reflète le changement sans
  re-cliquer « Appliquer » → un événement `ready` avec le même design ne bouge pas.
- 🧑 rendu réel borne d'essai + iPad (design.G, étendu polices + preview vivante).
