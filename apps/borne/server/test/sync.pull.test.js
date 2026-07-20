import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';

import { openRegistry, closeRegistry, getRegistry, insertEvent } from '../src/registry.js';
import { closeEventDb } from '../src/eventDb.js';
import { config } from '../src/config.js';

// Importer les modules sous test au top-level (ESM cache stable)
import { hubFetch, hubFetchJson } from '../src/sync/hubClient.js';
import { pullEvent, pullMyEvent } from '../src/sync/pull.js';

// ── hubClient ──────────────────────────────────────────────────────────────────

describe('hubClient — hubFetch / hubFetchJson', () => {
  let savedFetch;
  const origHubUrl = config.hubUrl;
  const origBoxToken = config.boxToken;

  before(() => {
    savedFetch = globalThis.fetch;
    config.hubUrl = 'https://hub.test';
    config.boxToken = 'test-token-abc';
  });

  after(() => {
    globalThis.fetch = savedFetch;
    config.hubUrl = origHubUrl;
    config.boxToken = origBoxToken;
  });

  it('envoie X-Box-Token dans le header', async () => {
    let capturedHeaders;
    globalThis.fetch = async (url, opts) => {
      capturedHeaders = opts?.headers ?? {};
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };
    await hubFetch('/api/sync/assigned');
    assert.equal(capturedHeaders['X-Box-Token'], 'test-token-abc');
  });

  it('compose l\'URL complète avec hubUrl', async () => {
    let capturedUrl;
    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return { ok: true, status: 200, json: async () => ({}) };
    };
    await hubFetch('/api/sync/assigned');
    assert.equal(capturedUrl, 'https://hub.test/api/sync/assigned');
  });

  it('hubFetchJson lève si statut >= 400 avec le code HTTP', async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: async () => ({ error: 'Token borne invalide' }),
    });
    await assert.rejects(
      () => hubFetchJson('/api/sync/assigned'),
      (err) => { assert.equal(err.status, 401); return true; }
    );
  });

  it('hubFetchJson retourne le body parsé si ok', async () => {
    globalThis.fetch = async () => ({
      ok: true, status: 200,
      json: async () => [{ id: 'ev-1', status: 'ready' }],
    });
    const result = await hubFetchJson('/api/sync/assigned');
    assert.deepEqual(result, [{ id: 'ev-1', status: 'ready' }]);
  });

  it('retente 5 fois sur erreur réseau puis lève', async () => {
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error('Network error'); };

    // On patch setTimeout pour ne pas attendre le backoff réel
    const origSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn) => { fn(); return 0; };

    try {
      await assert.rejects(
        () => hubFetchJson('/api/sync/test'),
        (err) => { assert.match(err.message, /tentatives échouées/); return true; }
      );
      assert.equal(calls, 5, 'doit tenter exactement 5 fois');
    } finally {
      globalThis.setTimeout = origSetTimeout;
    }
  });
});

// ── pull.js — pullEvent ────────────────────────────────────────────────────────

