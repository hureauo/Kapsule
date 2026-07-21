---
status: tests-pending
base_commit: 0b488dca8408c1af1ecd392d105a439ed46fb2da
workspaces: [@kapsule/hub-web, @kapsule/guest-ui]
generated_at: 2026-07-21T00:00:00Z
verdict: COMMIT OK
---

# Relais de review → tests

Lot designUI F+G combiné (working tree, non commité) : DesignPreview.jsx monte les
vrais écrans `@kapsule/guest-ui`, data-color-target ajoutés sur les écrans invité,
nettoyage du CSS `.dp-*` mort, fix de spécificité `.dp-pulse.dp-pulse`.

Workspaces à tester :
- @kapsule/hub-web (raison : DesignPreview.jsx réécrit, main.jsx import guest.css, app.css nettoyé)
- @kapsule/guest-ui (raison : StartScreen/NameInput/RecordingScreen/QuestionNav/ThankYouScreen modifiés — ajout data-color-target)

Points d'attention pour les tests (findings du reviewer à confirmer par les tests) :
- Non-régression borne : les `data-color-target` ajoutés sur les écrans invité doivent rester
  inertes côté kiosque (jamais lus par CSS/JS borne). Attendu : suites @kapsule/borne-web et
  @kapsule/guest-ui vertes sans changement de comportement (déjà 28/28 borne-web selon l'agent
  principal — à reconfirmer).
- hub-web : DesignPreview monte StartScreen/NameInput/RecordingScreen(showcase)/ThankYouScreen ;
  vérifier que le rendu de l'aperçu n'appelle aucun réseau (fakeCreateSession, showcase sans
  getUserMedia) et ne casse aucun test existant (29/29 hub-web annoncés).
- Aucun test ne dépend de Docker ici ; smoke non requis (aucun fichier infra touché).

## Corrections demandées

Aucune correction requise.
