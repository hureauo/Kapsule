import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../src/config.js';

const SAFE = { jwtSecret: 'une-vraie-cle', techPassword: 'mdp-fort', previewMode: false };
const WEAK_JWT = { jwtSecret: 'change-me', techPassword: 'mdp-fort', previewMode: false };
const EMPTY_JWT = { jwtSecret: '', techPassword: 'mdp-fort', previewMode: false };
const WEAK_TECH = { jwtSecret: 'une-vraie-cle', techPassword: 'tech123', previewMode: false };
// change-me : valeur d'exemple des deux gabarits .env.example-hub/-rasp (Phase C)
const WEAK_TECH_CHANGEME = { jwtSecret: 'une-vraie-cle', techPassword: 'change-me', previewMode: false };

describe('validateConfig (borne) — production', () => {
  test('JWT_SECRET change-me → erreur', () => {
    assert.throws(() => validateConfig(WEAK_JWT, 'production'), /JWT_SECRET/);
  });

  test('JWT_SECRET vide → erreur', () => {
    assert.throws(() => validateConfig(EMPTY_JWT, 'production'), /JWT_SECRET/);
  });

  test('TECH_PASSWORD tech123 → erreur', () => {
    assert.throws(() => validateConfig(WEAK_TECH, 'production'), /TECH_PASSWORD/);
  });

  test('TECH_PASSWORD change-me → erreur', () => {
    assert.throws(() => validateConfig(WEAK_TECH_CHANGEME, 'production'), /TECH_PASSWORD/);
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

  test('TECH_PASSWORD tech123 en preview → erreur', () => {
    assert.throws(
      () => validateConfig({ ...WEAK_TECH, previewMode: true }, 'development'),
      /TECH_PASSWORD/
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

  test('TECH_PASSWORD tech123 → OK (pas de restriction en dev)', () => {
    assert.doesNotThrow(() => validateConfig(WEAK_TECH, 'development'));
  });
});