describe('pull — pullEvent', () => {
  let dir;
  let savedFetch;
  const origHubUrl = config.hubUrl;
  const origBoxToken = config.boxToken;

  const BUNDLE = {
    event: { id: 'hub-ev-1', name: 'Mariage Test', status: 'loaded', meta: { consent_text: 'Je consens', idle_timeout: '90' } },
    questions: [
      { id: 1, text: 'Question A', max_duration: 60, countdown: 3, order_index: 0, enabled: 1 },
      { id: 2, text: 'Question B', max_duration: 90, countdown: 3, order_index: 1, enabled: 1 },
    ],
  };

  before(() => {
    savedFetch = globalThis.fetch;
    config.hubUrl = 'https://hub.test';
    config.boxToken = 'tok';
  });

  after(() => {
    globalThis.fetch = savedFetch;
    config.hubUrl = origHubUrl;
    config.boxToken = origBoxToken;
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'borne-pull-'));
    openRegistry(dir);
    globalThis.fetch = async () => ({
      ok: true, status: 200,
      json: async () => BUNDLE,
    });
  });

  afterEach(() => {
    closeEventDb();
    closeRegistry();
    rmSync(dir, { recursive: true, force: true });
  });

  it('crée le dossier events/<id>/ et db.sqlite', async () => {
    await pullEvent('hub-ev-1', dir);
    assert.ok(existsSync(join(dir, 'events', 'hub-ev-1')));
    assert.ok(existsSync(join(dir, 'events', 'hub-ev-1', 'db.sqlite')));
  });

  it('insère l\'événement dans local_events avec pulled_at', async () => {
    await pullEvent('hub-ev-1', dir);
    const ev = getRegistry().prepare('SELECT * FROM local_events WHERE id = ?').get('hub-ev-1');
    assert.ok(ev);
    assert.equal(ev.origin, 'hub');
    assert.equal(ev.status, 'loaded');
    assert.ok(ev.pulled_at, 'pulled_at doit être défini');
  });

  it('écrit les questions dans la BD événement', async () => {
    await pullEvent('hub-ev-1', dir);
    const edb = new Database(join(dir, 'events', 'hub-ev-1', 'db.sqlite'));
    const questions = edb.prepare('SELECT * FROM questions ORDER BY order_index').all();
    edb.close();
    assert.equal(questions.length, 2);
    assert.equal(questions[0].text, 'Question A');
    assert.equal(questions[1].text, 'Question B');
  });

  it('écrit event_meta dans la BD événement', async () => {
    await pullEvent('hub-ev-1', dir);
    const edb = new Database(join(dir, 'events', 'hub-ev-1', 'db.sqlite'));
    const meta = Object.fromEntries(
      edb.prepare('SELECT key, value FROM event_meta').all().map(r => [r.key, r.value])
    );
    edb.close();
    assert.equal(meta.consent_text, 'Je consens');
    assert.equal(meta.idle_timeout, '90');
  });

  it('§11.10 — ignore le pull si statut local n\'est pas loaded', async () => {
    // Insère en statut 'loaded' puis force 'live' (bypass CHECK via PRAGMA)
    getRegistry().pragma('writable_schema = OFF');
    insertEvent({ id: 'hub-ev-1', name: 'Test', origin: 'hub', status: 'loaded' });
    // Mettre manuellement à live via UPDATE sans CHECK (better-sqlite3 applique le CHECK au niveau SQL)
    // On utilise status 'live' directement — la registry Borne accepte 'live' dans le CHECK
    getRegistry().prepare("UPDATE local_events SET status='live' WHERE id='hub-ev-1'").run();

    const result = await pullEvent('hub-ev-1', dir);
    assert.ok(result.skipped);
    assert.match(result.reason, /live/);
  });

  it('re-pull écrase les questions si statut est loaded', async () => {
    await pullEvent('hub-ev-1', dir);

    globalThis.fetch = async () => ({
      ok: true, status: 200,
      json: async () => ({
        event: { ...BUNDLE.event, meta: {} },
        questions: [{ id: 99, text: 'Nouvelle question', max_duration: 30, countdown: 3, order_index: 0, enabled: 1 }],
      }),
    });

    await pullEvent('hub-ev-1', dir);

    const edb = new Database(join(dir, 'events', 'hub-ev-1', 'db.sqlite'));
    const questions = edb.prepare('SELECT * FROM questions').all();
    edb.close();
    assert.equal(questions.length, 1);
    assert.equal(questions[0].text, 'Nouvelle question');
  });

  it('écrit bundle.users dans event_users de la BD événement', async () => {
    globalThis.fetch = async () => ({
      ok: true, status: 200,
      json: async () => ({
        ...BUNDLE,
        users: [
          { email: 'alice@test.com', password_hash: '$argon2id$v=19$test', roles: ['admin_borne'] },
          { email: 'bob@test.com',   password_hash: '$argon2id$v=19$test2', roles: ['tech_borne', 'general'] },
        ],
      }),
    });

    await pullEvent('hub-ev-1', dir);

    const edb = new Database(join(dir, 'events', 'hub-ev-1', 'db.sqlite'));
    const users = edb.prepare('SELECT * FROM event_users ORDER BY email').all();
    edb.close();

    assert.equal(users.length, 2);
    assert.equal(users[0].email, 'alice@test.com');
    assert.equal(users[0].password_hash, '$argon2id$v=19$test');
    assert.deepEqual(JSON.parse(users[0].roles), ['admin_borne']);
    assert.equal(users[1].email, 'bob@test.com');
    assert.deepEqual(JSON.parse(users[1].roles), ['tech_borne', 'general']);
  });

  it('re-pull écrase event_users (DELETE+INSERT)', async () => {
    // Premier pull avec alice
    globalThis.fetch = async () => ({
      ok: true, status: 200,
      json: async () => ({
        ...BUNDLE,
        users: [{ email: 'alice@test.com', password_hash: '$argon2id$hash1', roles: ['admin_borne'] }],
      }),
    });
    await pullEvent('hub-ev-1', dir);

    // Second pull sans alice (liste vide)
    globalThis.fetch = async () => ({
      ok: true, status: 200,
      json: async () => ({ ...BUNDLE, users: [] }),
    });
    await pullEvent('hub-ev-1', dir);

    const edb = new Database(join(dir, 'events', 'hub-ev-1', 'db.sqlite'));
    const users = edb.prepare('SELECT * FROM event_users').all();
    edb.close();
    assert.equal(users.length, 0, 'event_users doit être vide après pull sans users');
  });
});

