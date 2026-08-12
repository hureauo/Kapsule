import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  openRegistry, closeRegistry,
  getActiveEvent, listEvents, insertEvent, setActiveEvent, updateEventStatus,
  getSetting, setSetting,
} from '../src/registry.js';
import { getActiveEventDb, closeEventDb } from '../src/eventDb.js';

// ─── registry.js ─────────────────────────────────────────────────────────────

describe('registry', () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'borne-reg-'));
    openRegistry(dir);
  });

  afterEach(() => {
    closeEventDb();
    closeRegistry();
    rmSync(dir, { recursive: true });
  });

  test('crée les tables au premier appel', () => {
    const db = openRegistry(dir); // idempotent
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all().map(r => r.name);
    assert.ok(tables.includes('local_events'));
    assert.ok(tables.includes('push_state'));
    assert.ok(tables.includes('borne_settings'));
  });

  test('openRegistry est idempotent — retourne le même handle', () => {
    const db1 = openRegistry(dir);
    const db2 = openRegistry(dir);
    assert.equal(db1, db2);
  });

  test('getActiveEvent retourne null si aucun événement actif', () => {
    assert.equal(getActiveEvent(), null);
  });

  test('insertEvent + getActiveEvent', () => {
    insertEvent({ id: 'evt-1', name: 'Mariage', origin: 'local' });
    setActiveEvent('evt-1');
    const ev = getActiveEvent();
    assert.equal(ev.id, 'evt-1');
    assert.equal(ev.name, 'Mariage');
    assert.equal(ev.active, 1);
  });

  test('setActiveEvent désactive les autres événements', () => {
    insertEvent({ id: 'evt-a', name: 'A', origin: 'local' });
    insertEvent({ id: 'evt-b', name: 'B', origin: 'local' });
    setActiveEvent('evt-a');
    setActiveEvent('evt-b');
    const active = getActiveEvent();
    assert.equal(active.id, 'evt-b');
    const all = listEvents();
    const evtA = all.find(e => e.id === 'evt-a');
    assert.equal(evtA.active, 0);
  });

  test('updateEventStatus met à jour le statut', () => {
    insertEvent({ id: 'evt-s', name: 'Status', origin: 'local' });
    updateEventStatus('evt-s', 'live');
    const ev = listEvents().find(e => e.id === 'evt-s');
    assert.equal(ev.status, 'live');
  });

  test('listEvents retourne tous les événements', () => {
    insertEvent({ id: 'e1', name: 'Un', origin: 'local' });
    insertEvent({ id: 'e2', name: 'Deux', origin: 'hub' });
    assert.equal(listEvents().length, 2);
  });
});

// ─── borne_settings (identité persistante, Phase B) ─────────────────────────

describe('registry — borne_settings', () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'borne-settings-'));
    openRegistry(dir);
  });

  afterEach(() => {
    closeRegistry();
    rmSync(dir, { recursive: true });
  });

  test('getSetting retourne null pour une clé absente', () => {
    assert.equal(getSetting('borne_token'), null);
  });

  test('setSetting puis getSetting retourne la valeur', () => {
    setSetting('borne_token', 'abc123');
    assert.equal(getSetting('borne_token'), 'abc123');
  });

  test('setSetting écrase une valeur existante (upsert)', () => {
    setSetting('borne_token', 'ancien');
    setSetting('borne_token', 'nouveau');
    assert.equal(getSetting('borne_token'), 'nouveau');
  });

  test('deux clés distinctes ne se marchent pas dessus', () => {
    setSetting('borne_token', 'tok');
    setSetting('hub_url', 'https://hub.test');
    assert.equal(getSetting('borne_token'), 'tok');
    assert.equal(getSetting('hub_url'), 'https://hub.test');
  });
});

// ─── eventDb.js ──────────────────────────────────────────────────────────────

describe('eventDb', () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'borne-evdb-'));
    openRegistry(dir);
  });

  afterEach(() => {
    closeEventDb();
    closeRegistry();
    rmSync(dir, { recursive: true });
  });

  test('retourne null si pas d\'événement actif', () => {
    assert.equal(getActiveEventDb(dir, null), null);
  });

  test('ouvre et met en cache la BD de l\'événement actif', () => {
    const eventId = 'evt-cache-1';
    mkdirSync(join(dir, 'events', eventId), { recursive: true });
    const activeEvent = { id: eventId };
    const db1 = getActiveEventDb(dir, activeEvent);
    const db2 = getActiveEventDb(dir, activeEvent);
    assert.ok(db1 !== null);
    assert.equal(db1, db2, 'doit retourner le même handle (cache)');
  });

  test('invalide le cache quand l\'événement actif change', () => {
    const id1 = 'evt-swap-1';
    const id2 = 'evt-swap-2';
    mkdirSync(join(dir, 'events', id1), { recursive: true });
    mkdirSync(join(dir, 'events', id2), { recursive: true });
    const db1 = getActiveEventDb(dir, { id: id1 });
    const db2 = getActiveEventDb(dir, { id: id2 });
    assert.notEqual(db1, db2, 'doit ouvrir une nouvelle connexion');
  });

  test('la BD ouverte a les bonnes tables (createEventDb appliqué)', () => {
    const eventId = 'evt-tables';
    mkdirSync(join(dir, 'events', eventId), { recursive: true });
    const db = getActiveEventDb(dir, { id: eventId });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all().map(r => r.name);
    assert.ok(tables.includes('questions'));
    assert.ok(tables.includes('sessions'));
    assert.ok(tables.includes('videos'));
  });
});
