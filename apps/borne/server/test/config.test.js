import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../src/config.js';

const SAFE_CFG = { jwtSecret: 'une-vraie-cle-longue' };
const WEAK_CFG = { jwtSecret: 'change-me' };

describe('validateConfig (borne)', () => {
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
});
