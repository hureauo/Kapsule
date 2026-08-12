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
 * à seeder) et pour le mode autonome (ni BORNE_TOKEN ni token persisté).
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
