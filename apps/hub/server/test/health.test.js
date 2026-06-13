import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createApp } from '../src/index.js';

describe('GET /api/health', () => {
  test('retourne 200 avec la structure attendue', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hub-'));
    try {
      const app = createApp(dir);
      const res = await request(app).get('/api/health');
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
      assert.ok(typeof res.body.disk.free_bytes === 'number');
      assert.ok(typeof res.body.disk.total_bytes === 'number');
      assert.ok(res.body.disk.total_bytes > 0);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('retourne 500 si dataDir inexistant', async () => {
    const app = createApp('/tmp/hub-inexistant-xyz-99');
    const res = await request(app).get('/api/health');
    assert.equal(res.status, 500);
    assert.ok(res.body.error);
  });
});
