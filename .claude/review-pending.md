---
status: tests-pending
base_commit: 741ab72d66058aa3558236174fb4e10745b69eb9
workspaces: [@kapsule/hub-server]
generated_at: 2026-06-23T00:00:00Z
verdict: COMMIT OK
---

# Relais de review → tests

Workspaces à tester :
- @kapsule/hub-server (raison : routes/auth.js + registry.js modifiés — nouvelle route POST /forgot-password, helper getLatestRegistrationToken)

Note : apps/hub/web/ touché (LoginPage.jsx, client.js) mais sans suite de tests web — vérification visuelle/manuelle uniquement.

Points d'attention pour les tests (findings du reviewer à confirmer par les tests) :
- Anti-énumération par TIMING (💡) : la branche « compte réel + actif » fait un envoi SMTP synchrone (await sendPasswordReset) alors que les branches inconnu/inactif/<5min répondent quasi-instantanément. Le corps + statut HTTP sont strictement identiques (vérifié), mais la latence du premier envoi pour un compte existant constitue un oracle de timing en production réelle. Non bloquant ; le mock de test ne révèle pas la latence d'un vrai SMTP.
- Token reset (1h) réutilise registration_tokens + /set-password sans distinction de type : un token issu de forgot-password doit poser un nouveau password et rester usage-unique. La suite actuelle ne couvre PAS le chemin de bout en bout forgot → set-password — à confirmer.
- Garde 5 min : created_at SQLite (résolution seconde, UTC) normalisé en ISO via replace(' '->'T')+'Z'. Le test « renvoi <5min refusé » couvre le cas nominal ; pas de test du cas inverse « token >5min → nouvel envoi autorisé ».

## Corrections demandées

Aucune correction requise.
