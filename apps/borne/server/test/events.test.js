import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createApp } from '../src/index.js';
import { closeRegistry, insertEvent, setActiveEvent, updateEventStatus } from '../src/registry.js';
import { closeEventDb } from '../src/eventDb.js';
import { createEventDb } from '@kapsule/core/src/eventDbSchema.js';
import { DEFAULTS } from '@kapsule/core';
import { _setPushRunning } from '../src/sync/push.js';
import { TEST_CFG, seedAuthUsers, loginAdmin, loginTech, clearSeedEvent } from './helpers.js';

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'borne-ev-'));
  const app = createApp(dir, { ...TEST_CFG, dataDir: dir });
  await seedAuthUsers(dir);
  const token = await loginAdmin(app, request);
  const techToken = await loginTech(app, request);
  clearSeedEvent(); // retire ev-seed pour ne pas polluer les tests "aucun event"
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

  test('requiresLogin = false si event non-preview', async () => {
    makeActiveEvent(ctx.dir, 'ev-no-preview', 'Evt No Preview');
    const res = await request(ctx.app).get('/api/event');
    assert.equal(res.status, 200);
    assert.equal(res.body.requiresLogin, false);
  });

  test('requiresLogin = true si preview + requires_login dans event_meta (§11.24)', async () => {
    const eventDir = join(ctx.dir, 'events', 'ev-preview-req');
    mkdirSync(join(eventDir, 'videos'), { recursive: true });
    const edb = createEventDb(join(eventDir, 'db.sqlite'));
    // pull.js écrit requires_login dans event_meta — les general ne sont plus dans event_users
    edb.prepare("INSERT OR REPLACE INTO event_meta (key, value) VALUES ('requires_login', 'true')").run();
    edb.close();
    insertEvent({ id: 'ev-preview-req', name: 'Evt Preview Req', origin: 'hub', status: 'loaded', is_preview: 1 });
    setActiveEvent('ev-preview-req');

    const res = await request(ctx.app).get('/api/event');
    assert.equal(res.status, 200);
    assert.equal(res.body.requiresLogin, true);
  });

  test('requiresLogin = false si preview mais aucun user general', async () => {
    makeActiveEvent(ctx.dir, 'ev-preview-no-general', 'Evt Preview No General');
    // Marquer comme preview sans user general
    const reg = (await import('../src/registry.js')).getRegistry();
    reg.prepare("UPDATE local_events SET is_preview = 1 WHERE id = 'ev-preview-no-general'").run();
    const res = await request(ctx.app).get('/api/event');
    assert.equal(res.status, 200);
    assert.equal(res.body.requiresLogin, false);
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

// ── Orientation + qualité vidéo ───────────────────────────────────────────────

describe('PUT /api/event/video-quality (qualité + orientation)', () => {
  let ctx;
  beforeEach(async () => { ctx = await setup(); });
  afterEach(() => teardown(ctx.dir));

  // Écrit directement dans event_meta (simule ce que le pull Hub dépose).
  function setMeta(id, key, value) {
    const edb = createEventDb(join(ctx.dir, 'events', id, 'db.sqlite'));
    edb.prepare('INSERT OR REPLACE INTO event_meta (key, value) VALUES (?, ?)').run(key, value);
    edb.close();
  }

  test('GET /api/event : défaut paysage quand rien n\'est réglé', async () => {
    makeActiveEvent(ctx.dir, 'ev-def');
    const res = await request(ctx.app).get('/api/event');
    assert.equal(res.status, 200);
    assert.equal(res.body.video_orientation, 'paysage');
    assert.equal(res.body.video_quality, 'standard');
    assert.equal(res.body.video_width, 1280);
    assert.equal(res.body.video_height, 720);
  });

  test('GET /api/event : orientation Hub (event_meta) appliquée → dimensions verticales', async () => {
    makeActiveEvent(ctx.dir, 'ev-meta');
    setMeta('ev-meta', 'video_orientation', 'portrait');
    const res = await request(ctx.app).get('/api/event');
    assert.equal(res.status, 200);
    assert.equal(res.body.video_orientation, 'portrait');
    assert.equal(res.body.video_width, 720);
    assert.equal(res.body.video_height, 1280);
    assert.ok(res.body.video_height > res.body.video_width);
  });

  test('override local prime sur le défaut Hub (event_meta)', async () => {
    makeActiveEvent(ctx.dir, 'ev-override');
    setMeta('ev-override', 'video_orientation', 'paysage');

    const put = await request(ctx.app)
      .put('/api/event/video-quality')
      .set('Authorization', `Bearer ${ctx.techToken}`)
      .send({ orientation: 'portrait' });
    assert.equal(put.status, 200);
    assert.equal(put.body.video_orientation, 'portrait');

    const res = await request(ctx.app).get('/api/event');
    assert.equal(res.body.video_orientation, 'portrait');
    assert.equal(res.body.video_height, 1280);
  });

  test('changer l\'orientation seule conserve la qualité déjà réglée', async () => {
    makeActiveEvent(ctx.dir, 'ev-partial');
    await request(ctx.app)
      .put('/api/event/video-quality')
      .set('Authorization', `Bearer ${ctx.techToken}`)
      .send({ quality: 'max' });

    const put = await request(ctx.app)
      .put('/api/event/video-quality')
      .set('Authorization', `Bearer ${ctx.techToken}`)
      .send({ orientation: 'portrait' });
    assert.equal(put.status, 200);
    assert.equal(put.body.video_quality, 'max');       // conservée
    assert.equal(put.body.video_orientation, 'portrait');
    assert.equal(put.body.width, 1080);                 // preset max portrait
    assert.equal(put.body.height, 1920);
  });

  test('orientation invalide → 400', async () => {
    makeActiveEvent(ctx.dir, 'ev-bad');
    const res = await request(ctx.app)
      .put('/api/event/video-quality')
      .set('Authorization', `Bearer ${ctx.techToken}`)
      .send({ orientation: 'diagonale' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Orientation invalide/);
  });

  test('qualité invalide → 400', async () => {
    makeActiveEvent(ctx.dir, 'ev-badq');
    const res = await request(ctx.app)
      .put('/api/event/video-quality')
      .set('Authorization', `Bearer ${ctx.techToken}`)
      .send({ quality: 'ultra' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Qualité invalide/);
  });

  test('body vide → 400', async () => {
    makeActiveEvent(ctx.dir, 'ev-empty');
    const res = await request(ctx.app)
      .put('/api/event/video-quality')
      .set('Authorization', `Bearer ${ctx.techToken}`)
      .send({});
    assert.equal(res.status, 400);
  });

  test('hors preview : sans token tech → 401', async () => {
    makeActiveEvent(ctx.dir, 'ev-guard');
    const res = await request(ctx.app)
      .put('/api/event/video-quality')
      .send({ orientation: 'portrait' });
    assert.equal(res.status, 401);
  });

  test('en preview : accessible sans token (borne d\'essai)', async () => {
    const eventDir = join(ctx.dir, 'events', 'ev-prev-orient');
    mkdirSync(join(eventDir, 'videos'), { recursive: true });
    createEventDb(join(eventDir, 'db.sqlite')).close();
    insertEvent({ id: 'ev-prev-orient', name: 'Preview', origin: 'hub', status: 'loaded', is_preview: 1 });
    setActiveEvent('ev-prev-orient');

    const res = await request(ctx.app)
      .put('/api/event/video-quality')
      .send({ orientation: 'portrait' });
    assert.equal(res.status, 200);
    assert.equal(res.body.video_orientation, 'portrait');
  });

  test('valeur corrompue en event_meta → GET retombe sur le défaut', async () => {
    makeActiveEvent(ctx.dir, 'ev-corrupt');
    setMeta('ev-corrupt', 'video_orientation', 'n\'importe quoi');
    const res = await request(ctx.app).get('/api/event');
    assert.equal(res.status, 200);
    assert.equal(res.body.video_orientation, 'paysage');
    assert.equal(res.body.video_width, 1280);
  });
});

// ── Design appliqué (§9bis) ───────────────────────────────────────────────────

describe('GET /api/event — design', () => {
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const LOGO = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b.png';

  // Applique un design (config en meta + fichier sur disque), comme le fait le pull.
  function applyDesign(dir, id, design, { withFile = true } = {}) {
    const db = createEventDb(join(dir, 'events', id, 'db.sqlite'));
    db.prepare("INSERT OR REPLACE INTO event_meta (key,value) VALUES ('design', ?)").run(JSON.stringify(design));
    db.close();
    if (withFile) {
      const designDir = join(dir, 'events', id, 'design');
      mkdirSync(designDir, { recursive: true });
      writeFileSync(join(designDir, LOGO), PNG);
    }
  }

  const DESIGN = {
    version: 1,
    colors: { bg: '#101020', accent: '#ff8800' },
    radius: 'round',
    font: 'serif',
    images: {
      start: { mode: 'cover', filename: LOGO },
      thanks: { mode: 'none', filename: null },
    },
  };

  test('expose le design, avec les images sous forme d\'URL', async () => {
    const { dir, app } = await setup();
    try {
      const id = makeEvent(dir, 'ev-design');
      setActiveEvent(id);
      applyDesign(dir, id, DESIGN);

      const res = await request(app).get('/api/event');
      assert.equal(res.status, 200);
      assert.equal(res.body.design.colors.bg, '#101020');
      assert.equal(res.body.design.radius, 'round');
      assert.equal(res.body.design.images.start.mode, 'cover');
      assert.equal(res.body.design.images.start.filename, `/api/event/design/${LOGO}`);
      assert.equal(res.body.design.images.thanks.mode, 'none');
      assert.equal(res.body.design.images.thanks.filename, null);
    } finally { teardown(dir); }
  });

  test('design null si aucun design appliqué (comportement d\'avant : thèmes)', async () => {
    const { dir, app } = await setup();
    try {
      const id = makeEvent(dir, 'ev-nodesign');
      setActiveEvent(id);

      const res = await request(app).get('/api/event');
      assert.equal(res.status, 200);
      assert.equal(res.body.design, null);
      assert.ok(res.body.theme, 'le thème figé reste exposé');
    } finally { teardown(dir); }
  });

  test('design corrompu → null, sans planter', async () => {
    const { dir, app } = await setup();
    try {
      const id = makeEvent(dir, 'ev-corrompu');
      setActiveEvent(id);
      const db = createEventDb(join(dir, 'events', id, 'db.sqlite'));
      db.prepare("INSERT OR REPLACE INTO event_meta (key,value) VALUES ('design', ?)").run('{ pas du json');
      db.close();

      const res = await request(app).get('/api/event');
      assert.equal(res.status, 200);
      assert.equal(res.body.design, null);
    } finally { teardown(dir); }
  });

  test('design invalide au regard du contrat → null (pas de config hostile servie)', async () => {
    const { dir, app } = await setup();
    try {
      const id = makeEvent(dir, 'ev-invalide');
      setActiveEvent(id);
      applyDesign(dir, id, { version: 1, colors: { bg: 'url(https://evil.test/x)' } }, { withFile: false });

      const res = await request(app).get('/api/event');
      assert.equal(res.status, 200);
      assert.equal(res.body.design, null);
    } finally { teardown(dir); }
  });
});

describe('GET /api/event/design/:filename', () => {
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const LOGO = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b.png';

  async function setupWithDesign() {
    const ctx = await setup();
    const id = makeEvent(ctx.dir, 'ev-assets');
    setActiveEvent(id);

    const db = createEventDb(join(ctx.dir, 'events', id, 'db.sqlite'));
    db.prepare("INSERT OR REPLACE INTO event_meta (key,value) VALUES ('design', ?)").run(JSON.stringify({
      version: 1, images: { start: { mode: 'centered', filename: LOGO }, thanks: { mode: 'none', filename: null } },
    }));
    db.close();

    const designDir = join(ctx.dir, 'events', id, 'design');
    mkdirSync(designDir, { recursive: true });
    writeFileSync(join(designDir, LOGO), PNG);
    // Fichier présent sur disque mais NON référencé par la config.
    writeFileSync(join(designDir, 'orphelin.png'), 'nope');

    return ctx;
  }

  test('sert l\'image référencée (public, sans auth)', async () => {
    const { dir, app } = await setupWithDesign();
    try {
      const res = await request(app).get(`/api/event/design/${LOGO}`);
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, PNG);
    } finally { teardown(dir); }
  });

  test('404 sur un fichier présent mais non référencé par la config', async () => {
    const { dir, app } = await setupWithDesign();
    try {
      const res = await request(app).get('/api/event/design/orphelin.png');
      assert.equal(res.status, 404);
    } finally { teardown(dir); }
  });

  test('404 sur une traversée de chemin (registry.sqlite hors de portée)', async () => {
    const { dir, app } = await setupWithDesign();
    try {
      for (const evil of ['..%2F..%2Fregistry.sqlite', '%2e%2e%2fdb.sqlite', '..%2Fdb.sqlite']) {
        const res = await request(app).get(`/api/event/design/${evil}`);
        assert.ok(res.status === 404 || res.status === 400, `${evil} → ${res.status}`);
      }
    } finally { teardown(dir); }
  });

  test('404 si aucun design appliqué', async () => {
    const { dir, app } = await setup();
    try {
      const id = makeEvent(dir, 'ev-sans-design');
      setActiveEvent(id);
      const res = await request(app).get(`/api/event/design/${LOGO}`);
      assert.equal(res.status, 404);
    } finally { teardown(dir); }
  });
});
