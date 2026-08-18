import { randomBytes } from 'node:crypto';
import { getSetting, setSetting } from './registry.js';
import { config } from './config.js';

/**
 * Résout l'identité persistante de la borne physique (Phase B), après
 * openRegistry() et avant tout appel Hub. Au premier démarrage, sème
 * borne_settings depuis les variables d'env (BORNE_TOKEN, HUB_URL) ; aux
 * démarrages suivants, la base fait foi — permet de faire tourner le token
 * (POST /api/sync/token, à étendre à borne_token) sans éditer le .env.
 *
 * No-op pour une borne d'essai (jamais de BORNE_TOKEN, donc jamais de valeur
 * à seeder) et tant qu'aucun BORNE_TOKEN n'est configuré (avant appairage).
 */
export function resolveBorneIdentity() {
  const persistedToken = getSetting('borne_token');
  if (persistedToken) {
    config.borneToken = persistedToken;
  } else if (config.borneToken) {
    setSetting('borne_token', config.borneToken);
  }

  if (!config.borneToken) return; // pas une borne physique : hub_url n'a rien à seeder ici

  const persistedHubUrl = getSetting('hub_url');
  if (persistedHubUrl) {
    config.hubUrl = persistedHubUrl;
  } else if (config.hubUrl) {
    setSetting('hub_url', config.hubUrl);
  }
}

// Valeurs connues publiquement (défaut historique de config.js + valeur
// d'exemple des deux gabarits .env.example-*) — jamais utilisable telle
// quelle en sortie de resolveJwtSecret().
const WEAK_JWT_SECRETS = new Set(['', 'change-me']);

/**
 * Résout JWT_SECRET (Phase C, first-boot sans .env), après openRegistry() et
 * avant validateConfig()/tout jwt.sign(). Même principe que
 * resolveBorneIdentity() (seed .env → persistance borne_settings), MAIS avec
 * la priorité INVERSÉE par rapport à celle-ci et SANS la garde sur
 * borneToken : un secret de signature est nécessaire dès le premier
 * démarrage, avant même tout appairage (écran d'onboarding).
 *
 * Une valeur d'env EXPLICITE et non faible prime TOUJOURS sur la valeur
 * persistée (et la remplace) — pas l'inverse. Deux raisons : (1) une rotation
 * volontaire de JWT_SECRET doit avoir un effet, pas rester sans suite après
 * le premier démarrage ; (2) une borne preview reçoit le JWT_SECRET **du
 * Hub** (`provisioner.js`, secret partagé assumé), et une rotation côté Hub
 * doit se propager au prochain redémarrage du conteneur preview — sinon les
 * JWT `general` signés par le Hub pour cette preview cessent de vérifier
 * silencieusement, sans qu'aucune rotation ne l'explique.
 *
 * Si la valeur d'env est absente ou correspond à une valeur d'exemple connue,
 * on retombe sur la valeur déjà persistée, puis seulement sur une génération
 * aléatoire — l'opérateur n'a alors jamais besoin de la choisir lui-même.
 * Jamais affichée (contrairement à l'ancien TECH_PASSWORD, retiré — plus
 * aucun secret humain à révéler ici, cf. routes/sync.js
 * `POST /sync/onboarding/pair` qui ouvre une session directement à partir du
 * token borne validé par le Hub).
 */
export function resolveJwtSecret() {
  const envIsWeak = WEAK_JWT_SECRETS.has(config.jwtSecret);
  if (!envIsWeak) {
    setSetting('jwt_secret', config.jwtSecret);
    return { jwtGenerated: false };
  }
  const persistedJwt = getSetting('jwt_secret');
  if (persistedJwt) {
    config.jwtSecret = persistedJwt;
    return { jwtGenerated: false };
  }
  const value = randomBytes(32).toString('hex');
  config.jwtSecret = value;
  setSetting('jwt_secret', value);
  return { jwtGenerated: true };
}
