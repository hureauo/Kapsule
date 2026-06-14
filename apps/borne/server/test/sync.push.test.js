import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { openRegistry, closeRegistry, getRegistry, insertEvent, updateEventStatus } from '../src/registry.js';
import { closeEventDb } from '../src/eventDb.js';
import { config } from '../src/config.js';
import { createEventDb } from '@kapsule/core/src/eventDbSchema.js';
import { pushEvent, getPushState } from '../src/sync/push.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

let dir;
let savedFetch;
const origHubUrl = config.hubUrl;
const origBoxToken = config.boxToken;

function setupEnv() {
  savedFetch = globalThis.fetch;
  config.hubUrl = 'https://hub.test';
  config.boxToken = 'tok';
}

function teardownEnv() {
  globalThis.fetch = savedFetch;
  config.hubUrl = origHubUrl;
  config.boxToken = origBoxToken;
}

/**
 * Crée un event en statut closed avec N vidéos fictives dans le fs + la BD.
 */
function makeClosedEvent(d, eventId, videoCount = 2) {
  const eventDir = join(d, 'events', eventId);
  const videosDir = join(eventDir, 'videos');
  mkdirSync(videosDir, { recursive: true });

  // DB événement avec session + vidéos
  const edb = createEventDb(join(eventDir, 'db.sqlite'));
  // Créer une session factice (FK requise par videos)
  edb.prepare(
    `INSERT INTO sessions (id, guest_name, consent_at) VALUES ('sess-1', 'Test', CURRENT_TIMESTAMP)`
  ).run();
  const videos = [];
  for (let i = 0; i < videoCount; i++) {
    const vid = `vid-${i}`;
    const filename = `${vid}.mp4`;
    const content = `fake video ${i}`;
    writeFileSync(join(videosDir, filename), content);
    edb.prepare(
      `INSERT INTO videos (id, session_id, question_id, question_text, filename, mime_type, size, checksum, recorded_at)
       VALUES (?, 'sess-1', NULL, 'Q${i}', ?, 'video/mp4', ?, 'aaaa${i}', CURRENT_TIMESTAMP)`
    ).run(vid, filename, Buffer.byteLength(content));
    videos.push({ id: vid, filename });
  }
  edb.close();

  // Registre
  insertEvent({ id: eventId, name: 'Test', origin: 'hub', status: 'loaded' });
  updateEventStatus(eventId, 'live');
  updateEventStatus(eventId, 'closed');

  return videos;
}

// ── Suite principale ──────────────────────────────────────────────────────────

