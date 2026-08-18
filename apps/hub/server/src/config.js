const env = process.env;

export const config = {
  port: parseInt(env.PORT ?? '3001', 10),
  jwtSecret: env.JWT_SECRET ?? 'change-me',
  dataDir: env.DATA_DIR ?? '/app/data',
  allowRegister: env.ALLOW_REGISTER === 'true',
  adminEmail: env.ADMIN_EMAIL ?? '',
  adminPassword: env.ADMIN_PASSWORD_HUB ?? '',

  // SMTP — envoi des emails (lien de définition de mot de passe, notifications).
  // Si smtpHost est vide, aucun transport réel n'est créé (createNullMailer) :
  // les liens restent affichés/copiables côté admin, l'envoi est juste désactivé.
  smtpHost: env.SMTP_HOST ?? '',
  smtpPort: parseInt(env.SMTP_PORT ?? '587', 10),
  smtpSecure: env.SMTP_SECURE === 'true', // true = TLS implicite (port 465), false = STARTTLS (587)
  smtpUser: env.SMTP_USER ?? '',
  smtpPassword: env.SMTP_PASSWORD ?? '',
  smtpFrom: env.SMTP_FROM ?? 'Kapsule <noreply@kapsule.local>',
};

export function validateConfig(cfg, nodeEnv) {
  // '' ET 'change-me' sont faibles — pas seulement 'change-me' : un compose qui
  // retire le défaut public (docker-compose.hub.yml, JWT_SECRET=${JWT_SECRET:-})
  // laisse passer une chaîne vide si l'opérateur ne l'a pas renseignée, qui
  // sinon traverserait cette garde sans même un warning.
  if (!cfg.jwtSecret || cfg.jwtSecret === 'change-me') {
    if (nodeEnv === 'production') {
      throw new Error('[hub] JWT_SECRET absent ou "change-me" — refus de démarrer en production. Définissez JWT_SECRET.');
    }
    console.warn('[hub] ⚠️  JWT_SECRET non configuré (absent ou valeur par défaut "change-me") — acceptable en dev/test uniquement.');
  }
  // adminPassword vide = seed automatique désactivé (voir index.js) : rien à valider.
  // Non vide + valeur d'exemple = un superuser Internet-facing serait créé avec un
  // mot de passe public (.env.example-hub) — même garde que JWT_SECRET.
  if (cfg.adminPassword === 'change-me') {
    if (nodeEnv === 'production') {
      throw new Error('[hub] ADMIN_PASSWORD_HUB est "change-me" — refus de démarrer en production. Définissez ADMIN_PASSWORD_HUB (ou laissez-le vide pour désactiver le seed automatique).');
    }
    console.warn('[hub] ⚠️  ADMIN_PASSWORD_HUB non configuré (valeur par défaut "change-me") — acceptable en dev/test uniquement.');
  }
  // SMTP non bloquant : son absence dégrade (pas d'envoi auto) mais ne doit pas
  // empêcher le Hub de démarrer — le fallback « lien copiable » couvre ce cas.
  if (!cfg.smtpHost) {
    console.warn('[hub] ⚠️  SMTP non configuré (SMTP_HOST vide) — envoi d\'emails désactivé, les liens restent copiables manuellement.');
  }
}
