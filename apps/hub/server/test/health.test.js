import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import argon2 from 'argon2';
import request from 'supertest';
import { createApp } from '../src/index.js';
import { getDb, closeRegistry, insertUser } from '../src/registry.js';

describe('GET /api/health (public)', () => {
  test('retourne 200 avec { ok: true } seulement', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hub-health-'));
    try {
      const app = createApp(dir);
      const res = await request(app).get('/api/health');
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.disk, undefined, 'disk ne doit pas être exposé publiquement');
    } finally {
      closeRegistry();
      rmSync(dir, { recursive: true });
    }
  });
});

describe('GET /api/admin/health (authentifié)', () => {
  test('retourne 200 avec disk pour un utilisateur authentifié', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hub-adminhealth-'));
    try {
      const app = createApp(dir);
      const db = getDb();
      const hash = await argon2.hash('pass-admin', { type: argon2.argon2id });
      insertUser(db, { email: 'admin@health.test', password_hash: hash, role: 'superuser' });

      const loginRes = await request(app)
        .post('/api/auth/login')
        .send({ email: 'admin@health.test', password: 'pass-admin' });
      assert.equal(loginRes.status, 200);
      const token = loginRes.body.token;

      const res = await request(app)
        .get('/api/admin/health')
        .set('Authorization', `Bearer ${token}`);
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
      assert.ok(typeof res.body.disk.free_bytes === 'number');
      assert.ok(typeof res.body.disk.total_bytes === 'number');
    } finally {
      closeRegistry();
      rmSync(dir, { recursive: true });
    }
  });

  test('retourne 401 sans token', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hub-adminhealth-noauth-'));
    try {
      const app = createApp(dir);
      const res = await request(app).get('/api/admin/health');
      assert.equal(res.status, 401);
    } finally {
      closeRegistry();
      rmSync(dir, { recursive: true });
    }
  });
});
