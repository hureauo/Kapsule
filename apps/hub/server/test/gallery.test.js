import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import supertest from 'supertest';
import argon2 from 'argon2';
import { v4 as uuidv4 } from 'uuid';
import { createApp } from '../src/index.js';
import { getDb, closeRegistry, insertUser } from '../src/registry.js';
import { openEventDb, closeAllEventDbs } from '../src/eventStore.js';

let dir;
let request;
let token;
let otherToken;
let eventId;
let videoId;
const SESSION_ID = 'sess-gallery-001';

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kapsule-gallery-'));
  const app = createApp(dir);
  request = supertest(app);

  const db = getDb();
  const hash = await argon2.hash('pass123', { type: argon2.argon2id });
  const hashOther = await argon2.hash('other123', { type: argon2.argon2id });
  const res = insertUser(db, { email: 'owner@gallery.test', password_hash: hash, role: 'client' });
  insertUser(db, { email: 'other@gallery.test', password_hash: hashOther, role: 'client' });

  const loginRes = await supertest(app).post('/api/auth/login').send({ email: 'owner@gallery.test', password: 'pass123' });
  const loginOther = await supertest(app).post('/api/auth/login').send({ email: 'other@gallery.test', password: 'other123' });
  token = loginRes.body.token;
  otherToken = loginOther.body.token;

  // Crée un événement en statut 'pushed'
  eventId = uuidv4();
  const ownerId = res.lastInsertRowid;
  db.prepare(`
    INSERT INTO events (id, owner_id, name, status, pushed_at)
    VALUES (?, ?, 'Galerie Test', 'pushed', CURRENT_TIMESTAMP)
  `).run(eventId, ownerId);

  // Structure de fichiers
  const videosDir = join(dir, 'events', eventId, 'videos');
  const derivedDir = join(dir, 'events', eventId, 'derived');
  mkdirSync(videosDir, { recursive: true });
  mkdirSync(derivedDir, { recursive: true });

  // Fichier vidéo fictif
  writeFileSync(join(videosDir, 'test.mp4'), Buffer.from('FAKE VIDEO BYTES RANGE TEST'));

  // ZIP fictif
  writeFileSync(join(derivedDir, 'archive.zip'), Buffer.from('PK\x03\x04FAKE ZIP'));

  // Miniature fictive
  writeFileSync(join(derivedDir, 'VID1.jpg'), Buffer.from('FAKE JPEG'));

  // BD événement
  videoId = 'VID1';
  const edb = openEventDb(eventId, dir);
  edb.prepare(`INSERT INTO sessions (id, guest_name, consent_at) VALUES (?, 'Alice', CURRENT_TIMESTAMP)`).run(SESSION_ID);
  edb.prepare(`
    INSERT INTO videos (id, session_id, question_id, question_text, filename, mime_type, size, checksum)
    VALUES (?, ?, 1, 'Question?', 'test.mp4', 'video/mp4', 26, 'abc')
  `).run(videoId, SESSION_ID);
  edb.prepare(`
    INSERT INTO derived (video_id, thumbnail, duration_s, width, height, probed_at)
    VALUES (?, 'VID1.jpg', 10.5, 1280, 720, CURRENT_TIMESTAMP)
  `).run(videoId);

  // Job archive done
  db.prepare(`INSERT INTO jobs (event_id, type, status) VALUES (?, 'archive', 'done')`).run(eventId);
});

after(() => {
  closeAllEventDbs();
  closeRegistry();
  rmSync(dir, { recursive: true, force: true });
});

const auth = (t) => ({ Authorization: `Bearer ${t}` });

// ── GET /videos ───────────────────────────────────────────────────────────────

describe('GET /api/events/:id/videos', () => {
  it('retourne 401 sans token', async () => {
    const res = await request.get(`/api/events/${eventId}/videos`);
    assert.equal(res.status, 401);
  });

  it('retourne 403 si non propriétaire', async () => {
    const res = await request.get(`/api/events/${eventId}/videos`).set(auth(otherToken));
    assert.equal(res.status, 403);
  });

  it('retourne 200 + liste avec derived', async () => {
    const res = await request.get(`/api/events/${eventId}/videos`).set(auth(token));
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
    assert.equal(res.body.length, 1);
    const v = res.body[0];
    assert.equal(v.id, videoId);
    assert.equal(v.duration_s, 10.5);
    assert.equal(v.thumbnail, 'VID1.jpg');
    assert.equal(v.guest_name, 'Alice');
  });
});

// ── GET /videos/export/csv ───────────────────────────────────────────────────

describe('GET /api/events/:id/videos/export/csv', () => {
  it('retourne 200 avec CSV', async () => {
    const res = await request
      .get(`/api/events/${eventId}/videos/export/csv`)
      .set(auth(token));
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type'].includes('text/csv'));
    assert.ok(res.text.includes('question_text'));
    assert.ok(res.text.includes('Alice'));
  });
});

