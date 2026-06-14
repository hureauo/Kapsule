import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import supertest from 'supertest';
import argon2 from 'argon2';
import { v4 as uuidv4 } from 'uuid';
import { createApp } from '../src/index.js';
import {
  getDb, closeRegistry, insertUser, insertBox, getBoxByTokenHash, getEvent,
} from '../src/registry.js';
import { closeAllEventDbs, openEventDb, cacheSize } from '../src/eventStore.js';

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
    // UUID bien formé mais absent → 404 (et non 400 de validation)
    const res = await request.get('/api/sync/events/11111111-1111-4111-8111-111111111111/bundle')
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
    const res = await request.post('/api/sync/events/11111111-1111-4111-8111-111111111111/status')
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

// ── Helpers pour les tests push ───────────────────────────────────────────────

// Prépare un événement en état 'closed' assigné à la borne (via heartbeat)
async function makeClosedEvent(req, tokenClient, tokenAdmin, boxToken, boxId, name) {
  const ev = await req.post('/api/events')
    .set('Authorization', `Bearer ${tokenClient}`)
    .send({ name });
  const id = ev.body.id;
  await req.put(`/api/events/${id}/status`).set('Authorization', `Bearer ${tokenClient}`).send({ status: 'ready' });
  await req.put(`/api/events/${id}/assign`).set('Authorization', `Bearer ${tokenAdmin}`).send({ box_id: boxId });
  await req.get(`/api/sync/events/${id}/bundle`).set('X-Box-Token', boxToken);  // loaded
  await req.post(`/api/sync/events/${id}/status`).set('X-Box-Token', boxToken).send({ status: 'live' });
  await req.post(`/api/sync/events/${id}/status`).set('X-Box-Token', boxToken).send({ status: 'closed' });
  return id;
}

// ── POST /api/sync/events/:id/manifest ──────────────────────────────────────

describe('POST /api/sync/events/:id/manifest', () => {
  let manifestEventId;

  before(async () => {
    manifestEventId = await makeClosedEvent(request, tokenClient, tokenAdmin, boxToken, boxId, 'Push manifest test');
  });

  it('retourne { missing: [] } si aucun fichier annoncé', async () => {
    const res = await request.post(`/api/sync/events/${manifestEventId}/manifest`)
      .set('X-Box-Token', boxToken)
      .send({ files: [], db: { size: 1000, checksum: 'abc' } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.missing, []);
  });

  it('retourne les video_id manquants', async () => {
    const res = await request.post(`/api/sync/events/${manifestEventId}/manifest`)
      .set('X-Box-Token', boxToken)
      .send({
        files: [
          { video_id: 'vid-001', filename: 'vid-001.mp4', size: 100, checksum: 'aaa' },
          { video_id: 'vid-002', filename: 'vid-002.mp4', size: 200, checksum: 'bbb' },
        ],
        db: { size: 1000, checksum: 'ccc' },
      });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.missing.sort(), ['vid-001', 'vid-002']);
  });

  it('ne retourne pas un fichier déjà présent avec le bon checksum', async () => {
    // Créer un fichier vidéo factice avec un checksum connu
    const content = randomBytes(32);
    const hash = createHash('sha256').update(content).digest('hex');
    const videosDir = join(dir, 'events', manifestEventId, 'videos');
    mkdirSync(videosDir, { recursive: true });
    writeFileSync(join(videosDir, 'vid-existing.mp4'), content);

    const res = await request.post(`/api/sync/events/${manifestEventId}/manifest`)
      .set('X-Box-Token', boxToken)
      .send({
        files: [
          { video_id: 'vid-existing', filename: 'vid-existing.mp4', size: content.length, checksum: hash },
          { video_id: 'vid-missing', filename: 'vid-missing.mp4', size: 100, checksum: 'xxx' },
        ],
        db: { size: 100, checksum: 'yyy' },
      });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.missing, ['vid-missing']);
  });

  it('retourne 409 si statut n\'est pas closed/pushed', async () => {
    // Utilise un événement en statut 'loaded'
    const evLoaded = await request.post('/api/events')
      .set('Authorization', `Bearer ${tokenClient}`)
      .send({ name: 'Loaded event' });
    await request.put(`/api/events/${evLoaded.body.id}/status`)
      .set('Authorization', `Bearer ${tokenClient}`).send({ status: 'ready' });
    await request.put(`/api/events/${evLoaded.body.id}/assign`)
      .set('Authorization', `Bearer ${tokenAdmin}`).send({ box_id: boxId });
    await request.get(`/api/sync/events/${evLoaded.body.id}/bundle`).set('X-Box-Token', boxToken);

    const res = await request.post(`/api/sync/events/${evLoaded.body.id}/manifest`)
      .set('X-Box-Token', boxToken)
      .send({ files: [], db: { size: 0, checksum: 'x' } });
    assert.equal(res.status, 409);
  });

  it('retourne 400 si body invalide', async () => {
    const res = await request.post(`/api/sync/events/${manifestEventId}/manifest`)
      .set('X-Box-Token', boxToken)
      .send({ files: [] }); // db manquant
    assert.equal(res.status, 400);
  });
});

