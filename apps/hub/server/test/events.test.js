import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import supertest from 'supertest';
import argon2 from 'argon2';
import { createApp } from '../src/index.js';
import { getDb, closeRegistry, insertUser } from '../src/registry.js';
import { closeAllEventDbs } from '../src/eventStore.js';

let dir;
let request;
let tokenAlice;
let tokenBob;
let aliceId;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kapsule-hub-events-'));
  const app = createApp(dir);
  request = supertest(app);

  const db = getDb();
  const hashA = await argon2.hash('pass-alice', { type: argon2.argon2id });
  const hashB = await argon2.hash('pass-bob',   { type: argon2.argon2id });
  const resA = insertUser(db, { email: 'alice@ev.test', password_hash: hashA, role: 'client' });
  insertUser(db, { email: 'bob@ev.test', password_hash: hashB, role: 'client' });
  aliceId = resA.lastInsertRowid;

  const loginA = await request.post('/api/auth/login').send({ email: 'alice@ev.test', password: 'pass-alice' });
  const loginB = await request.post('/api/auth/login').send({ email: 'bob@ev.test',   password: 'pass-bob' });
  tokenAlice = loginA.body.token;
  tokenBob   = loginB.body.token;
});

after(() => {
  closeAllEventDbs();
  closeRegistry();
  rmSync(dir, { recursive: true, force: true });
});

const auth = (token) => ({ Authorization: `Bearer ${token}` });

// ── GET /api/events ───────────────────────────────────────────────────────────

describe('GET /api/events', () => {
  it('retourne 401 sans token', async () => {
    const res = await request.get('/api/events');
    assert.equal(res.status, 401);
  });

  it('retourne 200 et un tableau vide pour un nouveau compte', async () => {
    const res = await request.get('/api/events').set(auth(tokenBob));
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
  });
});

// ── POST /api/events ──────────────────────────────────────────────────────────

describe('POST /api/events', () => {
  it('crée un événement et retourne 201', async () => {
    const res = await request.post('/api/events')
      .set(auth(tokenAlice))
      .send({ name: 'Mariage Alice', event_date: '2026-09-01' });
    assert.equal(res.status, 201);
    assert.equal(res.body.name, 'Mariage Alice');
    assert.equal(res.body.status, 'draft');
    assert.equal(res.body.owner_id, aliceId);
  });

  it('retourne 400 si name manquant', async () => {
    const res = await request.post('/api/events').set(auth(tokenAlice)).send({});
    assert.equal(res.status, 400);
  });

  it('retourne 401 sans token', async () => {
    const res = await request.post('/api/events').send({ name: 'Test' });
    assert.equal(res.status, 401);
  });
});

// ── GET /api/events/:eventId ──────────────────────────────────────────────────

describe('GET /api/events/:eventId', () => {
  let eventId;

  before(async () => {
    const res = await request.post('/api/events')
      .set(auth(tokenAlice))
      .send({ name: 'Événement detail' });
    eventId = res.body.id;
  });

  it('retourne 200 pour le propriétaire', async () => {
    const res = await request.get(`/api/events/${eventId}`).set(auth(tokenAlice));
    assert.equal(res.status, 200);
    assert.equal(res.body.id, eventId);
  });

  it('retourne 403 pour un autre user', async () => {
    const res = await request.get(`/api/events/${eventId}`).set(auth(tokenBob));
    assert.equal(res.status, 403);
  });

  it('retourne 404 pour un id inconnu', async () => {
    const res = await request.get('/api/events/evt-inconnu').set(auth(tokenAlice));
    assert.equal(res.status, 404);
  });
});

// ── PUT /api/events/:eventId ──────────────────────────────────────────────────

describe('PUT /api/events/:eventId', () => {
  let eventId;

  before(async () => {
    const res = await request.post('/api/events')
      .set(auth(tokenAlice))
      .send({ name: 'Événement edit' });
    eventId = res.body.id;
  });

  it('met à jour name et event_date', async () => {
    const res = await request.put(`/api/events/${eventId}`)
      .set(auth(tokenAlice))
      .send({ name: 'Nouveau nom', event_date: '2026-10-10' });
    assert.equal(res.status, 200);
    assert.equal(res.body.name, 'Nouveau nom');
  });

  it('écrit consent_text dans event_meta', async () => {
    const res = await request.put(`/api/events/${eventId}`)
      .set(auth(tokenAlice))
      .send({ consent_text: 'Texte RGPD personnalisé' });
    assert.equal(res.status, 200);
  });

  it('retourne 403 pour un autre user', async () => {
    const res = await request.put(`/api/events/${eventId}`)
      .set(auth(tokenBob))
      .send({ name: 'Hack' });
    assert.equal(res.status, 403);
  });
});

// ── PUT /api/events/:eventId/status ──────────────────────────────────────────

