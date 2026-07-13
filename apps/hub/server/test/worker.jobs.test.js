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
import { runFfprobe, makeThumbnail } from '../src/worker/ffmpeg.js';

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

  // Plus de questions seedées par défaut → en créer une explicitement pour la FK videos.question_id
  edb.prepare(`INSERT INTO questions (id, text) VALUES (1, 'Question test')`).run();
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

// ── Orientation : dimensions d'affichage, rotation appliquée ──────────────────
//
// Le piège : une vidéo filmée en portrait sur mobile est souvent ENCODÉE en paysage
// (1280×720) avec une matrice de rotation de 90°. `coded_width`/`coded_height`
// décrivent le flux AVANT rotation — s'y fier ferait passer cette vidéo pour du
// paysage, alors qu'elle s'affiche verticalement. runFfprobe doit rendre les
// dimensions d'AFFICHAGE.

// Détecté au chargement du module, et NON dans un before() : node:test évalue les
// options `skip` des tests avant d'exécuter les hooks. Un `hasFfmpeg` initialisé
// dans before() vaudrait encore false à ce moment-là, et TOUS ces tests seraient
// silencieusement skippés — un test qui rassure sans rien vérifier.
const HAS_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0;

describe('runFfprobe — orientation', () => {
  let vDir;

  // Génère une vidéo de test de 2s (plus longue que le seek à 1s de makeThumbnail).
  function makeVideo(name, size) {
    const out = join(vDir, name);
    const r = spawnSync('ffmpeg', [
      '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `color=black:s=${size}:d=2`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', '2', '-an', out,
    ]);
    return r.status === 0 ? out : null;
  }

  before(() => { vDir = mkdtempSync(join(tmpdir(), 'kapsule-orient-')); });
  after(() => rmSync(vDir, { recursive: true, force: true }));

  test('vidéo paysage → width > height, rotation 0', { skip: !HAS_FFMPEG }, async () => {
    const p = makeVideo('paysage.mp4', '640x360');
    if (!p) return;
    const r = await runFfprobe(p);
    assert.equal(r.width, 640);
    assert.equal(r.height, 360);
    assert.equal(r.rotation, 0);
  });

  test('vidéo portrait native → height > width', { skip: !HAS_FFMPEG }, async () => {
    const p = makeVideo('portrait.mp4', '360x640');
    if (!p) return;
    const r = await runFfprobe(p);
    assert.equal(r.width, 360);
    assert.equal(r.height, 640);
    assert.ok(r.height > r.width, 'doit être détectée verticale');
  });

  test('encodée paysage + rotation 90° (cas mobile) → dimensions d\'affichage verticales', { skip: !HAS_FFMPEG }, async () => {
    // -display_rotation écrit une vraie Display Matrix, comme un iPhone/iPad tenu droit.
    const src = makeVideo('src.mp4', '640x360');
    if (!src) return;
    const rotated = join(vDir, 'rotated.mp4');
    const r = spawnSync('ffmpeg', [
      '-y', '-loglevel', 'error', '-display_rotation', '90', '-i', src, '-c', 'copy', rotated,
    ]);
    if (r.status !== 0) return; // ffmpeg trop ancien pour -display_rotation

    const probed = await runFfprobe(rotated);
    assert.equal(probed.rotation, 90);
    // Le flux est encodé 640×360, mais s'AFFICHE en 360×640.
    assert.equal(probed.width, 360);
    assert.equal(probed.height, 640);
    assert.ok(probed.height > probed.width, 'une vidéo mobile portrait ne doit pas passer pour du paysage');
  });

  test('makeThumbnail : le JPEG d\'une source portrait est vertical', { skip: !HAS_FFMPEG }, async () => {
    const p = makeVideo('portrait2.mp4', '360x640');
    if (!p) return;
    const jpg = join(vDir, 'portrait2.jpg');
    await makeThumbnail(p, jpg);

    // On sonde le JPEG produit : ffprobe le lit comme une image d'une frame.
    const r = await runFfprobe(jpg);
    assert.equal(r.width, 360);
    assert.equal(r.height, 640);
  });
});
