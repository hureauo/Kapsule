const env = process.env;

export const config = {
  port: parseInt(env.PORT ?? '3001', 10),
  jwtSecret: env.JWT_SECRET ?? 'change-me',
  dataDir: env.DATA_DIR ?? '/app/data',
  allowRegister: env.ALLOW_REGISTER === 'true',
  adminEmail: env.ADMIN_EMAIL ?? '',
  adminPassword: env.ADMIN_PASSWORD_HUB ?? '',
};

export function validateConfig(cfg, nodeEnv) {
  if (cfg.jwtSecret === 'change-me') {
    if (nodeEnv === 'production') {
      throw new Error('[hub] JWT_SECRET est "change-me" — refus de démarrer en production. Définissez JWT_SECRET.');
    }
    console.warn('[hub] ⚠️  JWT_SECRET non configuré (valeur par défaut "change-me") — acceptable en dev/test uniquement.');
  }
}
