const env = process.env;

export const config = {
  port: parseInt(env.PORT ?? '3001', 10),
  techPassword: env.TECH_PASSWORD ?? 'tech123',
  jwtSecret: env.JWT_SECRET ?? 'change-me',
  dataDir: env.DATA_DIR ?? '/app/data',
  hubUrl: env.HUB_URL ?? '',
  boxToken: env.BOX_TOKEN ?? '',
  // Phase B : identité de borne physique (machine persistante, plusieurs
  // événements assignés) — distincte de BOX_TOKEN (token = événement, réservé
  // aux bornes d'essai injectées par le provisioner Hub). Seed uniquement :
  // resolveBorneIdentity() fait ensuite primer la valeur persistée en base.
  borneToken: env.BORNE_TOKEN ?? '',
  pullIntervalMs: parseInt(env.PULL_INTERVAL_MS ?? '300000', 10),
maxDataBytes: parseInt(env.MAX_DATA_BYTES || '0', 10),
  previewMode: env.PREVIEW_MODE === 'true',
};

export function validateConfig(cfg, nodeEnv) {
  const strict = nodeEnv === 'production' || cfg.previewMode === true;
  const weakSecret = !cfg.jwtSecret || cfg.jwtSecret === 'change-me';
  if (weakSecret) {
    if (strict) {
      throw new Error('[borne] JWT_SECRET absent ou "change-me" — refus de démarrer en production/preview. Définissez JWT_SECRET.');
    }
    console.warn('[borne] ⚠️  JWT_SECRET non configuré — acceptable en dev/test uniquement.');
  }
  // 'tech123' = défaut historique (config.js) ; 'change-me' = valeur d'exemple des
  // deux gabarits .env.example-* — les deux sont des mots de passe connus publiquement.
  const weakTechPassword = cfg.techPassword === 'tech123' || cfg.techPassword === 'change-me';
  if (strict && weakTechPassword) {
    throw new Error('[borne] TECH_PASSWORD est une valeur d\'exemple ("tech123"/"change-me") — refus de démarrer en production/preview. Définissez TECH_PASSWORD.');
  }
}