// ── pull.js — pullMyEvent ─────────────────────────────────────────────────────

describe('pull — pullMyEvent', () => {
  let dir;
  let savedFetch;
  const origHubUrl = config.hubUrl;
  const origBoxToken = config.boxToken;

  before(() => {
    savedFetch = globalThis.fetch;
    config.hubUrl = 'https://hub.test';
    config.boxToken = 'tok';
  });

  after(() => {
    globalThis.fetch = savedFetch;
    config.hubUrl = origHubUrl;
    config.boxToken = origBoxToken;
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'borne-assigned-'));
    openRegistry(dir);
  });

  afterEach(() => {
    closeEventDb();
    closeRegistry();
    rmSync(dir, { recursive: true, force: true });
  });

  it("pull l'événement lié au token s'il est absent localement", async () => {
    globalThis.fetch = async (url) => {
      // GET /api/sync/event (exact : pas de /events/ pluriel, pas de /bundle)
      if (url.endsWith('/sync/event')) {
        return { ok: true, status: 200, json: async () => ({ id: 'ev-A', name: 'Event A', status: 'ready', is_preview: 0 }) };
      }
      // GET /api/sync/events/:id/bundle
      return { ok: true, status: 200, json: async () => ({
        event: { id: 'ev-A', name: 'Event A', meta: {} }, questions: [],
      })};
    };
    const count = await pullMyEvent(dir);
    assert.equal(count, 1);
    assert.ok(getRegistry().prepare('SELECT * FROM local_events WHERE id = ?').get('ev-A'));
  });

  it('ne pull pas un event déjà en statut live (§11.10)', async () => {
    insertEvent({ id: 'ev-live', name: 'Live Event', origin: 'hub', status: 'loaded' });
    getRegistry().prepare("UPDATE local_events SET status='live' WHERE id='ev-live'").run();

    let bundleCalled = false;
    globalThis.fetch = async (url) => {
      if (url.endsWith('/sync/event')) {
        return { ok: true, status: 200, json: async () => ({ id: 'ev-live', status: 'loaded' }) };
      }
      bundleCalled = true;
      return { ok: true, status: 200, json: async () => ({ event: { id: 'ev-live', meta: {} }, questions: [] }) };
    };

    const count = await pullMyEvent(dir);
    assert.equal(count, 0);
    assert.ok(!bundleCalled, 'le bundle ne doit pas être appelé pour un event live');
  });

  it("retourne 0 si aucun événement pullable (404 Hub)", async () => {
    globalThis.fetch = async () => ({
      ok: false, status: 404, json: async () => ({ error: 'Aucun événement pullable' }),
    });
    const count = await pullMyEvent(dir);
    assert.equal(count, 0);
  });
});

// ── Assets du design (§9bis) ──────────────────────────────────────────────────
//
// Seul contenu binaire du bundle : téléchargé fichier par fichier et vérifié par
// checksum. Un mismatch fait ÉCHOUER le pull (invariant §11.27) — mieux vaut pas
// de design du tout qu'une image corrompue servie au kiosque.