// ── PUT /api/sync/events/:id/files/:videoId ──────────────────────────────────

describe('PUT /api/sync/events/:id/files/:videoId', () => {
  let uploadEventId;

  before(async () => {
    uploadEventId = await makeClosedEvent(request, tokenClient, tokenAdmin, boxToken, boxId, 'Upload vidéo test');
    // Prépare le manifest
    await request.post(`/api/sync/events/${uploadEventId}/manifest`)
      .set('X-Box-Token', boxToken)
      .send({ files: [], db: { size: 0, checksum: 'x' } });
  });

  it('accepte un fichier vidéo et retourne son checksum', async () => {
    const vidId = uuidv4();
    const content = randomBytes(64);
    const res = await request.put(`/api/sync/events/${uploadEventId}/files/${vidId}`)
      .set('X-Box-Token', boxToken)
      .attach('file', content, `${vidId}.mp4`);
    assert.equal(res.status, 200);
    assert.ok(res.body.ok);
    assert.equal(res.body.video_id, vidId);
    assert.ok(res.body.checksum, 'checksum doit être présent');
  });

  it('retourne 422 si checksum mismatch', async () => {
    // Prépare un manifest avec un mauvais checksum
    const badVid = uuidv4();
    const wrongChecksum = 'a'.repeat(64);
    const evMismatch = await makeClosedEvent(request, tokenClient, tokenAdmin, boxToken, boxId, 'Checksum mismatch');
    await request.post(`/api/sync/events/${evMismatch}/manifest`)
      .set('X-Box-Token', boxToken)
      .send({ files: [{ video_id: badVid, filename: `${badVid}.mp4`, size: 10, checksum: wrongChecksum }], db: { size: 0, checksum: 'x' } });

    const content = randomBytes(64);
    const res = await request.put(`/api/sync/events/${evMismatch}/files/${badVid}`)
      .set('X-Box-Token', boxToken)
      .attach('file', content, `${badVid}.mp4`);
    assert.equal(res.status, 422);
  });

  it('retourne 400 si aucun fichier joint', async () => {
    const res = await request.put(`/api/sync/events/${uploadEventId}/files/${uuidv4()}`)
      .set('X-Box-Token', boxToken);
    assert.equal(res.status, 400);
  });
});

// ── PUT /api/sync/events/:id/db ──────────────────────────────────────────────

describe('PUT /api/sync/events/:id/db', () => {
  let dbUploadEventId;

  before(async () => {
    dbUploadEventId = await makeClosedEvent(request, tokenClient, tokenAdmin, boxToken, boxId, 'Upload db test');
  });

  it('écrase db.sqlite et ferme le handle LRU (§11.11)', async () => {
    // Force l'ouverture du handle eventDb AVANT le PUT pour s'assurer qu'il est en cache
    openEventDb(dbUploadEventId, dir);
    const sizeBefore = cacheSize();
    assert.ok(sizeBefore >= 1, 'le handle doit être en cache avant le PUT');

    // Crée un mini db.sqlite factice (contenu quelconque — pas un vrai SQLite)
    const content = randomBytes(64);
    const hash = createHash('sha256').update(content).digest('hex');

    // Enregistre le manifest avec le bon checksum db
    await request.post(`/api/sync/events/${dbUploadEventId}/manifest`)
      .set('X-Box-Token', boxToken)
      .send({ files: [], db: { size: content.length, checksum: hash } });

    const res = await request.put(`/api/sync/events/${dbUploadEventId}/db`)
      .set('X-Box-Token', boxToken)
      .attach('file', content, 'db.sqlite');
    assert.equal(res.status, 200);
    assert.ok(res.body.ok);
    assert.equal(res.body.checksum, hash);

    // §11.11 : le handle doit avoir été retiré du cache
    assert.equal(cacheSize(), sizeBefore - 1, 'closeEventDb doit avoir retiré le handle du cache');

    // Le fichier doit exister sur le disque
    const dbPath = join(dir, 'events', dbUploadEventId, 'db.sqlite');
    assert.ok(existsSync(dbPath), 'db.sqlite doit exister après PUT /db');
  });

  it('retourne 422 si checksum db mismatch', async () => {
    const evDbMismatch = await makeClosedEvent(request, tokenClient, tokenAdmin, boxToken, boxId, 'DB mismatch');
    const wrongHash = 'b'.repeat(64);
    await request.post(`/api/sync/events/${evDbMismatch}/manifest`)
      .set('X-Box-Token', boxToken)
      .send({ files: [], db: { size: 10, checksum: wrongHash } });

    const content = randomBytes(64);
    const res = await request.put(`/api/sync/events/${evDbMismatch}/db`)
      .set('X-Box-Token', boxToken)
      .attach('file', content, 'db.sqlite');
    assert.equal(res.status, 422);
  });
});

