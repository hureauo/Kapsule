---
description: Lance le reviewer Kapsule sur le diff courant (à faire avant chaque commit de sous-lot)
---

Lance l'agent `kapsule-reviewer` (tool Agent, subagent_type: kapsule-reviewer) sur les changements non commités du dépôt$ARGUMENTS.

À son retour : restitue le rapport tel quel (VERDICT + findings ❌/⚠️/💡/🧑 avec fichier:ligne et l'invariant concerné). Si le verdict est « COMMIT À CORRIGER », propose de corriger les findings ❌ — sans rien modifier avant validation.
