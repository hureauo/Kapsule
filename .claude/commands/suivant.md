---
description: Implémente la prochaine tâche non cochée de ROADMAP.md (ou la tâche indiquée)
argument-hint: [numéro de tâche, ex. 1a.3]
---

Implémente une tâche du plan de développement Kapsule.

1. Lis ROADMAP.md. Tâche cible : `$ARGUMENTS` si fourni, sinon la **première case non cochée** dans l'ordre. Ne jamais prendre une case 🧑 (vérification humaine) — si la prochaine case est 🧑, le signaler et passer à la suivante.
2. Avant d'écrire du code, relis les sections de PROJET.md qui couvrent cette tâche (la spec est la source de vérité) ainsi que les invariants de CLAUDE.md.
3. Implémente en respectant l'arborescence §4 et la stack figée §3. Pour le backend : écris les tests supertest avec la route, et lance `npm test` jusqu'au vert.
4. Coche la case dans ROADMAP.md. Si un nouveau script npm est apparu, mets à jour la section « Commandes » de CLAUDE.md.
5. Commit avec le message `phase X.Y: <description courte>`.
6. Termine en résumant ce qui a été fait, ce qui reste dans le sous-lot, et toute vérification humaine 🧑 à prévoir.

))
