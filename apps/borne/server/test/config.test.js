import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, resolveTrustProxyHops } from '../src/config.js';

const SAFE = { jwtSecret: 'une-vraie-cle', previewMode: false };
const WEAK_JWT = { jwtSecret: 'change-me', previewMode: false };
const EMPTY_JWT = { jwtSecret: '', previewMode: false };

describe('validateConfig (borne) — production', () => {
  test('JWT_SECRET change-me → erreur', () => {
    assert.throws(() => validateConfig(WEAK_JWT, 'production'), /JWT_SECRET/);
  });

  test('JWT_SECRET vide → erreur', () => {
    assert.throws(() => validateConfig(EMPTY_JWT, 'production'), /JWT_SECRET/);
  });

  test('secrets valides → OK', () => {
    assert.doesNotThrow(() => validateConfig(SAFE, 'production'));
  });
});

describe('validateConfig (borne) — preview mode', () => {
  test('JWT_SECRET change-me en preview → erreur', () => {
    assert.throws(
      () => validateConfig({ ...WEAK_JWT, previewMode: true }, 'development'),
      /JWT_SECRET/
    );
  });

  test('secrets valides en preview → OK', () => {
    assert.doesNotThrow(() => validateConfig({ ...SAFE, previewMode: true }, 'development'));
  });
});

describe('validateConfig (borne) — dev/test', () => {
  test('JWT_SECRET change-me → warning seulement (pas d erreur)', () => {
    assert.doesNotThrow(() => validateConfig(WEAK_JWT, 'test'));
  });
});

// Régression : docker-compose.borne.yml câble TRUST_PROXY_HOPS=${TRUST_PROXY_HOPS:-},
// donc la variable existe TOUJOURS dans le conteneur — vide si l'opérateur ne l'a
// pas définie (repli documenté dans .env.example-rasp). Avant fix, `??` laissait
// passer cette chaîne vide jusqu'à parseInt('') = NaN, désactivant `trust proxy`.
describe('resolveTrustProxyHops', () => {
  test('TRUST_PROXY_HOPS vide (déploiement réel non configuré) → repli 1 hors preview', () => {
    assert.equal(resolveTrustProxyHops({ TRUST_PROXY_HOPS: '' }), 1);
  });

  test('TRUST_PROXY_HOPS vide + PREVIEW_MODE=true → repli 2', () => {
    assert.equal(resolveTrustProxyHops({ TRUST_PROXY_HOPS: '', PREVIEW_MODE: 'true' }), 2);
  });

  test('TRUST_PROXY_HOPS absent (clé non déclarée) → repli 1', () => {
    assert.equal(resolveTrustProxyHops({}), 1);
  });

  test('TRUST_PROXY_HOPS explicite → valeur respectée (override)', () => {
    assert.equal(resolveTrustProxyHops({ TRUST_PROXY_HOPS: '3' }), 3);
  });

  test('TRUST_PROXY_HOPS invalide (non numérique) → repli plutôt que NaN', () => {
    assert.equal(resolveTrustProxyHops({ TRUST_PROXY_HOPS: 'abc' }), 1);
  });
});
