import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createApp } from '../src/index.js';

describe('GET /api/health', () => {
  let dir;
  let app;

  // Crée un répertoire temporaire pour chaque suite — nettoyé après
  const setup = () => {
    dir = mkdtempSync(join(tmpdir(), 'borne-'));
    app = createApp(dir);
  };
  const teardown = () => rmSync(dir, { recursive: true });

  test('retourne 200 avec la structure attendue', async () => {
    setup();
    try {
      const res = await request(app).get('/api/health');
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.activeEvent, null);
      assert.ok(typeof res.body.disk.free_bytes === 'number');
      assert.ok(typeof res.body.disk.total_bytes === 'number');
      assert.ok(res.body.disk.total_bytes > 0);
    } finally {
      teardown();
    }
  });

  test('retourne 500 si dataDir inexistant', async () => {
    const app = createApp('/tmp/kapsule-inexistant-xyz-99');
    const res = await request(app).get('/api/health');
    assert.equal(res.status, 500);
    assert.ok(res.body.error);
  });
});
