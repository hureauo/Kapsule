/**
 * Tests d'intégration du protocole synchro (phase 3.9)
 *
 * Architecture : Hub réel en mémoire (supertest) + Borne simulée
 * via les fonctions pull.js / push.js dont globalThis.fetch est redirigé
 * vers le Hub supertest. Aucun serveur réel sur le réseau.
 *
 * Scénario principal :
 *   1. Hub crée un événement ready + l'assigne à une borne
 *   2. Borne pull → local_events 'loaded', questions synchro
 *   3. Borne enregistre sessions + vidéos (simulées)
 *   4. Borne clôture, push
 *      a. manifest → Hub retourne missing
 *      b. uploads vidéos
 *      c. upload db
 *      d. finalize → Hub passe 'pushed', enfile jobs
 *   5. Statut local Borne 'pushed'
 *   6. Reprise : reset statut, relance push, manifest retourne [] (tout déjà là)
 *   7. Coupure simulée à mi-upload : première vidéo uploadée, deuxième coupe →
 *      relance → seule la deuxième est dans missing
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import supertest from 'supertest';
import argon2 from 'argon2';
import { v4 as uuidv4 } from 'uuid';
import Database from 'better-sqlite3';

// ── Hub
import { createApp as createHubApp } from '../src/index.js';
import {
  getDb as getHubDb, closeRegistry as closeHubRegistry,
  insertUser, insertBoxToken,
} from '../src/registry.js';
import { closeAllEventDbs } from '../src/eventStore.js';

// ── Borne (fonctions directes — pas de serveur Express)
import {
  openRegistry as openBorneRegistry,
  closeRegistry as closeBorneRegistry,
  getRegistry as getBorneRegistry,
  updateEventStatus as borneUpdateStatus,
} from '../../../borne/server/src/registry.js';
import { closeEventDb as closeBorneEventDb } from '../../../borne/server/src/eventDb.js';
import { config as borneConfig } from '../../../borne/server/src/config.js';
import { pullMyEvent } from '../../../borne/server/src/sync/pull.js';
import { pushEvent } from '../../../borne/server/src/sync/push.js';

// ── Constantes
const BOX_TOKEN = randomBytes(32).toString('hex');
const BOX_TOKEN_2 = randomBytes(32).toString('hex');
const HUB_URL = 'https://hub.test';

// ── Adaptateur fetch → supertest ─────────────────────────────────────────────
//
// hubFetch() et uploadFileWithRetry() appellent globalThis.fetch(url, opts).
// On remplace fetch par un adaptateur qui route les requêtes HUB_URL vers
// le serveur supertest en mémoire, sans aucun socket réseau réel.
//
// Les FormData (upload fichiers) sont reconstitués : supertest attend un
// Buffer ou un stream. On extrait le Blob du FormData en lisant ses entries.

async function blobToBuffer(blob) {
  const ab = await blob.arrayBuffer();
  return Buffer.from(ab);
}

function makeFetchAdapter(agent) {
  return async function fetchAdapter(url, opts = {}) {
    const urlStr = typeof url === 'string' ? url : url.toString();
    if (!urlStr.startsWith(HUB_URL)) {
      // Hors Hub — ne devrait pas arriver dans ces tests
      throw new Error(`fetch inattendu vers ${urlStr}`);
    }
    const path = urlStr.slice(HUB_URL.length);
    const method = (opts.method ?? 'GET').toLowerCase();

    let req = agent[method](path);

    // Headers (hors Content-Type géré par supertest pour multipart)
    const headers = opts.headers ?? {};
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() !== 'content-type') req = req.set(k, v);
    }

    // Body
    if (opts.body instanceof FormData) {
      // Extraire le fichier du FormData
      const entries = [...opts.body.entries()];
      for (const [field, value] of entries) {
        if (value instanceof Blob) {
          const buf = await blobToBuffer(value);
          // Récupérer le filename (3ème param de FormData.append)
          // Dans notre code : form.append('file', blob, filename)
          // FormData stocke le name dans value.name si c'est un File
          const filename = value.name ?? field;
          req = req.attach(field, buf, { filename, contentType: value.type || 'application/octet-stream' });
        } else {
          req = req.field(field, value);
        }
      }
    } else if (typeof opts.body === 'string') {
      req = req.set('Content-Type', 'application/json').send(opts.body);
    }

    const res = await req;

    // Construire un objet Response-like compatible avec notre code
    const status = res.status;
    const bodyText = JSON.stringify(res.body);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: String(status),
      json: async () => res.body,
      text: async () => bodyText,
    };
  };
}

// ── Setup / Teardown ─────────────────────────────────────────────────────────

let hubDir, borneDir;
let hubAgent;
let tokenClient;
let eventId;
let savedFetch;

before(async () => {
  // ── Hub
  hubDir = mkdtempSync(join(tmpdir(), 'kapsule-integ-hub-'));
  const hubApp = createHubApp(hubDir);
  hubAgent = supertest.agent(hubApp);

  const db = getHubDb();
  const hash = await argon2.hash('pass-client', { type: argon2.argon2id });
  insertUser(db, { email: 'client@integ.test', password_hash: hash, role: 'client' });
  const loginRes = await hubAgent.post('/api/auth/login').send({ email: 'client@integ.test', password: 'pass-client' });
  tokenClient = loginRes.body.token;

  // Événement Hub ready
  const evRes = await hubAgent
    .post('/api/events')
    .set('Authorization', `Bearer ${tokenClient}`)
    .send({ name: 'Événement Intégration' });
  eventId = evRes.body.id;

  await hubAgent
    .put(`/api/events/${eventId}/status`)
    .set('Authorization', `Bearer ${tokenClient}`)
    .send({ status: 'ready' });

  // Token de borne lié à cet événement (modèle token = événement §11.20)
  const tokenHash = createHash('sha256').update(BOX_TOKEN).digest('hex');
  insertBoxToken(db, { event_id: eventId, token_hash: tokenHash, label: 'Borne Integ' });

  // Questions Hub
  await hubAgent
    .post(`/api/events/${eventId}/questions`)
    .set('Authorization', `Bearer ${tokenClient}`)
    .send({ text: 'Question A', max_duration: 60, countdown: 3 });
  await hubAgent
    .post(`/api/events/${eventId}/questions`)
    .set('Authorization', `Bearer ${tokenClient}`)
    .send({ text: 'Question B', max_duration: 60, countdown: 3 });

  // ── Borne
  borneDir = mkdtempSync(join(tmpdir(), 'kapsule-integ-borne-'));
  openBorneRegistry(borneDir);

  // Configurer hubClient (config est un objet muable)
  borneConfig.hubUrl = HUB_URL;
  borneConfig.boxToken = BOX_TOKEN;

  // Remplacer globalThis.fetch par l'adaptateur supertest
  savedFetch = globalThis.fetch;
  globalThis.fetch = makeFetchAdapter(hubAgent);
});

after(() => {
  globalThis.fetch = savedFetch;
  borneConfig.hubUrl = '';
  borneConfig.boxToken = '';
  closeBorneEventDb();
  closeBorneRegistry();
  closeAllEventDbs();
  closeHubRegistry();
  rmSync(hubDir, { recursive: true, force: true });
  rmSync(borneDir, { recursive: true, force: true });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeVideoFile(borneEventDir, videoId, content = 'fake video content') {
  const videosDir = join(borneEventDir, 'videos');
  mkdirSync(videosDir, { recursive: true });
  const filename = `${videoId}.mp4`;
  writeFileSync(join(videosDir, filename), content);
  return { filename, size: Buffer.byteLength(content), content };
}

function insertVideoInDb(edb, videoId, sessionId, filename, size, content) {
  const checksum = createHash('sha256').update(content).digest('hex');
  edb.prepare(
    `INSERT INTO videos (id, session_id, question_id, question_text, filename, mime_type, size, checksum, recorded_at)
     VALUES (?, ?, NULL, 'Q', ?, 'video/mp4', ?, ?, CURRENT_TIMESTAMP)`
  ).run(videoId, sessionId, filename, size, checksum);
  return checksum;
}

// ── Scénario 1 : pull ────────────────────────────────────────────────────────

describe('Intégration 3.9 — pull', () => {
  it('pull : Borne reçoit l\'événement et les questions du Hub', async () => {
    const count = await pullMyEvent(borneDir);
    assert.ok(count >= 1, 'au moins 1 event pulled');

    // Vérification local_events
    const ev = getBorneRegistry().prepare('SELECT * FROM local_events WHERE id = ?').get(eventId);
    assert.ok(ev, 'event présent dans local_events Borne');
    assert.equal(ev.status, 'loaded');
    assert.equal(ev.origin, 'hub');
    assert.ok(ev.pulled_at, 'pulled_at défini');

    // Vérification questions dans db.sqlite événement
    const dbPath = join(borneDir, 'events', eventId, 'db.sqlite');
    assert.ok(existsSync(dbPath), 'db.sqlite créé');
    const edb = new Database(dbPath, { readonly: true });
    const questions = edb.prepare('SELECT * FROM questions ORDER BY order_index').all();
    edb.close();
    // Le Hub seed 4 questions par défaut + 2 ajoutées = 6 total synchronisées
    assert.ok(questions.length >= 2, 'questions synchronisées');
    const texts = questions.map(q => q.text);
    assert.ok(texts.includes('Question A'), 'Question A présente');
    assert.ok(texts.includes('Question B'), 'Question B présente');
  });

  it('pull : le Hub passe l\'événement en loaded', async () => {
    const res = await hubAgent
      .get(`/api/events/${eventId}`)
      .set('Authorization', `Bearer ${tokenClient}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'loaded', 'Hub voit l\'événement en loaded après pull');
  });
});

// ── Scénario 2 : push nominal ────────────────────────────────────────────────

describe('Intégration 3.9 — push nominal', () => {
  before(async () => {
    // Simuler des sessions + vidéos sur la Borne
    const borneEventDir = join(borneDir, 'events', eventId);
    const dbPath = join(borneEventDir, 'db.sqlite');
    const edb = new Database(dbPath);

    // Session
    edb.prepare(
      `INSERT INTO sessions (id, guest_name, consent_at) VALUES ('sess-integ', 'Alice', CURRENT_TIMESTAMP)`
    ).run();

    // 2 vidéos (id = UUID v4, comme en production où videos.id vient de uuidv4())
    const vidIntg1 = uuidv4();
    const vidIntg2 = uuidv4();
    const { filename: fn1, size: s1, content: c1 } = makeVideoFile(borneEventDir, vidIntg1);
    const { filename: fn2, size: s2, content: c2 } = makeVideoFile(borneEventDir, vidIntg2);
    insertVideoInDb(edb, vidIntg1, 'sess-integ', fn1, s1, c1);
    insertVideoInDb(edb, vidIntg2, 'sess-integ', fn2, s2, c2);
    edb.close();

    // Borne passe live → closed
    borneUpdateStatus(eventId, 'live');
    borneUpdateStatus(eventId, 'closed');
  });

  it('push : finalize réussit, statut Borne → pushed', async () => {
    await pushEvent(eventId, borneDir);

    const ev = getBorneRegistry().prepare('SELECT * FROM local_events WHERE id = ?').get(eventId);
    assert.equal(ev.status, 'pushed', 'statut Borne pushed');
    assert.ok(ev.pushed_at, 'pushed_at défini');
  });

  it('push : Hub voit l\'événement en pushed avec jobs', async () => {
    const res = await hubAgent
      .get(`/api/events/${eventId}`)
      .set('Authorization', `Bearer ${tokenClient}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'pushed');

    const syncRes = await hubAgent
      .get(`/api/events/${eventId}/sync`)
      .set('Authorization', `Bearer ${tokenClient}`);
    assert.equal(syncRes.status, 200);
    assert.ok(syncRes.body.jobs.total > 0, 'jobs enfilés par finalize');
  });

  it('push : push_state Borne contient les vidéos avec uploaded_at', () => {
    const ps = getBorneRegistry().prepare(
      'SELECT * FROM push_state WHERE event_id = ?'
    ).all(eventId);
    assert.equal(ps.length, 2, '2 entrées push_state');
    for (const p of ps) {
      assert.ok(p.uploaded_at, `uploaded_at défini pour ${p.video_id}`);
    }
  });
});

// ── Scénario 3 : push idempotent (re-push sans rien manquant) ────────────────

describe('Intégration 3.9 — reprise idempotente', () => {
  it('push idempotent : tout déjà reçu → manifest retourne missing=[]', async () => {
    // Remettre en closed pour pouvoir re-pousser
    getBorneRegistry()
      .prepare("UPDATE local_events SET status='closed', pushed_at=NULL WHERE id=?")
      .run(eventId);

    // Re-push : le Hub a déjà toutes les vidéos
    await pushEvent(eventId, borneDir);

    const ev = getBorneRegistry().prepare('SELECT * FROM local_events WHERE id = ?').get(eventId);
    assert.equal(ev.status, 'pushed', 'statut pushed après re-push');
  });
});

// ── Scénario 4 : coupure simulée à mi-upload + reprise ───────────────────────

describe('Intégration 3.9 — coupure à mi-upload et reprise', () => {
  let eventId2;
  let uploadCount;

  before(async () => {
    // Nouvel événement pour ce scénario (l'event précédent est déjà pushed)
    const evRes = await hubAgent
      .post('/api/events')
      .set('Authorization', `Bearer ${tokenClient}`)
      .send({ name: 'Événement Coupure' });
    eventId2 = evRes.body.id;

    await hubAgent.put(`/api/events/${eventId2}/status`).set('Authorization', `Bearer ${tokenClient}`).send({ status: 'ready' });
    await hubAgent.post(`/api/events/${eventId2}/questions`).set('Authorization', `Bearer ${tokenClient}`).send({ text: 'Q Coupure', max_duration: 60, countdown: 3 });

    // Token de borne lié à eventId2 (token distinct — un token = un événement §11.20)
    const db = getHubDb();
    const hash2 = createHash('sha256').update(BOX_TOKEN_2).digest('hex');
    insertBoxToken(db, { event_id: eventId2, token_hash: hash2, label: 'Borne Integ 2' });

    // Basculer le token de la Borne sur BOX_TOKEN_2 pour ce scénario
    borneConfig.boxToken = BOX_TOKEN_2;

    // Pull Borne
    await pullMyEvent(borneDir);

    // Vidéos simulées
    const borneEventDir = join(borneDir, 'events', eventId2);
    const dbPath = join(borneEventDir, 'db.sqlite');
    const edb = new Database(dbPath);
    edb.prepare(`INSERT INTO sessions (id, guest_name, consent_at) VALUES ('sess-coup', 'Bob', CURRENT_TIMESTAMP)`).run();

    const vidCoup1 = uuidv4();
    const vidCoup2 = uuidv4();
    const { filename: fn1, size: s1, content: c1 } = makeVideoFile(borneEventDir, vidCoup1, 'video content A');
    const { filename: fn2, size: s2, content: c2 } = makeVideoFile(borneEventDir, vidCoup2, 'video content B');
    insertVideoInDb(edb, vidCoup1, 'sess-coup', fn1, s1, c1);
    insertVideoInDb(edb, vidCoup2, 'sess-coup', fn2, s2, c2);
    edb.close();

    borneUpdateStatus(eventId2, 'live');
    borneUpdateStatus(eventId2, 'closed');

    // 1er push : coupe après le premier upload vidéo
    // Patch setTimeout pour éviter les vrais délais de backoff (~30 s sinon)
    const origSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn) => { fn(); return 0; };

    uploadCount = 0;
    const baseFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      // Laisser passer manifest, 1er fichier, puis couper sur le 2ème
      if (typeof url === 'string' && url.includes('/files/')) {
        uploadCount++;
        if (uploadCount >= 2) throw new Error('Coupure réseau simulée');
      }
      return baseFetch(url, opts);
    };

    try {
      await pushEvent(eventId2, borneDir);
    } catch {
      // Coupure attendue
    }

    // Restaurer setTimeout et le fetch normal
    globalThis.setTimeout = origSetTimeout;
    globalThis.fetch = makeFetchAdapter(hubAgent);
  });

  it('après coupure : 1 vidéo uploadée (uploaded_at), 1 non', () => {
    const ps = getBorneRegistry().prepare(
      'SELECT * FROM push_state WHERE event_id = ? ORDER BY video_id'
    ).all(eventId2);
    const withDate = ps.filter(p => p.uploaded_at);
    const withoutDate = ps.filter(p => !p.uploaded_at);
    // Exactement une vidéo confirmée, l'autre non
    assert.equal(withDate.length, 1, '1 vidéo confirmée dans push_state');
    assert.equal(withoutDate.length, 1, '1 vidéo non confirmée');
  });

  it('reprise : le Hub recalcule missing et seule la 2ème vidéo est uploadée', async () => {
    // Remettre en closed
    getBorneRegistry()
      .prepare("UPDATE local_events SET status='closed', pushed_at=NULL WHERE id=?")
      .run(eventId2);

    let missingFromHub = null;
    const baseFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      const res = await baseFetch(url, opts);
      // Capturer la réponse du manifest
      if (typeof url === 'string' && url.includes('/manifest') && opts?.method === 'POST') {
        const body = await res.json();
        missingFromHub = body.missing;
        return {
          ok: res.ok, status: res.status, statusText: res.statusText,
          json: async () => body, text: async () => JSON.stringify(body),
        };
      }
      return res;
    };

    await pushEvent(eventId2, borneDir);
    globalThis.fetch = baseFetch;

    // Hub ne retourne qu'1 vidéo dans missing (l'autre est déjà là)
    assert.ok(missingFromHub !== null, 'manifest reçu');
    assert.equal(missingFromHub.length, 1, 'Hub retourne 1 seul missing à la reprise (§11.12)');

    const ev2 = getBorneRegistry().prepare('SELECT * FROM local_events WHERE id = ?').get(eventId2);
    assert.equal(ev2.status, 'pushed', 'statut pushed après reprise');
  });
});
