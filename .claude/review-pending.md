---
status: tests-pending
base_commit: 2a1af81dd68d9d041f6e1494691f05e981f58846
workspaces: []
generated_at: 2026-07-14T00:00:00Z
verdict: COMMIT À CORRIGER
---

# Relais de review → tests

Workspaces à tester :
- (aucun) — le diff ne touche que PROJET.md (documentation contractuelle §9bis), aucun fichier testable.

Points d'attention pour les tests (findings du reviewer à confirmer par les tests) :
- Aucun test ne couvre ce diff (doc seule). Le finding ❌ est purement documentaire : la
  section §9bis décrit `captureSnapshot`/`readSnapshot` comme « restreint à `META_KEYS` »,
  ce que le code (`apps/hub/server/src/versioning.js`) contredit — `readSnapshot` lit TOUT
  `event_meta` sans filtre. À traiter par correction de la doc, pas par un test.

## Corrections demandées

> Cette section est lue par l'agent principal pour implémenter les corrections.
> Chaque item est coché par l'agent principal une fois corrigé.

- [ ] ❌ `PROJET.md:679-682` — Corriger le paragraphe « Conséquence pour `captureSnapshot` ».
  Le code réel (`versioning.js` `readSnapshot`) fait `SELECT key, value FROM event_meta`
  sans aucune restriction à `META_KEYS` et sans boucle `META_KEYS` : `event_meta.design`
  sera capturé automatiquement dès qu'il existera, aucune adaptation n'est requise. Reformuler
  pour refléter que le snapshot lit déjà tout `event_meta` (donc `design` est tracé sans
  changement), ou supprimer la « conséquence » erronée.
