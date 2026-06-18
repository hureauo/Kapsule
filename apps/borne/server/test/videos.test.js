import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createApp } from '../src/index.js';
import { closeRegistry, insertEvent, setActiveEvent } from '../src/registry.js';
import { closeEventDb } from '../src/eventDb.js';
import { createEventDb } from '@kapsule/core/src/eventDbSchema.js';
import { TEST_CFG, seedAuthUsers, loginAdmin } from './helpers.js';

const EVENT_ID = 'ev-videos-test';

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'borne-vid-'));
  const eventDir = join(dir, 'events', EVENT_ID);
  mkdirSync(join(eventDir, 'videos'), { recursive: true });
  const edb = createEventDb(join(eventDir, 'db.sqlite'));
  // Seed une question pour que les tests d'upload fonctionnent
  edb.prepare("INSERT INTO questions (text, max_duration, countdown, order_index) VALUES ('Q1', 60, 3, 0)").run();
  edb.close();
  const app = createApp(dir, { ...TEST_CFG, dataDir: dir });
  await seedAuthUsers(dir);
  const token = await loginAdmin(app, request);
  insertEvent({ id: EVENT_ID, name: 'Evt Videos', origin: 'hub', status: 'loaded' });
  setActiveEvent(EVENT_ID);
  const sessRes = await request(app)
    .post('/api/sessions')
    .send({ guest_name: 'Alice', consent: true });
  const sessionId = sessRes.body.id;
  const questRes = await request(app).get('/api/questions');
  const questionId = questRes.body[0].id;
  const questionText = questRes.body[0].text;
  return { dir, app, token, eventId: EVENT_ID, sessionId, questionId, questionText };
}

function teardown(dir) {
  closeEventDb();
  closeRegistry();
  rmSync(dir, { recursive: true });
}

// Crée un petit faux fichier vidéo MP4 pour les uploads
function fakeVideoBuffer() {
  return Buffer.from('fake-video-content');
}

// ── POST /api/videos ──────────────────────────────────────────────────────────

describe('POST /api/videos', () => {
  let ctx;
  beforeEach(async () => { ctx = await setup(); });
  afterEach(() => teardown(ctx.dir));

  test('upload une vidéo et retourne 201', async () => {
    const res = await request(ctx.app)
      .post('/api/videos')
      .field('session_id', ctx.sessionId)
      .field('question_id', String(ctx.questionId))
      .field('question_text', ctx.questionText)
      .attach('video', fakeVideoBuffer(), { filename: 'recording.mp4', contentType: 'video/mp4' });
    assert.equal(res.status, 201);
    assert.ok(res.body.id);
    assert.ok(res.body.checksum);
    assert.equal(res.body.session_id, ctx.sessionId);
    assert.equal(res.body.question_text, ctx.questionText);
  });

  test('remplace une vidéo existante (remplacement transactionnel §11.9)', async () => {
    // Premier upload
    await request(ctx.app)
      .post('/api/videos')
      .field('session_id', ctx.sessionId)
      .field('question_id', String(ctx.questionId))
      .field('question_text', ctx.questionText)
      .attach('video', fakeVideoBuffer(), { filename: 'v1.mp4', contentType: 'video/mp4' });
    // Second upload sur même (session, question)
    const res2 = await request(ctx.app)
      .post('/api/videos')
      .field('session_id', ctx.sessionId)
      .field('question_id', String(ctx.questionId))
      .field('question_text', ctx.questionText)
      .attach('video', fakeVideoBuffer(), { filename: 'v2.mp4', contentType: 'video/mp4' });
    assert.equal(res2.status, 201);
    // Il ne doit exister qu'une seule vidéo pour ce couple
    const listRes = await request(ctx.app)
      .get('/api/videos')
      .set('Authorization', `Bearer ${ctx.token}`);
    const matching = listRes.body.filter(
      v => v.session_id === ctx.sessionId && v.question_id === ctx.questionId
    );
    assert.equal(matching.length, 1);
  });

  test('tolère un mime générique avec extension .mp4 (Safari §11.4)', async () => {
    const res = await request(ctx.app)
      .post('/api/videos')
      .field('session_id', ctx.sessionId)
      .field('question_text', ctx.questionText)
      .attach('video', fakeVideoBuffer(), {
        filename: 'recording.mp4',
        contentType: 'application/octet-stream',
      });
    assert.equal(res.status, 201);
  });

  test('retourne 400 si session_id manquant', async () => {
    const res = await request(ctx.app)
      .post('/api/videos')
      .field('question_text', 'Q?')
      .attach('video', fakeVideoBuffer(), { filename: 'r.mp4', contentType: 'video/mp4' });
    assert.equal(res.status, 400);
  });

  test('retourne 400 si question_text manquant', async () => {
    const res = await request(ctx.app)
      .post('/api/videos')
      .field('session_id', ctx.sessionId)
      .attach('video', fakeVideoBuffer(), { filename: 'r.mp4', contentType: 'video/mp4' });
    assert.equal(res.status, 400);
  });

  test('retourne 400 sans fichier (pas de crash req.file.path)', async () => {
    const res = await request(ctx.app)
      .post('/api/videos')
      .field('session_id', ctx.sessionId)
      .field('question_text', ctx.questionText);
    // Pas de .attach — req.file est undefined
    assert.equal(res.status, 400);
    assert.ok(res.body.error);
  });
});

