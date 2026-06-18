import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import argon2 from 'argon2';
import Database from 'better-sqlite3';
import { createApp } from '../src/index.js';
import { closeRegistry, getRegistry, insertEvent, setActiveEvent } from '../src/registry.js';
import { closeEventDb } from '../src/eventDb.js';
import { requireAdmin, requireTech } from '../src/middleware/auth.js';
import { createEventDb } from '@kapsule/core/src/eventDbSchema.js';

const TEST_CONFIG = {
  techPassword: 'tech-test',
  jwtSecret: 'secret-test',
  dataDir: '',
};

// Crée un événement actif avec un user event_users (hash argon2)
async function seedActiveEvent(dir, email, password, roles) {
  insertEvent({ id: 'ev-auth', name: 'Auth Test', origin: 'hub', status: 'loaded' });
  setActiveEvent('ev-auth');

  const eventDir = join(dir, 'events', 'ev-auth');
  mkdirSync(eventDir, { recursive: true });
  const edb = createEventDb(join(eventDir, 'db.sqlite'));
  const hash = await argon2.hash(password, { type: argon2.argon2id });
  edb.prepare('INSERT INTO event_users (email, password_hash, roles) VALUES (?, ?, ?)').run(
    email, hash, JSON.stringify(roles)
  );
  edb.close();
}

// ── POST /api/admin/login — auth par compte nominatif ────────────────────────

describe('POST /api/admin/login — compte nominatif (event_users)', () => {
  let dir, app;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'borne-auth-'));
    app = createApp(dir, { ...TEST_CONFIG, dataDir: dir });
    await seedActiveEvent(dir, 'alice@test.com', 'mdp-alice', ['admin_borne']);
  });

  afterEach(() => {
    closeEventDb();
    closeRegistry();
    rmSync(dir, { recursive: true });
  });

  test('login ok → JWT avec email + roles', async () => {
    const res = await request(app)
      .post('/api/admin/login')
      .send({ email: 'alice@test.com', password: 'mdp-alice' });
    assert.equal(res.status, 200);
    assert.ok(res.body.token);
    const payload = jwt.verify(res.body.token, TEST_CONFIG.jwtSecret);
    assert.equal(payload.email, 'alice@test.com');
    assert.deepEqual(payload.roles, ['admin_borne']);
  });

  test('retourne 401 avec un mauvais mot de passe', async () => {
    const res = await request(app)
      .post('/api/admin/login')
      .send({ email: 'alice@test.com', password: 'mauvais' });
    assert.equal(res.status, 401);
  });

  test('retourne 401 si email inconnu', async () => {
    const res = await request(app)
      .post('/api/admin/login')
      .send({ email: 'inconnu@test.com', password: 'mdp-alice' });
    assert.equal(res.status, 401);
  });

  test('retourne 401 si corps vide', async () => {
    const res = await request(app).post('/api/admin/login').send({});
    assert.equal(res.status, 401);
  });
});

// ── POST /api/admin/login — fallback TECH_PASSWORD (mode autonome) ───────────

describe('POST /api/admin/login — fallback TECH_PASSWORD (aucun user en base)', () => {
  let dir, app;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'borne-auth-fallback-'));
    app = createApp(dir, { ...TEST_CONFIG, dataDir: dir });
    // Pas d'événement actif → event_users vide → fallback env
  });

  afterEach(() => {
    closeEventDb();
    closeRegistry();
    rmSync(dir, { recursive: true });
  });

  test('login avec TECH_PASSWORD → JWT roles tech_borne', async () => {
    const res = await request(app)
      .post('/api/admin/login')
      .send({ password: 'tech-test' });
    assert.equal(res.status, 200);
    assert.ok(res.body.token);
    const payload = jwt.verify(res.body.token, TEST_CONFIG.jwtSecret);
    assert.deepEqual(payload.roles, ['tech_borne']);
  });

  test('retourne 401 si mauvais mot de passe env', async () => {
    const res = await request(app)
      .post('/api/admin/login')
      .send({ password: 'mauvais' });
    assert.equal(res.status, 401);
  });

  test('retourne 401 si corps vide (pas de password)', async () => {
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