describe('PUT /api/events/:eventId/status', () => {
  let eventId;

  before(async () => {
    const res = await request.post('/api/events')
      .set(auth(tokenAlice))
      .send({ name: 'Événement status' });
    eventId = res.body.id;
  });

  it('passe draft → ready', async () => {
    const res = await request.put(`/api/events/${eventId}/status`)
      .set(auth(tokenAlice))
      .send({ status: 'ready' });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ready');
  });

  it('passe ready → draft', async () => {
    const res = await request.put(`/api/events/${eventId}/status`)
      .set(auth(tokenAlice))
      .send({ status: 'draft' });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'draft');
  });

  it('refuse une transition non manuelle (draft → loaded)', async () => {
    const res = await request.put(`/api/events/${eventId}/status`)
      .set(auth(tokenAlice))
      .send({ status: 'loaded' });
    assert.equal(res.status, 400);
  });

  it('gèle l\'édition si statut ≥ live (simule via DB)', async () => {
    // Passer en ready puis simuler un statut live via registry directement
    const { getDb: db, updateEvent } = await import('../src/registry.js');
    updateEvent(db(), eventId, { status: 'live' });

    const res = await request.put(`/api/events/${eventId}/status`)
      .set(auth(tokenAlice))
      .send({ status: 'closed' });
    assert.equal(res.status, 409);

    // Remettre en draft pour ne pas polluer les autres tests
    updateEvent(db(), eventId, { status: 'draft' });
  });
});

// ── PUT /api/events/:eventId/assign ──────────────────────────────────────────

describe('PUT /api/events/:eventId/assign', () => {
  let eventId;

  before(async () => {
    const res = await request.post('/api/events')
      .set(auth(tokenAlice))
      .send({ name: 'Événement assign' });
    eventId = res.body.id;
  });

  it('assigne une box (null = désassigner)', async () => {
    const res = await request.put(`/api/events/${eventId}/assign`)
      .set(auth(tokenAlice))
      .send({ box_id: null });
    assert.equal(res.status, 200);
  });

  it('retourne 400 si box_id manquant', async () => {
    const res = await request.put(`/api/events/${eventId}/assign`)
      .set(auth(tokenAlice))
      .send({});
    assert.equal(res.status, 400);
  });
});

// ── DELETE /api/events/:eventId — purge RGPD ─────────────────────────────────

describe('DELETE /api/events/:eventId', () => {
  let eventId;
  let eventName;

  before(async () => {
    const res = await request.post('/api/events')
      .set(auth(tokenAlice))
      .send({ name: 'Événement à purger' });
    eventId = res.body.id;
    eventName = res.body.name;
  });

  it('retourne 400 si confirm incorrect', async () => {
    const res = await request.delete(`/api/events/${eventId}`)
      .set(auth(tokenAlice))
      .send({ confirm: 'mauvais nom' });
    assert.equal(res.status, 400);
  });

  it('retourne 403 pour un autre user', async () => {
    const res = await request.delete(`/api/events/${eventId}`)
      .set(auth(tokenBob))
      .send({ confirm: eventName });
    assert.equal(res.status, 403);
  });

  it('purge l\'événement avec la confirmation exacte', async () => {
    const res = await request.delete(`/api/events/${eventId}`)
      .set(auth(tokenAlice))
      .send({ confirm: eventName });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
  });

  it('l\'événement est marqué purged après suppression', async () => {
    // L'événement existe toujours en DB mais en statut purged
    const res = await request.get(`/api/events/${eventId}`).set(auth(tokenAlice));
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'purged');
  });
});

// ── GET /api/events/:eventId/sync ─────────────────────────────────────────────

describe('GET /api/events/:eventId/sync', () => {
  let eventId;

  before(async () => {
    const res = await request
      .post('/api/events')
      .set(auth(tokenAlice))
      .send({ name: 'Sync Info Event' });
    eventId = res.body.id;
  });

  it('retourne les champs attendus', async () => {
    const res = await request
      .get(`/api/events/${eventId}/sync`)
      .set(auth(tokenAlice));
    assert.equal(res.status, 200);
    assert.ok('event' in res.body);
    assert.ok('box' in res.body);
    assert.ok('jobs' in res.body);
    assert.ok('sync_log' in res.body);
    assert.equal(res.body.event.id, eventId);
    assert.equal(res.body.jobs.total, 0);
    assert.equal(res.body.jobs.done, 0);
  });

  it('retourne 403 pour un autre utilisateur', async () => {
    const res = await request
      .get(`/api/events/${eventId}/sync`)
      .set(auth(tokenBob));
    assert.equal(res.status, 403);
  });

  it('retourne 401 sans token', async () => {
    const res = await request.get(`/api/events/${eventId}/sync`);
    assert.equal(res.status, 401);
  });
});
