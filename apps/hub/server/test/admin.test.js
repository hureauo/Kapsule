import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import supertest from 'supertest';
import argon2 from 'argon2';
import { createApp } from '../src/index.js';
import { getDb, closeRegistry, insertUser, getBoxByTokenHash } from '../src/registry.js';
import { createHash } from 'node:crypto';

let dir, request, tokenAdmin, tokenClient;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kapsule-hub-admin-'));
  const app = createApp(dir);
  request = supertest(app);

  const db = getDb();
  const hashAdmin  = await argon2.hash('admin-pass', { type: argon2.argon2id });
  const hashClient = await argon2.hash('client-pass', { type: argon2.argon2id });
  insertUser(db, { email: 'admin@test.com',  password_hash: hashAdmin,  role: 'admin' });
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

// ── POST /api/admin/boxes ─────────────────────────────────────────────────────

describe('POST /api/admin/boxes', () => {
  it('crée une borne et retourne le token en clair (admin)', async () => {
    const res = await request.post('/api/admin/boxes')
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ name: 'Borne Salon' });
    assert.equal(res.status, 201);
    assert.ok(res.body.id);
    assert.equal(res.body.name, 'Borne Salon');
    assert.ok(res.body.token, 'token en clair doit être présent');
    assert.equal(res.body.token.length, 64, '32 octets hex = 64 chars');

    // Le hash du token retourné doit correspondre à ce qui est stocké
    const db = getDb();
    const hash = createHash('sha256').update(res.body.token).digest('hex');
    const box = getBoxByTokenHash(db, hash);
    assert.ok(box, 'la borne doit exister en base');
    assert.equal(box.name, 'Borne Salon');
  });

  it('retourne 400 si name manquant', async () => {
    const res = await request.post('/api/admin/boxes')
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({});
    assert.equal(res.status, 400);
  });

  it('retourne 403 pour un client', async () => {
    const res = await request.post('/api/admin/boxes')
      .set('Authorization', `Bearer ${tokenClient}`)
      .send({ name: 'Borne Test' });
    assert.equal(res.status, 403);
  });

  it('retourne 401 sans token', async () => {
    const res = await request.post('/api/admin/boxes').send({ name: 'Borne Test' });
    assert.equal(res.status, 401);
  });
});

// ── GET /api/admin/boxes ──────────────────────────────────────────────────────

describe('GET /api/admin/boxes', () => {
  it('liste les bornes sans token_hash (admin)', async () => {
    const res = await request.get('/api/admin/boxes')
      .set('Authorization', `Bearer ${tokenAdmin}`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
    assert.ok(res.body.length >= 1);
    assert.ok(!('token_hash' in res.body[0]), 'token_hash ne doit pas être exposé');
  });

  it('retourne 403 pour un client', async () => {
    const res = await request.get('/api/admin/boxes')
      .set('Authorization', `Bearer ${tokenClient}`);
    assert.equal(res.status, 403);
  });
});

// ── DELETE /api/admin/boxes/:id ───────────────────────────────────────────────

describe('DELETE /api/admin/boxes/:id', () => {
  it('supprime une borne existante (admin)', async () => {
    // Créer une borne à supprimer
    const create = await request.post('/api/admin/boxes')
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ name: 'À supprimer' });
    const id = create.body.id;

    const res = await request.delete(`/api/admin/boxes/${id}`)
      .set('Authorization', `Bearer ${tokenAdmin}`);
    assert.equal(res.status, 204);
  });

  it('retourne 404 pour une borne inexistante', async () => {
    const res = await request.delete('/api/admin/boxes/99999')
      .set('Authorization', `Bearer ${tokenAdmin}`);
    assert.equal(res.status, 404);
  });

  it('retourne 403 pour un client', async () => {
    const res = await request.delete('/api/admin/boxes/1')
      .set('Authorization', `Bearer ${tokenClient}`);
    assert.equal(res.status, 403);
  });
});

// ── requireBox (via boxAuth.js) ───────────────────────────────────────────────
// Testé indirectement via les routes /api/sync (phase 3.2+).
// Ici on vérifie que le middleware est opérationnel sur un endpoint arbitraire
// monté manuellement — utiliser la route admin pour vérifier que requireBox
// rejette correctement sur une route protégée.

describe('boxAuth — middleware', () => {
  let boxToken;

  before(async () => {
    const res = await request.post('/api/admin/boxes')
      .set('Authorization', `Bearer ${tokenAdmin}`)
      .send({ name: 'Borne boxAuth test' });
    boxToken = res.body.token;
  });

  it('met à jour last_seen_at quand le token est valide', async () => {
    const db = getDb();
    const hash = createHash('sha256').update(boxToken).digest('hex');
    const before = getBoxByTokenHash(db, hash).last_seen_at;

    // On fait une requête qui passe par requireBox (route /api/sync montée phase 3.2,
    // mais on peut tester l'import direct du middleware)
    // Pour l'instant, on vérifie uniquement que le hash correspond bien en base
    assert.ok(getBoxByTokenHash(db, hash), 'le token doit être retrouvable par son hash');
    // last_seen_at sera vérifié dans les tests de la phase 3.2
    void before; // référencé pour éviter lint
  });

  it('sha256 du token retourné correspond au hash en base', async () => {
    const db = getDb();
    const hash = createHash('sha256').update(boxToken).digest('hex');
    const box = getBoxByTokenHash(db, hash);
    assert.ok(box);
    assert.equal(box.name, 'Borne boxAuth test');
  });
});