// ── POST /api/sync/events/:id/finalize ───────────────────────────────────────

describe('POST /api/sync/events/:id/finalize', () => {
  let finalizeEventId;

  before(async () => {
    finalizeEventId = await makeClosedEvent(request, tokenClient, tokenAdmin, boxToken, boxId, 'Finalize test');

    // Upload 2 vidéos fictives + db.sqlite (video_id = UUID, comme en production)
    const fVid1 = uuidv4();
    const fVid2 = uuidv4();
    const vid1 = randomBytes(32);
    const vid2 = randomBytes(32);
    const dbContent = randomBytes(32);
    const h1 = createHash('sha256').update(vid1).digest('hex');
    const h2 = createHash('sha256').update(vid2).digest('hex');
    const hdb = createHash('sha256').update(dbContent).digest('hex');

    // Manifest
    await request.post(`/api/sync/events/${finalizeEventId}/manifest`)
      .set('X-Box-Token', boxToken)
      .send({
        files: [
          { video_id: fVid1, filename: `${fVid1}.mp4`, size: vid1.length, checksum: h1 },
          { video_id: fVid2, filename: `${fVid2}.mp4`, size: vid2.length, checksum: h2 },
        ],
        db: { size: dbContent.length, checksum: hdb },
      });

    // Uploads vidéos
    await request.put(`/api/sync/events/${finalizeEventId}/files/${fVid1}`)
      .set('X-Box-Token', boxToken).attach('file', vid1, `${fVid1}.mp4`);
    await request.put(`/api/sync/events/${finalizeEventId}/files/${fVid2}`)
      .set('X-Box-Token', boxToken).attach('file', vid2, `${fVid2}.mp4`);

    // Upload db
    await request.put(`/api/sync/events/${finalizeEventId}/db`)
      .set('X-Box-Token', boxToken).attach('file', dbContent, 'db.sqlite');
  });

  it('passe l\'événement en pushed et enfile les jobs', async () => {
    const res = await request.post(`/api/sync/events/${finalizeEventId}/finalize`)
      .set('X-Box-Token', boxToken);
    assert.equal(res.status, 200);
    assert.ok(res.body.ok);
    assert.equal(res.body.jobs, 5, '2 probe + 2 thumbnail + 1 archive = 5 jobs');

    const db = getDb();
    const event = getEvent(db, finalizeEventId);
    assert.equal(event.status, 'pushed');
    assert.ok(event.pushed_at);

    const jobs = db.prepare('SELECT * FROM jobs WHERE event_id = ?').all(finalizeEventId);
    assert.equal(jobs.length, 5);
    const types = jobs.map(j => j.type).sort();
    assert.deepEqual(types, ['archive', 'probe', 'probe', 'thumbnail', 'thumbnail']);
  });

  it('retourne 409 si des fichiers sont encore manquants', async () => {
    const evPartial = await makeClosedEvent(request, tokenClient, tokenAdmin, boxToken, boxId, 'Partial push');
    await request.post(`/api/sync/events/${evPartial}/manifest`)
      .set('X-Box-Token', boxToken)
      .send({ files: [{ video_id: 'missing-vid', filename: 'missing.mp4', size: 10, checksum: 'z'.repeat(64) }], db: { size: 0, checksum: 'z'.repeat(64) } });
    // Ne fait pas les uploads

    const res = await request.post(`/api/sync/events/${evPartial}/finalize`)
      .set('X-Box-Token', boxToken);
    assert.equal(res.status, 409);
    assert.ok(res.body.missing || res.body.error);
  });

  it('retourne 409 si manifest absent', async () => {
    const evNoManifest = await makeClosedEvent(request, tokenClient, tokenAdmin, boxToken, boxId, 'No manifest');
    const res = await request.post(`/api/sync/events/${evNoManifest}/finalize`)
      .set('X-Box-Token', boxToken);
    assert.equal(res.status, 409);
  });

  it('est idempotent : pushed→pushed ne ré-insère pas les jobs', async () => {
    const db = getDb();
    const jobsBefore = db.prepare('SELECT COUNT(*) as n FROM jobs WHERE event_id = ?').get(finalizeEventId).n;

    const res = await request.post(`/api/sync/events/${finalizeEventId}/finalize`)
      .set('X-Box-Token', boxToken);
    assert.equal(res.status, 200);
    assert.ok(res.body.ok);
    assert.ok(res.body.alreadyPushed, 'doit indiquer alreadyPushed=true');

    const jobsAfter = db.prepare('SELECT COUNT(*) as n FROM jobs WHERE event_id = ?').get(finalizeEventId).n;
    assert.equal(jobsAfter, jobsBefore, 'aucun job supplémentaire ne doit être inséré');
  });
});

