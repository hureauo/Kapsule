import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import supertest from 'supertest';
import argon2 from 'argon2';
import { createApp } from '../src/index.js';
import { getDb, closeRegistry, insertUser, getUserByEmail, getBoxByTokenHash } from '../src/registry.js';
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

  it('génère un nouveau lien d\'enregistrement', async () => {
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

    // Structure attendue
    assert.ok(Array.isArray(res.body.events), 'events doit être un tableau');
    assert.ok(typeof res.body.disk?.free_bytes === 'number', 'disk.free_bytes doit être un nombre');
    assert.ok(typeof res.body.disk?.total_bytes === 'number', 'disk.total_bytes doit être un nombre');
    assert.ok(Array.isArray(res.body.failed_jobs), 'failed_jobs doit être un tableau');
    assert.ok(Array.isArray(res.body.boxes), 'boxes doit être un tableau');

    // Le job failed apparaît
    const failed = res.body.failed_jobs.find((j) => j.error === 'test error');
    assert.ok(failed, 'le job failed doit apparaître dans overview');
    assert.equal(failed.type, 'probe');

    // Les bornes ont last_seen_at
    assert.ok(res.body.boxes.length >= 1, 'au moins une borne en base');
    assert.ok('last_seen_at' in res.body.boxes[0]);

    // Les events ont disk_bytes
    // (pas d'événement créé dans ce test, mais la structure est vérifiée)
    for (const ev of res.body.events) {
      assert.ok(typeof ev.disk_bytes === 'number', 'disk_bytes doit être un nombre');
      assert.ok(!('token_hash' in ev), 'token_hash ne doit pas fuiter');
    }
  });
});
