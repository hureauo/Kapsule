/**
 * Tests du router previewGallery (proxy Hub → backend borne d'essai).
 *
 * Stratégie : on lance un mini-serveur express "faux backend borne" sur un port
 * libre en mémoire. `createApp` accepte `resolvePreviewBase` (option injectable)
 * qui redirige les requêtes proxy vers ce faux backend au lieu du container Docker.
 * L'auth Hub réelle est utilisée (JWT, requireUser, requireOwner).
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import supertest from 'supertest';
import argon2 from 'argon2';
import { v4 as uuidv4 } from 'uuid';
import express from 'express';
import jwt from 'jsonwebtoken';

import { createApp } from '../src/index.js';
import { getDb, closeRegistry, insertUser, upsertEventUser } from '../src/registry.js';
import { closeAllEventDbs } from '../src/eventStore.js';
import { triggerPreviewPull } from '../src/routes/previewGallery.js';

// ── Faux backend borne (simulé en mémoire) ────────────────────────────────────

let fakeServer;
let fakePort;
let fakeVideos = [];
let borneDown = false; // simule borne hors ligne (ne répond pas → ECONNREFUSED)
let lastPullTokenRoles = null; // capture le rôle JWT du dernier POST /api/sync/pull reçu

// forgePreviewToken lit process.env.JWT_SECRET ?? 'change-me'.
// On force la même valeur dans le faux backend pour vérifier la signature.
const FAKE_JWT_SECRET = process.env.JWT_SECRET ?? 'change-me';

function startFakeBackend() {
  return new Promise((resolve) => {
    const app = express();

    // Simule /api/videos (gardé requireAdmin → accepte admin_borne ou tech_borne)
    app.get('/api/videos', (req, res) => {
      if (borneDown) return;
      res.json(fakeVideos);
    });

    app.get('/api/videos/:id/file', (req, res) => {
      if (borneDown) return;
      const body = Buffer.from('FAKE VIDEO BYTES');
      if (req.headers.range) {
        // Simule une réponse 206 Partial Content
        res.writeHead(206, {
          'Content-Range': `bytes 0-15/${body.length}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(body.length),
          'Content-Type': 'video/mp4',
        });
      } else {
        res.writeHead(200, {
          'Content-Type': 'video/mp4',
          'Content-Length': String(body.length),
          'Accept-Ranges': 'bytes',
        });
      }
      res.end(body);
    });

    // Simule /api/sync/pull (gardé requireTech → accepte UNIQUEMENT tech_borne, §11.19).
    // Vérifie que le Hub forge bien tech_borne et capture le rôle pour les tests.
    app.post('/api/sync/pull', (req, res) => {
      if (borneDown) return;
      const authHeader = req.headers['authorization'] ?? '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
      if (!token) return res.status(401).json({ error: 'Token manquant' });
      try {
        const payload = jwt.verify(token, FAKE_JWT_SECRET, { algorithms: ['HS256'] });
        const roles = Array.isArray(payload.roles) ? payload.roles : [];
        if (!roles.includes('tech_borne')) {
          return res.status(403).json({ error: 'Accès refusé (tech_borne requis)' });
        }
        lastPullTokenRoles = roles;
        res.json({ ok: true, pulled: true, localConfig: {} });
      } catch {
        res.status(401).json({ error: 'Token invalide' });
      }
    });

    fakeServer = http.createServer(app);
    fakeServer.listen(0, '127.0.0.1', () => {
      fakePort = fakeServer.address().port;
      resolve();
    });
  });
}

// ── Setup global ──────────────────────────────────────────────────────────────

let dir;
let request;
let token;        // token du propriétaire de l'event
let otherToken;   // token d'un autre utilisateur (ne doit pas voir l'event)
let eventId;

before(async () => {
  await startFakeBackend();

  dir = mkdtempSync(join(tmpdir(), 'kapsule-prevgal-'));

  // resolvePreviewBase injectable → pointe sur le faux backend local
  const resolvePreviewBase = () => `http://127.0.0.1:${fakePort}`;

  const app = createApp(dir, {}, { resolvePreviewBase });
  request = supertest(app);

  const db = getDb();
  const hash = await argon2.hash('pass1', { type: argon2.argon2id });
  const hashOther = await argon2.hash('pass2', { type: argon2.argon2id });
  const ownerRow = insertUser(db, { email: 'owner@prevgal.test', password_hash: hash, role: 'superuser' });
  insertUser(db, { email: 'other@prevgal.test', password_hash: hashOther, role: 'client' });

  const loginOwner = await request.post('/api/auth/login').send({ email: 'owner@prevgal.test', password: 'pass1' });
  const loginOther = await request.post('/api/auth/login').send({ email: 'other@prevgal.test', password: 'pass2' });
  token = loginOwner.body.token;
  otherToken = loginOther.body.token;

  // Événement en statut 'preview' (accessible via /preview-videos)
  eventId = uuidv4();
  const ownerId = ownerRow.lastInsertRowid;
  db.prepare(`
    INSERT INTO events (id, name, status)
    VALUES (?, 'Preview Test', 'preview')
  `).run(eventId);
  upsertEventUser(db, { event_id: eventId, user_id: ownerId, roles: ['admin_borne'] });
});

after(() => {
  fakeServer.close();
  closeAllEventDbs();
  closeRegistry();
  rmSync(dir, { recursive: true, force: true });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/events/:eventId/preview-videos — liste', () => {
  beforeEach(() => {
    borneDown = false;
    fakeVideos = [
      { id: 'v1', guest_name: 'Alice', question_text: 'Ton souvenir ?', size: 1024, duration_s: 12 },
      { id: 'v2', guest_name: 'Bob',   question_text: 'Un mot ?',        size: 2048, duration_s: 8  },
    ];
  });

  it('renvoie 401 sans token', async () => {
    const res = await request.get(`/api/events/${eventId}/preview-videos`);
    assert.equal(res.status, 401);
  });

  it('renvoie 403 si l\'utilisateur n\'est pas owner', async () => {
    const res = await request
      .get(`/api/events/${eventId}/preview-videos`)
      .set('Authorization', `Bearer ${otherToken}`);
    // otherToken est `client` sans membership → requireOwner refuse
    assert.equal(res.status, 403);
  });

  it('renvoie la liste des vidéos (cas nominal)', async () => {
    const res = await request
      .get(`/api/events/${eventId}/preview-videos`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
    assert.equal(res.body.length, 2);
    assert.equal(res.body[0].guest_name, 'Alice');
  });

  it('renvoie 503 si la borne est hors ligne', async () => {
    borneDown = true;
    const res = await request
      .get(`/api/events/${eventId}/preview-videos`)
      .set('Authorization', `Bearer ${token}`);
    borneDown = false;
    assert.equal(res.status, 503);
    assert.ok(res.body.error);
  });

  it('renvoie 404 pour un eventId inconnu', async () => {
    const res = await request
      .get(`/api/events/${uuidv4()}/preview-videos`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 404);
  });
});

describe('GET /api/events/:eventId/preview-videos/:videoId/file — proxy flux', () => {
  beforeEach(() => { borneDown = false; });

  it('renvoie 401 sans token', async () => {
    const res = await request.get(`/api/events/${eventId}/preview-videos/v1/file`);
    assert.equal(res.status, 401);
  });

  it('proxifie le flux vidéo (200)', async () => {
    const res = await request
      .get(`/api/events/${eventId}/preview-videos/1/file`)
      .set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.ok(res.headers['content-type']?.includes('video'));
    assert.ok(res.headers['accept-ranges']);
  });

  it('proxifie le Range entrant et renvoie 206', async () => {
    const res = await request
      .get(`/api/events/${eventId}/preview-videos/1/file`)
      .set('Authorization', `Bearer ${token}`)
      .set('Range', 'bytes=0-7');
    assert.equal(res.status, 206);
    assert.ok(res.headers['content-range']);
  });

  it('renvoie 503 si la borne est hors ligne', async () => {
    borneDown = true;
    const res = await request
      .get(`/api/events/${eventId}/preview-videos/1/file`)
      .set('Authorization', `Bearer ${token}`);
    borneDown = false;
    assert.equal(res.status, 503);
    assert.ok(res.body.error);
  });
});

describe('triggerPreviewPull — JWT tech_borne (§11.19)', () => {
  beforeEach(() => {
    borneDown = false;
    lastPullTokenRoles = null;
  });

  it('forge un token tech_borne accepté par requireTech de la borne', async () => {
    // triggerPreviewPull est fire-and-forget ; on attend un tick pour que la requête
    // arrive sur le faux backend (qui tourne sur le même event loop).
    const resolveBase = () => `http://127.0.0.1:${fakePort}`;
    await triggerPreviewPull(eventId, resolveBase);
    // Petit délai pour laisser le réseau interne se régler (même process, très rapide)
    await new Promise(r => setTimeout(r, 50));
    assert.deepEqual(lastPullTokenRoles, ['tech_borne'],
      'Le token forgé doit porter tech_borne (seul rôle accepté par requireTech)');
  });

  it('ne lève pas si la borne est hors ligne (fire-and-forget)', async () => {
    borneDown = true;
    const resolveBase = () => `http://127.0.0.1:${fakePort}`;
    // Doit résoudre sans exception
    await assert.doesNotReject(() => triggerPreviewPull(eventId, resolveBase));
    borneDown = false;
  });
});
