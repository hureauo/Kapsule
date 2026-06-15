---
description: Lance le reviewer Kapsule sur le diff courant, puis synchronise la doc (à faire avant chaque commit de sous-lot)
---

Déroule les deux étapes dans l'ordre.

## 1. Review

Lance l'agent `kapsule-reviewer` (tool Agent, subagent_type: kapsule-reviewer) sur les changements non commités du dépôt$ARGUMENTS.

À son retour : restitue le rapport tel quel (VERDICT + findings ❌/⚠️/💡/🧑 avec fichier:ligne et l'invariant concerné). Si le verdict est « COMMIT À CORRIGER », propose de corriger les findings ❌ — sans rien modifier avant validation.

## 2. Synchronisation de la doc

La doc ne doit refléter que le code dans son état **final** (celui qui sera commité). Donc :

- Si le verdict était « COMMIT À CORRIGER » : attends que les findings ❌ soient corrigés (et validés) avant de passer à la doc. La synchro se fait sur le diff corrigé, pas sur le diff initial.
- Si le verdict était « COMMIT OK » : enchaîne directement.

Une fois le code stabilisé, lance l'agent `kapsule-doc-sync` (tool Agent, subagent_type: kapsule-doc-sync) pour mettre à jour `docs/` d'après le diff courant. Il lit lui-même `git diff HEAD` — ne lui transmets pas de résumé du diff.

À son retour : restitue son compte rendu (pages mises à jour / ajoutées / supprimées, invariants impactés, vérifs). Les modifications de doc restent non commitées comme le reste — l'utilisateur commitera l'ensemble (code + doc) quand il le décidera.

Si l'utilisateur veut sauter l'étape doc (ex. changement purement interne sans impact documentaire), il peut le dire — ne force pas la synchro.
