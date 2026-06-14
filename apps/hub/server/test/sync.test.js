import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import supertest from 'supertest';
import argon2 from 'argon2';
import { createApp } from '../src/index.js';
import {
  getDb, closeRegistry, insertUser, insertBox, getBoxByTokenHash, getEvent,
} from '../src/registry.js';
import { closeAllEventDbs } from '../src/eventStore.js';

let dir, request;
let tokenAdmin, tokenClient;
let boxToken, boxId;
let eventId;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kapsule-hub-sync-'));
  const app = createApp(dir);
  request = supertest(app);

  const db = getDb();

  // Utilisateurs
  const hashAdmin  = await argon2.hash('admin-pass', { type: argon2.argon2id });
  const hashClient = await argon2.hash('client-pass', { type: argon2.argon2id });
  insertUser(db, { email: 'admin@sync.test', password_hash: hashAdmin,  role: 'admin' });
  insertUser(db, { email: 'client@sync.test', password_hash: hashClient, role: 'client' });

  const r1 = await request.post('/api/auth/login').send({ email: 'admin@sync.test',  password: 'admin-pass' });
  const r2 = await request.post('/api/auth/login').send({ email: 'client@sync.test', password: 'client-pass' });
  tokenAdmin  = r1.body.token;
  tokenClient = r2.body.token;

  // Borne
  const raw = 'a'.repeat(64); // token clair simulé (64 chars hex)
  const hash = createHash('sha256').update(raw).digest('hex');
  const result = insertBox(db, { name: 'Borne Sync Test', token_hash: hash });
  boxId = result.lastInsertRowid;
  boxToken = raw;

  // Événement en statut 'ready', assigné à la borne
  const evRes = await request.post('/api/events')
    .set('Authorization', `Bearer ${tokenClient}`)
    .send({ name: 'Événement Sync', event_date: '2026-09-01' });
  eventId = evRes.body.id;

  // Passer en ready puis assigner la borne
  await request.put(`/api/events/${eventId}/status`)
    .set('Authorization', `Bearer ${tokenClient}`)
    .send({ status: 'ready' });
  await request.put(`/api/events/${eventId}/assign`)
    .set('Authorization', `Bearer ${tokenAdmin}`)
    .send({ box_id: boxId });
});

after(() => {
  closeAllEventDbs();
  closeRegistry();
  rmSync(dir, { recursive: true, force: true });
});

// ── requireBox — middleware ────────────────────────────────────────────────────

describe('requireBox — middleware (via GET /api/sync/assigned)', () => {
  it('retourne 401 si X-Box-Token absent', async () => {
    const res = await request.get('/api/sync/assigned');
    assert.equal(res.status, 401);
    assert.ok(res.body.error);
  });

  it('retourne 401 si token invalide', async () => {
    const res = await request.get('/api/sync/assigned')
      .set('X-Box-Token', 'token-bidon-inexistant');
    assert.equal(res.status, 401);
  });

  it('met à jour last_seen_at avec un token valide (sans log sync_log)', async () => {
    const db = getDb();
    const hash = createHash('sha256').update(boxToken).digest('hex');
    const before = getBoxByTokenHash(db, hash).last_seen_at;
    const logCountBefore = db.prepare('SELECT COUNT(*) as n FROM sync_log WHERE box_id = ? AND action = ?').get(boxId, 'heartbeat').n;

    await request.get('/api/sync/assigned').set('X-Box-Token', boxToken);

    const after = getBoxByTokenHash(db, hash).last_seen_at;
    assert.ok(after !== null, 'last_seen_at doit être défini après un appel');
    if (before !== null) assert.ok(after >= before);

    // GET /assigned ne doit pas produire de ligne sync_log (pas d'action métier à tracer)
    const logCountAfter = db.prepare('SELECT COUNT(*) as n FROM sync_log WHERE box_id = ? AND action = ?').get(boxId, 'heartbeat').n;
    assert.equal(logCountAfter, logCountBefore, 'GET /assigned ne doit pas écrire de sync_log heartbeat');
  });
});

// ── GET /api/sync/assigned ───────────────────────────────────────────────────