// ── validateUuidParams — anti path traversal (SECURITY.md H1) ──────────────────

describe('validateUuidParams — rejet des params non-UUID avant tout accès disque', () => {
  it('rejette :id = ".." (400) sur le bundle', async () => {
    const res = await request.get('/api/sync/events/..%2f..%2f..%2fetc/bundle')
      .set('X-Box-Token', boxToken);
    assert.equal(res.status, 400);
    assert.match(res.body.error, /id invalide/);
  });

  it('rejette :id non-UUID (400) sur le manifest', async () => {
    const res = await request.post('/api/sync/events/pas-un-uuid/manifest')
      .set('X-Box-Token', boxToken)
      .send({ files: [], db: { size: 1, checksum: 'x' } });
    assert.equal(res.status, 400);
  });

  it('rejette :videoId malformé (400) sans écrire de fichier hors du dossier', async () => {
    const res = await request.put(`/api/sync/events/${eventId}/files/..%2f..%2f..%2fevil`)
      .set('X-Box-Token', boxToken)
      .attach('file', Buffer.from('malveillant'), 'evil.mp4');
    assert.equal(res.status, 400);
    assert.match(res.body.error, /videoId invalide/);
    // Aucun fichier 'evil' ne doit avoir été déposé à la racine du DATA_DIR
    assert.ok(!existsSync(join(dir, 'evil')), 'aucun fichier ne doit sortir du dossier événement');
    assert.ok(!existsSync(join(dir, 'evil.mp4')), 'aucun fichier ne doit sortir du dossier événement');
  });

  it('exige le token borne avant la validation des params (401 prioritaire)', async () => {
    const res = await request.put('/api/sync/events/pas-un-uuid/files/pas-un-uuid').send({});
    assert.equal(res.status, 401);
  });

  it('accepte un :id UUID valide (pas de 400 de validation)', async () => {
    // event inexistant mais UUID bien formé → on passe la validation, 404 attendu (pas 400)
    const res = await request.get('/api/sync/events/00000000-0000-4000-8000-000000000000/bundle')
      .set('X-Box-Token', boxToken);
    assert.notEqual(res.status, 400);
  });
});

// ── Limite de taille d'upload (SECURITY.md M2 / S3.1) ─────────────────────────

describe('limite de taille d\'upload sync (anti-DoS disque)', () => {
  let smallApp, smallEventId;
  const MAX = 1024; // 1 Ko : plafond minuscule injecté pour le test

  before(async () => {
    // Même DATA_DIR / même registre (singleton), mais multer plafonné à 1 Ko
    smallApp = supertest(createApp(dir, { sync: { maxUploadBytes: MAX } }));
    smallEventId = await makeClosedEvent(smallApp, tokenClient, tokenAdmin, boxToken, boxId, 'Upload limit test');
    await smallApp.post(`/api/sync/events/${smallEventId}/manifest`)
      .set('X-Box-Token', boxToken)
      .send({ files: [], db: { size: 0, checksum: 'x' } });
  });

  it('rejette une vidéo dépassant la limite (413)', async () => {
    const tooBig = randomBytes(MAX + 512); // > 1 Ko
    const res = await smallApp.put(`/api/sync/events/${smallEventId}/files/${uuidv4()}`)
      .set('X-Box-Token', boxToken)
      .attach('file', tooBig, 'big.mp4');
    assert.equal(res.status, 413);
    assert.match(res.body.error, /Upload refusé/);
  });

  it('rejette un db.sqlite dépassant la limite (413)', async () => {
    const tooBig = randomBytes(MAX + 512);
    const res = await smallApp.put(`/api/sync/events/${smallEventId}/db`)
      .set('X-Box-Token', boxToken)
      .attach('file', tooBig, 'db.sqlite');
    assert.equal(res.status, 413);
  });

  it('accepte un fichier sous la limite', async () => {
    const ok = randomBytes(256); // < 1 Ko
    const res = await smallApp.put(`/api/sync/events/${smallEventId}/files/${uuidv4()}`)
      .set('X-Box-Token', boxToken)
      .attach('file', ok, 'small.mp4');
    assert.equal(res.status, 200);
  });
});
