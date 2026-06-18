import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { hasAdminRole, hasTechRole, getTokenEmail, decodeJwtPayload } from '../src/api/roles.js';

// Fabrique un JWT minimal sans signature (header.payload.fakesig)
function makeToken(payload) {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body   = btoa(JSON.stringify(payload));
  return `${header}.${body}.fakesig`;
}

describe('decodeJwtPayload', () => {
  test('décode un payload valide', () => {
    const t = makeToken({ email: 'a@b.com', roles: ['admin_borne'] });
    const p = decodeJwtPayload(t);
    assert.equal(p.email, 'a@b.com');
  });

  test('retourne null sur token malformé', () => {
    assert.equal(decodeJwtPayload('pas.un.jwt.valide'), null);
    assert.equal(decodeJwtPayload(''), null);
    assert.equal(decodeJwtPayload(null), null);
  });
});

describe('hasAdminRole', () => {
  test('admin_borne → true', () => {
    assert.ok(hasAdminRole(makeToken({ roles: ['admin_borne'] })));
  });

  test('tech_borne → true (sur-ensemble)', () => {
    assert.ok(hasAdminRole(makeToken({ roles: ['tech_borne'] })));
  });

  test('admin_borne + tech_borne → true', () => {
    assert.ok(hasAdminRole(makeToken({ roles: ['admin_borne', 'tech_borne', 'general'] })));
  });

  test('general seul → false', () => {
    assert.ok(!hasAdminRole(makeToken({ roles: ['general'] })));
  });

  test('tableau vide → false', () => {
    assert.ok(!hasAdminRole(makeToken({ roles: [] })));
  });

  test('pas de champ roles → false', () => {
    assert.ok(!hasAdminRole(makeToken({ email: 'x@y.com' })));
  });

  test('token null → false', () => {
    assert.ok(!hasAdminRole(null));
  });
});

describe('hasTechRole', () => {
  test('tech_borne → true', () => {
    assert.ok(hasTechRole(makeToken({ roles: ['tech_borne'] })));
  });

  test('admin_borne seul → false (pas de droits tech)', () => {
    assert.ok(!hasTechRole(makeToken({ roles: ['admin_borne'] })));
  });

  test('general seul → false', () => {
    assert.ok(!hasTechRole(makeToken({ roles: ['general'] })));
  });

  test('admin_borne + tech_borne + general → true', () => {
    assert.ok(hasTechRole(makeToken({ roles: ['admin_borne', 'tech_borne', 'general'] })));
  });

  test('token null → false', () => {
    assert.ok(!hasTechRole(null));
  });
});

describe('getTokenEmail', () => {
  test('extrait l\'email', () => {
    assert.equal(getTokenEmail(makeToken({ email: 'test@test.com', roles: [] })), 'test@test.com');
  });

  test('retourne null si pas d\'email', () => {
    assert.equal(getTokenEmail(makeToken({ roles: ['admin_borne'] })), null);
  });

  test('retourne null sur token invalide', () => {
    assert.equal(getTokenEmail(null), null);
  });
});
