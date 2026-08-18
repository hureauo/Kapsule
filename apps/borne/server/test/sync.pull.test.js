import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';

import { openRegistry, closeRegistry, getRegistry, insertEvent, getActiveEvent, setActiveEvent } from '../src/registry.js';
import { closeEventDb } from '../src/eventDb.js';
import { config } from '../src/config.js';

// Importer les modules sous test au top-level (ESM cache stable)
import { hubFetch, hubFetchJson } from '../src/sync/hubClient.js';
import { pullEvent, pullMyEvent, pullMyEvents } from '../src/sync/pull.js';

// ── hubClient ──────────────────────────────────────────────────────────────────

describe('hubClient — hubFetch / hubFetchJson', () => {
  let savedFetch;
  const origHubUrl = config.hubUrl;
  const origBoxToken = config.boxToken;
  const origBorneToken = config.borneToken;

  before(() => {
    savedFetch = globalThis.fetch;
    config.hubUrl = 'https://hub.test';
    config.boxToken = 'test-token-abc';
  });

  after(() => {
    globalThis.fetch = savedFetch;
    config.hubUrl = origHubUrl;
    config.boxToken = origBoxToken;
    config.borneToken = origBorneToken;
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

  it('Phase B — préfère config.borneToken à config.boxToken (identité de borne physique)', async () => {
    config.borneToken = 'physical-borne-token';
    let capturedHeaders;
    globalThis.fetch = async (url, opts) => {
      capturedHeaders = opts?.headers ?? {};
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };
    try {
      await hubFetch('/api/sync/borne/events');
      assert.equal(capturedHeaders['X-Box-Token'], 'physical-borne-token', 'une borne physique ne doit jamais envoyer un token vide/preview');
    } finally {
      config.borneToken = '';
    }
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

  it('ignore un bundle.users éventuel — event_users reste vide (admin_borne/tech_borne passés au PIN partagé)', async () => {
    globalThis.fetch = async () => ({
      ok: true, status: 200,
      json: async () => ({
        ...BUNDLE,
        // Champ historique, ignoré s'il est encore envoyé par un vieux Hub.
        users: [{ email: 'alice@test.com', password_hash: '$argon2id$v=19$test', roles: ['tech_borne'] }],
      }),
    });

    await pullEvent('hub-ev-1', dir);

    const edb = new Database(join(dir, 'events', 'hub-ev-1', 'db.sqlite'));
    const users = edb.prepare('SELECT * FROM event_users').all();
    edb.close();
    assert.equal(users.length, 0);
  });

  it('écrit admin_pin/tech_pin depuis bundle.event.meta dans event_meta', async () => {
    globalThis.fetch = async () => ({
      ok: true, status: 200,
      json: async () => ({
        ...BUNDLE,
        event: { ...BUNDLE.event, meta: { admin_pin: '111111', tech_pin: '222222' } },
      }),
    });

    await pullEvent('hub-ev-1', dir);

    const edb = new Database(join(dir, 'events', 'hub-ev-1', 'db.sqlite'));
    const meta = Object.fromEntries(edb.prepare('SELECT key, value FROM event_meta').all().map(r => [r.key, r.value]));
    edb.close();
    assert.equal(meta.admin_pin, '111111');
    assert.equal(meta.tech_pin, '222222');
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

// ── pull.js — pullMyEvents (Phase B — bornes physiques, plusieurs événements) ──

describe('pull — pullMyEvents', () => {
  let dir;
  let savedFetch;
  const origHubUrl = config.hubUrl;
  const origBorneToken = config.borneToken;

  function bundleFor(id, name = `Event ${id}`) {
    return { event: { id, name, meta: {} }, questions: [] };
  }

  before(() => {
    savedFetch = globalThis.fetch;
    config.hubUrl = 'https://hub.test';
    // Phase B : pullMyEvents est le chemin BORNE PHYSIQUE — config.borneToken,
    // pas config.boxToken (réservé aux previews). Utiliser le mauvais champ ici
    // masquerait une régression sur l'en-tête envoyé (cf. hubClient.js).
    config.borneToken = 'physical-borne-tok';
  });

  after(() => {
    globalThis.fetch = savedFetch;
    config.hubUrl = origHubUrl;
    config.borneToken = origBorneToken;
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'borne-pull-many-'));
    openRegistry(dir);
  });

  afterEach(() => {
    closeEventDb();
    closeRegistry();
    rmSync(dir, { recursive: true, force: true });
  });

  it('pullEvent seul ne pose plus active=1 (Phase B — activation retirée du cœur du pull)', async () => {
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => bundleFor('ev-solo') });
    await pullEvent('ev-solo', dir);
    assert.equal(getActiveEvent(), null, 'pullEvent seul ne doit jamais activer un événement');
  });

  it('pulle plusieurs événements assignés en une passe', async () => {
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/sync/borne/events')) {
        return { ok: true, status: 200, json: async () => ({ events: [{ id: 'ev-a', status: 'ready' }, { id: 'ev-b', status: 'ready' }] }) };
      }
      const id = String(url).includes('ev-a') ? 'ev-a' : 'ev-b';
      return { ok: true, status: 200, json: async () => bundleFor(id) };
    };

    const { pulled, results } = await pullMyEvents(dir);
    assert.equal(pulled, 2);
    assert.equal(results.filter(r => r.ok).length, 2);
    assert.ok(getRegistry().prepare('SELECT * FROM local_events WHERE id = ?').get('ev-a'));
    assert.ok(getRegistry().prepare('SELECT * FROM local_events WHERE id = ?').get('ev-b'));
  });

  it('active automatiquement le seul événement pullé si aucun n\'était actif (bootstrap)', async () => {
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/sync/borne/events')) {
        return { ok: true, status: 200, json: async () => ({ events: [{ id: 'ev-unique', status: 'ready' }] }) };
      }
      return { ok: true, status: 200, json: async () => bundleFor('ev-unique') };
    };

    await pullMyEvents(dir);
    assert.equal(getActiveEvent()?.id, 'ev-unique');
  });

  it('NE choisit PAS d\'actif si plusieurs événements sont pullés (choix explicite requis)', async () => {
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/sync/borne/events')) {
        return { ok: true, status: 200, json: async () => ({ events: [{ id: 'ev-a', status: 'ready' }, { id: 'ev-b', status: 'ready' }] }) };
      }
      const id = String(url).includes('ev-a') ? 'ev-a' : 'ev-b';
      return { ok: true, status: 200, json: async () => bundleFor(id) };
    };

    await pullMyEvents(dir);
    assert.equal(getActiveEvent(), null, 'ambigu entre 2 événements — reste à un humain de choisir');
  });

  it('ne bascule jamais un événement déjà actif au profit d\'un nouveau pull (§11.10)', async () => {
    insertEvent({ id: 'ev-live', name: 'En cours', origin: 'hub', status: 'loaded' });
    getRegistry().prepare("UPDATE local_events SET status='live' WHERE id='ev-live'").run();
    setActiveEvent('ev-live');

    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/sync/borne/events')) {
        return { ok: true, status: 200, json: async () => ({ events: [{ id: 'ev-live', status: 'loaded' }, { id: 'ev-new', status: 'ready' }] }) };
      }
      return { ok: true, status: 200, json: async () => bundleFor('ev-new') };
    };

    const { pulled, results } = await pullMyEvents(dir);
    assert.equal(pulled, 1, 'seul ev-new doit être pullé, ev-live est ignoré (déjà live)');
    assert.ok(results.find(r => r.eventId === 'ev-live')?.skipped);
    assert.equal(getActiveEvent().id, 'ev-live', 'l\'événement live doit rester actif');
  });

  it('retourne pulled:0 si la route répond 400 (token preview envoyé par erreur)', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: 'Route réservée aux bornes physiques' }) });
    const { pulled, results } = await pullMyEvents(dir);
    assert.equal(pulled, 0);
    assert.deepEqual(results, []);
  });

  it('consigne les échecs individuels sans interrompre les autres pulls', async () => {
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/sync/borne/events')) {
        return { ok: true, status: 200, json: async () => ({ events: [{ id: 'ev-ok', status: 'ready' }, { id: 'ev-ko', status: 'ready' }] }) };
      }
      if (String(url).includes('ev-ko')) {
        return { ok: false, status: 500, json: async () => ({ error: 'boom' }) };
      }
      return { ok: true, status: 200, json: async () => bundleFor('ev-ok') };
    };

    const { pulled, results } = await pullMyEvents(dir);
    assert.equal(pulled, 1);
    assert.ok(results.find(r => r.eventId === 'ev-ok')?.ok);
    assert.equal(results.find(r => r.eventId === 'ev-ko')?.ok, false);
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

  // Régression : POST /sync/onboarding/pair (routes/sync.js) verrouille aussi
  // sur "au moins une ligne local_events" (second signal, en plus de
  // borne_settings.paired_at — couvre une borne mise à niveau). Si pullEvent()
  // insérait la ligne AVANT les assets de design, un premier appairage dont le
  // pull échoue sur un checksum laisserait une ligne orpheline : le second
  // essai (avec un token corrigé) recevrait 403 alors qu'aucun PIN n'a jamais
  // existé — verrouillage sans issue. La ligne ne doit donc apparaître qu'APRÈS
  // un pull complet et réussi.
  it('un checksum invalide ne laisse aucune ligne local_events (pas de verrouillage sans issue)', async () => {
    mockHub(bundleWith([{ filename: LOGO, size: PNG.length, checksum: PNG_SHA }], designWithLogo), { corrupt: true });

    await assert.rejects(() => pullEvent('hub-ev-1', dir), /[Cc]hecksum/);

    const row = getRegistry().prepare('SELECT 1 FROM local_events WHERE id = ?').get('hub-ev-1');
    assert.equal(row, undefined);
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
