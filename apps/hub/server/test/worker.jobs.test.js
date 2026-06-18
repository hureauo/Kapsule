import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { openRegistry, getDb, closeRegistry } from '../src/registry.js';
import { openEventDb, closeAllEventDbs } from '../src/eventStore.js';
import { runProbe } from '../src/worker/jobs/probe.js';
import { runThumbnail } from '../src/worker/jobs/thumbnail.js';
import { runArchive } from '../src/worker/jobs/archive.js';

const EVENT_ID = 'ev-jobs-test';
const VIDEO_ID = 'vid-001';
const SESSION_ID = 'sess-001';

let dataDir;
let db;
let edb;
let realVideoPath; // défini si ffmpeg peut générer une vidéo de test

before(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'kapsule-jobs-'));
  db = openRegistry(dataDir);

  db.prepare(`INSERT INTO users (id, email, password_hash) VALUES (1, 'test@test.com', 'x')`).run();
  db.prepare(`INSERT INTO events (id, name, status) VALUES (?, 'Test', 'pushed')`)
    .run(EVENT_ID);

  const videosDir = join(dataDir, 'events', EVENT_ID, 'videos');
  mkdirSync(videosDir, { recursive: true });

  // Tente de générer une vraie vidéo décodable si ffmpeg est disponible
  const testMp4 = join(videosDir, 'test.mp4');
  const gen = spawnSync('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', 'color=black:s=64x64:d=1',
    '-t', '1', '-an', testMp4,
  ]);
  if (gen.status === 0) {
    realVideoPath = testMp4;
  } else {
    // Fallback : fichier dummy (tests ffmpeg seront skippés)
    writeFileSync(testMp4, Buffer.from('DUMMY'));
  }

  edb = openEventDb(EVENT_ID, dataDir);

  edb.prepare(`INSERT INTO sessions (id, guest_name, consent_at) VALUES (?, 'Test', CURRENT_TIMESTAMP)`)
    .run(SESSION_ID);
  edb.prepare(`
    INSERT INTO videos (id, session_id, question_id, question_text, filename, mime_type, size, checksum)
    VALUES (?, ?, 1, 'Question test', 'test.mp4', 'video/mp4', 100, 'abc123')
  `).run(VIDEO_ID, SESSION_ID);
});

after(() => {
  closeAllEventDbs();
  closeRegistry();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('runProbe', () => {
  test('sonde la vidéo et écrit derived', { skip: !realVideoPath }, async () => {
    const job = { event_id: EVENT_ID, video_id: VIDEO_ID };
    await runProbe(job, dataDir);

    const derived = edb.prepare('SELECT * FROM derived WHERE video_id = ?').get(VIDEO_ID);
    assert.ok(derived, 'derived doit exister');
    assert.ok(derived.duration_s >= 0, 'duration_s doit être >= 0');
    assert.ok(typeof derived.width === 'number', 'width doit être un nombre');
    assert.ok(derived.probed_at != null, 'probed_at doit être renseigné');

    // Nettoyage pour ne pas interférer avec thumbnail
    edb.prepare('DELETE FROM derived WHERE video_id = ?').run(VIDEO_ID);
  });

  test('lève une erreur si la vidéo est absente en base', async () => {
    const job = { event_id: EVENT_ID, video_id: 'id-inexistant' };
    await assert.rejects(() => runProbe(job, dataDir), /introuvable/);
  });
});

describe('runThumbnail', () => {
  test('génère un JPEG et met à jour derived.thumbnail', { skip: !realVideoPath }, async () => {
    const job = { event_id: EVENT_ID, video_id: VIDEO_ID };
    await runThumbnail(job, dataDir);

    const thumbPath = join(dataDir, 'events', EVENT_ID, 'derived', `${VIDEO_ID}.jpg`);
    assert.ok(existsSync(thumbPath), 'thumbnail JPEG doit exister');
    assert.ok(statSync(thumbPath).size > 0, 'JPEG ne doit pas être vide');

    const derived = edb.prepare('SELECT thumbnail FROM derived WHERE video_id = ?').get(VIDEO_ID);
    assert.ok(derived?.thumbnail != null, 'derived.thumbnail doit être renseigné');
  });

  test('lève une erreur si la vidéo est absente en base', async () => {
    const job = { event_id: EVENT_ID, video_id: 'id-inexistant' };
    await assert.rejects(() => runThumbnail(job, dataDir), /introuvable/);
  });
});

describe('runArchive', () => {
  test('génère un ZIP non vide dans derived/', async () => {
    const job = { event_id: EVENT_ID };
    await runArchive(job, dataDir);

    const zipPath = join(dataDir, 'events', EVENT_ID, 'derived', 'archive.zip');
    assert.ok(existsSync(zipPath), 'archive.zip doit exister');
    assert.ok(statSync(zipPath).size > 0, 'archive.zip ne doit pas être vide');
  });

  test('idempotent : un 2ème appel écrase le ZIP précédent', async () => {
    const job = { event_id: EVENT_ID };

    await runArchive(job, dataDir);
    const zipPath = join(dataDir, 'events', EVENT_ID, 'derived', 'archive.zip');
    const size1 = statSync(zipPath).size;

    await runArchive(job, dataDir);
    const size2 = statSync(zipPath).size;

    assert.ok(size1 > 0);
    assert.equal(size1, size2, 'deux archives du même contenu doivent avoir la même taille');
  });
});