// ── GET /api/sessions/:sid/videos/:qid/file (public) ─────────────────────────

describe('GET /api/sessions/:sessionId/videos/:questionId/file', () => {
  let ctx;
  beforeEach(async () => { ctx = await setup(); });
  afterEach(() => teardown(ctx.dir));

  test('stream la vidéo de l\'invité (200)', async () => {
    await request(ctx.app)
      .post('/api/videos')
      .field('session_id', ctx.sessionId)
      .field('question_id', String(ctx.questionId))
      .field('question_text', ctx.questionText)
      .attach('video', fakeVideoBuffer(), { filename: 'r.mp4', contentType: 'video/mp4' });
    const res = await request(ctx.app)
      .get(`/api/sessions/${ctx.sessionId}/videos/${ctx.questionId}/file`);
    assert.equal(res.status, 200);
  });

  test('supporte les Range requests (206)', async () => {
    await request(ctx.app)
      .post('/api/videos')
      .field('session_id', ctx.sessionId)
      .field('question_id', String(ctx.questionId))
      .field('question_text', ctx.questionText)
      .attach('video', fakeVideoBuffer(), { filename: 'r.mp4', contentType: 'video/mp4' });
    const res = await request(ctx.app)
      .get(`/api/sessions/${ctx.sessionId}/videos/${ctx.questionId}/file`)
      .set('Range', 'bytes=0-3');
    assert.equal(res.status, 206);
    assert.ok(res.headers['content-range']);
  });

  test('retourne 404 si vidéo absente', async () => {
    const res = await request(ctx.app)
      .get(`/api/sessions/${ctx.sessionId}/videos/9999/file`);
    assert.equal(res.status, 404);
  });

  test('accessible sans token (public)', async () => {
    await request(ctx.app)
      .post('/api/videos')
      .field('session_id', ctx.sessionId)
      .field('question_id', String(ctx.questionId))
      .field('question_text', ctx.questionText)
      .attach('video', fakeVideoBuffer(), { filename: 'r.mp4', contentType: 'video/mp4' });
    const res = await request(ctx.app) // pas de token
      .get(`/api/sessions/${ctx.sessionId}/videos/${ctx.questionId}/file`);
    assert.equal(res.status, 200);
  });
});

// ── GET /api/videos (admin) ───────────────────────────────────────────────────

