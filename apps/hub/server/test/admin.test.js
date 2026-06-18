import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import supertest from 'supertest';
import argon2 from 'argon2';
import { createApp } from '../src/index.js';
import { getDb, closeRegistry, insertUser, getUserByEmail, getBoxTokenByHash, insertEvent, upsertEventUser } from '../src/registry.js';
import { createHash } from 'node:crypto';

let dir, request, tokenAdmin, tokenClient;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kapsule-hub-admin-'));
  const app = createApp(dir);
  request = supertest(app);

  const db = getDb();
  const hashAdmin  = await argon2.hash('admin-pass', { type: argon2.argon2id });
  const hashClient = await argon2.hash('client-pass', { type: argon2.argon2id });
  insertUser(db, { email: 'admin@test.com',  password_hash: hashAdmin,  role: 'superuser' });
  insertUser(db, { email: 'client@test.com', password_hash: hashClient, role: 'client' });

  const r1 = await request.post('/api/auth/login').send({ email: 'admin@test.com',  password: 'admin-pass' });
  const r2 = await request.post('/api/auth/login').send({ email: 'client@test.com', password: 'client-pass' });
  tokenAdmin  = r1.body.token;
  tokenClient = r2.body.token;
});

after(() => {
  closeRegistry();
  rmSync(dir, { recursive: true, force: true });
});

// ── POST /api/admin/users ─────────────────────────────────────────────────────

describe('POST /api/admin/users', () => {
  it('crée un compte client sans mdp et retourne registration_url (201)', async () => {
    const res = await request.post('/api/admin/users')
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ email: 'newclient@test.com', name: 'Client Test' });
    assert.equal(res.status, 201);
    assert.equal(res.body.user.email, 'newclient@test.com');
    assert.equal(res.body.user.has_password, false);
    assert.ok(res.body.registration_url?.includes('/register?token='));
    assert.ok(!('password_hash' in res.body.user));
  });

  it('retourne 409 si email déjà utilisé', async () => {
    const res = await request.post('/api/admin/users')
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ email: 'newclient@test.com' });
    assert.equal(res.status, 409);
  });

  it('retourne 400 si email manquant', async () => {
    const res = await request.post('/api/admin/users')
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ name: 'Sans Email' });
    assert.equal(res.status, 400);
  });

  it('retourne 403 pour un client', async () => {
    const res = await request.post('/api/admin/users')
      .set('Authorization', `Bearer ${tokenClient}`)
      .send({ email: 'other@test.com' });
    assert.equal(res.status, 403);
  });
});

// ── GET /api/admin/users ──────────────────────────────────────────────────────

describe('GET /api/admin/users', () => {
  it('retourne la liste avec has_password (admin)', async () => {
    const res = await request.get('/api/admin/users')
      .set('Authorization', `Bearer ${tokenAdmin}`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
    assert.ok(res.body.length >= 1);
    assert.ok('has_password' in res.body[0]);
    assert.ok(!('password_hash' in res.body[0]));
  });

  it('retourne 403 pour un client', async () => {
    const res = await request.get('/api/admin/users')
      .set('Authorization', `Bearer ${tokenClient}`);
    assert.equal(res.status, 403);
  });
});

// ── PUT /api/admin/users/:id ──────────────────────────────────────────────────

describe('PUT /api/admin/users/:id', () => {
  let targetId;

  before(() => {
    const db = getDb();
    targetId = getUserByEmail(db, 'newclient@test.com').id;
  });

  it('désactive le compte (active=0)', async () => {
    const res = await request.put(`/api/admin/users/${targetId}`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ active: false });
    assert.equal(res.status, 200);
    assert.equal(res.body.active, 0);
  });

  it('réactive le compte (active=1)', async () => {
    const res = await request.put(`/api/admin/users/${targetId}`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ active: true, name: 'Client Renommé' });
    assert.equal(res.status, 200);
    assert.equal(res.body.active, 1);
    assert.equal(res.body.name, 'Client Renommé');
  });

  it('retourne 404 pour un id inconnu', async () => {
    const res = await request.put('/api/admin/users/99999')
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ active: false });
    assert.equal(res.status, 404);
  });
});

// ── POST /api/admin/users/:id/registration-link ───────────────────────────────

