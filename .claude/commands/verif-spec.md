---
description: Lance le reviewer Kapsule sur le diff courant (à faire avant chaque commit de sous-lot)
---

Lance l'agent `kapsule-reviewer` (tool Agent, subagent_type: kapsule-reviewer) sur les changements non commités du dépôt$ARGUMENTS.

À son retour :
1. Restitue le rapport tel quel.
2. Si le verdict est `COMMIT À CORRIGER`, lis la section `## Corrections demandées` de `.claude/review-pending.md` et propose à l'utilisateur d'implémenter les corrections (une par une, dans l'ordre, en cochant chaque item une fois fait). N'implémente rien sans son feu vert explicite.
3. Propose des pistes d'amélioration du projet (les 💡 du rapport).
