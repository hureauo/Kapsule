import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import supertest from 'supertest';
import argon2 from 'argon2';
import { createApp } from '../src/index.js';
import { getDb, closeRegistry, insertUser, updateEvent } from '../src/registry.js';
import { closeAllEventDbs } from '../src/eventStore.js';

let dir;
let request;
let token;
let tokenBob;
let eventId;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kapsule-hub-q-'));
  const app = createApp(dir);
  request = supertest(app);

  const db = getDb();
  const hashA = await argon2.hash('pass-a', { type: argon2.argon2id });
  const hashB = await argon2.hash('pass-b', { type: argon2.argon2id });
  insertUser(db, { email: 'alice@q.test', password_hash: hashA, role: 'client' });
  insertUser(db, { email: 'bob@q.test',   password_hash: hashB, role: 'client' });

  const loginA = await request.post('/api/auth/login').send({ email: 'alice@q.test', password: 'pass-a' });
  const loginB = await request.post('/api/auth/login').send({ email: 'bob@q.test',   password: 'pass-b' });
  token    = loginA.body.token;
  tokenBob = loginB.body.token;

  // Créer un événement pour Alice
  const ev = await request.post('/api/events').set('Authorization', `Bearer ${token}`)
    .send({ name: 'Événement questions' });
  eventId = ev.body.id;
});

after(() => {
  closeAllEventDbs();
  closeRegistry();
  rmSync(dir, { recursive: true, force: true });
});

const auth = (t) => ({ Authorization: `Bearer ${t}` });
const base = () => `/api/events/${eventId}/questions`;

// ── GET /api/events/:eventId/questions ────────────────────────────────────────

describe('GET /api/events/:eventId/questions', () => {
  it('retourne 200 et les questions (seedées par défaut)', async () => {
    const res = await request.get(base()).set(auth(token));
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
    assert.ok(res.body.length >= 4); // 4 questions seedées par createEventDb
  });

  it('retourne 401 sans token', async () => {
    const res = await request.get(base());
    assert.equal(res.status, 401);
  });

  it('retourne 403 pour un autre user', async () => {
    const res = await request.get(base()).set(auth(tokenBob));
    assert.equal(res.status, 403);
  });
});

// ── POST /api/events/:eventId/questions ───────────────────────────────────────

describe('POST /api/events/:eventId/questions', () => {
  it('crée une question et retourne 201', async () => {
    const res = await request.post(base()).set(auth(token))
      .send({ text: 'Quelle est votre question préférée ?', max_duration: 60, countdown: 3 });
    assert.equal(res.status, 201);
    assert.equal(res.body.text, 'Quelle est votre question préférée ?');
  });

  it('retourne 400 pour un texte vide', async () => {
    const res = await request.post(base()).set(auth(token))
      .send({ text: '' });
    assert.equal(res.status, 400);
  });

  it('retourne 400 pour max_duration hors plage', async () => {
    const res = await request.post(base()).set(auth(token))
      .send({ text: 'Q valide ?', max_duration: 5 });
    assert.equal(res.status, 400);
  });

  it('retourne 403 pour un autre user', async () => {
    const res = await request.post(base()).set(auth(tokenBob))
      .send({ text: 'Q de Bob ?' });
    assert.equal(res.status, 403);
  });

  it('retourne 409 si l\'événement est gelé (statut live)', async () => {
    updateEvent(getDb(), eventId, { status: 'live' });
    const res = await request.post(base()).set(auth(token))
      .send({ text: 'Q gelée ?' });
    updateEvent(getDb(), eventId, { status: 'draft' });
    assert.equal(res.status, 409);
  });
});

// ── PUT /api/events/:eventId/questions/:id ────────────────────────────────────

describe('PUT /api/events/:eventId/questions/:id', () => {
  let qId;

  before(async () => {
    const res = await request.post(base()).set(auth(token))
      .send({ text: 'Question à éditer' });
    qId = res.body.id;
  });

  it('met à jour le texte', async () => {
    const res = await request.put(`${base()}/${qId}`).set(auth(token))
      .send({ text: 'Texte modifié' });
    assert.equal(res.status, 200);
    assert.equal(res.body.text, 'Texte modifié');
  });

  it('retourne 404 pour un id inconnu', async () => {
    const res = await request.put(`${base()}/9999`).set(auth(token))
      .send({ text: 'Inconnu' });
    assert.equal(res.status, 404);
  });

  it('retourne 400 si aucun champ fourni', async () => {
    const res = await request.put(`${base()}/${qId}`).set(auth(token)).send({});
    assert.equal(res.status, 400);
  });

  it('retourne 409 si l\'événement est gelé', async () => {
    updateEvent(getDb(), eventId, { status: 'closed' });
    const res = await request.put(`${base()}/${qId}`).set(auth(token))
      .send({ text: 'Bloqué ?' });
    updateEvent(getDb(), eventId, { status: 'draft' });
    assert.equal(res.status, 409);
  });
});

// ── PUT /api/events/:eventId/questions/reorder/batch ─────────────────────────

describe('PUT /api/events/:eventId/questions/reorder/batch', () => {
  it('reordonne les questions', async () => {
    const listRes = await request.get(base()).set(auth(token));
    const ids = listRes.body.map((q) => q.id);
    const order = ids.map((id, i) => ({ id, order_index: ids.length - 1 - i }));

    const res = await request.put(`${base()}/reorder/batch`).set(auth(token))
      .send({ order });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
  });

  it('retourne 400 si order est vide', async () => {
    const res = await request.put(`${base()}/reorder/batch`).set(auth(token))
      .send({ order: [] });
    assert.equal(res.status, 400);
  });

  it('retourne 409 si l\'événement est gelé', async () => {
    updateEvent(getDb(), eventId, { status: 'pushed' });
    const res = await request.put(`${base()}/reorder/batch`).set(auth(token))
      .send({ order: [{ id: 1, order_index: 0 }] });
    updateEvent(getDb(), eventId, { status: 'draft' });
    assert.equal(res.status, 409);
  });
});

// ── DELETE /api/events/:eventId/questions/:id ─────────────────────────────────

describe('DELETE /api/events/:eventId/questions/:id', () => {
  let qId;

  before(async () => {
    const res = await request.post(base()).set(auth(token))
      .send({ text: 'Question à supprimer' });
    qId = res.body.id;
  });

  it('supprime la question (204)', async () => {
    const res = await request.delete(`${base()}/${qId}`).set(auth(token));
    assert.equal(res.status, 204);
  });

  it('retourne 404 pour un id déjà supprimé', async () => {
    const res = await request.delete(`${base()}/${qId}`).set(auth(token));
    assert.equal(res.status, 404);
  });

  it('retourne 409 si l\'événement est gelé', async () => {
    // Créer une question, geler, tenter la suppression
    const createRes = await request.post(base()).set(auth(token))
      .send({ text: 'Q gelée delete ?' });
    const frozenId = createRes.body.id;
    updateEvent(getDb(), eventId, { status: 'live' });
    const res = await request.delete(`${base()}/${frozenId}`).set(auth(token));
    updateEvent(getDb(), eventId, { status: 'draft' });
    assert.equal(res.status, 409);
  });
});
