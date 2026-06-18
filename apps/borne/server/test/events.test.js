import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createApp } from '../src/index.js';
import { closeRegistry, insertEvent, setActiveEvent, updateEventStatus } from '../src/registry.js';
import { closeEventDb } from '../src/eventDb.js';
import { createEventDb } from '@kapsule/core/src/eventDbSchema.js';
import { DEFAULTS } from '@kapsule/core';
import { _setPushRunning } from '../src/sync/push.js';

const TEST_CFG = { adminPassword: 'test', techPassword: 'tech-test', jwtSecret: 'secret-test', dataDir: '' };

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'borne-ev-'));
  const app = createApp(dir, { ...TEST_CFG, dataDir: dir });
  const loginRes = await request(app).post('/api/admin/login').send({ password: 'test' });
  const token = loginRes.body.token;
  const techRes = await request(app).post('/api/admin/login').send({ password: 'tech-test' });
  const techToken = techRes.body.token;
  return { dir, app, token, techToken };
}

function teardown(dir) {
  closeEventDb();
  closeRegistry();
  rmSync(dir, { recursive: true });
}

// Crée un événement hub en statut 'loaded' avec sa structure disque.
function makeEvent(dir, id, name = 'Test Event') {
  const eventDir = join(dir, 'events', id);
  mkdirSync(join(eventDir, 'videos'), { recursive: true });
  const db = createEventDb(join(eventDir, 'db.sqlite'));
  db.prepare('INSERT OR IGNORE INTO event_meta (key,value) VALUES (?,?)').run('theme', DEFAULTS.THEME);
  db.prepare('INSERT OR IGNORE INTO event_meta (key,value) VALUES (?,?)').run('name', name);
  db.close();
  insertEvent({ id, name, origin: 'hub', status: 'loaded' });
  return id;
}

// Crée un événement et l'active.
function makeActiveEvent(dir, id, name = 'Test Event') {
  makeEvent(dir, id, name);
  setActiveEvent(id);
  return id;
}

// ── GET /api/events ───────────────────────────────────────────────────────────

describe('GET /api/events', () => {
  let ctx;
  beforeEach(async () => { ctx = await setup(); });
  afterEach(() => teardown(ctx.dir));

  test('retourne une liste vide au démarrage', async () => {
    const res = await request(ctx.app).get('/api/events').set('Authorization', `Bearer ${ctx.token}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, []);
  });

  test('retourne 401 sans token', async () => {
    const res = await request(ctx.app).get('/api/events');
    assert.equal(res.status, 401);
  });
});

// ── POST /api/events supprimé — 404 attendu ──────────────────────────────────

describe('POST /api/events', () => {
  let ctx;
  beforeEach(async () => { ctx = await setup(); });
  afterEach(() => teardown(ctx.dir));

  test('retourne 404 — création locale désactivée', async () => {
    const res = await request(ctx.app)
      .post('/api/events')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ name: 'Mariage Test' });
    assert.equal(res.status, 404);
  });
});

// ── PUT /api/events/:id/activate ─────────────────────────────────────────────

describe('PUT /api/events/:id/activate', () => {
  let ctx;
  beforeEach(async () => { ctx = await setup(); });
  afterEach(() => teardown(ctx.dir));

  test('active un événement existant', async () => {
    makeEvent(ctx.dir, 'ev-activate', 'Evt A');
    const res = await request(ctx.app)
      .put('/api/events/ev-activate/activate')
      .set('Authorization', `Bearer ${ctx.token}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.active, 1);
  });

  test('retourne 404 pour un id inexistant', async () => {
    const res = await request(ctx.app)
      .put('/api/events/inexistant/activate')
      .set('Authorization', `Bearer ${ctx.token}`);
    assert.equal(res.status, 404);
  });

  test('retourne 401 sans token', async () => {
    const res = await request(ctx.app).put('/api/events/x/activate');
    assert.equal(res.status, 401);
  });

  test('retourne 409 si un push est en cours (§6)', async () => {
    makeEvent(ctx.dir, 'ev-push', 'Evt push');
    _setPushRunning(true);
    try {
      const res = await request(ctx.app)
        .put('/api/events/ev-push/activate')
        .set('Authorization', `Bearer ${ctx.token}`);
      assert.equal(res.status, 409);
      assert.match(res.body.error, /push/i);
    } finally {
      _setPushRunning(false);
    }
  });
});

// ── PUT /api/events/:id/close ─────────────────────────────────────────────────

