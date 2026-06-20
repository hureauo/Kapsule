import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { createApp } from '../src/index.js';
import { closeRegistry } from '../src/registry.js';
import { TEST_CFG } from './helpers.js';

describe('GET /api/health (public)', () => {
  let dir, app;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'borne-health-'));
    app = createApp(dir, { ...TEST_CFG, dataDir: dir });
  });

  afterEach(() => {
    closeRegistry();
    rmSync(dir, { recursive: true, force: true });
  });

  test('retourne 200 avec { ok: true } seulement', async () => {
    const res = await request(app).get('/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.disk, undefined, 'disk ne doit pas être exposé publiquement');
    assert.equal(res.body.activeEvent, undefined, 'activeEvent ne doit pas être exposé publiquement');
  });
});

describe('GET /api/admin/health (authentifié)', () => {
  let dir, app;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'borne-adminhealth-'));
    app = createApp(dir, { ...TEST_CFG, dataDir: dir });
  });

  afterEach(() => {
    closeRegistry();
    rmSync(dir, { recursive: true, force: true });
  });

  function makeToken(roles) {
    return jwt.sign({ roles }, TEST_CFG.jwtSecret, { expiresIn: '1h' });
  }

  test('retourne 200 avec disk pour un admin authentifié', async () => {
    const token = makeToken(['admin_borne']);
    const res = await request(app)
      .get('/api/admin/health')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.ok(typeof res.body.disk.free_bytes === 'number');
    assert.ok(typeof res.body.disk.total_bytes === 'number');
    assert.ok(res.body.disk.total_bytes > 0);
  });

  test('retourne 401 sans token', async () => {
    const res = await request(app).get('/api/admin/health');
    assert.equal(res.status, 401);
  });

  test('error handler 500 retourne message générique sans fuite de détail', async () => {
    rmSync(dir, { recursive: true, force: true });
    const token = makeToken(['admin_borne']);
    const res = await request(app)
      .get('/api/admin/health')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 500);
    assert.equal(res.body.error, 'Erreur interne du serveur');
    assert.ok(!res.body.error.includes(dir), 'Le chemin interne ne doit pas fuiter');
  });
});
