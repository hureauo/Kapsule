import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createApp } from '../src/index.js';
import { closeRegistry, getActiveEvent } from '../src/registry.js';
import { closeEventDb } from '../src/eventDb.js';

const TEST_CFG = { adminPassword: 'test', jwtSecret: 'secret-test', dataDir: '' };

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'borne-sess-'));
  const app = createApp(dir, { ...TEST_CFG, dataDir: dir });
  const loginRes = await request(app).post('/api/admin/login').send({ password: 'test' });
  const token = loginRes.body.token;
  const evtRes = await request(app)
    .post('/api/events')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'Evt Sessions' });
  await request(app)
    .put(`/api/events/${evtRes.body.id}/activate`)
    .set('Authorization', `Bearer ${token}`);
  return { dir, app, token, eventId: evtRes.body.id };
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
