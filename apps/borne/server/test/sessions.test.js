import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createApp } from '../src/index.js';
import { closeRegistry, getActiveEvent, insertEvent, setActiveEvent, getRegistry } from '../src/registry.js';
import { closeEventDb } from '../src/eventDb.js';
import { createEventDb } from '@kapsule/core/src/eventDbSchema.js';
import { TEST_CFG, seedAuthUsers, loginAdmin, loginTech } from './helpers.js';
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';

const EVENT_ID = 'ev-sessions-test';

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'borne-sess-'));
  const eventDir = join(dir, 'events', EVENT_ID);
  mkdirSync(join(eventDir, 'videos'), { recursive: true });
  const edb = createEventDb(join(eventDir, 'db.sqlite'));
  edb.close();
  const app = createApp(dir, { ...TEST_CFG, dataDir: dir });
  await seedAuthUsers(dir);
  const token = await loginAdmin(app, request);
  const techToken = await loginTech(app, request);
  insertEvent({ id: EVENT_ID, name: 'Evt Sessions', origin: 'hub', status: 'loaded' });
  setActiveEvent(EVENT_ID);
  return { dir, app, token, techToken, eventId: EVENT_ID };
}

function teardown(dir) {
  closeEventDb();
  closeRegistry();
  rmSync(dir, { recursive: true });
}

// ── POST /api/sessions ────────────────────────────────────────────────────────

describe('POST /api/sessions', () => {
  let ctx;
  beforeEach(async () => { ctx = await setup(); });
  afterEach(() => teardown(ctx.dir));

  test('crée une session et retourne 201', async () => {
    const res = await request(ctx.app)
      .post('/api/sessions')
      .send({ guest_name: 'Alice', consent: true });
    assert.equal(res.status, 201);
    assert.ok(res.body.id);
    assert.equal(res.body.guest_name, 'Alice');
    assert.ok(res.body.consent_at);
  });

  test('passe l\'événement en live à la première session', async () => {
    await request(ctx.app)
      .post('/api/sessions')
      .send({ guest_name: 'Bob', consent: true });
    const active = getActiveEvent();
    assert.equal(active.status, 'live');
  });

  test('ne repasse pas live si déjà live (idempotent)', async () => {
    await request(ctx.app).post('/api/sessions').send({ guest_name: 'Alice', consent: true });
    await request(ctx.app).post('/api/sessions').send({ guest_name: 'Bob', consent: true });
    const active = getActiveEvent();
    assert.equal(active.status, 'live');
  });

  test('retourne 400 si consent manquant', async () => {
    const res = await request(ctx.app)
      .post('/api/sessions')
      .send({ guest_name: 'Alice' });
    assert.equal(res.status, 400);
  });

  test('retourne 400 si consent est false', async () => {
    const res = await request(ctx.app)
      .post('/api/sessions')
      .send({ guest_name: 'Alice', consent: false });
    assert.equal(res.status, 400);
  });

  test('retourne 400 si consent est la string "true" (pas booléen)', async () => {
    const res = await request(ctx.app)
      .post('/api/sessions')
      .send({ guest_name: 'Alice', consent: 'true' });
    assert.equal(res.status, 400);
  });

  test('retourne 400 si guest_name vide', async () => {
    const res = await request(ctx.app)
      .post('/api/sessions')
      .send({ guest_name: '', consent: true });
    assert.equal(res.status, 400);
  });

  test('retourne 409 si l\'événement est clôturé (closed)', async () => {
    // Passage en live puis clôture (close requiert requireTech)
    await request(ctx.app).post('/api/sessions').send({ guest_name: 'Alice', consent: true });
    await request(ctx.app)
      .put(`/api/events/${ctx.eventId}/close`)
      .set('Authorization', `Bearer ${ctx.techToken}`);
    const res = await request(ctx.app)
      .post('/api/sessions')
      .send({ guest_name: 'Bob', consent: true });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'event_closed');
  });

  test('retourne 404 si aucun événement actif', async () => {
    // Nouveau contexte sans événement actif
    const dir2 = mkdtempSync(join(tmpdir(), 'borne-sess-noact-'));
    closeEventDb(); closeRegistry();
    try {
      const app2 = createApp(dir2, { ...TEST_CFG, dataDir: dir2 });
      const res = await request(app2).post('/api/sessions').send({ guest_name: 'X', consent: true });
      assert.equal(res.status, 404);
    } finally {
      closeEventDb(); closeRegistry();
      rmSync(dir2, { recursive: true });
      ctx.app = createApp(ctx.dir, { ...TEST_CFG, dataDir: ctx.dir });
    }
  });
});

