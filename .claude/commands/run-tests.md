---
description: Lance kapsule-tester pour exécuter les tests ciblés par la dernière review (à faire sur la machine de dev, après pull du code reviewé)
---

Lance l'agent `kapsule-tester` (tool Agent, subagent_type: kapsule-tester).

L'agent lit le relais `.claude/review-pending.md` écrit par `kapsule-reviewer`, vérifie sa cohérence (commit + statut), lance les tests des workspaces concernés via Docker, puis met à jour le statut du relais (`tests-passed` / `tests-failed`).

À son retour : restitue le compte rendu tel quel (verdict, workspaces testés, échecs éventuels avec le message d'assertion exact). L'agent ne corrige jamais le code ; si des tests échouent, propose-moi de corriger les findings — mais ne corrige rien sans mon feu vert.
