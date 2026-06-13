import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openEventDb, closeEventDb, closeAllEventDbs, cacheSize,
} from '../src/eventStore.js';

let dir;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'kapsule-hub-store-'));
  // Pré-créer les répertoires events/<id>/ pour chaque test
});

after(() => {
  closeAllEventDbs();
  rmSync(dir, { recursive: true, force: true });
});

function makeEventDir(id) {
  mkdirSync(join(dir, 'events', id), { recursive: true });
}

describe('openEventDb', () => {
  it('crée la base et retourne un handle Database', () => {
    makeEventDir('evt-001');
    const db = openEventDb('evt-001', dir);
    assert.ok(db);
    assert.equal(typeof db.prepare, 'function');
  });

  it('retourne le même handle pour le même eventId (cache hit)', () => {
    makeEventDir('evt-002');
    const db1 = openEventDb('evt-002', dir);
    const db2 = openEventDb('evt-002', dir);
    assert.strictEqual(db1, db2);
  });

  it('initialise le schéma avec les tables attendues', () => {
    makeEventDir('evt-003');
    const db = openEventDb('evt-003', dir);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    assert.ok(tables.includes('questions'));
    assert.ok(tables.includes('sessions'));
    assert.ok(tables.includes('videos'));
  });

  it('évince le LRU quand on dépasse 10 handles', () => {
    // Vider le cache d'abord
    closeAllEventDbs();
    assert.equal(cacheSize(), 0);

    // Ouvrir 10 handles (evt-lru-0 à evt-lru-9)
    for (let i = 0; i < 10; i++) {
      makeEventDir(`evt-lru-${i}`);
      openEventDb(`evt-lru-${i}`, dir);
    }
    assert.equal(cacheSize(), 10);

    // L'ouverture d'un 11ème doit évincer le plus ancien (evt-lru-0)
    makeEventDir('evt-lru-10');
    openEventDb('evt-lru-10', dir);
    assert.equal(cacheSize(), 10);

    // evt-lru-0 a été éjecté : en le rouvrant on obtient un nouveau handle
    const db = openEventDb('evt-lru-0', dir);
    assert.ok(db); // nouveau handle valide
    assert.equal(cacheSize(), 10); // toujours 10 (evt-lru-1 éjecté)
  });
});

describe('closeEventDb', () => {
  it('retire le handle du cache sans erreur', () => {
    closeAllEventDbs();
    makeEventDir('evt-close-1');
    openEventDb('evt-close-1', dir);
    assert.equal(cacheSize(), 1);
    closeEventDb('evt-close-1');
    assert.equal(cacheSize(), 0);
  });

  it('est no-op pour un eventId absent du cache', () => {
    closeEventDb('evt-inconnu');
    assert.equal(cacheSize(), 0);
  });
});

describe('closeAllEventDbs', () => {
  it('vide complètement le cache', () => {
    closeAllEventDbs();
    makeEventDir('evt-all-1');
    makeEventDir('evt-all-2');
    openEventDb('evt-all-1', dir);
    openEventDb('evt-all-2', dir);
    assert.equal(cacheSize(), 2);
    closeAllEventDbs();
    assert.equal(cacheSize(), 0);
  });
});