// ── GET /api/sessions/:id/answers ─────────────────────────────────────────────

describe('GET /api/sessions/:id/answers', () => {
  let ctx;
  beforeEach(async () => { ctx = await setup(); });
  afterEach(() => teardown(ctx.dir));

  test('retourne [] pour une session sans vidéos', async () => {
    const sessRes = await request(ctx.app)
      .post('/api/sessions')
      .send({ guest_name: 'Alice', consent: true });
    const res = await request(ctx.app)
      .get(`/api/sessions/${sessRes.body.id}/answers`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, []);
  });

  test('retourne 404 pour un id de session inexistant', async () => {
    const res = await request(ctx.app).get('/api/sessions/id-inexistant/answers');
    assert.equal(res.status, 404);
  });

  test('accessible sans token (public)', async () => {
    const sessRes = await request(ctx.app)
      .post('/api/sessions')
      .send({ guest_name: 'Alice', consent: true });
    const res = await request(ctx.app) // pas de token
      .get(`/api/sessions/${sessRes.body.id}/answers`);
    assert.equal(res.status, 200);
  });
});

// ── PUT /api/sessions/:id/complete ────────────────────────────────────────────

describe('PUT /api/sessions/:id/complete', () => {
  let ctx;
  beforeEach(async () => { ctx = await setup(); });
  afterEach(() => teardown(ctx.dir));

  test('marque la session comme complétée', async () => {
    const sessRes = await request(ctx.app)
      .post('/api/sessions')
      .send({ guest_name: 'Alice', consent: true });
    const res = await request(ctx.app)
      .put(`/api/sessions/${sessRes.body.id}/complete`);
    assert.equal(res.status, 200);
    assert.ok(res.body.completed_at);
  });

  test('retourne 404 pour un id inexistant', async () => {
    const res = await request(ctx.app).put('/api/sessions/inexistant/complete');
    assert.equal(res.status, 404);
  });

  test('accessible sans token (public)', async () => {
    const sessRes = await request(ctx.app)
      .post('/api/sessions')
      .send({ guest_name: 'Alice', consent: true });
    const res = await request(ctx.app) // pas de token
      .put(`/api/sessions/${sessRes.body.id}/complete`);
    assert.equal(res.status, 200);
  });
});

// ── GET /api/sessions (admin) ─────────────────────────────────────────────────

