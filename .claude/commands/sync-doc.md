---
description: Lance kapsule-doc-sync pour synchroniser docs/ avec le diff courant (manuel, à la demande)
---

Lance l'agent `kapsule-doc-sync` (tool Agent, subagent_type: kapsule-doc-sync) sur les changements non commités du dépôt$ARGUMENTS.

À son retour : restitue le compte rendu tel quel (pages mises à jour / ajoutées / supprimées, invariants impactés, vérifs). L'agent n'écrit que sous `docs/` ; il ne touche ni au code ni à l'état git. Aucun commit n'est fait — propose-le seulement après avoir restitué le rapport.