describe('PUT /api/events/:id/close', () => {
  let ctx;
  beforeEach(async () => { ctx = await setup(); });
  afterEach(() => teardown(ctx.dir));

  test('clôture un événement live (tech token)', async () => {
    makeEvent(ctx.dir, 'ev-live', 'Evt Live');
    updateEventStatus('ev-live', 'live');
    const res = await request(ctx.app)
      .put('/api/events/ev-live/close')
      .set('Authorization', `Bearer ${ctx.techToken}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'closed');
  });

  test('retourne 403 avec un token client (§11.19)', async () => {
    makeEvent(ctx.dir, 'ev-403', 'Evt 403');
    updateEventStatus('ev-403', 'live');
    const res = await request(ctx.app)
      .put('/api/events/ev-403/close')
      .set('Authorization', `Bearer ${ctx.token}`);
    assert.equal(res.status, 403);
  });

  test('retourne 409 si l\'événement n\'est pas live', async () => {
    makeEvent(ctx.dir, 'ev-loaded', 'Evt Loaded');
    const res = await request(ctx.app)
      .put('/api/events/ev-loaded/close')
      .set('Authorization', `Bearer ${ctx.techToken}`);
    assert.equal(res.status, 409);
  });

  test('retourne 404 pour un id inexistant', async () => {
    const res = await request(ctx.app)
      .put('/api/events/inexistant/close')
      .set('Authorization', `Bearer ${ctx.techToken}`);
    assert.equal(res.status, 404);
  });
});

// ── GET /api/event (public) ───────────────────────────────────────────────────

describe('GET /api/event', () => {
  let ctx;
  beforeEach(async () => { ctx = await setup(); });
  afterEach(() => teardown(ctx.dir));

  test('retourne 404 si aucun événement actif', async () => {
    const res = await request(ctx.app).get('/api/event');
    assert.equal(res.status, 404);
  });

  test('retourne l\'événement actif avec consent_text et idle_timeout', async () => {
    makeActiveEvent(ctx.dir, 'ev-public', 'Evt Public');
    const res = await request(ctx.app).get('/api/event');
    assert.equal(res.status, 200);
    assert.equal(res.body.id, 'ev-public');
    assert.equal(res.body.name, 'Evt Public');
    assert.ok(res.body.consent_text);
    assert.ok(typeof res.body.idle_timeout === 'number');
  });

  test('accessible sans token (route publique)', async () => {
    makeActiveEvent(ctx.dir, 'ev-public2', 'Evt Public 2');
    const res = await request(ctx.app).get('/api/event');
    assert.equal(res.status, 200);
  });
});

// ── PUT /api/events/:id/settings (thème) ─────────────────────────────────────

describe('PUT /api/events/:id/settings', () => {
  let ctx;
  beforeEach(async () => { ctx = await setup(); });
  afterEach(() => teardown(ctx.dir));

  test('écrit le thème et le relit via GET /event', async () => {
    makeActiveEvent(ctx.dir, 'ev-theme', 'Evt Thème');
    const put = await request(ctx.app)
      .put('/api/events/ev-theme/settings')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ theme: 'dark' });
    assert.equal(put.status, 200);
    assert.equal(put.body.theme, 'dark');
    const get = await request(ctx.app).get('/api/event');
    assert.equal(get.body.theme, 'dark');
  });

  test('accepte le thème modern', async () => {
    makeActiveEvent(ctx.dir, 'ev-modern', 'Evt Modern');
    const put = await request(ctx.app)
      .put('/api/events/ev-modern/settings')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ theme: 'modern' });
    assert.equal(put.status, 200);
    assert.equal(put.body.theme, 'modern');
  });

  test('thème par défaut = cute à la création', async () => {
    makeActiveEvent(ctx.dir, 'ev-default', 'Evt Défaut');
    const get = await request(ctx.app).get('/api/event');
    assert.equal(get.body.theme, 'cute');
  });

  test('retourne 400 pour un thème invalide', async () => {
    makeActiveEvent(ctx.dir, 'ev-invalid', 'Evt Invalide');
    const res = await request(ctx.app)
      .put('/api/events/ev-invalid/settings')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ theme: 'neon' });
    assert.equal(res.status, 400);
  });

  test('retourne 409 si l\'événement n\'est pas actif', async () => {
    makeEvent(ctx.dir, 'ev-inactive', 'Evt Inactif');
    const put = await request(ctx.app)
      .put('/api/events/ev-inactive/settings')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ theme: 'dark' });
    assert.equal(put.status, 409);
  });

  test('retourne 404 pour un id inexistant', async () => {
    const res = await request(ctx.app)
      .put('/api/events/inexistant/settings')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ theme: 'cute' });
    assert.equal(res.status, 404);
  });

  test('retourne 401 sans token', async () => {
    const res = await request(ctx.app)
      .put('/api/events/x/settings')
      .send({ theme: 'cute' });
    assert.equal(res.status, 401);
  });

  test('écrit name_prompt et le relit via GET /event', async () => {
    makeActiveEvent(ctx.dir, 'ev-name-prompt', 'Evt Name Prompt');
    const put = await request(ctx.app)
      .put('/api/events/ev-name-prompt/settings')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ name_prompt: 'Quel est votre prénom ?' });
    assert.equal(put.status, 200);
    assert.equal(put.body.name_prompt, 'Quel est votre prénom ?');
    const get = await request(ctx.app).get('/api/event');
    assert.equal(get.body.name_prompt, 'Quel est votre prénom ?');
  });

  test('écrit thanks_text et le relit via GET /event', async () => {
    makeActiveEvent(ctx.dir, 'ev-thanks', 'Evt Thanks');
    await request(ctx.app)
      .put('/api/events/ev-thanks/settings')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ thanks_text: 'Merci infiniment !' });
    const get = await request(ctx.app).get('/api/event');
    assert.equal(get.body.thanks_text, 'Merci infiniment !');
  });

  test('écrit consent_details et le relit via GET /event', async () => {
    makeActiveEvent(ctx.dir, 'ev-consent', 'Evt Consent Details');
    const details = 'Vos données sont stockées 30 jours.';
    await request(ctx.app)
      .put('/api/events/ev-consent/settings')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ consent_details: details });
    const get = await request(ctx.app).get('/api/event');
    assert.equal(get.body.consent_details, details);
  });

  test('écrit welcome_title et le relit', async () => {
    makeActiveEvent(ctx.dir, 'ev-welcome', 'Evt Welcome');
    await request(ctx.app)
      .put('/api/events/ev-welcome/settings')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ welcome_title: 'Bienvenue à la soirée !' });
    const get = await request(ctx.app).get('/api/event');
    assert.equal(get.body.welcome_title, 'Bienvenue à la soirée !');
  });

  test('welcome_title dynamique = nom event quand non défini', async () => {
    makeActiveEvent(ctx.dir, 'ev-dyn-title', 'Mon Mariage');
    const get = await request(ctx.app).get('/api/event');
    assert.equal(get.body.welcome_title, 'Mon Mariage');
  });

  test('welcome_subtitle dynamique = 1ère ligne du consent quand non défini', async () => {
    makeActiveEvent(ctx.dir, 'ev-dyn-subtitle', 'Evt Subtitle');
    const get = await request(ctx.app).get('/api/event');
    const { DEFAULTS: D } = await import('@kapsule/core');
    const expected = D.CONSENT_TEXT.split('\n')[0];
    assert.equal(get.body.welcome_subtitle, expected);
  });

  test('retourne 400 si un champ texte dépasse TEXT_FIELD_MAX', async () => {
    const { TEXT_FIELD_MAX: MAX } = await import('@kapsule/core');
    makeActiveEvent(ctx.dir, 'ev-long', 'Evt Long');
    const res = await request(ctx.app)
      .put('/api/events/ev-long/settings')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ name_prompt: 'x'.repeat(MAX + 1) });
    assert.equal(res.status, 400);
  });

  test('retourne 400 si un champ texte n\'est pas une chaîne', async () => {
    makeActiveEvent(ctx.dir, 'ev-type', 'Evt Type');
    const res = await request(ctx.app)
      .put('/api/events/ev-type/settings')
      .set('Authorization', `Bearer ${ctx.token}`)
      .send({ thanks_text: 42 });
    assert.equal(res.status, 400);
  });
});

// ── GET /api/preflight ────────────────────────────────────────────────────────

describe('GET /api/preflight', () => {
  let ctx;
  beforeEach(async () => { ctx = await setup(); });
  afterEach(() => teardown(ctx.dir));

  test('retourne la structure attendue sans événement actif (tech token)', async () => {
    const res = await request(ctx.app)
      .get('/api/preflight')
      .set('Authorization', `Bearer ${ctx.techToken}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.event.loaded, false);
    assert.equal(res.body.questions_count, 0);
    assert.equal(typeof res.body.disk_ok, 'boolean');
    assert.equal(res.body.clock_ok, null);
  });

  test('retourne 403 avec un token client (§11.19)', async () => {
    const res = await request(ctx.app)
      .get('/api/preflight')
      .set('Authorization', `Bearer ${ctx.token}`);
    assert.equal(res.status, 403);
  });

  test('clock_ok=true si ?client_time proche de now', async () => {
    const clientTime = new Date().toISOString();
    const res = await request(ctx.app)
      .get(`/api/preflight?client_time=${encodeURIComponent(clientTime)}`)
      .set('Authorization', `Bearer ${ctx.techToken}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.clock_ok, true);
  });

  test('clock_ok=false si ?client_time très décalé', async () => {
    const past = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const res = await request(ctx.app)
      .get(`/api/preflight?client_time=${encodeURIComponent(past)}`)
      .set('Authorization', `Bearer ${ctx.techToken}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.clock_ok, false);
  });

  test('retourne 401 sans token', async () => {
    const res = await request(ctx.app).get('/api/preflight');
    assert.equal(res.status, 401);
  });
});
