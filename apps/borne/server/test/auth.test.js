import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/index.js';
import { closeRegistry } from '../src/registry.js';
import { requireAdmin } from '../src/middleware/auth.js';

const TEST_CONFIG = {
  adminPassword: 'motdepasse-test',
  jwtSecret: 'secret-test',
  dataDir: '',
};

describe('POST /api/admin/login', () => {
  let dir, app;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'borne-auth-'));
    app = createApp(dir, { ...TEST_CONFIG, dataDir: dir });
  });

  afterEach(() => {
    closeRegistry();
    rmSync(dir, { recursive: true });
  });

  test('retourne un token JWT avec le bon mot de passe', async () => {
    const res = await request(app)
      .post('/api/admin/login')
      .send({ password: 'motdepasse-test' });
    assert.equal(res.status, 200);
    assert.ok(res.body.token);
    const payload = jwt.verify(res.body.token, 'secret-test');
    assert.equal(payload.role, 'admin');
  });

  test('retourne 401 avec un mauvais mot de passe', async () => {
    const res = await request(app)
      .post('/api/admin/login')
      .send({ password: 'mauvais' });
    assert.equal(res.status, 401);
    assert.ok(res.body.error);
  });

  test('retourne 401 si le corps est vide', async () => {
    const res = await request(app)
      .post('/api/admin/login')
      .send({});
    assert.equal(res.status, 401);
  });

  test('retourne 401 pour un mot de passe de longueur différente (§S5.2/L2)', async () => {
    // timingSafeEqual lève si longueurs différentes — safeCompare doit gérer ce cas
    const res = await request(app)
      .post('/api/admin/login')
      .send({ password: 'motdepasse-test-beaucoup-plus-long' });
    assert.equal(res.status, 401);
  });
});

describe('requireAdmin middleware', () => {
  let dir, app;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'borne-mw-'));
    app = createApp(dir, { ...TEST_CONFIG, dataDir: dir });
    // Route de test protégée
    app.get('/api/admin/ping', requireAdmin(TEST_CONFIG), (req, res) => res.json({ ok: true }));
  });

  afterEach(() => {
    closeRegistry();
    rmSync(dir, { recursive: true });
  });

  const makeToken = (payload = { role: 'admin' }) =>
    jwt.sign(payload, TEST_CONFIG.jwtSecret, { expiresIn: '1h' });

  test('accepte un token valide dans Authorization: Bearer', async () => {
    const token = makeToken();
    const res = await request(app)
      .get('/api/admin/ping')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
  });

  test('accepte un token valide dans ?token= (invariant §11.2)', async () => {
    const token = makeToken();
    const res = await request(app).get(`/api/admin/ping?token=${token}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
  });

  test('retourne 401 si token manquant', async () => {
    const res = await request(app).get('/api/admin/ping');
    assert.equal(res.status, 401);
  });

  test('retourne 401 si token invalide', async () => {
    const res = await request(app)
      .get('/api/admin/ping')
      .set('Authorization', 'Bearer token-bidon');
    assert.equal(res.status, 401);
  });

  test('retourne 401 si token signé avec une autre clé', async () => {
    const token = jwt.sign({ role: 'admin' }, 'autre-secret', { expiresIn: '1h' });
    const res = await request(app)
      .get('/api/admin/ping')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 401);
  });

  test('retourne 401 pour un token alg:none (§S5.1/L1)', async () => {
    // Forge un JWT avec alg:none pour tester que l'épinglage algorithms rejet bien ce cas
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ role: 'admin', iat: Math.floor(Date.now() / 1000) })).toString('base64url');
    const noneToken = `${header}.${payload}.`;
    const res = await request(app)
      .get('/api/admin/ping')
      .set('Authorization', `Bearer ${noneToken}`);
    assert.equal(res.status, 401);
  });

  test('retourne 403 si le rôle n\'est pas admin', async () => {
    const token = makeToken({ role: 'user' });
    const res = await request(app)
      .get('/api/admin/ping')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 403);
  });
});
