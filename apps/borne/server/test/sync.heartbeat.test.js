import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openRegistry, closeRegistry, insertEvent, setActiveEvent } from '../src/registry.js';
import { closeEventDb } from '../src/eventDb.js';
import { config } from '../src/config.js';
import { beat, startHeartbeat, stopHeartbeat } from '../src/sync/heartbeat.js';

describe('heartbeat — beat()', () => {
  let dir;
  let savedFetch;
  const origHubUrl = config.hubUrl;
  const origBorneToken = config.borneToken;

  before(() => {
    savedFetch = globalThis.fetch;
    config.hubUrl = 'https://hub.test';
    config.borneToken = 'physical-borne-tok'; // le heartbeat est le chemin borne physique
  });

  after(() => {
    globalThis.fetch = savedFetch;
    config.hubUrl = origHubUrl;
    config.borneToken = origBorneToken;
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'borne-heartbeat-'));
    openRegistry(dir);
  });

  afterEach(() => {
    stopHeartbeat();
    closeEventDb();
    closeRegistry();
    rmSync(dir, { recursive: true, force: true });
  });

  it('envoie agent_version, disque, borne_time_ms et active_event_id', async () => {
    insertEvent({ id: 'ev-active', name: 'Actif', origin: 'hub', status: 'loaded' });
    setActiveEvent('ev-active');

    let captured;
    globalThis.fetch = async (url, opts) => {
      captured = { url: String(url), body: JSON.parse(opts.body) };
      return { ok: true, status: 200, json: async () => ({ commands: [] }) };
    };

    await beat(dir);

    assert.ok(captured.url.endsWith('/sync/borne/heartbeat'));
    assert.equal(captured.body.active_event_id, 'ev-active');
    assert.equal(typeof captured.body.borne_time_ms, 'number');
    assert.ok(!('clock_skew_ms' in captured.body), 'la borne ne doit jamais calculer/envoyer le skew elle-même (§11.16)');
    assert.ok('disk' in captured.body);
  });

  it('exécute les commandes reçues et poste leur résultat', async () => {
    insertEvent({ id: 'ev-to-activate', name: 'À activer', origin: 'hub', status: 'loaded' });

    const posted = [];
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      if (u.endsWith('/sync/borne/heartbeat')) {
        return {
          ok: true, status: 200,
          json: async () => ({ commands: [{ id: 42, type: 'activate_event', payload: { event_id: 'ev-to-activate' } }] }),
        };
      }
      if (u.includes('/sync/borne/commands/42/result')) {
        posted.push(JSON.parse(opts.body));
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      throw new Error(`URL inattendue dans le test : ${u}`);
    };

    await beat(dir);

    assert.equal(posted.length, 1);
    assert.equal(posted[0].status, 'done');
    assert.equal(posted[0].result.activated, 'ev-to-activate');
  });

  it('ne lève jamais si le Hub est injoignable (best-effort, offline-first)', async () => {
    globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
    // Patch setTimeout pour ne pas attendre les 5 tentatives de retry de hubFetch
    const origSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn) => { fn(); return 0; };
    try {
      await assert.doesNotReject(() => beat(dir));
    } finally {
      globalThis.setTimeout = origSetTimeout;
    }
  });

  it('un échec de POST du résultat de commande n\'interrompt pas le battement', async () => {
    insertEvent({ id: 'ev-x', name: 'X', origin: 'hub', status: 'loaded' });
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.endsWith('/sync/borne/heartbeat')) {
        return { ok: true, status: 200, json: async () => ({ commands: [{ id: 7, type: 'activate_event', payload: { event_id: 'ev-x' } }] }) };
      }
      return { ok: false, status: 500, json: async () => ({ error: 'boom' }) };
    };
    await assert.doesNotReject(() => beat(dir));
  });
});

describe('heartbeat — startHeartbeat/stopHeartbeat', () => {
  let dir;
  const origHubUrl = config.hubUrl;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'borne-heartbeat-loop-'));
    openRegistry(dir);
  });

  afterEach(() => {
    stopHeartbeat();
    closeEventDb();
    closeRegistry();
    rmSync(dir, { recursive: true, force: true });
    config.hubUrl = origHubUrl;
  });

  it('démarrer deux fois ne crée pas deux intervalles concurrents', () => {
    const origSetInterval = globalThis.setInterval;
    let calls = 0;
    globalThis.setInterval = (...args) => { calls++; return origSetInterval(...args); };
    try {
      startHeartbeat(dir);
      startHeartbeat(dir);
      assert.equal(calls, 1, 'le second appel doit être un no-op');
    } finally {
      globalThis.setInterval = origSetInterval;
    }
  });

  it('stopHeartbeat permet de redémarrer proprement', () => {
    const origSetInterval = globalThis.setInterval;
    let calls = 0;
    globalThis.setInterval = (...args) => { calls++; return origSetInterval(...args); };
    try {
      startHeartbeat(dir);
      stopHeartbeat();
      startHeartbeat(dir);
      assert.equal(calls, 2);
    } finally {
      globalThis.setInterval = origSetInterval;
    }
  });
});
