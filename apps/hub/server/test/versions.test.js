import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import argon2 from 'argon2';
import supertest from 'supertest';
import { createApp } from '../src/index.js';
import { getDb, closeRegistry, insertUser } from '../src/registry.js';
import { closeAllEventDbs } from '../src/eventStore.js';

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('event versions', () => {
  let dataDir, app, token, eventId;

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'kapsule-versions-'));
    app = createApp(dataDir);

    const db = getDb();
    const hash = await argon2.hash('password123', { type: argon2.argon2id });
    insertUser(db, { email: 'admin@test.com', password_hash: hash, role: 'superuser' });

    const login = await supertest(app)
      .post('/api/auth/login')
      .send({ email: 'admin@test.com', password: 'password123' });
    token = login.body.token;

    // Créer un événement
    const r = await supertest(app)
      .post('/api/events')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Test Versions', event_date: '2026-09-01' });
    assert.equal(r.status, 201);
    eventId = r.body.id;
  });

  after(() => {
    closeAllEventDbs();
    closeRegistry();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('GET /versions retourne liste vide au départ', async () => {
    const r = await supertest(app)
      .get(`/api/events/${eventId}/versions`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, []);
  });

  it('PUT /events/:id (meta) crée une version', async () => {
    const r = await supertest(app)
      .put(`/api/events/${eventId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ theme: 'dark' });
    assert.equal(r.status, 200);

    const versions = await supertest(app)
      .get(`/api/events/${eventId}/versions`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(versions.body.length, 1);
    assert.match(versions.body[0].summary, /Version initiale|Thème/);
    assert.equal(versions.body[0].author, 'admin@test.com');
  });

  it('POST /questions crée une version', async () => {
    const before = await supertest(app)
      .get(`/api/events/${eventId}/versions`)
      .set('Authorization', `Bearer ${token}`);
    const countBefore = before.body.length;

    await supertest(app)
      .post(`/api/events/${eventId}/questions`)
      .set('Authorization', `Bearer ${token}`)
      .send({ text: 'Question de test ?' });

    const after = await supertest(app)
      .get(`/api/events/${eventId}/versions`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(after.body.length, countBefore + 1);
  });

  it('GET /versions/:id retourne snapshot + diff', async () => {
    const list = await supertest(app)
      .get(`/api/events/${eventId}/versions`)
      .set('Authorization', `Bearer ${token}`);
    const lastId = list.body[0].id;

    const r = await supertest(app)
      .get(`/api/events/${eventId}/versions/${lastId}`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(r.status, 200);
    assert.ok(r.body.snapshot);
    assert.ok(Array.isArray(r.body.snapshot.questions));
    assert.ok(Array.isArray(r.body.diff));
  });

  it('deux modifications identiques ne créent pas de doublon', async () => {
    // Envoyer le même thème deux fois
    await supertest(app)
      .put(`/api/events/${eventId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ theme: 'dark' });

    const list1 = await supertest(app)
      .get(`/api/events/${eventId}/versions`)
      .set('Authorization', `Bearer ${token}`);
    const count1 = list1.body.length;

    await supertest(app)
      .put(`/api/events/${eventId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ theme: 'dark' }); // identique

    const list2 = await supertest(app)
      .get(`/api/events/${eventId}/versions`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(list2.body.length, count1); // pas de version supplémentaire
  });

  it('POST /versions/:id/restore restaure le snapshot et crée une version', async () => {
    // Récupérer la première version (la plus ancienne = thème dark sans questions)
    const list = await supertest(app)
      .get(`/api/events/${eventId}/versions`)
      .set('Authorization', `Bearer ${token}`);
    const firstVersion = list.body[list.body.length - 1];

    const r = await supertest(app)
      .post(`/api/events/${eventId}/versions/${firstVersion.id}/restore`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(r.status, 200);

    // Une nouvelle version "Restauration" doit apparaître
    const list2 = await supertest(app)
      .get(`/api/events/${eventId}/versions`)
      .set('Authorization', `Bearer ${token}`);
    assert.match(list2.body[0].summary, /Restauration/);
  });

  it('GET /versions/:id inexistant → 404', async () => {
    const r = await supertest(app)
      .get(`/api/events/${eventId}/versions/99999`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(r.status, 404);
  });
});
