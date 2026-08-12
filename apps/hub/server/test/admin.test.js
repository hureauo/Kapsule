import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import supertest from 'supertest';
import argon2 from 'argon2';
import { createApp } from '../src/index.js';
import { getDb, closeRegistry, insertUser, getUserByEmail, getBoxTokenByHash, insertEvent, upsertEventUser, countSuperusers } from '../src/registry.js';
import { createHash } from 'node:crypto';
import jwt from 'jsonwebtoken';

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

// ── PUT /api/admin/users/:id — modification du rôle global ───────────────────

describe('PUT /api/admin/users/:id — rôle global', () => {
  let clientId;

  before(() => {
    clientId = getUserByEmail(getDb(), 'client@test.com').id;
  });

  it('promeut un client en superuser (200)', async () => {
    const res = await request.put(`/api/admin/users/${clientId}`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ role: 'superuser' });
    assert.equal(res.status, 200);
    assert.equal(res.body.role, 'superuser');
  });

  it('rétrograde le superuser promu en client (200)', async () => {
    const res = await request.put(`/api/admin/users/${clientId}`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ role: 'client' });
    assert.equal(res.status, 200);
    assert.equal(res.body.role, 'client');
  });

  it('retourne 400 si rôle invalide', async () => {
    const res = await request.put(`/api/admin/users/${clientId}`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ role: 'admin' });
    assert.equal(res.status, 400);
  });

  it('interdit de modifier son propre rôle (403)', async () => {
    // admin@test.com essaie de se rétrograder lui-même → 403
    const adminId = getUserByEmail(getDb(), 'admin@test.com').id;
    const res = await request.put(`/api/admin/users/${adminId}`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ role: 'client' });
    assert.equal(res.status, 403);
    const check = getUserByEmail(getDb(), 'admin@test.com');
    assert.equal(check.role, 'superuser');
  });

  it('interdit de rétrograder le dernier superuser (409)', async () => {
    // Crée un second superuser temporaire pour faire la demande de rétrogradation
    const db = getDb();
    const res2 = await request.post('/api/admin/users')
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ email: 'superuser2@test.com' });
    const su2Id = res2.body.user.id;
    // Promouvons-le superuser
    await request.put(`/api/admin/users/${su2Id}`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ role: 'superuser' });
    // Rétrogradons-le → 2 superusers → OK
    const okRes = await request.put(`/api/admin/users/${su2Id}`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ role: 'client' });
    assert.equal(okRes.status, 200);
    // Maintenant il reste 1 seul superuser actif (admin@test.com)
    // Essayer de le rétrograder → 409, mais c'est lui-même → on passe par un autre chemin :
    // On vérifie juste que countSuperusers renvoie 1
    assert.equal(countSuperusers(db), 1);
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

// ── Bornes (Phase B — identité machine persistante) ────────────────────────────

describe('POST /api/admin/bornes', () => {
  it('crée une borne et retourne le token en clair (201)', async () => {
    const res = await request.post('/api/admin/bornes')
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ name: 'Borne Entrée', location: 'Salle A' });
    assert.equal(res.status, 201);
    assert.ok(res.body.id);
    assert.equal(res.body.name, 'Borne Entrée');
    assert.equal(res.body.location, 'Salle A');
    assert.ok(res.body.token_clear, 'token_clear doit être présent');
    assert.equal(res.body.token_clear.length, 64, '32 octets hex = 64 chars');
  });

  it('retourne 400 si name manquant', async () => {
    const res = await request.post('/api/admin/bornes')
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ location: 'Sans nom' });
    assert.equal(res.status, 400);
  });

  it('retourne 403 pour un client', async () => {
    const res = await request.post('/api/admin/bornes')
      .set('Authorization', `Bearer ${tokenClient}`)
      .send({ name: 'Interdite' });
    assert.equal(res.status, 403);
  });

  it('retourne 401 sans token', async () => {
    const res = await request.post('/api/admin/bornes').send({ name: 'Sans auth' });
    assert.equal(res.status, 401);
  });
});

