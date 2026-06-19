import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { getRole, decodeJwtPayload } from '../src/api/roles.js';

// Fabrique un JWT minimal sans signature (header.payload.fakesig)
function makeToken(payload) {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body   = btoa(JSON.stringify(payload));
  return `${header}.${body}.fakesig`;
}

describe('decodeJwtPayload', () => {
  test('décode un payload valide', () => {
    const p = decodeJwtPayload(makeToken({ sub: 'u1', role: 'superuser' }));
    assert.equal(p.role, 'superuser');
    assert.equal(p.sub, 'u1');
  });

  test('retourne null sur token malformé', () => {
    assert.equal(decodeJwtPayload('pas-un-jwt'), null);
    assert.equal(decodeJwtPayload(''), null);
    assert.equal(decodeJwtPayload(null), null);
  });
});

describe('getRole', () => {
  test('extrait superuser', () => {
    assert.equal(getRole(makeToken({ role: 'superuser' })), 'superuser');
  });

  test('extrait client', () => {
    assert.equal(getRole(makeToken({ role: 'client' })), 'client');
  });

  test('retourne null si pas de rôle', () => {
    assert.equal(getRole(makeToken({ sub: 'u1' })), null);
  });

  test('retourne null sur token null/invalide', () => {
    assert.equal(getRole(null), null);
    assert.equal(getRole('xxx'), null);
  });
});
