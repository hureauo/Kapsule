import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createApp } from '../src/index.js';
import { closeRegistry } from '../src/registry.js';
import { closeEventDb } from '../src/eventDb.js';

const TEST_CFG = { adminPassword: 'test', jwtSecret: 'secret-test', dataDir: '' };

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'borne-q-'));
  const app = createApp(dir, { ...TEST_CFG, dataDir: dir });
  const loginRes = await request(app).post('/api/admin/login').send({ password: 'test' });
  const token = loginRes.body.token;
  // Crée un événement et l'active
  const evtRes = await request(app)
    .post('/api/events')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'Evt Questions' });
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

// ── GET /api/questions (public) ───────────────────────────────────────────────

describe('GET /api/questions', () => {
  let ctx;
  beforeEach(async () => { ctx = await setup(); });
  afterEach(() => teardown(ctx.dir));

  test('retourne les 4 questions par défaut (seed)', async () => {
    const res = await request(ctx.app).get('/api/questions');
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 4);
  });

  test('accessible sans token (public)', async () => {
    const res = await request(ctx.app).get('/api/questions'); // pas de token
    assert.equal(res.status, 200);
  });

  test('retourne 404 si aucun événement actif', async () => {
    // Crée une app fraîche dans un dir temporaire distinct, sans activer d'événement
    const dir2 = mkdtempSync(join(tmpdir(), 'borne-q-noact-'));
    // Ferme le singleton courant avant d'en ouvrir un autre dans un dir différent
    closeEventDb();
    closeRegistry();
    try {
      const app2 = createApp(dir2, { ...TEST_CFG, dataDir: dir2 });
      const res = await request(app2).get('/api/questions');
      assert.equal(res.status, 404);
    } finally {
      closeEventDb();
      closeRegistry();
      rmSync(dir2, { recursive: true });
      // Réinitialiser le contexte principal pour les autres tests de la suite
      ctx.app = createApp(ctx.dir, { ...TEST_CFG, dataDir: ctx.dir });
    }
  });
});

// ── POST /api/questions ───────────────────────────────────────────────────────

describe('POST /api/questions', () => {
  let ctx;
  beforeEach(async () => { ctx = await setup(); });
  afterEach(() => teardown(ctx.dir));

  test('crée une question et retourne 201', async () => {
    const res = await request(ctx.app)
      .post('/api/questions')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ text: 'Nouvelle question ?' });
    assert.equal(res.status, 201);
    assert.equal(res.body.text, 'Nouvelle question ?');
    assert.equal(res.body.max_duration, 60);
    assert.equal(res.body.countdown, 3);
  });

  test('order_index est max+1', async () => {
    const res = await request(ctx.app)
      .post('/api/questions')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ text: 'Question bonus', max_duration: 90 });
    // Les 4 seeds ont order_index 0–3, donc la nouvelle doit avoir 4
    assert.equal(res.body.order_index, 4);
  });

  test('retourne 400 si text manquant', async () => {
    const res = await request(ctx.app)
      .post('/api/questions')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ max_duration: 60 });
    assert.equal(res.status, 400);
  });

  test('retourne 400 si max_duration hors bornes', async () => {
    const res = await request(ctx.app)
      .post('/api/questions')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ text: 'Trop long', max_duration: 9 });
    assert.equal(res.status, 400);
  });

  test('retourne 401 sans token', async () => {
    const res = await request(ctx.app).post('/api/questions').send({ text: 'X' });
    assert.equal(res.status, 401);
  });
});

// ── PUT /api/questions/reorder/batch ──────────────────────────────────────────

describe('PUT /api/questions/reorder/batch', () => {
  let ctx;
  beforeEach(async () => { ctx = await setup(); });
  afterEach(() => teardown(ctx.dir));

  test('réordonne en transaction', async () => {
    const listRes = await request(ctx.app).get('/api/questions');
    const questions = listRes.body;
    // Inverser les deux premiers
    const order = [
      { id: questions[0].id, order_index: 10 },
      { id: questions[1].id, order_index: 0 },
    ];
    const res = await request(ctx.app)
      .put('/api/questions/reorder/batch')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ order });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    // Vérifie que l'ordre a changé
    const after = await request(ctx.app).get('/api/questions');
    assert.equal(after.body[0].id, questions[1].id);
  });

  test('retourne 400 si order vide', async () => {
    const res = await request(ctx.app)
      .put('/api/questions/reorder/batch')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ order: [] });
    assert.equal(res.status, 400);
  });

  test('retourne 401 sans token', async () => {
    const res = await request(ctx.app)
      .put('/api/questions/reorder/batch')
      .send({ order: [{ id: 1, order_index: 0 }] });
    assert.equal(res.status, 401);
  });
});

// ── PUT /api/questions/:id ────────────────────────────────────────────────────

describe('PUT /api/questions/:id', () => {
  let ctx;
  beforeEach(async () => { ctx = await setup(); });
  afterEach(() => teardown(ctx.dir));

  test('met à jour partiellement une question', async () => {
    const listRes = await request(ctx.app).get('/api/questions');
    const q = listRes.body[0];
    const res = await request(ctx.app)
      .put(`/api/questions/${q.id}`)
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ text: 'Texte modifié', enabled: 0 });
    assert.equal(res.status, 200);
    assert.equal(res.body.text, 'Texte modifié');
    assert.equal(res.body.enabled, 0);
    // max_duration inchangé
    assert.equal(res.body.max_duration, q.max_duration);
  });

  test('retourne 404 pour un id inexistant', async () => {
    const res = await request(ctx.app)
      .put('/api/questions/9999')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ text: 'X' });
    assert.equal(res.status, 404);
  });

  test('retourne 400 si aucun champ', async () => {
    const listRes = await request(ctx.app).get('/api/questions');
    const q = listRes.body[0];
    const res = await request(ctx.app)
      .put(`/api/questions/${q.id}`)
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({});
    assert.equal(res.status, 400);
  });

  test('retourne 401 sans token', async () => {
    const res = await request(ctx.app).put('/api/questions/1').send({ text: 'X' });
    assert.equal(res.status, 401);
  });
});

// ── DELETE /api/questions/:id ─────────────────────────────────────────────────

describe('DELETE /api/questions/:id', () => {
  let ctx;
  beforeEach(async () => { ctx = await setup(); });
  afterEach(() => teardown(ctx.dir));

  test('supprime une question et retourne 204', async () => {
    const listRes = await request(ctx.app).get('/api/questions');
    const q = listRes.body[0];
    const res = await request(ctx.app)
      .delete(`/api/questions/${q.id}`)
      .set('Authorization', `Bearer ${ctx.token}`);
    assert.equal(res.status, 204);
    // Vérifier qu'elle n'est plus là
    const after = await request(ctx.app).get('/api/questions');
    assert.ok(!after.body.find(x => x.id === q.id));
  });

  test('retourne 404 pour un id inexistant', async () => {
    const res = await request(ctx.app)
      .delete('/api/questions/9999')
      .set('Authorization', `Bearer ${ctx.token}`);
    assert.equal(res.status, 404);
  });

  test('retourne 401 sans token', async () => {
    const res = await request(ctx.app).delete('/api/questions/1');
    assert.equal(res.status, 401);
  });
});
