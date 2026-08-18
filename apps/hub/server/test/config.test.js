import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../src/config.js';

const SAFE_CFG = { jwtSecret: 'une-vraie-cle-longue' };
const WEAK_CFG = { jwtSecret: 'change-me' };

describe('validateConfig (hub)', () => {
  test('lève une erreur en production avec le secret par défaut', () => {
    assert.throws(
      () => validateConfig(WEAK_CFG, 'production'),
      /JWT_SECRET/
    );
  });

  test('ne lève pas en test avec le secret par défaut', () => {
    assert.doesNotThrow(() => validateConfig(WEAK_CFG, 'test'));
  });

  test('ne lève pas en dev avec le secret par défaut', () => {
    assert.doesNotThrow(() => validateConfig(WEAK_CFG, 'development'));
  });

  test('ne lève pas en production avec un vrai secret', () => {
    assert.doesNotThrow(() => validateConfig(SAFE_CFG, 'production'));
  });

  // Régression : docker-compose.hub.yml a perdu son défaut public 'change-me'
  // (JWT_SECRET=${JWT_SECRET:-}) — une chaîne vide doit être traitée comme
  // faible au même titre, sinon elle traverserait cette garde sans même un
  // warning (pire que l'ancien défaut, qui au moins déclenchait le fail-fast).
  test('lève une erreur en production avec un secret vide', () => {
    assert.throws(
      () => validateConfig({ jwtSecret: '' }, 'production'),
      /JWT_SECRET/
    );
  });
});

describe('validateConfig (hub) — ADMIN_PASSWORD_HUB', () => {
  test('lève une erreur en production si adminPassword vaut "change-me"', () => {
    assert.throws(
      () => validateConfig({ ...SAFE_CFG, adminPassword: 'change-me' }, 'production'),
      /ADMIN_PASSWORD_HUB/
    );
  });

  test('ne lève pas en test avec adminPassword "change-me"', () => {
    assert.doesNotThrow(() => validateConfig({ ...SAFE_CFG, adminPassword: 'change-me' }, 'test'));
  });

  test('ne lève pas en production si adminPassword est vide (seed désactivé)', () => {
    assert.doesNotThrow(() => validateConfig({ ...SAFE_CFG, adminPassword: '' }, 'production'));
  });

  test('ne lève pas en production avec un vrai mot de passe', () => {
    assert.doesNotThrow(() => validateConfig({ ...SAFE_CFG, adminPassword: 'un-mdp-fort' }, 'production'));
  });
});