describe('pull — assets du design', () => {
  let dir;
  let savedFetch;
  const origHubUrl = config.hubUrl;
  const origBoxToken = config.boxToken;

  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  // sha256 du buffer ci-dessus.
  const PNG_SHA = createHash('sha256').update(PNG).digest('hex');
  const LOGO = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b.png';

  const bundleWith = (design_assets, design) => ({
    event: {
      id: 'hub-ev-1',
      name: 'Événement design',
      status: 'loaded',
      meta: design ? { design: JSON.stringify(design) } : {},
    },
    questions: [],
    design_assets,
  });

  // Répond le JSON du bundle sur /bundle, le PNG sur /design/<filename>.
  function mockHub(bundle, { corrupt = false } = {}) {
    globalThis.fetch = async (url) => {
      if (String(url).includes('/design/')) {
        const body = corrupt ? Buffer.from('contenu corrompu') : PNG;
        return {
          ok: true, status: 200,
          arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
        };
      }
      return { ok: true, status: 200, json: async () => bundle };
    };
  }

  before(() => {
    savedFetch = globalThis.fetch;
    config.hubUrl = 'https://hub.test';
    config.boxToken = 'tok';
  });

  after(() => {
    globalThis.fetch = savedFetch;
    config.hubUrl = origHubUrl;
    config.boxToken = origBoxToken;
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'borne-pull-design-'));
    openRegistry(dir);
  });

  afterEach(() => {
    closeEventDb();
    closeRegistry();
    rmSync(dir, { recursive: true, force: true });
  });

  const designWithLogo = {
    version: 1,
    colors: { bg: '#ffffff' },
    images: { start: { mode: 'centered', filename: LOGO }, thanks: { mode: 'none', filename: null } },
  };

  it('télécharge les images et vérifie leur checksum', async () => {
    mockHub(bundleWith([{ filename: LOGO, size: PNG.length, checksum: PNG_SHA }], designWithLogo));

    const res = await pullEvent('hub-ev-1', dir);
    assert.equal(res.ok, true);

    const file = join(dir, 'events', 'hub-ev-1', 'design', LOGO);
    assert.ok(existsSync(file), 'l\'image doit être téléchargée');
    assert.deepEqual(readFileSync(file), PNG);

    // La config du design arrive par event_meta (le bundle la porte comme le reste).
    const edb = new Database(join(dir, 'events', 'hub-ev-1', 'db.sqlite'));
    const raw = edb.prepare("SELECT value FROM event_meta WHERE key='design'").get()?.value;
    edb.close();
    assert.equal(JSON.parse(raw).images.start.filename, LOGO);
  });

  it('un checksum invalide fait ÉCHOUER le pull et ne laisse aucun fichier', async () => {
    mockHub(bundleWith([{ filename: LOGO, size: PNG.length, checksum: PNG_SHA }], designWithLogo), { corrupt: true });

    await assert.rejects(
      () => pullEvent('hub-ev-1', dir),
      (err) => {
        assert.match(err.message, /[Cc]hecksum/);
        return true;
      },
    );

    // Aucun fichier corrompu ne doit subsister.
    assert.ok(!existsSync(join(dir, 'events', 'hub-ev-1', 'design', LOGO)));
  });

  it('un pull sans design vide le dossier d\'un design précédent', async () => {
    // 1er pull : avec design.
    mockHub(bundleWith([{ filename: LOGO, size: PNG.length, checksum: PNG_SHA }], designWithLogo));
    await pullEvent('hub-ev-1', dir);
    assert.ok(existsSync(join(dir, 'events', 'hub-ev-1', 'design', LOGO)));

    // 2e pull : le design a été retiré côté Hub.
    mockHub(bundleWith([], null));
    await pullEvent('hub-ev-1', dir);

    assert.ok(!existsSync(join(dir, 'events', 'hub-ev-1', 'design', LOGO)), 'l\'ancienne image doit disparaître');
  });

  it('rejette un filename de traversée dans le bundle (jamais d\'écriture hors du dossier)', async () => {
    // Un Hub compromis ne doit pas pouvoir écraser db.sqlite via un filename piégé.
    mockHub(bundleWith([{ filename: '../db.sqlite', size: 4, checksum: 'x' }], designWithLogo));

    await assert.rejects(() => pullEvent('hub-ev-1', dir), /invalide|interrompu/i);

    // La base de l'événement doit être intacte (lisible).
    const edb = new Database(join(dir, 'events', 'hub-ev-1', 'db.sqlite'));
    assert.doesNotThrow(() => edb.prepare('SELECT 1').get());
    edb.close();
  });

  it('un checksum invalide retire event_meta.design (pas de design aux images 404)', async () => {
    mockHub(bundleWith([{ filename: LOGO, size: PNG.length, checksum: PNG_SHA }], designWithLogo), { corrupt: true });

    await assert.rejects(() => pullEvent('hub-ev-1', dir), /[Cc]hecksum/);

    // Après l'échec, la clé design ne doit pas subsister (sinon GET /api/event
    // servirait un design dont les images sont absentes).
    const edb = new Database(join(dir, 'events', 'hub-ev-1', 'db.sqlite'));
    const raw = edb.prepare("SELECT value FROM event_meta WHERE key='design'").get();
    edb.close();
    assert.equal(raw, undefined);
  });

  it('un bundle sans design_assets (Hub non migré) ne casse pas le pull', async () => {
    globalThis.fetch = async () => ({
      ok: true, status: 200,
      json: async () => ({
        event: { id: 'hub-ev-1', name: 'Sans design', status: 'loaded', meta: {} },
        questions: [],
        // pas de champ design_assets du tout
      }),
    });

    const res = await pullEvent('hub-ev-1', dir);
    assert.equal(res.ok, true);
  });
});