describe('GET /api/sync/assigned', () => {
  it('retourne les événements ready/loaded assignés à cette borne', async () => {
    const res = await request.get('/api/sync/assigned')
      .set('X-Box-Token', boxToken);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
    const found = res.body.find(e => e.id === eventId);
    assert.ok(found, 'l\'événement ready doit apparaître');
    assert.equal(found.status, 'ready');
    assert.ok('name' in found);
    assert.ok('event_date' in found);
    assert.ok('updated_at' in found);
  });

  it('ne retourne pas les événements d\'une autre borne', async () => {
    // Créer un autre événement non assigné à cette borne
    const ev2 = await request.post('/api/events')
      .set('Authorization', `Bearer ${tokenClient}`)
      .send({ name: 'Autre événement' });
    await request.put(`/api/events/${ev2.body.id}/status`)
      .set('Authorization', `Bearer ${tokenClient}`)
      .send({ status: 'ready' });
    // Pas d'assign → box_id = null → ne doit pas apparaître

    const res = await request.get('/api/sync/assigned')
      .set('X-Box-Token', boxToken);
    const found = res.body.find(e => e.id === ev2.body.id);
    assert.ok(!found, 'un événement non assigné ne doit pas apparaître');
  });
});

// ── GET /api/sync/events/:id/bundle ─────────────────────────────────────────

describe('GET /api/sync/events/:id/bundle', () => {
  it('retourne le bundle et passe ready→loaded', async () => {
    const res = await request.get(`/api/sync/events/${eventId}/bundle`)
      .set('X-Box-Token', boxToken);
    assert.equal(res.status, 200);
    assert.ok(res.body.event, 'event doit être présent');
    assert.ok(Array.isArray(res.body.questions), 'questions doit être un tableau');
    assert.ok(res.body.questions.length >= 4, '4 questions par défaut au moins');

    // Transition ready→loaded
    const db = getDb();
    const event = getEvent(db, eventId);
    assert.equal(event.status, 'loaded');
    assert.ok(event.pulled_at, 'pulled_at doit être défini');
  });

  it('retourne 200 si déjà loaded (idempotent)', async () => {
    const res = await request.get(`/api/sync/events/${eventId}/bundle`)
      .set('X-Box-Token', boxToken);
    assert.equal(res.status, 200);
    const db = getDb();
    const event = getEvent(db, eventId);
    assert.equal(event.status, 'loaded');
  });

  it('retourne 404 pour un événement inexistant', async () => {
    const res = await request.get('/api/sync/events/does-not-exist/bundle')
      .set('X-Box-Token', boxToken);
    assert.equal(res.status, 404);
  });

  it('retourne 403 si l\'événement est assigné à une autre borne', async () => {
    // Créer une borne différente et un événement assigné à elle
    const db = getDb();
    const hash2 = createHash('sha256').update('b'.repeat(64)).digest('hex');
    insertBox(db, { name: 'Autre borne', token_hash: hash2 });

    const ev3 = await request.post('/api/events')
      .set('Authorization', `Bearer ${tokenClient}`)
      .send({ name: 'Événement autre borne' });
    await request.put(`/api/events/${ev3.body.id}/status`)
      .set('Authorization', `Bearer ${tokenClient}`)
      .send({ status: 'ready' });
    const box2 = db.prepare('SELECT id FROM boxes WHERE token_hash = ?').get(hash2);
    await request.put(`/api/events/${ev3.body.id}/assign`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ box_id: box2.id });

    const res = await request.get(`/api/sync/events/${ev3.body.id}/bundle`)
      .set('X-Box-Token', boxToken); // borne 1 tente d'accéder à l'événement de borne 2
    assert.equal(res.status, 403);
  });

  it('retourne 409 si statut n\'est pas ready ou loaded', async () => {
    // Créer un événement en draft
    const evDraft = await request.post('/api/events')
      .set('Authorization', `Bearer ${tokenClient}`)
      .send({ name: 'Événement draft' });
    await request.put(`/api/events/${evDraft.body.id}/assign`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ box_id: boxId });

    const res = await request.get(`/api/sync/events/${evDraft.body.id}/bundle`)
      .set('X-Box-Token', boxToken);
    assert.equal(res.status, 409);
  });
});

