import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';

import { createApp } from '../src/index.js';
import { closeRegistry, getRegistry, insertEvent, updateEventStatus } from '../src/registry.js';
import { closeEventDb } from '../src/eventDb.js';
import { createEventDb } from '@kapsule/core/src/eventDbSchema.js';
import { config } from '../src/config.js';

const TEST_CFG = {
  adminPassword: 'test',
  techPassword: 'tech-test',
  jwtSecret: 'secret-test',
  dataDir: '',
  hubUrl: 'https://hub.test',
  boxToken: 'tok',
};

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'borne-sync-routes-'));
  const app = createApp(dir, { ...TEST_CFG, dataDir: dir });
  // Les routes sync requièrent requireTech → login avec techPassword
  const loginRes = await request(app).post('/api/admin/login').send({ password: 'tech-test' });
  const token = loginRes.body.token;
  // Token client pour les tests d'accès refusé
  const clientRes = await request(app).post('/api/admin/login').send({ password: 'test' });
  const clientToken = clientRes.body.token;
  return { dir, app, token, clientToken };
}

function teardown(dir) {
  closeEventDb();
  closeRegistry();
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Crée un event en statut closed avec un db.sqlite valide.
 */
function makeClosedEvent(dir, eventId) {
  const eventDir = join(dir, 'events', eventId);
  mkdirSync(join(eventDir, 'videos'), { recursive: true });
  const edb = createEventDb(join(eventDir, 'db.sqlite'));
  edb.close();
  insertEvent({ id: eventId, name: 'Mon Event', origin: 'hub', status: 'loaded' });
  updateEventStatus(eventId, 'live');
  updateEventStatus(eventId, 'closed');
}

let savedFetch;
function mockFetchSuccess() {
  savedFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes('/manifest')) return { ok: true, status: 200, json: async () => ({ missing: [] }) };
    if (url.endsWith('/db')) return { ok: true, status: 200, json: async () => ({ ok: true }) };
    if (url.includes('/finalize')) return { ok: true, status: 200, json: async () => ({ ok: true }) };
    if (url.includes('/assigned')) return { ok: true, status: 200, json: async () => [] };
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
}
function restoreFetch() {
  if (savedFetch !== undefined) globalThis.fetch = savedFetch;
}

// ── GET /api/sync/status ─────────────────────────────────────────────────────

describe('GET /api/sync/status', () => {
  let dir, app, token;

  beforeEach(async () => {
    ({ dir, app, token } = await setup());
    mockFetchSuccess();
  });
  afterEach(() => { restoreFetch(); teardown(dir); });

  it('retourne les champs attendus', async () => {
    const res = await request(app)
      .get('/api/sync/status')
      .set('Authorization', `Bearer ${token}`);

    assert.equal(res.status, 200);
    assert.ok('online' in res.body);
    assert.ok('hubUrl' in res.body);
    assert.ok('lastPull' in res.body);
    assert.ok('push' in res.body);
    assert.ok('running' in res.body.push);
    assert.ok('total' in res.body.push);
    assert.ok('done' in res.body.push);
    assert.ok('currentFile' in res.body.push);
  });

  it('retourne 401 sans token', async () => {
    const res = await request(app).get('/api/sync/status');
    assert.equal(res.status, 401);
  });

  it('online=true si hubUrl configuré', async () => {
    const res = await request(app)
      .get('/api/sync/status')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(res.body.online, true);
    assert.equal(res.body.hubUrl, 'https://hub.test');
  });
});

// ── POST /api/sync/pull ──────────────────────────────────────────────────────

describe('POST /api/sync/pull', () => {
  let dir, app, token;

  beforeEach(async () => {
    ({ dir, app, token } = await setup());
    mockFetchSuccess();
  });
  afterEach(() => { restoreFetch(); teardown(dir); });

  it('retourne { ok: true } immédiatement', async () => {
    const res = await request(app)
      .post('/api/sync/pull')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
  });

  it('retourne 401 sans token', async () => {
    const res = await request(app).post('/api/sync/pull');
    assert.equal(res.status, 401);
  });
});

// ── POST /api/sync/push/:eventId ─────────────────────────────────────────────

describe('POST /api/sync/push/:eventId', () => {
  let dir, app, token, clientToken;

  beforeEach(async () => {
    ({ dir, app, token, clientToken } = await setup());
    mockFetchSuccess();
  });
  afterEach(async () => {
    restoreFetch();
    // Attendre que le push en tâche de fond termine pour éviter les fuites
    await new Promise(r => setTimeout(r, 100));
    teardown(dir);
  });

  it('retourne 404 si l\'event n\'existe pas', async () => {
    const res = await request(app)
      .post('/api/sync/push/inexistant')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 404);
  });

  it('retourne 409 si l\'event n\'est pas closed', async () => {
    insertEvent({ id: 'ev-live', name: 'Live', origin: 'hub', status: 'loaded' });
    updateEventStatus('ev-live', 'live');

    const res = await request(app)
      .post('/api/sync/push/ev-live')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 409);
    assert.match(res.body.error, /Clôturez/);
  });

  it('retourne { ok: true } et lance le push en tâche de fond', async () => {
    makeClosedEvent(dir, 'ev-push');

    const res = await request(app)
      .post('/api/sync/push/ev-push')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
  });

  it('retourne 409 si un push est déjà en cours', async () => {
    makeClosedEvent(dir, 'ev-push-running');

    // Bloquer le push : le manifest ne répond qu'après signal explicite
    let resolveManifest;
    globalThis.fetch = async (url) => {
      if (url.includes('/manifest')) {
        return new Promise(resolve => { resolveManifest = resolve; });
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };

    // Lance le 1er push (reste bloqué sur checkpointAndHash + manifest)
    const firstPush = request(app)
      .post('/api/sync/push/ev-push-running')
      .set('Authorization', `Bearer ${token}`);
    // Ne pas await — on veut que ça tourne en fond
    firstPush.end(() => {});

    // Sonder getPushState jusqu'à ce que running=true (max 500ms)
    const statusRes = await new Promise((resolve) => {
      const check = async () => {
        const r = await request(app)
          .get('/api/sync/status')
          .set('Authorization', `Bearer ${token}`);
        if (r.body.push?.running) return resolve(r);
        setTimeout(check, 10);
      };
      check();
    });
    assert.equal(statusRes.body.push.running, true);

    // 2ème tentative → 409
    const res = await request(app)
      .post('/api/sync/push/ev-push-running')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 409);
    assert.match(res.body.error, /déjà en cours/);

    // Débloquer le push bloqué pour nettoyage propre
    if (resolveManifest) resolveManifest({ ok: true, status: 200, json: async () => ({ missing: [] }) });
    await new Promise(r => setTimeout(r, 80));
  });

  it('retourne 403 avec un token client (§11.19)', async () => {
    const res = await request(app)
      .post('/api/sync/push/ev-x')
      .set('Authorization', `Bearer ${clientToken}`);
    assert.equal(res.status, 403);
  });

  it('retourne 401 sans token', async () => {
    const res = await request(app).post('/api/sync/push/ev-x');
    assert.equal(res.status, 401);
  });
});