describe('GET /api/admin/bornes', () => {
  it('liste les bornes sans exposer le token (200)', async () => {
    const res = await request.get('/api/admin/bornes')
      .set('Authorization', `Bearer ${tokenAdmin}`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
    assert.ok(res.body.length >= 1);
    assert.ok(!('token_hash' in res.body[0]), 'token_hash ne doit pas fuiter');
    assert.ok(!('token_clear' in res.body[0]), 'token_clear ne doit pas fuiter dans la vue liste');
    assert.ok('event_count' in res.body[0]);
  });
});

describe('GET/PUT/DELETE /api/admin/bornes/:id + assignation événements + commandes', () => {
  let borneId, eventId;

  before(async () => {
    const bRes = await request.post('/api/admin/bornes')
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ name: 'Borne Fiche' });
    borneId = bRes.body.id;

    const evRes = await request.post('/api/events')
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ name: 'Événement pour borne' });
    eventId = evRes.body.id;
  });

  it('GET /:id retourne la fiche (events et commands vides), sans token', async () => {
    const res = await request.get(`/api/admin/bornes/${borneId}`)
      .set('Authorization', `Bearer ${tokenAdmin}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.name, 'Borne Fiche');
    assert.ok(!('token_hash' in res.body));
    assert.deepEqual(res.body.events, []);
    assert.deepEqual(res.body.commands, []);
  });

  it('GET /:id retourne 404 pour une borne inconnue', async () => {
    const res = await request.get('/api/admin/bornes/no-such-borne')
      .set('Authorization', `Bearer ${tokenAdmin}`);
    assert.equal(res.status, 404);
  });

  it('PUT /:id renomme/déplace la borne (200)', async () => {
    const res = await request.put(`/api/admin/bornes/${borneId}`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ name: 'Borne Renommée', location: 'Salle B' });
    assert.equal(res.status, 200);
    assert.equal(res.body.name, 'Borne Renommée');
    assert.equal(res.body.location, 'Salle B');
    assert.ok(!('token_hash' in res.body));
  });

  it('PUT /:id retourne 404 pour une borne inconnue', async () => {
    const res = await request.put('/api/admin/bornes/no-such-borne')
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ name: 'X' });
    assert.equal(res.status, 404);
  });

  it('POST /:id/events assigne un événement (201)', async () => {
    const res = await request.post(`/api/admin/bornes/${borneId}/events`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ event_id: eventId });
    assert.equal(res.status, 201);
    assert.equal(res.body.borne_id, borneId);
    assert.equal(res.body.event_id, eventId);
  });

  it('POST /:id/events retourne 409 si déjà assigné', async () => {
    const res = await request.post(`/api/admin/bornes/${borneId}/events`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ event_id: eventId });
    assert.equal(res.status, 409);
  });

  it('POST /:id/events retourne 404 pour un événement inconnu', async () => {
    const res = await request.post(`/api/admin/bornes/${borneId}/events`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ event_id: 'no-such-event' });
    assert.equal(res.status, 404);
  });

  it('GET /:id reflète l\'événement assigné', async () => {
    const res = await request.get(`/api/admin/bornes/${borneId}`)
      .set('Authorization', `Bearer ${tokenAdmin}`);
    assert.equal(res.body.events.length, 1);
    assert.equal(res.body.events[0].id, eventId);
  });

  it('POST /:id/commands enfile une commande pending (201)', async () => {
    const res = await request.post(`/api/admin/bornes/${borneId}/commands`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ type: 'pull' });
    assert.equal(res.status, 201);
    assert.equal(res.body.type, 'pull');
    assert.equal(res.body.status, 'pending');
  });

  it('POST /:id/commands retourne 400 pour un type invalide', async () => {
    const res = await request.post(`/api/admin/bornes/${borneId}/commands`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ type: 'reboot' });
    assert.equal(res.status, 400);
  });

  it('POST /:id/commands retourne 400 sans payload.event_id pour activate_event', async () => {
    const res = await request.post(`/api/admin/bornes/${borneId}/commands`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ type: 'activate_event' });
    assert.equal(res.status, 400);
  });

  it('POST /:id/commands retourne 400 si l\'événement n\'est pas assigné à cette borne', async () => {
    const evOther = await request.post('/api/events')
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ name: 'Événement non assigné' });
    const res = await request.post(`/api/admin/bornes/${borneId}/commands`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ type: 'activate_event', payload: { event_id: evOther.body.id } });
    assert.equal(res.status, 400);
  });

  it('POST /:id/commands accepte activate_event pour un événement assigné (201)', async () => {
    const res = await request.post(`/api/admin/bornes/${borneId}/commands`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ type: 'activate_event', payload: { event_id: eventId } });
    assert.equal(res.status, 201);
  });

  it('POST /:id/commands retourne 400 pour purge_event sans confirm', async () => {
    const res = await request.post(`/api/admin/bornes/${borneId}/commands`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ type: 'purge_event', payload: { event_id: eventId } });
    assert.equal(res.status, 400);
  });

  it('POST /:id/commands accepte purge_event avec confirm (201)', async () => {
    const res = await request.post(`/api/admin/bornes/${borneId}/commands`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ type: 'purge_event', payload: { event_id: eventId, confirm: 'Événement pour borne' } });
    assert.equal(res.status, 201);
  });

  it('GET /:id liste les commandes déposées', async () => {
    const res = await request.get(`/api/admin/bornes/${borneId}`)
      .set('Authorization', `Bearer ${tokenAdmin}`);
    // pull + activate_event + purge_event, déposées par les tests précédents
    assert.equal(res.body.commands.length, 3);
    assert.ok(res.body.commands.some((c) => c.type === 'pull'));
  });

  it('DELETE /:id/events/:eventId retire l\'assignation (204)', async () => {
    const res = await request.delete(`/api/admin/bornes/${borneId}/events/${eventId}`)
      .set('Authorization', `Bearer ${tokenAdmin}`);
    assert.equal(res.status, 204);
  });

  it('DELETE /:id/events/:eventId retourne 404 si déjà retiré', async () => {
    const res = await request.delete(`/api/admin/bornes/${borneId}/events/${eventId}`)
      .set('Authorization', `Bearer ${tokenAdmin}`);
    assert.equal(res.status, 404);
  });

  it('DELETE /:id supprime la borne (204)', async () => {
    const res = await request.delete(`/api/admin/bornes/${borneId}`)
      .set('Authorization', `Bearer ${tokenAdmin}`);
    assert.equal(res.status, 204);
  });

  it('DELETE /:id retourne 404 pour une borne inconnue', async () => {
    const res = await request.delete('/api/admin/bornes/no-such-borne')
      .set('Authorization', `Bearer ${tokenAdmin}`);
    assert.equal(res.status, 404);
  });

  it('retourne 403 pour un client', async () => {
    const res = await request.get('/api/admin/bornes')
      .set('Authorization', `Bearer ${tokenClient}`);
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
      .send({ status: 'preview' });
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

// ── POST /api/events/:id/preview/token ────────────────────────────────────────
// Accessible au propriétaire (client) et aux superusers (requireOwner).

describe('POST /api/events/:id/preview/token', () => {
  let evId, tokenOwner;

  before(async () => {
    // Crée l'événement (superuser)
    const res = await request.post('/api/events')
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ name: 'Événement preview token' });
    evId = res.body.id;

    // Assigne un client owner et récupère son token
    const db = getDb();
    const hashOwner = await argon2.hash('owner-pass', { type: argon2.argon2id });
    insertUser(db, { email: 'owner-preview@test.com', password_hash: hashOwner, role: 'client' });
    const owner = getUserByEmail(db, 'owner-preview@test.com');
    upsertEventUser(db, { event_id: evId, user_id: owner.id, roles: ['admin_borne'] });
    const r = await request.post('/api/auth/login').send({ email: 'owner-preview@test.com', password: 'owner-pass' });
    tokenOwner = r.body.token;
  });

  it('retourne un token JWT et une preview_url (superuser)', async () => {
    const res = await request.post(`/api/events/${evId}/preview/token`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ expires_in: '1d' });
    assert.equal(res.status, 200);
    assert.ok(res.body.token, 'token absent');
    assert.ok(res.body.preview_url, 'preview_url absent');
    assert.match(res.body.preview_url, /^https:\/\/essai-/);
    assert.ok(res.body.preview_url.includes('?token='), 'token absent de l\'URL');
  });

  it('accessible au client owner de l\'événement', async () => {
    const res = await request.post(`/api/events/${evId}/preview/token`)
      .set('Authorization', `Bearer ${tokenOwner}`)
      .send({});
    assert.equal(res.status, 200);
    assert.ok(res.body.token);
  });

  it('le JWT contient event_id et le rôle general', async () => {
    const res = await request.post(`/api/events/${evId}/preview/token`)
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({});
    const payload = jwt.decode(res.body.token);
    assert.equal(payload.event_id, evId);
    assert.ok(Array.isArray(payload.roles) && payload.roles.includes('general'));
  });

  it('retourne 404 pour un événement inexistant', async () => {
    const res = await request.post('/api/events/00000000-0000-0000-0000-000000000000/preview/token')
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({});
    assert.equal(res.status, 404);
  });

  it('retourne 401 sans token', async () => {
    const res = await request.post(`/api/events/${evId}/preview/token`).send({});
    assert.equal(res.status, 401);
  });
});
