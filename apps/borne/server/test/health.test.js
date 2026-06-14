import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createApp } from '../src/index.js';
import { closeRegistry } from '../src/registry.js';

describe('GET /api/health', () => {
  let dir;
  let app;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'borne-'));
    app = createApp(dir);
  });

  afterEach(() => {
    closeRegistry();
    rmSync(dir, { recursive: true, force: true });
  });

  test('retourne 200 avec la structure attendue', async () => {
    const res = await request(app).get('/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.activeEvent, null);
    assert.ok(typeof res.body.disk.free_bytes === 'number');
    assert.ok(typeof res.body.disk.total_bytes === 'number');
    assert.ok(res.body.disk.total_bytes > 0);
  });

  test('retourne activeEvent non null quand un événement est actif', async () => {
    const { insertEvent, setActiveEvent } = await import('../src/registry.js');
    insertEvent({ id: 'evt-health-1', name: 'Test', origin: 'local' });
    setActiveEvent('evt-health-1');
    const res = await request(app).get('/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.activeEvent, 'evt-health-1');
  });

  test('error handler 500 retourne message générique sans fuite de détail', async () => {
    // Supprime le dataDir → statfs lève ENOENT, mais le client ne voit que le message générique
    rmSync(dir, { recursive: true, force: true });
    const res = await request(app).get('/api/health');
    assert.equal(res.status, 500);
    assert.equal(res.body.error, 'Erreur interne du serveur');
    assert.ok(!res.body.error.includes(dir), 'Le chemin interne ne doit pas fuiter');
    // afterEach utilise force:true, pas besoin de recréer le dir
  });
});