// ── POST /api/sync/purge/:eventId ────────────────────────────────────────────

describe('POST /api/sync/purge/:eventId', () => {
  let dir, app, token;

  beforeEach(async () => {
    ({ dir, app, token } = await setup());
    mockFetchSuccess();
  });
  afterEach(() => { restoreFetch(); teardown(dir); });

  it('retourne 404 si l\'event n\'existe pas', async () => {
    const res = await request(app)
      .post('/api/sync/purge/inexistant')
      .set('Authorization', `Bearer ${token}`)
      .send({ confirm: 'nom' });
    assert.equal(res.status, 404);
  });

  it('retourne 409 si l\'event n\'est pas pushed', async () => {
    insertEvent({ id: 'ev-closed', name: 'Closed', origin: 'hub', status: 'loaded' });
    updateEventStatus('ev-closed', 'live');
    updateEventStatus('ev-closed', 'closed');

    const res = await request(app)
      .post('/api/sync/purge/ev-closed')
      .set('Authorization', `Bearer ${token}`)
      .send({ confirm: 'Closed' });
    assert.equal(res.status, 409);
  });

  it('retourne 400 si la confirmation est absente', async () => {
    insertEvent({ id: 'ev-pushed', name: 'Pushed Event', origin: 'hub', status: 'loaded' });
    updateEventStatus('ev-pushed', 'live');
    updateEventStatus('ev-pushed', 'closed');
    updateEventStatus('ev-pushed', 'pushed');

    const res = await request(app)
      .post('/api/sync/purge/ev-pushed')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    assert.equal(res.status, 400);
  });

  it('retourne 400 si la confirmation ne correspond pas au nom', async () => {
    insertEvent({ id: 'ev-pushed2', name: 'Mon Beau Mariage', origin: 'hub', status: 'loaded' });
    updateEventStatus('ev-pushed2', 'live');
    updateEventStatus('ev-pushed2', 'closed');
    updateEventStatus('ev-pushed2', 'pushed');

    const res = await request(app)
      .post('/api/sync/purge/ev-pushed2')
      .set('Authorization', `Bearer ${token}`)
      .send({ confirm: 'mauvais nom' });
    assert.equal(res.status, 400);
  });

  it('supprime le dossier physique et passe en purged', async () => {
    const eventId = 'ev-to-purge';
    insertEvent({ id: eventId, name: 'À Purger', origin: 'hub', status: 'loaded' });
    updateEventStatus(eventId, 'live');
    updateEventStatus(eventId, 'closed');
    updateEventStatus(eventId, 'pushed');

    // Crée le dossier physique
    const eventDir = join(dir, 'events', eventId);
    mkdirSync(join(eventDir, 'videos'), { recursive: true });
    writeFileSync(join(eventDir, 'videos', 'test.mp4'), 'fake video');
    assert.ok(existsSync(eventDir));

    const res = await request(app)
      .post(`/api/sync/purge/${eventId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ confirm: 'À Purger' });

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.ok(!existsSync(eventDir), 'le dossier doit être supprimé');

    const ev = getRegistry().prepare('SELECT * FROM local_events WHERE id = ?').get(eventId);
    assert.equal(ev.status, 'purged');
  });

  it('nettoie push_state après purge', async () => {
    const eventId = 'ev-purge-state';
    insertEvent({ id: eventId, name: 'Purge State', origin: 'hub', status: 'loaded' });
    updateEventStatus(eventId, 'live');
    updateEventStatus(eventId, 'closed');
    updateEventStatus(eventId, 'pushed');

    // Insère un push_state factice
    getRegistry().prepare(
      'INSERT INTO push_state (event_id, video_id, checksum, uploaded_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)'
    ).run(eventId, 'vid-1', 'abc123');

    const res = await request(app)
      .post(`/api/sync/purge/${eventId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ confirm: 'Purge State' });

    assert.equal(res.status, 200);
    const ps = getRegistry().prepare('SELECT * FROM push_state WHERE event_id = ?').get(eventId);
    assert.ok(!ps, 'push_state doit être supprimé');
  });

  it('retourne 401 sans token', async () => {
    const res = await request(app)
      .post('/api/sync/purge/ev-x')
      .send({ confirm: 'test' });
    assert.equal(res.status, 401);
  });
});
