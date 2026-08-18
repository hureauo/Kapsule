import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/index.js';
import { closeRegistry, insertEvent, setActiveEvent } from '../src/registry.js';
import { closeEventDb } from '../src/eventDb.js';
import { requireAdmin, requireTech } from '../src/middleware/auth.js';
import { createEventDb } from '@kapsule/core/src/eventDbSchema.js';

const TEST_CONFIG = {
  jwtSecret: 'secret-test',
  dataDir: '',
  skipRateLimits: true,
};

// ── POST /api/admin/login — PIN partagé (admin_pin / tech_pin) ───────────────
// Ni admin_borne ni tech_borne n'ont de compte nominatif (cf. PROJET.md) : les
// deux rôles s'authentifient par un code à 6 chiffres partagé, pullé dans
// event_meta. tech_pin (rôle le plus élevé) est essayé avant admin_pin.

// Crée un événement actif avec des PIN dans event_meta (admin_pin/tech_pin, ou null pour omettre)
function seedActiveEventWithPin(dir, { adminPin = null, techPin = null } = {}) {
  insertEvent({ id: 'ev-pin', name: 'PIN Test', origin: 'hub', status: 'loaded' });
  setActiveEvent('ev-pin');

  const eventDir = join(dir, 'events', 'ev-pin');
  mkdirSync(eventDir, { recursive: true });
  const edb = createEventDb(join(eventDir, 'db.sqlite'));
  if (adminPin !== null) {
    edb.prepare("INSERT INTO event_meta (key, value) VALUES ('admin_pin', ?)").run(adminPin);
  }
  if (techPin !== null) {
    edb.prepare("INSERT INTO event_meta (key, value) VALUES ('tech_pin', ?)").run(techPin);
  }
  edb.close();
}

describe('POST /api/admin/login — PIN partagé (event_meta.admin_pin / tech_pin)', () => {
  let dir, app;

  afterEach(() => {
    closeEventDb();
    closeRegistry();
    rmSync(dir, { recursive: true });
  });

  test('admin_pin correct → JWT roles admin_borne, sans email', async () => {
    dir = mkdtempSync(join(tmpdir(), 'borne-pin-'));
    app = createApp(dir, { ...TEST_CONFIG, dataDir: dir });
    seedActiveEventWithPin(dir, { adminPin: '123456', techPin: '654321' });

    const res = await request(app).post('/api/admin/login').send({ pin: '123456' });
    assert.equal(res.status, 200);
    assert.ok(res.body.token);
    const payload = jwt.verify(res.body.token, TEST_CONFIG.jwtSecret);
    assert.deepEqual(payload.roles, ['admin_borne']);
    assert.equal(payload.email, undefined);
  });

  test('tech_pin correct → JWT roles tech_borne', async () => {
    dir = mkdtempSync(join(tmpdir(), 'borne-pin-'));
    app = createApp(dir, { ...TEST_CONFIG, dataDir: dir });
    seedActiveEventWithPin(dir, { adminPin: '123456', techPin: '654321' });

    const res = await request(app).post('/api/admin/login').send({ pin: '654321' });
    assert.equal(res.status, 200);
    const payload = jwt.verify(res.body.token, TEST_CONFIG.jwtSecret);
    assert.deepEqual(payload.roles, ['tech_borne']);
  });

  test('retourne 401 si mauvais PIN', async () => {
    dir = mkdtempSync(join(tmpdir(), 'borne-pin-'));
    app = createApp(dir, { ...TEST_CONFIG, dataDir: dir });
    seedActiveEventWithPin(dir, { adminPin: '123456', techPin: '654321' });

    const res = await request(app).post('/api/admin/login').send({ pin: '000000' });
    assert.equal(res.status, 401);
  });

  test('retourne 401 si aucun PIN configuré sur l\'événement actif', async () => {
    dir = mkdtempSync(join(tmpdir(), 'borne-pin-'));
    app = createApp(dir, { ...TEST_CONFIG, dataDir: dir });
    seedActiveEventWithPin(dir, {});

    const res = await request(app).post('/api/admin/login').send({ pin: '123456' });
    assert.equal(res.status, 401);
  });

  test('retourne 401 si aucun événement actif', async () => {
    dir = mkdtempSync(join(tmpdir(), 'borne-pin-'));
    app = createApp(dir, { ...TEST_CONFIG, dataDir: dir });

    const res = await request(app).post('/api/admin/login').send({ pin: '123456' });
    assert.equal(res.status, 401);
  });
});

// ── POST /api/admin/login — plus de fallback par mot de passe (§11.30) ───────
// TECH_PASSWORD a été retiré : le seul chemin d'auth est désormais { pin }.
// La fenêtre avant le premier PIN (juste après appairage) est couverte par la
// session ouverte directement par POST /sync/onboarding/pair (sync.routes.test.js).

describe('POST /api/admin/login — sans PIN dans le corps', () => {
  let dir, app;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'borne-auth-nopin-body-'));
    app = createApp(dir, { ...TEST_CONFIG, dataDir: dir });
  });

  afterEach(() => {
    closeEventDb();
    closeRegistry();
    rmSync(dir, { recursive: true });
  });

  test('un { password } seul (ancien fallback) est rejeté — 401', async () => {
    const res = await request(app)
      .post('/api/admin/login')
      .send({ password: 'nimporte-quoi' });
    assert.equal(res.status, 401);
  });

  test('retourne 401 si corps vide', async () => {
    const res = await request(app).post('/api/admin/login').send({});
    assert.equal(res.status, 401);
  });
});

