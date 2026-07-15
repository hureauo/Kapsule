---
status: tests-pending
base_commit: 63bdd261cdcd289ff63fe064b8fde5706b19edd4
workspaces: []
generated_at: 2026-07-15T00:00:00Z
verdict: COMMIT OK
---

# Relais de review → tests

Workspaces à tester : aucun.

Le sous-lot design2.A est purement documentaire (PROJET.md §5.3 / §9bis / §11.26 + ROADMAP.md,
plus le plan non tracké `.claude/plans/design-v2-lien-vivant.md`). Aucun fichier source, aucun test,
aucune infra Docker/nginx touchés. Rien à exécuter pour kapsule-tester.

Points d'attention pour les tests (à confirmer lors de design2.B, quand le code arrivera) :
- Vérifier que `event_meta.design_source_id` (nouvelle clé `event_meta`) n'est PAS transmis à la
  borne par le bundle de pull ni traité par la borne : `design_source_id` est une notion Hub-only
  (retrouver les previews à rafraîchir), la borne n'en a aucun usage.
- Vérifier que la restauration de version (`restoreEventDesign`) et `captureSnapshot`/`readSnapshot`
  se comportent correctement vis-à-vis de `design_source_id` : `readSnapshot` fait
  `SELECT key,value FROM event_meta` sans filtre, donc la clé sera capturée dans `event_versions`.
- Vérifier la cascade : suppression d'un événement vide bien `event_design_refs` ; suppression d'un
  design détache (retire les refs) sans casser la copie figée des événements.

## Corrections demandées

> Cette section est lue par l'agent principal pour implémenter les corrections.
> Chaque item est coché par l'agent principal une fois corrigé.

- [ ] ⚠️ `PROJET.md:723-724` — la « Limite assumée » de `restoreEventDesign` affirme « le snapshot
  ne conserve pas le `design_id` source ». Or `design2` introduit `event_meta.design_source_id`, et
  `readSnapshot` capture tout `event_meta` sans filtre : le snapshot conservera désormais l'id
  source. Ajuster cette phrase (ou préciser explicitement que `design_source_id` est exclu du
  snapshot / non ré-appliqué à la restauration) pour lever la contradiction avant design2.B.
- [ ] ⚠️ `PROJET.md:693-697` / §5.3 — la spec ne dit pas si `event_meta.design_source_id` doit être
  exclu du bundle Hub→Borne. Comme `event_meta.design` circule par le bundle, préciser noir sur
  blanc que `design_source_id` reste Hub-only (non transmis à la borne) pour que design2.B tranche
  sans ambiguïté et éviter une fuite de notion registre côté borne.
