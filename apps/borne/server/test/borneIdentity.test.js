import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openRegistry, closeRegistry, getSetting, setSetting } from '../src/registry.js';
import { config } from '../src/config.js';
import { resolveBorneIdentity, resolveJwtSecret } from '../src/borneIdentity.js';

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

  it('no-op si ni env ni base ne portent de borne_token (preview / pas encore appairée)', () => {
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

describe('resolveJwtSecret', () => {
  let dir;
  const origJwtSecret = config.jwtSecret;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'borne-secrets-'));
    openRegistry(dir);
  });

  afterEach(() => {
    closeRegistry();
    rmSync(dir, { recursive: true, force: true });
    config.jwtSecret = origJwtSecret;
  });

  it('génère JWT_SECRET quand absent/valeur d\'exemple', () => {
    config.jwtSecret = 'change-me';

    const { jwtGenerated } = resolveJwtSecret();

    assert.equal(jwtGenerated, true);
    assert.notEqual(config.jwtSecret, 'change-me');
    assert.ok(config.jwtSecret.length >= 32);
    assert.equal(getSetting('jwt_secret'), config.jwtSecret);
  });

  it('adopte une valeur d\'env forte telle quelle (pas de génération)', () => {
    config.jwtSecret = 'une-vraie-cle-forte';

    const { jwtGenerated } = resolveJwtSecret();

    assert.equal(jwtGenerated, false);
    assert.equal(config.jwtSecret, 'une-vraie-cle-forte');
    assert.equal(getSetting('jwt_secret'), 'une-vraie-cle-forte');
  });

  it('une valeur déjà persistée prime sur l\'env (survit à un redémarrage sans .env édité)', () => {
    setSetting('jwt_secret', 'secret-persiste');
    config.jwtSecret = 'change-me';

    resolveJwtSecret();

    assert.equal(config.jwtSecret, 'secret-persiste');
  });

  // Régression : avant le fix, une valeur déjà persistée primait TOUJOURS sur
  // l'env, y compris une valeur d'env explicite et forte — une rotation
  // volontaire de JWT_SECRET (ou la propagation d'un secret Hub tourné vers
  // les previews, cf. provisioner.js) n'avait alors plus aucun effet après le
  // premier démarrage.
  it('une valeur d\'env forte prime sur une valeur déjà persistée différente (rotation volontaire)', () => {
    setSetting('jwt_secret', 'ancien-secret-persiste');
    config.jwtSecret = 'nouveau-secret-fort-depuis-env';

    const { jwtGenerated } = resolveJwtSecret();

    assert.equal(jwtGenerated, false);
    assert.equal(config.jwtSecret, 'nouveau-secret-fort-depuis-env');
    assert.equal(getSetting('jwt_secret'), 'nouveau-secret-fort-depuis-env');
  });

  it('est idempotent : un second appel ne régénère rien', () => {
    config.jwtSecret = 'change-me';
    resolveJwtSecret();
    const firstJwt = config.jwtSecret;

    const second = resolveJwtSecret();

    assert.equal(config.jwtSecret, firstJwt);
    assert.equal(second.jwtGenerated, false);
  });
});