describe('GET /api/videos', () => {
  let ctx;
  beforeEach(async () => { ctx = await setup(); });
  afterEach(() => teardown(ctx.dir));

  test('retourne la liste avec guest_name', async () => {
    await request(ctx.app)
      .post('/api/videos')
      .field('session_id', ctx.sessionId)
      .field('question_text', 'Q?')
      .attach('video', fakeVideoBuffer(), { filename: 'r.mp4', contentType: 'video/mp4' });
    const res = await request(ctx.app)
      .get('/api/videos')
      .set('Authorization', `Bearer ${ctx.token}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 1);
    assert.equal(res.body[0].guest_name, 'Alice');
  });

  test('filtre par session_id', async () => {
    const res = await request(ctx.app)
      .get(`/api/videos?session_id=${ctx.sessionId}`)
      .set('Authorization', `Bearer ${ctx.token}`);
    assert.equal(res.status, 200);
  });

  test('retourne 401 sans token', async () => {
    const res = await request(ctx.app).get('/api/videos');
    assert.equal(res.status, 401);
  });
});

// ── GET /api/videos/export/csv (admin, AVANT /:id) ────────────────────────────

describe('GET /api/videos/export/csv', () => {
  let ctx;
  beforeEach(async () => { ctx = await setup(); });
  afterEach(() => teardown(ctx.dir));

  test('retourne un CSV avec les bonnes colonnes', async () => {
    await request(ctx.app)
      .post('/api/videos')
      .field('session_id', ctx.sessionId)
      .field('question_text', 'Ma question')
      .attach('video', fakeVideoBuffer(), { filename: 'r.mp4', contentType: 'video/mp4' });
    const res = await request(ctx.app)
      .get('/api/videos/export/csv')
      .set('Authorization', `Bearer ${ctx.token}`);
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type'].includes('text/csv'));
    assert.ok(res.headers['content-disposition'].includes('attachment'));
    assert.ok(res.text.includes('guest_name'));
    assert.ok(res.text.includes('consent_at'));
    assert.ok(res.text.includes('Alice'));
  });

  test('export/csv n\'est pas traité comme un :id (invariant §11.1)', async () => {
    // Si export est interprété comme un :id → /videos/export/file répondrait 404 vidéo
    // Le test sur /export/csv doit retourner 200 CSV, pas une erreur "vidéo introuvable"
    const res = await request(ctx.app)
      .get('/api/videos/export/csv')
      .set('Authorization', `Bearer ${ctx.token}`);
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type'].includes('text/csv'));
  });

  test('neutralise les préfixes de formule CSV (§S4/M1)', async () => {
    // Crée une session avec un guest_name malveillant
    const malSessRes = await request(ctx.app)
      .post('/api/sessions')
      .send({ guest_name: '=cmd|"/c calc"!A1', consent: true });
    assert.equal(malSessRes.status, 201);
    const malSessId = malSessRes.body.id;

    // Upload une vidéo avec une question_text malveillante
    await request(ctx.app)
      .post('/api/videos')
      .field('session_id', malSessId)
      .field('question_text', '+formule')
      .attach('video', fakeVideoBuffer(), { filename: 'r.mp4', contentType: 'video/mp4' });

    const res = await request(ctx.app)
      .get('/api/videos/export/csv')
      .set('Authorization', `Bearer ${ctx.token}`);
    assert.equal(res.status, 200);
    // Le préfixe = doit être précédé d'une apostrophe
    assert.ok(res.text.includes("'=cmd"), `guest_name malveillant non neutralisé : ${res.text}`);
    // Le préfixe + doit aussi être neutralisé
    assert.ok(res.text.includes("'+formule"), `question_text malveillant non neutralisé : ${res.text}`);
  });

  test('retourne 401 sans token', async () => {
    const res = await request(ctx.app).get('/api/videos/export/csv');
    assert.equal(res.status, 401);
  });
});

// ── GET /api/videos/:id/file et /download (admin) ────────────────────────────

describe('GET /api/videos/:id/file et /download', () => {
  let ctx;
  beforeEach(async () => { ctx = await setup(); });
  afterEach(() => teardown(ctx.dir));

  async function uploadVideo() {
    const res = await request(ctx.app)
      .post('/api/videos')
      .field('session_id', ctx.sessionId)
      .field('question_text', 'Q')
      .attach('video', fakeVideoBuffer(), { filename: 'r.mp4', contentType: 'video/mp4' });
    return res.body.id;
  }

  test('GET /videos/:id/file retourne 200 avec Accept-Ranges', async () => {
    const id = await uploadVideo();
    const res = await request(ctx.app)
      .get(`/api/videos/${id}/file`)
      .set('Authorization', `Bearer ${ctx.token}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers['accept-ranges'], 'bytes');
  });

  test('GET /videos/:id/file supporte Range (206)', async () => {
    const id = await uploadVideo();
    const res = await request(ctx.app)
      .get(`/api/videos/${id}/file`)
      .set('Authorization', `Bearer ${ctx.token}`)
      .set('Range', 'bytes=0-3');
    assert.equal(res.status, 206);
    assert.ok(res.headers['content-range']);
  });

  test('GET /videos/:id/download retourne Content-Disposition attachment', async () => {
    const id = await uploadVideo();
    const res = await request(ctx.app)
      .get(`/api/videos/${id}/download`)
      .set('Authorization', `Bearer ${ctx.token}`);
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-disposition'].includes('attachment'));
  });

  test('retourne 404 pour un id inexistant', async () => {
    const res = await request(ctx.app)
      .get('/api/videos/inexistant/file')
      .set('Authorization', `Bearer ${ctx.token}`);
    assert.equal(res.status, 404);
  });

  test('retourne 401 sans token', async () => {
    const res = await request(ctx.app).get('/api/videos/x/file');
    assert.equal(res.status, 401);
  });
});

// ── DELETE /api/videos/:id (admin) ────────────────────────────────────────────