describe('POST /api/admin/users/:id/registration-link', () => {
  let targetId;

  before(() => {
    const db = getDb();
    targetId = getUserByEmail(db, 'newclient@test.com').id;
  });

  it("génère un nouveau lien d'enregistrement", async () => {
    const res = await request.post(`/api/admin/users/${targetId}/registration-link`)
      .set('Authorization', `Bearer ${tokenAdmin}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.registration_url?.includes('/register?token='));
  });

  it('retourne 404 pour un id inconnu', async () => {
    const res = await request.post('/api/admin/users/99999/registration-link')
      .set('Authorization', `Bearer ${tokenAdmin}`);
    assert.equal(res.status, 404);
  });
});

// ── POST /api/admin/events/:id/tokens ────────────────────────────────────────

describe('POST /api/admin/events/:id/tokens', () => {
  let eventId;

  before(async () => {
    const evRes = await request.post('/api/events')
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ name: 'Événement Token Test' });
    eventId = evRes.body.id;
  });

  it('génère un token et le retourne en clair (201)', async () => {
    const res = await request.post(`/api/admin/events/${eventId}/tokens`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ label: 'Borne Salon', location: 'Entrée', is_preview: false });
    assert.equal(res.status, 201);
    assert.ok(res.body.id);
    assert.equal(res.body.event_id, eventId);
    assert.ok(res.body.token_clear, 'token_clear doit être présent');
    assert.equal(res.body.token_clear.length, 64, '32 octets hex = 64 chars');
    assert.equal(res.body.label, 'Borne Salon');

    // Le hash du token retourné doit correspondre à ce qui est stocké
    const db = getDb();
    const hash = createHash('sha256').update(res.body.token_clear).digest('hex');
    const row = getBoxTokenByHash(db, hash);
    assert.ok(row, 'le token doit exister en base');
    assert.equal(row.event_id, eventId);
  });

  it('retourne 404 pour un event inexistant', async () => {
    const res = await request.post('/api/admin/events/no-such-event/tokens')
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({});
    assert.equal(res.status, 404);
  });

  it('retourne 403 pour un client', async () => {
    const res = await request.post(`/api/admin/events/${eventId}/tokens`)
      .set('Authorization', `Bearer ${tokenClient}`)
      .send({ label: 'Test' });
    assert.equal(res.status, 403);
  });

  it('retourne 401 sans token', async () => {
    const res = await request.post(`/api/admin/events/${eventId}/tokens`).send({});
    assert.equal(res.status, 401);
  });
});

// ── GET /api/admin/events/:id/tokens ─────────────────────────────────────────

describe('GET /api/admin/events/:id/tokens', () => {
  let eventId;

  before(async () => {
    const evRes = await request.post('/api/events')
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ name: 'Événement Tokens List' });
    eventId = evRes.body.id;
    await request.post(`/api/admin/events/${eventId}/tokens`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ label: 'T1' });
    await request.post(`/api/admin/events/${eventId}/tokens`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ label: 'T2', is_preview: true });
  });

  it('liste les tokens avec hub_config_hash (admin)', async () => {
    const res = await request.get(`/api/admin/events/${eventId}/tokens`)
      .set('Authorization', `Bearer ${tokenAdmin}`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.tokens));
    assert.equal(res.body.tokens.length, 2);
    assert.ok(!('token_hash' in res.body.tokens[0]), 'token_hash ne doit pas être exposé');
    assert.ok('label' in res.body.tokens[0]);
    assert.ok('hub_config_hash' in res.body);
  });

  it('retourne 403 pour un client', async () => {
    const res = await request.get(`/api/admin/events/${eventId}/tokens`)
      .set('Authorization', `Bearer ${tokenClient}`);
    assert.equal(res.status, 403);
  });
});

// ── DELETE /api/admin/tokens/:tokenId ────────────────────────────────────────

describe('DELETE /api/admin/tokens/:tokenId', () => {
  let tokenId;

  before(async () => {
    const evRes = await request.post('/api/events')
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ name: 'Événement Delete Token' });
    const evId = evRes.body.id;
    const res = await request.post(`/api/admin/events/${evId}/tokens`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ label: 'À supprimer' });
    tokenId = res.body.id;
  });

  it('révoque un token (204)', async () => {
    const res = await request.delete(`/api/admin/tokens/${tokenId}`)
      .set('Authorization', `Bearer ${tokenAdmin}`);
    assert.equal(res.status, 204);
  });

  it('retourne 404 pour un token inexistant', async () => {
    const res = await request.delete('/api/admin/tokens/99999')
      .set('Authorization', `Bearer ${tokenAdmin}`);
    assert.equal(res.status, 404);
  });

  it('retourne 403 pour un client', async () => {
    const res = await request.delete('/api/admin/tokens/1')
      .set('Authorization', `Bearer ${tokenClient}`);
    assert.equal(res.status, 403);
  });
});

// ── PUT /api/admin/tokens/:tokenId ───────────────────────────────────────────

describe('PUT /api/admin/tokens/:tokenId', () => {
  let tokenId;

  before(async () => {
    const evRes = await request.post('/api/events')
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ name: 'Événement Update Token' });
    const evId = evRes.body.id;
    const res = await request.post(`/api/admin/events/${evId}/tokens`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ label: 'Borne Originale' });
    tokenId = res.body.id;
  });

  it('met à jour label et location (200)', async () => {
    const res = await request.put(`/api/admin/tokens/${tokenId}`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ label: 'Borne Renommée', location: 'Salle B' });
    assert.equal(res.status, 200);
    assert.equal(res.body.label, 'Borne Renommée');
    assert.equal(res.body.location, 'Salle B');
    assert.ok(!('token_hash' in res.body), 'token_hash ne doit pas fuiter');
  });

  it('retourne 404 pour un token inexistant', async () => {
    const res = await request.put('/api/admin/tokens/99999')
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ label: 'Test' });
    assert.equal(res.status, 404);
  });

  it('retourne 403 pour un client', async () => {
    const res = await request.put(`/api/admin/tokens/${tokenId}`)
      .set('Authorization', `Bearer ${tokenClient}`)
      .send({ label: 'Test' });
    assert.equal(res.status, 403);
  });
});

// ── requireBox (via boxAuth.js) ───────────────────────────────────────────────

describe('boxAuth — middleware', () => {
  let boxToken, eventIdBox;

  before(async () => {
    const evRes = await request.post('/api/events')
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ name: 'Événement boxAuth Test' });
    eventIdBox = evRes.body.id;

    // Passer l'event en ready pour que GET /api/sync/event retourne 200
    await request.put(`/api/events/${eventIdBox}/status`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ status: 'ready' });

    const tokenRes = await request.post(`/api/admin/events/${eventIdBox}/tokens`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ label: 'Borne boxAuth test' });
    boxToken = tokenRes.body.token_clear;
  });

  it('token valide → GET /api/sync/event retourne 200', async () => {
    const res = await request.get('/api/sync/event')
      .set('X-Box-Token', boxToken);
    assert.equal(res.status, 200);
    assert.equal(res.body.id, eventIdBox);
  });

  it('token invalide → 401', async () => {
    const res = await request.get('/api/sync/event')
      .set('X-Box-Token', 'not-a-valid-token');
    assert.equal(res.status, 401);
  });

  it('absent → 401', async () => {
    const res = await request.get('/api/sync/event');
    assert.equal(res.status, 401);
  });

  it('sha256 du token retourné correspond au hash en base', async () => {
    const db = getDb();
    const hash = createHash('sha256').update(boxToken).digest('hex');
    const row = getBoxTokenByHash(db, hash);
    assert.ok(row);
    assert.equal(row.event_id, eventIdBox);
  });
});

// ── GET /api/admin/overview ───────────────────────────────────────────────────

describe('GET /api/admin/overview', () => {
  it('retourne 401 sans token', async () => {
    const res = await request.get('/api/admin/overview');
    assert.equal(res.status, 401);
  });

  it('retourne 403 pour un client', async () => {
    const res = await request.get('/api/admin/overview')
      .set('Authorization', `Bearer ${tokenClient}`);
    assert.equal(res.status, 403);
  });

  it('retourne 200 avec events, disk, failed_jobs, boxes (admin)', async () => {
    const db = getDb();

    // Ajoute un job failed pour vérifier le champ
    db.prepare(`
      INSERT INTO jobs (event_id, type, status, error, finished_at)
      VALUES ('ev-overview', 'probe', 'failed', 'test error', CURRENT_TIMESTAMP)
    `).run();

    const res = await request.get('/api/admin/overview')
      .set('Authorization', `Bearer ${tokenAdmin}`);

    assert.equal(res.status, 200);

    assert.ok(Array.isArray(res.body.events), 'events doit être un tableau');
    assert.ok(typeof res.body.disk?.free_bytes === 'number', 'disk.free_bytes doit être un nombre');
    assert.ok(typeof res.body.disk?.total_bytes === 'number', 'disk.total_bytes doit être un nombre');
    assert.ok(Array.isArray(res.body.failed_jobs), 'failed_jobs doit être un tableau');
    assert.ok(Array.isArray(res.body.boxes), 'boxes doit être un tableau');

    // Le job failed apparaît
    const failed = res.body.failed_jobs.find((j) => j.error === 'test error');
    assert.ok(failed, 'le job failed doit apparaître dans overview');
    assert.equal(failed.type, 'probe');

    // Les box_tokens ont last_seen_at (créés dans les tests précédents)
    assert.ok(res.body.boxes.length >= 1, 'au moins un token borne en base');
    assert.ok('last_seen_at' in res.body.boxes[0]);

    // Les events ont disk_bytes
    for (const ev of res.body.events) {
      assert.ok(typeof ev.disk_bytes === 'number', 'disk_bytes doit être un nombre');
      assert.ok(!('token_hash' in ev), 'token_hash ne doit pas fuiter');
    }
  });
});

// ── GET /api/admin/tokens ─────────────────────────────────────────────────────

describe('GET /api/admin/tokens', () => {
  it('retourne 401 sans token', async () => {
    const res = await request.get('/api/admin/tokens');
    assert.equal(res.status, 401);
  });

  it('retourne 403 pour un client', async () => {
    const res = await request.get('/api/admin/tokens')
      .set('Authorization', `Bearer ${tokenClient}`);
    assert.equal(res.status, 403);
  });

  it('retourne 200 avec la liste globale incluant event_name et token_clear (admin)', async () => {
    const res = await request.get('/api/admin/tokens')
      .set('Authorization', `Bearer ${tokenAdmin}`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body), 'doit être un tableau');
    assert.ok(res.body.length >= 1, 'au moins un token (créé dans les tests précédents)');
    const t = res.body[0];
    assert.ok('token_clear' in t, 'token_clear doit être présent');
    assert.ok('event_name' in t, 'event_name jointé doit être présent');
    assert.ok(!('token_hash' in t), 'token_hash ne doit pas fuiter');
  });
});

// ── GET/POST/DELETE /api/admin/events/:id/users ───────────────────────────────

describe('event_users — gestion des utilisateurs par événement', () => {
  let eventId;
  let clientUserId;

  before(async () => {
    const db = getDb();
    // Crée un événement de test
    const { v4: uuidv4 } = await import('uuid');
    eventId = uuidv4();
    insertEvent(db, { id: eventId, name: 'Événement users test' });
    clientUserId = getUserByEmail(db, 'client@test.com').id;
  });

  it('GET retourne la liste vide (200)', async () => {
    const res = await request.get(`/api/admin/events/${eventId}/users`)
      .set('Authorization', `Bearer ${tokenAdmin}`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
    assert.equal(res.body.length, 0);
  });

  it('POST assigne un user avec rôles (201)', async () => {
    const res = await request.post(`/api/admin/events/${eventId}/users`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ user_id: clientUserId, roles: ['admin_borne'] });
    assert.equal(res.status, 201);
    assert.deepEqual(res.body.roles, ['admin_borne']);
  });

  it('GET retourne le user assigné avec ses rôles', async () => {
    const res = await request.get(`/api/admin/events/${eventId}/users`)
      .set('Authorization', `Bearer ${tokenAdmin}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 1);
    assert.equal(res.body[0].user_id, clientUserId);
    assert.deepEqual(res.body[0].roles, ['admin_borne']);
  });

  it('POST retourne 400 si roles invalide', async () => {
    const res = await request.post(`/api/admin/events/${eventId}/users`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ user_id: clientUserId, roles: ['role_inexistant'] });
    assert.equal(res.status, 400);
  });

  it('DELETE retire le user (204)', async () => {
    const res = await request.delete(`/api/admin/events/${eventId}/users/${clientUserId}`)
      .set('Authorization', `Bearer ${tokenAdmin}`);
    assert.equal(res.status, 204);
    const check = await request.get(`/api/admin/events/${eventId}/users`)
      .set('Authorization', `Bearer ${tokenAdmin}`);
    assert.equal(check.body.length, 0);
  });

  it('retourne 403 pour un client', async () => {
    const res = await request.get(`/api/admin/events/${eventId}/users`)
      .set('Authorization', `Bearer ${tokenClient}`);
    assert.equal(res.status, 403);
  });
});
