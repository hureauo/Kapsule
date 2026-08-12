import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openRegistry, closeRegistry, getSetting, setSetting } from '../src/registry.js';
import { config } from '../src/config.js';
import { resolveBorneIdentity } from '../src/borneIdentity.js';

describe('resolveBorneIdentity', () => {
  let dir;
  const origBorneToken = config.borneToken;
  const origHubUrl = config.hubUrl;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'borne-identity-'));
    openRegistry(dir);
  });

  afterEach(() => {
    closeRegistry();
    rmSync(dir, { recursive: true, force: true });
    config.borneToken = origBorneToken;
    config.hubUrl = origHubUrl;
  });

  it('no-op si ni env ni base ne portent de borne_token (preview / autonome)', () => {
    config.borneToken = '';
    config.hubUrl = 'https://hub.test';
    resolveBorneIdentity();
    assert.equal(config.borneToken, '');
    assert.equal(getSetting('hub_url'), null, "hub_url ne doit rien seeder sans identité borne");
  });

  it('sème borne_settings depuis BORNE_TOKEN/HUB_URL au premier démarrage', () => {
    config.borneToken = 'env-token-abc';
    config.hubUrl = 'https://hub.test';
    resolveBorneIdentity();
    assert.equal(getSetting('borne_token'), 'env-token-abc');
    assert.equal(getSetting('hub_url'), 'https://hub.test');
    assert.equal(config.borneToken, 'env-token-abc');
  });

  it('une valeur déjà persistée prime sur l\'env (rotation sans redéploiement)', () => {
    setSetting('borne_token', 'token-persiste');
    setSetting('hub_url', 'https://hub-persisté.test');
    config.borneToken = 'env-token-different';
    config.hubUrl = 'https://hub-env.test';

    resolveBorneIdentity();

    assert.equal(config.borneToken, 'token-persiste');
    assert.equal(config.hubUrl, 'https://hub-persisté.test');
  });

  it('un borne_token déjà persisté mais sans hub_url persisté sème hub_url depuis l\'env', () => {
    setSetting('borne_token', 'token-persiste');
    config.borneToken = 'env-token-ignoré'; // écrasé par la valeur persistée
    config.hubUrl = 'https://hub-env.test';

    resolveBorneIdentity();

    assert.equal(config.borneToken, 'token-persiste');
    assert.equal(config.hubUrl, 'https://hub-env.test');
    assert.equal(getSetting('hub_url'), 'https://hub-env.test');
  });

  it('est idempotent (deux appels successifs ne changent rien)', () => {
    config.borneToken = 'env-token-abc';
    config.hubUrl = 'https://hub.test';
    resolveBorneIdentity();
    resolveBorneIdentity();
    assert.equal(config.borneToken, 'env-token-abc');
    assert.equal(config.hubUrl, 'https://hub.test');
  });
});
