import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createApp } from '../src/index.js';
import { closeRegistry, updateEventStatus } from '../src/registry.js';
import { closeEventDb } from '../src/eventDb.js';

const TEST_CFG = { adminPassword: 'test', jwtSecret: 'secret-test', dataDir: '' };

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'borne-ev-'));
  const app = createApp(dir, { ...TEST_CFG, dataDir: dir });
  // Obtenir un token admin
  const loginRes = await request(app).post('/api/admin/login').send({ password: 'test' });
  const token = loginRes.body.token;
  return { dir, app, token };
}

function teardown(dir) {
  closeEventDb();
  closeRegistry();
  rmSync(dir, { recursive: true });
}

// ── GET /api/events ───────────────────────────────────────────────────────────

describe('GET /api/events', () => {
  let ctx;
  beforeEach(async () => { ctx = await setup(); });
  afterEach(() => teardown(ctx.dir));

  test('retourne une liste vide au démarrage', async () => {
    const res = await request(ctx.app).get('/api/events').set('Authorization', `Bearer ${ctx.token}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, []);
  });

  test('retourne 401 sans token', async () => {
    const res = await request(ctx.app).get('/api/events');
    assert.equal(res.status, 401);
  });
});

// ── POST /api/events ──────────────────────────────────────────────────────────

describe('POST /api/events', () => {
  let ctx;
  beforeEach(async () => { ctx = await setup(); });
  afterEach(() => teardown(ctx.dir));

  test('crée un événement local et retourne 201', async () => {
    const res = await request(ctx.app)
      .post('/api/events')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ name: 'Mariage Test' });
    assert.equal(res.status, 201);
    assert.equal(res.body.name, 'Mariage Test');
    assert.equal(res.body.origin, 'local');
    assert.ok(res.body.id);
  });

  test('crée le dossier events/<id>/videos sur disque', async () => {
    const res = await request(ctx.app)
      .post('/api/events')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ name: 'Test disque' });
    const { existsSync } = await import('node:fs');
    assert.ok(existsSync(join(ctx.dir, 'events', res.body.id, 'videos')));
    assert.ok(existsSync(join(ctx.dir, 'events', res.body.id, 'db.sqlite')));
  });

  test('retourne 400 si name manquant', async () => {
    const res = await request(ctx.app)
      .post('/api/events')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({});
    assert.equal(res.status, 400);
  });

  test('retourne 401 sans token', async () => {
    const res = await request(ctx.app).post('/api/events').send({ name: 'X' });
    assert.equal(res.status, 401);
  });
});

// ── PUT /api/events/:id/activate ─────────────────────────────────────────────

describe('PUT /api/events/:id/activate', () => {
  let ctx;
  beforeEach(async () => { ctx = await setup(); });
  afterEach(() => teardown(ctx.dir));

  test('active un événement existant', async () => {
    const created = await request(ctx.app)
      .post('/api/events')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ name: 'Evt A' });
    const res = await request(ctx.app)
      .put(`/api/events/${created.body.id}/activate`)
      .set('Authorization', `Bearer ${ctx.token}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.active, 1);
  });

  test('retourne 404 pour un id inexistant', async () => {
    const res = await request(ctx.app)
      .put('/api/events/inexistant/activate')
      .set('Authorization', `Bearer ${ctx.token}`);
    assert.equal(res.status, 404);
  });

  test('retourne 401 sans token', async () => {
    const res = await request(ctx.app).put('/api/events/x/activate');
    assert.equal(res.status, 401);
  });
});

// ── PUT /api/events/:id/close ─────────────────────────────────────────────────

describe('PUT /api/events/:id/close', () => {
  let ctx;
  beforeEach(async () => { ctx = await setup(); });
  afterEach(() => teardown(ctx.dir));

  test('clôture un événement live', async () => {
    const created = await request(ctx.app)
      .post('/api/events')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ name: 'Evt Live' });
    updateEventStatus(created.body.id, 'live');
    const res = await request(ctx.app)
      .put(`/api/events/${created.body.id}/close`)
      .set('Authorization', `Bearer ${ctx.token}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'closed');
  });

  test('retourne 409 si l\'événement n\'est pas live', async () => {
    const created = await request(ctx.app)
      .post('/api/events')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ name: 'Evt Loaded' });
    const res = await request(ctx.app)
      .put(`/api/events/${created.body.id}/close`)
      .set('Authorization', `Bearer ${ctx.token}`);
    assert.equal(res.status, 409);
  });

  test('retourne 404 pour un id inexistant', async () => {
    const res = await request(ctx.app)
      .put('/api/events/inexistant/close')
      .set('Authorization', `Bearer ${ctx.token}`);
    assert.equal(res.status, 404);
  });
});

// ── GET /api/event (public) ────────────────────────────────────────────────────

describe('GET /api/event', () => {
  let ctx;
  beforeEach(async () => { ctx = await setup(); });
  afterEach(() => teardown(ctx.dir));

  test('retourne 404 si aucun événement actif', async () => {
    const res = await request(ctx.app).get('/api/event');
    assert.equal(res.status, 404);
  });

  test('retourne l\'événement actif avec consent_text et idle_timeout', async () => {
    const created = await request(ctx.app)
      .post('/api/events')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ name: 'Evt Public' });
    await request(ctx.app)
      .put(`/api/events/${created.body.id}/activate`)
      .set('Authorization', `Bearer ${ctx.token}`);
    const res = await request(ctx.app).get('/api/event');
    assert.equal(res.status, 200);
    assert.equal(res.body.id, created.body.id);
    assert.equal(res.body.name, 'Evt Public');
    assert.ok(res.body.consent_text);
    assert.ok(typeof res.body.idle_timeout === 'number');
  });

  test('accessible sans token (route publique)', async () => {
    const created = await request(ctx.app)
      .post('/api/events')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ name: 'Evt Public 2' });
    await request(ctx.app)
      .put(`/api/events/${created.body.id}/activate`)
      .set('Authorization', `Bearer ${ctx.token}`);
    const res = await request(ctx.app).get('/api/event'); // pas de token
    assert.equal(res.status, 200);
  });
});

// ── GET /api/preflight ────────────────────────────────────────────────────────

describe('GET /api/preflight', () => {
  let ctx;
  beforeEach(async () => { ctx = await setup(); });
  afterEach(() => teardown(ctx.dir));

  test('retourne la structure attendue sans événement actif', async () => {
    const res = await request(ctx.app)
      .get('/api/preflight')
      .set('Authorization', `Bearer ${ctx.token}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.event.loaded, false);
    assert.equal(res.body.questions_count, 0);
    assert.equal(typeof res.body.disk_ok, 'boolean');
    assert.equal(res.body.clock_ok, null); // pas de ?client_time
  });

  test('clock_ok=true si ?client_time proche de now', async () => {
    const clientTime = new Date().toISOString();
    const res = await request(ctx.app)
      .get(`/api/preflight?client_time=${encodeURIComponent(clientTime)}`)
      .set('Authorization', `Bearer ${ctx.token}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.clock_ok, true);
  });

  test('clock_ok=false si ?client_time très décalé', async () => {
    const past = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const res = await request(ctx.app)
      .get(`/api/preflight?client_time=${encodeURIComponent(past)}`)
      .set('Authorization', `Bearer ${ctx.token}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.clock_ok, false);
  });

  test('retourne 401 sans token', async () => {
    const res = await request(ctx.app).get('/api/preflight');
    assert.equal(res.status, 401);
  });
});
