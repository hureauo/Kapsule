import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import supertest from 'supertest';
import argon2 from 'argon2';
import { config } from '../src/config.js';
import { createApp } from '../src/index.js';
import { getDb, closeRegistry, insertUser, insertEvent } from '../src/registry.js';

let dir;
let app;
let request;
let tokenAlice;
let tokenBob;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kapsule-hub-auth-'));
  app = createApp(dir);
  request = supertest(app);

  const db = getDb();
  const hashAlice = await argon2.hash('password-alice', { type: argon2.argon2id });
  const hashBob   = await argon2.hash('password-bob',   { type: argon2.argon2id });
  insertUser(db, { email: 'alice@test.com', password_hash: hashAlice, role: 'client' });
  insertUser(db, { email: 'bob@test.com',   password_hash: hashBob,   role: 'client' });
});

after(() => {
  closeRegistry();
  rmSync(dir, { recursive: true, force: true });
});

// ── login ────────────────────────────────────────────────────────────────────

describe('POST /api/auth/login', () => {
  it('retourne un token JWT pour des identifiants valides', async () => {
    const res = await request.post('/api/auth/login')
      .send({ email: 'alice@test.com', password: 'password-alice' });
    assert.equal(res.status, 200);
    assert.ok(res.body.token);
    tokenAlice = res.body.token;
  });

  it('retourne 401 pour un mauvais mot de passe', async () => {
    const res = await request.post('/api/auth/login')
      .send({ email: 'alice@test.com', password: 'wrong' });
    assert.equal(res.status, 401);
  });

  it('retourne 401 pour un email inconnu', async () => {
    const res = await request.post('/api/auth/login')
      .send({ email: 'nope@test.com', password: 'whatever' });
    assert.equal(res.status, 401);
  });

  it('retourne 400 si email ou password manquant', async () => {
    const res = await request.post('/api/auth/login').send({ email: 'alice@test.com' });
    assert.equal(res.status, 400);
  });
});

// ── register ─────────────────────────────────────────────────────────────────

describe('POST /api/auth/register', () => {
  it('retourne 403 quand ALLOW_REGISTER=false (défaut)', async () => {
    const res = await request.post('/api/auth/register')
      .send({ email: 'new@test.com', password: 'secure123' });
    assert.equal(res.status, 403);
  });

  // Les tests suivants mutent config.allowRegister sur l'objet ESM partagé
  it('crée un compte et retourne un token (201) quand ALLOW_REGISTER=true', async () => {
    config.allowRegister = true;
    const res = await request.post('/api/auth/register')
      .send({ email: 'charlie@test.com', password: 'securepass1', name: 'Charlie' });
    config.allowRegister = false;
    assert.equal(res.status, 201);
    assert.ok(res.body.token);
  });

  it('retourne 400 si le mot de passe est trop court', async () => {
    config.allowRegister = true;
    const res = await request.post('/api/auth/register')
      .send({ email: 'short@test.com', password: '1234567' });
    config.allowRegister = false;
    assert.equal(res.status, 400);
  });

  it('retourne 409 si l\'email est déjà utilisé', async () => {
    config.allowRegister = true;
    await request.post('/api/auth/register')
      .send({ email: 'dup@test.com', password: 'firstpass1' });
    const res = await request.post('/api/auth/register')
      .send({ email: 'dup@test.com', password: 'secondpass' });
    config.allowRegister = false;
    assert.equal(res.status, 409);
  });

  it('retourne 400 si email manquant', async () => {
    config.allowRegister = true;
    const res = await request.post('/api/auth/register').send({ password: 'securepass1' });
    config.allowRegister = false;
    assert.equal(res.status, 400);
  });
});

// ── requireUser ───────────────────────────────────────────────────────────────

describe('requireUser (via GET /api/events)', () => {
  it('retourne 401 sans token', async () => {
    const res = await request.get('/api/events');
    assert.equal(res.status, 401);
  });

  it('retourne 401 avec un token invalide', async () => {
    const res = await request.get('/api/events')
      .set('Authorization', 'Bearer token-bidon');
    assert.equal(res.status, 401);
  });

  it('accepte le token en header Authorization et retourne 200', async () => {
    const res = await request.get('/api/events')
      .set('Authorization', `Bearer ${tokenAlice}`);
    assert.equal(res.status, 200);
  });

  it('accepte le token en ?token= et retourne 200', async () => {
    const res = await request.get(`/api/events?token=${tokenAlice}`);
    assert.equal(res.status, 200);
  });
});

// ── cloisonnement requireOwner (2 comptes) ────────────────────────────────────

describe('requireOwner — cloisonnement 2 comptes', () => {
  let eventAliceId;

  before(async () => {
    const res = await request.post('/api/auth/login')
      .send({ email: 'bob@test.com', password: 'password-bob' });
    tokenBob = res.body.token;

    const db = getDb();
    const alice = db.prepare('SELECT id FROM users WHERE email = ?').get('alice@test.com');
    eventAliceId = 'evt-alice-001';
    insertEvent(db, { id: eventAliceId, owner_id: alice.id, name: 'Mariage Alice' });
  });

  it('Alice peut accéder à son propre événement (200)', async () => {
    const res = await request.get(`/api/events/${eventAliceId}`)
      .set('Authorization', `Bearer ${tokenAlice}`);
    assert.equal(res.status, 200);
  });

  it('Bob ne peut pas accéder à l\'événement d\'Alice (403)', async () => {
    const res = await request.get(`/api/events/${eventAliceId}`)
      .set('Authorization', `Bearer ${tokenBob}`);
    assert.equal(res.status, 403);
  });
});