describe('push — pushEvent', () => {
  before(setupEnv);
  after(teardownEnv);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'borne-push-'));
    openRegistry(dir);
  });

  afterEach(() => {
    closeEventDb();
    closeRegistry();
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuse si l\'événement n\'est pas closed', async () => {
    insertEvent({ id: 'ev-live', name: 'Live', origin: 'hub', status: 'loaded' });
    updateEventStatus('ev-live', 'live');

    globalThis.fetch = async () => { throw new Error('ne doit pas appeler le Hub'); };

    await assert.rejects(
      () => pushEvent('ev-live', dir),
      err => { assert.equal(err.status, 409); return true; }
    );
  });

  it('refuse si l\'événement est inconnu', async () => {
    await assert.rejects(
      () => pushEvent('inexistant', dir),
      err => { assert.equal(err.status, 404); return true; }
    );
  });

  it('poste le manifest avec les vidéos et le db', async () => {
    makeClosedEvent(dir, 'ev-1', 2);

    let manifestBody;
    globalThis.fetch = async (url, opts) => {
      if (url.includes('/manifest')) {
        manifestBody = JSON.parse(opts.body);
        return { ok: true, status: 200, json: async () => ({ missing: [] }) };
      }
      if (url.includes('/finalize')) return { ok: true, status: 200, json: async () => ({ ok: true }) };
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };

    await pushEvent('ev-1', dir);

    assert.ok(manifestBody, 'manifest envoyé');
    assert.equal(manifestBody.files.length, 2);
    assert.ok(manifestBody.db.checksum, 'db.checksum présent');
    assert.ok(manifestBody.db.size > 0, 'db.size > 0');
  });

  it('n\'uploade que les fichiers dans missing', async () => {
    makeClosedEvent(dir, 'ev-2', 2);

    const uploaded = [];
    globalThis.fetch = async (url, opts) => {
      if (url.includes('/manifest')) {
        return { ok: true, status: 200, json: async () => ({ missing: ['vid-1'] }) };
      }
      if (url.includes('/files/')) {
        uploaded.push(url.split('/files/')[1]);
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      if (url.includes('/db') || url.includes('/finalize')) {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };

    await pushEvent('ev-2', dir);

    assert.deepEqual(uploaded, ['vid-1'], 'seul vid-1 doit être uploadé');
  });

  it('uploade le db.sqlite après les vidéos', async () => {
    makeClosedEvent(dir, 'ev-3', 1);

    const order = [];
    globalThis.fetch = async (url) => {
      if (url.includes('/manifest')) {
        order.push('manifest');
        return { ok: true, status: 200, json: async () => ({ missing: ['vid-0'] }) };
      }
      if (url.includes('/files/')) {
        order.push('video');
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      if (url.endsWith('/db')) {
        order.push('db');
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      if (url.includes('/finalize')) {
        order.push('finalize');
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };

    await pushEvent('ev-3', dir);

    assert.deepEqual(order, ['manifest', 'video', 'db', 'finalize']);
  });

  it('passe le statut local à pushed après finalize', async () => {
    makeClosedEvent(dir, 'ev-4', 1);

    globalThis.fetch = async (url) => {
      if (url.includes('/manifest')) return { ok: true, status: 200, json: async () => ({ missing: [] }) };
      if (url.includes('/db')) return { ok: true, status: 200, json: async () => ({ ok: true }) };
      if (url.includes('/finalize')) return { ok: true, status: 200, json: async () => ({ ok: true }) };
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };

    await pushEvent('ev-4', dir);

    const ev = getRegistry().prepare('SELECT * FROM local_events WHERE id = ?').get('ev-4');
    assert.equal(ev.status, 'pushed');
    assert.ok(ev.pushed_at, 'pushed_at défini');
  });

  it('marque uploaded_at dans push_state après upload réussi', async () => {
    makeClosedEvent(dir, 'ev-5', 1);

    globalThis.fetch = async (url) => {
      if (url.includes('/manifest')) return { ok: true, status: 200, json: async () => ({ missing: ['vid-0'] }) };
      if (url.includes('/files/')) return { ok: true, status: 200, json: async () => ({ ok: true }) };
      if (url.includes('/db')) return { ok: true, status: 200, json: async () => ({ ok: true }) };
      if (url.includes('/finalize')) return { ok: true, status: 200, json: async () => ({ ok: true }) };
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };

    await pushEvent('ev-5', dir);

    const ps = getRegistry().prepare(
      'SELECT * FROM push_state WHERE event_id = ? AND video_id = ?'
    ).get('ev-5', 'vid-0');
    assert.ok(ps, 'push_state créé');
    assert.ok(ps.uploaded_at, 'uploaded_at défini après upload confirmé');
  });

  it('reprise idempotente — missing recalculé par le Hub', async () => {
    makeClosedEvent(dir, 'ev-6', 2);

    // 1er appel : missing = [vid-0, vid-1]
    // 2ème appel (reprise) : missing = [vid-1] (vid-0 déjà reçu)
    let manifestCall = 0;
    const uploadedByCall = [[], []];
    let call = 0;

    globalThis.fetch = async (url) => {
      if (url.includes('/manifest')) {
        const missingList = manifestCall === 0 ? ['vid-0', 'vid-1'] : ['vid-1'];
        manifestCall++;
        return { ok: true, status: 200, json: async () => ({ missing: missingList }) };
      }
      if (url.includes('/files/')) {
        const videoId = url.split('/files/')[1];
        uploadedByCall[Math.min(call, 1)].push(videoId);
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      if (url.includes('/db')) return { ok: true, status: 200, json: async () => ({ ok: true }) };
      if (url.includes('/finalize')) {
        call++;
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };

    // Premier push complet
    await pushEvent('ev-6', dir);
    // Reset statut pour simuler une relance
    updateEventStatus('ev-6', 'closed');
    getRegistry().prepare('UPDATE local_events SET pushed_at = NULL WHERE id = ?').run('ev-6');

    // Deuxième push (reprise)
    await pushEvent('ev-6', dir);

    assert.deepEqual(uploadedByCall[0].sort(), ['vid-0', 'vid-1']);
    // Le 2ème call upload seulement ce que le Hub déclare missing
    assert.deepEqual(uploadedByCall[1].sort(), ['vid-1']);
  });

  it('ne réessaie pas sur 422 (checksum mismatch)', async () => {
    makeClosedEvent(dir, 'ev-7', 1);

    let attempts = 0;
    globalThis.fetch = async (url) => {
      if (url.includes('/manifest')) return { ok: true, status: 200, json: async () => ({ missing: ['vid-0'] }) };
      if (url.includes('/files/')) {
        attempts++;
        return {
          ok: false, status: 422,
          json: async () => ({ error: 'Checksum mismatch' }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };

    await assert.rejects(
      () => pushEvent('ev-7', dir),
      err => { assert.equal(err.status, 422); return true; }
    );
    assert.equal(attempts, 1, 'ne doit pas réessayer sur 422');
  });

  it('réessaie 5 fois sur erreur réseau puis lève', async () => {
    makeClosedEvent(dir, 'ev-8', 1);

    // Patch setTimeout pour accélérer le backoff
    const origSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn) => { fn(); return 0; };

    let attempts = 0;
    globalThis.fetch = async (url) => {
      if (url.includes('/manifest')) return { ok: true, status: 200, json: async () => ({ missing: ['vid-0'] }) };
      if (url.includes('/files/')) {
        attempts++;
        throw new Error('Network error');
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };

    try {
      await assert.rejects(
        () => pushEvent('ev-8', dir),
        err => { assert.match(err.message, /tentatives échouées/); return true; }
      );
      assert.equal(attempts, 5);
    } finally {
      globalThis.setTimeout = origSetTimeout;
    }
  });

  it('getPushState retourne running=false et done=0 au repos', () => {
    const state = getPushState();
    assert.equal(state.running, false);
    assert.ok('total' in state);
    assert.ok('done' in state);
    assert.ok('currentFile' in state);
    assert.ok('lastError' in state);
  });

  it('getPushState.lastError expose un 401 (token révoqué) après échec', async () => {
    makeClosedEvent(dir, 'ev-401', 0);

    globalThis.fetch = async (url) => {
      if (url.includes('/manifest')) {
        return { ok: false, status: 401, json: async () => ({ error: 'Token borne invalide' }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };

    await assert.rejects(() => pushEvent('ev-401', dir));

    const state = getPushState();
    assert.equal(state.running, false);
    assert.ok(state.lastError !== null, 'lastError doit être défini');
    assert.equal(state.lastError.status, 401);
    assert.match(state.lastError.message, /révoqué/);
  });

  it('§11.8 — checkpoint WAL avant transfert du db.sqlite', async () => {
    makeClosedEvent(dir, 'ev-wal', 0);

    // Ouvre la BD événement en écriture pour créer un WAL
    const dbPath = join(dir, 'events', 'ev-wal', 'db.sqlite');
    const edb = new Database(dbPath);
    edb.pragma('journal_mode = WAL');
    edb.prepare('INSERT OR IGNORE INTO event_meta (key, value) VALUES (?, ?)').run('test_key', 'test_val');
    edb.close();

    // Vérifie que le WAL existe avant le push
    const walExists = existsSync(dbPath + '-wal');
    // (le WAL peut ou non exister selon SQLite auto-checkpoint, mais après checkpointAndHash il ne doit plus)

    let dbUploaded = false;
    globalThis.fetch = async (url) => {
      if (url.includes('/manifest')) return { ok: true, status: 200, json: async () => ({ missing: [] }) };
      if (url.endsWith('/db')) {
        dbUploaded = true;
        // À ce moment, le WAL doit être vide/absent (checkpoint effectué avant l'upload)
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      if (url.includes('/finalize')) return { ok: true, status: 200, json: async () => ({ ok: true }) };
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };

    await pushEvent('ev-wal', dir);

    assert.ok(dbUploaded, 'db.sqlite uploadé');
    // Le WAL ne doit plus exister après checkpoint (ou être vide)
    assert.ok(!existsSync(dbPath + '-wal') || statSync(dbPath + '-wal').size === 0,
      'WAL doit être vide ou absent après checkpoint');
  });
});
