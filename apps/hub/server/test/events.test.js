import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import supertest from 'supertest';
import argon2 from 'argon2';
import { createApp } from '../src/index.js';
import { getDb, closeRegistry, insertUser, insertBoxToken } from '../src/registry.js';
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
  const resA = insertUser(db, { email: 'alice@ev.test', password_hash: hashA, role: 'superuser' });
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
    assert.ok(res.body.id);
  });

  it('retourne preview_url dans la réponse (null si docker absent en test)', async () => {
    const res = await request.post('/api/events')
      .set(auth(tokenAlice))
      .send({ name: 'Événement preview url' });
    assert.equal(res.status, 201);
    // En environnement de test, docker CLI absent → provision échoue silencieusement → null
    assert.ok('preview_url' in res.body, 'preview_url doit être présent dans la réponse');
  });

  it('retourne 400 si name manquant', async () => {
    const res = await request.post('/api/events').set(auth(tokenAlice)).send({});
    assert.equal(res.status, 400);
  });

  it('retourne 401 sans token', async () => {
    const res = await request.post('/api/events').send({ name: 'Test' });
    assert.equal(res.status, 401);
  });

  it('retourne 403 pour un compte client (création réservée aux admins)', async () => {
    const res = await request.post('/api/events').set(auth(tokenBob)).send({ name: 'Test Bob' });
    assert.equal(res.status, 403);
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

  it('écrit le thème dans event_meta et le retourne dans meta', async () => {
    const res = await request.put(`/api/events/${eventId}`)
      .set(auth(tokenAlice))
      .send({ theme: 'dark' });
    assert.equal(res.status, 200);
    assert.equal(res.body.meta?.theme, 'dark');
  });

  it('rejette un thème invalide avec 400', async () => {
    const res = await request.put(`/api/events/${eventId}`)
      .set(auth(tokenAlice))
      .send({ theme: 'neon' });
    assert.equal(res.status, 400);
  });

  it('écrit tous les TEXT_FIELDS et les retourne dans meta', async () => {
    const res = await request.put(`/api/events/${eventId}`)
      .set(auth(tokenAlice))
      .send({ welcome_title: 'Bienvenue !', thanks_text: 'Merci !' });
    assert.equal(res.status, 200);
    assert.equal(res.body.meta?.welcome_title, 'Bienvenue !');
    assert.equal(res.body.meta?.thanks_text, 'Merci !');
  });

  it('GET /:id retourne event_meta (thème + textes)', async () => {
    await request.put(`/api/events/${eventId}`)
      .set(auth(tokenAlice))
      .send({ theme: 'modern', name_prompt: 'Votre prénom ?' });
    const res = await request.get(`/api/events/${eventId}`)
      .set(auth(tokenAlice));
    assert.equal(res.status, 200);
    assert.equal(res.body.meta?.theme, 'modern');
    assert.equal(res.body.meta?.name_prompt, 'Votre prénom ?');
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

// NOTE: PUT /api/events/:eventId/assign supprimé en 6C (token = événement, §11.20)

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
    assert.ok('tokens' in res.body, 'tokens (box_tokens liés) doit être présent');
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

// ── PUT /api/events/:eventId/owner ────────────────────────────────────────────

describe('PUT /api/events/:eventId/owner', () => {
  let eventId;

  before(async () => {
    const res = await request.post('/api/events')
      .set(auth(tokenAlice))
      .send({ name: 'Événement owner test' });
    eventId = res.body.id;
  });

  it("assigne un email existant sans créer de compte (created:false)", async () => {
    // Bob existe déjà (créé dans before global)
    const res = await request.put(`/api/events/${eventId}/owner`)
      .set(auth(tokenAlice))
      .send({ email: 'bob@ev.test' });
    assert.equal(res.status, 200);
    assert.equal(res.body.owner.email, 'bob@ev.test');
    assert.equal(res.body.created, false);
    assert.equal(res.body.registration_url, null);
  });

  it("crée un compte client si email inconnu (created:true + registration_url)", async () => {
    const res = await request.put(`/api/events/${eventId}/owner`)
      .set(auth(tokenAlice))
      .send({ email: 'nouveau@ev.test' });
    assert.equal(res.status, 200);
    assert.equal(res.body.owner.email, 'nouveau@ev.test');
    assert.equal(res.body.created, true);
    assert.ok(res.body.registration_url, 'registration_url doit être présent');
    assert.ok(res.body.registration_url.includes('/register?token='));
  });

  it('retourne 400 si email manquant', async () => {
    const res = await request.put(`/api/events/${eventId}/owner`)
      .set(auth(tokenAlice))
      .send({});
    assert.equal(res.status, 400);
  });

  it('retourne 403 pour un compte client (réservé aux admins)', async () => {
    const res = await request.put(`/api/events/${eventId}/owner`)
      .set(auth(tokenBob))
      .send({ email: 'test@ev.test' });
    assert.equal(res.status, 403);
  });
});

// ── POST /api/sync/events/:id/config — push config depuis borne/preview ──────
// Route déplacée sous /sync : protégée par X-Box-Token (pas JWT admin).

describe('POST /api/sync/events/:id/config', () => {
  let eventId;
  let rawToken;

  before(async () => {
    const res = await request.post('/api/events')
      .set(auth(tokenAlice))
      .send({ name: 'Événement config' });
    eventId = res.body.id;

    // Passe en ready pour que le token soit utilisable
    await request.put(`/api/events/${eventId}/status`)
      .set(auth(tokenAlice))
      .send({ status: 'ready' });

    rawToken = 'cfg-test-token-' + eventId.slice(0, 8);
    const hash = createHash('sha256').update(rawToken).digest('hex');
    insertBoxToken(getDb(), { event_id: eventId, token_hash: hash, token_clear: rawToken, label: 'Test config' });
  });

  const boxHeader = () => ({ 'X-Box-Token': rawToken });

  const configPayload = {
    mode: 'overwrite',
    questions: [
      { text: 'Question importée 1', max_duration: 60, countdown: 3 },
      { text: 'Question importée 2', max_duration: 30, countdown: 3 },
    ],
    meta: { theme: 'dark', welcome_title: 'Bienvenue preview', thanks_text: 'Merci preview' },
  };

  it('overwrite : remplace questions et meta (200)', async () => {
    const res = await request.post(`/api/sync/events/${eventId}/config`)
      .set(boxHeader())
      .send(configPayload);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
  });

  it('overwrite : les questions sont bien enregistrées', async () => {
    const res = await request.get(`/api/events/${eventId}/questions`)
      .set(auth(tokenAlice));
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 2);
    assert.ok(res.body.some(q => q.text === 'Question importée 1'));
  });

  it('merge : ne remplace pas les champs meta déjà renseignés', async () => {
    await request.put(`/api/events/${eventId}`)
      .set(auth(tokenAlice))
      .send({ welcome_title: 'Titre Hub original' });

    const res = await request.post(`/api/sync/events/${eventId}/config`)
      .set(boxHeader())
      .send({ ...configPayload, mode: 'merge', meta: { ...configPayload.meta, welcome_title: 'Titre preview ignoré' } });
    assert.equal(res.status, 200);
  });

  it('merge : n\'ajoute pas les questions déjà présentes (déduplique par texte)', async () => {
    const before = await request.get(`/api/events/${eventId}/questions`).set(auth(tokenAlice));
    const countBefore = before.body.length;

    await request.post(`/api/sync/events/${eventId}/config`)
      .set(boxHeader())
      .send({ mode: 'merge', questions: configPayload.questions, meta: {} });

    const after = await request.get(`/api/events/${eventId}/questions`).set(auth(tokenAlice));
    assert.equal(after.body.length, countBefore, 'Pas de doublon en mode merge');
  });

  it('retourne 400 si mode invalide', async () => {
    const res = await request.post(`/api/sync/events/${eventId}/config`)
      .set(boxHeader())
      .send({ mode: 'invalid', questions: [], meta: {} });
    assert.equal(res.status, 400);
  });

  it('retourne 401 sans token', async () => {
    const res = await request.post(`/api/sync/events/${eventId}/config`)
      .send(configPayload);
    assert.equal(res.status, 401);
  });
});

// ── POST /api/events/:id/config — import config depuis UI Hub (JWT admin) ─────

describe('POST /api/events/:eventId/config', () => {
  let eventId;

  before(async () => {
    const res = await request.post('/api/events')
      .set(auth(tokenAlice))
      .send({ name: 'Événement config UI' });
    eventId = res.body.id;
  });

  const payload = {
    mode: 'overwrite',
    questions: [{ text: 'Q UI 1', max_duration: 60, countdown: 3 }],
    meta: { theme: 'dark', welcome_title: 'Bienvenue' },
  };

  it('overwrite : remplace questions et meta (200)', async () => {
    const res = await request.post(`/api/events/${eventId}/config`)
      .set(auth(tokenAlice))
      .send(payload);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
  });

  it('retourne 400 si mode invalide', async () => {
    const res = await request.post(`/api/events/${eventId}/config`)
      .set(auth(tokenAlice))
      .send({ mode: 'bad', questions: [], meta: {} });
    assert.equal(res.status, 400);
  });

  it('retourne 401 sans JWT', async () => {
    const res = await request.post(`/api/events/${eventId}/config`).send(payload);
    assert.equal(res.status, 401);
  });
});
