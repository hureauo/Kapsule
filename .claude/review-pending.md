---
status: tests-pending
base_commit: e9d9db468b49d8eb1bfc950655354fb9f6d3bffb
workspaces: [@kapsule/hub-server]
generated_at: 2026-06-23T00:00:00Z
verdict: COMMIT OK
---

# Relais de review → tests

Workspaces à tester :
- @kapsule/hub-server (raison : nouveau module email/, mailer injecté dans createApp, endpoint POST /users/:id/send-registration, table email_logs + migration #9, refactor buildRegistrationUrl dans admin.js/events.js)

> Note : `apps/hub/web/` (AdminPage.jsx, client.js) est touché mais le projet n'a pas de suite de tests web — non listé comme workspace testable.

Points d'attention pour les tests (findings du reviewer à confirmer par les tests) :
- Migration #9 idempotente sur DB existante (schema_migrations v8 → v9) ET sur DB neuve (le bloc CREATE TABLE initial crée déjà email_logs, puis la migration la (re)crée via IF NOT EXISTS) — pas de double-création ni d'erreur.
- send-registration via null mailer : doit donner `email_sent:false` + log `skipped` (et non `sent`). Le test actuel couvre `sent` (mock ok) et `failed` (throw), mais PAS explicitement le chemin `skipped` du null mailer — un test supplémentaire serait utile.
- Confirmer qu'aucun chemin de test n'instancie `createMailer` (transport SMTP réel) : seul le null mailer (défaut createApp) ou un mock injecté est utilisé.
- email_logs ne contient que des emails de COMPTES (user.email), jamais d'invité (RGPD §11.13 / §5.3).

## Corrections demandées

Aucune correction requise.

> Findings non bloquants (⚠️ doc §13 périmée + 💡 rate-limit sur send-registration) documentés dans le rapport du reviewer — laissés à l'appréciation de l'agent principal, ne bloquent pas le commit.