describe('GET /api/sessions', () => {
  let ctx;
  beforeEach(async () => { ctx = await setup(); });
  afterEach(() => teardown(ctx.dir));

  test('retourne la liste des sessions avec video_count', async () => {
    await request(ctx.app).post('/api/sessions').send({ guest_name: 'Alice', consent: true });
    await request(ctx.app).post('/api/sessions').send({ guest_name: 'Bob', consent: true });
    const res = await request(ctx.app)
      .get('/api/sessions')
      .set('Authorization', `Bearer ${ctx.token}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 2);
    assert.ok('video_count' in res.body[0]);
    assert.ok('consent_at' in res.body[0]);
  });

  test('retourne 401 sans token', async () => {
    const res = await request(ctx.app).get('/api/sessions');
    assert.equal(res.status, 401);
  });
});

// ── POST /api/sessions — preview protégée (§7D.3) ────────────────────────────

describe('POST /api/sessions — preview requiresLogin', () => {
  let dir, app;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'borne-sess-preview-'));
    const eventDir = join(dir, 'events', 'ev-preview-login');
    mkdirSync(join(eventDir, 'videos'), { recursive: true });
    const edb = createEventDb(join(eventDir, 'db.sqlite'));

    // Seeder un user general avec hash argon2
    const hash = await argon2.hash('guest-pass', { type: argon2.argon2id });
    edb.prepare("INSERT INTO event_users (email, password_hash, roles) VALUES (?, ?, ?)").run(
      'guest@test.com', hash, JSON.stringify(['general'])
    );
    edb.close();

    app = createApp(dir, { ...TEST_CFG, dataDir: dir, previewMode: true });
    // Enregistrer l'event comme preview
    insertEvent({ id: 'ev-preview-login', name: 'Preview Login', origin: 'hub', status: 'loaded', is_preview: 1 });
    setActiveEvent('ev-preview-login');
  });

  afterEach(() => {
    closeEventDb();
    closeRegistry();
    rmSync(dir, { recursive: true });
  });

  test('retourne 401 sans token quand requiresLogin', async () => {
    const res = await request(app)
      .post('/api/sessions')
      .send({ guest_name: 'Alice', consent: true });
    assert.equal(res.status, 401);
  });

  test('retourne 401 avec token invalide', async () => {
    const res = await request(app)
      .post('/api/sessions')
      .set('Authorization', 'Bearer token-bidon')
      .send({ guest_name: 'Alice', consent: true });
    assert.equal(res.status, 401);
  });

  test('retourne 403 avec token sans rôle borne autorisé', async () => {
    // Aucun des rôles autorisés (general, admin_borne, tech_borne) n'est présent
    const token = jwt.sign({ roles: ['other_role'] }, TEST_CFG.jwtSecret, { expiresIn: '1h' });
    const res = await request(app)
      .post('/api/sessions')
      .set('Authorization', `Bearer ${token}`)
      .send({ guest_name: 'Alice', consent: true });
    assert.equal(res.status, 403);
  });

  test('retourne 201 avec token general valide', async () => {
    const token = jwt.sign({ email: 'guest@test.com', roles: ['general'] }, TEST_CFG.jwtSecret, { expiresIn: '1h' });
    const res = await request(app)
      .post('/api/sessions')
      .set('Authorization', `Bearer ${token}`)
      .send({ guest_name: 'Alice', consent: true });
    assert.equal(res.status, 201);
    assert.ok(res.body.id);
  });

  test('retourne 201 avec token general scopé à cet événement', async () => {
    const token = jwt.sign({ roles: ['general'], event_id: 'ev-preview-login' }, TEST_CFG.jwtSecret, { expiresIn: '1h' });
    const res = await request(app)
      .post('/api/sessions')
      .set('Authorization', `Bearer ${token}`)
      .send({ guest_name: 'Bob', consent: true });
    assert.equal(res.status, 201);
  });

  test('retourne 403 avec token general scopé à un autre événement (cloisonnement cross-preview)', async () => {
    const token = jwt.sign({ roles: ['general'], event_id: 'ev-autre-event' }, TEST_CFG.jwtSecret, { expiresIn: '1h' });
    const res = await request(app)
      .post('/api/sessions')
      .set('Authorization', `Bearer ${token}`)
      .send({ guest_name: 'Mallory', consent: true });
    assert.equal(res.status, 403);
  });
});

// ── Token general → accès refusé aux routes admin ─────────────────────────────
// Un user général peut créer une session (preview) mais ne peut PAS accéder
// aux routes admin (videos, sessions list…). Le frontend doit aussi refuser
// de considérer ce token comme une auth admin valide.

describe('token general — accès refusé aux routes admin', () => {
  let dir, app, generalToken;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'borne-general-admin-'));
    const eventDir = join(dir, 'events', 'ev-general');
    mkdirSync(join(eventDir, 'videos'), { recursive: true });
    const edb = createEventDb(join(eventDir, 'db.sqlite'));
    const hash = await argon2.hash('pwd', { type: argon2.argon2id });
    edb.prepare('INSERT INTO event_users (email, password_hash, roles) VALUES (?, ?, ?)').run(
      'guest@general.test', hash, JSON.stringify(['general'])
    );
    edb.close();
    app = createApp(dir, { ...TEST_CFG, dataDir: dir });
    insertEvent({ id: 'ev-general', name: 'General Test', origin: 'hub', status: 'loaded' });
    setActiveEvent('ev-general');
    // Login avec le compte general
    const res = await request(app).post('/api/admin/login').send({ email: 'guest@general.test', password: 'pwd' });
    generalToken = res.body.token;
  });

  afterEach(() => {
    closeEventDb();
    closeRegistry();
    rmSync(dir, { recursive: true });
  });

  test('login retourne un token avec rôle general uniquement', async () => {
    assert.ok(generalToken, 'le login doit réussir');
    const payload = JSON.parse(Buffer.from(generalToken.split('.')[1], 'base64').toString());
    assert.deepEqual(payload.roles, ['general']);
  });

  test('GET /api/videos retourne 403 avec token general', async () => {
    const res = await request(app)
      .get('/api/videos')
      .set('Authorization', `Bearer ${generalToken}`);
    assert.equal(res.status, 403);
  });

  test('GET /api/sessions retourne 403 avec token general', async () => {
    const res = await request(app)
      .get('/api/sessions')
      .set('Authorization', `Bearer ${generalToken}`);
    assert.equal(res.status, 403);
  });
});