// ── POST /api/sync/events/:id/status ────────────────────────────────────────

describe('POST /api/sync/events/:id/status (heartbeat)', () => {
  it('passe loaded→live', async () => {
    const res = await request.post(`/api/sync/events/${eventId}/status`)
      .set('X-Box-Token', boxToken)
      .send({ status: 'live' });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'live');

    const db = getDb();
    const event = getEvent(db, eventId);
    assert.equal(event.status, 'live');
  });

  it('passe live→closed', async () => {
    const res = await request.post(`/api/sync/events/${eventId}/status`)
      .set('X-Box-Token', boxToken)
      .send({ status: 'closed' });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'closed');
  });

  it('refuse un retour en arrière (closed→live)', async () => {
    const res = await request.post(`/api/sync/events/${eventId}/status`)
      .set('X-Box-Token', boxToken)
      .send({ status: 'live' });
    assert.equal(res.status, 409);
  });

  it('retourne 400 pour un statut invalide', async () => {
    const res = await request.post(`/api/sync/events/${eventId}/status`)
      .set('X-Box-Token', boxToken)
      .send({ status: 'draft' });
    assert.equal(res.status, 400);
  });

  it('retourne 400 pour un statut hors heartbeat (pushed)', async () => {
    const res = await request.post(`/api/sync/events/${eventId}/status`)
      .set('X-Box-Token', boxToken)
      .send({ status: 'pushed' });
    assert.equal(res.status, 400);
  });

  it('retourne 404 pour un événement inexistant', async () => {
    const res = await request.post('/api/sync/events/inexistant/status')
      .set('X-Box-Token', boxToken)
      .send({ status: 'live' });
    assert.equal(res.status, 404);
  });

  it('retourne 403 si événement assigné à une autre borne', async () => {
    // Réutiliser l'événement de "autre borne" créé plus haut (il est en ready)
    // On ne peut pas récupérer son id facilement, donc on crée un nouveau
    const db = getDb();
    const hash3 = createHash('sha256').update('c'.repeat(64)).digest('hex');
    insertBox(db, { name: 'Borne C', token_hash: hash3 });
    const box3 = db.prepare('SELECT id FROM boxes WHERE token_hash = ?').get(hash3);

    const ev4 = await request.post('/api/events')
      .set('Authorization', `Bearer ${tokenClient}`)
      .send({ name: 'Événement borne C' });
    await request.put(`/api/events/${ev4.body.id}/status`)
      .set('Authorization', `Bearer ${tokenClient}`)
      .send({ status: 'ready' });
    await request.put(`/api/events/${ev4.body.id}/assign`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ box_id: box3.id });

    const res = await request.post(`/api/sync/events/${ev4.body.id}/status`)
      .set('X-Box-Token', boxToken)
      .send({ status: 'live' });
    assert.equal(res.status, 403);
  });

  it('insère une entrée sync_log action=status pour le heartbeat', async () => {
    // Créer un événement dans un état permettant la transition
    const ev5 = await request.post('/api/events')
      .set('Authorization', `Bearer ${tokenClient}`)
      .send({ name: 'Événement log test' });
    await request.put(`/api/events/${ev5.body.id}/status`)
      .set('Authorization', `Bearer ${tokenClient}`)
      .send({ status: 'ready' });
    await request.put(`/api/events/${ev5.body.id}/assign`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ box_id: boxId });
    // Pull pour passer en loaded
    await request.get(`/api/sync/events/${ev5.body.id}/bundle`)
      .set('X-Box-Token', boxToken);

    const db = getDb();
    const countBefore = db.prepare('SELECT COUNT(*) as n FROM sync_log WHERE event_id = ?').get(ev5.body.id).n;

    await request.post(`/api/sync/events/${ev5.body.id}/status`)
      .set('X-Box-Token', boxToken)
      .send({ status: 'live' });

    const rows = db.prepare('SELECT * FROM sync_log WHERE event_id = ? ORDER BY id DESC').all(ev5.body.id);
    assert.ok(rows.length > countBefore, 'une ligne sync_log doit être insérée');
    assert.equal(rows[0].action, 'status', 'l\'action doit être "status", pas "heartbeat"');
  });
});