// ── GET /videos/:videoId/file ─────────────────────────────────────────────────

describe('GET /api/events/:id/videos/:videoId/file', () => {
  it('retourne 200 le fichier complet', async () => {
    const res = await request
      .get(`/api/events/${eventId}/videos/${videoId}/file`)
      .set(auth(token));
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type'].includes('video/mp4'));
  });

  it('retourne 206 sur requête Range', async () => {
    const res = await request
      .get(`/api/events/${eventId}/videos/${videoId}/file`)
      .set({ ...auth(token), Range: 'bytes=0-4' });
    assert.equal(res.status, 206);
    assert.ok(res.headers['content-range']);
    assert.equal(res.body.length, 5);
  });

  it('retourne 404 si vidéo inconnue', async () => {
    const res = await request
      .get(`/api/events/${eventId}/videos/UNKNOWN/file`)
      .set(auth(token));
    assert.equal(res.status, 404);
  });
});

// ── GET /videos/:videoId/download ────────────────────────────────────────────

describe('GET /api/events/:id/videos/:videoId/download', () => {
  it('retourne 200 avec header Content-Disposition attachment', async () => {
    const res = await request
      .get(`/api/events/${eventId}/videos/${videoId}/download`)
      .set(auth(token));
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-disposition'].includes('attachment'));
  });
});

// ── GET /videos/:videoId/thumbnail ────────────────────────────────────────────

describe('GET /api/events/:id/videos/:videoId/thumbnail', () => {
  it('retourne 200 image/jpeg', async () => {
    const res = await request
      .get(`/api/events/${eventId}/videos/${videoId}/thumbnail`)
      .set(auth(token));
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type'].includes('image/jpeg'));
  });

  it('retourne 404 si pas de miniature', async () => {
    const res = await request
      .get(`/api/events/${eventId}/videos/UNKNOWN/thumbnail`)
      .set(auth(token));
    assert.equal(res.status, 404);
  });
});

// ── GET /archive ───────────────────────────────────────────────────────────────

describe('GET /api/events/:id/archive', () => {
  it('retourne le ZIP quand le job est done', async () => {
    const res = await request
      .get(`/api/events/${eventId}/archive`)
      .set(auth(token));
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type'].includes('zip') || res.headers['content-type'].includes('octet'));
  });

  it('retourne 202 si aucun job archive done', async () => {
    // Crée un événement sans job archive
    const db = getDb();
    const evId2 = uuidv4();
    db.prepare(`INSERT INTO events (id, owner_id, name, status) VALUES (?, 1, 'NoArchive', 'pushed')`).run(evId2);
    mkdirSync(join(dir, 'events', evId2), { recursive: true });
    openEventDb(evId2, dir);

    const res = await request.get(`/api/events/${evId2}/archive`).set(auth(token));
    assert.equal(res.status, 202);
    assert.equal(res.body.pending, true);
  });
});

// ── DELETE /videos/:videoId ────────────────────────────────────────────────────

describe('DELETE /api/events/:id/videos/:videoId', () => {
  it('retourne 404 si vidéo inconnue', async () => {
    const res = await request
      .delete(`/api/events/${eventId}/videos/UNKNOWN`)
      .set(auth(token));
    assert.equal(res.status, 404);
  });

  it('supprime la vidéo et ré-enfile un job archive', async () => {
    // Crée une vidéo supplémentaire à supprimer
    const db = getDb();
    const edb = openEventDb(eventId, dir);
    const vid2 = 'VID2';
    const sess2 = 'sess2';
    edb.prepare(`INSERT INTO sessions (id, guest_name, consent_at) VALUES (?, 'Bob', CURRENT_TIMESTAMP)`).run(sess2);
    edb.prepare(`
      INSERT INTO videos (id, session_id, question_id, question_text, filename, mime_type, size, checksum)
      VALUES (?, ?, 2, 'Q2', 'video2.mp4', 'video/mp4', 10, 'def')
    `).run(vid2, sess2);
    writeFileSync(join(dir, 'events', eventId, 'videos', 'video2.mp4'), Buffer.from('BYTES'));

    const jobsBefore = db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE event_id = ? AND type = 'archive'`).get(eventId).n;

    const res = await request
      .delete(`/api/events/${eventId}/videos/${vid2}`)
      .set(auth(token));
    assert.equal(res.status, 204);

    const jobsAfter = db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE event_id = ? AND type = 'archive'`).get(eventId).n;
    assert.ok(jobsAfter > jobsBefore, 'un nouveau job archive doit être enfilé');

    // La vidéo n'est plus en base
    const stillThere = edb.prepare('SELECT id FROM videos WHERE id = ?').get(vid2);
    assert.equal(stillThere, undefined);
  });
});