// ── requireAdmin middleware ────────────────────────────────────────────────────

describe('requireAdmin middleware', () => {
  let dir, app;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'borne-mw-'));
    app = createApp(dir, { ...TEST_CONFIG, dataDir: dir });
    app.get('/api/admin/ping', requireAdmin(TEST_CONFIG), (req, res) => res.json({ ok: true }));
  });

  afterEach(() => {
    closeEventDb();
    closeRegistry();
    rmSync(dir, { recursive: true });
  });

  const makeToken = (payload) => jwt.sign(payload, TEST_CONFIG.jwtSecret, { expiresIn: '1h' });

  test('accepte un token admin_borne', async () => {
    const token = makeToken({ email: 'a@test.com', roles: ['admin_borne'] });
    const res = await request(app)
      .get('/api/admin/ping')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 200);
  });

  test('accepte un token tech_borne (sur-ensemble, §11.19)', async () => {
    const token = makeToken({ roles: ['tech_borne'] });
    const res = await request(app)
      .get('/api/admin/ping')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 200);
  });

  test('accepte un token valide dans ?token= (invariant §11.2)', async () => {
    const token = makeToken({ roles: ['admin_borne'] });
    const res = await request(app).get(`/api/admin/ping?token=${token}`);
    assert.equal(res.status, 200);
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
    const token = jwt.sign({ roles: ['admin_borne'] }, 'autre-secret', { expiresIn: '1h' });
    const res = await request(app)
      .get('/api/admin/ping')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 401);
  });

  test('retourne 401 pour un token alg:none (§S5.1/L1)', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ roles: ['admin_borne'], iat: Math.floor(Date.now() / 1000) })).toString('base64url');
    const noneToken = `${header}.${payload}.`;
    const res = await request(app)
      .get('/api/admin/ping')
      .set('Authorization', `Bearer ${noneToken}`);
    assert.equal(res.status, 401);
  });

  test('retourne 403 si roles ne contient pas admin_borne ni tech_borne', async () => {
    const token = makeToken({ roles: ['general'] });
    const res = await request(app)
      .get('/api/admin/ping')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 403);
  });
});

// ── requireTech middleware ─────────────────────────────────────────────────────

describe('requireTech middleware', () => {
  let dir, app;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'borne-tech-'));
    app = createApp(dir, { ...TEST_CONFIG, dataDir: dir });
    app.get('/api/tech/ping', requireTech(TEST_CONFIG), (req, res) => res.json({ ok: true }));
  });

  afterEach(() => {
    closeEventDb();
    closeRegistry();
    rmSync(dir, { recursive: true });
  });

  const makeToken = (payload) => jwt.sign(payload, TEST_CONFIG.jwtSecret, { expiresIn: '1h' });

  test('accepte un token tech_borne', async () => {
    const token = makeToken({ roles: ['tech_borne'] });
    const res = await request(app)
      .get('/api/tech/ping')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 200);
  });

  test('retourne 403 pour un token admin_borne seul (§11.19)', async () => {
    const token = makeToken({ roles: ['admin_borne'] });
    const res = await request(app)
      .get('/api/tech/ping')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 403);
  });

  test('retourne 401 si token manquant', async () => {
    const res = await request(app).get('/api/tech/ping');
    assert.equal(res.status, 401);
  });
});

// ── Cloisonnement event_id dans requireAdmin ───────────────────────────────────
// Un JWT scopé à un événement précis (émis par le Hub pour la preview) doit
// être rejeté si la borne sert un autre événement.

describe('requireAdmin — cloisonnement event_id', () => {
  let dir, app;
  const ACTIVE_EVENT_ID = 'ev-cloison-active';
  const OTHER_EVENT_ID  = 'ev-cloison-other';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'borne-cloison-'));
    app = createApp(dir, { ...TEST_CONFIG, dataDir: dir });
    app.get('/api/admin/ping', requireAdmin(TEST_CONFIG), (req, res) => res.json({ ok: true }));
    // Simule un événement actif sur cette borne
    insertEvent({ id: ACTIVE_EVENT_ID, name: 'Actif', origin: 'hub', status: 'loaded' });
    setActiveEvent(ACTIVE_EVENT_ID);
  });

  afterEach(() => {
    closeEventDb();
    closeRegistry();
    rmSync(dir, { recursive: true });
  });

  const makeToken = (payload) => jwt.sign(payload, TEST_CONFIG.jwtSecret, { expiresIn: '1h' });

  test('accepte un JWT admin_borne scopé à l\'événement actif', async () => {
    const token = makeToken({ roles: ['admin_borne'], event_id: ACTIVE_EVENT_ID });
    const res = await request(app).get('/api/admin/ping').set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 200);
  });

  test('rejette un JWT scopé à un autre événement (403)', async () => {
    const token = makeToken({ roles: ['admin_borne'], event_id: OTHER_EVENT_ID });
    const res = await request(app).get('/api/admin/ping').set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 403);
  });

  test('accepte un JWT sans event_id (tokens non scopés)', async () => {
    const token = makeToken({ roles: ['admin_borne'] });
    const res = await request(app).get('/api/admin/ping').set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 200);
  });
});