describe('DELETE /api/videos/:id', () => {
  let ctx;
  beforeEach(async () => { ctx = await setup(); });
  afterEach(() => teardown(ctx.dir));

  test('supprime la vidéo et retourne 204', async () => {
    const uploadRes = await request(ctx.app)
      .post('/api/videos')
      .field('session_id', ctx.sessionId)
      .field('question_text', 'Q')
      .attach('video', fakeVideoBuffer(), { filename: 'r.mp4', contentType: 'video/mp4' });
    const id = uploadRes.body.id;
    const res = await request(ctx.app)
      .delete(`/api/videos/${id}`)
      .set('Authorization', `Bearer ${ctx.token}`);
    assert.equal(res.status, 204);
    // Vérifier que la vidéo n'est plus en base
    const listRes = await request(ctx.app)
      .get('/api/videos')
      .set('Authorization', `Bearer ${ctx.token}`);
    assert.ok(!listRes.body.find(v => v.id === id));
  });

  test('retourne 404 pour un id inexistant', async () => {
    const res = await request(ctx.app)
      .delete('/api/videos/inexistant')
      .set('Authorization', `Bearer ${ctx.token}`);
    assert.equal(res.status, 404);
  });

  test('retourne 401 sans token', async () => {
    const res = await request(ctx.app).delete('/api/videos/x');
    assert.equal(res.status, 401);
  });
});

// ── Quota MAX_DATA_BYTES (§11.21 / 6D.1) ─────────────────────────────────────

describe('POST /api/videos — quota 507', () => {
  let ctx;

  beforeEach(async () => {
    // maxDataBytes = 1 → tout upload est refusé (quota atteint dès le 1er octet)
    const dir = mkdtempSync(join(tmpdir(), 'borne-vid-quota-'));
    const quotaEventId = 'ev-quota-test';
    const eventDir = join(dir, 'events', quotaEventId);
    mkdirSync(join(eventDir, 'videos'), { recursive: true });
    const edb = createEventDb(join(eventDir, 'db.sqlite'));
    edb.prepare("INSERT INTO questions (text, max_duration, countdown, order_index) VALUES ('Q quota', 60, 3, 0)").run();
    edb.close();
    const app = createApp(dir, { ...TEST_CFG, dataDir: dir, maxDataBytes: 1 });
    insertEvent({ id: quotaEventId, name: 'Evt Quota', origin: 'hub', status: 'loaded' });
    setActiveEvent(quotaEventId);
    const sessRes = await request(app)
      .post('/api/sessions')
      .send({ guest_name: 'Bob', consent: true });
    const questRes = await request(app).get('/api/questions');
    ctx = {
      dir, app, sessionId: sessRes.body.id,
      questionId: questRes.body[0].id,
      questionText: questRes.body[0].text,
    };
  });

  afterEach(() => {
    closeEventDb();
    closeRegistry();
    rmSync(ctx.dir, { recursive: true });
  });

  test('retourne 507 quand le quota est dépassé', async () => {
    const res = await request(ctx.app)
      .post('/api/videos')
      .field('session_id', ctx.sessionId)
      .field('question_id', String(ctx.questionId))
      .field('question_text', ctx.questionText)
      .attach('video', Buffer.from('fake'), { filename: 'rec.mp4', contentType: 'video/mp4' });
    assert.equal(res.status, 507);
  });
});

// ── Mode preview — download et CSV bloqués (§preview) ────────────────────────

describe('preview — routes bloquées', () => {
  let ctx;

  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'borne-vid-preview-'));
    const previewEventId = 'ev-preview-test';
    const eventDir = join(dir, 'events', previewEventId);
    mkdirSync(join(eventDir, 'videos'), { recursive: true });
    const edb = createEventDb(join(eventDir, 'db.sqlite'));
    edb.prepare("INSERT INTO questions (text, max_duration, countdown, order_index) VALUES ('Q preview', 60, 3, 0)").run();
    edb.close();
    const app = createApp(dir, { ...TEST_CFG, dataDir: dir, previewMode: true });
    await seedAuthUsers(dir);
    const token = await loginAdmin(app, request);
    insertEvent({ id: previewEventId, name: 'Evt Preview', origin: 'hub', status: 'loaded' });
    setActiveEvent(previewEventId);
    ctx = { dir, app, token };
  });

  afterEach(() => {
    closeEventDb();
    closeRegistry();
    rmSync(ctx.dir, { recursive: true });
  });

  test('GET /videos/export/csv retourne 403 en mode preview', async () => {
    const res = await request(ctx.app)
      .get('/api/videos/export/csv')
      .set('Authorization', `Bearer ${ctx.token}`);
    assert.equal(res.status, 403);
  });

  test('GET /videos/:id/download retourne 403 en mode preview', async () => {
    const res = await request(ctx.app)
      .get('/api/videos/some-id/download')
      .set('Authorization', `Bearer ${ctx.token}`);
    assert.equal(res.status, 403);
  });
});
