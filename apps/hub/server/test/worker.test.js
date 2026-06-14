import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { openRegistry, getDb, closeRegistry } from '../src/registry.js';
import { closeAllEventDbs } from '../src/eventStore.js';
import {
  recoverOrphans,
  claimNextJob,
  maybeMarkProcessed,
  processJob,
  _setHandlers,
} from '../src/worker/index.js';

let dataDir;
let db;

before(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'kapsule-worker-'));
  db = openRegistry(dataDir);

  // Injecte des handlers de substitution pour éviter de charger archiver (4.2)
  _setHandlers({
    probe: async (job) => {
      if (job.video_id === 'vid-absent') throw new Error('Vidéo introuvable');
    },
    thumbnail: async () => {},
    archive: async () => {},
  });

  // Crée un user et un événement minimal dans le registre
  db.prepare(`INSERT INTO users (id, email, password_hash) VALUES (1, 'test@test.com', 'x')`).run();
  db.prepare(`
    INSERT INTO events (id, owner_id, name, status)
    VALUES ('ev1', 1, 'Test Event', 'pushed')
  `).run();
});

after(() => {
  closeAllEventDbs();
  closeRegistry();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('recoverOrphans', () => {
  test('remet les jobs running en pending', () => {
    db.prepare(`INSERT INTO jobs (event_id, type, status) VALUES ('ev1', 'probe', 'running')`).run();
    db.prepare(`INSERT INTO jobs (event_id, type, status) VALUES ('ev1', 'probe', 'running')`).run();
    db.prepare(`INSERT INTO jobs (event_id, type, status) VALUES ('ev1', 'probe', 'pending')`).run();

    recoverOrphans(db);

    const running = db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE status = 'running'`).get();
    const pending = db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE status = 'pending'`).get();
    assert.equal(running.n, 0);
    assert.ok(pending.n >= 3);

    db.prepare(`DELETE FROM jobs`).run();
  });
});

describe('claimNextJob', () => {
  test('retourne null si aucun job pending', () => {
    const job = claimNextJob(db);
    assert.equal(job, null);
  });

  test('prend le plus ancien job pending et le passe en running', () => {
    db.prepare(`INSERT INTO jobs (id, event_id, type, status, created_at) VALUES (100, 'ev1', 'probe', 'pending', '2024-01-01 10:00:00')`).run();
    db.prepare(`INSERT INTO jobs (id, event_id, type, status, created_at) VALUES (101, 'ev1', 'thumbnail', 'pending', '2024-01-01 11:00:00')`).run();

    const job = claimNextJob(db);
    assert.equal(job.id, 100);
    assert.equal(job.type, 'probe');

    const inDb = db.prepare(`SELECT status FROM jobs WHERE id = 100`).get();
    assert.equal(inDb.status, 'running');

    const second = db.prepare(`SELECT status FROM jobs WHERE id = 101`).get();
    assert.equal(second.status, 'pending');

    db.prepare(`DELETE FROM jobs WHERE id IN (100, 101)`).run();
  });
});

describe('maybeMarkProcessed', () => {
  test('passe l\'événement en processed quand tous les jobs sont done', () => {
    db.prepare(`INSERT INTO jobs (event_id, type, status) VALUES ('ev1', 'probe', 'done')`).run();
    db.prepare(`INSERT INTO jobs (event_id, type, status) VALUES ('ev1', 'thumbnail', 'done')`).run();

    maybeMarkProcessed(db, 'ev1');

    const ev = db.prepare(`SELECT status FROM events WHERE id = 'ev1'`).get();
    assert.equal(ev.status, 'processed');

    db.prepare(`DELETE FROM jobs`).run();
    db.prepare(`UPDATE events SET status = 'pushed' WHERE id = 'ev1'`).run();
  });

  test('ne passe pas en processed si un job est encore pending', () => {
    db.prepare(`INSERT INTO jobs (event_id, type, status) VALUES ('ev1', 'probe', 'done')`).run();
    db.prepare(`INSERT INTO jobs (event_id, type, status) VALUES ('ev1', 'thumbnail', 'pending')`).run();

    maybeMarkProcessed(db, 'ev1');

    const ev = db.prepare(`SELECT status FROM events WHERE id = 'ev1'`).get();
    assert.equal(ev.status, 'pushed');

    db.prepare(`DELETE FROM jobs`).run();
  });

  test('ne passe pas en processed si un job est failed', () => {
    db.prepare(`INSERT INTO jobs (event_id, type, status) VALUES ('ev1', 'probe', 'done')`).run();
    db.prepare(`INSERT INTO jobs (event_id, type, status, error) VALUES ('ev1', 'thumbnail', 'failed', 'err')`).run();

    maybeMarkProcessed(db, 'ev1');

    const ev = db.prepare(`SELECT status FROM events WHERE id = 'ev1'`).get();
    assert.equal(ev.status, 'pushed');

    db.prepare(`DELETE FROM jobs`).run();
  });
});

describe('processJob', () => {
  test('marque failed si le type de job est inconnu', async () => {
    const info = db.prepare(`INSERT INTO jobs (event_id, type, status) VALUES ('ev1', 'inconnu', 'running')`).run();
    const jobId = info.lastInsertRowid;
    const job = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(jobId);

    await processJob(db, job, dataDir);

    const updated = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(jobId);
    assert.equal(updated.status, 'failed');
    assert.ok(updated.error.includes('inconnu'));

    db.prepare(`DELETE FROM jobs WHERE id = ?`).run(jobId);
  });

  test('marque done si le handler réussit', async () => {
    const info = db.prepare(`INSERT INTO jobs (event_id, video_id, type, status) VALUES ('ev1', 'vid1', 'thumbnail', 'running')`).run();
    const jobId = info.lastInsertRowid;
    const job = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(jobId);

    await processJob(db, job, dataDir);

    const updated = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(jobId);
    assert.equal(updated.status, 'done');
    assert.equal(updated.error, null);

    db.prepare(`DELETE FROM jobs WHERE id = ?`).run(jobId);
    db.prepare(`UPDATE events SET status = 'pushed' WHERE id = 'ev1'`).run();
  });

  test('marque failed si le handler lève une erreur', async () => {
    const info = db.prepare(`INSERT INTO jobs (event_id, video_id, type, status) VALUES ('ev1', 'vid-absent', 'probe', 'running')`).run();
    const jobId = info.lastInsertRowid;
    const job = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(jobId);

    await processJob(db, job, dataDir);

    const updated = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(jobId);
    assert.equal(updated.status, 'failed');
    assert.ok(updated.error != null);

    db.prepare(`DELETE FROM jobs WHERE id = ?`).run(jobId);
  });
});
