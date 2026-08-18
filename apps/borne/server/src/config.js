const env = process.env;

// Extrait en fonction pure (plutôt qu'inline dans l'objet config) pour être
// testable indépendamment de process.env / du cache du module ESM — voir
// config.test.js pour le cas `TRUST_PROXY_HOPS=''` qui a régressé en NaN.
export function resolveTrustProxyHops(env) {
  const fallback = env.PREVIEW_MODE === 'true' ? 2 : 1;
  const hops = parseInt(env.TRUST_PROXY_HOPS || String(fallback), 10);
  return Number.isInteger(hops) && hops >= 0 ? hops : fallback;
}

export const config = {
  port: parseInt(env.PORT ?? '3001', 10),
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
  // Nombre de proxies inverses devant ce process, pour `app.set('trust proxy', …)`
  // (sinon req.ip vaut l'IP du dernier hop et tous les rate-limiters partagent un
  // seul seau). Borne réelle : iPad → borne-nginx → backend (1 hop). Preview :
  // Internet → edge-nginx → preview-nginx → backend (2 hops) — la valeur suit
  // previewMode par défaut, mais reste surchageable si la topologie change.
  //
  // `resolveTrustProxyHops` utilise `||`, pas `??` : docker-compose.borne.yml câble
  // TRUST_PROXY_HOPS=${TRUST_PROXY_HOPS:-} (syntaxe liste Compose) — la variable
  // existe TOUJOURS dans le conteneur, à '' si non définie par l'opérateur (repli
  // documenté dans .env.example-rasp). Avec `??` (nullish), cette chaîne vide
  // passerait telle quelle à parseInt('') = NaN, et `app.set('trust proxy', NaN)`
  // désactive silencieusement le trust proxy (pire que l'ancien `1` figé).
  trustProxyHops: resolveTrustProxyHops(env),
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
}
